import crypto from 'node:crypto';

import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { hashPassword, logAuditEvent } from '../src/auth.js';
import { prisma } from '../src/database.js';
import { base58Encode } from '../src/wallet-verification.js';

process.env.ADMIN_EMAIL = 'admin@soltrader.local';
process.env.ADMIN_PASSWORD = 'AdminPass123!';
process.env.SESSION_TTL_SECONDS = '30';

const { app } = await import('../src/app.js');

function createTestWallet() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url');
  return { address: base58Encode(raw), sign: (message: string) => crypto.sign(null, Buffer.from(message, 'utf8'), privateKey).toString('base64') };
}

async function linkWallet(agent: ReturnType<typeof request.agent>, wallet: ReturnType<typeof createTestWallet>, label = 'Primary wallet') {
  const challenge = await agent.post('/api/settings/wallet/challenge').send({ publicAddress: wallet.address, network: 'devnet' });
  expect(challenge.status).toBe(200);
  return agent.post('/api/settings/wallet/connect').send({
    type: 'USER',
    publicAddress: wallet.address,
    network: 'devnet',
    provider: 'PHANTOM',
    label,
    nonce: challenge.body.data.nonce,
    signature: wallet.sign(challenge.body.data.message),
  });
}

describe('user settings API', () => {
  const agent = request.agent(app);

  beforeEach(async () => {
    await agent.post('/api/auth/login').send({
      email: 'admin@soltrader.local',
      password: 'AdminPass123!',
    });
  });

  afterEach(async () => {
    await agent.post('/api/auth/logout').send({});
  });

  it('creates and returns user-owned settings', async () => {
    const response = await agent.get('/api/settings');
    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.data).toHaveProperty('tradingMode');
    expect(response.body.data).toHaveProperty('risk');
    expect(response.body.data).toHaveProperty('strategies');
  });

  it('updates risk settings for the authenticated user only', async () => {
    const rival = await prisma.user.create({
      data: { email: `risk-owner-${Date.now()}@soltrader.local`, passwordHash: 'test-only', role: 'USER' },
    });
    const rivalRisk = await prisma.riskConfig.create({ data: { userId: rival.id, maxPositionPercent: 7 } });

    try {
      const response = await agent.patch('/api/settings/risk').send({
        maxPositionPercent: 15,
        maxTotalExposurePercent: 30,
        maxSlippagePercent: 1.2,
        minSignalScore: 68,
      });

      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
      expect(response.body.data.maxPositionPercent).toBe(15);
      const unchanged = await prisma.riskConfig.findUnique({ where: { userId: rival.id } });
      expect(Number(unchanged?.maxPositionPercent)).toBe(Number(rivalRisk.maxPositionPercent));
    } finally {
      await prisma.user.delete({ where: { id: rival.id } });
    }
  });

  it('persists general settings and returns them on the next read', async () => {
    const update = await agent.patch('/api/settings').send({
      tradingMode: 'SEMI_AUTO',
      isScannerEnabled: true,
      maxPositionSize: 42,
      riskThreshold: 35,
    });

    expect(update.status).toBe(200);
    expect(update.body.data.tradingMode).toBe('SEMI_AUTO');
    expect(update.body.data.maxPositionSize).toBe(42);

    const reread = await agent.get('/api/settings');
    expect(reread.status).toBe(200);
    expect(reread.body.data.tradingMode).toBe('SEMI_AUTO');
    expect(reread.body.data.maxPositionSize).toBe(42);
  });

  it('updates a strategy toggle and wallet connection', async () => {
    const patchStrategy = await agent.patch('/api/settings/strategies/Momentum').send({ isEnabled: true, params: { minimumMomentum: 65 } });
    expect(patchStrategy.status).toBe(200);
    expect(patchStrategy.body.ok).toBe(true);
    expect(patchStrategy.body.data.params.minimumMomentum).toBe(65);
    expect(patchStrategy.body.data.params.maximumRiskScore).toBe(66);

    const wallet = createTestWallet();
    const walletConnect = await linkWallet(agent, wallet);

    expect(walletConnect.status).toBe(200);
    expect(walletConnect.body.ok).toBe(true);
    expect(walletConnect.body.data.publicAddress).toBe(wallet.address);
    expect(walletConnect.body.data.network).toBe('devnet');
  });

  it('rejects unknown strategies and unknown strategy parameters', async () => {
    const unknown = await agent.patch('/api/settings/strategies/Grid').send({ isEnabled: true });
    expect(unknown.status).toBe(404);
    const badParam = await agent.patch('/api/settings/strategies/Momentum').send({ params: { lookback: 12 } });
    expect(badParam.status).toBe(400);
    const listed = await agent.get('/api/settings/strategies');
    expect(Object.keys(listed.body.data).sort()).toEqual(['Breakout', 'Momentum', 'Pullback']);
  });

  it('refuses to link a user wallet without a valid ownership signature', async () => {
    const wallet = createTestWallet();
    const unsigned = await agent.post('/api/settings/wallet/connect').send({ type: 'USER', publicAddress: wallet.address, network: 'mainnet-beta' });
    expect(unsigned.status).toBe(400);

    const challenge = await agent.post('/api/settings/wallet/challenge').send({ publicAddress: wallet.address, network: 'mainnet-beta' });
    const impostor = createTestWallet();
    const forged = await agent.post('/api/settings/wallet/connect').send({
      type: 'USER', publicAddress: wallet.address, network: 'mainnet-beta', nonce: challenge.body.data.nonce, signature: impostor.sign(challenge.body.data.message),
    });
    expect(forged.status).toBe(401);

    // The nonce is single-use: even the genuine signature is refused after a failed attempt.
    const replay = await agent.post('/api/settings/wallet/connect').send({
      type: 'USER', publicAddress: wallet.address, network: 'mainnet-beta', nonce: challenge.body.data.nonce, signature: wallet.sign(challenge.body.data.message),
    });
    expect(replay.status).toBe(400);
  });

  it('lets an administrator register the bot trading wallet by public address', async () => {
    const botWallet = createTestWallet();
    const response = await agent.post('/api/settings/wallet/connect').send({ type: 'BOT_TRADING', publicAddress: botWallet.address, network: 'mainnet-beta' });
    expect(response.status).toBe(200);
    const view = await agent.get('/api/settings/wallet');
    expect(view.body.data.botTradingWallet.publicAddress).toBe(botWallet.address);
    const removed = await agent.post('/api/settings/wallet/disconnect').send({ type: 'BOT_TRADING' });
    expect(removed.status).toBe(200);
  });

  it('does not allow switching on AI requirements while no AI analyst is configured', async () => {
    const off = await agent.patch('/api/settings/risk').send({ aiAnalysisEnabled: false, aiRequiredForHighRisk: false, aiRequiredForVeryHighRisk: false });
    expect(off.status).toBe(200);
    expect(off.body.data.aiProviderConfigured).toBe(false);
    const on = await agent.patch('/api/settings/risk').send({ aiAnalysisEnabled: true, aiRequiredForHighRisk: true });
    expect(on.status).toBe(400);
  });

  it('rejects secret-like fields in strategy parameters', async () => {
    const response = await agent.patch('/api/settings/strategies/Momentum').send({
      params: { nested: { rpcApiKey: 'test-only-placeholder' } },
    });

    expect(response.status).toBe(400);
    expect(response.body.error).toContain('Invalid strategy settings payload');
  });

  it('redacts secret-like audit fields before database persistence', async () => {
    const user = await prisma.user.findUnique({ where: { email: 'admin@soltrader.local' } });
    expect(user).not.toBeNull();
    const action = `audit-redaction-${Date.now()}`;
    await logAuditEvent(action, user!.id, { nested: { privateKey: 'test-only-placeholder', safeField: 'visible' }, apiKey: 'test-only-placeholder' });

    const audit = await prisma.auditLog.findFirst({ where: { userId: user!.id, action } });
    expect(audit?.details).toEqual({ nested: { privateKey: '[REDACTED]', safeField: 'visible' }, apiKey: '[REDACTED]' });
    if (audit) await prisma.auditLog.delete({ where: { id: audit.id } });
  });

  it('redacts legacy secret-like strategy fields from API responses', async () => {
    const user = await prisma.user.findUnique({ where: { email: 'admin@soltrader.local' } });
    expect(user).not.toBeNull();
    const strategyName = `legacy-redaction-${Date.now()}`;
    await prisma.strategyConfig.create({
      data: { userId: user!.id, strategyName, params: { sessionToken: 'test-only-placeholder', visible: 'ok' } },
    });

    try {
      // Rows for strategies the engine does not know are never returned, so their contents cannot leak.
      const response = await agent.get('/api/settings/strategies');
      expect(response.status).toBe(200);
      expect(response.body.data[strategyName]).toBeUndefined();
      expect(JSON.stringify(response.body)).not.toContain('test-only-placeholder');
    } finally {
      await prisma.strategyConfig.delete({ where: { userId_strategyName: { userId: user!.id, strategyName } } });
    }
  });

  it('requires authentication for wallet settings access', async () => {
    const response = await request(app).get('/api/settings/wallet');
    expect(response.status).toBe(401);
  });

  it('rejects invalid wallet addresses', async () => {
    const response = await agent.post('/api/settings/wallet/connect').send({
      type: 'USER',
      publicAddress: 'invalid',
      network: 'mainnet-beta',
    });

    expect(response.status).toBe(400);
  });

  it('rejects invalid network values', async () => {
    const response = await agent.post('/api/settings/wallet/connect').send({
      type: 'USER',
      publicAddress: '9xQ7QfL54wA7pM9JqimGJmP4XhQ5v1VJz2aS2b3s1Q4',
      network: 'ethereum',
    });

    expect(response.status).toBe(400);
  });

  it('enforces single active user wallet and disconnect behavior', async () => {
    const first = await linkWallet(agent, createTestWallet());
    expect(first.status).toBe(200);

    const duplicate = await linkWallet(agent, createTestWallet(), 'Secondary wallet');

    expect(duplicate.status).toBe(200);

    const stored = await prisma.wallet.findMany({ where: { userId: (await prisma.user.findUnique({ where: { email: 'admin@soltrader.local' } }))!.id, type: 'USER' } });
    expect(stored.filter((wallet) => wallet.isActive).length).toBe(1);

    const disconnect = await agent.post('/api/settings/wallet/disconnect').send({ type: 'USER' });
    expect(disconnect.status).toBe(200);
    expect(disconnect.body.data.status).toBe('DISCONNECTED');
  });

  it('blocks wallet ownership changes for another user', async () => {
    const rivalEmail = `rival-${Date.now()}@soltrader.local`;
    const rivalUser = await prisma.user.create({
      data: {
        email: rivalEmail,
        name: 'Rival User',
        passwordHash: await hashPassword('Password123!'),
        role: 'USER',
      },
    });

    const otherWallet = await prisma.wallet.create({
      data: {
        userId: rivalUser.id,
        type: 'USER',
        publicAddress: '2VQ9P6gJqL3r1Fz9tYh7D2v4M8xK5wC6',
        network: 'mainnet-beta',
        label: 'Rival wallet',
        isActive: true,
      },
    });

    const response = await agent.post('/api/settings/wallet/disconnect').send({
      type: 'USER',
      publicAddress: otherWallet.publicAddress,
    });

    expect(response.status).toBe(404);
    const walletView = await agent.get('/api/settings/wallet');
    expect(walletView.status).toBe(200);
    expect(walletView.body.data.wallets.some((wallet: { publicAddress: string }) => wallet.publicAddress === otherWallet.publicAddress)).toBe(false);
  });
});
