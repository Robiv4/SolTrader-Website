import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';

import { hashPassword } from '../src/auth.js';
import { prisma } from '../src/database.js';

const { app } = await import('../src/app.js');

describe('advanced strategy settings API (per user, PostgreSQL)', () => {
  const email = `advanced-settings-${Date.now()}@soltrader.local`;
  const password = 'AdvancedPass123!';
  let userId = '';

  afterAll(async () => {
    if (!userId) return;
    await prisma.advancedStrategyConfig.deleteMany({ where: { userId } });
    await prisma.botConfig.deleteMany({ where: { userId } });
    await prisma.auditLog.deleteMany({ where: { userId } });
    await prisma.session.deleteMany({ where: { userId } }).catch(() => undefined);
    await prisma.user.delete({ where: { id: userId } });
  });

  it('returns safe defaults, merges partial updates per module and validates input', async () => {
    const user = await prisma.user.create({ data: { email, passwordHash: await hashPassword(password), role: 'USER' } });
    userId = user.id;
    const agent = request.agent(app);
    expect((await agent.post('/api/auth/login').send({ email, password })).status).toBe(200);

    const defaults = await agent.get('/api/settings/advanced-strategies');
    expect(defaults.status).toBe(200);
    expect(defaults.body.data).toMatchObject({ compositeEnabled: false, minimumConfirmations: 3, exhaustionEnabled: true, exhaustionBlockThreshold: 85, persisted: false });
    expect(defaults.body.data.modules.VolumeSpike).toMatchObject({ enabled: true, weight: 1.2, minSpikeRatio: 2 });

    const saved = await agent.put('/api/settings/advanced-strategies').send({ compositeEnabled: true, minimumConfirmations: 4, modules: { VolumeSpike: { weight: 1.5 } } });
    expect(saved.status).toBe(200);
    const second = await agent.put('/api/settings/advanced-strategies').send({ modules: { BuyPressure: { enabled: false } } });
    expect(second.status).toBe(200);
    expect(second.body.data).toMatchObject({ compositeEnabled: true, minimumConfirmations: 4, persisted: true });
    // The earlier VolumeSpike change survives a later update of another module.
    expect(second.body.data.modules.VolumeSpike).toMatchObject({ weight: 1.5, minSpikeRatio: 2 });
    expect(second.body.data.modules.BuyPressure.enabled).toBe(false);

    const row = await prisma.advancedStrategyConfig.findUniqueOrThrow({ where: { userId } });
    expect(row.minimumConfirmations).toBe(4);

    expect((await agent.put('/api/settings/advanced-strategies').send({ exhaustionWarningThreshold: 90, exhaustionBlockThreshold: 50 })).status).toBe(400);
    expect((await agent.put('/api/settings/advanced-strategies').send({ minimumConfirmations: 0 })).status).toBe(400);
    expect((await agent.put('/api/settings/advanced-strategies').send({ modules: { NotAModule: { enabled: true } } })).status).toBe(400);
  });

  it('stores the monitored-token count (10-300) and the token monitor uses it as its default size', async () => {
    const agent = request.agent(app);
    expect((await agent.post('/api/auth/login').send({ email, password })).status).toBe(200);
    expect((await agent.patch('/api/settings').send({ maxMonitoredTokens: 120 })).status).toBe(200);
    expect((await agent.get('/api/settings')).body.data.maxMonitoredTokens).toBe(120);
    expect((await agent.patch('/api/settings').send({ maxMonitoredTokens: 500 })).status).toBe(400);
    expect((await agent.patch('/api/settings').send({ maxMonitoredTokens: 5 })).status).toBe(400);
    const tokens = await agent.get('/api/tokens');
    expect(tokens.status).toBe(200);
    expect(tokens.body.data.length).toBeLessThanOrEqual(120);
    expect((await agent.get('/api/tokens?limit=301')).status).toBe(400);
  });

  it('requires authentication', async () => {
    expect((await request(app).get('/api/settings/advanced-strategies')).status).toBe(401);
  });
});
