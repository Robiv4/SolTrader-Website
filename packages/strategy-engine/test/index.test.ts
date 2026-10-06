import { describe, expect, it } from 'vitest';

import {
  BreakoutStrategy,
  MomentumStrategy,
  PullbackStrategy,
  createConfiguredStrategy,
  createDefaultStrategies,
  type StrategyMarketData,
} from '../src/index.js';

const timestamp = new Date('2026-09-23T12:00:00.000Z');

const momentumFixture: StrategyMarketData = {
  token: 'BONK',
  timestamp,
  riskScore: 20,
  shortTermMomentum: 80,
  volumeAcceleration: 75,
  buyPressure: 85,
  liquidityStability: 90,
};

const breakoutFixture: StrategyMarketData = {
  token: 'WIF',
  timestamp,
  riskScore: 25,
  localConsolidation: 80,
  resistance: 75,
  breakout: 90,
  volumeConfirmation: 85,
};

const pullbackFixture: StrategyMarketData = {
  token: 'JUP',
  timestamp,
  riskScore: 15,
  initialImpulse: 90,
  retracement: 60,
  support: 85,
  renewedBuyingPressure: 80,
};

describe('strategy metadata and entry evaluation', () => {
  it('exposes all default strategies independently from execution', () => {
    const strategies = createDefaultStrategies();
    expect(strategies.map((strategy) => strategy.name)).toEqual([
      'MomentumStrategy',
      'BreakoutStrategy',
      'PullbackStrategy',
    ]);
    for (const strategy of strategies) {
      expect(strategy.description).toBeTruthy();
      expect(strategy.parameters.length).toBeGreaterThan(0);
      expect(strategy.entryConditions.length).toBeGreaterThan(0);
      expect(strategy.exitConditions.length).toBeGreaterThan(0);
      expect(strategy.cooldownMs).toBeGreaterThan(0);
      expect(strategy.configuration).toBeTruthy();
    }
  });

  it('emits a momentum BUY signal from deterministic data', () => {
    const signal = new MomentumStrategy().evaluate(momentumFixture);
    expect(signal).toMatchObject({ token: 'BONK', strategy: 'MomentumStrategy', riskScore: 20, recommendedAction: 'BUY' });
    expect(signal.score).toBe(82);
  });

  it('emits breakout and pullback BUY signals', () => {
    expect(new BreakoutStrategy().evaluate(breakoutFixture).recommendedAction).toBe('BUY');
    expect(new PullbackStrategy().evaluate(pullbackFixture).recommendedAction).toBe('BUY');
  });
});

describe('strategy signal actions', () => {
  it('watches when entry conditions are incomplete', () => {
    const signal = new MomentumStrategy().evaluate({ ...momentumFixture, buyPressure: 10 });
    expect(signal.recommendedAction).toBe('WATCH');
    expect(signal.reasons).toContain('Buy pressure meets threshold. not met.');
  });

  it('rejects a signal above the configured risk threshold', () => {
    const signal = new BreakoutStrategy().evaluate({ ...breakoutFixture, riskScore: 90 });
    expect(signal.recommendedAction).toBe('REJECT');
    expect(signal.reasons[0]).toContain('exceeds configured maximum');
  });

  it('emits SELL when an open position fails all exit conditions', () => {
    const signal = new PullbackStrategy().evaluate({ ...pullbackFixture, support: 10, renewedBuyingPressure: 10 }, { hasOpenPosition: true });
    expect(signal.recommendedAction).toBe('SELL');
    expect(signal.reasons).toEqual(['Support has failed.', 'Buying pressure has weakened.']);
  });

  it('keeps signal scores bounded between zero and one hundred', () => {
    const signal = new MomentumStrategy().evaluate({ ...momentumFixture, shortTermMomentum: 1000, volumeAcceleration: -100 });
    expect(signal.score).toBeGreaterThanOrEqual(0);
    expect(signal.score).toBeLessThanOrEqual(100);
  });
});

describe('createConfiguredStrategy (per-user PostgreSQL params)', () => {
  it('builds a strategy honoring persisted param overrides', () => {
    const strategy = createConfiguredStrategy('Momentum', { minimumMomentum: 95 });
    expect(strategy?.name).toBe('MomentumStrategy');
    const signal = strategy?.evaluate(momentumFixture);
    // minimumMomentum 95 is not met by the fixture's shortTermMomentum of 80.
    expect(signal?.recommendedAction).toBe('WATCH');
  });

  it('falls back to defaults for missing params', () => {
    const strategy = createConfiguredStrategy('Breakout', {});
    expect(strategy?.evaluate(breakoutFixture).recommendedAction).toBe('BUY');
  });

  it('returns undefined for an unknown strategy name', () => {
    expect(createConfiguredStrategy('MeanReversion', {})).toBeUndefined();
  });
});