/* eslint-disable @typescript-eslint/no-explicit-any -- market-data provider stub and scoped Prisma proxy */
/**
 * Deterministic end-to-end PAPER run of the advanced signal pipeline against the development database
 * (own throw-away user): snapshots -> features -> modules -> composite -> risk (HIGH, no hard block) ->
 * APPROVED_REDUCED_SIZE -> PAPER BUY -> position -> exit -> trade -> analytics, with SSE events captured.
 */
import { randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import { PrismaMarketDataRepository, type TokenMarketSnapshot } from '@soltrader/market-data';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { computeTradeAnalytics, type AnalyticsTrade } from '../../api/src/trade-analytics.js';
import { PaperExecutionCoordinator } from '../src/paper-execution.js';
import { PositionManager } from '../src/position-manager.js';
import { createPrismaPositionStore } from '../src/position-store.js';
import { StrategyRunner } from '../src/strategy-runner.js';

const prisma = new PrismaClient();
const runId = randomUUID().slice(0, 8);
const address = `SIMCOMP${runId}`;
const MINUTE = 60_000;
let userId = '';
let tokenId = '';
const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
const logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

/** Deterministic price path: flat, then accelerating (+1%, +3%, ~+5.8% per 5 minutes) into a breakout. */
function priceAt(minutesAgo: number) {
  if (minutesAgo >= 15) return 1;
  if (minutesAgo >= 10) return 1 + (15 - minutesAgo) / 5 * 0.01;
  if (minutesAgo >= 5) return 1.01 + (10 - minutesAgo) / 5 * 0.03;
  return 1.04 + (5 - minutesAgo) / 5 * 0.06;
}

function snapshotAt(minutesAgo: number, now: number): TokenMarketSnapshot {
  const latest = minutesAgo === 0;
  return {
    metadata: { address, symbol: 'SIMC', name: 'Composite simulation' },
    timestamp: new Date(now - minutesAgo * MINUTE),
    priceUsd: priceAt(minutesAgo),
    liquidityUsd: 200_000,
    volume24h: 2_000_000,
    priceChange1h: 12,
    priceChange24h: 20,
    priceChange5m: latest ? 5.8 : 1,
    volume5m: latest ? 30_000 : minutesAgo === 5 ? 15_000 : 10_000,
    volume1h: latest ? 140_000 : 120_000,
    buyCount5m: latest ? 180 : 60,
    sellCount5m: latest ? 75 : 60,
    buyCount1h: 700,
    sellCount1h: 700,
    provider: 'simulation',
    dataQuality: 'VALID',
  };
}

let current: TokenMarketSnapshot;
const provider = { getTokenMetrics: async () => ({ ...current, timestamp: new Date() }) } as any;

/** Only this test's user is visible to the worker stages (the dev database is shared). */
function scopedPrisma(): PrismaClient {
  return new Proxy(prisma, {
    get(target, key) {
      if (key === 'botConfig') return { ...target.botConfig, findMany: (args: any) => target.botConfig.findMany({ ...args, where: { ...args?.where, userId } }) };
      if (key === 'riskAssessment') return { ...target.riskAssessment, findMany: (args: any) => target.riskAssessment.findMany({ ...args, where: { ...args?.where, userId } }) };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as PrismaClient;
}

beforeAll(async () => {
  const user = await prisma.user.create({ data: { email: `composite-sim-${runId}@soltrader.test` } });
  userId = user.id;
  await prisma.paperAccount.create({ data: { userId, initialBalance: 1_000, cashBalance: 1_000, equity: 1_000 } });
  await prisma.botConfig.create({ data: { userId, tradingMode: 'PAPER', status: 'RUNNING', isScannerEnabled: true } });
  await prisma.riskConfig.create({ data: {
    userId, maxPositionPercent: 5, maxTotalExposurePercent: 25, maxConcurrentPositions: 4, dailyLossLimitPercent: 8, maxSlippagePercent: 3,
    minSignalScore: 35, cooldownSeconds: 60, stopLossPercent: 20, takeProfitPercent: 25, trailingStopPercent: 8, trailingActivationPercent: 15,
    breakEvenActivationPercent: 10, riskPolicy: 'EXPLORATORY', lowRiskMax: 30, moderateRiskMax: 50, highRiskMax: 90, veryHighRiskMax: 100,
  } });
  await prisma.advancedStrategyConfig.create({ data: {
    userId, compositeEnabled: true, minimumConfirmations: 3, minimumCompositeScore: 60,
    modules: { PullbackContinuation: { enabled: false } },
  } });
  // Market snapshots collected by the scanner over 20 minutes.
  const now = Date.now();
  const repository = new PrismaMarketDataRepository(prisma);
  for (let ago = 20; ago >= 1; ago -= 1) await repository.save(snapshotAt(ago, now));
  current = snapshotAt(0, now);
  tokenId = (await prisma.token.findUniqueOrThrow({ where: { address } })).id;
  // Risk engine: HIGH but no hard block.
  await prisma.riskAssessment.create({ data: { tokenId, userId, riskScore: 60, decision: 'ACCEPT', classification: 'HIGH', hardBlocked: false, hardBlockReasons: [], riskPolicy: 'EXPLORATORY', positionMultiplier: 0.35, factors: {}, rejectionReasons: [], warnings: [], source: 'simulation' } });
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
    await prisma.riskAssessment.deleteMany({ where: { userId } });
    await prisma.tokenMetric.deleteMany({ where: { tokenId } });
    await prisma.token.deleteMany({ where: { id: tokenId } });
    await prisma.advancedStrategyConfig.deleteMany({ where: { userId } });
    await prisma.riskConfig.deleteMany({ where: { userId } });
    await prisma.botConfig.deleteMany({ where: { userId } });
    await prisma.paperAccount.deleteMany({ where: { userId } });
    await prisma.user.delete({ where: { id: userId } });
  }
  await prisma.$disconnect();
});

describe('advanced signal pipeline (deterministic PAPER run)', () => {
  it('snapshots -> composite BUY -> reduced-size PAPER buy -> managed exit -> trade -> analytics', async () => {
    const metrics = await prisma.tokenMetric.findMany({ where: { tokenId }, orderBy: { timestamp: 'asc' } });
    expect(metrics).toHaveLength(20);
    expect(Number(metrics.at(-1)!.volume5m)).toBe(10_000);
    expect(metrics.at(-1)!.buyCount5m).toBe(60);

    const cached: Record<string, unknown> = {};
    const runner = new StrategyRunner({
      prisma: scopedPrisma(), provider, logger, registry: {} as any, lookbackMs: 10 * MINUTE, historyWindow: 20, staleAfterMs: 2 * MINUTE,
      publishEvent: async (type, payload) => { events.push({ type, payload }); },
      cacheAnalysis: async (_user, token, analysis) => { cached[token] = analysis; },
    });
    await runner.runCycle({ aborted: false });

    const composite = await prisma.signal.findFirstOrThrow({ where: { userId, strategyName: 'CompositeSignal' } });
    const analysis = (composite.metadata as any).analysis;
    const status = Object.fromEntries(analysis.results.map((result: any) => [result.strategy, result]));
    expect(status.VolumeSpike.triggered).toBe(true);
    expect(status.BuyPressure.triggered).toBe(true);
    expect(status.MomentumAcceleration.triggered).toBe(true);
    expect(status.ConfirmedBreakout.triggered).toBe(true);
    expect(status.PumpExhaustion.score).toBeLessThan(40);
    expect(status.RelativeStrength.status).toBe('UNAVAILABLE');
    expect(analysis.confirmations).toBeGreaterThanOrEqual(4);
    expect(composite.direction).toBe('BUY');
    expect(Number(composite.score)).toBeGreaterThanOrEqual(60);
    expect(analysis.settings.minimumConfirmations).toBe(3);
    expect(cached[address]).toBeTruthy();
    expect(events.some((event) => event.type === 'signal_update' && event.payload.strategy === 'CompositeSignal')).toBe(true);

    const coordinator = new PaperExecutionCoordinator({ prisma: scopedPrisma(), provider, logger, publishEvent: async (type, payload) => { events.push({ type, payload }); } });
    const summary = await coordinator.runCycle({ aborted: false });
    expect(summary.executed).toBe(1);
    const approval = await prisma.auditLog.findFirstOrThrow({ where: { userId, action: 'TRADE_APPROVED_REDUCED_SIZE' } });
    expect((approval.details as any).positionMultiplier).toBe(0.35);
    const position = await prisma.position.findFirstOrThrow({ where: { userId, status: 'OPEN' } });
    const openTrade = await prisma.trade.findFirstOrThrow({ where: { userId, status: 'OPEN' } });
    expect(Number(openTrade.size)).toBeCloseTo(1_000 * 0.05 * 0.35, 6);
    expect(openTrade.strategyName).toBe('CompositeSignal');
    expect((openTrade.configSnapshot as any).signalContext.confirmedModules).toEqual(expect.arrayContaining(['VolumeSpike', 'BuyPressure', 'MomentumAcceleration', 'ConfirmedBreakout']));
    expect(Number(position.entryLiquidityUsd)).toBe(200_000);
    expect(events.map((event) => event.type)).toEqual(expect.arrayContaining(['position_update', 'trade_update', 'pnl_update']));

    // Position management: break-even arms at +10%, trailing at +15%, then the pullback closes via trailing.
    const fill = Number(position.avgEntryPrice);
    const manager = new PositionManager(createPrismaPositionStore(prisma, { userId, publishEvent: async (type, payload) => { events.push({ type, payload }); } }));
    let closed = null;
    for (const price of [fill * 1.05, fill * 1.12, fill * 1.2, fill * 1.1]) {
      const result = await manager.reconcileMarket({ [address]: { price, liquidityUsd: 200_000 } });
      if (result.length) { closed = result[0]; break; }
    }
    expect(closed?.exitReason).toBe('TRAILING_STOP');
    const trade = await prisma.trade.findFirstOrThrow({ where: { userId }, include: { position: true } });
    expect(trade.status).toBe('CLOSED');
    expect(trade.position!.breakEvenAppliedAt).not.toBeNull();
    expect(Number(trade.netPnl)).toBeCloseTo(Number(trade.pnl) - Number(trade.fees), 8);
    expect(Number(trade.netPnl)).toBeGreaterThan(0);

    const context = (trade.configSnapshot as any).signalContext;
    const row: AnalyticsTrade = {
      netPnl: Number(trade.netPnl), grossPnl: Number(trade.pnl), fees: Number(trade.fees), slippage: Number(trade.slippage), size: Number(trade.size),
      entryPrice: Number(trade.entry), exitPrice: Number(trade.exit), entryAt: trade.entryAt, exitAt: trade.exitAt, strategy: trade.strategyName ?? '',
      exitReason: trade.exitReason ?? '', riskClassification: trade.riskClassification ?? '', signalScore: Number(trade.signalScore), manual: false,
      highestPrice: Number(trade.position!.highestPrice), lowestPrice: Number(trade.position!.lowestPrice), trailingActivationPercent: 0.15,
      trailingActivationPrice: Number(trade.position!.trailingActivationPrice), trailingActivatedAt: trade.position!.trailingActivatedAt,
      primaryStrategy: context.primaryStrategy, confirmations: context.confirmedModules, compositeScore: context.compositeScore, exhaustionScore: context.exhaustionScore,
    };
    const report = computeTradeAnalytics([row], 1_000);
    expect(report.signalContextTrades).toBe(1);
    expect(report.confirmationPerformance.map((group) => group.name)).toEqual(expect.arrayContaining(['VolumeSpike', 'BuyPressure']));
    expect(report.combinationPerformance.pairs.length).toBeGreaterThan(0);
    expect(report.primaryStrategyPerformance[0].name).toBe('CompositeSignal');
  });
});
