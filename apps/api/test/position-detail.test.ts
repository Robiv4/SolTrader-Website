import { randomUUID } from 'node:crypto';

import { Prisma } from '@prisma/client';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';

import { hashPassword } from '../src/auth.js';
import { prisma } from '../src/database.js';

const { app } = await import('../src/app.js');

const password = 'PositionPass123!';
const users: string[] = [];
const tokens: string[] = [];

async function createUser() {
  const email = `position-detail-${randomUUID().slice(0, 8)}@soltrader.local`;
  const user = await prisma.user.create({ data: { email, passwordHash: await hashPassword(password), role: 'USER' } });
  users.push(user.id);
  const agent = request.agent(app);
  expect((await agent.post('/api/auth/login').send({ email, password })).status).toBe(200);
  return { id: user.id, agent };
}

/** Open NEW_LAUNCH position with stored exit state, real price history and recorded events. */
async function seedPosition(userId: string, options: { closed?: boolean } = {}) {
  const address = `DETAIL${randomUUID().slice(0, 12)}`;
  const token = await prisma.token.create({ data: { address, symbol: 'DTL', name: 'Detail test' } });
  tokens.push(token.id);
  const openedAt = new Date(Date.now() - 20 * 60_000);
  const prices = [1, 1.04, 1.1, 1.18, 1.22, 1.2, 1.26, 1.24];
  for (let i = 0; i < prices.length; i += 1) {
    await prisma.tokenMetric.create({ data: { tokenId: token.id, timestamp: new Date(openedAt.getTime() + i * 2 * 60_000), priceUsd: new Prisma.Decimal(prices[i]), liquidityUsd: new Prisma.Decimal(40_000), provider: 'test' } as never });
  }
  const closedAt = options.closed ? new Date(openedAt.getTime() + 16 * 60_000) : null;
  const position = await prisma.position.create({ data: {
    userId, tokenId: token.id, side: 'BUY', mode: 'PAPER', status: options.closed ? 'CLOSED' : 'OPEN', quantity: new Prisma.Decimal(10), avgEntryPrice: new Prisma.Decimal(1),
    currentPrice: new Prisma.Decimal(1.24), stopLossPrice: new Prisma.Decimal(1.004), takeProfitPrice: new Prisma.Decimal(1.4), trailingStopPercent: new Prisma.Decimal(0.08),
    trailingActivationPercent: new Prisma.Decimal(0.15), trailingActive: true, trailingActivatedAt: new Date(openedAt.getTime() + 6 * 60_000), trailingActivationPrice: new Prisma.Decimal(1.18),
    trailingTriggerPrice: new Prisma.Decimal(1.1592), breakEvenActivationPercent: new Prisma.Decimal(0.1), breakEvenAppliedAt: new Date(openedAt.getTime() + 4 * 60_000),
    highestPrice: new Prisma.Decimal(1.26), lowestPrice: new Prisma.Decimal(1), unrealizedPnl: new Prisma.Decimal(options.closed ? 0 : 2.4), openedAt, closedAt,
    exitReason: options.closed ? 'TRAILING_STOP' : null,
  } as never });
  await prisma.trade.create({ data: {
    userId, tokenId: token.id, positionId: position.id, side: 'BUY', tokenAddress: address, symbol: 'DTL', mode: 'PAPER', status: options.closed ? 'CLOSED' : 'OPEN',
    strategyName: 'NewLaunchStrategy', decisionSource: 'NEW_LAUNCH', entry: new Prisma.Decimal(1), size: new Prisma.Decimal(10), entryAt: openedAt,
    exit: options.closed ? new Prisma.Decimal(1.16) : null, exitAt: closedAt, exitReason: options.closed ? 'TRAILING_STOP' : null, netPnl: options.closed ? new Prisma.Decimal(1.5) : null,
    configSnapshot: { stopLossPercent: 20, takeProfitPercent: 40, trailingStopPercent: 8, trailingActivationPercent: 15, breakEvenActivationPercent: 10, launch: { score: 81, ageSeconds: 24, detectedPrice: 0.98, decisionPrice: 0.99, simulatedFillPrice: 1 } },
  } as never });
  await prisma.positionEvent.createMany({ data: [
    { positionId: position.id, userId, type: 'ENTRY', at: openedAt, price: new Prisma.Decimal(1), details: { decisionSource: 'NEW_LAUNCH' } },
    { positionId: position.id, userId, type: 'BREAK_EVEN_APPLIED', at: new Date(openedAt.getTime() + 4 * 60_000), price: new Prisma.Decimal(1.1), details: { stopLoss: 1.004 } },
    { positionId: position.id, userId, type: 'TRAILING_ACTIVATED', at: new Date(openedAt.getTime() + 6 * 60_000), price: new Prisma.Decimal(1.18), details: { triggerPrice: 1.0856 } },
    { positionId: position.id, userId, type: 'TRAILING_MOVED', at: new Date(openedAt.getTime() + 12 * 60_000), price: new Prisma.Decimal(1.26), details: { from: 1.0856, to: 1.1592 } },
    ...(options.closed ? [{ positionId: position.id, userId, type: 'EXIT', at: closedAt!, price: new Prisma.Decimal(1.16), details: { exitReason: 'TRAILING_STOP', netPnl: 1.5 } }] : []),
  ] as never });
  return { position, address };
}

afterAll(async () => {
  for (const userId of users) {
    await prisma.positionEvent.deleteMany({ where: { userId } });
    await prisma.trade.deleteMany({ where: { userId } });
    await prisma.position.deleteMany({ where: { userId } });
    await prisma.auditLog.deleteMany({ where: { userId } });
    await prisma.session.deleteMany({ where: { userId } }).catch(() => undefined);
  }
  await prisma.tokenMetric.deleteMany({ where: { tokenId: { in: tokens } } });
  await prisma.token.deleteMany({ where: { id: { in: tokens } } });
  for (const userId of users) await prisma.user.delete({ where: { id: userId } });
});

describe('position detail + chart API', () => {
  it('returns the unified detail view with backend exit levels, attribution, entry snapshot and timeline', async () => {
    const owner = await createUser();
    const { position } = await seedPosition(owner.id);
    const response = await owner.agent.get(`/api/positions/${position.id}`);
    expect(response.status).toBe(200);
    const data = response.body.data;
    expect(data).toMatchObject({ id: position.id, status: 'OPEN', mode: 'PAPER', decisionSource: 'NEW_LAUNCH', entryPrice: 1, currentPrice: 1.24, invested: 10 });
    expect(data.unrealizedPnl).toBeCloseTo(2.4, 8);
    expect(data.exitLevels.stopLoss.price).toBeCloseTo(1.004, 8);
    expect(data.exitLevels.takeProfit.price).toBeCloseTo(1.4, 8);
    expect(data.exitLevels.breakEven.status).toBe('ACTIVE');
    expect(data.exitLevels.trailing).toMatchObject({ status: 'ACTIVE', triggerPrice: 1.1592 });
    expect(data.decision).toMatchObject({ source: 'NEW_LAUNCH', launch: { score: 81, ageSeconds: 24 } });
    // Historical entry configuration comes from the snapshot, not from the current user settings.
    expect(data.configuration.atEntry).toMatchObject({ stopLossPercent: 20, takeProfitPercent: 40, trailingActivationPercent: 15 });
    expect(data.configuration.currentPosition.stopLossPercent).toBeCloseTo(0.4, 6);
    // Unknown security facts stay unknown.
    expect(data.security.mintAuthority).toBe('UNKNOWN');
    expect(data.timeline.map((event: { type: string }) => event.type)).toEqual(['ENTRY', 'BREAK_EVEN_APPLIED', 'TRAILING_ACTIVATED', 'TRAILING_MOVED']);
  });

  it('chart uses only real stored price points and backend levels, with trailing steps and markers', async () => {
    const owner = await createUser();
    const { position, address } = await seedPosition(owner.id);
    const response = await owner.agent.get(`/api/positions/${position.id}/chart?range=lifetime`);
    expect(response.status).toBe(200);
    const chart = response.body.data;
    expect(chart.chartType).toBe('line');
    expect(chart.points.map((point: { price: number }) => point.price)).toEqual([1, 1.04, 1.1, 1.18, 1.22, 1.2, 1.26, 1.24]);
    // Break-even is applied: the stored stop (1.004) is drawn as the break-even stop, not as the stop loss.
    expect(chart.levels).toMatchObject({ entry: 1, stopLoss: null, breakEvenStop: 1.004, takeProfit: 1.4, trailingStop: 1.1592, current: 1.24, exit: null });
    expect(chart.trailingSteps.map((step: { price: number }) => step.price)).toEqual([1.0856, 1.1592]);
    expect(chart.markers.some((marker: { type: string }) => marker.type === 'ENTRY')).toBe(true);
    expect(chart.availableRanges).toContain('lifetime');
    expect((await owner.agent.get(`/api/positions/${position.id}/chart?range=2d`)).status).toBe(400);

    const tokenChart = await owner.agent.get(`/api/tokens/${address}/chart?from=${Date.now() - 3_600_000}&to=${Date.now()}`);
    expect(tokenChart.status).toBe(200);
    expect(tokenChart.body.data.points).toHaveLength(8);
  });

  it('works for closed positions (exit level, EXIT marker, realized P&L)', async () => {
    const owner = await createUser();
    const { position } = await seedPosition(owner.id, { closed: true });
    const detail = (await owner.agent.get(`/api/positions/${position.id}`)).body.data;
    expect(detail).toMatchObject({ status: 'CLOSED', exitReason: 'TRAILING_STOP', exitPrice: 1.16, realizedPnl: 1.5 });
    const chart = (await owner.agent.get(`/api/positions/${position.id}/chart`)).body.data;
    expect(chart.levels.exit).toBe(1.16);
    expect(chart.levels.current).toBeNull();
    expect(chart.markers.some((marker: { type: string; exitReason: string }) => marker.type === 'EXIT' && marker.exitReason === 'TRAILING_STOP')).toBe(true);
  });

  it('user isolation: another user gets 404 for detail and chart', async () => {
    const owner = await createUser();
    const other = await createUser();
    const { position } = await seedPosition(owner.id);
    expect((await other.agent.get(`/api/positions/${position.id}`)).status).toBe(404);
    expect((await other.agent.get(`/api/positions/${position.id}/chart`)).status).toBe(404);
    expect((await request(app).get(`/api/positions/${position.id}`)).status).toBe(401);
  });
});
