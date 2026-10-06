/**
 * Exit latency benchmark (PAPER, development database, throw-away user - removed afterwards).
 *
 * BEFORE: the previous NewLaunch exit loop - a 1 s timer that, per tick, read the open NEW_LAUNCH positions,
 *         then PositionManager.reconcileMarket (reads all open positions with their relations, evaluates, writes).
 *         A market event waits for the next tick (uniform 0..interval) plus both reads before the decision.
 * AFTER:  the event-driven HotPositionMonitor - the decision is taken synchronously on the event, persistence is
 *         asynchronous; exits go straight to the idempotent paper close.
 *
 * Usage (from apps/worker): npx tsx scripts/exit-latency-benchmark.ts
 */
import { randomUUID } from 'node:crypto';

import { Prisma, PrismaClient } from '@prisma/client';
import { RollingPercentiles } from '@soltrader/trading-engine';

import { HotPositionMonitor, type MarketEvent } from '../src/exit/hot-position-monitor.js';
import { PositionManager } from '../src/position-manager.js';
import { createPrismaPositionStore } from '../src/position-store.js';

const prisma = new PrismaClient();
const runId = randomUUID().slice(0, 8);
const OLD_TICK_MS = 1_000;
const fmt = (summary: { p50: number | null; p95: number | null; p99: number | null }) => `P50 ${summary.p50?.toFixed(3)} ms | P95 ${summary.p95?.toFixed(3)} ms | P99 ${summary.p99?.toFixed(3)} ms`;

async function createPosition(userId: string, tokenId: string, index: number) {
  const position = await prisma.position.create({ data: {
    userId, tokenId, mode: 'PAPER', side: 'BUY', status: 'OPEN', quantity: new Prisma.Decimal(1), avgEntryPrice: new Prisma.Decimal(100), entryMarketPrice: new Prisma.Decimal(99.5), currentPrice: new Prisma.Decimal(100),
    stopLossPrice: new Prisma.Decimal(82), takeProfitPrice: new Prisma.Decimal(125), trailingStopPercent: new Prisma.Decimal(0.08), trailingActivationPercent: new Prisma.Decimal(0.15), breakEvenActivationPercent: new Prisma.Decimal(0.1),
    highestPrice: new Prisma.Decimal(100), lowestPrice: new Prisma.Decimal(100), exitPolicy: 'NEW_LAUNCH', entryLiquidityUsd: new Prisma.Decimal(1_000_000),
  } });
  await prisma.trade.create({ data: { userId, tokenId, positionId: position.id, side: 'BUY', tokenAddress: `BENCH${runId}`, symbol: `B${index}`, quantity: new Prisma.Decimal(1), size: new Prisma.Decimal(100), entry: new Prisma.Decimal(100), fees: new Prisma.Decimal(0.3), slippage: new Prisma.Decimal(0.5), status: 'OPEN', decisionSource: 'NEW_LAUNCH', mode: 'PAPER' } as never });
  return position;
}

async function main() {
  const user = await prisma.user.create({ data: { email: `exit-bench-${runId}@soltrader.test` } });
  await prisma.paperAccount.create({ data: { userId: user.id, initialBalance: 10_000, cashBalance: 10_000, equity: 10_000 } });
  const token = await prisma.token.create({ data: { address: `BENCH${runId}`, symbol: 'BENCH' } });
  try {
    const store = createPrismaPositionStore(prisma, { userId: user.id, publishEvent: async () => undefined });
    const manager = new PositionManager(store);

    // ---------------- BEFORE ----------------
    const benchPosition = await createPosition(user.id, token.id, 0);
    const readPhase = new RollingPercentiles();
    const fullTick = new RollingPercentiles();
    const evaluation = new RollingPercentiles();
    for (let index = 0; index < 150; index += 1) {
      const start = globalThis.performance.now();
      await prisma.position.findMany({ where: { userId: user.id, status: 'OPEN', mode: 'PAPER', exitPolicy: 'NEW_LAUNCH' }, select: { id: true, token: { select: { address: true } } } });
      const rows = await store.getOpenPositions();
      const afterReads = globalThis.performance.now();
      const evalStart = globalThis.performance.now();
      manager.evaluatePosition(rows[0], { price: 101 + (index % 5), liquidityUsd: 1_000_000, timestamp: Date.now(), sourceTimestamp: null, receivedAt: Date.now(), slot: null, eventId: null, source: 'BENCH' }, new Date());
      evaluation.add(globalThis.performance.now() - evalStart);
      readPhase.add(afterReads - start);
      await manager.reconcileMarket({ [token.address]: { price: 101 + (index % 5), liquidityUsd: 1_000_000, timestamp: new Date() } }, new Date(), { positionFilter: (position) => position.id === benchPosition.id, skipRiskChecks: true });
      fullTick.add(globalThis.performance.now() - start);
    }
    // Event -> decision of the old loop: uniform wait for the next 1 s tick + the database reads + evaluation.
    const oldDetection = new RollingPercentiles(20_000);
    const reads = Array.from({ length: 2_000 }, () => readPhase.percentile(Math.random())!);
    for (let index = 0; index < 20_000; index += 1) oldDetection.add(Math.random() * OLD_TICK_MS + reads[index % reads.length] + (evaluation.percentile(0.5) ?? 0));
    console.log('BEFORE (1 s polling loop with DB reads before every decision)');
    console.log('  DB reads before the decision      ', fmt(readPhase.summary()));
    console.log('  full tick (reads + eval + writes) ', fmt(fullTick.summary()));
    console.log('  exit evaluation (CPU)             ', fmt(evaluation.summary()));
    console.log('  market event -> decision          ', fmt(oldDetection.summary()), '(tick wait simulated uniformly, DB reads measured)');
    await prisma.position.update({ where: { id: benchPosition.id }, data: { status: 'CLOSED', closedAt: new Date() } });

    // ---------------- AFTER ----------------
    const decision = new RollingPercentiles(20_000);
    const triggerToFill = new RollingPercentiles();
    const triggerToRequest = new RollingPercentiles();
    let slot = 1;
    for (let round = 0; round < 25; round += 1) {
      const position = await createPosition(user.id, token.id, round + 1);
      const timing: { triggeredHr?: number; requestedHr?: number } = {};
      const monitor = new HotPositionMonitor({
        manager: {
          evaluatePosition: (...args) => manager.evaluatePosition(...args),
          closeEvaluated: async (...args) => {
            timing.requestedHr = globalThis.performance.now();
            await manager.closeEvaluated(...args);
          },
        },
        loadOpenPositions: () => store.getOpenPositions({ exitPolicy: 'NEW_LAUNCH' }),
        persist: (id, updates) => store.updatePosition(id, updates),
        streamStatus: () => ({ state: 'ACTIVE', lastEventAt: Date.now() }),
        latestStreamEvent: () => null,
        pollQuote: async () => null,
        isActive: () => true,
        logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      }, { resyncMs: 60_000, watchdogMs: 60_000 });
      await monitor.start();
      const event = (price: number): MarketEvent => ({ mint: token.address, price, liquidityUsd: 1_000_000, marketTimestamp: Date.now(), sourceTimestamp: null, receivedAt: Date.now(), slot: slot++, eventId: null, source: 'BENCH' });
      for (let index = 0; index < 400; index += 1) {
        const start = globalThis.performance.now();
        monitor.onMarketEvent(event(101 + index * 0.01));
        decision.add(globalThis.performance.now() - start);
      }
      if (round === 0) console.log('  (evaluations', monitor.snapshot().evaluations, 'of', monitor.snapshot().eventsReceived, 'events)');
      timing.triggeredHr = globalThis.performance.now();
      monitor.onMarketEvent(event(80));
      for (let wait = 0; wait < 200 && monitor.snapshot().exitsFilled === 0; wait += 1) await new Promise((resolve) => globalThis.setTimeout(resolve, 5));
      if (timing.requestedHr) triggerToRequest.add(timing.requestedHr - timing.triggeredHr);
      const filled = monitor.snapshot().triggerToFillMs;
      if (filled.p50 !== null) triggerToFill.add(filled.p50);
      await monitor.stop();
      const row = await prisma.position.findUniqueOrThrow({ where: { id: position.id } });
      if (row.status !== 'CLOSED') throw new Error('position not closed');
    }
    console.log('AFTER (event-driven hot monitor, async persistence)');
    console.log('  market event -> decision          ', fmt(decision.summary()), `(n=${decision.count}, includes scheduling async persistence)`);
    console.log('  trigger -> execution request      ', fmt(triggerToRequest.summary()));
    console.log('  trigger -> paper fill (DB tx)     ', fmt(triggerToFill.summary()), `(n=${triggerToFill.count}, PAPER latency mode NONE)`);
  } finally {
    const positions = await prisma.position.findMany({ where: { userId: user.id }, select: { id: true } });
    const ids = positions.map((position) => position.id);
    await prisma.positionEvent.deleteMany({ where: { positionId: { in: ids } } });
    await prisma.positionPathMetric.deleteMany({ where: { positionId: { in: ids } } });
    await prisma.trade.deleteMany({ where: { userId: user.id } });
    await prisma.position.deleteMany({ where: { userId: user.id } });
    await prisma.auditLog.deleteMany({ where: { userId: user.id } });
    await prisma.paperAccount.deleteMany({ where: { userId: user.id } });
    await prisma.token.delete({ where: { id: token.id } });
    await prisma.user.delete({ where: { id: user.id } });
    await prisma.$disconnect();
  }
}

void main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exitCode = 1;
});
