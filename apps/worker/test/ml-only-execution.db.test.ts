/* eslint-disable @typescript-eslint/no-explicit-any -- prisma scoping proxy */
/**
 * ML-only contract at execution (PAPER Execution Engine with mlOnly = true) against the LOCAL development database
 * (throw-away users / models, removed afterwards; never run against production):
 *  - a DEFAULT signal is rejected even for a user whose stored strategy is DEFAULT;
 *  - two models cannot enter for one user: only the selected model's signal executes;
 *  - no model / paused / LIVE bot -> no entry;
 *  - open positions stay protected by the Exit Engine after the model is deselected.
 */
import { randomUUID } from 'node:crypto';

import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PaperExecutionCoordinator } from '../src/paper-execution.js';
import { PositionManager } from '../src/position-manager.js';
import { createPrismaPositionStore } from '../src/position-store.js';

const prisma = new PrismaClient();
const logger = { info: () => undefined, warn: () => undefined, error: () => undefined };
const runId = randomUUID().slice(0, 8);
const MODEL_A = `TEST-MLONLY-A-${runId}`;
const MODEL_B = `TEST-MLONLY-B-${runId}`;
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

async function createUser(settings: { strategyMode: 'DEFAULT' | 'ML'; modelVersion: string | null; tradingPaused?: boolean } | null, options: { tradingMode?: 'PAPER' | 'LIVE' } = {}) {
  const user = await prisma.user.create({ data: { email: `ml-only-${randomUUID().slice(0, 8)}@soltrader.test` } });
  createdUsers.push(user.id);
  await prisma.paperAccount.create({ data: { userId: user.id, initialBalance: 1_000, cashBalance: 1_000, equity: 1_000 } });
  await prisma.botConfig.create({ data: { userId: user.id, tradingMode: options.tradingMode ?? 'PAPER', status: 'RUNNING' } });
  await prisma.riskConfig.create({ data: {
    userId: user.id, maxPositionPercent: 5, maxTotalExposurePercent: 25, maxConcurrentPositions: 4, dailyLossLimitPercent: 8, maxSlippagePercent: 3,
    minSignalScore: 0, cooldownSeconds: 0, riskPolicy: 'EXPLORATORY', lowRiskMax: 30, moderateRiskMax: 50, highRiskMax: 90, veryHighRiskMax: 100,
  } });
  await prisma.newLaunchConfig.create({ data: { userId: user.id, enabled: true, minScore: 0 } });
  if (settings) await prisma.mlPaperSettings.create({ data: { userId: user.id, ...settings } });
  return user.id;
}

async function decisionRow(userId: string, mint: string, modelVersion: string) {
  return prisma.mlPaperDecision.create({ data: {
    userId, mint, modelVersion, featureVersion: 'ML-FEATURES-v1', snapshotKind: 'AGE_30S', snapshotAt: new Date(), detectedAt: new Date(Date.now() - 31_000), features: {}, featureHash: 'x',
    dataQuality: 80, probability: new Prisma.Decimal(0.91), threshold: new Prisma.Decimal(0.7), mlDecision: 'ML_BUY', outcome: 'SIGNALED', decidedAt: new Date(),
  } });
}

async function launchSignal(userId: string, mint: string, entryStrategy: 'DEFAULT' | 'ML', ml: { decisionId: string; modelVersion: string } | null = null) {
  const token = await prisma.token.upsert({ where: { address: mint }, update: {}, create: { address: mint, symbol: 'MLO', name: 'ML-only test' } });
  if (!createdTokens.includes(token.id)) createdTokens.push(token.id);
  const now = Date.now();
  return prisma.signal.create({ data: {
    tokenId: token.id, userId, strategyName: 'NewLaunchStrategy', direction: 'BUY', score: new Prisma.Decimal(40), riskScore: new Prisma.Decimal(45), signalType: 'NEW_LAUNCH', mode: 'SCANNER',
    reasons: ['TEST'], entryConditions: [], invalidationConditions: [],
    metadata: {
      decisionSource: 'NEW_LAUNCH', primaryStrategy: 'NewLaunchStrategy', riskClassification: 'MODERATE', hardBlocked: false, hardBlockReasons: [], riskPolicy: 'EXPLORATORY', riskWarnings: [], riskFactors: {},
      entryStrategy, ml: ml ? { ...ml, probability: 0.91, threshold: 0.7, snapshotKind: 'AGE_30S' } : null,
      launch: { source: 'PUMP_FUN', mint, detectedAt: new Date(now - 31_000).toISOString(), decisionAt: new Date(now - 500).toISOString(), ageSeconds: 31, score: 40, liquidityUsd: 30_000, reasons: [], warnings: [], qualityGate: null },
    },
  } });
}

function coordinator(userIds: string[], quotes: Map<string, number>) {
  return new PaperExecutionCoordinator({
    mlOnly: true, prisma: scoped(userIds), provider: { getTokenMetrics: async () => null } as any, logger, publishEvent: async () => undefined,
    getLaunchQuote: (mint: string) => (quotes.has(mint) ? { priceUsd: quotes.get(mint)!, liquidityUsd: 30_000, timestamp: new Date(), impactPercentFor: () => 0.8 } : null),
    publishLaunchEvent: async () => undefined,
  } as any);
}

const mint = () => `MLO${randomUUID().replace(/-/g, '').slice(0, 30)}`;
const rejectionsOf = async (userId: string) => (await prisma.auditLog.findMany({ where: { userId, action: 'TRADE_REJECTED' } })).map((row) => (row.details as any).decisionReasons[0]);

beforeAll(async () => {
  for (const version of [MODEL_A, MODEL_B]) {
    await prisma.mlModelVersion.create({ data: {
      version, algorithm: 'logistic_regression', status: 'SHADOW', readiness: 'SHADOW_READY', featureVersion: 'ML-FEATURES-v1', labelVersion: 'ML-LABELS-v1', target: 'plus20BeforeMinus10_30m',
      datasetVersion: 'TEST', config: {}, metrics: {}, artifactPath: 'ml/models/test/model.json', artifactHash: 'x', statusHistory: [], trainedAt: new Date(), paperApproved: true, paperApprovedAt: new Date(), paperApprovedBy: 'test',
    } });
  }
});

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
  await prisma.mlModelVersion.deleteMany({ where: { version: { in: [MODEL_A, MODEL_B] } } });
  await prisma.token.deleteMany({ where: { id: { in: createdTokens } } });
  for (const userId of createdUsers) await prisma.user.delete({ where: { id: userId } });
  await prisma.$disconnect();
});

describe('ML-only contract at execution', () => {
  it('DEFAULT signals are rejected, also for a user whose stored strategy is DEFAULT or who has no selection', async () => {
    const legacyDefault = await createUser({ strategyMode: 'DEFAULT', modelVersion: null });
    const noSelection = await createUser(null);
    const [a, b] = [mint(), mint()];
    await launchSignal(legacyDefault, a, 'DEFAULT');
    await launchSignal(noSelection, b, 'DEFAULT');
    const summary = await coordinator([legacyDefault, noSelection], new Map([[a, 0.000005], [b, 0.000005]])).runCycle({ aborted: false });
    expect(summary.executed).toBe(0);
    expect(await rejectionsOf(legacyDefault)).toEqual(['NO_TRADING_MODEL_SELECTED']);
    expect(await rejectionsOf(noSelection)).toEqual(['NO_TRADING_MODEL_SELECTED']);
  });

  it('two approved models, one user: only the selected model enters; the other model is rejected', async () => {
    const userId = await createUser({ strategyMode: 'ML', modelVersion: MODEL_A });
    const [a, b, c] = [mint(), mint(), mint()];
    const fromA = await decisionRow(userId, a, MODEL_A);
    const fromB = await decisionRow(userId, b, MODEL_B);
    await launchSignal(userId, a, 'ML', { decisionId: fromA.id, modelVersion: MODEL_A });
    await launchSignal(userId, b, 'ML', { decisionId: fromB.id, modelVersion: MODEL_B });
    await launchSignal(userId, c, 'DEFAULT');
    const summary = await coordinator([userId], new Map([[a, 0.000005], [b, 0.000005], [c, 0.000005]])).runCycle({ aborted: false });
    expect(summary.executed).toBe(1);
    const trades = await prisma.trade.findMany({ where: { userId } });
    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject({ entryStrategy: 'ML', mlModelVersion: MODEL_A, mode: 'PAPER' });
    expect((await rejectionsOf(userId)).sort()).toEqual(['DEFAULT_STRATEGY_DISABLED', 'ML_MODEL_NOT_SELECTED']);

    // Model deselected (DATA_COLLECTION): the open position keeps its model and is still protected by the Exit Engine.
    await prisma.mlPaperSettings.update({ where: { userId }, data: { modelVersion: null } });
    const manager = new PositionManager(createPrismaPositionStore(prisma, { userId, publishEvent: async () => undefined }));
    const closed = await manager.reconcileMarket({ [a]: { price: 0.000005 * 0.6, liquidityUsd: 30_000, timestamp: new Date() } });
    expect(closed.map((item) => item.exitReason)).toEqual(['STOP_LOSS']);
    expect(await prisma.trade.findFirstOrThrow({ where: { userId, side: 'BUY' } })).toMatchObject({ entryStrategy: 'ML', mlModelVersion: MODEL_A });
  });

  it('paused trading and a revoked model open nothing (no DEFAULT fallback)', async () => {
    const paused = await createUser({ strategyMode: 'ML', modelVersion: MODEL_A, tradingPaused: true });
    const revoked = await createUser({ strategyMode: 'ML', modelVersion: MODEL_B });
    await prisma.mlModelVersion.update({ where: { version: MODEL_B }, data: { paperApproved: false } });
    const [a, b, c] = [mint(), mint(), mint()];
    const d1 = await decisionRow(paused, a, MODEL_A);
    const d2 = await decisionRow(revoked, b, MODEL_B);
    await launchSignal(paused, a, 'ML', { decisionId: d1.id, modelVersion: MODEL_A });
    await launchSignal(revoked, b, 'ML', { decisionId: d2.id, modelVersion: MODEL_B });
    await launchSignal(revoked, c, 'DEFAULT');
    const summary = await coordinator([paused, revoked], new Map([[a, 0.000005], [b, 0.000005], [c, 0.000005]])).runCycle({ aborted: false });
    expect(summary.executed).toBe(0);
    expect(await rejectionsOf(paused)).toEqual(['TRADING_PAUSED_BY_USER']);
    expect((await rejectionsOf(revoked)).sort()).toEqual(['MODEL_NOT_PAPER_APPROVED', 'MODEL_NOT_PAPER_APPROVED']);
    await prisma.mlModelVersion.update({ where: { version: MODEL_B }, data: { paperApproved: true } });
  });

  it('no LIVE: a LIVE-mode bot never gets an ML entry', async () => {
    const live = await createUser({ strategyMode: 'ML', modelVersion: MODEL_A }, { tradingMode: 'LIVE' });
    const address = mint();
    const decision = await decisionRow(live, address, MODEL_A);
    await launchSignal(live, address, 'ML', { decisionId: decision.id, modelVersion: MODEL_A });
    const summary = await coordinator([live], new Map([[address, 0.000005]])).runCycle({ aborted: false });
    expect(summary.executed).toBe(0);
    expect(await prisma.trade.count({ where: { userId: live } })).toBe(0);
    expect(await prisma.trade.count({ where: { userId: { in: createdUsers }, mode: 'LIVE' } })).toBe(0);
  });
});
