import { describe, expect, it } from 'vitest';

import { aiDecisionFunnel, type AnalyticsTrade, computeTradeAnalytics, holdingBucket, newLaunchAnalytics, profitFactor, realizedDrawdown, signalScoreBucket } from '../src/trade-analytics.js';

function trade(overrides: Partial<AnalyticsTrade>): AnalyticsTrade {
  return {
    netPnl: 0, grossPnl: 0, fees: 0.3, slippage: 0.2, size: 100, entryPrice: 1, exitPrice: 1,
    entryAt: new Date('2026-09-28T10:00:00Z'), exitAt: new Date('2026-09-28T10:02:00Z'),
    strategy: 'MomentumStrategy', exitReason: 'TAKE_PROFIT', riskClassification: 'HIGH', signalScore: 65, manual: false,
    highestPrice: 1.1, lowestPrice: 0.95, trailingActivationPercent: null, trailingActivationPrice: null, trailingActivatedAt: null,
    ...overrides,
  };
}

describe('closed-trade analytics', () => {
  const rows = [
    trade({ netPnl: 10, grossPnl: 10.6, strategy: 'MomentumStrategy', exitReason: 'TAKE_PROFIT', signalScore: 72 }),
    trade({ netPnl: -4, grossPnl: -3.4, strategy: 'MomentumStrategy', exitReason: 'STOP_LOSS', signalScore: 38 }),
    // Gross positive but net negative: a LOSS.
    trade({ netPnl: -0.1, grossPnl: 0.5, strategy: 'BreakoutStrategy', exitReason: 'TRAILING_STOP', signalScore: 55, exitPrice: 0.99, highestPrice: 1.004 }),
    trade({ netPnl: -6, grossPnl: -5.4, strategy: 'MANUAL_PAPER', manual: true, exitReason: 'manual-close', signalScore: 20 }),
    trade({ netPnl: 5, grossPnl: 5.6, strategy: 'BreakoutStrategy', exitReason: 'TRAILING_STOP', signalScore: 91, exitPrice: 1.05, highestPrice: 1.2, trailingActivationPercent: 0.15, trailingActivationPrice: 1.16 }),
  ];
  const metrics = computeTradeAnalytics(rows, 1_000);

  it('counts wins/losses on final net P&L', () => {
    expect(metrics.wins).toBe(2);
    expect(metrics.losses).toBe(3);
    expect(metrics.winRate).toBeCloseTo(40, 10);
  });

  it('computes profit factor, expectancy and net P&L', () => {
    expect(metrics.realizedPnl).toBeCloseTo(4.9, 10);
    expect(metrics.profitFactor).toBeCloseTo(15 / 10.1, 10);
    expect(metrics.expectancy).toBeCloseTo(4.9 / 5, 10);
    expect(metrics.totalFees).toBeCloseTo(1.5, 10);
  });

  it('computes max drawdown in USD and percent of the running peak', () => {
    // Equity: 1010, 1006, 1005.9, 999.9, 1004.9 -> peak 1010, trough 999.9.
    expect(metrics.maxDrawdown).toBeCloseTo(10.1, 10);
    expect(metrics.maxDrawdownPercent).toBeCloseTo(10.1 / 1010 * 100, 10);
  });

  it('groups by strategy, exit reason, execution source and signal bucket', () => {
    const byReason = Object.fromEntries(metrics.exitReasonDistribution.map((group) => [group.name, group]));
    expect(byReason.TRAILING_STOP.trades).toBe(2);
    expect(byReason.TRAILING_STOP.netPnl).toBeCloseTo(4.9, 10);
    const bySource = Object.fromEntries(metrics.executionSourcePerformance.map((group) => [group.name, group]));
    expect(bySource.AUTOMATIC.trades).toBe(4);
    expect(bySource.MANUAL_PAPER.trades).toBe(1);
    // Manual trades are excluded from the automatic strategy table.
    expect(metrics.automaticStrategyPerformance.map((group) => group.name)).not.toContain('MANUAL_PAPER');
    const buckets = Object.fromEntries(metrics.signalScorePerformance.map((group) => [group.name, group.trades]));
    expect(buckets).toEqual({ '0–39': 1, '50–59': 1, '70–79': 1, '90–100': 1 });
    expect(metrics.riskClassificationPerformance[0]).toMatchObject({ name: 'HIGH', trades: 5 });
  });

  it('flags trailing exits whose trailing was armed below net break-even', () => {
    const trailing = metrics.trailingDiagnostics;
    expect(trailing.trailingExits).toBe(2);
    expect(trailing.profitable).toBe(1);
    // The legacy trade was armed from entry (below +0.6%); the other activated at +16%.
    expect(trailing.activatedBelowNetBreakEven).toBe(1);
    expect(trailing.peakNeverAboveNetBreakEven).toBe(1);
    expect(trailing.averageGainAtActivationPercent).toBeCloseTo(8, 10);
    expect(trailing.flagged).toBe(true);
  });

  it('handles empty and loss-free inputs safely', () => {
    expect(profitFactor([])).toBe(0);
    expect(profitFactor([1, 2])).toBeNull();
    expect(realizedDrawdown([], 1_000)).toEqual({ maxDrawdown: 0, maxDrawdownPercent: 0 });
    expect(computeTradeAnalytics([], 1_000)).toMatchObject({ totalTrades: 0, winRate: 0, expectancy: 0, profitFactor: 0 });
  });

  it('buckets signal scores and holding times at their boundaries', () => {
    expect(signalScoreBucket(39.9)).toBe('0–39');
    expect(signalScoreBucket(40)).toBe('40–49');
    expect(signalScoreBucket(89.9)).toBe('80–89');
    expect(signalScoreBucket(90)).toBe('90–100');
    expect(signalScoreBucket(null)).toBe('n/a');
    expect(holdingBucket(59_999)).toBe('< 1 perc');
    expect(holdingBucket(60_000)).toBe('1–5 perc');
  });
});

describe('signal experiment analytics', () => {
  const base = { grossPnl: 0, fees: 0.3, slippage: 0.1, size: 100, entryPrice: 1, exitPrice: 1, entryAt: new Date('2026-09-28T10:00:00Z'), exitAt: new Date('2026-09-28T10:05:00Z'), strategy: 'CompositeSignal', exitReason: 'TAKE_PROFIT', riskClassification: 'HIGH', signalScore: 70, manual: false, highestPrice: null, lowestPrice: null, trailingActivationPercent: null, trailingActivationPrice: null, trailingActivatedAt: null };
  const rows: AnalyticsTrade[] = [
    { ...base, netPnl: 5, confirmations: ['VolumeSpike', 'BuyPressure', 'MomentumAcceleration'], compositeScore: 84, exhaustionScore: 12, primaryStrategy: 'CompositeSignal' },
    { ...base, netPnl: -2, confirmations: ['VolumeSpike', 'BuyPressure'], compositeScore: 66, exhaustionScore: 55, primaryStrategy: 'CompositeSignal' },
    { ...base, netPnl: 3, confirmations: ['Momentum', 'VolumeSpike'], compositeScore: 72, exhaustionScore: 25, primaryStrategy: 'MomentumStrategy' },
    // Older trade without recorded signal context: excluded from the signal groupings, not guessed.
    { ...base, netPnl: -1, confirmations: null, compositeScore: null, exhaustionScore: null, primaryStrategy: null, strategy: 'BreakoutStrategy' },
  ];
  const report = computeTradeAnalytics(rows, 1_000);

  it('groups trades containing each confirmation', () => {
    const byModule = Object.fromEntries(report.confirmationPerformance.map((group) => [group.name, group]));
    expect(byModule.VolumeSpike).toMatchObject({ trades: 3, wins: 2 });
    expect(byModule.VolumeSpike.netPnl).toBeCloseTo(6, 10);
    expect(byModule.VolumeSpike.expectancy).toBeCloseTo(2, 10);
    expect(byModule.BuyPressure.profitFactor).toBeCloseTo(2.5, 10);
    expect(report.signalContextTrades).toBe(3);
  });

  it('tracks exact combinations and pairs with sample sizes', () => {
    expect(report.combinationPerformance.exact.map((group) => [group.name, group.trades])).toEqual(expect.arrayContaining([['BuyPressure + MomentumAcceleration + VolumeSpike', 1], ['BuyPressure + VolumeSpike', 1], ['Momentum + VolumeSpike', 1]]));
    const pair = report.combinationPerformance.pairs.find((group) => group.name === 'BuyPressure + VolumeSpike');
    expect(pair).toMatchObject({ trades: 2, wins: 1 });
    expect(pair?.maxDrawdown).toBeNull();
  });

  it('buckets composite and exhaustion scores and groups by primary strategy', () => {
    expect(report.compositeScorePerformance.map((group) => [group.name, group.trades])).toEqual([['60–69', 1], ['70–79', 1], ['80–89', 1]]);
    expect(report.exhaustionScorePerformance.map((group) => [group.name, group.trades])).toEqual([['0–19', 1], ['20–39', 1], ['40–59', 1]]);
    expect(Object.fromEntries(report.primaryStrategyPerformance.map((group) => [group.name, group.trades]))).toEqual({ CompositeSignal: 2, MomentumStrategy: 1, BreakoutStrategy: 1 });
  });
});

describe('AI vs Strategy analytics', () => {
  const base = { grossPnl: 0, fees: 0.3, slippage: 0.1, size: 100, entryPrice: 1, exitPrice: 1, entryAt: new Date('2026-09-28T10:00:00Z'), exitAt: new Date('2026-09-28T10:05:00Z'), strategy: 'X', exitReason: 'TAKE_PROFIT', riskClassification: 'HIGH', signalScore: 70, manual: false, highestPrice: null, lowestPrice: null, trailingActivationPercent: null, trailingActivationPrice: null, trailingActivatedAt: null };
  const rows: AnalyticsTrade[] = [
    { ...base, netPnl: 4, decisionSource: 'AI', aiConfidence: 86 },
    { ...base, netPnl: -2, decisionSource: 'AI', aiConfidence: 77 },
    { ...base, netPnl: 3, decisionSource: 'STRATEGY' },
    { ...base, netPnl: -1, decisionSource: 'MANUAL_PAPER', manual: true },
  ];
  const report = computeTradeAnalytics(rows, 1_000);

  it('keeps AI, Strategy and Manual separate with averages', () => {
    const bySource = Object.fromEntries(report.decisionSourcePerformance.map((group) => [group.name, group]));
    expect(bySource.AI).toMatchObject({ trades: 2, wins: 1, averageWin: 4, averageLoss: -2 });
    expect(bySource.AI.profitFactor).toBeCloseTo(2, 10);
    expect(bySource.STRATEGY.trades).toBe(1);
    expect(bySource.MANUAL_PAPER.trades).toBe(1);
  });

  it('buckets AI trades by confidence', () => {
    expect(report.aiConfidencePerformance.map((group) => [group.name, group.trades])).toEqual([['70–79', 1], ['80–89', 1]]);
  });

  it('computes the WATCH funnel', () => {
    const at = (minute: number) => new Date(Date.UTC(2026, 8, 28, 16, minute));
    const funnel = aiDecisionFunnel([
      { tokenId: 'A', effectiveDecision: 'WATCH', createdAt: at(0) },
      { tokenId: 'A', effectiveDecision: 'WATCH', createdAt: at(1) },
      { tokenId: 'A', effectiveDecision: 'BUY', createdAt: at(2) },
      { tokenId: 'B', effectiveDecision: 'WATCH', createdAt: at(0) },
      { tokenId: 'B', effectiveDecision: 'SKIP', createdAt: at(3) },
      { tokenId: 'C', effectiveDecision: 'SKIP', createdAt: at(0) },
    ]);
    expect(funnel).toMatchObject({ buy: 1, watch: 3, skip: 2, watchToBuy: 1, watchToSkip: 1, averageWatchToBuyMs: 2 * 60_000 });
  });
});

describe('NewLaunch analytics', () => {
  const launch = (overrides: Partial<AnalyticsTrade>) => trade({ decisionSource: 'NEW_LAUNCH', strategy: 'NewLaunchStrategy', ...overrides });
  const rows = [
    launch({ netPnl: 3, launchScore: 85, launchAgeSeconds: 8, launchLiquidityUsd: 12_000, exitReason: 'TAKE_PROFIT' }),
    launch({ netPnl: -2, launchScore: 72, launchAgeSeconds: 45, launchLiquidityUsd: 30_000, exitReason: 'STOP_LOSS' }),
    launch({ netPnl: 0.1, launchScore: 74, launchAgeSeconds: 25, launchLiquidityUsd: 60_000, exitReason: 'STOP_LOSS', breakEvenApplied: true }),
    // Other decision sources never leak into the NewLaunch section.
    trade({ netPnl: 50, decisionSource: 'AI' }),
  ];
  const result = newLaunchAnalytics(rows);

  it('summarises only NEW_LAUNCH trades', () => {
    expect(result.summary.trades).toBe(3);
    expect(result.summary.netPnl).toBeCloseTo(1.1, 10);
    expect(result.summary.averageLaunchScore).toBeCloseTo(77, 10);
    expect(result.summary.averageEntryAgeSeconds).toBeCloseTo(26, 10);
  });

  it('groups by launch score, entry age, entry liquidity and exit reason', () => {
    const count = (items: Array<{ name: string; trades: number }>, name: string) => items.find((item) => item.name === name)?.trades ?? 0;
    expect(count(result.byLaunchScore, '80–89')).toBe(1);
    expect(count(result.byLaunchScore, '70–79')).toBe(2);
    expect(count(result.byEntryAge, '0–10 mp')).toBe(1);
    expect(count(result.byEntryAge, '31–60 mp')).toBe(1);
    expect(count(result.byEntryLiquidity, '$10k–25k')).toBe(1);
    expect(count(result.byEntryLiquidity, '$50k–100k')).toBe(1);
    expect(count(result.byExitReason, 'BREAK_EVEN')).toBe(1);
    expect(count(result.byExitReason, 'STOP_LOSS')).toBe(1);
    expect(count(result.byExitReason, 'TAKE_PROFIT')).toBe(1);
  });

  it('is part of the overall analytics payload', () => {
    expect(computeTradeAnalytics(rows, 1_000).newLaunch.summary.trades).toBe(3);
  });
});
