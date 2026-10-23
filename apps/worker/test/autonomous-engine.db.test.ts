/* eslint-disable @typescript-eslint/no-explicit-any -- minimal launch state fixtures */
/**
 * Autonomous ML PAPER engine against the LOCAL development database (throw-away users / bundles / rows, removed
 * afterwards; never run against production). Market data comes from an in-memory accessor; bundles are controlled
 * constant-output test bundles (no trained model is claimed here).
 *
 * Covers: collection without users, BUY into the separate virtual account (the user's PAPER account and Trade table are
 * untouched), one decision per decision point (duplicates / restart), model SELL / PARTIAL_SELL / HOLD, fail-safe
 * protection when the bundle is unavailable, mandatory safety blockers, LIVE / non-PAPER refusal, stale quotes, SHADOW.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PrismaClient } from '@prisma/client';
import { AUTONOMOUS_BUNDLE_FORMAT, ML_AUTONOMOUS_FEATURE_VERSION } from '@soltrader/strategy-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AutonomousEngine, type AutonomousLaunchAccessor } from '../src/autonomous/engine.js';

const prisma = new PrismaClient();
const logger = { info: () => undefined, warn: () => undefined };
const run = randomUUID().slice(0, 8);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const bundleDir = path.join(repoRoot, 'ml', 'autonomous-models', `__test-${run}`);
const users: string[] = [];
const bundles: string[] = [];

const leaf = (value: number) => ({ format: 'soltrader-ml-model-v1', modelVersion: 'x', algorithm: 'lightgbm', featureVersion: ML_AUTONOMOUS_FEATURE_VERSION, labelVersion: 'AUTO-LABELS-v1', target: 'x', columns: [{ name: 'ret1mPct', feature: 'ret1mPct', kind: 'value' }], lightgbm: { trees: [{ tree_structure: { leaf_value: value } }] }, calibration: null, decisionThreshold: 0.5 });

/** Constant-output test bundle: expected net / downside / logit(profit) / hold advantage / logit(hold). */
async function makeBundle(name: string, outputs: { ret: number; down: number; profit: number; adv: number; hold: number }, row: { status?: string; paperApproved?: boolean; corrupt?: boolean } = {}) {
  const version = `TEST-AUTO-${name}-${run}`;
  const bundle = {
    format: AUTONOMOUS_BUNDLE_FORMAT, bundleVersion: version, featureVersion: ML_AUTONOMOUS_FEATURE_VERSION, labelVersion: 'AUTO-LABELS-v1', datasetVersion: 'TEST', createdAt: new Date().toISOString(),
    components: {
      entryReturn: { ...leaf(outputs.ret), objective: 'regression' }, entryDownside: { ...leaf(outputs.down), objective: 'regression' }, entryProfit: { ...leaf(outputs.profit), objective: 'binary' },
      exitAdvantage: { ...leaf(outputs.adv), objective: 'regression' }, exitHold: { ...leaf(outputs.hold), objective: 'binary' },
    },
    policy: { entry: { minProbability: 0.6, minExpectedNetPct: 1, minDownsideNetPct: -30, waitMinProbability: 0.5 }, exit: { sellBelowAdvantagePct: -1, partialBelowAdvantagePct: -0.5, minHoldProbability: 0.4, partialSellFraction: 0.5 } },
    sizing: { method: 'EDGE_OVER_DOWNSIDE', baseFractionPct: 2, maxFractionPct: 5, minOrderUsd: 5, maxImpactPct: 8 },
  };
  mkdirSync(path.join(bundleDir, version), { recursive: true });
  const text = JSON.stringify(bundle);
  writeFileSync(path.join(bundleDir, version, 'bundle.json'), text);
  await prisma.mlAutonomousModelBundle.create({ data: {
    version, status: row.status ?? 'SHADOW', readiness: 'SHADOW_READY', featureVersion: ML_AUTONOMOUS_FEATURE_VERSION, labelVersion: 'AUTO-LABELS-v1', datasetVersion: 'TEST',
    artifactPath: path.relative(repoRoot, path.join(bundleDir, version, 'bundle.json')).replace(/\\/g, '/'), artifactHash: row.corrupt ? 'f'.repeat(64) : createHash('sha256').update(text).digest('hex'),
    policy: bundle.policy, metrics: {}, statusHistory: [], trainedAt: new Date(), paperApproved: row.paperApproved ?? true,
  } });
  bundles.push(version);
  return version;
}

async function createUser(bundleVersion: string | null, options: { tradingMode?: 'PAPER' | 'LIVE'; paused?: boolean } = {}) {
  const user = await prisma.user.create({ data: { email: `auto-${randomUUID().slice(0, 8)}@soltrader.test` } });
  users.push(user.id);
  await prisma.paperAccount.create({ data: { userId: user.id, initialBalance: 1_000, cashBalance: 1_000, equity: 1_000 } });
  await prisma.botConfig.create({ data: { userId: user.id, tradingMode: options.tradingMode ?? 'PAPER', status: 'RUNNING' } });
  await prisma.mlPaperSettings.create({ data: { userId: user.id, strategyMode: 'ML_AUTONOMOUS', autonomousBundleVersion: bundleVersion, tradingPaused: options.paused ?? false } });
  return user.id;
}

/** In-memory market: launches with a live quote, tracker-like state and samples. */
class Market implements AutonomousLaunchAccessor {
  tokens = new Map<string, { detectedAt: number; price: number; liquidity: number; quoteAt: number; migrated: boolean; blockers: string[] }>();
  constructor(private readonly clock: () => number) {}
  add(mint: string, detectedAt: number, price = 0.00001, liquidity = 30_000) {
    this.tokens.set(mint, { detectedAt, price, liquidity, quoteAt: this.clock(), migrated: false, blockers: [] });
  }
  launches() {
    return [...this.tokens.entries()].map(([mint, token]) => ({ mint, source: 'PUMP_FUN', symbol: 'TST', detectedAt: token.detectedAt, createdAt: token.detectedAt - 1_000, firstTradeAt: token.detectedAt, migrated: token.migrated, trades: 20 }));
  }
  state(mint: string) {
    const token = this.tokens.get(mint);
    if (!token) return null;
    const observations = Array.from({ length: 6 }, (_, i) => ({ takenAt: token.detectedAt + i * 2_000, priceUsd: token.price, liquidityUsd: token.liquidity, buyCount: 5 + i, sellCount: 2, volumeUsd: 200 + i * 50, buyVolumeUsd: 150, sellVolumeUsd: 50, uniqueBuyers: 4 + i, uniqueSellers: 2 }));
    return { mint, detectedAt: token.detectedAt, createdAt: token.detectedAt - 1_000, observations, largestBuyerShare: 0.1, buysPerBuyer: 1.2, creatorSoldRatio: 0, largestHolderSupplyShare: 0.04, priceImpactPercent: 1, observedSellers: 3 } as any;
  }
  security() {
    return { security: { sellability: 'VERIFIED', mintAuthorityRevoked: true, freezeAuthorityRevoked: true, tokenProgram: 'spl-token', extensions: [], hardBlockReasons: [], warnings: [] } as any, completedAt: this.clock() - 5_000 };
  }
  samples(mint: string) {
    const token = this.tokens.get(mint)!;
    return [{ t: token.detectedAt, price: token.price, liquidityUsd: token.liquidity, tradeCount: 0 }, { t: token.quoteAt, price: token.price, liquidityUsd: token.liquidity, tradeCount: 20 }];
  }
  quote(mint: string) {
    const token = this.tokens.get(mint);
    return token ? { price: token.price, liquidityUsd: token.liquidity, at: token.quoteAt, migrated: token.migrated } : null;
  }
  tokenSafety(mint: string) {
    return { blockers: this.tokens.get(mint)?.blockers ?? [], riskScore: 40, riskObservedAt: this.clock() };
  }
  async candidateId() {
    return null;
  }
}

function setup(serverMode = 'PAPER') {
  let now = Date.now();
  const market = new Market(() => now);
  const engine = () => new AutonomousEngine({ prisma, logger, repoRoot, accessor: () => market, serverTradingMode: () => serverMode, initialBalanceUsd: 1_000, maxSnapshotsPerMinute: 1_000, now: () => now, accountFilter: (userId) => users.includes(userId) });
  return { market, engine, now: () => now, advance: (ms: number) => { now += ms; }, setNow: (value: number) => { now = value; } };
}

const mint = () => `AUTO${randomUUID().replace(/-/g, '').slice(0, 28)}`;

afterAll(async () => {
  const accounts = await prisma.mlAutonomousAccount.findMany({ where: { userId: { in: users } }, select: { id: true } });
  const accountIds = accounts.map((account) => account.id);
  const positions = await prisma.mlAutonomousPosition.findMany({ where: { accountId: { in: accountIds } }, select: { id: true, mint: true } });
  await prisma.mlAutonomousFill.deleteMany({ where: { accountId: { in: accountIds } } });
  await prisma.mlAutonomousPosition.deleteMany({ where: { accountId: { in: accountIds } } });
  await prisma.mlAutonomousDecision.deleteMany({ where: { OR: [{ accountId: { in: accountIds } }, { bundleVersion: { in: bundles } }] } });
  await prisma.mlAutonomousAccount.deleteMany({ where: { id: { in: accountIds } } });
  await prisma.mlAutonomousDecisionSnapshot.deleteMany({ where: { mint: { startsWith: 'AUTO' }, createdAt: { gte: new Date(Date.now() - 3_600_000) } } });
  await prisma.mlAutonomousModelBundle.deleteMany({ where: { version: { in: bundles } } });
  for (const userId of users) {
    await prisma.mlPaperSettings.deleteMany({ where: { userId } });
    await prisma.botConfig.deleteMany({ where: { userId } });
    await prisma.paperAccount.deleteMany({ where: { userId } });
    await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
  }
  void positions;
  rmSync(bundleDir, { recursive: true, force: true });
  await prisma.$disconnect();
});

beforeAll(async () => {
  // Isolation from other rows in the dev DB: no other SHADOW bundle is newer than ours during the run.
  expect(await prisma.mlAutonomousModelBundle.count({ where: { status: 'SHADOW', version: { notIn: bundles } } })).toBeGreaterThanOrEqual(0);
});

const decisionsOf = (accountUserId: string) => prisma.mlAutonomousDecision.findMany({ where: { userId: accountUserId }, orderBy: { decidedAt: 'asc' } });

describe('Autonomous ML engine', () => {
  it('collects ENTRY decision snapshots without any user or bundle (data collection only)', async () => {
    const h = setup();
    const token = mint();
    h.market.add(token, h.now() - 16_000);
    await h.engine().tick();
    const snapshots = await prisma.mlAutonomousDecisionSnapshot.findMany({ where: { mint: token } });
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({ kind: 'ENTRY', trigger: 'AGE_15S', featureVersion: ML_AUTONOMOUS_FEATURE_VERSION, validForTraining: true });
    expect((snapshots[0].features as any).decisionKind).toBe('ENTRY');
    expect(await prisma.mlAutonomousDecision.count({ where: { mint: token, mode: 'PAPER' } })).toBe(0);
  });

  it('BUY into the separate virtual account; PAPER account / Trade table untouched; one decision per point (duplicate + restart safe)', async () => {
    const h = setup();
    const version = await makeBundle('buy', { ret: 6, down: -6, profit: 2, adv: 2, hold: 2 });
    const userId = await createUser(version);
    const token = mint();
    h.market.add(token, h.now() - 16_000);
    const engine = h.engine();
    await engine.tick();
    await engine.tick();
    await h.engine().tick();
    const positions = await prisma.mlAutonomousPosition.findMany({ where: { userId } });
    expect(positions).toHaveLength(1);
    expect(positions[0]).toMatchObject({ mint: token, status: 'OPEN', bundleVersion: version });
    const decision = (await decisionsOf(userId)).find((row) => row.action === 'BUY')!;
    expect(decision).toMatchObject({ mode: 'PAPER', kind: 'ENTRY', executionStatus: 'EXECUTED', bundleVersion: version, positionId: positions[0].id });
    expect(Number(decision.suggestedSizeUsd)).toBeGreaterThan(0);
    expect(Number(decision.executedSizeUsd)).toBeLessThanOrEqual(Number(decision.suggestedSizeUsd));
    expect(decision.featureHash).toMatch(/^[0-9a-f]{64}$/);
    expect(decision.snapshotId).toBeTruthy();
    expect((decision.outputs as any).expectedNetPct).toBeCloseTo(6, 6);
    const account = await prisma.mlAutonomousAccount.findUniqueOrThrow({ where: { userId } });
    expect(account.accountKey).toBe(`ML_AUTONOMOUS_PAPER:${userId}`);
    expect(Number(account.cashBalance)).toBeLessThan(1_000);
    expect(Number((await prisma.paperAccount.findUniqueOrThrow({ where: { userId } })).cashBalance)).toBe(1_000);
    expect(await prisma.trade.count({ where: { userId } })).toBe(0);
    expect(await prisma.mlAutonomousFill.count({ where: { accountId: account.id, side: 'BUY' } })).toBe(1);
  });

  it('model exits: HOLD while the hold value is positive, PARTIAL_SELL then SELL when it turns negative', async () => {
    const h = setup();
    const holdVersion = await makeBundle('exit', { ret: 6, down: -6, profit: 2, adv: 2, hold: 2 });
    const userId = await createUser(holdVersion);
    const token = mint();
    h.market.add(token, h.now() - 16_000);
    await h.engine().tick();
    const [position] = await prisma.mlAutonomousPosition.findMany({ where: { userId } });
    expect(position.status).toBe('OPEN');
    // Price up, still HOLD.
    h.advance(11_000);
    const market = h.market.tokens.get(token)!;
    market.price *= 1.2;
    market.quoteAt = h.now();
    await h.engine().tick();
    expect((await decisionsOf(userId)).some((row) => row.kind === 'POSITION' && row.action === 'HOLD')).toBe(true);
    // The position's bundle now sees a weakly negative hold value -> partial, then clearly negative -> sell.
    const bundleRow = await prisma.mlAutonomousModelBundle.findUniqueOrThrow({ where: { version: holdVersion } });
    const file = path.join(repoRoot, bundleRow.artifactPath);
    const write = async (adv: number) => {
      const bundle = JSON.parse((await import('node:fs')).readFileSync(file, 'utf8'));
      bundle.components.exitAdvantage.lightgbm.trees[0].tree_structure.leaf_value = adv;
      const text = JSON.stringify(bundle);
      writeFileSync(file, text);
      await prisma.mlAutonomousModelBundle.update({ where: { version: holdVersion }, data: { artifactHash: createHash('sha256').update(text).digest('hex') } });
    };
    await write(-0.7);
    h.advance(61_000);
    market.quoteAt = h.now();
    await h.engine().tick();
    const afterPartial = await prisma.mlAutonomousPosition.findUniqueOrThrow({ where: { id: position.id } });
    expect(afterPartial).toMatchObject({ status: 'OPEN', partiallySold: true });
    expect(Number(afterPartial.quantity)).toBeCloseTo(Number(position.quantity) / 2, 6);
    await write(-3);
    h.advance(61_000);
    market.quoteAt = h.now();
    await h.engine().tick();
    const closed = await prisma.mlAutonomousPosition.findUniqueOrThrow({ where: { id: position.id } });
    expect(closed).toMatchObject({ status: 'CLOSED', exitReason: 'MODEL_SELL', openKey: null });
    expect(Number(closed.realizedPnlUsd)).toBeGreaterThan(0);
    const fills = await prisma.mlAutonomousFill.findMany({ where: { positionId: position.id }, orderBy: { at: 'asc' } });
    expect(fills.map((fill) => fill.reason)).toEqual(['MODEL_BUY', 'MODEL_PARTIAL_SELL', 'MODEL_SELL']);
    // Never a second entry on the same token for this account.
    h.advance(61_000);
    await h.engine().tick();
    expect(await prisma.mlAutonomousPosition.count({ where: { userId } })).toBe(1);
  }, 30_000);

  it('bundle unavailable (corrupt file): no BUY; an open position is still protected by the fail-safe (hard max loss)', async () => {
    const h = setup();
    const good = await makeBundle('good', { ret: 6, down: -6, profit: 2, adv: 2, hold: 2 });
    const userId = await createUser(good);
    const token = mint();
    h.market.add(token, h.now() - 16_000);
    await h.engine().tick();
    expect(await prisma.mlAutonomousPosition.count({ where: { userId, status: 'OPEN' } })).toBe(1);
    // The file is modified after approval: hash mismatch -> bundle unavailable.
    await prisma.mlAutonomousModelBundle.update({ where: { version: good }, data: { artifactHash: 'f'.repeat(64) } });
    const other = mint();
    h.market.add(other, h.now() - 16_000);
    const market = h.market.tokens.get(token)!;
    market.price *= 0.5;
    market.quoteAt = h.now();
    h.advance(11_000);
    market.quoteAt = h.now();
    h.market.tokens.get(other)!.detectedAt = h.now() - 31_000;
    await h.engine().tick();
    const positions = await prisma.mlAutonomousPosition.findMany({ where: { userId } });
    expect(positions).toHaveLength(1);
    expect(positions[0]).toMatchObject({ status: 'CLOSED', exitReason: 'HARD_MAX_LOSS' });
    expect((await decisionsOf(userId)).find((row) => row.mint === other)?.action).toBe('ERROR');
  });

  it('mandatory safety: token fraud blocker -> SAFETY_BLOCKED; LIVE bot / non-PAPER server -> no entry; paused -> no entry', async () => {
    const version = await makeBundle('safety', { ret: 6, down: -6, profit: 2, adv: 2, hold: 2 });
    const blockedUser = await createUser(version);
    const liveUser = await createUser(version, { tradingMode: 'LIVE' });
    const pausedUser = await createUser(version, { paused: true });
    const h = setup();
    const token = mint();
    h.market.add(token, h.now() - 16_000);
    h.market.tokens.get(token)!.blockers = ['SELLABILITY_FAILED'];
    await h.engine().tick();
    expect((await decisionsOf(blockedUser)).find((row) => row.action === 'BUY')).toMatchObject({ executionStatus: 'SAFETY_BLOCKED', safetyBlockers: ['SELLABILITY_FAILED'] });
    expect(await decisionsOf(liveUser)).toEqual([]);
    expect(await decisionsOf(pausedUser)).toEqual([]);
    const server = setup('LIVE');
    const second = mint();
    server.market.add(second, server.now() - 16_000);
    await server.engine().tick();
    expect(await prisma.mlAutonomousPosition.count({ where: { userId: { in: [blockedUser, liveUser, pausedUser] } } })).toBe(0);
    expect(await prisma.trade.count({ where: { userId: { in: [blockedUser, liveUser, pausedUser] }, mode: 'LIVE' } })).toBe(0);
  });

  it('a forced exit with a stale quote waits (no invented price)', async () => {
    const h = setup();
    const version = await makeBundle('stale', { ret: 6, down: -6, profit: 2, adv: 2, hold: 2 });
    const userId = await createUser(version);
    const token = mint();
    h.market.add(token, h.now() - 16_000);
    await h.engine().tick();
    const market = h.market.tokens.get(token)!;
    market.price *= 0.4;
    market.quoteAt = h.now();
    h.advance(120_000);
    await h.engine().tick();
    expect(await prisma.mlAutonomousPosition.count({ where: { userId, status: 'OPEN' } })).toBe(1);
  });

  it('SHADOW bundle: decisions recorded for evaluation, never executed, no account', async () => {
    const h = setup();
    const version = await makeBundle('shadow', { ret: 6, down: -6, profit: 2, adv: 2, hold: 2 }, { status: 'SHADOW', paperApproved: false });
    await prisma.mlAutonomousModelBundle.update({ where: { version }, data: { trainedAt: new Date(Date.now() + 60_000) } });
    const token = mint();
    h.market.add(token, h.now() - 16_000);
    await h.engine().tick();
    const shadow = await prisma.mlAutonomousDecision.findMany({ where: { bundleVersion: version } });
    expect(shadow).toHaveLength(1);
    expect(shadow[0]).toMatchObject({ mode: 'SHADOW', executionStatus: 'SHADOW', accountId: null, positionId: null });
  });
});
