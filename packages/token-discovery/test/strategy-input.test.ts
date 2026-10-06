import type { TokenMarketSnapshot } from '@soltrader/market-data';
import { describe, expect, it } from 'vitest';

import { buildStrategyMarketData, type HistoricalMetricPoint } from '../src/strategy-input.js';

function snapshot(overrides: Partial<TokenMarketSnapshot> = {}): TokenMarketSnapshot {
  return {
    metadata: { address: 'token' },
    timestamp: new Date('2026-09-25T12:00:00.000Z'),
    priceUsd: 1.2,
    liquidityUsd: 50_000,
    volume24h: 100_000,
    transactionCount: 400,
    buyCount24h: 260,
    sellCount24h: 140,
    priceChange1h: 12,
    priceChange24h: 30,
    provider: 'test',
    ...overrides,
  };
}

describe('buildStrategyMarketData', () => {
  it('leaves history-dependent fields undefined with no prior observations (never fabricates data)', () => {
    const result = buildStrategyMarketData('token', snapshot(), [], 20);
    expect(result.volumeAcceleration).toBeUndefined();
    expect(result.liquidityStability).toBeUndefined();
    expect(result.resistance).toBeUndefined();
    expect(result.support).toBeUndefined();
    expect(result.breakout).toBeUndefined();
    // Fields derivable from the current snapshot alone are still populated.
    expect(result.shortTermMomentum).toBe(74);
    expect(result.buyPressure).toBeCloseTo(65, 5);
  });

  it('derives momentum/volume/buy-pressure fields directly from the current snapshot', () => {
    const result = buildStrategyMarketData('token', snapshot(), [], 20);
    expect(result.token).toBe('token');
    expect(result.riskScore).toBe(20);
  });

  it('computes technical features from real prior TokenMetric history once enough points exist', () => {
    const history: HistoricalMetricPoint[] = [
      { timestamp: new Date('2026-09-25T12:00:00.000Z'), priceUsd: 1.2, volume24h: 100_000, liquidityUsd: 50_000, buyCount24h: 260, sellCount24h: 140 },
      { timestamp: new Date('2026-09-25T11:00:00.000Z'), priceUsd: 1.0, volume24h: 80_000, liquidityUsd: 49_000, buyCount24h: 150, sellCount24h: 150 },
      { timestamp: new Date('2026-09-25T10:00:00.000Z'), priceUsd: 0.8, volume24h: 60_000, liquidityUsd: 48_000, buyCount24h: 120, sellCount24h: 120 },
      { timestamp: new Date('2026-09-25T09:00:00.000Z'), priceUsd: 0.9, volume24h: 55_000, liquidityUsd: 47_500, buyCount24h: 100, sellCount24h: 130 },
    ];

    const result = buildStrategyMarketData('token', snapshot(), history, 20);

    expect(result.volumeAcceleration).toBeGreaterThan(50); // 100k now vs 80k prior cycle => accelerating
    // Resistance/support are 0-100 level-strength scores (strategies compare them with 0-100 thresholds):
    // the prior high (1.0) and low (0.8) were each tested once out of three observations.
    expect(result.resistance).toBeCloseTo(100 / 3, 5);
    expect(result.support).toBeCloseTo(100 / 3, 5);
    expect(result.breakout).toBeGreaterThan(50); // current price (1.2) exceeds prior resistance (1.0)
    expect(result.renewedBuyingPressure).toBeGreaterThan(50); // buy ratio improved vs prior cycle
    expect(result.liquidityStability).toBeGreaterThan(0);
  });

  it('scores a repeatedly tested level as strong and a broken support as zero', () => {
    const tested: HistoricalMetricPoint[] = [
      { timestamp: new Date('2026-09-25T12:00:00.000Z'), priceUsd: 1.0 },
      { timestamp: new Date('2026-09-25T11:00:00.000Z'), priceUsd: 1.0 },
      { timestamp: new Date('2026-09-25T10:00:00.000Z'), priceUsd: 0.99 },
      { timestamp: new Date('2026-09-25T09:00:00.000Z'), priceUsd: 1.01 },
    ];
    expect(buildStrategyMarketData('token', snapshot(), tested, 20).resistance).toBe(100);

    const broken = buildStrategyMarketData('token', { ...snapshot(), priceUsd: 0.5 }, tested, 20);
    expect(broken.support).toBe(0);
  });
});
