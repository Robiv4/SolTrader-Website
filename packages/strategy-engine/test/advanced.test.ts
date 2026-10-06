import { describe, expect, it } from 'vitest';

import {
  analyzeToken,
  computeCompositeSignal,
  computeMarketFeatures,
  DEFAULT_MODULE_SETTINGS,
  evaluateBuyPressure,
  evaluateConfirmedBreakout,
  evaluateLiquidityInflow,
  evaluateMomentumAcceleration,
  evaluatePullbackContinuation,
  evaluatePumpExhaustion,
  evaluateRelativeStrength,
  evaluateVolumeSpike,
  type MarketObservation,
  type ModuleContext,
  percentileRank,
  resolveAdvancedSettings,
  type StrategyResult,
} from '../src/index.js';

const NOW = new Date('2026-09-28T12:00:00Z');
const MINUTE = 60_000;
const thresholds = { warning: 40, strongWarning: 70, block: 85 };

function observation(minutesAgo: number, overrides: Partial<MarketObservation> = {}): MarketObservation {
  return {
    timestamp: new Date(NOW.getTime() - minutesAgo * MINUTE),
    priceUsd: 1,
    liquidityUsd: 100_000,
    volume5m: 10_000,
    volume1h: 120_000,
    buyCount5m: 60,
    sellCount5m: 60,
    buyCount1h: 700,
    sellCount1h: 700,
    priceChange5m: 0,
    priceChange1h: 0,
    priceChange24h: 0,
    ...overrides,
  };
}

/** One observation per minute for `minutes` minutes (oldest first); `at(minutesAgo)` customises each point. */
function series(minutes: number, at: (minutesAgo: number) => Partial<MarketObservation> = () => ({})) {
  return Array.from({ length: minutes + 1 }, (_, index) => observation(minutes - index, at(minutes - index)));
}

function context(observations: MarketObservation[], extra: Partial<ModuleContext> = {}): ModuleContext {
  return { features: computeMarketFeatures(observations, NOW), observations, now: NOW, ...extra };
}

describe('MarketFeatureEngine', () => {
  it('derives short-window features from real observations and leaves unsupported ones null', () => {
    const features = computeMarketFeatures(series(20, (ago) => ({ priceUsd: 1 + (20 - ago) * 0.01 })), NOW);
    expect(features.priceChange15m).toBeCloseTo((1.2 / 1.05 - 1) * 100, 8);
    expect(features.volume5mBaseline).toBeCloseTo(10_000, 8);
    expect(features.volumeSpikeRatio).toBeCloseTo(1, 8);
    expect(features.buyVolume5m).toBeNull();
    expect(features.buySellVolumeRatio).toBeNull();
    expect(features.historyMinutes).toBe(20);
    expect(features.dataQuality).toBe('VALID');
  });

  it('never interpolates a missing point: no observation near 15 minutes ago -> null', () => {
    const features = computeMarketFeatures([observation(30), observation(2), observation(0)], NOW);
    expect(features.priceChange15m).toBeNull();
    expect(features.momentumWindows).toBeNull();
  });

  it('marks stale and invalid data', () => {
    expect(computeMarketFeatures([observation(10)], NOW).dataQuality).toBe('STALE');
    expect(computeMarketFeatures([observation(0, { priceUsd: 0 })], NOW).dataQuality).toBe('INVALID');
  });
});

describe('Volume Spike', () => {
  const settings = DEFAULT_MODULE_SETTINGS.VolumeSpike;
  it('normal volume -> no spike', () => {
    const result = evaluateVolumeSpike(context(series(10)), settings);
    expect(result.status).toBe('OK');
    expect(result.triggered).toBe(false);
  });
  it('3x volume increase -> spike detected', () => {
    const result = evaluateVolumeSpike(context(series(10, (ago) => (ago === 0 ? { volume5m: 30_000, volume1h: 140_000, priceChange5m: 4 } : {}))), settings);
    expect(result.features.volumeSpikeRatio).toBeCloseTo(3, 8);
    expect(result.triggered).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(60);
  });
  it('missing history -> WARMING_UP', () => {
    const result = evaluateVolumeSpike(context([observation(1), observation(0)]), settings);
    expect(result.status).toBe('WARMING_UP');
    expect(result.score).toBeNull();
  });
  it('invalid market data / missing windows -> unavailable', () => {
    expect(evaluateVolumeSpike(context(series(10, () => ({ volume5m: null }))), settings).status).toBe('UNAVAILABLE');
    expect(evaluateVolumeSpike(context(series(10, (ago) => (ago === 0 ? { priceUsd: null } : {}))), settings).status).toBe('UNAVAILABLE');
  });
});

describe('Buy Pressure', () => {
  const settings = DEFAULT_MODULE_SETTINGS.BuyPressure;
  it('buys == sells -> neutral, not triggered', () => {
    const result = evaluateBuyPressure(context(series(1)), settings);
    expect(result.score).toBe(50);
    expect(result.triggered).toBe(false);
  });
  it('buys strongly dominate with meaningful volume -> strong score', () => {
    const result = evaluateBuyPressure(context(series(1, () => ({ buyCount5m: 180, sellCount5m: 75, volume5m: 40_000, priceChange5m: 3 }))), settings);
    expect(result.triggered).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(70);
  });
  it('many tiny buys without meaningful volume -> capped, not maximum', () => {
    const result = evaluateBuyPressure(context(series(1, () => ({ buyCount5m: 500, sellCount5m: 20, volume5m: 400 }))), settings);
    expect(result.score).toBeLessThanOrEqual(55);
    expect(result.triggered).toBe(false);
  });
  it('missing buy/sell data -> unavailable', () => {
    expect(evaluateBuyPressure(context(series(1, () => ({ buyCount5m: null }))), settings).status).toBe('UNAVAILABLE');
  });
});

describe('Momentum Acceleration', () => {
  const settings = DEFAULT_MODULE_SETTINGS.MomentumAcceleration;
  /** Prices at 15/10/5/0 minutes ago following the given window returns. */
  function path(returns: [number, number, number]) {
    const prices = [1];
    for (const change of returns) prices.push(prices.at(-1)! * (1 + change / 100));
    return series(15, (ago) => ({ priceUsd: prices[Math.floor((15 - ago) / 5)] ?? prices[3], volume5m: null, volume1h: null, buyCount5m: null, sellCount5m: null }));
  }
  it('+5%, +5%, +5% -> momentum but low acceleration', () => {
    const result = evaluateMomentumAcceleration(context(path([5, 5, 5])), settings);
    expect(result.features.momentumAcceleration).toBeCloseTo(0, 8);
    expect(result.triggered).toBe(false);
  });
  it('+1%, +3%, +6% -> positive acceleration', () => {
    const result = evaluateMomentumAcceleration(context(path([1, 3, 6])), settings);
    expect(result.triggered).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(80);
  });
  it('+8%, +4%, +1% -> deceleration', () => {
    const result = evaluateMomentumAcceleration(context(path([8, 4, 1])), settings);
    expect(result.triggered).toBe(false);
    expect(result.score).toBeLessThan(30);
    expect(result.warnings.join(' ')).toContain('lassul');
  });
  it('less than 15 minutes of history -> WARMING_UP', () => {
    expect(evaluateMomentumAcceleration(context(series(10)), settings).status).toBe('WARMING_UP');
  });
});

describe('Confirmed Breakout', () => {
  const settings = DEFAULT_MODULE_SETTINGS.ConfirmedBreakout;
  const breakout = (volumeAtBreakout: Partial<MarketObservation>) => series(20, (ago) => ({ priceUsd: ago <= 2 ? 1.06 : 1 + (ago % 3) * 0.005, ...(ago === 0 ? volumeAtBreakout : {}) }));
  it('price above resistance without volume -> weak / unconfirmed', () => {
    const result = evaluateConfirmedBreakout(context(breakout({})), settings);
    expect(result.features.persisted).toBe(true);
    expect(result.triggered).toBe(false);
    expect(result.score).toBeLessThanOrEqual(55);
  });
  it('price above resistance with strong volume -> confirmed', () => {
    const result = evaluateConfirmedBreakout(context(breakout({ volume5m: 30_000, volume1h: 140_000, buyCount5m: 90, sellCount5m: 40 })), settings);
    expect(result.triggered).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(80);
  });
  it('stale price -> unavailable', () => {
    const stale = breakout({}).map((point) => ({ ...point, timestamp: new Date(point.timestamp.getTime() - 10 * MINUTE) }));
    expect(evaluateConfirmedBreakout(context(stale), settings).status).toBe('UNAVAILABLE');
  });
});

describe('Liquidity Inflow', () => {
  const settings = DEFAULT_MODULE_SETTINGS.LiquidityInflow;
  const at = (values: [number, number, number, number]) => series(15, (ago) => ({ liquidityUsd: values[3 - Math.floor(ago / 5)] ?? values[0] }));
  it('stable liquidity -> neutral', () => {
    const result = evaluateLiquidityInflow(context(at([100_000, 100_000, 100_000, 100_000])), settings);
    expect(result.triggered).toBe(false);
    expect(result.features.liquidityOutflow).toBe(false);
  });
  it('increasing liquidity -> inflow', () => {
    const result = evaluateLiquidityInflow(context(at([35_000, 48_000, 63_000, 82_000])), settings);
    expect(result.triggered).toBe(true);
    expect(result.features.liquidityChangePercent).toBeCloseTo((82 / 35 - 1) * 100, 6);
  });
  it('rapid liquidity reduction -> LIQUIDITY_OUTFLOW warning (critical)', () => {
    const result = evaluateLiquidityInflow(context(at([100_000, 80_000, 55_000, 32_000])), settings);
    expect(result.features.liquidityOutflow).toBe(true);
    expect(result.features.criticalLiquidityOutflow).toBe(true);
    expect(result.warnings.join(' ')).toContain('LIQUIDITY_OUTFLOW');
    expect(result.triggered).toBe(false);
  });
  it('missing liquidity -> unavailable', () => {
    expect(evaluateLiquidityInflow(context(series(15, () => ({ liquidityUsd: null }))), settings).status).toBe('UNAVAILABLE');
  });
});

describe('Pullback Continuation', () => {
  const settings = DEFAULT_MODULE_SETTINGS.PullbackContinuation;
  it('impulse -> controlled pullback -> buyers return -> reclaim', () => {
    const prices = [1, 1.05, 1.1, 1.15, 1.2, 1.25, 1.3, 1.27, 1.22, 1.18, 1.16, 1.15, 1.16, 1.18, 1.2, 1.22, 1.23, 1.24, 1.25, 1.26, 1.27];
    const observations = prices.map((price, index) => observation(prices.length - 1 - index, { priceUsd: price, buyCount5m: 80, sellCount5m: 40 }));
    const result = evaluatePullbackContinuation(context(observations), settings);
    expect(result.triggered).toBe(true);
    expect(result.features.retracementPercent).toBeCloseTo(50, 6);
  });
  it('uncontrolled collapse is not a pullback', () => {
    const prices = [1, 1.1, 1.2, 1.3, 1.25, 1.1, 0.95, 0.9, 0.85, 0.8, 0.82, 0.83, 0.84, 0.85, 0.86, 0.87, 0.88, 0.89, 0.9, 0.91, 0.92];
    const observations = prices.map((price, index) => observation(prices.length - 1 - index, { priceUsd: price, buyCount5m: 80, sellCount5m: 40 }));
    const result = evaluatePullbackContinuation(context(observations), settings);
    expect(result.triggered).toBe(false);
    expect(result.warnings.join(' ')).toContain('Kontrollálatlan');
  });
});

describe('Relative Strength', () => {
  const settings = DEFAULT_MODULE_SETTINGS.RelativeStrength;
  const universe = Array.from({ length: 12 }, (_, index) => ({
    tokenAddress: `T${index}`,
    features: computeMarketFeatures(series(6, (ago) => (ago === 0 ? { priceChange5m: index, volume5m: 10_000 + index * 1_000, volume1h: 120_000, buyCount5m: 50 + index, sellCount5m: 50 } : {})), NOW),
  }));
  it('ranks deterministically against the candidate universe', () => {
    expect(percentileRank(5, [1, 2, 3, 4])).toBe(100);
    expect(percentileRank(1, [1, 2, 3, 4])).toBe(12.5);
    const best = evaluateRelativeStrength({ ...context(series(6)), features: universe[11].features, universe, tokenAddress: 'T11' }, settings);
    const worst = evaluateRelativeStrength({ ...context(series(6)), features: universe[0].features, universe, tokenAddress: 'T0' }, settings);
    expect(best.score).toBe(100);
    expect(worst.score).toBe(0);
    expect(best.triggered).toBe(true);
  });
  it('insufficient candidate sample -> unavailable, not a fake score', () => {
    const result = evaluateRelativeStrength({ ...context(series(6)), features: universe[5].features, universe: universe.slice(0, 4), tokenAddress: 'T5' }, settings);
    expect(result.status).toBe('UNAVAILABLE');
    expect(result.unavailableReason).toBe('INSUFFICIENT_CANDIDATE_SAMPLE');
    expect(result.score).toBeNull();
  });
});

describe('Pump Exhaustion', () => {
  const settings = DEFAULT_MODULE_SETTINGS.PumpExhaustion;
  it('strong momentum with rising volume -> low exhaustion', () => {
    const observations = series(15, (ago) => ({ priceUsd: 1 + (15 - ago) * 0.02, volume5m: ago === 0 ? 20_000 : 10_000, priceChange1h: 30, buyCount5m: 70, sellCount5m: 40 }));
    const result = evaluatePumpExhaustion(context(observations), settings, thresholds);
    expect(result.score).toBeLessThan(40);
  });
  it('extreme prior pump + falling volume + weakening buyers + rejection -> high exhaustion', () => {
    const prices = [1, 1.4, 1.8, 2.2, 2.6, 3, 3.3, 3.5, 3.6, 3.65, 3.6, 3.5, 3.3, 3.2, 3.15, 3.1];
    const observations = prices.map((price, index) => observation(prices.length - 1 - index, {
      priceUsd: price, priceChange1h: 250, volume5m: index === prices.length - 1 ? 3_000 : 20_000, buyCount5m: 40, sellCount5m: 70, buyCount1h: 900, sellCount1h: 500,
    }));
    const result = evaluatePumpExhaustion(context(observations), settings, thresholds);
    expect(result.score).toBeGreaterThanOrEqual(85);
    expect(result.features.level).toBe('BLOCK');
  });
});

function okResult(strategy: StrategyResult['strategy'], score: number, triggered: boolean): StrategyResult {
  return { strategy, enabled: true, available: true, status: 'OK', unavailableReason: null, triggered, score, confidence: 1, reasons: [], warnings: [], features: {}, requiredHistoryMinutes: 0, evaluatedAt: NOW.toISOString() };
}
function missing(strategy: StrategyResult['strategy'], status: 'WARMING_UP' | 'UNAVAILABLE'): StrategyResult {
  return { ...okResult(strategy, 0, false), available: false, status, score: null, unavailableReason: status };
}

describe('Composite Signal', () => {
  const settings = resolveAdvancedSettings({ compositeEnabled: true });
  const strong = [
    okResult('Momentum', 78, true), okResult('MomentumAcceleration', 86, true), okResult('VolumeSpike', 91, true), okResult('BuyPressure', 82, true),
    okResult('ConfirmedBreakout', 74, true), okResult('LiquidityInflow', 65, true), okResult('RelativeStrength', 88, true), okResult('PullbackContinuation', 20, false),
    okResult('PumpExhaustion', 18, false),
  ];

  it('uses the configured weights (not a plain average) and is deterministic', () => {
    const result = computeCompositeSignal(strong, settings);
    const weights = { Momentum: 1, MomentumAcceleration: 1.2, VolumeSpike: 1.2, BuyPressure: 1.1, ConfirmedBreakout: 1.1, LiquidityInflow: 0.7, RelativeStrength: 1, PullbackContinuation: 1 };
    const scores = { Momentum: 78, MomentumAcceleration: 86, VolumeSpike: 91, BuyPressure: 82, ConfirmedBreakout: 74, LiquidityInflow: 65, RelativeStrength: 88, PullbackContinuation: 20 };
    const expected = Object.entries(weights).reduce((sum, [name, weight]) => sum + weight * scores[name as keyof typeof scores], 0) / Object.values(weights).reduce((a, b) => a + b, 0);
    expect(result.weightedScore).toBeCloseTo(expected, 10);
    expect(result.score).toBe(Math.round(expected));
    expect(result.confirmations).toBe(7);
    expect(computeCompositeSignal(strong, settings)).toEqual(result);
    expect(result.action).toBe('BUY');
  });

  it('excludes disabled modules', () => {
    const disabled = resolveAdvancedSettings({ compositeEnabled: true, modules: { PullbackContinuation: { enabled: false } } });
    const result = computeCompositeSignal(strong, disabled);
    expect(result.unconfirmedModules).not.toContain('PullbackContinuation');
    expect(result.weightedScore!).toBeGreaterThan(computeCompositeSignal(strong, settings).weightedScore!);
  });

  it('never counts unavailable or warming-up modules as confirmations, and lowers coverage', () => {
    const partial = [okResult('Momentum', 90, true), missing('MomentumAcceleration', 'WARMING_UP'), missing('VolumeSpike', 'UNAVAILABLE'), okResult('BuyPressure', 90, true), okResult('PumpExhaustion', 10, false)];
    const result = computeCompositeSignal(partial, settings);
    expect(result.confirmations).toBe(2);
    expect(result.coverage).toBeLessThan(1);
    expect(result.score).toBeLessThan(90);
    expect(result.entryEligible).toBe(false);
    const penalized = computeCompositeSignal(partial, { ...settings, penalizeUnavailable: true });
    expect(penalized.weightedScore!).toBeLessThan(result.weightedScore!);
  });

  it('requires the minimum number of confirmations', () => {
    const two = strong.map((result, index) => (index > 1 && result.strategy !== 'PumpExhaustion' ? { ...result, triggered: false } : result));
    expect(computeCompositeSignal(two, settings).entryEligible).toBe(false);
    expect(computeCompositeSignal(two, { ...settings, minimumConfirmations: 2 }).entryEligible).toBe(true);
  });

  it('extreme exhaustion blocks automatic entry despite huge momentum (BLOCK policy) and is penalised otherwise', () => {
    const exhausted = strong.map((result) => (result.strategy === 'PumpExhaustion' ? okResult('PumpExhaustion', 94, true) : result.strategy === 'Momentum' ? okResult('Momentum', 95, true) : result));
    const blocked = computeCompositeSignal(exhausted, settings);
    expect(blocked.exhaustionBlocked).toBe(true);
    expect(blocked.entryEligible).toBe(false);
    expect(blocked.exhaustionPenalty).toBeCloseTo(0.5 * (94 - 40), 10);
    const warnOnly = computeCompositeSignal(exhausted, { ...settings, exhaustionPolicy: 'WARN_ONLY' });
    expect(warnOnly.exhaustionBlocked).toBe(false);
    expect(warnOnly.score).toBeLessThan(computeCompositeSignal(strong, settings).score);
  });

  it('keeps the score within 0-100', () => {
    const extreme = strong.map((result) => (result.strategy === 'PumpExhaustion' ? okResult('PumpExhaustion', 100, true) : okResult(result.strategy, 0, false)));
    expect(computeCompositeSignal(extreme, { ...settings, exhaustionPenaltyWeight: 5 }).score).toBe(0);
    const perfect = strong.map((result) => (result.strategy === 'PumpExhaustion' ? okResult('PumpExhaustion', 0, false) : okResult(result.strategy, 100, true)));
    expect(computeCompositeSignal(perfect, settings).score).toBe(100);
  });

  it('a critical liquidity outflow prevents entry', () => {
    const outflow = strong.map((result) => (result.strategy === 'LiquidityInflow' ? { ...okResult('LiquidityInflow', 10, false), features: { criticalLiquidityOutflow: true } } : result));
    expect(computeCompositeSignal(outflow, settings).entryEligible).toBe(false);
  });

  it('analyzeToken runs every module once with standard results', () => {
    const analysis = analyzeToken(context(series(20)), settings, null);
    expect(analysis.results.map((result) => result.strategy)).toEqual(['Momentum', 'MomentumAcceleration', 'VolumeSpike', 'BuyPressure', 'ConfirmedBreakout', 'LiquidityInflow', 'RelativeStrength', 'PullbackContinuation', 'PumpExhaustion']);
    for (const result of analysis.results) {
      expect(result.score === null || (result.score >= 0 && result.score <= 100)).toBe(true);
      if (!result.available) expect(result.score).toBeNull();
    }
  });
});
