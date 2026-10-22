/* eslint-disable @typescript-eslint/no-explicit-any -- minimal request user stub */
/**
 * Simplified ML API against the LOCAL development database (throw-away rows, removed afterwards; never production):
 * admin-only training start / cancel, strict validation (no paths / CLI arguments), one active job (double click ->
 * the same job), readiness without enough data, models with suitability, "Modell ellenőrzése" only for SHADOW_READY
 * models, activation needs an approved model (USER forbidden), "Nincs modell" = data collection, no DEFAULT / LIVE.
 */
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { prisma } from '../src/database.js';
import { createMlPaperRouter } from '../src/ml-paper.js';
import { createMlTrainingRouter } from '../src/ml-training.js';

const stamp = Date.now();
const ids = { user: '' };
const audits: string[] = [];
const RESEARCH = `TEST-TRAIN-RESEARCH-${stamp}`;
const READY = `TEST-TRAIN-READY-${stamp}`;

function app(role: 'ADMIN' | 'USER', mlOnly = false) {
  const server = express();
  server.use(express.json());
  server.use((req: any, _res, next) => {
    req.user = { id: ids.user, email: `train-api-${stamp}@soltrader.local`, role };
    next();
  });
  const common = { prisma, logger: { error: () => undefined }, readJson: async () => null, stepUp: (async () => true) as any, logAuditEvent: async (action: string) => { audits.push(action); } };
  server.use('/api', createMlTrainingRouter(common));
  server.use('/api', createMlPaperRouter({ ...common, serverTradingMode: () => 'PAPER', mlOnly: () => mlOnly }));
  return server;
}

const bundle = (version: string, readiness: string) => ({
  version, status: 'TRAINED', readiness, featureVersion: 'ML-FEATURES-AUTONOMOUS-v1', labelVersion: 'AUTO-LABELS-v1', datasetVersion: 'TEST', artifactPath: 'ml/autonomous-models/x/bundle.json', artifactHash: 'x',
  policy: {}, metrics: { entry: { rows: { train: 1000, test: 300 }, backtest: { policy: { trades: 40, netPnl: 12.5, profitFactor: 1.4, maxDrawdown: 3 } } } }, statusHistory: [{ status: 'TRAINED' }], trainedAt: new Date(),
});

beforeAll(async () => {
  // The single-active-job slot must be free for this run (nothing else trains on the development database).
  if (await prisma.mlTrainingJob.findUnique({ where: { activeKey: 'ACTIVE' } })) throw new Error('An active training job exists in the development database; finish or cancel it before running this test.');
  const user = await prisma.user.create({ data: { email: `train-api-${stamp}@soltrader.local` } });
  ids.user = user.id;
  await prisma.botConfig.create({ data: { userId: user.id, tradingMode: 'PAPER', status: 'STOPPED' } });
  await prisma.mlAutonomousModelBundle.createMany({ data: [bundle(RESEARCH, 'RESEARCH_ONLY'), bundle(READY, 'SHADOW_READY')] });
});

afterAll(async () => {
  await prisma.mlTrainingJob.deleteMany({ where: { requestedBy: `train-api-${stamp}@soltrader.local` } });
  await prisma.mlAutonomousModelBundle.deleteMany({ where: { version: { in: [RESEARCH, READY] } } });
  await prisma.mlPaperSettings.deleteMany({ where: { userId: ids.user } });
  await prisma.botConfig.deleteMany({ where: { userId: ids.user } });
  await prisma.user.delete({ where: { id: ids.user } }).catch(() => undefined);
});

describe('training jobs API', () => {
  it('only an administrator can start; inputs are strictly validated (no paths / CLI arguments)', async () => {
    expect((await request(app('USER')).post('/api/ml/autonomous/training-jobs').send({})).status).toBe(403);
    for (const body of [{ datasetVersion: '../../etc/passwd' }, { datasetVersion: 'AUTO-DATASET-v1; rm -rf /' }, { name: 'x'.repeat(61) }, { name: 'a$(whoami)' }, { args: ['--allow-small'] }, { python: '/bin/sh' }]) {
      expect((await request(app('ADMIN')).post('/api/ml/autonomous/training-jobs').send(body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await request(app('ADMIN')).post('/api/ml/autonomous/training-jobs').send({ datasetVersion: 'AUTO-DATASET-NOPE' })).status).toBe(404);
  });

  it('a double click creates one job: the second request returns the active one (409)', async () => {
    const first = await request(app('ADMIN')).post('/api/ml/autonomous/training-jobs').send({ name: 'Community Autonomous ML v2' });
    expect(first.status).toBe(201);
    expect(first.body.data).toMatchObject({ status: 'QUEUED', name: 'Community Autonomous ML v2', activeKey: 'ACTIVE' });
    const second = await request(app('ADMIN')).post('/api/ml/autonomous/training-jobs').send({ name: 'again' });
    expect(second.status).toBe(409);
    expect(second.body.data.activeJob.id).toBe(first.body.data.id);
    expect(await prisma.mlTrainingJob.count({ where: { requestedBy: `train-api-${stamp}@soltrader.local` } })).toBe(1);
    expect(audits).toContain('ml_training_job_started');
    const list = await request(app('USER')).get('/api/ml/autonomous/training-jobs');
    expect(list.body.data.trainer).toEqual({ available: false });
    expect(list.body.data.jobs[0].id).toBe(first.body.data.id);
  });

  it('cancel: USER forbidden; a queued job is cancelled at once and the slot is free again', async () => {
    const active = await prisma.mlTrainingJob.findUniqueOrThrow({ where: { activeKey: 'ACTIVE' } });
    expect((await request(app('USER')).post(`/api/ml/autonomous/training-jobs/${active.id}/cancel`).send({})).status).toBe(403);
    const cancelled = await request(app('ADMIN')).post(`/api/ml/autonomous/training-jobs/${active.id}/cancel`).send({});
    expect(cancelled.body.data).toMatchObject({ status: 'CANCELLED', activeKey: null });
    expect(audits).toContain('ml_training_job_cancelled');
    expect((await request(app('ADMIN')).post(`/api/ml/autonomous/training-jobs/${active.id}/cancel`).send({})).status).toBe(409);
  });

  it('dataset readiness: real counts, explicit missing items when there is not enough data', async () => {
    const response = await request(app('USER')).get('/api/ml/autonomous/dataset-readiness');
    expect(response.status).toBe(200);
    const data = response.body.data;
    expect(typeof data.completedPaths).toBe('number');
    expect(data.estimate.entryRowsUpperBound).toBeGreaterThanOrEqual(0);
    if (!data.canTrain) expect(data.missing.length).toBeGreaterThan(0);
    expect(data.resources.threads).toBe(1);
  });
});

describe('models + activation', () => {
  it('models list: suitability separates training success from trading suitability', async () => {
    const response = await request(app('USER')).get('/api/ml/autonomous/models');
    const research = response.body.data.models.find((model: any) => model.version === RESEARCH);
    const ready = response.body.data.models.find((model: any) => model.version === READY);
    expect(research.suitability).toEqual({ code: 'RESEARCH_ONLY', tradeable: false });
    expect(ready.suitability).toEqual({ code: 'NOT_CHECKED', tradeable: false });
    expect(ready.test).toMatchObject({ trades: 40, netPnl: 12.5, profitFactor: 1.4 });
    expect(ready.active).toBe(false);
  });

  it('"Modell ellenőrzése": research model refused; SHADOW_READY model starts the check (admin only)', async () => {
    expect((await request(app('ADMIN')).post(`/api/ml/autonomous/models/${RESEARCH}/check`).send({})).status).toBe(409);
    expect((await request(app('USER')).post(`/api/ml/autonomous/models/${READY}/check`).send({})).status).toBe(403);
    const started = await request(app('ADMIN')).post(`/api/ml/autonomous/models/${READY}/check`).send({});
    expect(started.body.data).toEqual({ version: READY, status: 'SHADOW' });
    const detail = await request(app('USER')).get(`/api/ml/autonomous/models/${READY}`);
    expect(detail.body.data.suitability.code).toBe('CHECK_RUNNING');
  });

  it('activation: not-approved model refused, USER forbidden; nothing becomes active by training or checking', async () => {
    expect((await request(app('ADMIN')).put('/api/settings/ml-paper').send({ strategyMode: 'ML_AUTONOMOUS', autonomousBundleVersion: READY })).status).toBe(409);
    expect((await request(app('USER')).put('/api/settings/ml-paper').send({ strategyMode: 'ML_AUTONOMOUS', autonomousBundleVersion: READY })).status).toBe(403);
    expect(await prisma.mlPaperSettings.findUnique({ where: { userId: ids.user } })).toBeNull();
    await prisma.mlAutonomousModelBundle.update({ where: { version: READY }, data: { paperApproved: true } });
    const activated = await request(app('ADMIN')).put('/api/settings/ml-paper').send({ strategyMode: 'ML_AUTONOMOUS', autonomousBundleVersion: READY });
    expect(activated.status).toBe(200);
    expect(activated.body.data).toMatchObject({ autonomousBundleVersion: READY, tradingState: { state: 'ML_PAPER_ACTIVE' }, liveTrading: 'DISABLED' });
    expect(activated.body.data.autonomous.approvedModels.map((model: any) => model.version)).toContain(READY);
    expect(activated.body.data.autonomous.riskLimits.maxPositionPctOfEquity).toBeGreaterThan(0);
  });

  it('"Nincs modell – csak adatgyűjtés": also with the ML-only flag off it never falls back to DEFAULT', async () => {
    const cleared = await request(app('USER', false)).post('/api/settings/ml-paper/clear-model').send({});
    expect(cleared.status).toBe(200);
    expect(cleared.body.data).toMatchObject({ strategyMode: 'ML', modelVersion: null, autonomousBundleVersion: null, tradingState: { state: 'DATA_COLLECTION', mayOpenEntries: false } });
  });
});
