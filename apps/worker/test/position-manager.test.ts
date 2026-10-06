import { describe, expect, it } from 'vitest';

import { PositionManager, type PositionRecord, type PositionManagerStore } from '../src/position-manager.js';

function makeStore(initial: PositionRecord[]) {
  const positions = [...initial];
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];

  const store: PositionManagerStore = {
    async getOpenPositions() {
      return positions.filter((row) => row.status === 'OPEN');
    },
    async updatePosition(id, updates) {
      const index = positions.findIndex((row) => row.id === id && row.userId === updates.userId);
      if (index >= 0) Object.assign(positions[index], updates);
    },
    async closePosition(id, updates) {
      const index = positions.findIndex((row) => row.id === id && row.userId === updates.userId);
      if (index >= 0) {
        positions[index] = { ...positions[index], ...updates, status: 'CLOSED' };
      }
    },
    async publishEvent(type, payload) {
      events.push({ type, payload });
    },
  };

  return { store, positions, events };
}

function makePosition(overrides: Partial<PositionRecord> = {}): PositionRecord {
  return {
    id: overrides.id ?? 'pos-1',
    userId: 'user-1',
    token: overrides.token ?? 'TOKEN',
    symbol: overrides.symbol ?? 'TKN',
    side: overrides.side ?? 'BUY',
    quantity: overrides.quantity ?? 2,
    avgEntryPrice: overrides.avgEntryPrice ?? 100,
    currentPrice: overrides.currentPrice ?? 100,
    stopLoss: overrides.stopLoss ?? 96,
    takeProfit: overrides.takeProfit ?? 110,
    trailingStop: 'trailingStop' in overrides ? overrides.trailingStop ?? null : 0.02,
    highestPrice: overrides.highestPrice ?? 100,
    lowestPrice: overrides.lowestPrice ?? 100,
    unrealizedPnl: overrides.unrealizedPnl ?? 0,
    realizedPnl: overrides.realizedPnl ?? 0,
    status: overrides.status ?? 'OPEN',
    exitReason: overrides.exitReason ?? null,
    strategy: overrides.strategy ?? 'Momentum',
    signalId: overrides.signalId ?? 'signal-1',
    ...overrides,
  };
}

describe('position manager risk control', () => {
  it('closes a buy on a stop loss and a take profit', async () => {
    // No trailing stop: an armed-from-entry 2% trailing stop (98) would be the tighter, effective stop.
    const stop = makePosition({ id: 'stop-1', stopLoss: 96, takeProfit: 110, currentPrice: 100, trailingStop: null });
    const take = makePosition({ id: 'take-1', stopLoss: 96, takeProfit: 110, currentPrice: 100, trailingStop: null });
    const stopFixture = makeStore([stop]);
    const takeFixture = makeStore([take]);
    const stopManager = new PositionManager(stopFixture.store);
    const takeManager = new PositionManager(takeFixture.store);

    await stopManager.reconcileMarket({ TOKEN: 94 });
    await takeManager.reconcileMarket({ TOKEN: 110 });

    expect(stopFixture.positions[0].status).toBe('CLOSED');
    expect(stopFixture.positions[0].exitReason).toBe('STOP_LOSS');
    expect(takeFixture.positions[0].status).toBe('CLOSED');
    expect(takeFixture.positions[0].exitReason).toBe('TAKE_PROFIT');
  });

  it('closes on a trailing stop after a new high', async () => {
    const position = makePosition({ id: 'trail-1', currentPrice: 100, highestPrice: 102, trailingStop: 0.02, stopLoss: 96, takeProfit: 120 });
    const fixture = makeStore([position]);
    const manager = new PositionManager(fixture.store);

    await manager.reconcileMarket({ TOKEN: 99.5 });

    expect(fixture.positions[0].status).toBe('CLOSED');
    expect(fixture.positions[0].exitReason).toBe('TRAILING_STOP');
  });

  it('publishes risk warnings for maximum exposure and daily loss limits', async () => {
    const fixture = makeStore([
      makePosition({ id: 'pos-1', token: 'TOKA', symbol: 'TKA', quantity: 10, currentPrice: 100, avgEntryPrice: 100, stopLoss: 95, takeProfit: 120 }),
      makePosition({ id: 'pos-2', token: 'TOKB', symbol: 'TKB', quantity: 10, currentPrice: 100, avgEntryPrice: 100, stopLoss: 95, takeProfit: 120 }),
    ]);
    const manager = new PositionManager(fixture.store, { accountEquityUsd: 100, maxExposurePercent: 80, dailyLossLimitPercent: 20 });

    await manager.reconcileMarket({ TOKA: 100, TOKB: 100 });
    expect(fixture.events.some((event) => event.type === 'risk_update' && event.payload.code === 'MAX_EXPOSURE')).toBe(true);
  });

  it('derives a missing stop loss and take profit from the entry price, so they actually trigger', async () => {
    const stop = makeStore([makePosition({ id: 'no-levels-stop', stopLoss: null, takeProfit: null, trailingStop: 0.5, avgEntryPrice: 100, highestPrice: 100 })]);
    const take = makeStore([makePosition({ id: 'no-levels-take', stopLoss: null, takeProfit: null, trailingStop: 0.5, avgEntryPrice: 100, highestPrice: 100 })]);
    const custom = makeStore([makePosition({ id: 'user-levels', stopLoss: null, takeProfit: null, trailingStop: 0.5, avgEntryPrice: 100, highestPrice: 100, stopLossPercent: 10 })]);

    await new PositionManager(stop.store).reconcileMarket({ TOKEN: 97.9 });
    await new PositionManager(take.store).reconcileMarket({ TOKEN: 104 });
    await new PositionManager(custom.store).reconcileMarket({ TOKEN: 95 });

    expect(stop.positions[0].exitReason).toBe('STOP_LOSS');
    expect(take.positions[0].exitReason).toBe('TAKE_PROFIT');
    // A 10% user stop is not hit by a 5% drop.
    expect(custom.positions[0].status).toBe('OPEN');
    expect(custom.positions[0].stopLoss).toBeCloseTo(90, 6);
  });

  it('makes no exit decision without a fresh market price', async () => {
    const fixture = makeStore([makePosition({ id: 'unpriced', currentPrice: 50, stopLoss: 96 })]);
    await new PositionManager(fixture.store).reconcileMarket({});
    expect(fixture.positions[0].status).toBe('OPEN');
  });

  it('evaluates exposure per owner against that owner equity', async () => {
    const fixture = makeStore([
      makePosition({ id: 'a', userId: 'user-a', token: 'TA', quantity: 1, currentPrice: 100, stopLoss: 50, takeProfit: 200 }),
      makePosition({ id: 'b', userId: 'user-b', token: 'TB', quantity: 1, currentPrice: 100, stopLoss: 50, takeProfit: 200 }),
    ]);
    const equity: Record<string, number> = { 'user-a': 10_000, 'user-b': 200 };
    fixture.store.getAccountEquity = async (userId) => equity[userId] ?? null;
    await new PositionManager(fixture.store, { maxExposurePercent: 25 }).reconcileMarket({ TA: 100, TB: 100 });
    const exposureEvents = fixture.events.filter((event) => event.payload.code === 'MAX_EXPOSURE');
    expect(exposureEvents.map((event) => event.payload.userId)).toEqual(['user-b']);
  });

  it('keeps only the targeted position closed when multiple positions are open', async () => {
    const fixture = makeStore([
      makePosition({ id: 'keep-1', token: 'TOKEN', symbol: 'TKN', quantity: 2, currentPrice: 100, avgEntryPrice: 100, stopLoss: 95, takeProfit: 120 }),
      makePosition({ id: 'close-1', token: 'OTHER', symbol: 'OTH', quantity: 2, currentPrice: 100, avgEntryPrice: 100, stopLoss: 95, takeProfit: 120 }),
    ]);
    const manager = new PositionManager(fixture.store);

    await manager.reconcileMarket({ TOKEN: 100, OTHER: 94 });

    expect(fixture.positions.find((position) => position.id === 'close-1')?.status).toBe('CLOSED');
    expect(fixture.positions.find((position) => position.id === 'keep-1')?.status).toBe('OPEN');
  });
});

describe('optional liquidity-outflow exit', () => {
  it('closes when enabled and liquidity fell below the configured share of the entry liquidity', async () => {
    const fixture = makeStore([makePosition({ id: 'liq', stopLoss: 50, takeProfit: 200, trailingStop: null, entryLiquidityUsd: 100_000, liquidityOutflowExitPercent: 50 })]);
    const manager = new PositionManager(fixture.store);
    await manager.reconcileMarket({ TOKEN: { price: 100, liquidityUsd: 60_000 } });
    expect(fixture.positions[0].status).toBe('OPEN');
    await manager.reconcileMarket({ TOKEN: { price: 100, liquidityUsd: 49_000 } });
    expect(fixture.positions[0].exitReason).toBe('LIQUIDITY_OUTFLOW');
  });

  it('does nothing when the setting is off (default)', async () => {
    const fixture = makeStore([makePosition({ id: 'liq-off', stopLoss: 50, takeProfit: 200, trailingStop: null, entryLiquidityUsd: 100_000, liquidityOutflowExitPercent: null })]);
    await new PositionManager(fixture.store).reconcileMarket({ TOKEN: { price: 100, liquidityUsd: 5_000 } });
    expect(fixture.positions[0].status).toBe('OPEN');
  });
});
