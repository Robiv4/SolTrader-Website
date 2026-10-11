/* eslint-disable @typescript-eslint/no-explicit-any -- hand-rolled Prisma mocks */
import { Prisma, type PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { PaperExecutionCoordinator } from '../src/paper-execution.js';

const decimal = (value: number) => new Prisma.Decimal(value);

/** Runs one PAPER cycle for a single HIGH-risk signal and returns the opened order/trade (if any). */
async function runEntry(options: { configuredSize: number | null; manualAmount?: number; equity?: number; maxPositionPercent?: number; metadata?: Record<string, unknown>; score?: number; strategyName?: string }) {
  const orders: any[] = [];
  const trades: any[] = [];
  const audits: any[] = [];
  const equity = options.equity ?? 1_000;
  const account = { id: 'account-1', userId: 'user-1', cashBalance: decimal(equity), equity: decimal(equity), totalFees: decimal(0) };
  const riskConfig = {
    maxPositionPercent: decimal(options.maxPositionPercent ?? 5), maxTotalExposurePercent: decimal(100), maxConcurrentPositions: 4,
    maxSlippagePercent: decimal(3), minSignalScore: decimal(35), cooldownSeconds: 0, stopLossPercent: decimal(20), takeProfitPercent: decimal(25),
    trailingStopPercent: decimal(8), trailingActivationPercent: decimal(15), breakEvenActivationPercent: null,
    riskPolicy: 'EXPLORATORY', lowRiskMax: 30, moderateRiskMax: 50, highRiskMax: 90, veryHighRiskMax: 100,
    lowPositionMultiplier: decimal(1), moderatePositionMultiplier: decimal(0.75), highPositionMultiplier: decimal(0.35), veryHighPositionMultiplier: decimal(0.15),
    aiAnalysisEnabled: false, aiRequiredForHighRisk: false, aiRequiredForVeryHighRisk: false,
  };
  const signal = {
    id: 'signal-1', userId: 'user-1', tokenId: 'token-1', strategyName: options.strategyName ?? (options.manualAmount ? 'MANUAL_PAPER' : 'MomentumStrategy'), score: decimal(options.score ?? 65), riskScore: decimal(60),
    recommendedStop: null, recommendedTarget: null, createdAt: new Date(), reasons: [],
    metadata: { riskClassification: 'HIGH', riskPolicy: 'EXPLORATORY', ...(options.manualAmount ? { executionSource: 'MANUAL_PAPER', requestedAmount: options.manualAmount } : {}), ...options.metadata },
    token: { address: 'TOKEN', symbol: 'TKN' },
  };
  const transaction = {
    paperOrder: { create: async ({ data }: any) => { orders.push(data); return { id: 'order-1', ...data }; } },
    paperFill: { create: async ({ data }: any) => data },
    position: { create: async ({ data }: any) => ({ id: 'position-1', ...data }), findMany: async () => [] },
    trade: { create: async ({ data }: any) => { trades.push(data); return { id: 'trade-1', ...data }; } },
    paperAccount: { updateMany: async () => ({ count: 1 }), findUnique: async () => account, update: async () => account },
    auditLog: { create: async ({ data }: any) => { audits.push(data); return data; } },
  };
  const prisma = {
    botConfig: { findMany: async () => [{ userId: 'user-1', tradingMode: 'PAPER', maxPositionSize: options.configuredSize === null ? null : decimal(options.configuredSize), maxDailyLoss: null, user: { riskConfigs: [riskConfig] } }] },
    signal: { findMany: async () => [signal] },
    paperOrder: { findFirst: async () => null },
    approvalRequest: { findFirst: async () => null },
    auditLog: { findFirst: async () => null, create: async ({ data }: any) => { audits.push(data); return data; } },
    trade: { findFirst: async () => null, findMany: async () => [] },
    paperAccount: { findUnique: async () => account },
    position: { count: async () => 0, findMany: async () => [], findFirst: async () => null },
    $transaction: async (callback: (value: typeof transaction) => Promise<unknown>) => callback(transaction),
  } as unknown as PrismaClient;
  const coordinator = new PaperExecutionCoordinator({
    prisma,
    provider: { getTokenMetrics: async () => ({ metadata: { address: 'TOKEN', symbol: 'TKN' }, timestamp: new Date(), priceUsd: 1, liquidityUsd: 10_000_000, provider: 'test' }) } as any,
    publishEvent: async () => undefined,
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    // Shared sizing engine with generic signals (production executes NEW_LAUNCH only).
    automaticSources: ['STRATEGY', 'MANUAL_PAPER', 'NEW_LAUNCH'],
  });
  const summary = await coordinator.runCycle({ aborted: false });
  return { summary, order: orders[0], trade: trades[0], audits };
}

describe('risk-adjusted position sizing', () => {
  it('applies the HIGH multiplier to the percent default: 5% x 0.35 = 1.75% of equity', async () => {
    const { order, trade } = await runEntry({ configuredSize: null });
    expect(Number(order.requestedNotionalUsd)).toBeCloseTo(17.5, 8);
    expect(trade.configSnapshot).toMatchObject({ riskMultiplier: 0.35, maxPositionPercent: 5, trailingActivationPercent: 15, trailingStopPercent: 8 });
  });

  it('applies the HIGH multiplier to a configured USDC size as well (100 x 0.35 = 35)', async () => {
    const { order } = await runEntry({ configuredSize: 100 });
    expect(Number(order.requestedNotionalUsd)).toBeCloseTo(35, 8);
  });

  it('buys exactly the requested amount for a manual Paper buy (no multiplier)', async () => {
    const { order } = await runEntry({ configuredSize: 100, manualAmount: 50 });
    expect(Number(order.requestedNotionalUsd)).toBeCloseTo(50, 8);
  });

  it('never exceeds the risk-adjusted maximum', async () => {
    for (const equity of [100, 1_000, 25_000]) {
      const { order } = await runEntry({ configuredSize: null, equity });
      expect(Number(order.requestedNotionalUsd)).toBeLessThanOrEqual(equity * 0.05 * 0.35 + 1e-9);
    }
  });

  it('rejects dust entries below 1 USDC instead of opening them', async () => {
    const { summary, order } = await runEntry({ configuredSize: null, equity: 40 });
    expect(order).toBeUndefined();
    expect(summary.rejected).toBe(1);
  });
});

describe('signals never override safety', () => {
  const analysis = { version: 1, compositeScore: 96, confirmations: 6, confirmedModules: ['VolumeSpike', 'BuyPressure', 'MomentumAcceleration', 'ConfirmedBreakout', 'RelativeStrength', 'Momentum'], exhaustionScore: 10 };

  it('a composite score of 96 does not bypass a hard safety block: no PAPER buy', async () => {
    const { order, audits } = await runEntry({ configuredSize: null, strategyName: 'CompositeSignal', score: 96, metadata: { hardBlocked: true, hardBlockReasons: ['SELLABILITY_FAILED'], analysis } });
    expect(order).toBeUndefined();
    expect(audits.some((audit) => audit.action === 'HARD_BLOCK_TRIGGERED')).toBe(true);
  });

  it('momentum 95 with exhaustion 94 above the block threshold: automatic entry is prevented', async () => {
    const { order, summary } = await runEntry({ configuredSize: null, score: 95, metadata: { exhaustionBlocked: true, analysis: { ...analysis, exhaustionScore: 94, exhaustionBlocked: true } } });
    expect(order).toBeUndefined();
    expect(summary.rejected).toBe(1);
  });

  it('a critical liquidity outflow prevents automatic entry', async () => {
    const { order } = await runEntry({ configuredSize: null, score: 90, metadata: { criticalLiquidityOutflow: true } });
    expect(order).toBeUndefined();
  });

  it('a composite BUY goes through the normal path: HIGH risk -> reduced size, analysis stored on the trade', async () => {
    const { order, trade, audits } = await runEntry({ configuredSize: null, strategyName: 'CompositeSignal', score: 84, metadata: { primaryStrategy: 'CompositeSignal', analysis } });
    expect(Number(order.requestedNotionalUsd)).toBeCloseTo(17.5, 8);
    expect(audits.some((audit) => audit.action === 'TRADE_APPROVED_REDUCED_SIZE')).toBe(true);
    expect(trade.configSnapshot.signalContext).toMatchObject({ primaryStrategy: 'CompositeSignal', compositeScore: 96, confirmedModules: analysis.confirmedModules, source: 'SIGNAL' });
  });

  it('a manual PAPER buy keeps the real analysis unchanged', async () => {
    const { order, trade } = await runEntry({ configuredSize: null, manualAmount: 20, metadata: { analysis: { ...analysis, compositeScore: 41 } } });
    expect(Number(order.requestedNotionalUsd)).toBeCloseTo(20, 8);
    expect(trade.signalScore.toNumber()).toBe(65);
    expect(trade.configSnapshot.signalContext).toMatchObject({ primaryStrategy: 'MANUAL_PAPER', compositeScore: 41 });
  });
});
