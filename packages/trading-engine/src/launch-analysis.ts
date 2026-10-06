/**
 * NewLaunch trade analytics: performance metrics, robust distributions, buckets and a DIAGNOSTIC
 * (not absolute) classification of why a trade won or lost. Pure functions over closed trades.
 */

export interface PerformanceStats {
  trades: number;
  wins: number;
  losses: number;
  winRate: number | null;
  netPnl: number;
  grossProfit: number;
  grossLoss: number;
  profitFactor: number | null;
  expectancy: number | null;
  averageWinner: number | null;
  averageLoser: number | null;
  payoffRatio: number | null;
  /** Win rate needed to break even with the observed average winner / loser (descriptive, not a forecast). */
  breakEvenWinRate: number | null;
  maxDrawdown: number;
  averageMfePercent: number | null;
  averageMaePercent: number | null;
  averageHoldMs: number | null;
  averageCaptureRatio: number | null;
}

export interface PerformanceRow {
  netPnl: number;
  closedAt: number;
  mfePercent?: number | null;
  maePercent?: number | null;
  holdMs?: number | null;
  captureRatio?: number | null;
}

const avg = (values: Array<number | null | undefined>) => {
  const known = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  return known.length ? known.reduce((sum, value) => sum + value, 0) / known.length : null;
};

/** Peak-to-trough drop of the cumulative realised P&L in chronological order (USDC). */
export function realizedMaxDrawdown(rows: ReadonlyArray<PerformanceRow>) {
  let equity = 0;
  let peak = 0;
  let drawdown = 0;
  for (const row of [...rows].sort((a, b) => a.closedAt - b.closedAt)) {
    equity += row.netPnl;
    peak = Math.max(peak, equity);
    drawdown = Math.max(drawdown, peak - equity);
  }
  return drawdown;
}

export function performanceStats(rows: ReadonlyArray<PerformanceRow>): PerformanceStats {
  const winners = rows.filter((row) => row.netPnl > 0);
  const losers = rows.filter((row) => row.netPnl <= 0);
  const grossProfit = winners.reduce((sum, row) => sum + row.netPnl, 0);
  const grossLoss = Math.abs(losers.reduce((sum, row) => sum + row.netPnl, 0));
  const netPnl = grossProfit - grossLoss;
  const averageWinner = winners.length ? grossProfit / winners.length : null;
  const averageLoser = losers.length ? -grossLoss / losers.length : null;
  const payoffRatio = averageWinner !== null && averageLoser !== null && averageLoser < 0 ? averageWinner / Math.abs(averageLoser) : null;
  return {
    trades: rows.length,
    wins: winners.length,
    losses: losers.length,
    winRate: rows.length ? winners.length / rows.length * 100 : null,
    netPnl,
    grossProfit,
    grossLoss,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
    expectancy: rows.length ? netPnl / rows.length : null,
    averageWinner,
    averageLoser,
    payoffRatio,
    breakEvenWinRate: averageWinner !== null && averageLoser !== null && averageWinner + Math.abs(averageLoser) > 0 ? Math.abs(averageLoser) / (averageWinner + Math.abs(averageLoser)) * 100 : null,
    maxDrawdown: realizedMaxDrawdown(rows),
    averageMfePercent: avg(rows.map((row) => row.mfePercent)),
    averageMaePercent: avg(rows.map((row) => row.maePercent)),
    averageHoldMs: avg(rows.map((row) => row.holdMs)),
    averageCaptureRatio: avg(rows.map((row) => row.captureRatio)),
  };
}

export interface Distribution { count: number; average: number | null; median: number | null; p25: number | null; p75: number | null }

function quantile(sorted: number[], q: number) {
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

/** Robust summary; memecoin distributions have extreme outliers, so median / quartiles are reported too. */
export function distribution(values: ReadonlyArray<number | null | undefined>): Distribution {
  const known = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value)).sort((a, b) => a - b);
  return { count: known.length, average: avg(known), median: quantile(known, 0.5), p25: known.length >= 4 ? quantile(known, 0.25) : null, p75: known.length >= 4 ? quantile(known, 0.75) : null };
}

export interface BucketDefinition { label: string; test: (value: number) => boolean }

/** Buckets in the given order; rows whose value is unknown go to "Ismeretlen"; empty buckets are dropped. */
export function bucketPerformance<T extends PerformanceRow>(rows: ReadonlyArray<T>, value: (row: T) => number | null | undefined, buckets: ReadonlyArray<BucketDefinition>) {
  const groups = buckets.map((bucket) => ({ label: bucket.label, rows: [] as T[] }));
  const unknown: T[] = [];
  for (const row of rows) {
    const v = value(row);
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      unknown.push(row);
      continue;
    }
    const index = buckets.findIndex((bucket) => bucket.test(v));
    if (index >= 0) groups[index].rows.push(row);
  }
  const result = groups.filter((group) => group.rows.length > 0).map((group) => ({ label: group.label, ...performanceStats(group.rows) }));
  if (unknown.length) result.push({ label: 'Ismeretlen', ...performanceStats(unknown) });
  return result;
}

export const range = (min: number, max: number) => (value: number) => value >= min && value < max;

// ---------------------------------------------------------------------------------------------
// Diagnostic classification
// ---------------------------------------------------------------------------------------------

export type TradeDiagnosis = 'POOR_ENTRY' | 'GOOD_ENTRY_BAD_EXIT' | 'NORMAL_LOSS' | 'SUCCESSFUL_EXIT' | 'UNCLASSIFIED';

/**
 * Configurable, documented rules. Defaults:
 *  - POOR_ENTRY: losing trade whose MFE stayed below +3% and that either reached a -10% MAE or was
 *    stopped out, within 120 s of entry.
 *  - GOOD_ENTRY_BAD_EXIT: losing (net <= 0) trade whose MFE reached at least +10%.
 *  - SUCCESSFUL_EXIT: winning trade that kept at least 30% of its MFE (profit capture ratio).
 *  - NORMAL_LOSS: any other losing trade.  - UNCLASSIFIED: no path data, or a low-capture win.
 */
export interface DiagnosticRules {
  poorEntryMaxMfePercent: number;
  poorEntryMaePercent: number;
  poorEntryWithinMs: number;
  goodEntryMinMfePercent: number;
  successfulMinCaptureRatio: number;
}

export const DEFAULT_DIAGNOSTIC_RULES: DiagnosticRules = { poorEntryMaxMfePercent: 3, poorEntryMaePercent: 10, poorEntryWithinMs: 120_000, goodEntryMinMfePercent: 10, successfulMinCaptureRatio: 0.3 };

export interface DiagnosticInput {
  netPnl: number;
  realizedReturnPercent: number;
  mfePercent: number | null;
  maePercent: number | null;
  timeToMaeMs: number | null;
  holdMs: number | null;
  exitReason: string | null;
}

/** Share of the MFE that was realised; only for winning trades with a positive MFE. */
export function profitCaptureRatio(realizedReturnPercent: number, mfePercent: number | null) {
  if (mfePercent === null || !(mfePercent > 0) || !(realizedReturnPercent > 0)) return null;
  return realizedReturnPercent / mfePercent;
}

/** Percentage points of the peak gain given back before the exit (MFE - realised return). */
export function profitGivebackPercent(realizedReturnPercent: number, mfePercent: number | null) {
  if (mfePercent === null || !(mfePercent > 0)) return null;
  return Math.max(0, mfePercent - realizedReturnPercent);
}

export function classifyTrade(input: DiagnosticInput, rules: DiagnosticRules = DEFAULT_DIAGNOSTIC_RULES): TradeDiagnosis {
  if (input.mfePercent === null) return 'UNCLASSIFIED';
  if (input.netPnl > 0) {
    const capture = profitCaptureRatio(input.realizedReturnPercent, input.mfePercent);
    return capture !== null && capture >= rules.successfulMinCaptureRatio ? 'SUCCESSFUL_EXIT' : 'UNCLASSIFIED';
  }
  if (input.mfePercent >= rules.goodEntryMinMfePercent) return 'GOOD_ENTRY_BAD_EXIT';
  const deepFast = input.maePercent !== null && input.maePercent <= -rules.poorEntryMaePercent && input.timeToMaeMs !== null && input.timeToMaeMs <= rules.poorEntryWithinMs;
  const fastStop = input.exitReason === 'STOP_LOSS' && input.holdMs !== null && input.holdMs <= rules.poorEntryWithinMs;
  if (input.mfePercent < rules.poorEntryMaxMfePercent && (deepFast || fastStop)) return 'POOR_ENTRY';
  return 'NORMAL_LOSS';
}
