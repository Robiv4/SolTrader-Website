/**
 * ML PAPER strategy API (tests 2, 9, 11): separate PAPER approval (admin, SHADOW-tested, intact artifact), admin-only
 * enabling with an approved model in PAPER mode, revocation without silent fallback, LIVE refused while ML is selected,
 * comparison analytics separated by strategy. Only rows created by this test are touched.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { hashPassword } from '../src/auth.js';
import { prisma } from '../src/database.js';

const { app } = await import('../src/app.js');

const stamp = Date.now();
const password = 'MlPaperPass123!';
const adminEmail = `ml-paper-admin-${stamp}@soltrader.local`;
const userEmail = `ml-paper-user-${stamp}@soltrader.local`;
const READY = `TEST-PAPER-READY-${stamp}`;
const RESEARCH = `TEST-PAPER-RESEARCH-${stamp}`;
const DATASET = `TEST-PAPER-DS-${stamp}`;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const artifactDir = path.join(repoRoot, 'ml', 'models', `__test-${stamp}`);
const ids: { admin: string; user: string; token: string } = { admin: '', user: '', token: '' };

async function login(email: string) {
  const agent = request.agent(app);
  expect((await agent.post('/api/auth/login').send({ email, password })).status).toBe(200);
  return agent;
}

beforeAll(async () => {
  const admin = await prisma.user.create({ data: { email: adminEmail, passwordHash: await hashPassword(password), role: 'ADMIN' } });
  const user = await prisma.user.create({ data: { email: userEmail, passwordHash: await hashPassword(password), role: 'USER' } });
  ids.admin = admin.id;
  ids.user = user.id;
  for (const id of [admin.id, user.id]) await prisma.botConfig.create({ data: { userId: id, tradingMode: 'PAPER', status: 'STOPPED' } });
  mkdirSync(artifactDir, { recursive: true });
  const content = JSON.stringify({ format: 'soltrader-ml-model-v1', modelVersion: READY });
  writeFileSync(path.join(artifactDir, 'model.json'), content);
  const hash = createHash('sha256').update(content).digest('hex');
  const artifactPath = path.relative(repoRoot, path.join(artifactDir, 'model.json')).replace(/\\/g, '/');
  await prisma.mlDatasetVersion.create({ data: { version: DATASET, featureVersion: 'ML-FEATURES-v1', labelVersion: 'ML-LABELS-v1', target: 'plus20BeforeMinus10_30m', config: { snapshotKind: 'AGE_30S', minDataQuality: 50 }, manifest: {}, rowCount: 0, filePath: 'x', fileHash: 'x' } });
  const metrics = { metrics: { test: { rocAuc: 0.66, prAuc: 0.31, precision: 0.4, recall: 0.3, brier: 0.18, n: 900 } }, walkForwardAucStd: 0.03, overfittingRisk: false };
  const common = { algorithm: 'lightgbm', featureVersion: 'ML-FEATURES-v1', labelVersion: 'ML-LABELS-v1', target: 'plus20BeforeMinus10_30m', datasetVersion: DATASET, config: {}, metrics, artifactPath, artifactHash: hash, trainedAt: new Date() };
  await prisma.mlModelVersion.create({ data: { ...common, version: READY, status: 'SHADOW', readiness: 'SHADOW_READY', statusHistory: [{ status: 'TRAINED' }, { status: 'VALIDATED' }, { status: 'SHADOW' }] } });
  // Research model: never in SHADOW, and its stored hash does not match the file (corrupt / modified artifact).
  await prisma.mlModelVersion.create({ data: { ...common, version: RESEARCH, status: 'VALIDATED', readiness: 'RESEARCH_ONLY', artifactHash: 'f'.repeat(64), statusHistory: [{ status: 'TRAINED' }, { status: 'VALIDATED' }] } });
  // SHADOW test history of the ready model: 100 stored shadow predictions.
  await prisma.mlFeatureSnapshot.createMany({ data: Array.from({ length: 100 }, (_, index) => ({
    id: `mlpaper-${stamp}-${index}`, candidateId: `mlpaper-cand-${stamp}-${index}`, mint: `MLPAPER${stamp}${index}`, source: 'PUMP_FUN', kind: 'AGE_30S', snapshotAt: new Date(), detectedAt: new Date(),
    featureVersion: 'ML-FEATURES-v1', features: {}, observedAt: {}, dataQuality: 80, validForTraining: false, invalidReasons: ['TEST'], decision: 'WATCH', decisionContext: {},
  })) });
  await prisma.mlPrediction.createMany({ data: Array.from({ length: 100 }, (_, index) => ({ snapshotId: `mlpaper-${stamp}-${index}`, modelVersion: READY, mint: `MLPAPER${stamp}${index}`, probability: 0.5, calibrated: true, mlEntryScore: 50, predictedClass: 'ML_SKIP', dataQuality: 80, latencyMs: 1 })) });
});

afterAll(async () => {
  rmSync(artifactDir, { recursive: true, force: true });
  await prisma.mlPrediction.deleteMany({ where: { modelVersion: { in: [READY, RESEARCH] } } });
  await prisma.mlFeatureSnapshot.deleteMany({ where: { id: { startsWith: `mlpaper-${stamp}-` } } });
  await prisma.mlModelVersion.deleteMany({ where: { version: { in: [READY, RESEARCH] } } });
  await prisma.mlDatasetVersion.deleteMany({ where: { version: DATASET } });
  for (const id of [ids.admin, ids.user].filter(Boolean)) {
    await prisma.trade.deleteMany({ where: { userId: id } });
    await prisma.mlPaperSettings.deleteMany({ where: { userId: id } });
    await prisma.botConfig.deleteMany({ where: { userId: id } });
    await prisma.riskConfig.deleteMany({ where: { userId: id } });
    await prisma.notificationConfig.deleteMany({ where: { userId: id } });
    await prisma.auditLog.deleteMany({ where: { userId: id } });
    await prisma.session.deleteMany({ where: { userId: id } }).catch(() => undefined);
    await prisma.user.delete({ where: { id } }).catch(() => undefined);
  }
  if (ids.token) await prisma.token.delete({ where: { id: ids.token } }).catch(() => undefined);
});

describe('ML PAPER strategy API', () => {
  it('2. default is the rule-based strategy; ML cannot be enabled without admin rights and an approved model', async () => {
    const user = await login(userEmail);
    const view = await user.get('/api/settings/ml-paper');
    expect(view.status).toBe(200);
    expect(view.body.data).toMatchObject({ strategyMode: 'DEFAULT', canEnable: false, liveTrading: 'DISABLED' });
    expect(view.body.data.enableBlockers).toContain('ADMIN_REQUIRED');
    expect((await user.put('/api/settings/ml-paper').send({ strategyMode: 'ML', modelVersion: READY })).status).toBe(403);
    expect((await user.post(`/api/ml/models/${READY}/paper-approval`).send({})).status).toBe(403);

    const admin = await login(adminEmail);
    // SHADOW_READY alone grants nothing: the model is not PAPER-approved yet.
    expect((await admin.put('/api/settings/ml-paper').send({ strategyMode: 'ML', modelVersion: READY })).status).toBe(409);
    expect((await prisma.mlPaperSettings.findUnique({ where: { userId: ids.admin } }))?.strategyMode ?? 'DEFAULT').toBe('DEFAULT');
  });

  it('2. PAPER approval only for a SHADOW-tested, SHADOW_READY model with an intact artifact', async () => {
    const admin = await login(adminEmail);
    const research = await admin.post(`/api/ml/models/${RESEARCH}/paper-approval`).send({});
    expect(research.status).toBe(409);
    expect(research.body.data.blockers).toEqual(expect.arrayContaining(['READINESS_RESEARCH_ONLY', 'NEVER_RUN_IN_SHADOW', expect.stringMatching(/^SHADOW_PREDICTIONS_0_BELOW/), 'ARTIFACT_HASH_MISMATCH']));
    const check = await admin.get(`/api/ml/models/${READY}/paper-approval`);
    expect(check.body.data.blockers).toEqual([]);
    const approved = await admin.post(`/api/ml/models/${READY}/paper-approval`).send({});
    expect(approved.status).toBe(200);
    expect(await prisma.mlModelVersion.findUniqueOrThrow({ where: { version: READY } })).toMatchObject({ paperApproved: true, paperApprovedBy: adminEmail, status: 'SHADOW' });
  });

  it('enable with an approved model (threshold limits enforced); LIVE is refused while ML is selected (11)', async () => {
    const admin = await login(adminEmail);
    expect((await admin.put('/api/settings/ml-paper').send({ strategyMode: 'ML', modelVersion: READY, buyThreshold: 0.95 })).status).toBe(400);
    expect((await admin.put('/api/settings/ml-paper').send({ strategyMode: 'ML', modelVersion: READY, buyThreshold: 0.75, decisionWindowSeconds: 12 })).status).toBe(200);
    const view = await admin.get('/api/settings/ml-paper');
    expect(view.body.data).toMatchObject({ strategyMode: 'ML', modelVersion: READY, buyThreshold: 0.75, decisionWindowSeconds: 12, selectedModel: { version: READY, usable: true, snapshotKind: 'AGE_30S' } });
    expect(view.body.data.selectedModel.metrics.testRocAuc).toBe(0.66);

    const live = await admin.post('/api/safety/live/enable').send({ confirmLiveTrading: true });
    expect(live.status).toBe(409);
    expect(await prisma.botConfig.findUniqueOrThrow({ where: { userId: ids.admin } })).toMatchObject({ tradingMode: 'PAPER', isLiveEnabled: false });

    // ML PAPER refuses any non-PAPER account state.
    await prisma.botConfig.update({ where: { userId: ids.admin }, data: { tradingMode: 'SEMI_AUTO' } });
    expect((await admin.put('/api/settings/ml-paper').send({ strategyMode: 'ML', modelVersion: READY, buyThreshold: 0.8 })).status).toBe(409);
    await prisma.botConfig.update({ where: { userId: ids.admin }, data: { tradingMode: 'PAPER' } });
  });

  it('there is no setting that switches the fraud / honeypot protection off', async () => {
    const admin = await login(adminEmail);
    for (const body of [{ tokenSafetyChecksEnabled: false }, { tokenSafetyChecksEnabled: false, acknowledgeExperimentalMode: true }, { skipFraudProtection: true }]) {
      expect((await admin.put('/api/settings/ml-paper').send({ strategyMode: 'ML', modelVersion: READY, ...body })).status).toBe(400);
    }
    const view = await admin.get('/api/settings/ml-paper');
    expect(view.body.data).not.toHaveProperty('tokenSafetyChecksEnabled');
  });

  it('9. revoking the approval stops ML entries without switching the user to buying with the rule strategy', async () => {
    const admin = await login(adminEmail);
    expect((await admin.delete(`/api/ml/models/${READY}/paper-approval`)).status).toBe(200);
    const view = await admin.get('/api/settings/ml-paper');
    expect(view.body.data).toMatchObject({ strategyMode: 'ML', selectedModel: { usable: false } });
    // Back to the rule-based strategy: an explicit owner action, always allowed (also for non-admins).
    expect((await admin.put('/api/settings/ml-paper').send({ strategyMode: 'DEFAULT' })).status).toBe(200);
    expect((await prisma.mlPaperSettings.findUniqueOrThrow({ where: { userId: ids.admin } })).strategyMode).toBe('DEFAULT');
    const user = await login(userEmail);
    expect((await user.put('/api/settings/ml-paper').send({ strategyMode: 'DEFAULT' })).status).toBe(200);

    // A retired model loses its PAPER approval at once.
    expect((await admin.post(`/api/ml/models/${READY}/paper-approval`).send({})).status).toBe(200);
    expect((await admin.post(`/api/ml/models/${READY}/status`).send({ status: 'RETIRED' })).status).toBe(200);
    expect(await prisma.mlModelVersion.findUniqueOrThrow({ where: { version: READY } })).toMatchObject({ status: 'RETIRED', paperApproved: false });
  });

  it('comparison analytics: DEFAULT and ML PAPER results are reported separately (real closed trades only)', async () => {
    const token = await prisma.token.create({ data: { address: `MLPAPERTOKEN${stamp}`.padEnd(44, '1'), symbol: 'MLPT' } });
    ids.token = token.id;
    const trade = (netPnl: number, entryStrategy: string, mlModelVersion: string | null) => prisma.trade.create({ data: {
      userId: ids.admin, tokenId: token.id, side: 'BUY', tokenAddress: token.address, symbol: 'MLPT', entry: 1, size: 10, quantity: 10, fees: 0.06, slippage: 0.02, netPnl,
      decisionSource: 'NEW_LAUNCH', entryStrategy, mlModelVersion, mode: 'PAPER', status: 'CLOSED', entryAt: new Date(Date.now() - 600_000), exitAt: new Date(),
    } });
    await trade(5, 'DEFAULT', null);
    await trade(-2, 'ML', READY);
    await trade(3, 'ML', READY);
    const admin = await login(adminEmail);
    const response = await admin.get('/api/ml/paper');
    expect(response.status).toBe(200);
    expect(response.body.data.strategies.DEFAULT).toMatchObject({ trades: 1, netPnl: 5 });
    expect(response.body.data.strategies.ML).toMatchObject({ trades: 2, netPnl: 1, wins: 1, profitFactor: 1.5, maxDrawdownUsd: 2 });
    // ML strategy = ML entries + the common rule-based exit; SHADOW predictions are reported separately from PAPER results.
    expect(response.body.data.exitMode).toBe('RULE_BASED');
    // ML BUY funnel: signals, fraud / honeypot blocks, market / risk blocks and opened positions are counted separately.
    expect(response.body.data.mlFunnel).toMatchObject({ mlBuy: expect.any(Number), blockedByTokenSecurity: expect.any(Number), honeypotBlocked: expect.any(Number), positionsOpened: expect.any(Number) });
    expect(Array.isArray(response.body.data.shadowPredictions)).toBe(true);
    expect(response.body.data.byModel).toEqual([expect.objectContaining({ modelVersion: READY, trades: 2 })]);
    expect(response.body.data.training.label).toMatch(/SHADOW TRAINING DATA/);
  });
});
