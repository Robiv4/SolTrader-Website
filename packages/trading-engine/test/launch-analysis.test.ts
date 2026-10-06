import { describe, expect, it } from 'vitest';

import {
  advancePathMetric,
  chronologicalSplit,
  classifyTrade,
  distribution,
  exitParameterGrid,
  initPathMetric,
  optimizeEntryFilters,
  passesFilter,
  pathMetricFromSeries,
  performanceStats,
  profitCaptureRatio,
  profitGivebackPercent,
  simulateEntryFilter,
  simulateExit,
  summarizePathMetric,
  type ExitSimulationTrade,
  type OptimizerTrade,
} from '../src/index.js';

const T0 = Date.UTC(2026, 8, 30, 10);

describe('path metrics (MFE / MAE / milestones)', () => {
  it('entry 100, path 95 -> 110 -> 120 -> 108: MFE +20%, MAE -5%, realised +8%', () => {
    let state = initPathMetric(100, T0, 2);
    for (const [offset, price] of [[1_000, 95], [2_000, 110], [3_000, 120], [4_000, 108]] as const) state = advancePathMetric(state, price, T0 + offset);
    const summary = summarizePathMetric(state);
    expect(summary.mfePercent).toBeCloseTo(20, 10);
    expect(summary.maePercent).toBeCloseTo(-5, 10);
    expect(summary.mfeUsd).toBeCloseTo(40, 10);
    expect(summary.maeUsd).toBeCloseTo(-10, 10);
    expect(summary.timeToMfeMs).toBe(3_000);
    expect(summary.timeToMaeMs).toBe(1_000);
    expect((108 / 100 - 1) * 100).toBeCloseTo(8, 10);
    // First-reach milestones from real observations only.
    expect(summary.milestones).toEqual({ '-3': 1_000, '-5': 1_000, '+3': 2_000, '+5': 2_000, '+10': 2_000, '+15': 3_000, '+20': 3_000 });
  });

  it('ignores out-of-order / pre-entry samples and never fabricates a path', () => {
    let state = initPathMetric(100, T0, 1);
    state = advancePathMetric(state, 110, T0 + 5_000);
    state = advancePathMetric(state, 200, T0 + 4_000);
    state = advancePathMetric(state, 50, T0 - 1_000);
    expect(summarizePathMetric(state).mfePercent).toBeCloseTo(10, 10);
    expect(summarizePathMetric(state).maePercent).toBe(0);
    expect(pathMetricFromSeries([{ t: T0 + 1, price: 101 }, { t: T0 + 2, price: 102 }], 100, T0, T0 + 10, 1)).toBeNull();
    expect(summarizePathMetric(initPathMetric(100, T0, 1)).mfePercent).toBeNull();
  });
});

describe('diagnostic classification', () => {
  it('reached +18% then closed -3% -> GOOD_ENTRY_BAD_EXIT', () => {
    expect(classifyTrade({ netPnl: -0.3, realizedReturnPercent: -3, mfePercent: 18, maePercent: -4, timeToMaeMs: 90_000, holdMs: 120_000, exitReason: 'STOP_LOSS' })).toBe('GOOD_ENTRY_BAD_EXIT');
  });

  it('never above +1%, -20% within seconds -> POOR_ENTRY', () => {
    expect(classifyTrade({ netPnl: -2, realizedReturnPercent: -20, mfePercent: 1, maePercent: -20, timeToMaeMs: 12_000, holdMs: 12_000, exitReason: 'STOP_LOSS' })).toBe('POOR_ENTRY');
  });

  it('winners with a reasonable capture are SUCCESSFUL_EXIT; missing path data stays UNCLASSIFIED', () => {
    expect(classifyTrade({ netPnl: 1, realizedReturnPercent: 10, mfePercent: 20, maePercent: -2, timeToMaeMs: 1, holdMs: 1, exitReason: 'TRAILING_STOP' })).toBe('SUCCESSFUL_EXIT');
    expect(classifyTrade({ netPnl: 1, realizedReturnPercent: 10, mfePercent: null, maePercent: null, timeToMaeMs: null, holdMs: 1, exitReason: 'TAKE_PROFIT' })).toBe('UNCLASSIFIED');
    expect(classifyTrade({ netPnl: -1, realizedReturnPercent: -6, mfePercent: 5, maePercent: -8, timeToMaeMs: 600_000, holdMs: 600_000, exitReason: 'STOP_LOSS' })).toBe('NORMAL_LOSS');
  });

  it('profit capture and giveback handle zero / negative MFE safely', () => {
    expect(profitCaptureRatio(5, 20)).toBeCloseTo(0.25, 10);
    expect(profitGivebackPercent(5, 20)).toBeCloseTo(15, 10);
    expect(profitCaptureRatio(5, 0)).toBeNull();
    expect(profitCaptureRatio(-3, 18)).toBeNull();
    expect(profitGivebackPercent(-3, 18)).toBeCloseTo(21, 10);
    expect(profitGivebackPercent(-3, null)).toBeNull();
  });
});

describe('performance statistics', () => {
  it('7 winners x +3 and 3 losers x -8 is negative despite a 70% win rate', () => {
    const rows = [...Array.from({ length: 7 }, (_, i) => ({ netPnl: 3, closedAt: i })), ...Array.from({ length: 3 }, (_, i) => ({ netPnl: -8, closedAt: 10 + i }))];
    const stats = performanceStats(rows);
    expect(stats.winRate).toBe(70);
    expect(stats.netPnl).toBe(-3);
    expect(stats.profitFactor).toBeCloseTo(21 / 24, 10);
    expect(stats.payoffRatio).toBeCloseTo(3 / 8, 10);
    // With +3 / -8 a win rate of 8 / 11 = 72.7% is needed to break even.
    expect(stats.breakEvenWinRate).toBeCloseTo(8 / 11 * 100, 8);
    expect(stats.maxDrawdown).toBe(24);
  });

  it('distribution reports median and quartiles, not only the average', () => {
    const summary = distribution([1, 2, 3, 4, 100]);
    expect(summary.average).toBe(22);
    expect(summary.median).toBe(3);
    expect(summary.p25).toBe(2);
    expect(summary.p75).toBe(4);
    expect(distribution([null, undefined]).count).toBe(0);
  });
});

/** Synthetic history where low launch scores lose and high ones win (both in train and validation). */
function history(count: number, flipLate = false): OptimizerTrade[] {
  return Array.from({ length: count }, (_, i) => {
    const score = 60 + (i * 7) % 35;
    const late = i >= count * 0.7;
    const good = flipLate && late ? score < 75 : score >= 75;
    return { id: `t${i}`, closedAt: T0 + i * 60_000, netPnl: good ? 2 : -3, features: { launchScore: score, uniqueBuyers: 10 + (i % 20), liquidityUsd: null } };
  });
}

describe('entry filter optimizer', () => {
  it('requires a minimum sample before recommending anything', () => {
    const result = optimizeEntryFilters(history(30), { minScore: 70 });
    expect(result.sufficientData).toBe(false);
    expect(result.recommendations).toEqual([]);
  });

  it('splits chronologically (never shuffled) and validates the tuned value on later trades', () => {
    const trades = history(120);
    const { train, validation } = chronologicalSplit([...trades].reverse(), 0.7);
    expect(train.at(-1)!.closedAt).toBeLessThan(validation[0].closedAt);
    const result = optimizeEntryFilters(trades, { minScore: 70 });
    const recommendation = result.recommendations.find((item) => item.parameter === 'minScore');
    expect(recommendation).toBeDefined();
    expect(recommendation!.suggestedValue).toBeGreaterThanOrEqual(75);
    expect(recommendation!.possibleOverfit).toBe(false);
    expect(recommendation!.validationMetrics.filtered.expectancy!).toBeGreaterThan(recommendation!.validationMetrics.base.expectancy!);
    expect(['MEDIUM', 'HIGH']).toContain(recommendation!.confidenceLevel);
  });

  it('flags a filter that only worked in the training window as possible overfitting', () => {
    const recommendation = optimizeEntryFilters(history(120, true), { minScore: 70 }).recommendations.find((item) => item.parameter === 'minScore');
    expect(recommendation?.possibleOverfit).toBe(true);
    expect(recommendation?.confidenceLevel).toBe('LOW');
    expect(recommendation?.warnings.join(' ')).toContain('LEHETSÉGES TÚLILLESZTÉS');
  });

  it('historical filter simulation counts retained winners / removed losers; unknown features never pass', () => {
    const trades = history(100);
    const simulation = simulateEntryFilter(trades, [{ feature: 'launchScore', kind: 'min', value: 75 }]);
    expect(simulation.label).toBe('HISTORICAL SIMULATION — NOT FUTURE PERFORMANCE');
    expect(simulation.winnersRetained).toBe(simulation.winners);
    expect(simulation.losersRemoved).toBe(simulation.losers);
    expect(passesFilter(trades[0], [{ feature: 'liquidityUsd', kind: 'min', value: 0 }])).toBe(false);
  });
});

describe('exit parameter simulation (stored prices only, same Exit Engine)', () => {
  const trade = (path: Array<[number, number]>): ExitSimulationTrade => ({ id: 'x', entryAt: T0, entryPrice: 100, quantity: 1, feeBps: 30, exitSlippagePercent: 0.5, path: path.map(([offset, price]) => ({ t: T0 + offset, price })) });
  const config = { stopLossPercent: 10, takeProfitPercent: 20, breakEvenActivationPercent: null, trailingActivationPercent: null, trailingDistancePercent: null };

  it('exits at the FIRST triggering observation (no lookahead) and includes fees and slippage', () => {
    const result = simulateExit(trade([[2_000, 105], [4_000, 121], [6_000, 200]]), config);
    expect(result.status).toBe('RESOLVED');
    expect(result.exitReason).toBe('TAKE_PROFIT');
    expect(result.exitAt).toBe(T0 + 4_000);
    const proceeds = 121 * 0.995;
    expect(result.netPnl).toBeCloseTo(proceeds - 100 - (100 + proceeds) * 0.003, 8);
  });

  it('a jump through the stop right after being near the target is AMBIGUOUS_EVENT_ORDER, never assumed profitable', () => {
    // Previous observation 118 (1.7% below TP 120, 23.7% above SL 90), next 85: the TP may have been touched first.
    expect(simulateExit(trade([[1_000, 118], [2_000, 85]]), config).status).toBe('AMBIGUOUS_EVENT_ORDER');
    // From 105 (nearer the stop than the target) a drop to 85 is an unambiguous stop loss.
    const resolved = simulateExit(trade([[1_000, 105], [2_000, 85]]), config);
    expect(resolved.status).toBe('RESOLVED');
    expect(resolved.exitReason).toBe('STOP_LOSS');
  });

  it('gaps longer than the resolution limit and paths without an exit are excluded', () => {
    expect(simulateExit(trade([[120_000, 130]]), config).status).toBe('LOW_RESOLUTION');
    expect(simulateExit(trade([[1_000, 101], [2_000, 102]]), config).status).toBe('NO_EXIT_IN_DATA');
  });

  it('grid reports every cell without choosing a winner', () => {
    const cells = exitParameterGrid([trade([[1_000, 105], [2_000, 116], [3_000, 89]])], [10, 15], [15, 25], (sl, tp) => ({ ...config, stopLossPercent: sl, takeProfitPercent: tp }));
    expect(cells).toHaveLength(4);
    expect(cells.every((cell) => !('best' in cell))).toBe(true);
    expect(cells.find((cell) => cell.x === 10 && cell.y === 15)!.stats!.netPnl).toBeGreaterThan(0);
    // SL 10 / TP 25: from 116 (nearer the 125 target) straight to 89 -> the order is unknown, excluded.
    const wide = cells.find((cell) => cell.x === 10 && cell.y === 25)!;
    expect(wide.ambiguous).toBe(1);
    expect(wide.stats).toBeNull();
  });
});
