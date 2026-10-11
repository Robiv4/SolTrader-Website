/* eslint-disable @typescript-eslint/no-explicit-any -- in-memory prisma fake */
/**
 * ML shadow outcome lifecycle (real MlShadowService, simulated clock and trade stream):
 * continuous stream -> COMPLETE after 60 min; stream outage -> gap -> PARTIAL; worker restart -> resume -> finalised;
 * health snapshot published to Redis.
 */
import { describe, expect, it } from 'vitest';

import { ProgramLogsSubscription } from '../src/launch/providers.js';
import { MlShadowService, startMlHealthPublisher, type MlLaunchView } from '../src/ml/ml-shadow-service.js';

const logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

/** In-memory store with the subset of Prisma the ML service uses (rows keyed like the real unique keys). */
/** Clock used for createdAt of stored rows (set by the scenario). */
const createdAtClock = { now: Date.parse('2026-10-09T10:00:00Z') };

function store() {
  const snapshots = new Map<string, any>();
  const outcomes = new Map<string, any>();
  let id = 0;
  const prisma = {
    mlFeatureSnapshot: { create: async ({ data }: any) => { const row = { id: `snap-${++id}`, ...data }; snapshots.set(row.id, row); return { id: row.id }; } },
    mlCandidateOutcome: {
      create: async ({ data }: any) => { if (outcomes.has(data.snapshotId)) throw new Error('unique violation'); outcomes.set(data.snapshotId, { ...data, createdAt: new Date(createdAtClock.now) }); return data; },
      update: async ({ where, data }: any) => { const row = outcomes.get(where.snapshotId); if (!row) throw new Error('Record to update not found'); outcomes.set(where.snapshotId, { ...row, ...data }); return row; },
      findMany: async ({ where, take, skip, cursor }: any) => {
        let rows = [...outcomes.values()].filter((row) => (!where?.status || row.status === where.status) && (!where?.createdAt?.lt || row.createdAt < where.createdAt.lt)).sort((a, b) => a.snapshotId.localeCompare(b.snapshotId));
        if (cursor) rows = rows.slice(rows.findIndex((row) => row.snapshotId === cursor.snapshotId) + (skip ?? 0));
        return rows.slice(0, take ?? rows.length).map((row) => ({ snapshotId: row.snapshotId, mint: row.mint, path: JSON.parse(JSON.stringify(row.path)), snapshot: { source: snapshots.get(row.snapshotId)?.source ?? 'PUMP_FUN' } }));
      },
    },
    mlPrediction: { create: async () => ({}) },
    mlModelVersion: { findFirst: async () => null },
  };
  return { prisma, snapshots, outcomes };
}

function harness(db: ReturnType<typeof store>, clock: { now: number }, mints: string[]) {
  const service = new MlShadowService({ prisma: db.prisma as any, logger, mode: 'SHADOW', repoRoot: process.cwd(), now: () => clock.now });
  const detected = new Map(mints.map((mint) => [mint, clock.now]));
  service.attach({
    launches: () => [...detected.entries()].filter(([, at]) => clock.now - at < 10 * 60_000).map(([mint, at]): MlLaunchView => ({ mint, source: 'PUMP_FUN', detectedAt: at, createdAt: at - 1_000, firstTradeAt: at, creator: 'creator', hasStream: true, migrated: false })),
    state: (mint) => ({ mint, detectedAt: detected.get(mint)!, createdAt: null, observations: [{ takenAt: clock.now, priceUsd: 0.00001, liquidityUsd: 9_000, buyCount: 6, sellCount: 1, volumeUsd: 400, buyVolumeUsd: 350, sellVolumeUsd: 50, uniqueBuyers: 6, uniqueSellers: 1 }], largestBuyerShare: 0.2, buysPerBuyer: 1, creatorSoldRatio: 0, largestHolderSupplyShare: 0.05, priceImpactPercent: 1, observedSellers: 1 }),
    impact: () => 1, security: () => null, candidateId: async (mint) => `cand-${mint}`,
  });
  return service;
}

/** Advances time in 1 s steps: one trade per mint per second (unless the stream is down), a tick every 2 s. */
async function run(service: MlShadowService, clock: { now: number }, mints: string[], seconds: number, options: { streamDownFrom?: number; streamDownTo?: number; price?: (mint: string, t: number) => number } = {}) {
  const start = clock.now;
  for (let s = 0; s < seconds; s += 1) {
    clock.now += 1_000;
    createdAtClock.now = clock.now;
    const t = clock.now - start;
    const down = options.streamDownFrom !== undefined && t >= options.streamDownFrom * 1000 && t < (options.streamDownTo ?? Infinity) * 1000;
    if (!down) {
      for (const mint of mints) {
        const price = options.price?.(mint, t) ?? 0.00001;
        // price = virtualSol / virtualToken * solUsd (solUsd = 100)
        service.onTrade({ mint, wallet: 'w', isBuy: true, virtualSolReserves: price * 1e9 / 100, virtualTokenReserves: 1e9, realSolReserves: 5, receivedAt: clock.now }, 100);
      }
    }
    if (s % 2 === 0) service.onTick(clock.now);
    if (s % 30 === 0) await service.flush();
  }
  await service.flush();
}

describe('ML shadow outcome lifecycle', () => {
  it('continuous stream: AGE_30S outcome is finalised COMPLETE after 60 minutes', async () => {
    const clock = { now: Date.parse('2026-10-09T10:00:00Z') };
    const db = store();
    const mints = ['MintA'];
    const service = harness(db, clock, mints);
    await run(service, clock, mints, 3_700);
    const outcome = [...db.outcomes.values()][0];
    expect(outcome.status).toBe('COMPLETE');
    expect(outcome.validHorizons).toContain(1800);
    expect(service.snapshot().trackedPaths).toBe(0);
  }, 60_000);

  it('stream outage (WebSocket reconnect > 15 s) inside the 30-minute window -> PARTIAL, label still known if decided before the gap', async () => {
    const clock = { now: Date.parse('2026-10-09T10:00:00Z') };
    const db = store();
    const mints = ['MintB'];
    const service = harness(db, clock, mints);
    // +30 % at minute 2 (decided before the outage at minute 10).
    await run(service, clock, mints, 3_700, { streamDownFrom: 600, streamDownTo: 640, price: (_mint, t) => (t > 150_000 ? 0.000013 : 0.00001) });
    const outcome = [...db.outcomes.values()][0];
    expect(outcome.status).toBe('PARTIAL');
    expect(outcome.result.pathLabels.plus20BeforeMinus10).toBe(true);
    expect(outcome.path.gaps.length).toBe(1);
  }, 60_000);

  it('short reconnect (< 15 s silence) is still recorded as a gap when the provider reports the disconnect', async () => {
    const clock = { now: Date.parse('2026-10-09T10:00:00Z') };
    const db = store();
    const mints = ['MintC'];
    const service = harness(db, clock, mints);
    await run(service, clock, mints, 120);
    service.onStreamDown(clock.now);
    await run(service, clock, mints, 5, { streamDownFrom: 0, streamDownTo: 5 });
    service.onStreamUp(clock.now);
    await run(service, clock, mints, 3_600);
    const outcome = [...db.outcomes.values()][0];
    expect(outcome.path.gaps.length).toBe(1);
    expect(outcome.status).toBe('PARTIAL');
  }, 60_000);

  it('worker restart: TRACKING rows are resumed; the downtime gap starts at the last persisted checkpoint, not at the snapshot', async () => {
    const clock = { now: Date.parse('2026-10-09T10:00:00Z') };
    const db = store();
    const mints = ['MintD'];
    const first = harness(db, clock, mints);
    await run(first, clock, mints, 700); // checkpoints at 130 s and 610 s persisted
    expect([...db.outcomes.values()][0].status).toBe('TRACKING');
    // Restart: 5 minutes down, then a new process resumes.
    clock.now += 300_000;
    const second = harness(db, clock, []);
    await second.resume();
    await run(second, clock, mints, 3_000);
    const outcome = [...db.outcomes.values()][0];
    expect(outcome.status).not.toBe('TRACKING');
    // Data until the last checkpoint (~610 s after the snapshot) stays valid: 5-minute horizon valid.
    expect(outcome.validHorizons).toContain(300);
    expect(outcome.path.gaps[0][0] - outcome.path.startAt).toBeGreaterThanOrEqual(600_000);
  }, 60_000);

  it('stale TRACKING rows (older than 60 min at startup) are finalised by resume, not left TRACKING', async () => {
    const clock = { now: Date.parse('2026-10-09T10:00:00Z') };
    const db = store();
    const mints = ['MintE'];
    const first = harness(db, clock, mints);
    await run(first, clock, mints, 200);
    clock.now += 2 * 3_600_000;
    const second = harness(db, clock, []);
    await second.resume();
    await second.flush();
    expect([...db.outcomes.values()][0].status).not.toBe('TRACKING');
  }, 60_000);

  it('a failing final write is retried (not silently lost, row does not stay TRACKING forever)', async () => {
    const clock = { now: Date.parse('2026-10-09T10:00:00Z') };
    const db = store();
    const mints = ['MintF'];
    const service = harness(db, clock, mints);
    const update = db.prisma.mlCandidateOutcome.update;
    let failNext = false;
    db.prisma.mlCandidateOutcome.update = async (args: any) => {
      if (failNext && args.data.status !== 'TRACKING') {
        failNext = false;
        throw new Error('connection reset');
      }
      return update(args);
    };
    await run(service, clock, mints, 3_590);
    failNext = true;
    await run(service, clock, mints, 120);
    expect([...db.outcomes.values()][0].status).toBe('COMPLETE');
  }, 60_000);
});

describe('ML shadow outcome lifecycle: quiet token restart', () => {
  it('quiet token (no trades after the snapshot): a restart at minute 20 keeps the first ~10 minutes valid', async () => {
    const clock = { now: Date.parse('2026-10-09T10:00:00Z') };
    const db = store();
    const first = harness(db, clock, ['QuietMint']);
    // Trades for the token only before the snapshot; afterwards only other tokens trade (stream healthy).
    await run(first, clock, ['QuietMint'], 31);
    await run(first, clock, ['OtherMint'], 1_170);
    clock.now += 60_000;
    const second = harness(db, clock, []);
    await second.resume();
    await run(second, clock, ['OtherMint'], 3_000);
    const outcome = [...db.outcomes.values()].find((row) => row.mint === 'QuietMint');
    expect(outcome.status).toBe('PARTIAL');
    expect(outcome.validHorizons).toContain(600);
  }, 60_000);
});

describe('ML shadow: orphans, health, stream status, paged resume', () => {
  it('orphan sweep: a TRACKING row no process owns (lost state) is finalised after 70 minutes, not left TRACKING', async () => {
    const clock = { now: Date.parse('2026-10-09T10:00:00Z') };
    const db = store();
    const lost = harness(db, clock, ['OrphanMint']);
    await run(lost, clock, ['OrphanMint'], 200);
    // The owning process is gone without a restart-resume (e.g. state lost); a new service only sweeps.
    const other = harness(db, clock, []);
    await run(other, clock, ['OtherMint'], 4_500);
    await other.flush();
    const outcome = [...db.outcomes.values()].find((row) => row.mint === 'OrphanMint');
    expect(outcome.status).not.toBe('TRACKING');
    expect(outcome.endReason).toBe('ORPHANED_TRACKING');
    expect(other.snapshot().orphansFinalized).toBe(1);
  }, 60_000);

  it('resume pages through many TRACKING rows (no silent single huge query)', async () => {
    const clock = { now: Date.parse('2026-10-09T10:00:00Z') };
    const db = store();
    for (let index = 0; index < 450; index += 1) {
      db.outcomes.set(`s${String(index).padStart(4, '0')}`, { snapshotId: `s${String(index).padStart(4, '0')}`, mint: `M${index}`, status: 'TRACKING', createdAt: new Date(clock.now), path: { startAt: clock.now - 600_000, entryPrice: 1, entryLiquidity: null, buckets: [], gaps: [], endedAt: null, endReason: null, creatorSellAt: null, persistedAt: clock.now - 30_000 } });
    }
    const service = harness(db, clock, []);
    await service.resume();
    expect(service.snapshot().resumedPaths).toBe(450);
    expect(service.snapshot().trackedPaths).toBe(450);
  });

  it('ml:health: published immediately and every interval with a 60 s TTL; a failing Redis never throws', async () => {
    const writes: Array<{ key: string; value: string; options: { EX: number } }> = [];
    const service = harness(store(), { now: Date.now() }, []);
    const timer = startMlHealthPublisher(service, async (key, value, options) => { writes.push({ key, value, options }); }, 20);
    await new Promise((resolve) => globalThis.setTimeout(resolve, 70));
    globalThis.clearInterval(timer);
    expect(writes.length).toBeGreaterThanOrEqual(3);
    expect(writes[0]).toMatchObject({ key: 'ml:health', options: { EX: 60 } });
    expect(JSON.parse(writes[0].value)).toMatchObject({ mode: 'SHADOW', featureVersion: 'ML-FEATURES-v1' });
    const errors: unknown[] = [];
    const failing = startMlHealthPublisher(service, async () => { throw new Error('redis down'); }, 20, (error) => errors.push(error));
    await new Promise((resolve) => globalThis.setTimeout(resolve, 50));
    globalThis.clearInterval(failing);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('WebSocket subscription reports DOWN on close and UP after re-subscribe (exact gaps for ML)', async () => {
    const sockets: any[] = [];
    const factory = () => {
      const socket: any = { send: () => undefined, close: () => undefined, onopen: null, onmessage: null, onerror: null, onclose: null };
      sockets.push(socket);
      return socket;
    };
    const statuses: string[] = [];
    const subscription = new ProgramLogsSubscription('wss://test', 'Program1', () => undefined, logger as any, factory as any, (state) => statuses.push(state));
    subscription.start();
    sockets[0].onopen();
    sockets[0].onmessage({ data: JSON.stringify({ id: 1, result: 7 }) });
    expect(statuses).toEqual([]);
    sockets[0].onclose();
    sockets[0].onclose(); // a duplicate close event does not produce a second DOWN
    expect(statuses).toEqual(['DOWN']);
    subscription.stop();
    // Reconnect manually (the real one waits for the back-off timer).
    (subscription as any).stopped = false;
    (subscription as any).connect();
    sockets.at(-1).onopen();
    sockets.at(-1).onmessage({ data: JSON.stringify({ id: 1, result: 8 }) });
    expect(statuses).toEqual(['DOWN', 'UP']);
    subscription.stop();
  });
});
