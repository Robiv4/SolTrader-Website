/* eslint-disable @typescript-eslint/no-explicit-any -- minimal request user stub */
/**
 * ML-only strategy settings API (router with ML_ONLY_ARCHITECTURE_ENABLED on / off) against the LOCAL development
 * database with a throw-away user (removed afterwards; never run against production):
 * no DEFAULT selector, operating state from the shared contract, pause / resume, deselect model, legacy unchanged.
 */
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { prisma } from '../src/database.js';
import { createMlPaperRouter } from '../src/ml-paper.js';

const stamp = Date.now();
const ids = { user: '' };
const audits: string[] = [];

function app(mlOnly: boolean, role: 'ADMIN' | 'USER') {
  const server = express();
  server.use(express.json());
  server.use((req: any, _res, next) => {
    req.user = { id: ids.user, email: `ml-only-${stamp}@soltrader.local`, role };
    next();
  });
  server.use('/api', createMlPaperRouter({
    prisma, logger: { error: () => undefined }, readJson: async () => null, stepUp: (async () => true) as any,
    logAuditEvent: async (action: string) => { audits.push(action); }, serverTradingMode: () => 'PAPER', mlOnly: () => mlOnly,
  }));
  return server;
}

beforeAll(async () => {
  const user = await prisma.user.create({ data: { email: `ml-only-${stamp}@soltrader.local` } });
  ids.user = user.id;
  await prisma.botConfig.create({ data: { userId: user.id, tradingMode: 'PAPER', status: 'STOPPED' } });
});

afterAll(async () => {
  await prisma.mlPaperSettings.deleteMany({ where: { userId: ids.user } });
  await prisma.botConfig.deleteMany({ where: { userId: ids.user } });
  await prisma.user.delete({ where: { id: ids.user } }).catch(() => undefined);
});

describe('ML-only settings API', () => {
  it('no DEFAULT selector; without a model the user is in DATA_COLLECTION', async () => {
    const response = await request(app(true, 'USER')).get('/api/settings/ml-paper');
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ mlOnly: true, selectableStrategies: ['ML', 'ML_AUTONOMOUS'], tradingState: { state: 'DATA_COLLECTION', mayOpenEntries: false }, liveTrading: 'DISABLED' });
  });

  it('selecting DEFAULT is refused in ML-only mode (nothing stored)', async () => {
    const response = await request(app(true, 'ADMIN')).put('/api/settings/ml-paper').send({ strategyMode: 'DEFAULT' });
    expect(response.status).toBe(400);
    expect(response.body.data).toEqual({ code: 'DEFAULT_STRATEGY_DISABLED' });
    expect(await prisma.mlPaperSettings.findUnique({ where: { userId: ids.user } })).toBeNull();
  });

  it('a model that is not PAPER-approved cannot be selected', async () => {
    const response = await request(app(true, 'ADMIN')).put('/api/settings/ml-paper').send({ strategyMode: 'ML', modelVersion: `NO-SUCH-MODEL-${stamp}` });
    expect(response.status).toBe(409);
  });

  it('pause: the owner can pause; resuming needs an administrator; state TRADING_PAUSED while paused', async () => {
    const paused = await request(app(true, 'USER')).post('/api/settings/ml-paper/pause').send({ paused: true });
    expect(paused.status).toBe(200);
    expect(paused.body.data).toMatchObject({ tradingPaused: true, tradingState: { state: 'TRADING_PAUSED', reasons: ['TRADING_PAUSED_BY_USER'] } });
    expect((await request(app(true, 'USER')).post('/api/settings/ml-paper/pause').send({ paused: false })).status).toBe(403);
    const resumed = await request(app(true, 'ADMIN')).post('/api/settings/ml-paper/pause').send({ paused: false });
    expect(resumed.body.data).toMatchObject({ tradingPaused: false, tradingState: { state: 'DATA_COLLECTION' } });
    expect(audits).toEqual(expect.arrayContaining(['ml_trading_paused', 'ml_trading_resumed']));
  });

  it('deselecting the model -> DATA_COLLECTION; not available in legacy mode', async () => {
    await prisma.mlPaperSettings.update({ where: { userId: ids.user }, data: { strategyMode: 'ML', modelVersion: 'SOME-REVOKED-MODEL' } });
    const unavailable = await request(app(true, 'USER')).get('/api/settings/ml-paper');
    expect(unavailable.body.data.tradingState).toMatchObject({ state: 'MODEL_UNAVAILABLE', mayOpenEntries: false });
    const cleared = await request(app(true, 'USER')).post('/api/settings/ml-paper/clear-model').send({});
    expect(cleared.body.data).toMatchObject({ modelVersion: null, tradingState: { state: 'DATA_COLLECTION' } });
    expect((await request(app(false, 'USER')).post('/api/settings/ml-paper/clear-model').send({})).status).toBe(409);
  });

  it('legacy mode (flag off): DEFAULT stays selectable and works as before', async () => {
    const view = await request(app(false, 'USER')).get('/api/settings/ml-paper');
    expect(view.body.data).toMatchObject({ mlOnly: false, selectableStrategies: ['DEFAULT', 'ML', 'ML_AUTONOMOUS'] });
    const saved = await request(app(false, 'USER')).put('/api/settings/ml-paper').send({ strategyMode: 'DEFAULT' });
    expect(saved.status).toBe(200);
    expect(saved.body.data.strategyMode).toBe('DEFAULT');
  });
});
