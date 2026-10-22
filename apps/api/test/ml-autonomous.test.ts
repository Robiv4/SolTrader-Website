/* eslint-disable @typescript-eslint/no-explicit-any -- minimal request user stub */
/**
 * Autonomous ML API against the LOCAL development database (throw-away rows, removed afterwards; never production):
 * promotion one step at a time, PAPER approval gates (SHADOW, SHADOW_READY, SHADOW decisions, artifact hash), no
 * automatic selection, ML_AUTONOMOUS selection needs an approved bundle + PAPER, comparison keeps ledgers apart.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { prisma } from '../src/database.js';
import { createMlAutonomousRouter, MIN_SHADOW_DECISIONS_FOR_APPROVAL } from '../src/ml-autonomous.js';
import { createMlPaperRouter } from '../src/ml-paper.js';

const stamp = Date.now();
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const dir = path.join(repoRoot, 'ml', 'autonomous-models', `__api-test-${stamp}`);
const VERSION = `TEST-API-AUTO-${stamp}`;
const ids = { user: '' };

function app(role: 'ADMIN' | 'USER') {
  const server = express();
  server.use(express.json());
  server.use((req: any, _res, next) => {
    req.user = { id: ids.user, email: `auto-api-${stamp}@soltrader.local`, role };
    next();
  });
  const common = { prisma, logger: { error: () => undefined }, readJson: async () => null, stepUp: (async () => true) as any, logAuditEvent: async () => undefined };
  server.use('/api', createMlAutonomousRouter(common));
  server.use('/api', createMlPaperRouter({ ...common, serverTradingMode: () => 'PAPER', mlOnly: () => true }));
  return server;
}

beforeAll(async () => {
  const user = await prisma.user.create({ data: { email: `auto-api-${stamp}@soltrader.local` } });
  ids.user = user.id;
  await prisma.botConfig.create({ data: { userId: user.id, tradingMode: 'PAPER', status: 'STOPPED' } });
  mkdirSync(path.join(dir, VERSION), { recursive: true });
  const content = JSON.stringify({ format: 'soltrader-autonomous-bundle-v1', bundleVersion: VERSION });
  writeFileSync(path.join(dir, VERSION, 'bundle.json'), content);
  await prisma.mlAutonomousModelBundle.create({ data: {
    version: VERSION, status: 'TRAINED', readiness: 'SHADOW_READY', featureVersion: 'ML-FEATURES-AUTONOMOUS-v1', labelVersion: 'AUTO-LABELS-v1', datasetVersion: 'TEST',
    artifactPath: path.relative(repoRoot, path.join(dir, VERSION, 'bundle.json')).replace(/\\/g, '/'), artifactHash: createHash('sha256').update(content).digest('hex'),
    policy: {}, metrics: { entry: { backtest: { policy: { trades: 0 } } } }, statusHistory: [{ status: 'TRAINED' }], trainedAt: new Date(),
  } });
});

afterAll(async () => {
  await prisma.mlAutonomousDecision.deleteMany({ where: { bundleVersion: VERSION } });
  await prisma.mlAutonomousModelBundle.deleteMany({ where: { version: VERSION } });
  await prisma.mlPaperSettings.deleteMany({ where: { userId: ids.user } });
  await prisma.botConfig.deleteMany({ where: { userId: ids.user } });
  await prisma.user.delete({ where: { id: ids.user } }).catch(() => undefined);
  rmSync(dir, { recursive: true, force: true });
});

describe('Autonomous ML API', () => {
  it('a TRAINED bundle cannot be selected or approved; promotion is one explicit step at a time (admin only)', async () => {
    expect((await request(app('ADMIN')).put('/api/settings/ml-paper').send({ strategyMode: 'ML_AUTONOMOUS', autonomousBundleVersion: VERSION })).status).toBe(409);
    expect((await request(app('ADMIN')).post(`/api/ml/autonomous/bundles/${VERSION}/paper-approval`).send({})).status).toBe(409);
    expect((await request(app('USER')).post(`/api/ml/autonomous/bundles/${VERSION}/status`).send({ status: 'VALIDATED' })).status).toBe(403);
    expect((await request(app('ADMIN')).post(`/api/ml/autonomous/bundles/${VERSION}/status`).send({ status: 'SHADOW' })).status).toBe(409);
    expect((await request(app('ADMIN')).post(`/api/ml/autonomous/bundles/${VERSION}/status`).send({ status: 'VALIDATED' })).status).toBe(200);
    expect((await request(app('ADMIN')).post(`/api/ml/autonomous/bundles/${VERSION}/status`).send({ status: 'SHADOW' })).status).toBe(200);
  });

  it('approval gates: SHADOW decisions required; with them (and an intact artifact) approval works; nothing is selected by it', async () => {
    const before = await request(app('ADMIN')).get(`/api/ml/autonomous/bundles/${VERSION}/paper-approval`);
    expect(before.body.data.blockers).toEqual([`SHADOW_DECISIONS_0_BELOW_${MIN_SHADOW_DECISIONS_FOR_APPROVAL}`]);
    await prisma.mlAutonomousDecision.createMany({ data: Array.from({ length: MIN_SHADOW_DECISIONS_FOR_APPROVAL }, (_, i) => ({ mode: 'SHADOW', bundleVersion: VERSION, mint: `M${i}`, kind: 'ENTRY', action: 'SKIP', featureHash: 'x', decidedAt: new Date(), executionStatus: 'SHADOW', idempotencyKey: `api-test-${stamp}-${i}` })) });
    const approved = await request(app('ADMIN')).post(`/api/ml/autonomous/bundles/${VERSION}/paper-approval`).send({});
    expect(approved.status).toBe(200);
    expect(await prisma.mlPaperSettings.findUnique({ where: { userId: ids.user } })).toBeNull();
  });

  it('a modified artifact blocks approval (checksum)', async () => {
    writeFileSync(path.join(dir, VERSION, 'bundle.json'), '{"tampered":true}');
    const check = await request(app('ADMIN')).get(`/api/ml/autonomous/bundles/${VERSION}/paper-approval`);
    expect(check.body.data.blockers).toContain('ARTIFACT_HASH_MISMATCH');
  });

  it('selection: admin + approved bundle + PAPER -> ML_AUTONOMOUS / ML_PAPER_ACTIVE; a USER cannot; revoke -> MODEL_UNAVAILABLE', async () => {
    expect((await request(app('USER')).put('/api/settings/ml-paper').send({ strategyMode: 'ML_AUTONOMOUS', autonomousBundleVersion: VERSION })).status).toBe(403);
    const selected = await request(app('ADMIN')).put('/api/settings/ml-paper').send({ strategyMode: 'ML_AUTONOMOUS', autonomousBundleVersion: VERSION });
    expect(selected.status).toBe(200);
    expect(selected.body.data).toMatchObject({ strategyMode: 'ML_AUTONOMOUS', autonomousBundleVersion: VERSION, tradingState: { state: 'ML_PAPER_ACTIVE', entryStrategy: 'ML_AUTONOMOUS' } });
    expect((await request(app('ADMIN')).delete(`/api/ml/autonomous/bundles/${VERSION}/paper-approval`)).body.data).toMatchObject({ paperApproved: false, usersOnBundle: 1 });
    const after = await request(app('USER')).get('/api/settings/ml-paper');
    expect(after.body.data.tradingState).toMatchObject({ state: 'MODEL_UNAVAILABLE', mayOpenEntries: false });
  });

  it('overview + comparison: each strategy from its own ledger; PAPER only', async () => {
    const overview = await request(app('USER')).get('/api/ml/autonomous/overview');
    expect(overview.status).toBe(200);
    expect(overview.body.data).toMatchObject({ mode: 'PAPER', liveTrading: 'DISABLED' });
    expect(overview.body.data.bundles.find((bundle: any) => bundle.version === VERSION)).toMatchObject({ status: 'SHADOW', shadowDecisions: MIN_SHADOW_DECISIONS_FOR_APPROVAL });
    const comparison = await request(app('USER')).get('/api/ml/autonomous/comparison?days=30');
    expect(Object.keys(comparison.body.data.strategies)).toEqual(['DEFAULT', 'ML_V3', 'ML_COMMUNITY', 'ML_AUTONOMOUS']);
    for (const stats of Object.values(comparison.body.data.strategies) as any[]) expect(stats).toHaveProperty('ledger');
  });
});
