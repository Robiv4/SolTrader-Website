/* eslint-disable @typescript-eslint/no-explicit-any -- request user stub / fixtures */
/**
 * SolTrader 3.0 END-TO-END (pnpm test:e2e; never part of the parallel unit run). LOCAL development database only:
 * the test refuses any non-local DATABASE_URL. Every row / file it creates is removed afterwards.
 *
 * Real components: API routers (settings, training jobs, models, check, approval), the ml-trainer job runner, the
 * dataset builder, the Python trainer (LightGBM), bundle registration, the Autonomous engine and its PAPER ledger.
 * Synthetic: the market (an in-memory accessor) and the historical outcome paths seeded into the dev DB. The market
 * is learnable on purpose (tokens with many buyers rise, then fall back): the test proves the pipeline end to end, it
 * proves nothing about real profitability.
 *
 * Steps: 1 empty model state -> 2 tokens / data -> 3 dataset -> 4 web training job -> 5 training + validation ->
 * 6 model listed -> 7 manual check / approval / selection -> 8 BUY -> 9 HOLD -> 10 SELL -> 11 settlement ->
 * 12 new data -> 13 second training -> 14 first model stays active -> 15 manual switch -> 16 open position protected
 * (own model) -> 17 model failure is fail-closed.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Prisma } from '@prisma/client';
import { buildMlFeatureSnapshot, newOutcomePath, recordPathPoint, type LaunchSecurity } from '@soltrader/strategy-engine';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AutonomousEngine, type AutonomousLaunchAccessor } from '../../worker/src/autonomous/engine.js';
import { TrainingJobRunner } from '../../worker/src/training/job-runner.js';
import { defaultPython } from '../../worker/src/training/pipeline.js';
import { prisma } from '../src/database.js';
import { createMlAutonomousRouter } from '../src/ml-autonomous.js';
import { createMlPaperRouter } from '../src/ml-paper.js';
import { createMlTrainingRouter } from '../src/ml-training.js';

const run = randomUUID().slice(0, 6);
const PREFIX = `E2E${run}`;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const python = defaultPython(repoRoot);
const logger = { info: () => undefined, warn: () => undefined, error: () => undefined };
const ids = { user: '' };
const email = `e2e-${run}@soltrader.local`;
const created = { bundles: [] as string[], datasets: [] as string[], jobs: [] as string[] };
const security: LaunchSecurity = { sellability: 'VERIFIED', mintAuthorityRevoked: true, freezeAuthorityRevoked: true, tokenProgram: 'spl-token', extensions: [], hardBlockReasons: [], warnings: [] };
const CANDIDATES = 2_100;
const START = Date.now() - (CANDIDATES * 120_000 + 2 * 3_600_000);

function assertLocalDatabase() {
  const url = new URL(process.env.DATABASE_URL ?? '');
  if (!['localhost', '127.0.0.1', '::1'].includes(url.hostname)) throw new Error(`E2E refused: DATABASE_URL host ${url.hostname} is not local (never run against production)`);
}

function app(role: 'ADMIN' | 'USER') {
  const server = express();
  server.use(express.json());
  server.use((req: any, _res, next) => {
    req.user = { id: ids.user, email, role };
    next();
  });
  const common = { prisma, logger, readJson: async () => null, stepUp: (async () => true) as any, logAuditEvent: async () => undefined };
  server.use('/api', createMlTrainingRouter(common));
  server.use('/api', createMlAutonomousRouter(common));
  server.use('/api', createMlPaperRouter({ ...common, serverTradingMode: () => 'PAPER', mlOnly: () => true }));
  return server;
}

/** Observations before a decision: "good" launches have many, growing buyers; "bad" ones few buyers and sellers. */
function observations(at: number, good: boolean, price: number) {
  return Array.from({ length: 10 }, (_, i) => ({
    takenAt: at - 27_000 + i * 3_000, priceUsd: price * (good ? 0.9 + 0.01 * i : 1.02 - 0.002 * i), liquidityUsd: 30_000, buyCount: good ? 20 + 12 * i : 4 + i, sellCount: good ? 2 + i : 6 + 2 * i,
    volumeUsd: good ? 400 + 160 * i : 80 + 10 * i, buyVolumeUsd: good ? 350 + 140 * i : 40 + 5 * i, sellVolumeUsd: good ? 50 + 20 * i : 40 + 5 * i, uniqueBuyers: good ? 10 + 4 * i : 2 + (i > 5 ? 1 : 0), uniqueSellers: good ? 1 + i : 3 + i,
  }));
}
const launchState = (mint: string, at: number, good: boolean, price: number) => ({ mint, detectedAt: at - 30_000, createdAt: at - 31_000, observations: observations(at, good, price), largestBuyerShare: good ? 0.08 : 0.4, buysPerBuyer: good ? 1.3 : 2.5, creatorSoldRatio: good ? 0 : 0.2, largestHolderSupplyShare: 0.04, priceImpactPercent: 1, observedSellers: 3 });

/** Price multiple over time: good = +50% in 8 min, back to 1.0 by 20 min; bad = -30% in 10 min. */
const multiple = (good: boolean, seconds: number) => (good ? (seconds <= 480 ? 1 + 0.5 * seconds / 480 : seconds <= 1_200 ? 1.5 - 0.5 * (seconds - 480) / 720 : 1) : 1 - 0.3 * Math.min(seconds, 600) / 600);

async function seedHistory() {
  const rng = (() => {
    let seed = 7;
    return () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  })();
  for (let offset = 0; offset < CANDIDATES; offset += 300) {
    const snapshots: Prisma.MlFeatureSnapshotCreateManyInput[] = [];
    const outcomes: Prisma.MlCandidateOutcomeCreateManyInput[] = [];
    for (let i = offset; i < Math.min(CANDIDATES, offset + 300); i += 1) {
      const at = START + i * 120_000;
      const mint = `${PREFIX}H${i}`;
      const good = rng() < 0.5;
      const behavesGood = rng() < 0.15 ? !good : good;
      const price = 0.00001;
      const snapshot = buildMlFeatureSnapshot({ snapshotAt: at, source: 'PUMP_FUN', detectedAt: at - 30_000, createdAt: at - 31_000, firstTradeAt: at - 29_000, state: launchState(mint, at, good, price), security, securityObservedAt: at - 5_000, riskScore: 40, riskObservedAt: at, social: null, referenceImpactPct: 1 });
      const id = `${PREFIX}S${i}`;
      snapshots.push({ id, candidateId: `${PREFIX}C${i}`, mint, source: 'PUMP_FUN', kind: 'AGE_30S', snapshotAt: new Date(at), detectedAt: new Date(at - 30_000), featureVersion: 'ML-FEATURES-v1', features: snapshot.features as Prisma.InputJsonValue, observedAt: snapshot.observedAt as Prisma.InputJsonValue, dataQuality: snapshot.dataQuality, validForTraining: snapshot.validForTraining, invalidReasons: snapshot.invalidReasons, lateDataExcluded: [], decision: 'WATCH', decisionContext: {}, referencePriceUsd: new Prisma.Decimal(snapshot.referencePriceUsd!) });
      const path0 = newOutcomePath(at, snapshot.referencePriceUsd!, 30_000);
      for (let s = 10; s <= 3_590; s += 10) recordPathPoint(path0, at + s * 1_000, snapshot.referencePriceUsd! * multiple(behavesGood, s) * (1 + (rng() - 0.5) * 0.01), 30_000 * multiple(behavesGood, s));
      path0.endedAt = at + 3_600_001;
      path0.endReason = 'HORIZON_REACHED';
      outcomes.push({ snapshotId: id, mint, labelVersion: 'ML-LABELS-v1', status: 'COMPLETE', entryPriceUsd: new Prisma.Decimal(snapshot.referencePriceUsd!), result: {}, path: path0 as unknown as Prisma.InputJsonValue, validHorizons: [], endReason: 'HORIZON_REACHED', trackingEndedAt: new Date(at + 3_600_000) });
    }
    await prisma.mlFeatureSnapshot.createMany({ data: snapshots });
    await prisma.mlCandidateOutcome.createMany({ data: outcomes });
  }
}

/** In-memory live market (tracker-like state, samples, quotes) whose launches follow the same two patterns. */
class Market implements AutonomousLaunchAccessor {
  tokens = new Map<string, { detectedAt: number; good: boolean; price: number; samples: Array<{ t: number; price: number; liquidityUsd: number; tradeCount: number }>; quoteAt: number }>();
  constructor(private readonly clock: () => number) {}
  add(mint: string, good: boolean) {
    const now = this.clock();
    this.tokens.set(mint, { detectedAt: now - 30_000, good, price: 0.00001, samples: [{ t: now, price: 0.00001, liquidityUsd: 30_000, tradeCount: 0 }], quoteAt: now });
  }
  move(mint: string, multiple: number) {
    const token = this.tokens.get(mint)!;
    const now = this.clock();
    token.price = 0.00001 * multiple;
    token.quoteAt = now;
    token.samples.push({ t: now, price: token.price, liquidityUsd: 30_000 * multiple, tradeCount: token.samples.length });
  }
  launches() {
    return [...this.tokens.entries()].map(([mint, token]) => ({ mint, source: 'PUMP_FUN', symbol: 'E2E', detectedAt: token.detectedAt, createdAt: token.detectedAt - 1_000, firstTradeAt: token.detectedAt + 1_000, migrated: false, trades: 50 }));
  }
  state(mint: string) {
    const token = this.tokens.get(mint);
    return token ? launchState(mint, token.detectedAt + 30_000, token.good, 0.00001) as any : null;
  }
  security() {
    return { security, completedAt: this.clock() - 5_000 };
  }
  samples(mint: string) {
    return this.tokens.get(mint)?.samples ?? [];
  }
  quote(mint: string) {
    const token = this.tokens.get(mint);
    return token ? { price: token.price, liquidityUsd: 30_000 * token.price / 0.00001, at: token.quoteAt, migrated: false } : null;
  }
  tokenSafety() {
    return { blockers: [] as string[], riskScore: 40, riskObservedAt: this.clock() };
  }
  async candidateId() {
    return null;
  }
}

const trainingRunner = () => new TrainingJobRunner({ prisma, logger, rootDir: repoRoot, python, owner: `e2e-${run}`, timeoutMs: 20 * 60_000, heartbeatMs: 2_000 });

async function trainViaWeb(name: string) {
  const started = await request(app('ADMIN')).post('/api/ml/autonomous/training-jobs').send({ name });
  expect(started.status, JSON.stringify(started.body)).toBe(201);
  created.jobs.push(started.body.data.id);
  await trainingRunner().poll();
  const job = (await request(app('USER')).get(`/api/ml/autonomous/training-jobs/${started.body.data.id}`)).body.data;
  expect(job.error).toBeNull();
  expect(job.status).toBe('COMPLETED');
  created.bundles.push(job.bundleVersion);
  created.datasets.push(job.datasetVersion);
  return job;
}

/** "Modell ellenőrzése" + SHADOW decisions + approval, all through the real routes and the real engine. */
async function checkAndApprove(version: string, clock: { now: number }) {
  expect((await request(app('ADMIN')).post(`/api/ml/autonomous/models/${version}/check`).send({})).body.data).toEqual({ version, status: 'SHADOW' });
  const market = new Market(() => clock.now);
  for (let i = 0; i < 520; i += 1) market.add(`${PREFIX}${version.slice(-12)}SH${i}`, i % 2 === 0);
  const shadowEngine = new AutonomousEngine({ prisma, logger, repoRoot, accessor: () => market, serverTradingMode: () => 'PAPER', maxSnapshotsPerMinute: 10_000, now: () => clock.now, accountFilter: () => false, shadowBundleVersion: () => version });
  for (const token of market.tokens.values()) token.detectedAt = clock.now - 31_000;
  await shadowEngine.tick();
  const blockers = (await request(app('ADMIN')).get(`/api/ml/autonomous/bundles/${version}/paper-approval`)).body.data.blockers;
  expect(blockers).toEqual([]);
  expect((await request(app('ADMIN')).post(`/api/ml/autonomous/bundles/${version}/paper-approval`).send({})).status).toBe(200);
}

beforeAll(async () => {
  assertLocalDatabase();
  if (!existsSync(python)) throw new Error('Python environment missing: run pnpm ml:setup');
  if (await prisma.mlTrainingJob.findUnique({ where: { activeKey: 'ACTIVE' } })) throw new Error('An active training job exists in the development database.');
  const user = await prisma.user.create({ data: { email } });
  ids.user = user.id;
  await prisma.botConfig.create({ data: { userId: user.id, tradingMode: 'PAPER', status: 'RUNNING' } });
  await prisma.riskConfig.create({ data: { userId: user.id, maxPositionPercent: 5, maxTotalExposurePercent: 25, maxConcurrentPositions: 4, dailyLossLimitPercent: 8, maxSlippagePercent: 3, minSignalScore: 0, cooldownSeconds: 0, riskPolicy: 'EXPLORATORY', lowRiskMax: 30, moderateRiskMax: 50, highRiskMax: 90, veryHighRiskMax: 100 } });
}, 120_000);

afterAll(async () => {
  const account = await prisma.mlAutonomousAccount.findUnique({ where: { userId: ids.user } });
  if (account) {
    await prisma.mlAutonomousFill.deleteMany({ where: { accountId: account.id } });
    await prisma.mlAutonomousPosition.deleteMany({ where: { accountId: account.id } });
    await prisma.mlAutonomousDecision.deleteMany({ where: { accountId: account.id } });
    await prisma.mlAutonomousAccount.delete({ where: { id: account.id } });
  }
  await prisma.mlAutonomousDecision.deleteMany({ where: { bundleVersion: { in: created.bundles } } });
  await prisma.mlAutonomousDecisionSnapshot.deleteMany({ where: { mint: { startsWith: PREFIX } } });
  await prisma.mlFeatureSnapshot.deleteMany({ where: { id: { startsWith: `${PREFIX}S` } } });
  await prisma.mlTrainingJob.deleteMany({ where: { id: { in: created.jobs } } });
  const bundles = await prisma.mlAutonomousModelBundle.findMany({ where: { version: { in: created.bundles } } });
  await prisma.mlAutonomousModelBundle.deleteMany({ where: { version: { in: created.bundles } } });
  const datasets = await prisma.mlDatasetVersion.findMany({ where: { version: { in: created.datasets } } });
  await prisma.mlAutonomousOutcome.deleteMany({ where: { snapshot: { mint: { startsWith: PREFIX } } } });
  await prisma.mlDatasetVersion.deleteMany({ where: { version: { in: created.datasets } } });
  for (const bundle of bundles) rmSync(path.dirname(path.join(repoRoot, bundle.artifactPath)), { recursive: true, force: true });
  for (const dataset of datasets) rmSync(path.dirname(path.join(repoRoot, dataset.filePath)), { recursive: true, force: true });
  await prisma.mlPaperSettings.deleteMany({ where: { userId: ids.user } });
  await prisma.riskConfig.deleteMany({ where: { userId: ids.user } });
  await prisma.botConfig.deleteMany({ where: { userId: ids.user } });
  await prisma.auditLog.deleteMany({ where: { userId: ids.user } });
  await prisma.user.delete({ where: { id: ids.user } }).catch(() => undefined);
}, 300_000);

describe('SolTrader 3.0 ML-only end to end', () => {
  const clock = { now: Date.now() };
  const market = new Market(() => clock.now);
  // 500 USD: positions near the 20 USD reference order the replayed training positions use (cost features match).
  const tradingEngine = () => new AutonomousEngine({ prisma, logger, repoRoot, accessor: () => market, serverTradingMode: () => 'PAPER', initialBalanceUsd: 500, maxSnapshotsPerMinute: 10_000, now: () => clock.now, accountFilter: (userId) => userId === ids.user, shadowBundleVersion: () => null });
  const state = { model1: '', model2: '', firstPosition: '', secondPosition: '' };
  const settings = async () => (await request(app('USER')).get('/api/settings/ml-paper')).body.data;
  const advance = async (engine: AutonomousEngine, ms: number) => {
    clock.now += ms;
    await engine.tick();
  };

  it('1-2. no model: DATA_COLLECTION, tokens are collected, nothing is bought', async () => {
    expect((await settings()).tradingState).toMatchObject({ state: 'DATA_COLLECTION', mayOpenEntries: false });
    market.add(`${PREFIX}L0`, true);
    for (const token of market.tokens.values()) token.detectedAt = clock.now - 31_000;
    await tradingEngine().tick();
    expect(await prisma.mlAutonomousDecisionSnapshot.count({ where: { mint: `${PREFIX}L0` } })).toBe(1);
    expect(await prisma.mlAutonomousDecision.count({ where: { userId: ids.user } })).toBe(0);
    expect(await prisma.mlAutonomousPosition.count({ where: { userId: ids.user } })).toBe(0);
  });

  it('3-6. history -> dataset -> web training job -> trained, validated, listed (not active)', async () => {
    await seedHistory();
    const readiness = (await request(app('USER')).get('/api/ml/autonomous/dataset-readiness')).body.data;
    expect(readiness.completedPaths).toBeGreaterThanOrEqual(CANDIDATES);
    expect(readiness.canTrain).toBe(true);
    const job = await trainViaWeb('E2E Autonomous ML v1');
    state.model1 = job.bundleVersion;
    const stages = job.log.map((entry: any) => entry.stage);
    for (const stage of ['PREPARING_DATASET', 'ENTRY_MODELS', 'EXIT_MODELS', 'POSITION_SIZING', 'VALIDATION', 'SAVING', 'REGISTERING', 'COMPLETED']) expect(stages).toContain(stage);
    const models = (await request(app('USER')).get('/api/ml/autonomous/models')).body.data.models;
    const listed = models.find((model: any) => model.version === state.model1);
    expect(listed).toMatchObject({ status: 'TRAINED', paperApproved: false, active: false });
    expect(listed.readiness).toBe('SHADOW_READY');
    const bundle = await prisma.mlAutonomousModelBundle.findUniqueOrThrow({ where: { version: state.model1 } });
    expect(createHash('sha256').update(readFileSync(path.join(repoRoot, bundle.artifactPath))).digest('hex')).toBe(bundle.artifactHash);
    expect((await settings()).tradingState.state).toBe('DATA_COLLECTION');
  }, 1_200_000);

  it('7. manual check, approval and selection (explicit steps; nothing automatic)', async () => {
    await checkAndApprove(state.model1, clock);
    expect((await settings()).tradingState.state).toBe('DATA_COLLECTION');
    expect((await request(app('USER')).put('/api/settings/ml-paper').send({ strategyMode: 'ML_AUTONOMOUS', autonomousBundleVersion: state.model1 })).status).toBe(403);
    const selected = await request(app('ADMIN')).put('/api/settings/ml-paper').send({ strategyMode: 'ML_AUTONOMOUS', autonomousBundleVersion: state.model1 });
    expect(selected.body.data.tradingState).toMatchObject({ state: 'ML_PAPER_ACTIVE', entryStrategy: 'ML_AUTONOMOUS', authorizedModelVersion: state.model1 });
  }, 300_000);

  it('8-11. Autonomous PAPER BUY -> HOLD while rising -> SELL when it turns -> settled in the own account', async () => {
    const engine = tradingEngine();
    const mint = `${PREFIX}T1`;
    market.add(mint, true);
    market.tokens.get(mint)!.detectedAt = clock.now - 31_000;
    await engine.tick();
    const [position] = await prisma.mlAutonomousPosition.findMany({ where: { userId: ids.user, mint } });
    expect(position).toMatchObject({ status: 'OPEN', bundleVersion: state.model1 });
    state.firstPosition = position.id;
    for (let s = 10; s <= 240; s += 10) {
      // The replayed training paths know a price one 10 s point late (bucket end): the live feed mirrors that.
      market.move(mint, multiple(true, s - 10));
      await advance(engine, 10_000);
    }
    const holds = await prisma.mlAutonomousDecision.findMany({ where: { positionId: position.id, action: 'HOLD' } });
    expect(holds.length).toBeGreaterThan(0);
    expect((await prisma.mlAutonomousPosition.findUniqueOrThrow({ where: { id: position.id } })).status).toBe('OPEN');
    for (let s = 250; s <= 1_200 && (await prisma.mlAutonomousPosition.findUniqueOrThrow({ where: { id: position.id } })).status === 'OPEN'; s += 10) {
      market.move(mint, multiple(true, s - 10));
      await advance(engine, 10_000);
    }
    const closed = await prisma.mlAutonomousPosition.findUniqueOrThrow({ where: { id: position.id } });
    expect(closed.status).toBe('CLOSED');
    expect(['MODEL_SELL', 'MODEL_PARTIAL_SELL']).toContain(closed.exitReason);
    const fills = await prisma.mlAutonomousFill.findMany({ where: { positionId: position.id } });
    const account = await prisma.mlAutonomousAccount.findUniqueOrThrow({ where: { userId: ids.user } });
    const buy = fills.find((fill) => fill.side === 'BUY')!;
    const sells = fills.filter((fill) => fill.side === 'SELL');
    const realized = sells.reduce((sum, fill) => sum + Number(fill.realizedPnlUsd), 0);
    expect(Number(closed.realizedPnlUsd)).toBeCloseTo(realized, 4);
    // Cash = initial - every BUY (notional + fee) + every SELL (proceeds - fee) of this account (other tokens may be held).
    const allFills = await prisma.mlAutonomousFill.findMany({ where: { accountId: account.id } });
    expect(Number(account.cashBalance)).toBeCloseTo(allFills.reduce((cash, fill) => cash + (fill.side === 'BUY' ? -1 : 1) * Number(fill.notionalUsd) - Number(fill.feeUsd), 500), 4);
    expect(Number(buy.notionalUsd)).toBeGreaterThan(0);
    expect(new Set(fills.map((fill) => fill.side === 'SELL' ? fill.decisionId : null)).size).toBe(sells.length + 1);
  }, 600_000);

  it('12-14. new data keeps coming; a second model trains while the first stays active', async () => {
    const before = await prisma.mlAutonomousDecisionSnapshot.count({ where: { mint: { startsWith: PREFIX } } });
    const engine = tradingEngine();
    const mint = `${PREFIX}T2`;
    market.add(mint, true);
    market.tokens.get(mint)!.detectedAt = clock.now - 31_000;
    await engine.tick();
    expect(await prisma.mlAutonomousDecisionSnapshot.count({ where: { mint: { startsWith: PREFIX } } })).toBeGreaterThan(before);
    const [open] = await prisma.mlAutonomousPosition.findMany({ where: { userId: ids.user, mint, status: 'OPEN' } });
    expect(open.bundleVersion).toBe(state.model1);
    state.secondPosition = open.id;
    const job = await trainViaWeb('E2E Autonomous ML v2');
    state.model2 = job.bundleVersion;
    expect(state.model2).not.toBe(state.model1);
    expect((await settings())).toMatchObject({ autonomousBundleVersion: state.model1, tradingState: { state: 'ML_PAPER_ACTIVE' } });
    const first = await prisma.mlAutonomousModelBundle.findUniqueOrThrow({ where: { version: state.model1 } });
    expect(first.paperApproved).toBe(true);
  }, 1_200_000);

  it('15-16. manual switch: new entries only by the new model; the open position stays with (and is managed by) the old one', async () => {
    await checkAndApprove(state.model2, clock);
    await request(app('ADMIN')).put('/api/settings/ml-paper').send({ strategyMode: 'ML_AUTONOMOUS', autonomousBundleVersion: state.model2 });
    expect((await settings()).autonomousBundleVersion).toBe(state.model2);
    const engine = tradingEngine();
    const mint = `${PREFIX}T3`;
    market.add(mint, true);
    market.tokens.get(mint)!.detectedAt = clock.now - 31_000;
    await engine.tick();
    const [third] = await prisma.mlAutonomousPosition.findMany({ where: { userId: ids.user, mint } });
    expect(third.bundleVersion).toBe(state.model2);
    // The position opened with model 1 is still evaluated with model 1 (own bundle), never left unprotected.
    market.move(`${PREFIX}T2`, 1.1);
    await advance(engine, 11_000);
    const oldDecisions = await prisma.mlAutonomousDecision.findMany({ where: { positionId: state.secondPosition } });
    expect(oldDecisions.length).toBeGreaterThan(0);
    expect(oldDecisions.every((decision) => decision.bundleVersion === state.model1)).toBe(true);
  }, 600_000);

  it('17. model failure is fail-closed: no BUY with a broken model; its open position is still protected', async () => {
    const engine = tradingEngine();
    const open = `${PREFIX}T4`;
    market.add(open, true);
    market.tokens.get(open)!.detectedAt = clock.now - 31_000;
    await engine.tick();
    const [position] = await prisma.mlAutonomousPosition.findMany({ where: { userId: ids.user, mint: open, status: 'OPEN' } });
    expect(position.bundleVersion).toBe(state.model2);
    // Corrupt the active model's artifact: the checksum no longer matches, a fresh engine (= worker restart) refuses it.
    const row = await prisma.mlAutonomousModelBundle.findUniqueOrThrow({ where: { version: state.model2 } });
    const file = path.join(repoRoot, row.artifactPath);
    writeFileSync(file, readFileSync(file, 'utf8').replace('"entryReturn"', '"entryReturnBroken"'));
    const restarted = tradingEngine();
    const mint = `${PREFIX}T5`;
    market.add(mint, true);
    market.tokens.get(mint)!.detectedAt = clock.now - 31_000;
    await restarted.tick();
    expect(await prisma.mlAutonomousPosition.count({ where: { userId: ids.user, mint } })).toBe(0);
    expect((await prisma.mlAutonomousDecision.findFirst({ where: { userId: ids.user, mint } }))?.action).toBe('ERROR');
    // No model decision for the open position any more (no DEFAULT exit rules either): the mandatory protection closes it.
    market.move(open, 0.5);
    await advance(restarted, 11_000);
    expect(await prisma.mlAutonomousPosition.findUniqueOrThrow({ where: { id: position.id } })).toMatchObject({ status: 'CLOSED', exitReason: 'HARD_MAX_LOSS' });
    expect(await prisma.mlAutonomousDecision.count({ where: { positionId: position.id, action: { in: ['HOLD', 'SELL', 'PARTIAL_SELL'] }, decidedAt: { gt: new Date(clock.now - 11_000) } } })).toBe(0);
    expect(await prisma.trade.count({ where: { userId: ids.user } })).toBe(0);
  }, 300_000);
});
