import { describe, expect, it } from 'vitest';

import {
  capacityCurve, DEFAULT_CAPACITY_CONFIG, evaluateExitCapacity, impactAtSize, maxSafePosition, planCapacitySizing, replaySizeScenarios, simulatePartialExit,
  type CapacityMarket, type ExitCapacityResult,
} from '../src/exit-capacity.js';
import { estimatePriceImpactPercent } from '../src/paper-fills.js';

/** pump.fun-like curve: 30 SOL virtual reserve, 150 USD/SOL, price 0.00003 USD. */
const deepCurve: CapacityMarket = { priceUsd: 0.00003, liquidityUsd: 20_000, curve: { virtualQuote: 30, virtualBase: 30 / (0.00003 / 150), realQuote: 60, quoteUsd: 150 }, sellability: 'VERIFIED', dataAgeMs: 0 };
const thinCurve: CapacityMarket = { ...deepCurve, curve: { virtualQuote: 2, virtualBase: 2 / (0.00003 / 150), realQuote: 1, quoteUsd: 150 } };

const plan = (riskApprovedSize: number, capacity: ExitCapacityResult, mode: 'MONITOR_ONLY' | 'ENFORCE_PAPER' = 'ENFORCE_PAPER') => planCapacitySizing({ requestedSize: riskApprovedSize, riskApprovedSize, capacity, liquidityUsd: 20_000, mode, config: DEFAULT_CAPACITY_CONFIG });

describe('exit capacity engine', () => {
  it('small position in a deep enough pool: capacity never increases the risk allowance (100 stays 100)', () => {
    const capacity = evaluateExitCapacity(deepCurve, 100);
    expect(capacity.maxSafePosition!).toBeGreaterThan(100);
    const sizing = plan(100, capacity);
    expect(sizing.finalRecommendedSize).toBe(100);
    expect(sizing.decision).toBe('KEEP');
  });

  it('oversized position: reduced to the maximum safe size (risk 500 -> safe maximum)', () => {
    const capacity = evaluateExitCapacity(thinCurve, 500);
    expect(capacity.maxSafePosition!).toBeLessThan(500);
    const sizing = plan(500, capacity);
    expect(sizing.finalRecommendedSize).toBe(capacity.maxSafePosition);
    expect(sizing.decision).toBe('REDUCE');
    expect(sizing.reductionReason).toBe('EXIT_CAPACITY');
    // The safe maximum really keeps the full exit within the configured impact.
    expect(impactAtSize(thinCurve, capacity.maxSafePosition!).sellImpactPct!).toBeLessThanOrEqual(DEFAULT_CAPACITY_CONFIG.maxExitImpactPct);
    expect(impactAtSize(thinCurve, capacity.maxSafePosition! + 2).sellImpactPct!).toBeGreaterThan(DEFAULT_CAPACITY_CONFIG.maxExitImpactPct - 0.5);
  });

  it('spec example: risk 200, safe 100 -> approved 100 with reduction reason EXIT_CAPACITY', () => {
    const capacity = { ...evaluateExitCapacity(deepCurve, 200), maxSafePosition: 100, bindingConstraint: 'EXIT_IMPACT' as const };
    const sizing = plan(200, capacity);
    expect(sizing).toMatchObject({ requestedSize: 200, riskApprovedSize: 200, finalRecommendedSize: 100, executedSize: 100, reductionReason: 'EXIT_CAPACITY' });
  });

  it('MONITOR_ONLY never changes the executed size (only the recommendation)', () => {
    const capacity = evaluateExitCapacity(thinCurve, 500);
    const sizing = plan(500, capacity, 'MONITOR_ONLY');
    expect(sizing.executedSize).toBe(500);
    expect(sizing.finalRecommendedSize).toBeLessThan(500);
  });

  it('no sell route -> UNSAFE; no data -> UNKNOWN; neither is ever GOOD', () => {
    expect(evaluateExitCapacity({ ...deepCurve, sellRouteAvailable: false }, 50).classification).toBe('UNSAFE');
    const unknown = evaluateExitCapacity({ priceUsd: 0.00003, liquidityUsd: null }, 50);
    expect(unknown.classification).toBe('UNKNOWN');
    expect(unknown.basis).toBe('INSUFFICIENT_DATA');
    expect(plan(50, unknown).decision).toBe('BLOCK_UNKNOWN');
    expect(evaluateExitCapacity({ ...deepCurve, dataAgeMs: 120_000 }, 50).classification).toBe('UNKNOWN');
  });

  it('unverified sellability is never treated as safe because of high liquidity', () => {
    const result = evaluateExitCapacity({ ...deepCurve, liquidityUsd: 10_000_000, sellability: 'NOT_VERIFIED' }, 10);
    expect(result.exitCapacityScore!).toBeLessThan(50);
    expect(['MODERATE', 'POOR', 'UNSAFE']).not.toContain('GOOD');
    expect(result.classification).not.toBe('GOOD');
    expect(result.warnings).toContain('SELLABILITY_NOT_VERIFIED');
  });

  it('too small to trade: a safe size below the executable minimum rejects in ENFORCE_PAPER', () => {
    const tiny: CapacityMarket = { ...deepCurve, curve: { virtualQuote: 0.2, virtualBase: 0.2 / (0.00003 / 150), realQuote: 0.1, quoteUsd: 150 } };
    const capacity = evaluateExitCapacity(tiny, 50);
    expect(capacity.maxSafePosition!).toBeLessThan(DEFAULT_CAPACITY_CONFIG.minimumExecutablePosition);
    expect(plan(50, capacity).decision).toBe('TOO_SMALL_TO_TRADE');
    expect(plan(50, capacity).executedSize).toBe(0);
  });

  it('size-dependent execution: the same pool gives a larger impact for a larger order (both models)', () => {
    for (const market of [deepCurve, { priceUsd: 0.00003, liquidityUsd: 20_000 }] as CapacityMarket[]) {
      const curve = capacityCurve(market, [20, 200, 2_000]);
      expect(curve[0].sellImpactPct!).toBeLessThan(curve[1].sellImpactPct!);
      expect(curve[1].sellImpactPct!).toBeLessThan(curve[2].sellImpactPct!);
    }
    expect(capacityCurve({ priceUsd: 1, liquidityUsd: 20_000 })[0].basis).toBe('LIQUIDITY_ESTIMATE');
    expect(capacityCurve(deepCurve)[0].basis).toBe('POOL_MODEL');
  });

  it('impact is applied exactly once: expected fills = price x (1 +/- impact)', () => {
    const result = evaluateExitCapacity(deepCurve, 100);
    expect(result.expectedBuyFill!).toBeCloseTo(0.00003 * (1 + result.estimatedBuyImpactPct! / 100), 15);
    expect(result.expectedImmediateSellFill!).toBeCloseTo(0.00003 * (1 - result.estimatedImmediateSellImpactPct! / 100), 15);
    expect(result.estimatedRoundTripCostPct!).toBeCloseTo(result.estimatedRoundTripImpactPct! + 0.6, 10);
  });

  it('pool reserve bound: an exit that would pay out more SOL than the real reserve is not feasible', () => {
    const drained: CapacityMarket = { ...deepCurve, curve: { ...deepCurve.curve!, realQuote: 0.05 } };
    expect(impactAtSize(drained, 100).feasible).toBe(false);
    expect(maxSafePosition(drained).binding).toBe('POOL_RESERVE');
  });
});

describe('historical size replay and partial exits', () => {
  const trades = Array.from({ length: 6 }, (_, index) => ({ id: `t${index}`, closedAt: index, entryMarketPrice: 1, exitMarketPrice: index % 2 ? 1.2 : 0.9, entryLiquidityUsd: 10_000, exitLiquidityUsd: index === 5 ? 1_000 : 9_000 }));

  it('larger positions keep less of the return per USDC; capacity-limited sizing reduces oversized trades', () => {
    const results = replaySizeScenarios(trades, [25, 1_000]);
    const small = results.find((row) => row.variant === 'UNCONSTRAINED' && row.sizeUsd === 25)!;
    const large = results.find((row) => row.variant === 'UNCONSTRAINED' && row.sizeUsd === 1_000)!;
    expect(large.returnOnCapitalPct!).toBeLessThan(small.returnOnCapitalPct!);
    expect(large.averageSellImpactPct!).toBeGreaterThan(small.averageSellImpactPct!);
    const limited = results.find((row) => row.variant === 'CAPACITY_LIMITED' && row.sizeUsd === 1_000)!;
    expect(limited.tradesReduced).toBe(6);
    expect(limited.capitalDeployed).toBeLessThan(large.capitalDeployed);
  });

  it('a 25 USDC replay reproduces the PAPER fill model exactly (no extra impact)', () => {
    const [one] = replaySizeScenarios([trades[1]], [25]);
    const buyFill = 1 * (1 + estimatePriceImpactPercent(25, 10_000) / 100);
    const quantity = 25 / buyFill;
    const sellFill = 1.2 * (1 - estimatePriceImpactPercent(quantity * 1.2, 9_000) / 100);
    expect(one.netPnl).toBeCloseTo(quantity * (sellFill - buyFill) - (25 + quantity * sellFill) * 0.003, 10);
  });

  it('partial exits use only observations at or before each chunk time (no lookahead)', () => {
    const path = [{ t: 0, price: 1, liquidityUsd: 10_000 }, { t: 1_000, price: 0.8, liquidityUsd: 10_000 }, { t: 5_000, price: 2, liquidityUsd: 10_000 }];
    const split = simulatePartialExit(path, 0, 100, 2, 2_000)!;
    expect(split.fills.map((fill) => fill.at)).toEqual([0, 2_000]);
    expect(split.fills[1].price).toBeLessThan(0.8);
    expect(simulatePartialExit([], 0, 100, 2, 1_000)).toBeNull();
  });
});
