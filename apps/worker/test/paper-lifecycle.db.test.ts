/* eslint-disable @typescript-eslint/no-explicit-any -- market-data provider stub */
/**
 * Deterministic PAPER simulations against the development database: a real entry through the
 * PaperExecutionCoordinator, then scripted price paths through the PositionManager with the real Prisma
 * store, for STOP_LOSS, TAKE_PROFIT, TRAILING_STOP and a manual close. Uses its own throw-away user.
 */
import { randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import { closePaperPosition, estimateExitSlippagePercent } from '@soltrader/trading-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PaperExecutionCoordinator } from '../src/paper-execution.js';
import { PositionManager } from '../src/position-manager.js';
import { createPrismaPositionStore } from '../src/position-store.js';

const prisma = new PrismaClient();
const runId = randomUUID().slice(0, 8);
const LIQUIDITY = 5_000_000;
let userId = '';
const tokens: Record<string, { id: string; address: string }> = {};
const prices: Record<string, number> = {};

/** The coordinator only ever sees this user's bot config (the dev database is shared with real accounts). */
function scopedPrisma(): PrismaClient {
  return new Proxy(prisma, {
    get(target, key) {
      if (key === 'botConfig') {
        return { ...target.botConfig, findMany: (args: any) => target.botConfig.findMany({ ...args, where: { ...args?.where, userId } }) };
      }
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as PrismaClient;
}

const provider = {
  getTokenMetrics: async (address: string) => ({ metadata: { address, symbol: address.slice(0, 6) }, timestamp: new Date(), priceUsd: prices[address], liquidityUsd: LIQUIDITY, volume24h: 1_000_000, priceChange1h: 3, priceChange24h: 40, provider: 'simulation' }),
} as any;

async function enter(name: string) {
  const token = tokens[name];
  prices[token.address] = 1;
  await prisma.signal.create({ data: { tokenId: token.id, userId, strategyName: 'MomentumStrategy', direction: 'BUY', score: 65, riskScore: 60, signalType: 'STRATEGY', reasons: ['SIMULATION'], metadata: { riskClassification: 'HIGH', riskPolicy: 'EXPLORATORY' }, mode: 'SCANNER' } });
  const coordinator = new PaperExecutionCoordinator({ prisma: scopedPrisma(), provider, publishEvent: async () => undefined, logger: { info: () => undefined, warn: () => undefined, error: () => undefined } });
  const summary = await coordinator.runCycle({ aborted: false });
  expect(summary.executed).toBe(1);
  return prisma.position.findFirstOrThrow({ where: { userId, tokenId: token.id, status: 'OPEN' } });
}

async function walk(name: string, path: number[]) {
  const manager = new PositionManager(createPrismaPositionStore(prisma, { userId, publishEvent: async () => undefined }));
  const address = tokens[name].address;
  for (const price of path) {
    prices[address] = price;
    const closed = await manager.reconcileMarket({ [address]: { price, liquidityUsd: LIQUIDITY } });
    if (closed.length) return closed[0];
  }
  return null;
}

async function closedTrade(name: string) {
  return prisma.trade.findFirstOrThrow({ where: { userId, tokenId: tokens[name].id }, include: { position: true } });
}

beforeAll(async () => {
  const user = await prisma.user.create({ data: { email: `paper-sim-${runId}@soltrader.test` } });
  userId = user.id;
  await prisma.paperAccount.create({ data: { userId, initialBalance: 1_000, cashBalance: 1_000, equity: 1_000 } });
  await prisma.botConfig.create({ data: { userId, tradingMode: 'PAPER', status: 'RUNNING', isScannerEnabled: true } });
  await prisma.riskConfig.create({ data: {
    userId, maxPositionPercent: 5, maxTotalExposurePercent: 25, maxConcurrentPositions: 4, dailyLossLimitPercent: 8, maxSlippagePercent: 3,
    minSignalScore: 35, cooldownSeconds: 60, stopLossPercent: 20, takeProfitPercent: 25, trailingStopPercent: 8, trailingActivationPercent: 15,
    riskPolicy: 'EXPLORATORY', lowRiskMax: 30, moderateRiskMax: 50, highRiskMax: 90, veryHighRiskMax: 100,
  } });
  for (const name of ['SL', 'TP', 'TRAIL', 'MANUAL', 'CONC', 'RESTART']) {
    const address = `SIM${name}${runId}`;
    tokens[name] = await prisma.token.create({ data: { address, symbol: `SIM${name}` }, select: { id: true, address: true } });
  }
});

afterAll(async () => {
  if (userId) {
    const orders = await prisma.paperOrder.findMany({ where: { userId }, select: { id: true } });
    await prisma.paperFill.deleteMany({ where: { paperOrderId: { in: orders.map((order) => order.id) } } });
    await prisma.paperOrder.deleteMany({ where: { userId } });
    await prisma.trade.deleteMany({ where: { userId } });
    await prisma.position.deleteMany({ where: { userId } });
    await prisma.auditLog.deleteMany({ where: { userId } });
    await prisma.signal.deleteMany({ where: { userId } });
    await prisma.token.deleteMany({ where: { id: { in: Object.values(tokens).map((token) => token.id) } } });
    await prisma.riskConfig.deleteMany({ where: { userId } });
    await prisma.botConfig.deleteMany({ where: { userId } });
    await prisma.paperAccount.deleteMany({ where: { userId } });
    await prisma.user.delete({ where: { id: userId } });
  }
  await prisma.$disconnect();
});

describe('deterministic PAPER lifecycle (SL 20%, TP 25%, trailing 8% after +15%, HIGH 0.35 x 5%)', () => {
  it('STOP_LOSS: entry, a small dip does not close (trailing not armed), -21% closes at a loss', async () => {
    const position = await enter('SL');
    const fill = Number(position.avgEntryPrice);
    expect(Number(position.entryMarketPrice)).toBe(1);
    expect(fill).toBeGreaterThan(1);
    expect(Number(position.stopLossPrice)).toBeCloseTo(fill * 0.8, 10);
    expect(Number(position.takeProfitPrice)).toBeCloseTo(fill * 1.25, 10);
    const closed = await walk('SL', [0.97, 0.95, 0.9, 0.79]);
    expect(closed?.exitReason).toBe('STOP_LOSS');
    const trade = await closedTrade('SL');
    expect(Number(trade.size)).toBeCloseTo(17.5, 6);
    expect(Number(trade.exitMarketPrice)).toBe(0.79);
    expect(Number(trade.exit)).toBeLessThan(0.79);
    expect(Number(trade.netPnl)).toBeCloseTo(Number(trade.pnl) - Number(trade.fees), 8);
    expect(Number(trade.netPnl)).toBeLessThan(0);
    // Fees exactly once per side (0.30% of the entry notional + 0.30% of the exit fill notional).
    const exitNotional = Number(trade.exit) * Number(trade.quantity);
    expect(Number(trade.fees)).toBeCloseTo(Number(trade.size) * 0.003 + exitNotional * 0.003, 8);
    // Entry slippage lives in the entry fill (> market 1), exit slippage in the exit fill (< observed 0.79): once each.
    expect(Number(trade.slippage)).toBeCloseTo((fill - 1) * Number(trade.quantity) + (0.79 - Number(trade.exit)) * Number(trade.quantity), 8);
  });

  it('TAKE_PROFIT: +26% closes the whole position with a profit', async () => {
    await enter('TP');
    const closed = await walk('TP', [1.05, 1.1, 1.26]);
    expect(closed?.exitReason).toBe('TAKE_PROFIT');
    const trade = await closedTrade('TP');
    expect(trade.status).toBe('CLOSED');
    expect(Number(trade.quantity)).toBeCloseTo(Number(trade.position!.quantity), 8);
    expect(Number(trade.netPnl)).toBeGreaterThan(0);
  });

  it('TRAILING_STOP: arms at +15%, follows the peak, exits in profit on the pullback', async () => {
    const position = await enter('TRAIL');
    const fill = Number(position.avgEntryPrice);
    const peak = fill * 1.2;
    const closed = await walk('TRAIL', [1.05, 1.1, fill * 1.16, peak, peak * 0.95, peak * 0.91]);
    expect(closed?.exitReason).toBe('TRAILING_STOP');
    const trade = await closedTrade('TRAIL');
    expect(trade.position!.trailingActive).toBe(true);
    expect(Number(trade.position!.trailingActivationPrice)).toBeCloseTo(fill * 1.16, 8);
    expect(Number(trade.position!.trailingTriggerPrice)).toBeCloseTo(peak * 0.92, 8);
    expect(Number(trade.position!.highestPrice)).toBeCloseTo(peak, 8);
    expect(trade.exitDiagnostics).toMatchObject({ exitReason: 'TRAILING_STOP', trailingActive: true });
    // Trigger vs fill are separate, authoritative fields; latency components come from real timestamps.
    const diagnostics = trade.exitDiagnostics as Record<string, any>;
    expect(diagnostics.simulatedFillPrice).toBeCloseTo(Number(trade.exit), 12);
    expect(diagnostics.marketPriceAtTrigger).toBeCloseTo(peak * 0.91, 8);
    expect(diagnostics.exitTriggerPrice).toBeCloseTo(peak * 0.92, 8);
    expect(diagnostics.triggerToFillPriceDeteriorationPercent).toBeLessThan(0);
    expect(typeof diagnostics.latency.triggerToFillLatencyMs).toBe('number');
    expect(diagnostics.latency.triggerToFillLatencyMs).toBeGreaterThanOrEqual(0);
    expect(diagnostics.latencyTimestamps.exitFillAt).toBeTruthy();
    expect(Number(trade.netPnl)).toBeGreaterThan(0);
  });

  it('concurrent closes of the same position book exactly one PAPER sell', async () => {
    const position = await enter('CONC');
    const close = () => prisma.$transaction((transaction) => closePaperPosition(transaction, { positionId: position.id, userId, exitPrice: 0.9, exitSlippagePercent: 0.1, exitReason: 'STOP_LOSS' }));
    const results = await Promise.allSettled([close(), close(), close()]);
    const booked = results.filter((result) => result.status === 'fulfilled' && result.value !== null);
    expect(booked).toHaveLength(1);
    const trades = await prisma.trade.findMany({ where: { userId, positionId: position.id } });
    expect(trades).toHaveLength(1);
    expect(trades[0].status).toBe('CLOSED');
    const sells = await prisma.paperOrder.count({ where: { userId, tokenAddress: tokens.CONC.address, side: 'SELL' } });
    expect(sells).toBeLessThanOrEqual(1);
  });

  it('restart: a new PositionManager continues from the stored trailing state and never lowers it', async () => {
    const position = await enter('RESTART');
    const fill = Number(position.avgEntryPrice);
    const address = tokens.RESTART.address;
    const peak = fill * 1.2;
    expect(await walk('RESTART', [fill * 1.16, peak])).toBeNull();
    const stored = await prisma.position.findUniqueOrThrow({ where: { id: position.id } });
    expect(stored.trailingActive).toBe(true);
    expect(Number(stored.trailingTriggerPrice)).toBeCloseTo(peak * 0.92, 8);
    // Fresh instances (= worker restarts) read everything from the database.
    const restarted = new PositionManager(createPrismaPositionStore(prisma, { userId, publishEvent: async () => undefined }));
    prices[address] = peak * 0.95;
    expect(await restarted.reconcileMarket({ [address]: { price: peak * 0.95, liquidityUsd: LIQUIDITY } })).toHaveLength(0);
    const after = await prisma.position.findUniqueOrThrow({ where: { id: position.id } });
    expect(Number(after.trailingTriggerPrice)).toBeCloseTo(peak * 0.92, 8);
    expect(Number(after.highestPrice)).toBeCloseTo(peak, 8);
    const closed = await walk('RESTART', [peak * 0.91]);
    expect(closed?.exitReason).toBe('TRAILING_STOP');
    const trade = await closedTrade('RESTART');
    expect((trade.exitDiagnostics as Record<string, number>).exitTriggerPrice).toBeCloseTo(peak * 0.92, 8);
  });

  it('manual close: books the exit with modelled slippage, and the account reconciles exactly', async () => {
    const position = await enter('MANUAL');
    const quantity = Number(position.quantity);
    const result = await prisma.$transaction((transaction) => closePaperPosition(transaction, {
      positionId: position.id, userId, exitPrice: 1.02, exitSlippagePercent: estimateExitSlippagePercent(1.02, quantity, LIQUIDITY), exitReason: 'manual-close',
    }));
    expect(result).not.toBeNull();
    const trade = await closedTrade('MANUAL');
    expect(trade.exitReason).toBe('manual-close');
    expect(Number(trade.exit)).toBeLessThan(1.02);

    const trades = await prisma.trade.findMany({ where: { userId } });
    const account = await prisma.paperAccount.findUniqueOrThrow({ where: { userId } });
    const net = trades.reduce((total, row) => total + Number(row.netPnl), 0);
    const fees = trades.reduce((total, row) => total + Number(row.fees), 0);
    expect(trades.every((row) => row.status === 'CLOSED' && row.configSnapshot !== null && row.exitDiagnostics !== null)).toBe(true);
    // Cash after all round trips = initial balance + total net P&L; no cost is counted twice.
    expect(Number(account.cashBalance)).toBeCloseTo(1_000 + net, 6);
    expect(Number(account.realizedPnl)).toBeCloseTo(net, 6);
    expect(Number(account.totalFees)).toBeCloseTo(fees, 6);
    expect(Number(account.equity)).toBeCloseTo(Number(account.cashBalance), 6);
  });
});
