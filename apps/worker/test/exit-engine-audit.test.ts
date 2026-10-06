/**
 * Worker-side Exit Engine audit: trigger vs fill recording, exactly-once close under concurrent evaluations,
 * restart safety (state comes only from the store), stale market data diagnostics.
 */
import { describe, expect, it } from 'vitest';

import { PositionManager, type PositionManagerStore, type PositionRecord } from '../src/position-manager.js';

function makeStore(initial: PositionRecord[], options: { slowClose?: boolean } = {}) {
  const positions = initial.map((row) => ({ ...row }));
  const closes: Array<{ id: string; updates: Partial<PositionRecord> }> = [];
  const updates: Array<Partial<PositionRecord>> = [];
  const store: PositionManagerStore = {
    async getOpenPositions() {
      return positions.filter((row) => row.status === 'OPEN').map((row) => ({ ...row }));
    },
    async updatePosition(id, patch) {
      updates.push(patch);
      const index = positions.findIndex((row) => row.id === id && row.userId === patch.userId);
      if (index >= 0) Object.assign(positions[index], patch);
    },
    async closePosition(id, patch) {
      if (options.slowClose) await new Promise((resolve) => globalThis.setTimeout(resolve, 20));
      const index = positions.findIndex((row) => row.id === id && row.userId === patch.userId && row.status === 'OPEN');
      if (index < 0) return;
      closes.push({ id, updates: patch });
      positions[index] = { ...positions[index], ...patch, status: 'CLOSED' };
    },
    async publishEvent() { /* not needed */ },
  };
  return { store, positions, closes, updates };
}

/** NewLaunch-like position: entry fill 100, SL 82, TP 125, BE +10% (buffer 0.6%), trailing 8% after +15%. */
function launchPosition(overrides: Partial<PositionRecord> = {}): PositionRecord {
  return {
    id: 'nl-1', userId: 'user-1', token: 'MINT', symbol: 'MNT', side: 'BUY', quantity: 1, avgEntryPrice: 100, currentPrice: 100,
    stopLoss: 82, takeProfit: 125, trailingStop: 0.08, trailingActivation: 0.15, breakEvenActivation: 0.1, breakEvenCostBuffer: 0.006,
    highestPrice: 100, lowestPrice: 100, status: 'OPEN', exitPolicy: 'NEW_LAUNCH', entryLiquidityUsd: 10_000, openedAt: new Date('2026-10-01T10:00:00Z'),
    ...overrides,
  };
}

/** Exit diagnostics as recorded on the close (values checked numerically / by equality). */
type Diagnostics = Record<string, unknown>;

const at = (seconds: number) => new Date(Date.parse('2026-10-01T10:00:00Z') + seconds * 1000);
const quote = (price: number, seconds: number, liquidityUsd = 10_000) => ({ MINT: { price, liquidityUsd, timestamp: at(seconds) } });

describe('exit trigger vs paper fill', () => {
  it('records trigger level, observed price and modelled impact separately (trigger 100.6, observed 100.5)', async () => {
    const fixture = makeStore([launchPosition()]);
    const manager = new PositionManager(fixture.store);
    await manager.reconcileMarket(quote(111, 1), at(1));
    expect(fixture.positions[0].stopLoss).toBeCloseTo(100.6, 10);
    await manager.reconcileMarket(quote(100.5, 2), at(2));
    expect(fixture.closes).toHaveLength(1);
    const close = fixture.closes[0].updates;
    expect(close.exitReason).toBe('BREAK_EVEN_STOP');
    const diagnostics = close.exitDiagnostics as Diagnostics;
    expect(diagnostics.exitTriggerPrice).toBeCloseTo(100.6, 10);
    expect(diagnostics.requestedExitPrice).toBe(100.5);
    expect(diagnostics.triggerGapPercent).toBeCloseTo((100.5 / 100.6 - 1) * 100, 8);
    expect(diagnostics.stopSource).toBe('BREAK_EVEN');
    expect(diagnostics.exitPriceImpactPercent).toBe(close.exitSlippagePercent);
    expect(diagnostics.exitDataStale).toBe(false);
  });

  it('a crash through the stop records the real gap (trigger 100.6, observed 83 -> -17.5%), never a fill at the stop', async () => {
    const fixture = makeStore([launchPosition()]);
    const manager = new PositionManager(fixture.store);
    await manager.reconcileMarket(quote(111, 1), at(1));
    await manager.reconcileMarket(quote(83, 2, 9_000), at(2));
    const diagnostics = fixture.closes[0].updates.exitDiagnostics as Diagnostics;
    expect(diagnostics.exitTriggerPrice).toBeCloseTo(100.6, 10);
    expect(diagnostics.requestedExitPrice).toBe(83);
    expect(diagnostics.triggerGapPercent).toBeLessThan(-17);
    expect(fixture.closes[0].updates.currentPrice).toBe(83);
  });
});

describe('exactly-once close', () => {
  it('two concurrent evaluations (main monitor + fast exit loop) produce exactly one close', async () => {
    const fixture = makeStore([launchPosition()], { slowClose: true });
    const manager = new PositionManager(fixture.store);
    const [first, second] = await Promise.all([
      manager.reconcileMarket(quote(80, 1), at(1)),
      manager.reconcileMarket(quote(79, 1), at(1), { skipRiskChecks: true }),
    ]);
    expect(fixture.closes).toHaveLength(1);
    expect(first.length + second.length).toBe(1);
    expect(fixture.positions[0].status).toBe('CLOSED');
  });
});

describe('restart safety', () => {
  it('a new manager instance continues from the stored break-even / trailing state', async () => {
    // No take profit here, so +30% only moves the protective stops.
    const fixture = makeStore([launchPosition({ takeProfit: null, takeProfitPercent: 1_000 })]);
    await new PositionManager(fixture.store).reconcileMarket(quote(130, 1), at(1));
    const stored = fixture.positions[0];
    expect(stored.breakEvenAppliedAt).toBeTruthy();
    expect(stored.trailingActive).toBe(true);
    expect(stored.trailingTriggerPrice).toBeCloseTo(119.6, 10);

    // "Restart": a fresh instance has no in-memory state; 121 must not reset or lower anything.
    const restarted = new PositionManager(fixture.store);
    await restarted.reconcileMarket(quote(121, 2), at(2));
    expect(fixture.positions[0].status).toBe('OPEN');
    expect(fixture.positions[0].trailingTriggerPrice).toBeCloseTo(119.6, 10);
    expect(fixture.positions[0].stopLoss).toBeCloseTo(100.6, 10);
    expect(fixture.positions[0].highestPrice).toBe(130);

    await new PositionManager(fixture.store).reconcileMarket(quote(119, 3), at(3));
    expect(fixture.closes).toHaveLength(1);
    expect(fixture.closes[0].updates.exitReason).toBe('TRAILING_STOP');
    expect((fixture.closes[0].updates.exitDiagnostics as Diagnostics).exitTriggerPrice).toBeCloseTo(119.6, 10);
  });
});

describe('stale market data', () => {
  it('flags a quote older than EXIT_MARKET_DATA_MAX_AGE_MS once, and marks an exit on it EXIT_DATA_STALE', async () => {
    const fixture = makeStore([launchPosition()]);
    const manager = new PositionManager(fixture.store, { exitMarketDataMaxAgeMs: 15_000 });
    // Evaluated at t=60s with a quote from t=0s (60 s old).
    await manager.reconcileMarket(quote(105, 0), at(60));
    await manager.reconcileMarket(quote(104, 0), at(61));
    const staleEvents = fixture.updates.flatMap((update) => update.positionEvents ?? []).filter((event) => event.type === 'MARKET_DATA_STALE');
    expect(staleEvents).toHaveLength(1);
    expect(staleEvents[0].details).toMatchObject({ quoteAgeMs: 60_000, maxAgeMs: 15_000 });

    await manager.reconcileMarket(quote(80, 0), at(62));
    const diagnostics = fixture.closes[0].updates.exitDiagnostics as Diagnostics;
    expect(diagnostics.exitDataStale).toBe(true);
    expect(diagnostics.marketDataAgeMs).toBe(62_000);
  });
});

describe('deterministic exit priority: EFFECTIVE_STOP > TAKE_PROFIT > LIQUIDITY_SAFETY > MAX_HOLD_TIME', () => {
  const evaluate = (price: number, liquidityUsd: number, overrides: Partial<PositionRecord> = {}) => {
    const manager = new PositionManager(makeStore([]).store);
    const position = launchPosition({ liquidityOutflowExitPercent: 50, maxHoldUntil: new Date(Date.parse('2026-10-01T09:00:00Z')), ...overrides });
    return manager.evaluatePosition(position, { price, liquidityUsd, timestamp: at(1).getTime(), sourceTimestamp: null, receivedAt: at(1).getTime(), slot: null, eventId: null, source: 'TEST' }, at(1));
  };
  it('stop + liquidity collapse + max hold -> STOP_LOSS (others recorded as conditions)', () => {
    const result = evaluate(80, 1_000);
    expect(result.exitReason).toBe('STOP_LOSS');
    expect(result.exitContext.conditionsTriggered).toEqual(expect.arrayContaining(['STOP_LOSS', 'LIQUIDITY_SAFETY']));
  });
  it('take profit + liquidity collapse -> TAKE_PROFIT', () => {
    expect(evaluate(126, 1_000).exitReason).toBe('TAKE_PROFIT');
  });
  it('liquidity collapse only -> LIQUIDITY_SAFETY before MAX_HOLD_TIME', () => {
    expect(evaluate(101, 1_000).exitReason).toBe('LIQUIDITY_SAFETY');
  });
  it('nothing else -> MAX_HOLD_TIME', () => {
    expect(evaluate(101, 10_000).exitReason).toBe('MAX_HOLD_TIME');
  });
});


describe('open P&L', () => {
  it('is the mark-to-market change minus the entry fee already paid (equity-consistent)', async () => {
    const fixture = makeStore([launchPosition({ quantity: 2, entryFee: 0.6, takeProfit: 1_000 })]);
    const manager = new PositionManager(fixture.store);
    await manager.reconcileMarket(quote(105, 1), at(1));
    // (105 - 100) x 2 = 10 gross, minus the 0.6 entry fee.
    expect(fixture.positions[0].unrealizedPnl).toBeCloseTo(9.4, 10);
  });
});
