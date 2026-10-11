import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';

import { hashPassword } from '../src/auth.js';
import { prisma } from '../src/database.js';

const SECRET = 'sk-test-DO-NOT-LEAK-7f3a91';
// Configured provider pointing at an unreachable local port: health checks fail fast, no network traffic.
process.env.AI_PROVIDER = 'openai';
process.env.AI_MODEL = 'test-model';
process.env.OPENAI_API_KEY = SECRET;
process.env.AI_BASE_URL = 'http://127.0.0.1:9/v1';
const { app } = await import('../src/app.js');

describe('AI provider key stays server-side', () => {
  const email = `ai-secret-${Date.now()}@soltrader.local`;
  const password = 'AiSecretPass123!';
  let userId = '';

  afterAll(async () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.AI_PROVIDER;
    delete process.env.AI_BASE_URL;
    if (!userId) return;
    await prisma.aiConfig.deleteMany({ where: { userId } });
    await prisma.auditLog.deleteMany({ where: { userId } });
    await prisma.user.delete({ where: { id: userId } });
  });

  it('never returns the key from any settings / status endpoint', async () => {
    const user = await prisma.user.create({ data: { email, passwordHash: await hashPassword(password), role: 'USER' } });
    userId = user.id;
    const agent = request.agent(app);
    expect((await agent.post('/api/auth/login').send({ email, password })).status).toBe(200);
    const responses = [
      await agent.get('/api/settings'),
      await agent.get('/api/settings/risk'),
      await agent.get('/api/settings/new-launch'),
      await agent.get('/api/social/status'),
      await agent.get('/api/system/health'),
    ];
    for (const response of responses) expect(JSON.stringify(response.body)).not.toContain(SECRET);
    // The retired AI trader settings endpoint is gone (no AI entry mode can be switched on).
    expect((await agent.get('/api/settings/ai')).status).toBe(404);
    expect((await agent.put('/api/settings/ai').send({ aiAnalysisEnabled: true })).status).toBe(404);
    const audits = await prisma.auditLog.findMany({ where: { userId } });
    expect(JSON.stringify(audits)).not.toContain(SECRET);
    expect(JSON.stringify(await prisma.aiConfig.findMany({ where: { userId } }))).not.toContain(SECRET);
  });
});
