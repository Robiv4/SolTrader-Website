/**
 * E-mail verification (PostgreSQL): new-IP login codes and admin step-up codes. Only accounts created here are used.
 */
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { hashPassword } from '../src/auth.js';
import { prisma } from '../src/database.js';
import { devOutbox } from '../src/email-verification.js';

const { app } = await import('../src/app.js');

const stamp = Date.now();
const adminEmail = `ev-admin-${stamp}@soltrader.local`;
const userEmail = `ev-user-${stamp}@soltrader.local`;
const newEmail = `ev-new-${stamp}@soltrader.local`;
const password = 'EmailVerifyPass123!';
const lastCodeFor = (email: string) => [...devOutbox].reverse().find((mail) => mail.to === email)?.code ?? '';

describe('e-mail verification', () => {
  beforeAll(async () => {
    process.env.EMAIL_VERIFICATION_ENABLED = 'true';
    await prisma.user.create({ data: { email: adminEmail, passwordHash: await hashPassword(password), role: 'ADMIN' } });
    await prisma.user.create({ data: { email: userEmail, passwordHash: await hashPassword(password), role: 'USER' } });
  });

  afterAll(async () => {
    delete process.env.EMAIL_VERIFICATION_ENABLED;
    const users = await prisma.user.findMany({ where: { email: { in: [adminEmail, userEmail, newEmail] } }, select: { id: true } });
    for (const { id } of users) {
      await prisma.auditLog.deleteMany({ where: { userId: id } });
      await prisma.user.delete({ where: { id } }).catch(() => undefined);
    }
  });

  /** Logs in through the new-IP code flow and returns the agent. */
  async function verifiedAgent(email: string) {
    const agent = request.agent(app);
    const first = await agent.post('/api/auth/login').send({ email, password });
    expect(first.status).toBe(200);
    if (first.body.data.verificationRequired) {
      const verified = await agent.post('/api/auth/login/verify').send({ challengeId: first.body.data.challengeId, code: lastCodeFor(email) });
      expect(verified.status).toBe(200);
    }
    return agent;
  }

  it('login from a new IP needs the e-mailed code; wrong code is rejected; the IP is trusted afterwards', async () => {
    const agent = request.agent(app);
    const first = await agent.post('/api/auth/login').send({ email: userEmail, password });
    expect(first.status).toBe(200);
    expect(first.body.data).toMatchObject({ verificationRequired: true, emailHint: expect.stringContaining('@soltrader.local') });
    expect(first.headers['set-cookie']).toBeUndefined();
    expect((await agent.get('/api/auth/me')).status).toBe(401);
    const code = lastCodeFor(userEmail);
    expect(code).toMatch(/^\d{6}$/);

    const wrong = await agent.post('/api/auth/login/verify').send({ challengeId: first.body.data.challengeId, code: code === '000000' ? '111111' : '000000' });
    expect(wrong.status).toBe(400);
    expect(wrong.body.data).toMatchObject({ reason: 'INVALID_CODE', retryable: true, attemptsLeft: 4 });

    const ok = await agent.post('/api/auth/login/verify').send({ challengeId: first.body.data.challengeId, code });
    expect(ok.status).toBe(200);
    expect((await agent.get('/api/auth/me')).status).toBe(200);
    // Single use.
    expect((await request(app).post('/api/auth/login/verify').send({ challengeId: first.body.data.challengeId, code })).status).toBe(400);

    // Same IP again: no code needed.
    const again = await request.agent(app).post('/api/auth/login').send({ email: userEmail, password });
    expect(again.body.data.verificationRequired).toBeUndefined();
    expect(again.body.data.email).toBe(userEmail);
  });

  it('5 wrong codes lock the challenge (brute force protection)', async () => {
    await prisma.trustedLoginIp.deleteMany({ where: { user: { email: userEmail } } });
    const first = await request(app).post('/api/auth/login').send({ email: userEmail, password });
    const challengeId = first.body.data.challengeId as string;
    const real = lastCodeFor(userEmail);
    const wrongCode = real === '000000' ? '111111' : '000000';
    for (let index = 0; index < 5; index += 1) await request(app).post('/api/auth/login/verify').send({ challengeId, code: wrongCode });
    const locked = await request(app).post('/api/auth/login/verify').send({ challengeId, code: real });
    expect(locked.status).toBe(400);
    expect(locked.body.data.reason).toBe('TOO_MANY_ATTEMPTS');
  });

  it('admin step-up: the code goes to the ACTING admin and is bound to the exact action', async () => {
    const admin = await verifiedAgent(adminEmail);
    const payload = { email: newEmail, password, role: 'ADMIN' };
    const asked = await admin.post('/api/admin/users').send(payload);
    expect(asked.status).toBe(428);
    expect(asked.body).toMatchObject({ code: 'VERIFICATION_REQUIRED', data: { action: 'admin_user_create' } });
    expect(await prisma.user.findUnique({ where: { email: newEmail } })).toBeNull();
    const code = lastCodeFor(adminEmail);
    expect(code).toMatch(/^\d{6}$/);

    // The same code cannot approve a different action (role USER instead of ADMIN).
    const tampered = await admin.post('/api/admin/users').send({ ...payload, role: 'USER', verification: { challengeId: asked.body.data.challengeId, code } });
    expect(tampered.status).toBe(400);
    expect(tampered.body.data.reason).toBe('ACTION_MISMATCH');

    const second = await admin.post('/api/admin/users').send(payload);
    const created = await admin.post('/api/admin/users').send({ ...payload, verification: { challengeId: second.body.data.challengeId, code: lastCodeFor(adminEmail) } });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ email: newEmail, role: 'ADMIN' });

    // Granting admin and deleting also need a code; a rename does not.
    const plain = await prisma.user.findUniqueOrThrow({ where: { email: userEmail } });
    expect((await admin.patch(`/api/admin/users/${plain.id}`).send({ name: 'Átnevezve' })).status).toBe(200);
    const grant = await admin.patch(`/api/admin/users/${plain.id}`).send({ role: 'ADMIN' });
    expect(grant.status).toBe(428);
    const granted = await admin.patch(`/api/admin/users/${plain.id}`).send({ role: 'ADMIN', verification: { challengeId: grant.body.data.challengeId, code: lastCodeFor(adminEmail) } });
    expect(granted.body.data.role).toBe('ADMIN');

    // Guard rails run BEFORE a code is sent (no pointless e-mail for a refused action).
    const before = devOutbox.length;
    const self = await prisma.user.findUniqueOrThrow({ where: { email: adminEmail } });
    expect((await admin.delete(`/api/admin/users/${self.id}`).send({ confirmEmail: adminEmail })).status).toBe(400);
    expect(devOutbox.length).toBe(before);
  });
});
