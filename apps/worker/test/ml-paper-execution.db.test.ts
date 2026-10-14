/* eslint-disable @typescript-eslint/no-explicit-any -- prisma scoping proxy */
/**
 * ML PAPER entries through the real PAPER Execution Engine against the development database (throw-away users / model only):
 * origin recorded on trade + position, strategy / model re-checked at execution, emergency stop, PAPER only, and exits of
 * ML positions keep working when the model breaks (tests 2, 5, 7, 8, 9, 11).
 */
import { randomUUID } from 'node:crypto';

import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, describe, expect, it } from 'vitest';

import { PaperExecutionCoordinator } from '../src/paper-execution.js';
import { PositionManager } from '../src/position-manager.js';
import { createPrismaPositionStore } from '../src/position-store.js';

const prisma = new PrismaClient();
const logger = { info: () => undefined, warn: () => undefined, error: () => undefined };
const runId = randomUUID().slice(0, 8);
const MODEL = `TEST-ML-PAPER-${runId}`;
const createdUsers: string[] = [];
const createdTokens: string[] = [];

function scoped(userIds: string[]): PrismaClient {
  return new Proxy(prisma, {
    get(target, key) {
      if (key === 'botConfig') return { ...target.botConfig, findMany: (args: any) => target.botConfig.findMany({ ...args, where: { ...args?.where, userId: { in: userIds } } }), findUnique: (args: any) => target.botConfig.findUnique(args) };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as PrismaClient;
}

async function createUser(strategy: 'DEFAULT' | 'ML', options: { tradingMode?: 'PAPER' | 'SEMI_AUTO' | 'LIVE'; emergency?: boolean; minLaunchScore?: number } = {}) {
  const user = await prisma.user.create({ data: { email: `ml-paper-${randomUUID().slice(0, 8)}@soltrader.test` } });
  createdUsers.push(user.id);
  await prisma.paperAccount.create({ data: { userId: user.id, initialBalance: 1_000, cashBalance: 1_000, equity: 1_000 } });
  await prisma.botConfig.create({ data: { userId: user.id, tradingMode: options.tradingMode ?? 'PAPER', status: 'RUNNING', isEmergencyStop: options.emergency ?? false } });
  await prisma.riskConfig.create({ data: {
    userId: user.id, maxPositionPercent: 5, maxTotalExposurePercent: 25, maxConcurrentPositions: 4, dailyLossLimitPercent: 8, maxSlippagePercent: 3,
    minSignalScore: 0, cooldownSeconds: 0, riskPolicy: 'EXPLORATORY', lowRiskMax: 30, moderateRiskMax: 50, highRiskMax: 90, veryHighRiskMax: 100,
  } });
  await prisma.newLaunchConfig.create({ data: { userId: user.id, enabled: true, minScore: options.minLaunchScore ?? 0 } });
  await prisma.mlPaperSettings.create({ data: { userId: user.id, strategyMode: strategy, modelVersion: strategy === 'ML' ? MODEL : null } });
  return user.id;
}

async function decisionRow(userId: string, mint: string) {
  return prisma.mlPaperDecision.create({ data: {
    userId, mint, modelVersion: MODEL, featureVersion: 'ML-FEATURES-v1', snapshotKind: 'AGE_30S', snapshotAt: new Date(), detectedAt: new Date(Date.now() - 31_000), features: {}, featureHash: 'x',
    dataQuality: 80, probability: new Prisma.Decimal(0.91), threshold: new Prisma.Decimal(0.7), mlDecision: 'ML_BUY', outcome: 'SIGNALED', decidedAt: new Date(),
  } });
}

async function launchSignal(userId: string, mint: string, entryStrategy: 'DEFAULT' | 'ML', decisionId?: string, options: { qualityGate?: Record<string, unknown> | null; probability?: number } = {}) {
  const token = await prisma.token.upsert({ where: { address: mint }, update: {}, create: { address: mint, symbol: 'MLP', name: 'ML paper test' } });
  if (!createdTokens.includes(token.id)) createdTokens.push(token.id);
  const now = Date.now();
  return prisma.signal.create({ data: {
    tokenId: token.id, userId, strategyName: 'NewLaunchStrategy', direction: 'BUY', score: new Prisma.Decimal(40), riskScore: new Prisma.Decimal(45), signalType: 'NEW_LAUNCH', mode: 'SCANNER',
    reasons: ['ML_BUY'], entryConditions: [], invalidationConditions: [],
    metadata: {
      decisionSource: 'NEW_LAUNCH', primaryStrategy: 'NewLaunchStrategy', riskClassification: 'MODERATE', hardBlocked: false, hardBlockReasons: [], riskPolicy: 'EXPLORATORY', riskWarnings: [], riskFactors: {},
      entryStrategy, ml: entryStrategy === 'ML' ? { decisionId, modelVersion: MODEL, probability: options.probability ?? 0.91, threshold: 0.7, snapshotKind: 'AGE_30S' } : null,
      launch: { source: 'PUMP_FUN', mint, detectedAt: new Date(now - 31_000).toISOString(), decisionAt: new Date(now - 500).toISOString(), ageSeconds: 31, score: 40, liquidityUsd: 30_000, reasons: [], warnings: [], qualityGate: options.qualityGate ?? null },
    },
  } });
}

function coordinator(userIds: string[], quotes: Map<string, number>) {
  return new PaperExecutionCoordinator({
    prisma: scoped(userIds), provider: { getTokenMetrics: async () => null } as any, logger, publishEvent: async () => undefined,
    getLaunchQuote: (mint: string) => (quotes.has(mint) ? { priceUsd: quotes.get(mint)!, liquidityUsd: 30_000, timestamp: new Date(), impactPercentFor: () => 0.8 } : null),
    publishLaunchEvent: async () => undefined,
  } as any);
}

const mint = () => `MLP${randomUUID().replace(/-/g, '').slice(0, 30)}`;

afterAll(async () => {
  for (const userId of createdUsers) {
    const orders = await prisma.paperOrder.findMany({ where: { userId }, select: { id: true } });
    await prisma.paperFill.deleteMany({ where: { paperOrderId: { in: orders.map((order) => order.id) } } });
    await prisma.paperOrder.deleteMany({ where: { userId } });
    await prisma.positionEvent.deleteMany({ where: { userId } });
    await prisma.positionPathMetric.deleteMany({ where: { userId } });
    await prisma.trade.deleteMany({ where: { userId } });
    await prisma.position.deleteMany({ where: { userId } });
    await prisma.auditLog.deleteMany({ where: { userId } });
    await prisma.signal.deleteMany({ where: { userId } });
    await prisma.mlPaperDecision.deleteMany({ where: { userId } });
    await prisma.mlPaperSettings.deleteMany({ where: { userId } });
    await prisma.newLaunchConfig.deleteMany({ where: { userId } });
    await prisma.riskConfig.deleteMany({ where: { userId } });
    await prisma.botConfig.deleteMany({ where: { userId } });
    await prisma.paperAccount.deleteMany({ where: { userId } });
  }
  await prisma.mlModelVersion.deleteMany({ where: { version: MODEL } });
  await prisma.token.deleteMany({ where: { id: { in: createdTokens } } });
  for (const userId of createdUsers) await prisma.user.delete({ where: { id: userId } });
  await prisma.$disconnect();
});

describe('ML PAPER entries in the PAPER Execution Engine', () => {
  it('setup: a PAPER-approved test model', async () => {
    await prisma.mlModelVersion.create({ data: {
      version: MODEL, algorithm: 'logistic_regression', status: 'SHADOW', readiness: 'SHADOW_READY', featureVersion: 'ML-FEATURES-v1', labelVersion: 'ML-LABELS-v1', target: 'plus20BeforeMinus10_30m',
      datasetVersion: 'TEST', config: {}, metrics: {}, artifactPath: 'ml/models/test/model.json', artifactHash: 'x', statusHistory: [], trainedAt: new Date(), paperApproved: true, paperApprovedAt: new Date(), paperApprovedBy: 'test',
    } });
  });

  it('ML signal -> one PAPER position with an immutable ML origin; the decision row records the execution', async () => {
    const userId = await createUser('ML');
    const address = mint();
    const decision = await decisionRow(userId, address);
    const signal = await launchSignal(userId, address, 'ML', decision.id);
    const summary = await coordinator([userId], new Map([[address, 0.000005]])).runCycle({ aborted: false });
    expect(summary.executed).toBe(1);
    const trade = await prisma.trade.findFirstOrThrow({ where: { userId } });
    expect(trade).toMatchObject({ decisionSource: 'NEW_LAUNCH', entryStrategy: 'ML', mlModelVersion: MODEL, mlPaperDecisionId: decision.id, signalId: signal.id, mode: 'PAPER' });
    const position = await prisma.position.findUniqueOrThrow({ where: { id: trade.positionId! } });
    expect(position).toMatchObject({ entryStrategy: 'ML', exitPolicy: 'NEW_LAUNCH', mode: 'PAPER' });
    expect(position.stopLossPrice).not.toBeNull();
    expect((trade.configSnapshot as any).ml).toMatchObject({ modelVersion: MODEL, decisionId: decision.id });
    expect(await prisma.mlPaperDecision.findUniqueOrThrow({ where: { id: decision.id } })).toMatchObject({ outcome: 'EXECUTED', positionId: position.id, tradeId: trade.id });

    // 5. Duplicate prevention: another (ML or DEFAULT) signal for the same token never opens a second position.
    await launchSignal(userId, address, 'ML', decision.id);
    await coordinator([userId], new Map([[address, 0.000005]])).runCycle({ aborted: false });
    expect(await prisma.position.count({ where: { userId } })).toBe(1);

    // 9. A later model / strategy change never rewrites the origin of an existing trade.
    await prisma.mlPaperSettings.update({ where: { userId }, data: { strategyMode: 'DEFAULT' } });
    expect(await prisma.trade.findUniqueOrThrow({ where: { id: trade.id } })).toMatchObject({ entryStrategy: 'ML', mlModelVersion: MODEL });

    // 8. Model broken / revoked: the open ML position is still protected by the common exit engine (stop loss).
    await prisma.mlModelVersion.update({ where: { version: MODEL }, data: { paperApproved: false } });
    const manager = new PositionManager(createPrismaPositionStore(prisma, { userId, publishEvent: async () => undefined }));
    const closed = await manager.reconcileMarket({ [address]: { price: 0.000005 * 0.6, liquidityUsd: 30_000, timestamp: new Date() } });
    expect(closed.map((item) => item.exitReason)).toEqual(['STOP_LOSS']);
    expect(await prisma.trade.findUniqueOrThrow({ where: { id: trade.id } })).toMatchObject({ status: 'CLOSED', entryStrategy: 'ML' });
    await prisma.mlModelVersion.update({ where: { version: MODEL }, data: { paperApproved: true } });
  });

  it('exactly one strategy buys: a DEFAULT signal in ML mode and an ML signal in DEFAULT mode are both rejected', async () => {
    const mlUser = await createUser('ML');
    const defaultUser = await createUser('DEFAULT');
    const a = mint();
    const b = mint();
    await launchSignal(mlUser, a, 'DEFAULT');
    const decision = await decisionRow(defaultUser, b);
    await launchSignal(defaultUser, b, 'ML', decision.id);
    const summary = await coordinator([mlUser, defaultUser], new Map([[a, 0.000005], [b, 0.000005]])).runCycle({ aborted: false });
    expect(summary.executed).toBe(0);
    expect(await prisma.position.count({ where: { userId: { in: [mlUser, defaultUser] } } })).toBe(0);
    const reasons = await prisma.auditLog.findMany({ where: { userId: { in: [mlUser, defaultUser] }, action: 'TRADE_REJECTED' } });
    expect(reasons.map((row) => (row.details as any).decisionReasons[0]).sort()).toEqual(['ENTRY_STRATEGY_NOT_ACTIVE', 'ENTRY_STRATEGY_NOT_ACTIVE']);
    expect(await prisma.mlPaperDecision.findUniqueOrThrow({ where: { id: decision.id } })).toMatchObject({ outcome: 'EXECUTION_REJECTED' });
  });

  it('1 / 5 / 8. ML-only: a failed DEFAULT quality gate and a Launch Score below the DEFAULT minimum do not veto an ML entry; DEFAULT is unchanged', async () => {
    const failedGate = { mode: 'ENFORCE_PAPER', evaluated: true, wouldPass: false, reasons: ['LAUNCH_SCORE_BELOW_GATE'], blocksEntry: true };
    const mlUser = await createUser('ML', { minLaunchScore: 90 });
    const defaultUser = await createUser('DEFAULT', { minLaunchScore: 0 });
    const lowScoreUser = await createUser('DEFAULT', { minLaunchScore: 90 });
    const [a, b, c] = [mint(), mint(), mint()];
    const decision = await decisionRow(mlUser, a);
    await launchSignal(mlUser, a, 'ML', decision.id, { qualityGate: { ...failedGate, appliesToEntry: false } });
    await launchSignal(defaultUser, b, 'DEFAULT', undefined, { qualityGate: failedGate });
    await launchSignal(lowScoreUser, c, 'DEFAULT');
    const summary = await coordinator([mlUser, defaultUser, lowScoreUser], new Map([[a, 0.000005], [b, 0.000005], [c, 0.000005]])).runCycle({ aborted: false });
    expect(summary.executed).toBe(1);
    expect(await prisma.trade.findFirstOrThrow({ where: { userId: mlUser } })).toMatchObject({ entryStrategy: 'ML', mode: 'PAPER' });
    const rejected = await prisma.auditLog.findMany({ where: { userId: { in: [defaultUser, lowScoreUser] }, action: 'TRADE_REJECTED' } });
    expect(rejected.map((row) => (row.details as any).decisionReasons[0]).sort()).toEqual(['QUALITY_GATE_FAILED', 'SIGNAL_SCORE_BELOW_MINIMUM']);
  });

  it('an ML signal below its own approved threshold is rejected at execution (ML conviction, defence in depth)', async () => {
    const userId = await createUser('ML');
    const address = mint();
    const decision = await decisionRow(userId, address);
    await launchSignal(userId, address, 'ML', decision.id, { probability: 0.5 });
    const summary = await coordinator([userId], new Map([[address, 0.000005]])).runCycle({ aborted: false });
    expect(summary.executed).toBe(0);
    const rejected = await prisma.auditLog.findFirstOrThrow({ where: { userId, action: 'TRADE_REJECTED' } });
    expect((rejected.details as any).decisionReasons).toContain('SIGNAL_SCORE_BELOW_MINIMUM');
  });

  it('2 / 9. a revoked or no longer selected model cannot buy', async () => {
    const userId = await createUser('ML');
    const address = mint();
    const decision = await decisionRow(userId, address);
    await launchSignal(userId, address, 'ML', decision.id);
    await prisma.mlPaperSettings.update({ where: { userId }, data: { modelVersion: 'SOME-OTHER-MODEL' } });
    await coordinator([userId], new Map([[address, 0.000005]])).runCycle({ aborted: false });
    expect(await prisma.mlPaperDecision.findUniqueOrThrow({ where: { id: decision.id } })).toMatchObject({ outcome: 'EXECUTION_REJECTED', executionReason: expect.stringContaining('ML_MODEL_NOT_SELECTED') });

    const second = await createUser('ML');
    const other = mint();
    const secondDecision = await decisionRow(second, other);
    await launchSignal(second, other, 'ML', secondDecision.id);
    await prisma.mlModelVersion.update({ where: { version: MODEL }, data: { paperApproved: false } });
    try {
      await coordinator([second], new Map([[other, 0.000005]])).runCycle({ aborted: false });
    } finally {
      await prisma.mlModelVersion.update({ where: { version: MODEL }, data: { paperApproved: true } });
    }
    expect(await prisma.position.count({ where: { userId: { in: [userId, second] } } })).toBe(0);
    expect(await prisma.mlPaperDecision.findUniqueOrThrow({ where: { id: secondDecision.id } })).toMatchObject({ executionReason: expect.stringContaining('ML_MODEL_NOT_PAPER_APPROVED') });
  });

  it('7. emergency stop: no ML entry', async () => {
    const userId = await createUser('ML', { emergency: true });
    const address = mint();
    const decision = await decisionRow(userId, address);
    await launchSignal(userId, address, 'ML', decision.id);
    const summary = await coordinator([userId], new Map([[address, 0.000005]])).runCycle({ aborted: false });
    expect(summary.executed).toBe(0);
    expect(await prisma.position.count({ where: { userId } })).toBe(0);
  });

  it('11. never outside PAPER: SEMI_AUTO / LIVE accounts get no ML entry, every ML trade is mode PAPER', async () => {
    const semi = await createUser('ML', { tradingMode: 'SEMI_AUTO' });
    const live = await createUser('ML', { tradingMode: 'LIVE' });
    const a = mint();
    const b = mint();
    await launchSignal(semi, a, 'ML', (await decisionRow(semi, a)).id);
    await launchSignal(live, b, 'ML', (await decisionRow(live, b)).id);
    const summary = await coordinator([semi, live], new Map([[a, 0.000005], [b, 0.000005]])).runCycle({ aborted: false });
    expect(summary.executed).toBe(0);
    expect(await prisma.position.count({ where: { userId: { in: [semi, live] } } })).toBe(0);
    expect(await prisma.trade.count({ where: { entryStrategy: 'ML', mode: { not: 'PAPER' } } })).toBe(0);
  });
});
