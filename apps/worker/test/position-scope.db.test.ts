/**
 * The cycle-based exit monitor must keep protecting legacy / strategy PAPER positions (exitPolicy = null) while the
 * hot monitor owns NEW_LAUNCH positions. Runs against the development database with its own throw-away user.
 */
import { randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import { afterAll, describe, expect, it } from 'vitest';

import { cycleMonitoredPositionsWhere, ThrottledWarning } from '../src/exit/position-scope.js';

const prisma = new PrismaClient();
const runId = randomUUID().slice(0, 8);
let userId = '';
let tokenId = '';

afterAll(async () => {
  if (userId) {
    await prisma.position.deleteMany({ where: { userId } });
    await prisma.user.delete({ where: { id: userId } });
  }
  if (tokenId) await prisma.token.delete({ where: { id: tokenId } });
  await prisma.$disconnect();
});

describe('cycle exit monitor position scope', () => {
  it('includes positions without an exit policy (NULL) and leaves NEW_LAUNCH ones to the hot monitor', async () => {
    const user = await prisma.user.create({ data: { email: `position-scope-${runId}@soltrader.local`, passwordHash: 'test-only', role: 'USER' } });
    userId = user.id;
    const token = await prisma.token.create({ data: { address: `SCOPE${runId}`.padEnd(44, '1'), symbol: 'SCOPE' } });
    tokenId = token.id;
    const base = { userId, tokenId, side: 'BUY' as const, quantity: 1, avgEntryPrice: 1, status: 'OPEN' as const, mode: 'PAPER' as const };
    const legacy = await prisma.position.create({ data: { ...base, exitPolicy: null } });
    const launch = await prisma.position.create({ data: { ...base, exitPolicy: 'NEW_LAUNCH' } });
    const other = await prisma.position.create({ data: { ...base, exitPolicy: 'STRATEGY' } });
    await prisma.position.create({ data: { ...base, exitPolicy: null, status: 'CLOSED' } });

    const ids = async (hot: boolean) => (await prisma.position.findMany({ where: { AND: [cycleMonitoredPositionsWhere(hot), { userId }] }, select: { id: true } })).map((row) => row.id).sort();

    // The former `NOT: { exitPolicy: 'NEW_LAUNCH' }` filter returned only `other` here (NULL rows dropped).
    expect(await ids(true)).toEqual([legacy.id, other.id].sort());
    // Without a hot monitor the cycle monitor protects every open PAPER position.
    expect(await ids(false)).toEqual([legacy.id, launch.id, other.id].sort());
  });

  it('throttles the repeated "no fresh price" warning per token', () => {
    const warning = new ThrottledWarning(60_000);
    expect(warning.shouldLog('A', 0)).toBe(true);
    expect(warning.shouldLog('A', 30_000)).toBe(false);
    expect(warning.shouldLog('B', 30_000)).toBe(true);
    expect(warning.shouldLog('A', 60_000)).toBe(true);
  });
});
