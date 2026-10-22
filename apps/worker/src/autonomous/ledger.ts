/**
 * Separate virtual PAPER ledger of the Autonomous ML strategy (MlAutonomousAccount / Position / Fill). It never touches
 * the user's PAPER account, positions or trades, and no real funds exist anywhere. Fills use the PAPER cost model
 * (impact from the PAPER impact model at the current liquidity + 30 bps fee per side), identical to the labels.
 *
 * Every write runs in one transaction with conditional updates, so a duplicated or concurrent decision can never open
 * a second position for a token (openKey is unique while OPEN) or sell the same quantity twice.
 */
import { Prisma, type PrismaClient } from '@prisma/client';
import { AUTONOMOUS_FEE_RATE, impactPercent } from '@soltrader/strategy-engine';

export const AUTONOMOUS_ACCOUNT_PREFIX = 'ML_AUTONOMOUS_PAPER';
const dec = (value: number, digits = 6) => new Prisma.Decimal(value.toFixed(digits));
const n = (value: unknown) => Number(value ?? 0);

export type LedgerPrisma = Pick<PrismaClient, 'mlAutonomousAccount' | 'mlAutonomousPosition' | 'mlAutonomousFill' | '$transaction'>;

export class LedgerError extends Error {
  constructor(readonly code: 'INSUFFICIENT_CASH' | 'ALREADY_OPEN' | 'POSITION_CHANGED' | 'INVALID_PRICE', message?: string) {
    super(message ?? code);
  }
}

export async function ensureAccount(prisma: Pick<PrismaClient, 'mlAutonomousAccount'>, userId: string, initialBalanceUsd: number) {
  const existing = await prisma.mlAutonomousAccount.findUnique({ where: { userId } });
  if (existing) return existing;
  return prisma.mlAutonomousAccount.upsert({
    where: { userId }, update: {},
    create: { userId, accountKey: `${AUTONOMOUS_ACCOUNT_PREFIX}:${userId}`, initialBalance: dec(initialBalanceUsd), cashBalance: dec(initialBalanceUsd) },
  });
}

export interface OpenInput {
  accountId: string;
  userId: string;
  mint: string;
  symbol: string | null;
  bundleVersion: string;
  sizeUsd: number;
  marketPrice: number;
  liquidityUsd: number | null;
  entryContext: unknown;
  entrySnapshotId: string | null;
  decisionId: string;
  at: Date;
}

export async function openPosition(prisma: LedgerPrisma, input: OpenInput) {
  if (!(input.marketPrice > 0) || !(input.sizeUsd > 0)) throw new LedgerError('INVALID_PRICE');
  const impact = impactPercent(input.sizeUsd, input.liquidityUsd);
  const fillPrice = input.marketPrice * (1 + impact / 100);
  const quantity = input.sizeUsd / fillPrice;
  const fee = input.sizeUsd * AUTONOMOUS_FEE_RATE;
  return prisma.$transaction(async (tx) => {
    const account = await tx.mlAutonomousAccount.findUniqueOrThrow({ where: { id: input.accountId } });
    if (n(account.cashBalance) < input.sizeUsd + fee) throw new LedgerError('INSUFFICIENT_CASH');
    // Conditional cash debit (concurrent decisions cannot overdraw the account).
    const debited = await tx.mlAutonomousAccount.updateMany({ where: { id: account.id, cashBalance: { gte: dec(input.sizeUsd + fee) } }, data: { cashBalance: { decrement: dec(input.sizeUsd + fee) }, feesPaid: { increment: dec(fee) }, impactCost: { increment: dec(input.sizeUsd - quantity * input.marketPrice) } } });
    if (debited.count !== 1) throw new LedgerError('INSUFFICIENT_CASH');
    let position;
    try {
      position = await tx.mlAutonomousPosition.create({ data: {
        accountId: input.accountId, userId: input.userId, mint: input.mint, symbol: input.symbol, bundleVersion: input.bundleVersion, status: 'OPEN', openKey: `${input.accountId}:${input.mint}`,
        initialQuantity: dec(quantity, 12), quantity: dec(quantity, 12), entryFillPrice: dec(fillPrice, 18), entryMarketPrice: dec(input.marketPrice, 18), entryNotionalUsd: dec(input.sizeUsd),
        entryFeeUsd: dec(fee), entryImpactPct: dec(impact, 4), entryLiquidityUsd: input.liquidityUsd !== null ? dec(input.liquidityUsd, 8) : null, entryContext: input.entryContext as Prisma.InputJsonValue,
        entrySnapshotId: input.entrySnapshotId, entryDecisionId: input.decisionId, highestPrice: dec(input.marketPrice, 18), lowestPrice: dec(input.marketPrice, 18), feesUsd: dec(fee), openedAt: input.at,
      } });
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002') throw new LedgerError('ALREADY_OPEN');
      throw error;
    }
    await tx.mlAutonomousFill.create({ data: { positionId: position.id, accountId: input.accountId, side: 'BUY', quantity: dec(quantity, 12), fillPrice: dec(fillPrice, 18), marketPrice: dec(input.marketPrice, 18), notionalUsd: dec(input.sizeUsd), feeUsd: dec(fee), impactPct: dec(impact, 4), decisionId: input.decisionId, reason: 'MODEL_BUY', at: input.at } });
    return { position, fillPrice, quantity, fee, impact };
  });
}

export interface SellInput {
  positionId: string;
  /** 0 < fraction <= 1 of the CURRENT quantity. */
  fraction: number;
  marketPrice: number;
  liquidityUsd: number | null;
  reason: string;
  decisionId: string | null;
  at: Date;
}

export async function sellPosition(prisma: LedgerPrisma, input: SellInput) {
  if (!(input.marketPrice > 0) || !(input.fraction > 0)) throw new LedgerError('INVALID_PRICE');
  return prisma.$transaction(async (tx) => {
    const position = await tx.mlAutonomousPosition.findUniqueOrThrow({ where: { id: input.positionId } });
    if (position.status !== 'OPEN') throw new LedgerError('POSITION_CHANGED');
    const held = n(position.quantity);
    const full = input.fraction >= 0.999 || held * (1 - input.fraction) * input.marketPrice < 0.5;
    const quantity = full ? held : held * input.fraction;
    const notional = quantity * input.marketPrice;
    const impact = impactPercent(notional, input.liquidityUsd);
    const fillPrice = input.marketPrice * (1 - impact / 100);
    const proceeds = quantity * fillPrice;
    const fee = proceeds * AUTONOMOUS_FEE_RATE;
    const share = quantity / n(position.initialQuantity);
    const costBasis = quantity * n(position.entryFillPrice) + n(position.entryFeeUsd) * share;
    const realized = proceeds - fee - costBasis;
    // Conditional: only the exact quantity read above can be sold (a concurrent / repeated sell changes nothing).
    const updated = await tx.mlAutonomousPosition.updateMany({
      where: { id: position.id, status: 'OPEN', quantity: position.quantity },
      data: full
        ? { status: 'CLOSED', openKey: null, quantity: dec(0, 12), closedAt: input.at, exitReason: input.reason, realizedPnlUsd: { increment: dec(realized) }, feesUsd: { increment: dec(fee) } }
        : { quantity: dec(held - quantity, 12), partiallySold: true, realizedPnlUsd: { increment: dec(realized) }, feesUsd: { increment: dec(fee) } },
    });
    if (updated.count !== 1) throw new LedgerError('POSITION_CHANGED');
    await tx.mlAutonomousAccount.update({ where: { id: position.accountId }, data: { cashBalance: { increment: dec(proceeds - fee) }, realizedPnl: { increment: dec(realized) }, feesPaid: { increment: dec(fee) }, impactCost: { increment: dec(notional - proceeds) } } });
    await tx.mlAutonomousFill.create({ data: { positionId: position.id, accountId: position.accountId, side: 'SELL', quantity: dec(quantity, 12), fillPrice: dec(fillPrice, 18), marketPrice: dec(input.marketPrice, 18), notionalUsd: dec(proceeds), feeUsd: dec(fee), impactPct: dec(impact, 4), realizedPnlUsd: dec(realized), decisionId: input.decisionId, reason: input.reason, at: input.at } });
    return { quantity, fillPrice, proceeds, fee, realized, closed: full };
  });
}
