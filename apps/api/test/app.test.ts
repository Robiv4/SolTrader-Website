import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { hashPassword } from '../src/auth.js';
import { prisma } from '../src/database.js';

process.env.ADMIN_EMAIL = 'admin@soltrader.local';
process.env.ADMIN_PASSWORD = 'AdminPass123!';
process.env.SESSION_TTL_SECONDS = '30';

const { app } = await import('../src/app.js');

/** A token with a fresh market price, so PAPER fills have a real mark to execute against. */
async function createPricedToken(priceUsd: number) {
  const symbol = `SIM${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const token = await prisma.token.create({ data: { address: `${symbol}`.padEnd(44, '1'), symbol, name: 'Simulated token' } });
  await prisma.tokenMetric.create({ data: { tokenId: token.id, priceUsd, liquidityUsd: 100_000, timestamp: new Date() } });
  return token;
}

describe('API app', () => {
  const agent = request.agent(app);

  it('exposes health endpoint', async () => {
    const response = await request(app).get('/health');

    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.mode).toBe('PAPER');
  });

  it('valid login', async () => {
    const response = await agent.post('/api/auth/login').send({
      email: 'admin@soltrader.local',
      password: 'AdminPass123!',
    });

    expect(response.status).toBe(200);
    expect(response.headers['set-cookie'][0]).toContain('session_token=');
    expect(response.headers['set-cookie'][0]).toMatch(/HttpOnly/i);
    expect(response.headers['set-cookie'][0]).toMatch(/SameSite=Lax/i);
    expect(response.body.data).not.toHaveProperty('passwordHash');
    expect(response.body.data).not.toHaveProperty('token');
  });

  it('invalid login', async () => {
    const response = await request(app).post('/api/auth/login').send({
      email: 'admin@soltrader.local',
      password: 'wrong-password',
    });

    expect(response.status).toBe(401);
    expect(response.body.ok).toBe(false);
  });

  it('unauthorized API request', async () => {
    const response = await request(app).get('/api/settings');
    expect(response.status).toBe(401);
  });

  it('authorized API request', async () => {
    await agent.post('/api/auth/login').send({
      email: 'admin@soltrader.local',
      password: 'AdminPass123!',
    });

    const response = await agent.get('/api/settings');
    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
  });

  it('the retired token monitor list and manual token-list buy endpoints are gone (no signal is created)', async () => {
    await agent.post('/api/auth/login').send({ email: 'admin@soltrader.local', password: 'AdminPass123!' });
    const before = await prisma.signal.count({ where: { signalType: 'MANUAL_PAPER' } });
    expect((await agent.get('/api/tokens')).status).toBe(404);
    expect((await agent.post('/api/paper/orders/manual-buy').send({ tokenAddress: '9xQ7QfL54wA7pM9JqimGJmP4XhQ5v1VJz2aS2b3s1Q4', requestedAmount: 5, amountType: 'USDC' })).status).toBe(404);
    expect((await agent.post('/api/bot/strategies/Momentum/toggle').send({ isEnabled: true })).status).toBe(404);
    expect(await prisma.signal.count({ where: { signalType: 'MANUAL_PAPER' } })).toBe(before);
  });

  it('does not exhaust the sensitive-action limit on read-only settings requests', async () => {
    await agent.post('/api/auth/login').send({
      email: 'admin@soltrader.local',
      password: 'AdminPass123!',
    });

    const responses = await Promise.all(Array.from({ length: 31 }, () => agent.get('/api/settings')));
    expect(responses.every((response) => response.status === 200)).toBe(true);
  });

  it('books a manual PAPER close exactly once and credits the paper account', async () => {
    const email = `close-owner-${Date.now()}@soltrader.local`;
    const owner = await prisma.user.create({ data: { email, passwordHash: await hashPassword('ClosePass123!'), role: 'USER' } });
    const tokenAddress = `CLoSE${Date.now()}`.padEnd(44, '1');
    const token = await prisma.token.create({ data: { address: tokenAddress, symbol: 'CLS', name: 'Close test' } });
    await prisma.paperAccount.create({ data: { userId: owner.id, initialBalance: 1000, cashBalance: 900, equity: 1010, totalFees: 0.3 } });
    const position = await prisma.position.create({
      data: { userId: owner.id, tokenId: token.id, side: 'BUY', quantity: 1, avgEntryPrice: 100, currentPrice: 110, mode: 'PAPER', status: 'OPEN' },
    });
    const openTrade = await prisma.trade.create({
      data: { userId: owner.id, tokenId: token.id, positionId: position.id, side: 'BUY', tokenAddress, symbol: 'CLS', entry: 100, quantity: 1, fees: 0.3, mode: 'PAPER', status: 'OPEN' },
    });
    const ownerAgent = request.agent(app);

    try {
      expect((await ownerAgent.post('/api/auth/login').send({ email, password: 'ClosePass123!' })).status).toBe(200);
      const [first, second] = await Promise.all([
        ownerAgent.post(`/api/positions/${position.id}/close`).send({ reason: 'manual-close' }),
        ownerAgent.post(`/api/positions/${position.id}/close`).send({ reason: 'manual-close' }),
      ]);
      expect([first.status, second.status].sort()).toEqual([200, 409]);

      const account = await prisma.paperAccount.findUniqueOrThrow({ where: { userId: owner.id } });
      // No fresh quote in the test: the close is filled from the last mark minus the 0.1% latency slippage.
      const exitFill = 110 * (1 - 0.1 / 100);
      const exitFee = exitFill * 30 / 10_000;
      // Exit notional minus exit fee is credited once; equity equals cash with nothing left open.
      expect(Number(account.cashBalance)).toBeCloseTo(900 + exitFill - exitFee, 6);
      expect(Number(account.equity)).toBeCloseTo(Number(account.cashBalance), 6);
      const trade = await prisma.trade.findUniqueOrThrow({ where: { id: openTrade.id } });
      expect(trade.status).toBe('CLOSED');
      expect(Number(trade.netPnl)).toBeCloseTo(exitFill - 100 - 0.3 - exitFee, 6);
      expect(Number(trade.exitMarketPrice)).toBe(110);
      expect(await prisma.trade.count({ where: { positionId: position.id } })).toBe(1);
    } finally {
      await prisma.trade.deleteMany({ where: { userId: owner.id } });
      await prisma.position.deleteMany({ where: { userId: owner.id } });
      await prisma.token.delete({ where: { id: token.id } });
      await prisma.auditLog.deleteMany({ where: { userId: owner.id } });
      await prisma.user.delete({ where: { id: owner.id } });
    }
  });

  it('approves a SEMI_AUTO proposal whose prices do not survive float to DECIMAL rounding unchanged', async () => {
    const email = `semi-owner-${Date.now()}@soltrader.local`;
    const owner = await prisma.user.create({ data: { email, passwordHash: await hashPassword('SemiPass123!'), role: 'USER' } });
    const tokenAddress = `SEMi${Date.now()}`.padEnd(44, '1');
    const token = await prisma.token.create({ data: { address: tokenAddress, symbol: 'SEMI', name: 'Semi test' } });
    // 1/3-style prices have more digits than DECIMAL(30,18) keeps; hashing the JS floats used to break the integrity check.
    const entryPrice = 0.1 / 3;
    await prisma.botConfig.create({ data: { userId: owner.id, tradingMode: 'SEMI_AUTO', status: 'RUNNING' } });
    await prisma.riskConfig.create({ data: { userId: owner.id, maxSlippagePercent: 3, maxConcurrentPositions: 3 } });
    await prisma.paperAccount.create({ data: { userId: owner.id, initialBalance: 1000, cashBalance: 1000, equity: 1000 } });
    await prisma.tokenMetric.create({ data: { tokenId: token.id, priceUsd: entryPrice, liquidityUsd: 100_000, timestamp: new Date() } });
    const signal = await prisma.signal.create({ data: { userId: owner.id, tokenId: token.id, direction: 'BUY', score: 85, riskScore: 20, mode: 'SCANNER', strategyName: 'Momentum' } });
    const created = await prisma.approvalRequest.create({
      data: { userId: owner.id, signalId: signal.id, tokenId: token.id, direction: 'BUY', signalScore: 85, riskScore: 20, entryPrice, positionSize: 30 + 1 / 7, stopLoss: entryPrice * 0.98, takeProfit: entryPrice * 1.04, trailingStop: 0.02, reasons: [], proposedOrderHash: `pending-${Date.now()}`, expiresAt: new Date(Date.now() + 300_000) },
    });
    const { hashApprovalProposal } = await import('@soltrader/trading-engine');
    const approval = await prisma.approvalRequest.update({ where: { id: created.id }, data: { proposedOrderHash: hashApprovalProposal(created) } });
    const ownerAgent = request.agent(app);

    try {
      expect((await ownerAgent.post('/api/auth/login').send({ email, password: 'SemiPass123!' })).status).toBe(200);
      const response = await ownerAgent.post(`/api/approvals/${approval.id}/approve`).send({});
      expect(response.status).toBe(200);
      expect(response.body.data.status).toBe('EXECUTED');
      const account = await prisma.paperAccount.findUniqueOrThrow({ where: { userId: owner.id } });
      const notional = entryPrice * (30 + 1 / 7);
      expect(Number(account.cashBalance)).toBeCloseTo(1000 - notional * 1.003, 4);
    } finally {
      await prisma.trade.deleteMany({ where: { userId: owner.id } });
      await prisma.position.deleteMany({ where: { userId: owner.id } });
      await prisma.paperOrder.deleteMany({ where: { userId: owner.id } });
      await prisma.auditLog.deleteMany({ where: { userId: owner.id } });
      await prisma.tokenMetric.deleteMany({ where: { tokenId: token.id } });
      await prisma.signal.deleteMany({ where: { tokenId: token.id } });
      await prisma.token.delete({ where: { id: token.id } });
      await prisma.user.delete({ where: { id: owner.id } });
    }
  });

  it('reports the worker outcome of signals instead of only their BUY direction', async () => {
    expect((await agent.post('/api/auth/login').send({ email: 'admin@soltrader.local', password: 'AdminPass123!' })).status).toBe(200);
    const owner = await prisma.user.findUniqueOrThrow({ where: { email: 'admin@soltrader.local' } });
    const token = await createPricedToken(1);
    const rejected = await prisma.signal.create({ data: { userId: owner.id, tokenId: token.id, direction: 'BUY', score: 10, riskScore: 60, mode: 'SCANNER', signalType: 'MANUAL_PAPER', strategyName: 'MANUAL_PAPER' } });
    await prisma.auditLog.create({ data: { userId: owner.id, action: 'TRADE_REJECTED', details: { signalId: rejected.id, decisionReasons: ['SLIPPAGE_LIMIT_EXCEEDED'] } } });
    const pending = await prisma.signal.create({ data: { userId: owner.id, tokenId: token.id, direction: 'BUY', score: 10, riskScore: 60, mode: 'SCANNER', signalType: 'MANUAL_PAPER', strategyName: 'MANUAL_PAPER' } });

    try {
      const response = await agent.get(`/api/signals?tokenAddress=${token.address}`);
      expect(response.status).toBe(200);
      const byId = new Map(response.body.data.map((row: { id: string; outcome: unknown }) => [row.id, row.outcome]));
      expect(byId.get(rejected.id)).toEqual({ status: 'REJECTED', reasons: ['SLIPPAGE_LIMIT_EXCEEDED'] });
      expect(byId.get(pending.id)).toEqual({ status: 'PENDING', reasons: [] });
    } finally {
      await prisma.auditLog.deleteMany({ where: { userId: owner.id, action: 'TRADE_REJECTED', details: { path: ['signalId'], equals: rejected.id } } });
      await prisma.signal.deleteMany({ where: { id: { in: [rejected.id, pending.id] } } });
    }
  });

  it('scopes positions, trades, signals, and close actions to the authenticated owner', async () => {
    const rival = await prisma.user.create({
      data: {
        email: `security-owner-${Date.now()}@soltrader.local`,
        passwordHash: 'not-used-by-this-test',
        role: 'USER',
      },
    });
    const tokenAddress = 'So11111111111111111111111111111111111111112';
    const token = await prisma.token.upsert({
      where: { address: tokenAddress },
      update: {},
      create: { address: tokenAddress, symbol: 'SOL', name: 'Solana' },
    });
    const foreignPosition = await prisma.position.create({
      data: { userId: rival.id, tokenId: token.id, side: 'BUY', quantity: 1, avgEntryPrice: 100, mode: 'PAPER', status: 'OPEN' },
    });
    const foreignTrade = await prisma.trade.create({
      data: { userId: rival.id, tokenId: token.id, side: 'BUY', tokenAddress, symbol: 'SOL', status: 'OPEN' },
    });
    const foreignClosedTrade = await prisma.trade.create({
      data: { userId: rival.id, tokenId: token.id, side: 'BUY', tokenAddress, symbol: 'RIVAL-PRIVATE-TRADE', strategyName: 'RivalOnly', status: 'CLOSED', mode: 'PAPER', netPnl: 999 },
    });
    const foreignSignal = await prisma.signal.create({
      data: { userId: rival.id, tokenId: token.id, score: 80, riskScore: 10, mode: 'SCANNER' },
    });
    const foreignRiskAssessment = await prisma.riskAssessment.create({
      data: { userId: rival.id, tokenId: token.id, riskScore: 99, decision: 'REJECT', factors: {}, rejectionReasons: [], warnings: [], source: 'ownership-test' },
    });

    try {
      const login = await agent.post('/api/auth/login').send({ email: 'admin@soltrader.local', password: 'AdminPass123!' });
      expect(login.status).toBe(200);
      const [positions, trades, signals] = await Promise.all([
        agent.get('/api/positions'),
        agent.get('/api/trades'),
        agent.get('/api/signals'),
      ]);

      expect(positions.status).toBe(200);
      expect(trades.status).toBe(200);
      expect(signals.status).toBe(200);
      const analytics = await agent.get('/api/analytics?range=all');
      expect(analytics.status).toBe(200);
      const tokenDetails = await agent.get(`/api/tokens/${tokenAddress}`);
      expect(tokenDetails.status).toBe(200);
      expect(positions.body.data.some((position: { id: string }) => position.id === foreignPosition.id)).toBe(false);
      expect(trades.body.data.some((trade: { id: string }) => trade.id === foreignTrade.id)).toBe(false);
      expect(signals.body.data.some((signal: { id: string }) => signal.id === foreignSignal.id)).toBe(false);
      expect(trades.body.data.some((trade: { id: string }) => trade.id === foreignClosedTrade.id)).toBe(false);
      expect(analytics.body.data.strategyPerformance.some((row: { name: string }) => row.name === 'RivalOnly')).toBe(false);
      expect(analytics.body.data.tokenPerformance.some((row: { name: string }) => row.name === 'RIVAL-PRIVATE-TRADE')).toBe(false);
      expect(analytics.body.data.recentSignals.some((signal: { id: string }) => signal.id === foreignSignal.id)).toBe(false);
      expect(tokenDetails.body.data.signals.some((signal: { id: string }) => signal.id === foreignSignal.id)).toBe(false);
      expect(tokenDetails.body.data.riskAssessments.some((assessment: { id: string }) => assessment.id === foreignRiskAssessment.id)).toBe(false);

      const close = await agent.post(`/api/positions/${foreignPosition.id}/close`).send({ reason: 'unauthorized-test' });
      expect(close.status).toBe(404);
      expect((await prisma.position.findUnique({ where: { id: foreignPosition.id } }))?.status).toBe('OPEN');
    } finally {
      await prisma.trade.deleteMany({ where: { userId: rival.id } });
      await prisma.position.deleteMany({ where: { userId: rival.id } });
      await prisma.signal.deleteMany({ where: { userId: rival.id } });
      await prisma.riskAssessment.deleteMany({ where: { userId: rival.id } });
      await prisma.user.delete({ where: { id: rival.id } });
    }
  });

  it('denies regular users global bot control and monitoring data', async () => {
    const user = await prisma.user.create({
      data: {
        email: `security-role-${Date.now()}@soltrader.local`,
        passwordHash: await hashPassword('UserPass123!'),
        role: 'USER',
      },
    });
    const userAgent = request.agent(app);

    try {
      const login = await userAgent.post('/api/auth/login').send({ email: user.email, password: 'UserPass123!' });
      expect(login.status).toBe(200);
      expect((await userAgent.get('/api/bot/status')).status).toBe(403);
      expect((await userAgent.post('/api/bot/start').send({})).status).toBe(403);

      const health = await userAgent.get('/api/system/health');
      expect(health.status).toBe(200);
      expect(health.body.data).not.toHaveProperty('monitoring');
    } finally {
      await userAgent.post('/api/auth/logout').send({});
      await prisma.user.delete({ where: { id: user.id } });
    }
  });

  it('keeps the LIVE safety status GET read-only', async () => {
    const email = `safety-read-${Date.now()}@soltrader.local`;
    const user = await prisma.user.create({ data: { email, passwordHash: await hashPassword('AdminPass123!'), role: 'ADMIN' } });
    const isolatedAgent = request.agent(app);

    try {
      const login = await isolatedAgent.post('/api/auth/login').send({ email, password: 'AdminPass123!' });
      expect(login.status).toBe(200);
      await prisma.botConfig.create({
        data: { userId: user.id, tradingMode: 'LIVE', isLiveEnabled: true, liveApprovalCompleted: true },
      });

      const response = await isolatedAgent.get('/api/safety/live');
      expect(response.status).toBe(200);
      expect(response.body.data.status).toBe('LIVE BLOCKED');
      const unchanged = await prisma.botConfig.findUnique({ where: { userId: user.id } });
      expect(unchanged?.isLiveEnabled).toBe(true);
      expect(unchanged?.tradingMode).toBe('LIVE');
    } finally {
      await isolatedAgent.post('/api/auth/logout').send({});
      await prisma.user.delete({ where: { id: user.id } });
    }
  });

  it('rejects cross-origin state-changing requests', async () => {
    const response = await request(app)
      .post('/api/auth/logout')
      .set('Origin', 'https://attacker.invalid')
      .send({});
    expect(response.status).toBe(403);
  });

  it('returns database-backed portfolio and analytics snapshots with date filters', async () => {
    await agent.post('/api/auth/login').send({
      email: 'admin@soltrader.local',
      password: 'AdminPass123!',
    });

    const backtests = await agent.get('/api/backtests');
    expect(backtests.status).toBe(200);
    expect(Array.isArray(backtests.body.data)).toBe(true);

    const portfolio = await agent.get('/api/portfolio/snapshot?range=today');
    expect(portfolio.status).toBe(200);
    expect(portfolio.body.data.range).toBe('today');
    expect(typeof portfolio.body.data.totalEquity).toBe('number');
    expect(typeof portfolio.body.data.realizedPnl).toBe('number');

    const analytics = await agent.get('/api/analytics?range=7d');
    expect(analytics.status).toBe(200);
    expect(analytics.body.data.range).toBe('7d');
    expect(Array.isArray(analytics.body.data.strategyPerformance)).toBe(true);
    expect(typeof analytics.body.data.winRate).toBe('number');

    const invalid = await agent.get('/api/analytics?range=invalid');
    expect(invalid.status).toBe(400);
  });

  it('creates a default paper account and persists simulated order fills', async () => {
    await agent.post('/api/auth/login').send({
      email: 'admin@soltrader.local',
      password: 'AdminPass123!',
    });

    const accountResponse = await agent.get('/api/paper-account');
    expect(accountResponse.status).toBe(200);
    expect(accountResponse.body.ok).toBe(true);
    expect(accountResponse.body.data.currency).toBe('USDC');
    expect(Number(accountResponse.body.data.initialBalance)).toBeGreaterThan(0);

    const token = await createPricedToken(2);
    const cashBefore = Number(accountResponse.body.data.cashBalance);
    const tradeResponse = await agent.post('/api/v1/trades/simulate').send({
      symbol: token.symbol,
      side: 'buy',
      amount: 2,
    });

    expect(tradeResponse.status).toBe(200);
    expect(tradeResponse.body.ok).toBe(true);
    expect(tradeResponse.body.order.status).toBe('FILLED');

    // The buy is booked: cash is debited, an OPEN position and trade exist, and equity includes the position.
    const accountAfterTrade = await agent.get('/api/paper-account');
    expect(Number(accountAfterTrade.body.data.cashBalance)).toBeCloseTo(cashBefore - 2 * 1.003, 6);
    const positionsAfter = await agent.get('/api/positions');
    const opened = positionsAfter.body.data.find((row: { symbol: string; status: string }) => row.symbol === token.symbol && row.status === 'OPEN');
    expect(opened).toBeTruthy();
    const positionValue = Number(opened.quantity) * Number(opened.currentPrice);
    const tradesAfter = await agent.get('/api/trades');
    expect(tradesAfter.body.data.some((row: { symbol: string; status: string }) => row.symbol === token.symbol && row.status === 'OPEN')).toBe(true);
    const openValues = positionsAfter.body.data.filter((row: { status: string }) => row.status === 'OPEN').reduce((sum: number, row: { quantity: string; currentPrice: string }) => sum + Number(row.quantity) * Number(row.currentPrice), 0);
    expect(Number(accountAfterTrade.body.data.equity)).toBeCloseTo(Number(accountAfterTrade.body.data.cashBalance) + openValues, 4);
    expect(positionValue).toBeGreaterThan(0);

    // Selling closes the position and returns the proceeds to cash.
    const sell = await agent.post('/api/v1/trades/simulate').send({ symbol: token.symbol, side: 'sell', amount: 2 });
    expect(sell.status).toBe(200);
    const accountAfterSell = await agent.get('/api/paper-account');
    expect(Number(accountAfterSell.body.data.cashBalance)).toBeGreaterThan(Number(accountAfterTrade.body.data.cashBalance));

    const ordersResponse = await agent.get('/api/paper-account/orders');
    expect(ordersResponse.status).toBe(200);
    expect(ordersResponse.body.data.length).toBeGreaterThan(0);
  });

  it('session expiration', async () => {
    process.env.SESSION_TTL_SECONDS = '1';
    const response = await agent.post('/api/auth/login').send({
      email: 'admin@soltrader.local',
      password: 'AdminPass123!',
    });

    expect(response.status).toBe(200);

    await new Promise((resolve) => globalThis.setTimeout(resolve, 1200));

    const expired = await agent.get('/api/settings');
    expect(expired.status).toBe(401);
    process.env.SESSION_TTL_SECONDS = '30';
  });

  it('logout', async () => {
    await agent.post('/api/auth/login').send({
      email: 'admin@soltrader.local',
      password: 'AdminPass123!',
    });

    const response = await agent.post('/api/auth/logout');
    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
  });

  it('protected routes', async () => {
    const response = await request(app).post('/api/bot/start');
    expect(response.status).toBe(401);
  });

  it('simulates paper trade requests only after auth', async () => {
    await agent.post('/api/auth/login').send({
      email: 'admin@soltrader.local',
      password: 'AdminPass123!',
    });

    const token = await createPricedToken(0.00002);
    const response = await agent.post('/api/v1/trades/simulate').send({ symbol: token.symbol, side: 'buy', amount: 0.5 });

    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.mode).toBe('PAPER');
    expect(response.body.order.status).toBe('FILLED');
    await agent.post('/api/v1/trades/simulate').send({ symbol: token.symbol, side: 'sell', amount: 0.5 });

    const unpriced = await agent.post('/api/v1/trades/simulate').send({ symbol: 'NO_SUCH_TOKEN', side: 'buy', amount: 1 });
    expect(unpriced.status).toBe(409);
  });

  it('rejects direct API attempts to enable LIVE mode', async () => {
    await agent.post('/api/auth/login').send({
      email: 'admin@soltrader.local',
      password: 'AdminPass123!',
    });

    const settingsResponse = await agent.put('/api/settings').send({ tradingMode: 'LIVE', isLiveEnabled: true });
    expect(settingsResponse.status).toBe(403);
    expect(settingsResponse.body.error).toContain('LIVE mode cannot be enabled');

    const patchResponse = await agent.patch('/api/settings').send({ tradingMode: 'LIVE', isLiveEnabled: true });
    expect(patchResponse.status).toBe(403);

    const statusResponse = await agent.get('/api/safety/live');
    expect(statusResponse.status).toBe(200);
    expect(statusResponse.body.data.status).toBe('LIVE BLOCKED');
    expect(statusResponse.body.data.failedChecks).toContain('USER_LIVE_ENABLED');
    expect(statusResponse.body.data.blockingReasons.length).toBeGreaterThan(0);

    const enableResponse = await agent.post('/api/safety/live/enable').send({ confirmLiveTrading: true });
    expect(enableResponse.status).toBe(403);
    expect(enableResponse.body.error).toContain('LIVE mode cannot be enabled');
    expect(enableResponse.body.details.status).toBe('LIVE BLOCKED');
  });

  it('requires authentication for safety endpoints', async () => {
    const response = await request(app).post('/api/safety/live/enable').send({ confirmLiveTrading: true });
    expect(response.status).toBe(401);
  });
});
