import { createHash } from 'node:crypto';

import { Prisma, type PrismaClient } from '@prisma/client';

import { computeExitLatency, priceDeteriorationPercent, type ExitLatencyTimestamps } from './exit-latency.js';
import { simulatedSellFill } from './paper-fills.js';

/**
 * Shared PAPER-account bookkeeping used by both the API and the worker.
 *
 * Every balance mutation is expressed as an atomic increment/decrement (never "read, compute,
 * write back an absolute value"), so concurrent entries/exits for the same user cannot overwrite
 * each other's cash changes. Equity is always derived the same way: cash + market value of all
 * open PAPER positions.
 */

type Tx = Prisma.TransactionClient;

export const PAPER_FEE_BPS = 30;

export class InsufficientPaperCashError extends Error {
  constructor() {
    super('Insufficient paper cash balance');
    this.name = 'InsufficientPaperCashError';
  }
}

export function paperFee(notional: number) {
  return notional * PAPER_FEE_BPS / 10_000;
}

/** Atomically debits `notional + fee` from the account; throws when cash is insufficient. */
export async function debitPaperCash(tx: Tx, accountId: string, notional: number, fee: number) {
  const total = new Prisma.Decimal(notional).plus(fee);
  const result = await tx.paperAccount.updateMany({
    where: { id: accountId, cashBalance: { gte: total } },
    data: { cashBalance: { decrement: total }, totalFees: { increment: new Prisma.Decimal(fee) } },
  });
  if (result.count !== 1) throw new InsufficientPaperCashError();
}

/** Re-derives equity and unrealized PnL from the account cash and the currently open PAPER positions. */
export async function recomputePaperAccount(tx: Tx | PrismaClient, userId: string) {
  const [account, positions] = await Promise.all([
    tx.paperAccount.findUnique({ where: { userId } }),
    tx.position.findMany({
      where: { userId, status: 'OPEN', mode: 'PAPER' },
      select: { quantity: true, currentPrice: true, avgEntryPrice: true, unrealizedPnl: true },
    }),
  ]);
  if (!account) return null;
  const zero = new Prisma.Decimal(0);
  const marketValue = positions.reduce((total, position) => total.plus(position.quantity.times(position.currentPrice ?? position.avgEntryPrice)), zero);
  const unrealizedPnl = positions.reduce((total, position) => total.plus(position.unrealizedPnl ?? zero), zero);
  return tx.paperAccount.update({
    where: { id: account.id },
    data: { equity: account.cashBalance.plus(marketValue), unrealizedPnl },
  });
}

export interface ClosePaperPositionInput {
  positionId: string;
  userId: string;
  /** Reference MARKET price at exit; falls back to the position's last known price. */
  exitPrice?: number | null;
  /** Modelled adverse exit slippage in percent; the fill is exitPrice * (1 - slippage%). Default 0. */
  exitSlippagePercent?: number | null;
  exitReason: string;
  closedAt?: Date;
  /** Extra "why did this close" facts (trigger level, trailing state, ...), stored on the trade. */
  diagnostics?: Record<string, unknown>;
}

export interface ClosePaperPositionResult {
  positionId: string;
  tradeId: string;
  /** Simulated exit fill. */
  exitPrice: number;
  exitMarketPrice: number;
  exitSlippage: number;
  grossPnl: number;
  netPnl: number;
  exitFee: number;
}

/**
 * Closes one open PAPER position exactly once. The status flip is a conditional update, so two
 * concurrent closers (worker protection cycle, manual close, emergency stop) cannot both book the
 * exit. Returns null when the position was not open (already closed or not owned by the user).
 */
export async function closePaperPosition(tx: Tx, input: ClosePaperPositionInput): Promise<ClosePaperPositionResult | null> {
  const closedAt = input.closedAt ?? new Date();
  const locked = await tx.position.updateMany({
    where: { id: input.positionId, userId: input.userId, status: 'OPEN', mode: 'PAPER' },
    data: { status: 'CLOSED', closedAt, exitReason: input.exitReason, updatedAt: closedAt },
  });
  if (locked.count !== 1) return null;

  const position = await tx.position.findUniqueOrThrow({ where: { id: input.positionId }, include: { token: true } });
  const exitMarketPrice = input.exitPrice !== undefined && input.exitPrice !== null && Number.isFinite(input.exitPrice) && input.exitPrice > 0
    ? input.exitPrice
    : Number(position.currentPrice ?? position.avgEntryPrice);
  const exitSlippagePercent = Math.max(0, Number(input.exitSlippagePercent ?? 0) || 0);
  // Slippage is modelled once, inside the fill price (entry: avgEntryPrice, exit: exitPrice below).
  const exitPrice = position.side === 'BUY' ? simulatedSellFill(exitMarketPrice, exitSlippagePercent) : exitMarketPrice * (1 + exitSlippagePercent / 100);
  const quantity = Number(position.quantity);
  const entryPrice = Number(position.avgEntryPrice);
  const exitNotional = exitPrice * quantity;
  const exitSlippage = Math.abs(exitMarketPrice - exitPrice) * quantity;
  const exitFee = paperFee(exitNotional);
  const grossPnl = (position.side === 'BUY' ? exitPrice - entryPrice : entryPrice - exitPrice) * quantity;

  const openTrade = await tx.trade.findFirst({ where: { positionId: position.id, userId: input.userId, status: 'OPEN' }, orderBy: { createdAt: 'asc' } });
  // Slippage is embedded in both fill prices, so only fees are deducted from gross here.
  const entryFees = Number(openTrade?.fees ?? 0);
  const entrySlippage = Number(openTrade?.slippage ?? 0);
  const netPnl = grossPnl - entryFees - exitFee;
  const highestPrice = Math.max(Number(position.highestPrice ?? exitMarketPrice), exitMarketPrice);
  const lowestPrice = Math.min(Number(position.lowestPrice ?? exitMarketPrice), exitMarketPrice);
  const exitDiagnostics = {
    exitReason: input.exitReason,
    fillPolicy: 'SNAPSHOT_PRICE_MINUS_MODELLED_SLIPPAGE',
    exitMarketPrice,
    exitFillPrice: exitPrice,
    exitSlippagePercent,
    entryFillPrice: entryPrice,
    entryMarketPrice: position.entryMarketPrice !== null ? Number(position.entryMarketPrice) : null,
    highestPrice,
    lowestPrice,
    stopLossPrice: position.stopLossPrice !== null ? Number(position.stopLossPrice) : null,
    takeProfitPrice: position.takeProfitPrice !== null ? Number(position.takeProfitPrice) : null,
    trailingStopPercent: position.trailingStopPercent !== null ? Number(position.trailingStopPercent) : null,
    trailingActivationPercent: position.trailingActivationPercent !== null ? Number(position.trailingActivationPercent) : null,
    trailingActive: position.trailingActive,
    trailingActivatedAt: position.trailingActivatedAt?.toISOString() ?? null,
    trailingActivationPrice: position.trailingActivationPrice !== null ? Number(position.trailingActivationPrice) : null,
    trailingTriggerPrice: position.trailingTriggerPrice !== null ? Number(position.trailingTriggerPrice) : null,
    breakEvenAppliedAt: position.breakEvenAppliedAt?.toISOString() ?? null,
    holdingMs: closedAt.getTime() - position.openedAt.getTime(),
    ...input.diagnostics,
  };
  // Fill-time facts (this transaction IS the paper fill): authoritative simulated fill, timing, deterioration.
  const fillAt = new Date().toISOString();
  const given = (input.diagnostics ?? {}) as Record<string, unknown>;
  const latencyTimestamps = { ...(given.latencyTimestamps as Record<string, unknown> | undefined ?? {}), exitFillAt: fillAt, positionClosedAt: fillAt } as ExitLatencyTimestamps;
  const touchPrice = typeof given.takeProfitFirstTouchPrice === 'number' ? given.takeProfitFirstTouchPrice : null;
  const triggerMarket = typeof given.marketPriceAtTrigger === 'number' ? given.marketPriceAtTrigger : null;
  Object.assign(exitDiagnostics, {
    simulatedFillPrice: exitPrice,
    exitFillAt: fillAt,
    latencyTimestamps,
    latency: computeExitLatency(latencyTimestamps, typeof given.exitEvaluationDurationMs === 'number' ? given.exitEvaluationDurationMs : null),
    triggerToFillPriceDeteriorationPercent: priceDeteriorationPercent(triggerMarket, exitPrice),
    tpTouchToFillDeteriorationPercent: priceDeteriorationPercent(touchPrice, exitPrice),
    takeProfitFillPrice: input.exitReason === 'TAKE_PROFIT' ? exitPrice : null,
  });

  await tx.position.update({
    where: { id: position.id },
    data: { currentPrice: new Prisma.Decimal(exitMarketPrice), highestPrice: new Prisma.Decimal(highestPrice), lowestPrice: new Prisma.Decimal(lowestPrice), unrealizedPnl: new Prisma.Decimal(0), realizedPnl: new Prisma.Decimal(netPnl) },
  });

  const trade = openTrade
    ? await tx.trade.update({
        where: { id: openTrade.id },
        data: { exit: new Prisma.Decimal(exitPrice), exitMarketPrice: new Prisma.Decimal(exitMarketPrice), exitSlippage: new Prisma.Decimal(exitSlippage), slippage: new Prisma.Decimal(entrySlippage + exitSlippage), exitDiagnostics: exitDiagnostics as Prisma.InputJsonValue, fees: new Prisma.Decimal(entryFees + exitFee), pnl: new Prisma.Decimal(grossPnl), netPnl: new Prisma.Decimal(netPnl), exitReason: input.exitReason, exitAt: closedAt, status: 'CLOSED' },
      })
    : await tx.trade.create({
        data: {
          userId: input.userId,
          tokenId: position.tokenId,
          signalId: position.signalId,
          positionId: position.id,
          side: position.side,
          tokenAddress: position.token.address,
          symbol: position.token.symbol,
          entry: position.avgEntryPrice,
          exit: new Prisma.Decimal(exitPrice),
          exitMarketPrice: new Prisma.Decimal(exitMarketPrice),
          exitSlippage: new Prisma.Decimal(exitSlippage),
          slippage: new Prisma.Decimal(exitSlippage),
          exitDiagnostics: exitDiagnostics as Prisma.InputJsonValue,
          quantity: position.quantity,
          size: new Prisma.Decimal(entryPrice * quantity),
          fees: new Prisma.Decimal(exitFee),
          pnl: new Prisma.Decimal(grossPnl),
          netPnl: new Prisma.Decimal(netPnl),
          exitReason: input.exitReason,
          entryAt: position.openedAt,
          exitAt: closedAt,
          mode: 'PAPER',
          status: 'CLOSED',
        },
      });

  // Cash returned = entry notional + gross PnL - exit fee (equals exit notional - fee for longs).
  const cashCredit = entryPrice * quantity + grossPnl - exitFee;
  await tx.paperAccount.updateMany({
    where: { userId: input.userId },
    data: {
      cashBalance: { increment: new Prisma.Decimal(cashCredit) },
      realizedPnl: { increment: new Prisma.Decimal(netPnl) },
      totalFees: { increment: new Prisma.Decimal(exitFee) },
    },
  });
  await recomputePaperAccount(tx, input.userId);

  return { positionId: position.id, tradeId: trade.id, exitPrice, exitMarketPrice, exitSlippage, grossPnl, netPnl, exitFee };
}

export interface ApprovalProposalFields {
  signalId: string;
  userId: string;
  direction: string;
  entryPrice: Prisma.Decimal;
  positionSize: Prisma.Decimal;
  stopLoss: Prisma.Decimal | null;
  takeProfit: Prisma.Decimal | null;
  trailingStop: Prisma.Decimal | null;
}

/**
 * Integrity hash of a SEMI_AUTO proposal, computed from the persisted DECIMAL values so the worker
 * (on creation) and the API (on approval) always hash byte-identical input.
 */
export function hashApprovalProposal(approval: ApprovalProposalFields) {
  const decimal = (value: Prisma.Decimal | null) => (value === null ? null : value.toFixed());
  const canonical = {
    signalId: approval.signalId,
    userId: approval.userId,
    direction: approval.direction,
    entryPrice: decimal(approval.entryPrice),
    positionSize: decimal(approval.positionSize),
    stopLoss: decimal(approval.stopLoss),
    takeProfit: decimal(approval.takeProfit),
    trailingStop: decimal(approval.trailingStop),
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export interface DailyLossLimit {
  /** USDC loss at which new entries stop for the day; null when no limit is active. */
  limit: number | null;
  source: 'ABSOLUTE' | 'PERCENT' | null;
}

/**
 * The daily loss limit in effect. An explicit USDC amount ("Maximális napi veszteség") takes precedence
 * over the percent-of-equity setting; a missing, zero or negative value disables that setting.
 */
export function effectiveDailyLossLimit(equity: number, percent: number | null | undefined, absolute: number | null | undefined): DailyLossLimit {
  if (absolute !== null && absolute !== undefined && Number.isFinite(absolute) && absolute > 0) return { limit: absolute, source: 'ABSOLUTE' };
  if (percent !== null && percent !== undefined && Number.isFinite(percent) && percent > 0) return { limit: Math.max(0, equity) * percent / 100, source: 'PERCENT' };
  return { limit: null, source: null };
}
