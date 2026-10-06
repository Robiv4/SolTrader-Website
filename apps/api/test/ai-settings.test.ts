import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';

import { hashPassword } from '../src/auth.js';
import { prisma } from '../src/database.js';

// No AI provider configured in this test process. Empty values (not deletion): dotenv never overrides
// an existing variable, so a key in the developer's .env cannot leak into this test.
process.env.AI_PROVIDER = '';
process.env.OPENAI_API_KEY = '';
process.env.XAI_API_KEY = '';
process.env.GROQ_API_KEY = '';
const { app } = await import('../src/app.js');

describe('AI settings API (per user, PostgreSQL)', () => {
  const email = `ai-settings-${Date.now()}@soltrader.local`;
  const password = 'AiSettingsPass123!';
  let userId = '';

  afterAll(async () => {
    if (!userId) return;
    await prisma.aiConfig.deleteMany({ where: { userId } });
    await prisma.auditLog.deleteMany({ where: { userId } });
    await prisma.user.delete({ where: { id: userId } });
  });

  it('defaults to Strategy mode and refuses AI mode without a configured provider', async () => {
    const user = await prisma.user.create({ data: { email, passwordHash: await hashPassword(password), role: 'USER' } });
    userId = user.id;
    const agent = request.agent(app);
    expect((await agent.post('/api/auth/login').send({ email, password })).status).toBe(200);

    const initial = await agent.get('/api/settings/ai');
    expect(initial.status).toBe(200);
    expect(initial.body.data).toMatchObject({ aiAnalysisEnabled: false, decisionMode: 'STRATEGY', aiMinimumConfidence: 75, aiRecheckSeconds: 30, aiMaxAnalysesPerMinute: 10, aiAllowHighRisk: true, aiAllowVeryHighRisk: false, aiUseExitParameters: false, aiDynamicExitSuggestionsEnabled: false });
    expect(initial.body.data.provider.status).toBe('NOT_CONFIGURED');

    const enable = await agent.put('/api/settings/ai').send({ aiAnalysisEnabled: true });
    expect(enable.status).toBe(400);
    expect(enable.body.error).toBe('Az AI szolgáltató nincs konfigurálva. Állíts be érvényes szerveroldali AI API-kulcsot.');
    expect((await prisma.aiConfig.findUnique({ where: { userId } }))?.aiAnalysisEnabled ?? false).toBe(false);

    // Other AI settings can be prepared while the mode stays off.
    const saved = await agent.put('/api/settings/ai').send({ aiMinimumConfidence: 80, aiRecheckSeconds: 60 });
    expect(saved.status).toBe(200);
    expect(saved.body.data).toMatchObject({ aiMinimumConfidence: 80, aiRecheckSeconds: 60, aiAnalysisEnabled: false });
    expect((await prisma.aiConfig.findUniqueOrThrow({ where: { userId } })).aiMinimumConfidence).toBe(80);

    expect((await agent.put('/api/settings/ai').send({ aiMinimumConfidence: 20 })).status).toBe(400);
    expect((await agent.put('/api/settings/ai').send({ OPENAI_API_KEY: 'sk-x' })).status).toBe(400);
  });

  it('requires authentication', async () => {
    expect((await request(app).get('/api/settings/ai')).status).toBe(401);
  });
});
