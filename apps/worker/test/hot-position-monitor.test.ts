/**
 * Event-driven NewLaunch exit monitor: real PositionManager / Exit Engine, in-memory store with the same
 * conditional OPEN -> CLOSED semantics as the database, controllable clock.
 */
import { describe, expect, it } from 'vitest';

import { coalesceEvents, HotPositionMonitor, type HotPositionMonitorConfig, type MarketEvent, type StreamStatus } from '../src/exit/hot-position-monitor.js';
import { samplePaperLatencyMs } from '../src/exit/paper-latency.js';
import { PositionManager, type PositionManagerStore, type PositionRecord } from '../src/position-manager.js';

type Diagnostics = Record<string, unknown>;
const T0 = Date.parse('2026-10-02T10:00:00Z');

function makeStore(initial: PositionRecord[], options: { persistDelayMs?: number } = {}) {
  const positions = initial.map((row) => ({ ...row }));
  const closes: Array<{ id: string; updates: Partial<PositionRecord> }> = [];
  const persisted: Array<Partial<PositionRecord>> = [];
  const store: PositionManagerStore = {
    async getOpenPositions() {
      return positions.filter((row) => row.status === 'OPEN').map((row) => ({ ...row }));
    },
    async updatePosition(id, patch) {
      if (options.persistDelayMs) await new Promise((resolve) => globalThis.setTimeout(resolve, options.persistDelayMs));
      persisted.push(patch);
      const index = positions.findIndex((row) => row.id === id && row.status === 'OPEN');
      if (index >= 0) Object.assign(positions[index], { ...patch, positionEvents: undefined });
    },
    async closePosition(id, patch) {
      const index = positions.findIndex((row) => row.id === id && row.status === 'OPEN');
      if (index < 0) return;
      closes.push({ id, updates: patch });
      positions[index] = { ...positions[index], ...patch, status: 'CLOSED' };
    },
    async publishEvent() { /* not needed */ },
  };
  return { store, positions, closes, persisted };
}

/** NewLaunch-like: entry fill 100, SL 82 (18%), TP 125, BE +10% (0.6%), trailing 8% after +15%. */
function launchPosition(overrides: Partial<PositionRecord> = {}): PositionRecord {
  return {
    id: 'nl-1', userId: 'user-1', token: 'MINT', symbol: 'MNT', side: 'BUY', quantity: 1, avgEntryPrice: 100, currentPrice: 100,
    stopLoss: 82, takeProfit: 125, trailingStop: 0.08, trailingActivation: 0.15, breakEvenActivation: 0.1, breakEvenCostBuffer: 0.006,
    highestPrice: 100, lowestPrice: 100, status: 'OPEN', exitPolicy: 'NEW_LAUNCH', entryLiquidityUsd: 1_000_000, openedAt: new Date(T0 - 60_000),
    ...overrides,
  };
}

function harness(initial: PositionRecord[], options: { config?: Partial<HotPositionMonitorConfig>; persistDelayMs?: number; stream?: () => StreamStatus; poll?: (mint: string) => Promise<MarketEvent | null>; store?: ReturnType<typeof makeStore>; latest?: (mint: string) => MarketEvent | null } = {}) {
  const fixture = options.store ?? makeStore(initial, { persistDelayMs: options.persistDelayMs });
  const clock = { now: T0 };
  let slot = 1_000;
  const logs: string[] = [];
  const polls: string[] = [];
  const sleeps: number[] = [];
  const hooks: { duringSleep?: () => void } = {};
  const manager = new PositionManager(fixture.store);
  const monitor = new HotPositionMonitor({
    manager,
    loadOpenPositions: () => fixture.store.getOpenPositions({ exitPolicy: 'NEW_LAUNCH' }),
    persist: (id, updates) => fixture.store.updatePosition(id, updates),
    streamStatus: options.stream ?? (() => ({ state: 'ACTIVE', lastEventAt: clock.now })),
    latestStreamEvent: options.latest ?? (() => null),
    pollQuote: async (mint) => {
      polls.push(mint);
      return options.poll ? options.poll(mint) : null;
    },
    isActive: () => true,
    logger: { info: (_payload, message) => logs.push(String(message)), warn: (_payload, message) => logs.push(String(message)), error: (_payload, message) => logs.push(String(message)) },
    now: () => clock.now,
    sleep: async (ms) => {
      sleeps.push(ms);
      hooks.duringSleep?.();
      clock.now += ms;
    },
  }, { persistThrottleMs: 5, ...options.config });
  const event = (price: number, overrides: Partial<MarketEvent> = {}): MarketEvent => {
    clock.now += 10;
    slot += 1;
    return { mint: 'MINT', price, liquidityUsd: 1_000_000, marketTimestamp: clock.now, sourceTimestamp: null, receivedAt: clock.now, slot, eventId: `sig-${slot}`, source: 'PUMP_FUN_STREAM', ...overrides };
  };
  const settle = () => new Promise((resolve) => globalThis.setTimeout(resolve, 20));
  return { fixture, monitor, clock, event, settle, logs, polls, sleeps, hooks };
}

describe('hot position monitor (event-driven exits)', () => {
  it('fast TP cross 120, 123, 126, 124, 121: TP touch recorded at 126 and exactly one exit', async () => {
    const h = harness([launchPosition()]);
    await h.monitor.start();
    for (const price of [120, 123, 126, 124, 121]) h.monitor.onMarketEvent(h.event(price));
    await h.settle();
    expect(h.fixture.closes).toHaveLength(1);
    const close = h.fixture.closes[0].updates;
    expect(close.exitReason).toBe('TAKE_PROFIT');
    const diagnostics = close.exitDiagnostics as Diagnostics;
    expect(diagnostics.takeProfitFirstTouchPrice).toBe(126);
    expect(diagnostics.marketPriceAtTrigger).toBe(126);
    expect(diagnostics.exitTriggerPrice).toBe(125);
    expect(close.positionEvents?.some((item) => item.type === 'TAKE_PROFIT_TOUCHED' && item.price === 126)).toBe(true);
    await h.monitor.stop();
  });

  it('coalescing keeps exit-relevant extremes (a burst ending at 121 still contains the 126 touch)', () => {
    const events = [120, 123, 126, 124, 121, 122].map((price, index) => ({ mint: 'M', price, liquidityUsd: null, marketTimestamp: index, sourceTimestamp: null, receivedAt: index, slot: index, eventId: null, source: 'S' }));
    const { kept, dropped } = coalesceEvents(events);
    expect(kept.map((event) => event.price)).toEqual([120, 126, 122]);
    expect(dropped).toBe(3);
  });

  it('126, 127, 128 in a burst: one trigger, one sell, one fill', async () => {
    const h = harness([launchPosition()]);
    await h.monitor.start();
    for (const price of [126, 127, 128]) h.monitor.onMarketEvent(h.event(price));
    await h.settle();
    expect(h.fixture.closes).toHaveLength(1);
    expect(h.monitor.snapshot().exitsTriggered).toBe(1);
    await h.monitor.stop();
  });

  it('out-of-order: slot 101 @130 then slot 100 @120 never lowers the highest price or the trailing stop', async () => {
    const h = harness([launchPosition({ takeProfit: 1_000 })]);
    await h.monitor.start();
    h.monitor.onMarketEvent(h.event(130, { slot: 101 }));
    h.monitor.onMarketEvent(h.event(120, { slot: 100 }));
    const state = h.monitor.hotState('nl-1')!;
    expect(state.highestPrice).toBe(130);
    expect(state.trailingTriggerPrice).toBeCloseTo(119.6, 10);
    expect(state.currentPrice).toBe(130);
    expect(h.monitor.snapshot().outOfOrderEvents).toBe(1);
    expect(h.fixture.closes).toHaveLength(0);
    await h.monitor.stop();
  });

  it('stream failure: health leaves CONNECTED, fallback polling protects the position', async () => {
    let status: StreamStatus = { state: 'ACTIVE', lastEventAt: T0 };
    const h = harness([launchPosition()], { stream: () => status, poll: async () => ({ mint: 'MINT', price: 80, liquidityUsd: 1_000_000, marketTimestamp: h.clock.now, sourceTimestamp: h.clock.now, receivedAt: h.clock.now, slot: null, eventId: null, source: 'POLL' }) });
    await h.monitor.start();
    status = { state: 'DEGRADED', lastEventAt: T0 - 60_000 };
    h.clock.now += 10_000;
    await h.monitor.watchdog();
    await h.settle();
    expect(h.monitor.snapshot().health).toBe('FALLBACK_POLLING');
    expect(h.polls).toEqual(['MINT']);
    expect(h.fixture.closes).toHaveLength(1);
    expect(h.fixture.closes[0].updates.exitReason).toBe('STOP_LOSS');
    await h.monitor.stop();
  });

  it('stream recovery: back to CONNECTED, polling stops, a stream + poll report of the same move closes once', async () => {
    let status: StreamStatus = { state: 'DISCONNECTED', lastEventAt: null };
    let pollPrice = 105;
    const h = harness([launchPosition()], { stream: () => status, poll: async () => ({ mint: 'MINT', price: pollPrice, liquidityUsd: 1_000_000, marketTimestamp: h.clock.now, sourceTimestamp: null, receivedAt: h.clock.now, slot: null, eventId: null, source: 'POLL' }) });
    await h.monitor.start();
    await h.monitor.watchdog();
    expect(h.monitor.snapshot().health).toBe('FALLBACK_POLLING');
    expect(h.polls).toHaveLength(1);
    // Stream reconnects and delivers events again.
    status = { state: 'ACTIVE', lastEventAt: h.clock.now };
    h.monitor.onMarketEvent(h.event(106));
    status = { state: 'ACTIVE', lastEventAt: h.clock.now };
    (h.monitor as unknown as { deps: { latestStreamEvent: () => MarketEvent } }).deps.latestStreamEvent = () => h.event(106);
    h.clock.now += 5_000;
    status = { state: 'ACTIVE', lastEventAt: h.clock.now };
    await h.monitor.watchdog();
    expect(h.monitor.snapshot().health).toBe('CONNECTED');
    expect(h.polls).toHaveLength(1);
    // The same crash seen by the stream and by a late poll: one exit only.
    h.monitor.onMarketEvent(h.event(80));
    pollPrice = 80;
    h.monitor.onMarketEvent({ mint: 'MINT', price: 80, liquidityUsd: 1_000_000, marketTimestamp: h.clock.now, sourceTimestamp: null, receivedAt: h.clock.now, slot: null, eventId: null, source: 'POLL' });
    await h.settle();
    expect(h.fixture.closes).toHaveLength(1);
    await h.monitor.stop();
  });

  it('restart: break-even, trailing and highest price are reconstructed from the store', async () => {
    const stored = launchPosition({ takeProfit: 1_000, highestPrice: 130, stopLoss: 100.6, breakEvenAppliedAt: new Date(T0 - 30_000), trailingActive: true, trailingActivatedAt: new Date(T0 - 20_000), trailingActivationPrice: 116, trailingTriggerPrice: 119.6 });
    const h = harness([stored]);
    await h.monitor.start();
    const state = h.monitor.hotState('nl-1')!;
    expect(state.highestPrice).toBe(130);
    expect(state.trailingTriggerPrice).toBe(119.6);
    expect(state.breakEvenAppliedAt).toBeTruthy();
    h.monitor.onMarketEvent(h.event(121));
    expect(h.fixture.closes).toHaveLength(0);
    h.monitor.onMarketEvent(h.event(119));
    await h.settle();
    expect(h.fixture.closes).toHaveLength(1);
    expect(h.fixture.closes[0].updates.exitReason).toBe('TRAILING_STOP');
    expect((h.fixture.closes[0].updates.exitDiagnostics as Diagnostics).exitTriggerPrice).toBeCloseTo(119.6, 10);
    await h.monitor.stop();
  });

  it('TP touch at +28% then a fall to +15% during a 500 ms simulated execution: touch recorded, fill at the fill-time price', async () => {
    const h = harness([launchPosition()], { config: { paperLatency: { mode: 'FIXED', fixedMs: 500 } } });
    await h.monitor.start();
    h.hooks.duringSleep = () => {
      h.monitor.onMarketEvent(h.event(119)); // arrives during the execution delay
      h.monitor.onMarketEvent(h.event(115));
    };
    h.monitor.onMarketEvent(h.event(128));
    await h.settle();
    expect(h.sleeps).toEqual([500]);
    expect(h.fixture.closes).toHaveLength(1);
    const close = h.fixture.closes[0].updates;
    const diagnostics = close.exitDiagnostics as Diagnostics;
    expect(close.exitReason).toBe('TAKE_PROFIT');
    expect(diagnostics.takeProfitFirstTouchPrice).toBe(128);
    expect(diagnostics.marketPriceAtTrigger).toBe(128);
    expect(diagnostics.requestedExitPrice).toBe(115);
    expect(close.currentPrice).toBe(115);
    expect(diagnostics.paperExecutionSimulatedLatencyMs).toBe(500);
    await h.monitor.stop();
  });

  it('no lookahead: an event received after the simulated execution time is never used for the fill', async () => {
    const h = harness([launchPosition()], { config: { paperLatency: { mode: 'FIXED', fixedMs: 500 } } });
    await h.monitor.start();
    h.hooks.duringSleep = () => {
      h.monitor.onMarketEvent(h.event(112));
      // A (mis-timestamped) event "from the future": received after the fill moment.
      h.monitor.onMarketEvent({ ...h.event(150), receivedAt: h.clock.now + 10_000, marketTimestamp: h.clock.now + 10_000 });
    };
    h.monitor.onMarketEvent(h.event(126));
    await h.settle();
    expect(h.fixture.closes[0].updates.currentPrice).toBe(112);
    await h.monitor.stop();
  });

  it('gap through the stop: trigger stays at the level, the fill uses the next executable price', async () => {
    const h = harness([launchPosition()]);
    await h.monitor.start();
    h.monitor.onMarketEvent(h.event(70));
    await h.settle();
    const close = h.fixture.closes[0].updates;
    const diagnostics = close.exitDiagnostics as Diagnostics;
    expect(diagnostics.exitTriggerPrice).toBe(82);
    expect(diagnostics.marketPriceAtTrigger).toBe(70);
    expect(close.currentPrice).toBe(70);
    // The modelled impact is handed to the paper fill once (closePaperPosition applies it to currentPrice).
    expect(diagnostics.exitPriceImpactPercent).toBe(close.exitSlippagePercent);
    await h.monitor.stop();
  });

  it('slow persistence never delays the exit decision', async () => {
    const h = harness([launchPosition()], { persistDelayMs: 2_000 });
    await h.monitor.start();
    h.monitor.onMarketEvent(h.event(111)); // break-even applied -> critical persist starts (slow)
    const started = Date.now();
    h.monitor.onMarketEvent(h.event(100.5)); // break-even stop breached
    await new Promise((resolve) => globalThis.setTimeout(resolve, 20));
    expect(Date.now() - started).toBeLessThan(500);
    expect(h.fixture.closes).toHaveLength(1);
    expect(h.fixture.closes[0].updates.exitReason).toBe('BREAK_EVEN_STOP');
    await h.monitor.stop();
  }, 10_000);

  it('two workers observing the same trigger produce one exit', async () => {
    const shared = makeStore([launchPosition()]);
    const a = harness([], { store: shared });
    const b = harness([], { store: shared });
    await a.monitor.start();
    await b.monitor.start();
    a.monitor.onMarketEvent(a.event(70));
    b.monitor.onMarketEvent(b.event(70));
    await a.settle();
    expect(shared.closes).toHaveLength(1);
    await a.monitor.stop();
    await b.monitor.stop();
  });

  it('high event rate: bounded queue, no stale-event corruption, the crossing is not missed, one exit', async () => {
    const h = harness([launchPosition({ takeProfit: 1_000 })]);
    await h.monitor.start();
    let price = 105;
    for (let index = 0; index < 20_000; index += 1) {
      price = Math.min(114, Math.max(90, price + (index % 7 === 0 ? -0.5 : 0.3)));
      h.monitor.onMarketEvent(h.event(price));
    }
    const before = h.monitor.hotState('nl-1')!;
    expect(before.highestPrice).toBeLessThanOrEqual(114);
    h.monitor.onMarketEvent(h.event(81));
    for (let index = 0; index < 100; index += 1) h.monitor.onMarketEvent(h.event(95));
    await h.settle();
    const snapshot = h.monitor.snapshot();
    expect(snapshot.maxQueueDepth).toBeLessThanOrEqual(256);
    expect(h.fixture.closes).toHaveLength(1);
    expect(h.fixture.closes[0].updates.exitReason).toBe('BREAK_EVEN_STOP');
    expect(snapshot.evaluationDurationMs.p99).not.toBeNull();
    await h.monitor.stop();
  });

  it('paper latency sampling: NONE keeps the old behaviour, EMPIRICAL follows the configured percentiles', () => {
    expect(samplePaperLatencyMs({ mode: 'NONE' })).toBe(0);
    expect(samplePaperLatencyMs({ mode: 'EMPIRICAL' })).toBe(0);
    expect(samplePaperLatencyMs({ mode: 'FIXED', fixedMs: 300 })).toBe(300);
    expect(samplePaperLatencyMs({ mode: 'RANGE', minMs: 100, maxMs: 300 }, () => 0.5)).toBe(200);
    const empirical = { mode: 'EMPIRICAL' as const, p50Ms: 400, p75Ms: 600, p95Ms: 1_200 };
    expect(samplePaperLatencyMs(empirical, () => 0.5)).toBe(400);
    expect(samplePaperLatencyMs(empirical, () => 0.75)).toBe(600);
    expect(samplePaperLatencyMs(empirical, () => 0.95)).toBe(1_200);
  });

  it('exit capacity after entry: a liquidity collapse records the deterioration, a migrated curve without a pool records SELL_ROUTE_LOST', async () => {
    const h = harness([launchPosition({ takeProfit: 1_000, capacity: { config: null, classAtEntry: 'GOOD', current: 'GOOD', routeStatus: null } })]);
    await h.monitor.start();
    h.monitor.onMarketEvent(h.event(101, { liquidityUsd: 1_000_000 }));
    h.monitor.onMarketEvent(h.event(101.5, { liquidityUsd: 2_000 }));
    h.monitor.onMarketEvent(h.event(102, { liquidityUsd: null, migrated: true, curve: null }));
    await h.settle();
    const events = h.fixture.persisted.flatMap((update) => update.positionEvents ?? []);
    const deteriorated = events.find((event) => event.type === 'EXIT_CAPACITY_DETERIORATED');
    expect(deteriorated?.details).toMatchObject({ from: 'EXCELLENT', classAtEntry: 'GOOD' });
    expect(['MODERATE', 'POOR', 'UNSAFE']).toContain((deteriorated?.details as Record<string, unknown>).to);
    expect(events.some((event) => event.type === 'SELL_ROUTE_LOST')).toBe(true);
    // Diagnostic only: no exit was created by the capacity tracking.
    expect(h.fixture.closes).toHaveLength(0);
    await h.monitor.stop();
  });

  describe('max hold of a silent token (stuck positions MEOWN / CLEVER)', () => {
    const curve = { virtualQuote: 30, virtualBase: 1_000_000_000, realQuote: 5, quoteUsd: 150 };
    const lastTrade = (overrides: Partial<MarketEvent> = {}): MarketEvent => ({ mint: 'MINT', price: 103, liquidityUsd: 9_000, marketTimestamp: T0 - 600_000, sourceTimestamp: null, receivedAt: T0 - 600_000, slot: 5, eventId: 'sig-last', source: 'PUMP_FUN_STREAM', curve, migrated: false, ...overrides });

    it('healthy stream + silent bonding-curve token: max hold closes on the last curve state (the current price)', async () => {
      const h = harness([launchPosition({ maxHoldUntil: new Date(T0 - 1_000) })], { latest: () => lastTrade() });
      await h.monitor.start();
      await h.monitor.watchdog();
      await h.settle();
      expect(h.fixture.closes).toHaveLength(1);
      expect(h.fixture.closes[0].updates.exitReason).toBe('MAX_HOLD_TIME');
      expect(h.monitor.snapshot().maxHoldOnSilentCurve).toBe(1);
      await h.monitor.stop();
    });

    it('migrated token without a fresh quote: no exit at an invented price, waits for a real quote (logged once)', async () => {
      const h = harness([launchPosition({ maxHoldUntil: new Date(T0 - 1_000) })], { latest: () => lastTrade({ migrated: true, curve: null }) });
      await h.monitor.start();
      await h.monitor.watchdog();
      await h.monitor.watchdog();
      await h.settle();
      expect(h.fixture.closes).toHaveLength(0);
      expect(h.monitor.snapshot().maxHoldWaitingForQuote).toBe(1);
      expect(h.polls.length).toBeGreaterThan(0);
      await h.monitor.stop();
    });

    it('no max hold configured (maxHoldUntil null): a silent position between SL and TP stays open (reported by diagnostics)', async () => {
      const h = harness([launchPosition({ maxHoldUntil: null })], { latest: () => lastTrade() });
      await h.monitor.start();
      h.clock.now += 14 * 3_600_000;
      await h.monitor.watchdog();
      await h.settle();
      expect(h.fixture.closes).toHaveLength(0);
      await h.monitor.stop();
    });
  });
});
