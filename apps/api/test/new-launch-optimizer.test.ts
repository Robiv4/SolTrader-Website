import { randomUUID } from 'node:crypto';

import { Prisma } from '@prisma/client';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';

import { hashPassword } from '../src/auth.js';
import { prisma } from '../src/database.js';
import { executeRun } from '../src/new-launch-optimizer-job.js';

const { app } = await import('../src/app.js');

const password = 'OptimizerPass123!';
const users: string[] = [];
const tokens: string[] = [];

async function createUser() {
  const email = `nl-optimizer-${randomUUID().slice(0, 8)}@soltrader.local`;
  const user = await prisma.user.create({ data: { email, passwordHash: await hashPassword(password), role: 'USER' } });
  users.push(user.id);
  const agent = request.agent(app);
  expect((await agent.post('/api/auth/login').send({ email, password })).status).toBe(200);
  return { id: user.id, agent };
}

/** Closed NewLaunch trades: low Launch Scores lose, high ones win (in every period of the history). */
async function seedTrades(userId: string, count: number) {
  const token = await prisma.token.create({ data: { address: `NLOPT${randomUUID().slice(0, 12)}`, symbol: 'NLO', name: 'Optimizer test' } });
  tokens.push(token.id);
  const start = Date.now() - count * 120_000;
  for (let i = 0; i < count; i += 1) {
    const score = 60 + (i * 7) % 35;
    const win = score >= 75;
    const entryAt = new Date(start + i * 120_000);
    await prisma.trade.create({ data: {
      userId, tokenId: token.id, side: 'BUY', tokenAddress: token.address, symbol: 'NLO', mode: 'PAPER', status: 'CLOSED', strategyName: 'NewLaunchStrategy', decisionSource: 'NEW_LAUNCH',
      entry: new Prisma.Decimal(1), exit: new Prisma.Decimal(win ? 1.2 : 0.8), size: new Prisma.Decimal(10), quantity: new Prisma.Decimal(10), fees: new Prisma.Decimal(0.06),
      netPnl: new Prisma.Decimal(win ? 2 : -3), entryAt, exitAt: new Date(entryAt.getTime() + 60_000), exitReason: win ? 'TAKE_PROFIT' : 'STOP_LOSS',
      configSnapshot: { newLaunch: { configVersion: 'NL-v1' }, launch: { score, ageSeconds: 20, entryFeatures: { launchScore: score, uniqueBuyers: 10 + (i % 25), liquidityUsd: 8_000 + (i % 10) * 3_000, buySellRatio: 1.2 + (i % 5) * 0.4, exhaustionScore: 20 + (i % 6) * 10, priceImpactPercent: 0.5 + (i % 5) * 0.5, devAllocationPercent: null } } },
    } });
  }
}

afterAll(async () => {
  for (const userId of users) {
    await prisma.newLaunchOptimizationRecommendation.deleteMany({ where: { userId } });
    await prisma.newLaunchOptimizationRun.deleteMany({ where: { userId } });
    await prisma.newLaunchConfigVersion.deleteMany({ where: { userId } });
    await prisma.newLaunchConfig.deleteMany({ where: { userId } });
    await prisma.trade.deleteMany({ where: { userId } });
    await prisma.auditLog.deleteMany({ where: { userId } });
    await prisma.session.deleteMany({ where: { userId } }).catch(() => undefined);
  }
  await prisma.token.deleteMany({ where: { id: { in: tokens } } });
  for (const userId of users) await prisma.user.delete({ where: { id: userId } });
});

describe('NewLaunch settings versioning', () => {
  it('exit settings are separate and every configuration change creates a new immutable version', async () => {
    const { id, agent } = await createUser();
    const defaults = (await agent.get('/api/settings/new-launch')).body.data;
    expect(defaults).toMatchObject({ configVersion: 'NL-v1', stopLossPercent: 20, takeProfitPercent: 25, breakEvenEnabled: true, trailingEnabled: true, trailingActivationPercent: 15, trailingDistancePercent: 8, tieredTakeProfitEnabled: false, maxHoldEnabled: false, liquiditySafetyExitEnabled: true, liquidityDropExitPercent: 50 });
    expect(defaults.qualityGate.mode).toBe('MONITOR_ONLY');
    expect(defaults.exitNotice).toContain('csak az Új token / Sniper pozíciókra');

    const changed = await agent.put('/api/settings/new-launch').send({ stopLossPercent: 10 });
    expect(changed.status).toBe(200);
    expect(changed.body.data.configVersion).toBe('NL-v2');
    // Toggling on/off alone is not a new configuration.
    expect((await agent.put('/api/settings/new-launch').send({ enabled: true })).body.data.configVersion).toBe('NL-v2');
    const gate = await agent.put('/api/settings/new-launch').send({ qualityGate: { mode: 'ENFORCE_PAPER', minLaunchScore: 85 } });
    expect(gate.body.data.configVersion).toBe('NL-v3');
    expect(gate.body.data.qualityGate).toMatchObject({ mode: 'ENFORCE_PAPER', minLaunchScore: 85, version: 2 });
    const versions = await prisma.newLaunchConfigVersion.findMany({ where: { userId: id }, orderBy: { versionNumber: 'asc' } });
    expect(versions.map((version) => version.version)).toEqual(['NL-v1', 'NL-v2', 'NL-v3']);
    expect((versions[0].exitConfig as Record<string, unknown>).stopLossPercent).toBe(20);
    expect((versions[1].exitConfig as Record<string, unknown>).stopLossPercent).toBe(10);
    expect(versions[2].parentVersion).toBe('NL-v2');
    expect((await agent.put('/api/settings/new-launch').send({ stopLossPercent: 150 })).status).toBe(400);
  });

  it('exit capacity: MONITOR_ONLY by default; monitor thresholds do not split the version, enforcing creates a new one', async () => {
    const { agent } = await createUser();
    const defaults = (await agent.get('/api/settings/new-launch')).body.data;
    expect(defaults).toMatchObject({ configVersion: 'NL-v1', dynamicPositionSizingEnabled: true, exitCapacityMode: 'MONITOR_ONLY', maxEstimatedExitImpactPct: 3, minimumExecutablePosition: 5 });
    const monitored = await agent.put('/api/settings/new-launch').send({ maxEstimatedExitImpactPct: 2 });
    expect(monitored.status).toBe(200);
    expect(monitored.body.data).toMatchObject({ configVersion: 'NL-v1', maxEstimatedExitImpactPct: 2 });
    const enforced = await agent.put('/api/settings/new-launch').send({ exitCapacityMode: 'ENFORCE_PAPER' });
    expect(enforced.body.data).toMatchObject({ configVersion: 'NL-v2', exitCapacityMode: 'ENFORCE_PAPER' });
    expect((await agent.put('/api/settings/new-launch').send({ exitCapacityMode: 'LIVE' })).status).toBe(400);
  });
});

describe('NewLaunch analytics + optimizer', () => {
  it('builds per-user analytics, runs the optimizer without touching settings, and accepting creates a new PAPER version', async () => {
    const owner = await createUser();
    const other = await createUser();
    await seedTrades(owner.id, 80);

    const analytics = await owner.agent.get('/api/analytics/new-launch?version=all');
    expect(analytics.status).toBe(200);
    const data = analytics.body.data.analytics;
    expect(data.sampleSize).toBe(80);
    expect(data.summary.trades).toBe(80);
    expect(data.buckets.launchScore.map((bucket: { label: string }) => bucket.label)).toEqual(['60–69', '70–79', '80–89']);
    expect(data.winnerVsLoser.find((item: { metric: string }) => item.metric === 'launchScore').winners.median).toBeGreaterThan(data.winnerVsLoser.find((item: { metric: string }) => item.metric === 'launchScore').losers.median);
    // No price paths were stored for these trades: MFE / MAE stay unknown instead of being invented.
    expect(data.summary.averageMfePercent).toBeNull();
    expect(data.trades[0].mfePercent).toBeNull();
    // Dev allocation was not available at entry -> unknown, never 0.
    expect(data.winnerVsLoser.find((item: { metric: string }) => item.metric === 'devAllocationPercent').winners.count).toBe(0);
    // User isolation: the other user sees none of these trades.
    const otherAnalytics = (await other.agent.get('/api/analytics/new-launch?version=all')).body.data;
    expect(otherAnalytics.analytics.sampleSize).toBe(0);
    expect(otherAnalytics.analytics.goodEntryBadExit).toEqual([]);
    expect(otherAnalytics.analytics.suspiciousExits).toEqual([]);
    // Exit diagnostics sections exist; without stored paths nothing is guessed.
    expect(Array.isArray(data.goodEntryBadExit)).toBe(true);
    expect(data.dataIntegrity).toMatchObject({ duplicateTradesPerPosition: 0, futureTimestamps: 0, exitBeforeEntry: 0 });
    expect(data.execution).toHaveProperty('triggerToFillMs');

    const simulation = await owner.agent.post('/api/analytics/new-launch/simulate-filter').send({ version: 'all', conditions: [{ feature: 'launchScore', kind: 'min', value: 75 }] });
    expect(simulation.body.data).toMatchObject({ label: 'HISTORICAL SIMULATION — NOT FUTURE PERFORMANCE', historicalTrades: 80 });
    expect(simulation.body.data.after.netPnl).toBeGreaterThan(simulation.body.data.before.netPnl);

    const before = await prisma.newLaunchConfig.findUnique({ where: { userId: owner.id } });
    const run = await prisma.newLaunchOptimizationRun.create({ data: { userId: owner.id, status: 'RUNNING', scope: { version: 'all', sample: 'all' } } });
    await executeRun(run.id, owner.id, { version: 'all', sample: 'all' });
    expect((await prisma.newLaunchOptimizationRun.findUniqueOrThrow({ where: { id: run.id } })).status).toBe('COMPLETED');
    // Optimizer never changes the active settings.
    expect(await prisma.newLaunchConfig.findUnique({ where: { userId: owner.id } })).toEqual(before);
    const recommendation = await prisma.newLaunchOptimizationRecommendation.findFirstOrThrow({ where: { userId: owner.id, parameter: 'minScore', status: 'PENDING' } });
    expect(Number(recommendation.suggestedValue)).toBeGreaterThanOrEqual(75);
    expect(['MEDIUM', 'HIGH']).toContain(recommendation.confidenceLevel);

    // The other user cannot accept it.
    expect((await other.agent.post(`/api/new-launch/recommendations/${recommendation.id}/accept`)).status).toBe(404);
    const accepted = await owner.agent.post(`/api/new-launch/recommendations/${recommendation.id}/accept`);
    expect(accepted.status).toBe(200);
    expect(accepted.body.data.configVersion).toBe('NL-v2');
    const settings = (await owner.agent.get('/api/settings/new-launch')).body.data;
    expect(settings.minScore).toBe(Number(recommendation.suggestedValue));
    const version = await prisma.newLaunchConfigVersion.findFirstOrThrow({ where: { userId: owner.id, version: 'NL-v2' } });
    expect(version).toMatchObject({ parentVersion: 'NL-v1', createdFromRecommendationId: recommendation.id });
    expect((await prisma.newLaunchOptimizationRecommendation.findUniqueOrThrow({ where: { id: recommendation.id } })).status).toBe('ACCEPTED');
  });

  it('starts ONE automatic optimizer run once the current version has >= 50 closed trades (never applies anything)', async () => {
    const owner = await createUser();
    await seedTrades(owner.id, 55);
    const before = await prisma.newLaunchConfig.findUnique({ where: { userId: owner.id } });
    const first = await owner.agent.get('/api/analytics/new-launch');
    expect(first.body.data.analytics.sampleSize).toBe(55);
    expect(first.body.data.autoRunStarted).toBe(true);
    const second = await owner.agent.get('/api/analytics/new-launch');
    expect(second.body.data.autoRunStarted).toBe(false);
    expect(await prisma.newLaunchOptimizationRun.count({ where: { userId: owner.id } })).toBe(1);
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const run = await prisma.newLaunchOptimizationRun.findFirstOrThrow({ where: { userId: owner.id } });
      if (run.status !== 'RUNNING') break;
      await new Promise((resolve) => globalThis.setTimeout(resolve, 100));
    }
    expect(await prisma.newLaunchConfig.findUnique({ where: { userId: owner.id } })).toEqual(before);
  });

  it('small samples produce no recommendation', async () => {
    const owner = await createUser();
    await seedTrades(owner.id, 20);
    const run = await prisma.newLaunchOptimizationRun.create({ data: { userId: owner.id, status: 'RUNNING', scope: { version: 'all', sample: 'all' } } });
    const result = await executeRun(run.id, owner.id, { version: 'all', sample: 'all' });
    expect(result.entry.sufficientData).toBe(false);
    expect(await prisma.newLaunchOptimizationRecommendation.count({ where: { userId: owner.id } })).toBe(0);
  });
});
