/* eslint-disable @typescript-eslint/no-explicit-any -- prisma scoping proxy */
/**
 * NewLaunch PAPER entry against the development database (throw-away users only):
 * NEW_LAUNCH signal -> existing Paper Execution Engine -> exactly one position attributed to NEW_LAUNCH.
 */
import { randomUUID } from 'node:crypto';

import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, describe, expect, it } from 'vitest';

import { PaperExecutionCoordinator } from '../src/paper-execution.js';

const prisma = new PrismaClient();
const logger = { info: () => undefined, warn: () => undefined, error: () => undefined };
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

async function createUser(options: { aiEnabled: boolean; launchEnabled: boolean; tradingMode?: 'PAPER' | 'SEMI_AUTO' }) {
  const user = await prisma.user.create({ data: { email: `new-launch-${randomUUID().slice(0, 8)}@soltrader.test` } });
  createdUsers.push(user.id);
  await prisma.paperAccount.create({ data: { userId: user.id, initialBalance: 1_000, cashBalance: 1_000, equity: 1_000 } });
  await prisma.botConfig.create({ data: { userId: user.id, tradingMode: options.tradingMode ?? 'PAPER', status: 'RUNNING', maxPositionSize: 200 } });
  await prisma.riskConfig.create({ data: {
    userId: user.id, maxPositionPercent: 5, maxTotalExposurePercent: 25, maxConcurrentPositions: 4, dailyLossLimitPercent: 8, maxSlippagePercent: 3,
    minSignalScore: 60, cooldownSeconds: 0, stopLossPercent: 12, takeProfitPercent: 40, trailingStopPercent: 8, trailingActivationPercent: 15,
    riskPolicy: 'EXPLORATORY', lowRiskMax: 30, moderateRiskMax: 50, highRiskMax: 90, veryHighRiskMax: 100,
  } });
  await prisma.aiConfig.create({ data: { userId: user.id, aiAnalysisEnabled: options.aiEnabled } });
  await prisma.newLaunchConfig.create({ data: { userId: user.id, enabled: options.launchEnabled } });
  return user.id;
}

async function launchSignal(userId: string, mint: string, qualityGate: Record<string, unknown> | null = null) {
  const token = await prisma.token.upsert({ where: { address: mint }, update: {}, create: { address: mint, symbol: 'SNIP', name: 'Sniper test' } });
  if (!createdTokens.includes(token.id)) createdTokens.push(token.id);
  const now = Date.now();
  return prisma.signal.create({ data: {
    tokenId: token.id, userId, strategyName: 'NewLaunchStrategy', direction: 'BUY', score: new Prisma.Decimal(82), riskScore: new Prisma.Decimal(55), signalType: 'NEW_LAUNCH', mode: 'SCANNER',
    reasons: ['ALL_LAUNCH_CONDITIONS_MET'], entryConditions: [], invalidationConditions: [],
    metadata: {
      decisionSource: 'NEW_LAUNCH', primaryStrategy: 'NewLaunchStrategy', riskClassification: 'HIGH', hardBlocked: false, hardBlockReasons: [], riskPolicy: 'EXPLORATORY', riskWarnings: [], riskFactors: {},
      launch: { source: 'PUMP_FUN', mint, detectedAt: new Date(now - 25_000).toISOString(), decisionAt: new Date(now - 1_000).toISOString(), ageSeconds: 27, score: 82, detectedPrice: 0.0000045, decisionPrice: 0.0000048, liquidityUsd: 30_000, reasons: ['ALL_LAUNCH_CONDITIONS_MET'], warnings: [], qualityGate },
    },
  } });
}

function coordinator(userIds: string[], quotes: Map<string, number>, events: Array<Record<string, unknown>>) {
  const provider = { getTokenMetrics: async () => null } as any;
  return new PaperExecutionCoordinator({
    prisma: scoped(userIds), provider, logger, publishEvent: async () => undefined,
    getLaunchQuote: (mint: string) => (quotes.has(mint) ? { priceUsd: quotes.get(mint)!, liquidityUsd: 30_000, timestamp: new Date(), impactPercentFor: () => 0.8 } : null),
    publishLaunchEvent: async (event: Record<string, unknown>) => { events.push(event); },
  } as any);
}

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
    await prisma.newLaunchConfig.deleteMany({ where: { userId } });
    await prisma.aiConfig.deleteMany({ where: { userId } });
    await prisma.riskConfig.deleteMany({ where: { userId } });
    await prisma.botConfig.deleteMany({ where: { userId } });
    await prisma.paperAccount.deleteMany({ where: { userId } });
  }
  await prisma.token.deleteMany({ where: { id: { in: createdTokens } } });
  for (const userId of createdUsers) await prisma.user.delete({ where: { id: userId } });
  await prisma.$disconnect();
});

describe('NewLaunch PAPER entries (existing Paper Execution Engine)', () => {
  it('NEW_LAUNCH signal -> exactly one PAPER position, attributed to NEW_LAUNCH, even while AI mode is active', async () => {
    const userId = await createUser({ aiEnabled: true, launchEnabled: true });
    const mint = `SNIPE${randomUUID().slice(0, 12)}`;
    const signal = await launchSignal(userId, mint);
    const events: Array<Record<string, unknown>> = [];
    const quotes = new Map([[mint, 0.000005]]);
    const summary = await coordinator([userId], quotes, events).runCycle({ aborted: false });
    expect(summary.executed).toBe(1);

    const positions = await prisma.position.findMany({ where: { userId } });
    expect(positions).toHaveLength(1);
    const trade = await prisma.trade.findFirstOrThrow({ where: { userId } });
    expect(trade).toMatchObject({ decisionSource: 'NEW_LAUNCH', strategyName: 'NewLaunchStrategy', signalId: signal.id, positionId: positions[0].id, mode: 'PAPER' });
    // Small separate sizing: NewLaunch max 1% of equity (before the risk multiplier), never the fixed 200 USDC size.
    expect(Number(trade.size)).toBeGreaterThan(0);
    expect(Number(trade.size)).toBeLessThanOrEqual(10.01);
    const snapshot = trade.configSnapshot as Record<string, any>;
    expect(snapshot.launch).toMatchObject({ mint, score: 82 });
    expect(snapshot.launch.fillAt).toBeTruthy();
    expect(snapshot.launch.simulatedFillPrice).toBeGreaterThanOrEqual(0.000005);
    const entryEvent = await prisma.positionEvent.findFirstOrThrow({ where: { positionId: positions[0].id, type: 'ENTRY' } });
    expect(entryEvent.userId).toBe(userId);
    expect(events.some((event) => event.event === 'new_launch_position_opened' && event.positionId === positions[0].id)).toBe(true);

    // Idempotency: a second signal / cycle for the same launch never opens a second position.
    await launchSignal(userId, mint);
    await coordinator([userId], quotes, events).runCycle({ aborted: false });
    expect(await prisma.position.count({ where: { userId } })).toBe(1);
    expect(await prisma.trade.count({ where: { userId, decisionSource: 'NEW_LAUNCH' } })).toBe(1);
  });

  it('disabled NewLaunch or a non-PAPER mode never buys', async () => {
    const disabled = await createUser({ aiEnabled: false, launchEnabled: false });
    const semi = await createUser({ aiEnabled: false, launchEnabled: true, tradingMode: 'SEMI_AUTO' });
    const mintA = `SNIPE${randomUUID().slice(0, 12)}`;
    const mintB = `SNIPE${randomUUID().slice(0, 12)}`;
    await launchSignal(disabled, mintA);
    await launchSignal(semi, mintB);
    const summary = await coordinator([disabled, semi], new Map([[mintA, 0.00001], [mintB, 0.00001]]), []).runCycle({ aborted: false });
    expect(summary.executed).toBe(0);
    expect(summary.proposed).toBe(0);
    expect(await prisma.position.count({ where: { userId: { in: [disabled, semi] } } })).toBe(0);
  });

  it('without a live launch quote there is no fill (no invented price)', async () => {
    const userId = await createUser({ aiEnabled: false, launchEnabled: true });
    const mint = `SNIPE${randomUUID().slice(0, 12)}`;
    await launchSignal(userId, mint);
    const summary = await coordinator([userId], new Map(), []).runCycle({ aborted: false });
    expect(summary.executed).toBe(0);
    expect(await prisma.position.count({ where: { userId } })).toBe(0);
  });

  it('NEW_LAUNCH positions use the NewLaunch exit settings (not the strategy SL) and snapshot them; later settings changes do not rewrite open positions', async () => {
    const userId = await createUser({ aiEnabled: false, launchEnabled: true });
    const first = `SNIPE${randomUUID().slice(0, 12)}`;
    await launchSignal(userId, first);
    await coordinator([userId], new Map([[first, 0.000005]]), []).runCycle({ aborted: false });
    const position = await prisma.position.findFirstOrThrow({ where: { userId } });
    const entry = Number(position.avgEntryPrice);
    // NewLaunch default SL 20% / TP 25% — the strategy SL for this user is 12%.
    expect(Number(position.stopLossPrice)).toBeCloseTo(entry * 0.8, 12);
    expect(Number(position.takeProfitPrice)).toBeCloseTo(entry * 1.25, 12);
    expect(Number(position.trailingActivationPercent)).toBeCloseTo(0.15, 8);
    expect(Number(position.breakEvenActivationPercent)).toBeCloseTo(0.1, 8);
    expect(position).toMatchObject({ exitPolicy: 'NEW_LAUNCH', configVersion: 'NL-v1' });
    expect(Number(position.liquidityExitPercent)).toBe(50);
    const trade = await prisma.trade.findFirstOrThrow({ where: { userId } });
    const snapshot = trade.configSnapshot as Record<string, any>;
    expect(snapshot.newLaunch.exitConfig).toMatchObject({ stopLossPercent: 20, takeProfitPercent: 25, breakEvenActivationPercent: 10, trailingActivationPercent: 15, trailingDistancePercent: 8, liquidityDropExitPercent: 50 });
    expect(snapshot.newLaunch.configVersion).toBe('NL-v1');
    expect(snapshot.stopLossPercent).toBe(20);
    expect(await prisma.positionPathMetric.count({ where: { positionId: position.id } })).toBe(1);

    // Settings change to SL 10%: the open position keeps its snapshotted policy; a new one uses 10%.
    await prisma.newLaunchConfig.update({ where: { userId }, data: { stopLossPercent: 10, configVersion: 'NL-v2', maxConcurrentPositions: 5 } });
    const second = `SNIPE${randomUUID().slice(0, 12)}`;
    await launchSignal(userId, second);
    await coordinator([userId], new Map([[second, 0.000005]]), []).runCycle({ aborted: false });
    const unchanged = await prisma.position.findUniqueOrThrow({ where: { id: position.id } });
    expect(Number(unchanged.stopLossPrice)).toBeCloseTo(entry * 0.8, 12);
    const newer = await prisma.position.findFirstOrThrow({ where: { userId, id: { not: position.id } } });
    expect(Number(newer.stopLossPrice)).toBeCloseTo(Number(newer.avgEntryPrice) * 0.9, 12);
    expect(newer.configVersion).toBe('NL-v2');
  });

  it('quality gate: MONITOR_ONLY failure still executes (wouldPass=false stored); ENFORCE_PAPER failure gets no PAPER BUY', async () => {
    const userId = await createUser({ aiEnabled: false, launchEnabled: true });
    await prisma.newLaunchConfig.update({ where: { userId }, data: { maxConcurrentPositions: 5 } });
    const monitored = `SNIPE${randomUUID().slice(0, 12)}`;
    await launchSignal(userId, monitored, { mode: 'MONITOR_ONLY', evaluated: true, wouldPass: false, reasons: ['LAUNCH_SCORE_BELOW_GATE'], blocksEntry: false, version: 1 });
    await coordinator([userId], new Map([[monitored, 0.000005]]), []).runCycle({ aborted: false });
    const trade = await prisma.trade.findFirstOrThrow({ where: { userId } });
    expect((trade.configSnapshot as Record<string, any>).newLaunch.qualityGate).toMatchObject({ wouldPass: false, blocksEntry: false });

    const enforced = `SNIPE${randomUUID().slice(0, 12)}`;
    await launchSignal(userId, enforced, { mode: 'ENFORCE_PAPER', evaluated: true, wouldPass: false, reasons: ['UNIQUE_BUYERS_BELOW_GATE'], blocksEntry: true, version: 1 });
    const summary = await coordinator([userId], new Map([[enforced, 0.000005]]), []).runCycle({ aborted: false });
    expect(summary.executed).toBe(0);
    expect(await prisma.trade.count({ where: { userId } })).toBe(1);
    const rejection = await prisma.auditLog.findFirst({ where: { userId, action: 'TRADE_REJECTED' }, orderBy: { createdAt: 'desc' } });
    expect(JSON.stringify(rejection?.details)).toContain('QUALITY_GATE_FAILED');
  });

  it('exit capacity: MONITOR_ONLY keeps the NL size and stores the shadow recommendation; ENFORCE_PAPER reduces to the safe maximum', async () => {
    // Thin bonding curve: 2 SOL virtual reserve at 150 USD/SOL -> roughly 9 USDC can be exited within 3% impact.
    const thinQuote = (mint: string) => ({ priceUsd: 0.000005, liquidityUsd: 30_000, timestamp: new Date(), impactPercentFor: () => 0.8, curve: { virtualQuote: 2, virtualBase: 2 / (0.000005 / 150), realQuote: 1, quoteUsd: 150 }, migrated: false, streaming: true, mint });
    const run = async (userId: string, mint: string) => new PaperExecutionCoordinator({
      prisma: scoped([userId]), provider: { getTokenMetrics: async () => null } as any, logger, publishEvent: async () => undefined,
      getLaunchQuote: (requested: string) => (requested === mint ? thinQuote(mint) : null),
    } as any).runCycle({ aborted: false });

    const monitorUser = await createUser({ aiEnabled: false, launchEnabled: true });
    await prisma.paperAccount.update({ where: { userId: monitorUser }, data: { cashBalance: 20_000, equity: 20_000, initialBalance: 20_000 } });
    const monitored = `SNIPE${randomUUID().slice(0, 12)}`;
    await launchSignal(monitorUser, monitored);
    await run(monitorUser, monitored);
    const trade = await prisma.trade.findFirstOrThrow({ where: { userId: monitorUser } });
    const sizing = (trade.configSnapshot as Record<string, any>).launch.exitCapacity.sizing;
    expect(sizing.sizingMode).toBe('MONITOR_ONLY');
    expect(sizing.decision).toBe('REDUCE');
    expect(Number(trade.size)).toBeCloseTo(sizing.riskApprovedSize, 6);
    expect(sizing.actualExecutedSize).toBeCloseTo(sizing.riskApprovedSize, 6);
    expect(sizing.finalRecommendedSize).toBeLessThan(sizing.riskApprovedSize);
    expect(sizing.difference).toBeLessThan(0);
    const atEntry = (trade.configSnapshot as Record<string, any>).launch.exitCapacity.atEntry;
    expect(atEntry.basis).toBe('POOL_MODEL');
    expect(atEntry.maxSafePosition).toBe(sizing.finalRecommendedSize);

    const enforceUser = await createUser({ aiEnabled: false, launchEnabled: true });
    await prisma.paperAccount.update({ where: { userId: enforceUser }, data: { cashBalance: 20_000, equity: 20_000, initialBalance: 20_000 } });
    await prisma.newLaunchConfig.update({ where: { userId: enforceUser }, data: { exitCapacityMode: 'ENFORCE_PAPER' } });
    const enforced = `SNIPE${randomUUID().slice(0, 12)}`;
    await launchSignal(enforceUser, enforced);
    await run(enforceUser, enforced);
    const enforcedTrade = await prisma.trade.findFirstOrThrow({ where: { userId: enforceUser } });
    const enforcedSizing = (enforcedTrade.configSnapshot as Record<string, any>).launch.exitCapacity.sizing;
    expect(Number(enforcedTrade.size)).toBeCloseTo(enforcedSizing.finalRecommendedSize, 6);
    expect(Number(enforcedTrade.size)).toBeLessThan(enforcedSizing.riskApprovedSize);
  });
});

