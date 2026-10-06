import { describe, expect, it } from 'vitest';

import { HistoricalBacktestEngine, type HistoricalBar } from '../src/backtest.js';

function bar(index: number, open: number, high = open, low = open, close = open): HistoricalBar {
  return {
    timestamp: new Date(Date.UTC(2026, 0, 1, index)),
    token: 'TOKEN',
    open,
    high,
    low,
    close,
    volume: 100,
  };
}

const buySignal = {
  action: 'BUY' as const,
  score: 80,
  riskScore: 20,
  strategy: 'FixtureStrategy',
  reasons: ['deterministic fixture'],
};

describe('historical backtesting', () => {
  it('does not use future bars when evaluating a signal', () => {
    const bars = [bar(0, 100), bar(1, 100), bar(2, 100), bar(3, 100)];
    const historyLengths: number[] = [];
    new HistoricalBacktestEngine({
      initialEquity: 10_000,
      feeBps: 0,
      slippagePercent: 0,
      executionDelayBars: 1,
      partialExitPercent: 1,
      stopLossPercent: 2,
      takeProfitPercent: 2,
      trailingStopPercent: 2,
      positionPercent: 2,
    }).run(bars, ({ history, current }) => {
      historyLengths.push(history.length);
      expect(history[history.length - 1].timestamp).toEqual(current.timestamp);
      expect(history.length).toBeLessThanOrEqual(4);
      return history.length === 1 ? buySignal : null;
    });
    expect(historyLengths).toEqual([1, 2, 3, 4]);
  });

  it('fills after the decision bar and applies take profit deterministically', () => {
    const bars = [bar(0, 100), bar(1, 101), bar(2, 105, 106, 105, 105), bar(3, 105)];
    const result = new HistoricalBacktestEngine({
      initialEquity: 10_000,
      feeBps: 0,
      slippagePercent: 0,
      executionDelayBars: 1,
      partialExitPercent: 1,
      stopLossPercent: 2,
      takeProfitPercent: 2,
      trailingStopPercent: 2,
      positionPercent: 2,
    }).run(bars, ({ index }) => index === 0 ? buySignal : null, 'VALIDATION');
    expect(result.trades[0]).toMatchObject({ split: 'VALIDATION', entryPrice: 101, exitReason: 'TAKE_PROFIT' });
    expect(result.metrics.totalTrades).toBe(1);
    expect(result.metrics.wins).toBe(1);
    expect(result.metrics.fees).toBe(0);
  });

  it('tracks fees, slippage, partial exits, and drawdown', () => {
    const bars = [bar(0, 100), bar(1, 100), bar(2, 105, 106, 105, 105), bar(3, 96, 96, 94, 95)];
    const result = new HistoricalBacktestEngine({
      initialEquity: 10_000,
      feeBps: 100,
      slippagePercent: 1,
      executionDelayBars: 1,
      partialExitPercent: 0.5,
      stopLossPercent: 2,
      takeProfitPercent: 2,
      trailingStopPercent: 2,
      positionPercent: 2,
    }).run(bars, ({ index }) => index === 0 ? buySignal : null);
    expect(result.metrics.fees).toBeGreaterThan(0);
    expect(result.metrics.slippage).toBeGreaterThan(0);
    expect(result.metrics.maximumDrawdown).toBeGreaterThanOrEqual(0);
  });

  it('supports walk-forward training, validation, and out-of-sample windows', () => {
    const bars = Array.from({ length: 12 }, (_, index) => bar(index, 100));
    const results = new HistoricalBacktestEngine().walkForward(bars, () => null, 4, 4, 4);
    expect(results.map((result) => result.split)).toEqual(['TRAINING', 'VALIDATION', 'OUT_OF_SAMPLE']);
  });

  it('rejects non-chronological data', () => {
    expect(() => new HistoricalBacktestEngine().run([bar(1, 100), bar(0, 100)], () => null)).toThrow('strictly chronological');
  });
});