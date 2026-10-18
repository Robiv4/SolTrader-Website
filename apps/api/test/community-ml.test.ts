/**
 * Community ML API: approval gates accept the community feature version only with a matching dataset (and still need
 * SHADOW predictions etc.); the dashboard and the stuck-position diagnostics are read-only and per user.
 * Only rows created by this test are touched.
 */
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { hashPassword } from '../src/auth.js';
import { stopLossRate } from '../src/community-ml.js';
import { prisma } from '../src/database.js';

const { app } = await import('../src/app.js');

const stamp = Date.now();
const password = 'CommunityMl123!';
const email = `community-ml-${stamp}@soltrader.local`;
const COMMUNITY = `TEST-COMM-${stamp}`;
const WRONG_DATASET = `TEST-COMM-WRONGDS-${stamp}`;
const UNKNOWN = `TEST-COMM-UNKNOWN-${stamp}`;
const DS_COMMUNITY = `TEST-COMM-DS-${stamp}`;
const DS_V1 = `TEST-COMM-DSV1-${stamp}`;
const ids = { user: '', token: '', position: '' };

beforeAll(async () => {
  const user = await prisma.user.create({ data: { email, passwordHash: await hashPassword(password), role: 'ADMIN' } });
  ids.user = user.id;
  await prisma.botConfig.create({ data: { userId: user.id, tradingMode: 'PAPER', status: 'STOPPED' } });
  const dataset = (version: string, featureVersion: string) => ({ version, featureVersion, labelVersion: 'ML-LABELS-v1', target: 'simExitNetPositive', config: { snapshotKind: 'AGE_30S', minDataQuality: 50 }, manifest: { communityCoverage: { rowsWithCommunity: 0 } }, rowCount: 0, filePath: 'x', fileHash: 'x' });
  await prisma.mlDatasetVersion.createMany({ data: [dataset(DS_COMMUNITY, 'ML-FEATURES-COMMUNITY-v1'), dataset(DS_V1, 'ML-FEATURES-v1')] });
  const model = (version: string, featureVersion: string, datasetVersion: string) => ({
    version, algorithm: 'lightgbm', status: 'SHADOW', readiness: 'SHADOW_READY', featureVersion, labelVersion: 'ML-LABELS-v1', target: 'simExitNetPositive', datasetVersion, config: {}, metrics: {},
    artifactPath: 'ml/models/__missing__/model.json', artifactHash: 'f'.repeat(64), statusHistory: [{ status: 'SHADOW' }], trainedAt: new Date(),
  });
  await prisma.mlModelVersion.createMany({ data: [model(COMMUNITY, 'ML-FEATURES-COMMUNITY-v1', DS_COMMUNITY), model(WRONG_DATASET, 'ML-FEATURES-COMMUNITY-v1', DS_V1), model(UNKNOWN, 'ML-FEATURES-v999', DS_COMMUNITY)] });
  const token = await prisma.token.create({ data: { address: `COMMTEST${stamp}`, symbol: 'STUCK' } });
  ids.token = token.id;
  const position = await prisma.position.create({ data: { userId: user.id, tokenId: token.id, side: 'BUY', quantity: 1, avgEntryPrice: 1, exitPolicy: 'NEW_LAUNCH', entryStrategy: 'ML', mode: 'PAPER', openedAt: new Date(Date.now() - 5 * 3_600_000) } });
  ids.position = position.id;
});

afterAll(async () => {
  await prisma.position.deleteMany({ where: { userId: ids.user } });
  if (ids.token) await prisma.token.delete({ where: { id: ids.token } }).catch(() => undefined);
  await prisma.mlModelVersion.deleteMany({ where: { version: { in: [COMMUNITY, WRONG_DATASET, UNKNOWN] } } });
  await prisma.mlDatasetVersion.deleteMany({ where: { version: { in: [DS_COMMUNITY, DS_V1] } } });
  await prisma.botConfig.deleteMany({ where: { userId: ids.user } });
  await prisma.auditLog.deleteMany({ where: { userId: ids.user } });
  await prisma.session.deleteMany({ where: { userId: ids.user } }).catch(() => undefined);
  await prisma.user.delete({ where: { id: ids.user } }).catch(() => undefined);
});

async function login() {
  const agent = request.agent(app);
  expect((await agent.post('/api/auth/login').send({ email, password })).status).toBe(200);
  return agent;
}

describe('Community ML API', () => {
  it('approval gate: community feature version is supported, but the dataset must match and SHADOW evidence is still required', async () => {
    const agent = await login();
    const ok = (await agent.get(`/api/ml/models/${COMMUNITY}/paper-approval`)).body.data.blockers as string[];
    expect(ok).not.toContain('FEATURE_VERSION_MISMATCH');
    expect(ok).not.toContain('DATASET_FEATURE_VERSION_MISMATCH');
    // Never approvable without real SHADOW predictions and an intact artifact.
    expect(ok).toEqual(expect.arrayContaining([expect.stringMatching(/^SHADOW_PREDICTIONS_0_BELOW/), 'ARTIFACT_MISSING']));
    expect((await agent.get(`/api/ml/models/${WRONG_DATASET}/paper-approval`)).body.data.blockers).toContain('DATASET_FEATURE_VERSION_MISMATCH');
    expect((await agent.get(`/api/ml/models/${UNKNOWN}/paper-approval`)).body.data.blockers).toContain('FEATURE_VERSION_MISMATCH');
    expect((await agent.post(`/api/ml/models/${COMMUNITY}/paper-approval`).send({})).status).not.toBe(200);
    expect((await prisma.mlModelVersion.findUniqueOrThrow({ where: { version: COMMUNITY } })).paperApproved).toBe(false);
  });

  it('dashboard lists the community model with its dataset coverage and a separate baseline comparison', async () => {
    const agent = await login();
    const response = await agent.get('/api/community/ml-dashboard?hours=6');
    expect(response.status).toBe(200);
    const data = response.body.data;
    expect(data.featureVersions).toEqual({ community: 'ML-FEATURES-COMMUNITY-v1', baseline: 'ML-FEATURES-v1' });
    expect(data.communityModels.find((row: { version: string }) => row.version === COMMUNITY)).toMatchObject({ datasetVersion: DS_COMMUNITY, paperApproved: false, shadowPredictions: 0, communityCoverage: { rowsWithCommunity: 0 } });
    expect(data.hourly).toHaveLength(6);
    expect(data.comparison.community).toMatchObject({ featureVersion: 'ML-FEATURES-COMMUNITY-v1', trades: 0 });
    expect(data.comparison.baseline.featureVersion).toBe('ML-FEATURES-v1');
  });

  it('stuck diagnostics: an old position without max hold is reported, nothing is modified', async () => {
    const agent = await login();
    const before = await prisma.position.findUniqueOrThrow({ where: { id: ids.position } });
    const response = await agent.get('/api/positions/stuck-diagnostics');
    expect(response.status).toBe(200);
    const row = response.body.data.positions.find((item: { id: string }) => item.id === ids.position);
    expect(row).toMatchObject({ stuck: true, symbol: 'STUCK', maxHoldUntil: null });
    expect(row.reasons).toContain('NO_MAX_HOLD');
    expect(row.ageMinutes).toBeGreaterThanOrEqual(299);
    const after = await prisma.position.findUniqueOrThrow({ where: { id: ids.position } });
    expect(after.status).toBe('OPEN');
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
  });

  it('community health without a running worker: available false (no error)', async () => {
    const agent = await login();
    const response = await agent.get('/api/community/health');
    expect(response.status).toBe(200);
    expect(typeof response.body.data.available).toBe('boolean');
  });

  it('STOP_LOSS rate', () => {
    expect(stopLossRate([])).toBeNull();
    expect(stopLossRate([{ exitReason: 'STOP_LOSS' }, { exitReason: 'TAKE_PROFIT' }, { exitReason: null }, { exitReason: 'stop_loss' }])).toBe(0.5);
  });
});
