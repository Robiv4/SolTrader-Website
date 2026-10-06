/* eslint-disable @typescript-eslint/no-explicit-any -- provider/prisma stubs */
/**
 * AI mode vs Strategy mode against the development database (throw-away users only).
 * Covers the six required cases A-F plus cache reuse, confidence threshold, emergency stop and user isolation.
 */
import { randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import type { AIProvider, AiTokenAnalysis } from '@soltrader/ai-engine';
import { PrismaMarketDataRepository, type TokenMarketSnapshot } from '@soltrader/market-data';
import { afterAll, describe, expect, it } from 'vitest';

import { AiAnalysisService, type AiKeyValueStore, loadAiSettings } from '../src/ai-analysis-service.js';
import { PaperExecutionCoordinator } from '../src/paper-execution.js';
import { PositionManager } from '../src/position-manager.js';
import { createPrismaPositionStore } from '../src/position-store.js';
import { StrategyRunner } from '../src/strategy-runner.js';

const prisma = new PrismaClient();
const MINUTE = 60_000;
const logger = { info: () => undefined, warn: () => undefined, error: () => undefined };
const createdUsers: string[] = [];
const createdTokens: string[] = [];

class MemoryStore implements AiKeyValueStore {
  readonly values = new Map<string, string>();
  async get(key: string) { return this.values.get(key) ?? null; }
  async set(key: string, value: string) { this.values.set(key, value); return 'OK'; }
  async incrBy(key: string, amount: number) { const next = Number(this.values.get(key) ?? 0) + amount; this.values.set(key, String(next)); return next; }
  async expire() { return 1; }
}

function aiAnswer(overrides: Partial<AiTokenAnalysis> = {}): AiTokenAnalysis {
  return {
    decision: 'BUY', confidence: 86, entryQuality: 80, marketStrength: 82, momentumQuality: 84, liquidityQuality: 70, timingQuality: 78, exhaustionRisk: 20,
    recommendedPositionMultiplier: 0.5, suggestedStopLossPercent: 15, suggestedTakeProfitPercent: 30, suggestedTrailingActivationPercent: 12, suggestedTrailingDistancePercent: 6,
    recheckSeconds: 30, reasons: ['Növekvő vételi nyomás', 'Gyorsuló forgalom'], warnings: ['Fiatal token'], ...overrides,
  };
}

class FakeProvider implements AIProvider {
  calls = 0;
  constructor(public behaviour: () => Promise<unknown>) {}
  async analyzeToken() {
    this.calls += 1;
    return { output: await this.behaviour(), inputTokens: 900, outputTokens: 120 };
  }
  async healthCheck() { return true; }
  getProviderName() { return 'fake'; }
  getModelName() { return 'fake-model'; }
}

/** Accelerating breakout path (composite BUY in strategy mode). */
function priceAt(minutesAgo: number) {
  if (minutesAgo >= 15) return 1;
  if (minutesAgo >= 10) return 1 + (15 - minutesAgo) / 5 * 0.01;
  if (minutesAgo >= 5) return 1.01 + (10 - minutesAgo) / 5 * 0.03;
  return 1.04 + (5 - minutesAgo) / 5 * 0.06;
}

function snapshot(address: string, minutesAgo: number, now: number, priceFactor = 1): TokenMarketSnapshot {
  const latest = minutesAgo === 0;
  return {
    metadata: { address, symbol: 'AIT', name: 'AI test token', tokenAgeSeconds: 7_200 },
    timestamp: new Date(now - minutesAgo * MINUTE),
    priceUsd: priceAt(minutesAgo) * priceFactor,
    liquidityUsd: 200_000, volume24h: 2_000_000, priceChange1h: 12, priceChange24h: 20,
    priceChange5m: latest ? 5.8 : 1,
    volume5m: latest ? 30_000 : minutesAgo === 5 ? 15_000 : 10_000,
    volume1h: latest ? 140_000 : 120_000,
    buyCount5m: latest ? 180 : 60, sellCount5m: latest ? 75 : 60, buyCount1h: 700, sellCount1h: 700,
    provider: 'simulation', dataQuality: 'VALID', marketCap: 5_000_000, fdv: 6_000_000,
  };
}

interface World {
  userId: string;
  tokenId: string;
  address: string;
  provider: FakeProvider;
  store: MemoryStore;
  clock: { now: number };
  current: { snapshot: TokenMarketSnapshot };
  runner: StrategyRunner;
  coordinator: PaperExecutionCoordinator;
  ai: AiAnalysisService;
  events: Array<{ type: string; payload: Record<string, unknown> }>;
}

function scoped(userIds: string[]): PrismaClient {
  return new Proxy(prisma, {
    get(target, key) {
      if (key === 'botConfig') return { ...target.botConfig, findMany: (args: any) => target.botConfig.findMany({ ...args, where: { ...args?.where, userId: { in: userIds } } }), findUnique: (args: any) => target.botConfig.findUnique(args) };
      if (key === 'riskAssessment') return { ...target.riskAssessment, findMany: (args: any) => target.riskAssessment.findMany({ ...args, where: { ...args?.where, userId: { in: userIds } } }) };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as PrismaClient;
}

async function createUser(aiEnabled: boolean) {
  const user = await prisma.user.create({ data: { email: `ai-mode-${randomUUID().slice(0, 8)}@soltrader.test` } });
  createdUsers.push(user.id);
  await prisma.paperAccount.create({ data: { userId: user.id, initialBalance: 1_000, cashBalance: 1_000, equity: 1_000 } });
  await prisma.botConfig.create({ data: { userId: user.id, tradingMode: 'PAPER', status: 'RUNNING', isScannerEnabled: true } });
  await prisma.riskConfig.create({ data: {
    userId: user.id, maxPositionPercent: 5, maxTotalExposurePercent: 25, maxConcurrentPositions: 4, dailyLossLimitPercent: 8, maxSlippagePercent: 3,
    minSignalScore: 35, cooldownSeconds: 60, stopLossPercent: 20, takeProfitPercent: 25, trailingStopPercent: 8, trailingActivationPercent: 15,
    riskPolicy: 'EXPLORATORY', lowRiskMax: 30, moderateRiskMax: 50, highRiskMax: 90, veryHighRiskMax: 100,
  } });
  await prisma.advancedStrategyConfig.create({ data: { userId: user.id, compositeEnabled: true, minimumConfirmations: 3, minimumCompositeScore: 60, modules: { PullbackContinuation: { enabled: false } } } });
  await prisma.aiConfig.create({ data: { userId: user.id, aiAnalysisEnabled: aiEnabled } });
  return user.id;
}

async function createToken(userIds: string[], options: { hardBlocked?: boolean } = {}) {
  const address = `SIMAI${randomUUID().slice(0, 10)}`;
  const now = Date.now();
  const repository = new PrismaMarketDataRepository(prisma);
  for (let ago = 20; ago >= 1; ago -= 1) await repository.save(snapshot(address, ago, now));
  const tokenId = (await prisma.token.findUniqueOrThrow({ where: { address } })).id;
  createdTokens.push(tokenId);
  for (const userId of userIds) {
    await prisma.riskAssessment.create({ data: {
      tokenId, userId, riskScore: 60, decision: options.hardBlocked ? 'REJECT' : 'ACCEPT', classification: 'HIGH', hardBlocked: Boolean(options.hardBlocked),
      hardBlockReasons: options.hardBlocked ? ['SELLABILITY_FAILED'] : [], riskPolicy: 'EXPLORATORY', positionMultiplier: 0.35, factors: {}, rejectionReasons: [], warnings: [], source: 'simulation',
    } });
  }
  return { address, tokenId, now };
}

async function world(aiEnabled: boolean, behaviour: () => Promise<unknown> = async () => aiAnswer()): Promise<World> {
  const userId = await createUser(aiEnabled);
  const { address, tokenId, now } = await createToken([userId]);
  const provider = new FakeProvider(behaviour);
  const store = new MemoryStore();
  const clock = { now: Date.now() };
  const current = { snapshot: snapshot(address, 0, now) };
  const events: World['events'] = [];
  const db = scoped([userId]);
  const ai = new AiAnalysisService({ prisma: db, provider, providerInfo: { provider: 'fake', model: 'fake-model', configured: true }, store, logger, timeoutMs: 200, maxRetries: 1, serverMaxPerMinute: 30, concurrency: 2, now: () => new Date(clock.now) });
  const marketProvider = { getTokenMetrics: async () => ({ ...current.snapshot, timestamp: new Date() }) } as any;
  const runner = new StrategyRunner({ prisma: db, provider: marketProvider, logger, registry: {} as any, lookbackMs: 10 * MINUTE, historyWindow: 20, staleAfterMs: 2 * MINUTE, aiService: ai, publishEvent: async (type, payload) => { events.push({ type, payload }); } });
  const coordinator = new PaperExecutionCoordinator({ prisma: db, provider: marketProvider, logger, publishEvent: async (type, payload) => { events.push({ type, payload }); } });
  return { userId, tokenId, address, provider, store, clock, current, runner, coordinator, ai, events };
}

async function cycle(w: World) {
  await w.runner.runCycle({ aborted: false });
  await w.ai.drain();
  return w.coordinator.runCycle({ aborted: false });
}

afterAll(async () => {
  for (const userId of createdUsers) {
    const orders = await prisma.paperOrder.findMany({ where: { userId }, select: { id: true } });
    await prisma.paperFill.deleteMany({ where: { paperOrderId: { in: orders.map((order) => order.id) } } });
    await prisma.paperOrder.deleteMany({ where: { userId } });
    await prisma.trade.deleteMany({ where: { userId } });
    await prisma.position.deleteMany({ where: { userId } });
    await prisma.auditLog.deleteMany({ where: { userId } });
    await prisma.signal.deleteMany({ where: { userId } });
    await prisma.aiAnalysis.deleteMany({ where: { userId } });
    await prisma.riskAssessment.deleteMany({ where: { userId } });
  }
  await prisma.tokenMetric.deleteMany({ where: { tokenId: { in: createdTokens } } });
  await prisma.token.deleteMany({ where: { id: { in: createdTokens } } });
  for (const userId of createdUsers) {
    await prisma.aiConfig.deleteMany({ where: { userId } });
    await prisma.advancedStrategyConfig.deleteMany({ where: { userId } });
    await prisma.riskConfig.deleteMany({ where: { userId } });
    await prisma.botConfig.deleteMany({ where: { userId } });
    await prisma.paperAccount.deleteMany({ where: { userId } });
    await prisma.user.delete({ where: { id: userId } });
  }
  await prisma.$disconnect();
});

describe('decision modes (AI vs Strategy)', () => {
  it('CASE A: AI OFF -> no AI provider request; Strategy/Composite approves -> PAPER BUY', async () => {
    const w = await world(false);
    const summary = await cycle(w);
    expect(w.provider.calls).toBe(0);
    expect(await prisma.aiAnalysis.count({ where: { userId: w.userId } })).toBe(0);
    expect(summary.executed).toBe(1);
    const trade = await prisma.trade.findFirstOrThrow({ where: { userId: w.userId } });
    expect(trade.decisionSource).toBe('STRATEGY');
    expect(trade.strategyName).toBe('CompositeSignal');
  });

  it('CASE B: AI ON -> AI BUY 86 -> backend validation -> PAPER BUY through the normal pipeline (size only reduced)', async () => {
    const w = await world(true);
    const summary = await cycle(w);
    expect(w.provider.calls).toBe(1);
    const analysis = await prisma.aiAnalysis.findFirstOrThrow({ where: { userId: w.userId } });
    expect(analysis).toMatchObject({ status: 'COMPLETED', rawDecision: 'BUY', effectiveDecision: 'BUY', provider: 'fake', model: 'fake-model', promptVersion: 'token-entry-v1' });
    expect(summary.executed).toBe(1);
    const trade = await prisma.trade.findFirstOrThrow({ where: { userId: w.userId } });
    expect(trade.decisionSource).toBe('AI');
    expect(trade.aiAnalysisId).toBe(analysis.id);
    // Risk-adjusted 1000 x 5% x 0.35 = 17.5 is below normal 50 x AI 0.5 = 25 -> 17.5 (AI can only reduce).
    expect(Number(trade.size)).toBeCloseTo(17.5, 6);
    expect((trade.configSnapshot as any).ai).toMatchObject({ provider: 'fake', model: 'fake-model', confidence: 86, rawDecision: 'BUY', usedExitParameters: false });
    // Only the AI works: no strategy or composite signal of any direction was recorded.
    expect(await prisma.signal.count({ where: { userId: w.userId, strategyName: { not: 'AiTokenAnalyzer' } } })).toBe(0);
  });

  it('AI BUY below the minimum confidence is stored as raw BUY / effective WATCH and not bought', async () => {
    const w = await world(true, async () => aiAnswer({ confidence: 68 }));
    const summary = await cycle(w);
    const analysis = await prisma.aiAnalysis.findFirstOrThrow({ where: { userId: w.userId } });
    expect(analysis).toMatchObject({ rawDecision: 'BUY', effectiveDecision: 'WATCH', effectiveReason: 'AI_CONFIDENCE_BELOW_THRESHOLD' });
    expect(summary.executed).toBe(0);
  });

  it('CASE C: AI ON, strategy says BUY, AI says WATCH -> NO BUY', async () => {
    const w = await world(true, async () => aiAnswer({ decision: 'WATCH', confidence: 62 }));
    const summary = await cycle(w);
    expect(summary.executed).toBe(0);
    expect(await prisma.trade.count({ where: { userId: w.userId } })).toBe(0);
    const buys = await prisma.signal.count({ where: { userId: w.userId, direction: 'BUY' } });
    expect(buys).toBe(0);
  });

  it('CASE D: AI BUY 99 with a security hard block -> BLOCKED, no PAPER BUY', async () => {
    const w = await world(true, async () => aiAnswer({ confidence: 99 }));
    // A hard-blocked token is never sent to the AI.
    const blocked = await createToken([w.userId], { hardBlocked: true });
    expect(await w.ai.process({
      userId: w.userId, tokenId: blocked.tokenId, tokenAddress: blocked.address, symbol: 'AIT', name: null, tokenAgeSeconds: null, settings: await loadAiSettings(prisma, w.userId),
      risk: { id: 'r', riskScore: 60, classification: 'HIGH', riskPolicy: 'EXPLORATORY', positionMultiplier: 0.35, hardBlocked: true, hardBlockReasons: ['SELLABILITY_FAILED'], warnings: [], factors: {} },
      features: {} as any, observations: [], analysis: null, market: { volume24h: null, priceChange24h: null, marketCap: null, fdv: null }, referenceOrderUsd: null,
    })).toBe('HARD_BLOCKED');
    expect(w.provider.calls).toBe(0);
    // Even an AI BUY signal carrying a hard block cannot pass the execution gate.
    const analysis = await prisma.aiAnalysis.create({ data: { userId: w.userId, tokenId: blocked.tokenId, tokenAddress: blocked.address, provider: 'fake', model: 'fake-model', promptVersion: 'token-entry-v1', status: 'COMPLETED', rawDecision: 'BUY', effectiveDecision: 'BUY', confidence: 99, recommendedPositionMultiplier: 1, inputHash: 'x', marketStateHash: 'x', expiresAt: new Date(Date.now() + 10 * MINUTE) } });
    await prisma.signal.create({ data: { tokenId: blocked.tokenId, userId: w.userId, strategyName: 'AiTokenAnalyzer', direction: 'BUY', score: 99, riskScore: 60, signalType: 'AI', mode: 'SCANNER', metadata: { decisionSource: 'AI', aiAnalysisId: analysis.id, riskClassification: 'HIGH', hardBlocked: true, hardBlockReasons: ['SELLABILITY_FAILED'] } } });
    const summary = await w.coordinator.runCycle({ aborted: false });
    expect(summary.executed).toBe(0);
    expect(await prisma.trade.count({ where: { userId: w.userId, tokenId: blocked.tokenId } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { userId: w.userId, action: 'HARD_BLOCK_TRIGGERED' } })).toBeGreaterThan(0);
  });

  it('CASE E: AI ON, provider unavailable -> no automatic BUY, no silent strategy fallback, open positions still managed', async () => {
    const w = await world(true, () => new Promise(() => undefined));
    // An already open position (opened earlier) must keep being protected by the deterministic exit engine.
    const position = await prisma.position.create({ data: { userId: w.userId, tokenId: w.tokenId, side: 'BUY', quantity: 10, avgEntryPrice: 1, currentPrice: 1, stopLossPrice: 0.8, takeProfitPrice: 1.25, highestPrice: 1, lowestPrice: 1, mode: 'PAPER' } });
    await prisma.trade.create({ data: { userId: w.userId, tokenId: w.tokenId, positionId: position.id, side: 'BUY', tokenAddress: w.address, symbol: 'AIT', entry: 1, quantity: 10, size: 10, fees: 0.03, mode: 'PAPER', status: 'OPEN', decisionSource: 'STRATEGY' } });
    const summary = await cycle(w);
    expect(w.provider.calls).toBe(2); // first try + one retry, both timed out
    const failed = await prisma.aiAnalysis.findFirstOrThrow({ where: { userId: w.userId } });
    expect(failed).toMatchObject({ status: 'FAILED', effectiveDecision: 'NONE', effectiveReason: 'AI_PROVIDER_UNAVAILABLE' });
    expect(summary.executed).toBe(0);
    expect(await prisma.signal.count({ where: { userId: w.userId, direction: 'BUY' } })).toBe(0);
    const manager = new PositionManager(createPrismaPositionStore(prisma, { userId: w.userId, publishEvent: async () => undefined }));
    const closed = await manager.reconcileMarket({ [w.address]: { price: 0.75, liquidityUsd: 200_000 } });
    expect(closed[0]?.exitReason).toBe('STOP_LOSS');
  });

  it('CASE F: switching AI OFF stops AI calls, strategy entries resume, stale AI signals are refused, positions untouched', async () => {
    const w = await world(true);
    await cycle(w);
    const openBefore = await prisma.position.findMany({ where: { userId: w.userId, status: 'OPEN' }, orderBy: { id: 'asc' } });
    expect(openBefore).toHaveLength(1);
    // A second AI BUY signal is waiting when the user switches back to strategy mode.
    const other = await createToken([w.userId]);
    const analysis = await prisma.aiAnalysis.create({ data: { userId: w.userId, tokenId: other.tokenId, tokenAddress: other.address, provider: 'fake', model: 'fake-model', promptVersion: 'token-entry-v1', status: 'COMPLETED', rawDecision: 'BUY', effectiveDecision: 'BUY', confidence: 90, recommendedPositionMultiplier: 1, inputHash: 'x', marketStateHash: 'x', expiresAt: new Date(Date.now() + 10 * MINUTE) } });
    await prisma.signal.create({ data: { tokenId: other.tokenId, userId: w.userId, strategyName: 'AiTokenAnalyzer', direction: 'BUY', score: 90, riskScore: 60, signalType: 'AI', mode: 'SCANNER', metadata: { decisionSource: 'AI', aiAnalysisId: analysis.id, riskClassification: 'HIGH', hardBlocked: false } } });
    await prisma.aiConfig.update({ where: { userId: w.userId }, data: { aiAnalysisEnabled: false } });
    const callsBefore = w.provider.calls;
    w.clock.now += 5 * MINUTE;
    await w.coordinator.runCycle({ aborted: false });
    expect(await prisma.trade.count({ where: { userId: w.userId, tokenId: other.tokenId } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { userId: w.userId, action: 'TRADE_REJECTED', details: { path: ['decisionReasons'], array_contains: ['DECISION_MODE_STRATEGY_ACTIVE'] } } })).toBe(1);
    // Strategy mode: the composite may create BUY signals again, and no AI calls happen.
    await w.runner.runCycle({ aborted: false });
    await w.ai.drain();
    expect(w.provider.calls).toBe(callsBefore);
    expect(await prisma.signal.count({ where: { userId: w.userId, strategyName: 'CompositeSignal', direction: 'BUY', tokenId: other.tokenId } })).toBe(1);
    const openAfter = await prisma.position.findMany({ where: { userId: w.userId, status: 'OPEN', id: { in: openBefore.map((row) => row.id) } }, orderBy: { id: 'asc' } });
    expect(openAfter.map((row) => [row.id, row.quantity.toString(), row.stopLossPrice?.toString(), row.trailingStopPercent?.toString()])).toEqual(openBefore.map((row) => [row.id, row.quantity.toString(), row.stopLossPrice?.toString(), row.trailingStopPercent?.toString()]));
  });

  it('switching AI ON refuses a strategy BUY created just before (no duplicate entries)', async () => {
    const w = await world(false);
    await w.runner.runCycle({ aborted: false });
    expect(await prisma.signal.count({ where: { userId: w.userId, direction: 'BUY' } })).toBe(1);
    await prisma.aiConfig.update({ where: { userId: w.userId }, data: { aiAnalysisEnabled: true } });
    const summary = await w.coordinator.runCycle({ aborted: false });
    expect(summary.executed).toBe(0);
    expect(await prisma.auditLog.count({ where: { userId: w.userId, action: 'TRADE_REJECTED', details: { path: ['decisionReasons'], array_contains: ['DECISION_MODE_AI_ACTIVE'] } } })).toBe(1);
  });

  it('reuses a fresh analysis for an unchanged market; re-analyses after a meaningful change', async () => {
    const w = await world(true, async () => aiAnswer({ decision: 'WATCH', confidence: 60 }));
    await cycle(w);
    expect(w.provider.calls).toBe(1);
    w.clock.now += 20_000;
    await cycle(w);
    expect(w.provider.calls).toBe(1);
    expect(Number(w.store.values.get(`ai:usage:${w.userId}:${new Date(w.clock.now).toISOString().slice(0, 10)}:cached`) ?? 0)).toBeGreaterThanOrEqual(1);
    // +6% price move -> significant change -> new analysis before the recheck timer.
    w.current.snapshot = { ...w.current.snapshot, priceUsd: (w.current.snapshot.priceUsd ?? 1) * 1.06 };
    w.clock.now += 5_000;
    await cycle(w);
    expect(w.provider.calls).toBe(2);
  });

  it('emergency stop blocks execution of an AI BUY that was produced meanwhile', async () => {
    const w = await world(true);
    await w.runner.runCycle({ aborted: false });
    await w.ai.drain();
    expect(await prisma.signal.count({ where: { userId: w.userId, strategyName: 'AiTokenAnalyzer', direction: 'BUY' } })).toBe(1);
    await prisma.botConfig.update({ where: { userId: w.userId }, data: { isEmergencyStop: true } });
    const summary = await w.coordinator.runCycle({ aborted: false });
    expect(summary.executed).toBe(0);
    expect(await prisma.trade.count({ where: { userId: w.userId } })).toBe(0);
  });

  it('keeps users isolated: only the AI-mode user triggers provider calls and AI decisions', async () => {
    const userA = await createUser(true);
    const userB = await createUser(false);
    const token = await createToken([userA, userB]);
    const provider = new FakeProvider(async () => aiAnswer());
    const db = scoped([userA, userB]);
    const ai = new AiAnalysisService({ prisma: db, provider, providerInfo: { provider: 'fake', model: 'fake-model', configured: true }, store: new MemoryStore(), logger, timeoutMs: 200, maxRetries: 0, serverMaxPerMinute: 30, concurrency: 2 });
    const snap = snapshot(token.address, 0, token.now);
    const runner = new StrategyRunner({ prisma: db, provider: { getTokenMetrics: async () => ({ ...snap, timestamp: new Date() }) } as any, logger, registry: {} as any, lookbackMs: 10 * MINUTE, historyWindow: 20, staleAfterMs: 2 * MINUTE, aiService: ai });
    await runner.runCycle({ aborted: false });
    await ai.drain();
    expect(provider.calls).toBe(1);
    expect(await prisma.aiAnalysis.count({ where: { userId: userA } })).toBe(1);
    expect(await prisma.aiAnalysis.count({ where: { userId: userB } })).toBe(0);
    expect(await prisma.signal.count({ where: { userId: userB, strategyName: 'CompositeSignal', direction: 'BUY' } })).toBe(1);
    expect(await prisma.signal.count({ where: { userId: userA, strategyName: 'CompositeSignal', direction: 'BUY' } })).toBe(0);
  });
});
