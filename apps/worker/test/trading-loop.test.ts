import type { BotCommand } from '@soltrader/shared';
import { describe, expect, it } from 'vitest';

import { PositionManager, type PositionRecord } from '../src/position-manager.js';
import { BotTradingLoop, type TradingLoopStore, type WorkerBotStatus } from '../src/trading-loop.js';

class FakeSubscriber {
  handler?: (command: BotCommand) => void | Promise<void>;
  async subscribe(handler: (command: BotCommand) => void | Promise<void>) { this.handler = handler; }
}

function setup(initialStatus: WorkerBotStatus = 'STOPPED') {
  const events: string[] = [];
  const states: WorkerBotStatus[] = [];
  const store: TradingLoopStore = {
    readState: async () => ({ status: initialStatus }),
    writeState: async (status) => { states.push(status); },
    recordEvent: async (action) => { events.push(action); },
  };
  const subscriber = new FakeSubscriber();
  let tokenCycles = 0;
  let strategyCycles = 0;
  let executionCycles = 0;
  let positionCycles = 0;
  let cancelled: string | undefined;
  const loop = new BotTradingLoop(store, subscriber, {
    runTokenMonitor: async () => { tokenCycles += 1; },
    runStrategies: async () => { strategyCycles += 1; },
    runPaperExecution: async () => { executionCycles += 1; },
    monitorOpenPositions: async () => { positionCycles += 1; },
    cancelPendingOffers: async (reason) => { cancelled = reason; },
  }, 60_000);
  return { loop, subscriber, states, events, counters: { get token() { return tokenCycles; }, get strategy() { return strategyCycles; }, get execution() { return executionCycles; }, get positions() { return positionCycles; } }, get cancelled() { return cancelled; } };
}

describe('worker trading state machine', () => {
  it('starts from the persisted DB state and runs the appropriate cycle', async () => {
    const fixture = setup('RUNNING');
    await fixture.loop.start();
    await Promise.resolve();
    await Promise.resolve();
    expect(fixture.loop.currentStatus).toBe('RUNNING');
    expect(fixture.counters.token).toBeGreaterThan(0);
    expect(fixture.counters.strategy).toBeGreaterThan(0);
    expect(fixture.counters.execution).toBeGreaterThan(0);
    await fixture.loop.stop();
  });

  it('PAUSED monitors positions but does not run entries', async () => {
    const fixture = setup('PAUSED');
    await fixture.loop.start();
    await Promise.resolve();
    await Promise.resolve();
    expect(fixture.counters.positions).toBeGreaterThan(0);
    expect(fixture.counters.token).toBe(0);
    await fixture.loop.stop();
  });

  it('handles commands and immediately cancels on emergency stop', async () => {
    const fixture = setup('STOPPED');
    await fixture.loop.start();
    await fixture.subscriber.handler?.({ command: 'START', payload: { requestedBy: 'admin' } });
    expect(fixture.loop.currentStatus).toBe('RUNNING');
    await fixture.subscriber.handler?.({ command: 'EMERGENCY_STOP', payload: { requestedBy: 'admin', reason: 'test' } });
    expect(fixture.loop.currentStatus).toBe('EMERGENCY_STOP');
    expect(fixture.cancelled).toBe('EMERGENCY_STOP');
    expect(fixture.events).toContain('EMERGENCY_STOP');
    await fixture.loop.stop();
  });

  it('updates open positions and emits exit and pnl events when risk limits are hit', async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const positions: PositionRecord[] = [{
      id: 'pos-1',
      userId: 'user-1',
      token: 'TOKEN',
      symbol: 'TKN',
      side: 'BUY',
      quantity: 2,
      avgEntryPrice: 100,
      currentPrice: 100,
      stopLoss: 96,
      takeProfit: 110,
      // Without a trailing stop the fixed stop loss is the effective protective stop.
      trailingStop: null,
      highestPrice: 100,
      lowestPrice: 100,
      unrealizedPnl: 0,
      status: 'OPEN',
      exitReason: null,
      strategy: 'Momentum',
      signalId: 'signal-1',
    }];

    const manager = new PositionManager({
      async getOpenPositions() { return positions; },
      async updatePosition(id, updates) { const index = positions.findIndex((row) => row.id === id && row.userId === updates.userId); if (index >= 0) Object.assign(positions[index], updates); },
      async closePosition(id, data) { const index = positions.findIndex((row) => row.id === id && row.userId === data.userId); if (index >= 0) { positions[index] = { ...positions[index], ...data, status: 'CLOSED', exitReason: data.exitReason ?? positions[index].exitReason }; } },
      async publishEvent(type, payload) { events.push({ type, payload: payload as Record<string, unknown> }); },
    });

    await manager.reconcileMarket({ TOKEN: 94 }, new Date('2026-09-23T12:00:00.000Z'));

    expect(positions[0].status).toBe('CLOSED');
    expect(positions[0].exitReason).toBe('STOP_LOSS');
    expect(events.some((event) => event.type === 'position_update')).toBe(true);
    expect(events.some((event) => event.type === 'pnl_update')).toBe(true);
  });
});
