/* eslint-disable @typescript-eslint/no-explicit-any -- hand-rolled Prisma mocks */
import { Prisma, type PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { PaperExecutionCoordinator } from '../src/paper-execution.js';
import { PositionManager, type PositionRecord } from '../src/position-manager.js';

function decimal(value: number) {
  return new Prisma.Decimal(value);
}

describe('autonomous paper trading pipeline', () => {
  it('runs signal to paper buy, position, paper sell, trade, and P&L', async () => {
    const orders: Array<Record<string, unknown>> = [];
    const fills: Array<Record<string, unknown>> = [];
    const positions: Array<Record<string, any>> = [];
    const trades: Array<Record<string, any>> = [];
    const audits: Array<Record<string, unknown>> = [];
    const events: string[] = [];
    const account = { id: 'account-1', userId: 'user-1', cashBalance: decimal(1_000), equity: decimal(1_000), totalFees: decimal(0), realizedPnl: decimal(0), unrealizedPnl: decimal(0) };
    let id = 0;
    const nextId = (prefix: string) => `${prefix}-${++id}`;
    const activeConfig = {
      userId: 'user-1',
      tradingMode: 'PAPER',
      isScannerEnabled: true,
      maxPositionSize: null,
      riskThreshold: decimal(50),
      user: { riskConfigs: [{ maxPositionPercent: decimal(10), maxTotalExposurePercent: decimal(50), maxConcurrentPositions: 3, maxSlippagePercent: decimal(3), minSignalScore: decimal(70), cooldownSeconds: 0, stopLossPercent: decimal(2), takeProfitPercent: decimal(4), trailingStopPercent: decimal(2) }] },
    };
    const signal = {
      id: 'signal-1', userId: 'user-1', tokenId: 'token-1', strategyName: 'Momentum', score: decimal(90), riskScore: decimal(10),
      recommendedStop: decimal(98), recommendedTarget: decimal(104), createdAt: new Date(),
      token: { address: 'TOKEN', symbol: 'TKN' },
    };

    const transaction = {
      paperOrder: { create: async ({ data }: any) => { const row = { id: nextId('order'), ...data }; orders.push(row); return row; } },
      paperFill: { create: async ({ data }: any) => { const row = { id: nextId('fill'), ...data }; fills.push(row); return row; } },
      position: {
        create: async ({ data }: any) => { const row = { id: nextId('position'), ...data }; positions.push(row); return row; },
        findMany: async () => positions,
      },
      trade: { create: async ({ data }: any) => { const row = { id: nextId('trade'), ...data }; trades.push(row); return row; } },
      paperAccount: {
        // Emulates the conditional, atomic cash debit (UPDATE ... WHERE cashBalance >= amount).
        updateMany: async ({ where, data }: any) => {
          if (where.cashBalance?.gte && account.cashBalance.lessThan(where.cashBalance.gte)) return { count: 0 };
          if (data.cashBalance?.decrement) account.cashBalance = account.cashBalance.minus(data.cashBalance.decrement);
          if (data.totalFees?.increment) account.totalFees = account.totalFees.plus(data.totalFees.increment);
          return { count: 1 };
        },
        findUnique: async () => account,
        update: async ({ data }: any) => { Object.assign(account, data); return account; },
      },
      auditLog: { create: async ({ data }: any) => { audits.push(data); return data; } },
    };
    const prisma = {
      botConfig: { findMany: async () => [activeConfig] },
      signal: { findMany: async () => [signal] },
      paperOrder: { findFirst: async () => null },
      approvalRequest: { findFirst: async () => null },
      trade: { findFirst: async () => null },
      paperAccount: { findUnique: async () => account },
      position: { count: async () => 0, findMany: async () => [], findFirst: async () => null },
      $transaction: async (callback: (value: typeof transaction) => Promise<unknown>) => callback(transaction),
    } as unknown as PrismaClient;

    const coordinator = new PaperExecutionCoordinator({
      prisma,
      provider: { getTokenMetrics: async () => ({ metadata: { address: 'TOKEN', symbol: 'TKN' }, timestamp: new Date(), priceUsd: 100, liquidityUsd: 1_000_000, provider: 'test' }) } as any,
      publishEvent: async (type) => { events.push(type); },
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    });

    const summary = await coordinator.runCycle(new globalThis.AbortController().signal);

    expect(summary).toMatchObject({ users: 1, candidates: 1, executed: 1, rejected: 0, errors: 0 });
    expect(orders[0].status).toBe('FILLED');
    expect(fills).toHaveLength(1);
    expect(positions).toHaveLength(1);
    expect(trades[0].status).toBe('OPEN');
    expect(audits[0]).toBeTruthy();
    expect(events).toEqual(['position_update', 'trade_update', 'pnl_update']);

    const positionRecord: PositionRecord = {
      id: positions[0].id,
      userId: 'user-1', token: 'TOKEN', symbol: 'TKN', side: 'BUY', quantity: Number(positions[0].quantity),
      avgEntryPrice: Number(positions[0].avgEntryPrice), currentPrice: 100, stopLoss: 98, takeProfit: 104, trailingStop: 0.02,
      highestPrice: 100, lowestPrice: 100, status: 'OPEN', unrealizedPnl: 0, realizedPnl: 0,
    };
    const closedEvents: string[] = [];
    const manager = new PositionManager({
      getOpenPositions: async () => [positionRecord],
      updatePosition: async () => undefined,
      closePosition: async (_positionId, updates) => { Object.assign(positionRecord, updates); },
      publishEvent: async (type) => { closedEvents.push(type); },
    });

    const closed = await manager.reconcileMarket({ TOKEN: 97 }, new Date());

    expect(closed[0].exitReason).toBe('STOP_LOSS');
    expect(positionRecord.status).toBe('CLOSED');
    expect(closedEvents).toEqual(['position_update', 'trade_update', 'pnl_update']);
    expect(Number(account.cashBalance)).toBeLessThan(1_000);
    // Equity = remaining cash + marked value of the open position (not "cash minus fee").
    const openValue = Number(positions[0].quantity) * Number(positions[0].currentPrice);
    expect(Number(account.equity)).toBeCloseTo(Number(account.cashBalance) + openValue, 6);
    // Protection levels were stored on the position at entry, derived from the entry FILL (not the signal-time price).
    expect(Number(positions[0].stopLossPrice)).toBeCloseTo(Number(positions[0].avgEntryPrice) * 0.98, 8);
    expect(Number(positions[0].takeProfitPrice)).toBeCloseTo(Number(positions[0].avgEntryPrice) * 1.04, 8);
    expect(Number(positions[0].entryMarketPrice)).toBe(100);
    expect(Number(positions[0].avgEntryPrice)).toBeGreaterThan(100);
    expect(trades[0].configSnapshot).toMatchObject({ stopLossPercent: 2, takeProfitPercent: 4, trailingStopPercent: 2, minSignalScore: 70 });
    expect(Number(positions[0].trailingStopPercent)).toBeCloseTo(0.02, 6);
  });
});

describe('paper execution price impact', () => {
  it('estimates slippage from order size against pool liquidity, not from recent volatility', async () => {
    const { estimatePriceImpactPercent } = await import('../src/paper-execution.js');
    // A $5 buy into a $30k pool barely moves the price.
    expect(estimatePriceImpactPercent(5, 30_000)).toBeLessThan(0.2);
    // A $1,000 buy into a $10k pool is a large impact.
    expect(estimatePriceImpactPercent(1_000, 10_000)).toBeGreaterThan(10);
    expect(estimatePriceImpactPercent(5, 0)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('paper execution size limit', () => {
  it('caps the order at the size whose estimated impact equals the slippage limit', async () => {
    const { estimatePriceImpactPercent, maxNotionalForSlippage } = await import('../src/paper-execution.js');
    const cap = maxNotionalForSlippage(15_000, 1);
    expect(cap).toBeGreaterThan(0);
    expect(estimatePriceImpactPercent(cap, 15_000)).toBeCloseTo(1, 6);
    expect(maxNotionalForSlippage(15_000, 0.05)).toBe(0);
  });
});

describe('position sizing', () => {
  const base = { requestedAmount: null, configuredPositionSize: 0, equity: 1000, maxPositionPercent: 10, cashAvailable: 900, remainingExposure: 250, liquidityMaximum: 5000 };

  it('buys a manual order with exactly the requested amount or rejects it with the limit it breaks', async () => {
    const { planPositionSize } = await import('../src/paper-execution.js');
    expect(planPositionSize({ ...base, manual: true, requestedAmount: 40 })).toMatchObject({ size: 40, explicit: true });
    expect(planPositionSize({ ...base, manual: true, requestedAmount: 40, configuredPositionSize: 25 }).rejection).toBe('AMOUNT_ABOVE_MAX_POSITION_SIZE');
    expect(planPositionSize({ ...base, manual: true, requestedAmount: 300 }).rejection).toBe('AMOUNT_ABOVE_EXPOSURE_LIMIT');
    expect(planPositionSize({ ...base, manual: true, requestedAmount: 40, cashAvailable: 30 }).rejection).toBe('INSUFFICIENT_PAPER_CASH');
    expect(planPositionSize({ ...base, manual: true, requestedAmount: 40, liquidityMaximum: 10 }).rejection).toBe('AMOUNT_ABOVE_LIQUIDITY_LIMIT');
  });

  it('uses the configured position size for automatic entries and shrinks it only to fit hard limits', async () => {
    const { planPositionSize } = await import('../src/paper-execution.js');
    const configured = planPositionSize({ ...base, manual: false, configuredPositionSize: 60 });
    expect(configured).toMatchObject({ size: 60, explicit: true });
    expect(configured.limitedBy).toBeUndefined();
    expect(planPositionSize({ ...base, manual: false, configuredPositionSize: 500 })).toMatchObject({ target: 500, size: 250, limitedBy: 'AMOUNT_ABOVE_EXPOSURE_LIMIT' });
    // Without a configured size the percent-of-equity default applies (and risk multipliers stay in effect).
    expect(planPositionSize({ ...base, manual: false })).toMatchObject({ size: 100, explicit: false });
  });
});
