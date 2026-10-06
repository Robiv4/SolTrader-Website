/**
 * Administrator user management API (PostgreSQL). Only accounts created by this test are touched.
 */
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';

import { hashPassword } from '../src/auth.js';
import { prisma } from '../src/database.js';

const { app } = await import('../src/app.js');

describe('admin user management API', () => {
  const stamp = Date.now();
  const adminEmail = `admin-users-admin-${stamp}@soltrader.local`;
  const userEmail = `admin-users-user-${stamp}@soltrader.local`;
  const createdEmail = `admin-users-created-${stamp}@soltrader.local`;
  const password = 'AdminUsersPass123!';
  const created: string[] = [];

  afterAll(async () => {
    const users = await prisma.user.findMany({ where: { email: { in: [adminEmail, userEmail, createdEmail] } }, select: { id: true } });
    for (const { id } of users) {
      await prisma.auditLog.deleteMany({ where: { userId: id } });
      await prisma.user.delete({ where: { id } }).catch(() => undefined);
    }
    await prisma.auditLog.deleteMany({ where: { userId: null, action: { startsWith: 'admin_' }, details: { path: ['email'], string_contains: `-${stamp}@` } } }).catch(() => undefined);
  });

  it('only admins can use it; create / role / password / sessions / delete with server-side guard rails', async () => {
    const admin = await prisma.user.create({ data: { email: adminEmail, passwordHash: await hashPassword(password), role: 'ADMIN' } });
    const plain = await prisma.user.create({ data: { email: userEmail, passwordHash: await hashPassword(password), role: 'USER' } });
    created.push(admin.id, plain.id);

    const userAgent = request.agent(app);
    expect((await userAgent.post('/api/auth/login').send({ email: userEmail, password })).status).toBe(200);
    expect((await userAgent.get('/api/admin/users')).status).toBe(403);
    expect((await userAgent.post('/api/admin/users').send({ email: createdEmail, password, role: 'ADMIN' })).status).toBe(403);

    const agent = request.agent(app);
    expect((await agent.post('/api/auth/login').send({ email: adminEmail, password })).status).toBe(200);
    const list = await agent.get('/api/admin/users');
    expect(list.status).toBe(200);
    const self = list.body.data.users.find((user: { email: string }) => user.email === adminEmail);
    expect(self).toMatchObject({ role: 'ADMIN', isSelf: true });
    expect(JSON.stringify(list.body)).not.toMatch(/passwordHash|tokenHash/);

    // Create (an admin account directly), validation, duplicate.
    expect((await agent.post('/api/admin/users').send({ email: createdEmail, password: 'short' })).status).toBe(400);
    const createdUser = await agent.post('/api/admin/users').send({ email: createdEmail, name: 'Teszt Admin', password, role: 'ADMIN' });
    expect(createdUser.status).toBe(201);
    expect(createdUser.body.data).toMatchObject({ email: createdEmail, role: 'ADMIN', name: 'Teszt Admin' });
    expect((await agent.post('/api/admin/users').send({ email: createdEmail, password })).status).toBe(409);
    const createdAgent = request.agent(app);
    expect((await createdAgent.post('/api/auth/login').send({ email: createdEmail, password })).status).toBe(200);
    expect((await createdAgent.get('/api/admin/users')).status).toBe(200);

    // Grant / revoke admin on the plain user; effective immediately (role is read per request).
    expect((await agent.patch(`/api/admin/users/${plain.id}`).send({ role: 'ADMIN' })).body.data.role).toBe('ADMIN');
    expect((await userAgent.get('/api/admin/users')).status).toBe(200);
    expect((await agent.patch(`/api/admin/users/${plain.id}`).send({ role: 'USER' })).body.data.role).toBe('USER');
    expect((await userAgent.get('/api/admin/users')).status).toBe(403);

    // Guard rails: no self-demotion, no self-deletion.
    expect((await agent.patch(`/api/admin/users/${admin.id}`).send({ role: 'USER' })).status).toBe(400);
    expect((await agent.delete(`/api/admin/users/${admin.id}`).send({ confirmEmail: adminEmail })).status).toBe(400);

    // Password reset: old password stops working, the user's sessions end.
    const newPassword = 'BrandNewPass456!';
    expect((await agent.post(`/api/admin/users/${plain.id}/password`).send({ password: newPassword })).status).toBe(200);
    expect((await userAgent.get('/api/auth/me')).status).toBe(401);
    expect((await request(app).post('/api/auth/login').send({ email: userEmail, password })).status).toBe(401);
    const reAgent = request.agent(app);
    expect((await reAgent.post('/api/auth/login').send({ email: userEmail, password: newPassword })).status).toBe(200);
    const revoked = await agent.post(`/api/admin/users/${plain.id}/sessions/revoke`).send({});
    expect(revoked.body.data.revoked).toBeGreaterThanOrEqual(1);
    expect((await reAgent.get('/api/auth/me')).status).toBe(401);

    // Delete: wrong confirmation refused; correct one deletes, audit trail kept (detached).
    expect((await agent.delete(`/api/admin/users/${plain.id}`).send({ confirmEmail: 'wrong@soltrader.local' })).status).toBe(400);
    const deleted = await agent.delete(`/api/admin/users/${plain.id}`).send({ confirmEmail: userEmail });
    expect(deleted.status).toBe(200);
    expect(await prisma.user.findUnique({ where: { id: plain.id } })).toBeNull();
    expect(await prisma.auditLog.count({ where: { action: 'admin_user_deleted', userId: admin.id } })).toBe(1);

    // The admin still works afterwards.
    expect((await agent.get('/api/admin/users')).status).toBe(200);
  });
});
