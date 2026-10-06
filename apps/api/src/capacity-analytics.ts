/**
 * NewLaunch liquidity / exit-capacity analytics (stored data only).
 *
 * - Entry snapshots (exit capacity, shadow sizing) exist only for trades opened after the capacity engine was added;
 *   older trades contribute only through the replay below.
 * - Replay: every historical trade at other position sizes with the PAPER liquidity model at the stored entry / exit
 *   liquidity. The market path is held fixed (a larger order is assumed not to change other traders' behaviour) -
 *   an OPTIMISTIC assumption for large sizes. It is a counterfactual, never a forecast, and never rewrites trades.
 */
import { DEFAULT_CAPACITY_CONFIG, maxSafePosition, PAPER_FEE_BPS, replaySizeScenarios, simulatePartialExit, type CapacityConfig } from '@soltrader/trading-engine';

import type { LaunchTradeRow } from './new-launch-analytics.js';

type Json = Record<string, unknown>;
const record = (value: unknown): Json => (value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {});
const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

export const SCENARIO_SIZES = [25, 50, 100, 200, 500, 1_000];

function percentile(values: Array<number | null | undefined>, q: number) {
  const known = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value)).sort((a, b) => a - b);
  return known.length ? known[Math.min(known.length - 1, Math.floor((known.length - 1) * q))] : null;
}
const average = (values: Array<number | null | undefined>) => {
  const known = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  return known.length ? known.reduce((sum, value) => sum + value, 0) / known.length : null;
};

function stats(rows: LaunchTradeRow[]) {
  const wins = rows.filter((row) => row.netPnl > 0);
  const grossWin = wins.reduce((sum, row) => sum + row.netPnl, 0);
  const grossLoss = -rows.filter((row) => row.netPnl <= 0).reduce((sum, row) => sum + row.netPnl, 0);
  return {
    trades: rows.length,
    winRate: rows.length ? wins.length / rows.length * 100 : null,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
    expectancy: rows.length ? rows.reduce((sum, row) => sum + row.netPnl, 0) / rows.length : null,
    averageMfePercent: average(rows.map((row) => row.mfePercent)),
    averageMaePercent: average(rows.map((row) => row.maePercent)),
    averageExitDeteriorationPercent: average(rows.map((row) => row.forensics?.exitSpeed.triggerToFillDeteriorationPercent)),
  };
}

export function buildCapacityAnalytics(rows: LaunchTradeRow[], config: CapacityConfig = DEFAULT_CAPACITY_CONFIG, partialPaths: Map<string, Array<{ t: number; price: number; liquidityUsd: number | null }>> = new Map()) {
  // ---- Entry snapshots (new trades) ----
  const snapshots = rows.map((row) => ({ row, capacity: record(row.capacityAtEntry) })).filter((item) => Object.keys(item.capacity).length > 0);
  const atEntry = snapshots.map((item) => record(item.capacity.atEntry));
  const sizing = snapshots.map((item) => record(item.capacity.sizing));
  const entrySummary = {
    tradesWithSnapshot: snapshots.length,
    averageExitCapacityScore: average(atEntry.map((item) => num(item.exitCapacityScore))),
    medianEntryImpactPct: percentile(atEntry.map((item) => num(item.estimatedBuyImpactPct)), 0.5),
    medianFullExitImpactPct: percentile(atEntry.map((item) => num(item.estimatedImmediateSellImpactPct)), 0.5),
    p95FullExitImpactPct: percentile(atEntry.map((item) => num(item.estimatedImmediateSellImpactPct)), 0.95),
    classificationCounts: atEntry.reduce<Record<string, number>>((counts, item) => {
      const key = String(item.classification ?? 'UNKNOWN');
      counts[key] = (counts[key] ?? 0) + 1;
      return counts;
    }, {}),
    basisCounts: atEntry.reduce<Record<string, number>>((counts, item) => {
      const key = String(item.basis ?? 'INSUFFICIENT_DATA');
      counts[key] = (counts[key] ?? 0) + 1;
      return counts;
    }, {}),
    wouldReduce: sizing.filter((item) => item.decision === 'REDUCE').length,
    wouldBlock: sizing.filter((item) => num(item.finalRecommendedSize) === 0).length,
    averageRecommendedReductionPct: average(sizing.filter((item) => item.decision === 'REDUCE').map((item) => (num(item.riskApprovedSize) && num(item.finalRecommendedSize) !== null ? (1 - num(item.finalRecommendedSize)! / num(item.riskApprovedSize)!) * 100 : null))),
    enforcedTrades: sizing.filter((item) => item.sizingMode === 'ENFORCE_PAPER').length,
  };
  const events = rows.flatMap((row) => row.forensics?.lifecycle ?? []);
  const deteriorationEvents = events.filter((event) => event.type === 'EXIT_CAPACITY_DETERIORATED').length;
  const routeLossEvents = events.filter((event) => event.type === 'SELL_ROUTE_LOST').length;

  // ---- Historical replay (all trades with stored entry / exit liquidity) ----
  const replayTrades = rows.map((row) => ({
    id: row.id, closedAt: row.closedAt,
    entryMarketPrice: row.entryMarketPrice ?? 0,
    exitMarketPrice: row.exitMarketPrice ?? 0,
    entryLiquidityUsd: row.liquidityAtEntry, exitLiquidityUsd: row.exitLiquidity ?? row.forensics?.liquidity.atTrigger ?? null,
  }));
  const scenarios = replaySizeScenarios(replayTrades, SCENARIO_SIZES, { ...config, feeBps: PAPER_FEE_BPS });
  // Calibration: the replay at each trade's ACTUAL size vs the actual PAPER result (shows the model error honestly).
  const calibration = rows.map((row, index) => {
    const replay = replaySizeScenarios([replayTrades[index]], [row.size], { ...config, feeBps: PAPER_FEE_BPS }).find((item) => item.variant === 'UNCONSTRAINED');
    return replay && replay.tradesExecutable ? { actual: row.netPnl, replay: replay.netPnl } : null;
  }).filter((item): item is { actual: number; replay: number } => item !== null);

  // ---- Per-trade max safe position at entry (stored liquidity; LIQUIDITY_ESTIMATE) ----
  const perTrade = rows.map((row) => {
    const snapshot = record(row.capacityAtEntry);
    const entry = record(snapshot.atEntry);
    const estimated = row.liquidityAtEntry ? maxSafePosition({ priceUsd: row.entryPrice, liquidityUsd: row.liquidityAtEntry }, config) : { size: null, binding: null };
    return {
      id: row.id, positionId: row.positionId, symbol: row.symbol, closedAt: new Date(row.closedAt).toISOString(), actualSize: row.size, netPnl: row.netPnl,
      liquidityAtEntry: row.liquidityAtEntry, liquidityAtExit: row.exitLiquidity,
      maxSafePositionAtEntry: num(entry.maxSafePosition) ?? estimated.size,
      maxSafeBasis: num(entry.maxSafePosition) !== null ? String(entry.basis) : row.liquidityAtEntry ? 'LIQUIDITY_ESTIMATE' : 'INSUFFICIENT_DATA',
      bindingConstraint: entry.bindingConstraint ?? estimated.binding,
      exitCapacityScoreAtEntry: num(entry.exitCapacityScore),
      classificationAtEntry: entry.classification ?? null,
      recommendedSize: num(record(snapshot.sizing).finalRecommendedSize),
      exitCapacityAtTrigger: row.exitCapacityAtTrigger,
    };
  });

  // ---- Capacity vs outcome (capacity = safe size at entry; NOT a direction predictor) ----
  const bucketOf = (size: number | null) => (size === null ? 'UNKNOWN' : size >= 500 ? 'HIGH (≥500 USDC)' : size >= 100 ? 'MEDIUM (100–500 USDC)' : 'LOW (<100 USDC)');
  const buckets = new Map<string, LaunchTradeRow[]>();
  rows.forEach((row, index) => {
    const key = bucketOf(perTrade[index].maxSafePositionAtEntry);
    buckets.set(key, [...(buckets.get(key) ?? []), row]);
  });
  const capacityVsOutcome = [...buckets.entries()].map(([bucket, items]) => ({ bucket, ...stats(items) }));

  // ---- Partial exit analysis (chronological, stored post-trigger observations only) ----
  const partial = { evaluated: 0, insufficientData: 0, full: 0, halves: 0, quarters: 0 };
  for (const row of rows) {
    const path = partialPaths.get(row.id);
    const triggerAt = row.forensics?.exit.triggerAt ? Date.parse(row.forensics.exit.triggerAt) : null;
    if (!path || triggerAt === null || !row.quantity) {
      partial.insufficientData += 1;
      continue;
    }
    const full = simulatePartialExit(path, triggerAt, row.quantity, 1, 0);
    const halves = simulatePartialExit(path, triggerAt, row.quantity, 2, 3_000);
    const quarters = simulatePartialExit(path, triggerAt, row.quantity, 4, 3_000);
    if (!full || !halves || !quarters) {
      partial.insufficientData += 1;
      continue;
    }
    partial.evaluated += 1;
    partial.full += full.proceeds;
    partial.halves += halves.proceeds;
    partial.quarters += quarters.proceeds;
  }

  return {
    config,
    entrySummary,
    deteriorationEvents,
    routeLossEvents,
    scenarios,
    replayAssumptions: 'LIQUIDITY_ESTIMATE modell a tárolt belépési / kilépési likviditáson; az árfolyam-út változatlan (egy nagyobb megbízás piacra gyakorolt hatását nem modellezzük) – nagy méretnél optimista.',
    calibration: { trades: calibration.length, actualNetPnl: calibration.reduce((sum, item) => sum + item.actual, 0), replayNetPnl: calibration.reduce((sum, item) => sum + item.replay, 0) },
    perTrade,
    capacityVsOutcome,
    partialExit: partial,
  };
}
