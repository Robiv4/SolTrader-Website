/**
 * NewLaunch optimizer: historical simulation of stricter entry filters and alternative exit parameters.
 *
 * HISTORICAL SIMULATION — NOT FUTURE PERFORMANCE. Rules:
 *  - Recommendations never apply themselves; they are persisted and need an explicit user action.
 *  - Candidates are tuned on the chronologically first part of the trades and validated, unchanged, on the
 *    later part (no random shuffling of time-series data), plus a rolling walk-forward stability check.
 *  - The objective is never win rate alone: expectancy, profit factor, net P&L, drawdown, winner retention
 *    and loser rejection are all evaluated.
 *  - Exit simulations replay only stored, timestamped prices through the same Exit Engine used live; when
 *    the snapshot resolution cannot tell which level was touched first, the result is AMBIGUOUS_EVENT_ORDER
 *    and it is excluded (never assumed profitable).
 */
import { evaluateLongExit, type LongExitState } from './exit-rules.js';
import { performanceStats, type PerformanceRow, type PerformanceStats } from './launch-analysis.js';

// ---------------------------------------------------------------------------------------------
// Entry filters
// ---------------------------------------------------------------------------------------------

export interface OptimizerTrade extends PerformanceRow {
  id: string;
  /** Entry features exactly as recorded at entry (null = was not available at entry). */
  features: Record<string, number | null>;
  /** Diagnostic class (POOR_ENTRY, GOOD_ENTRY_BAD_EXIT, ...); used to report poor-entry rejection. */
  diagnosis?: string;
}

export interface EntryFilterCondition { feature: string; kind: 'min' | 'max'; value: number }

/** A trade passes only when every constrained feature is known at entry and inside the limit. */
export function passesFilter(trade: OptimizerTrade, conditions: ReadonlyArray<EntryFilterCondition>) {
  return conditions.every((condition) => {
    const value = trade.features[condition.feature];
    if (typeof value !== 'number' || !Number.isFinite(value)) return false;
    return condition.kind === 'min' ? value >= condition.value : value <= condition.value;
  });
}

export interface FilterSimulation {
  label: 'HISTORICAL SIMULATION — NOT FUTURE PERFORMANCE';
  historicalTrades: number;
  remaining: number;
  winnersRetained: number;
  winners: number;
  losersRemoved: number;
  losers: number;
  before: PerformanceStats;
  after: PerformanceStats;
}

export function simulateEntryFilter(trades: ReadonlyArray<OptimizerTrade>, conditions: ReadonlyArray<EntryFilterCondition>): FilterSimulation {
  const kept = trades.filter((trade) => passesFilter(trade, conditions));
  const winners = trades.filter((trade) => trade.netPnl > 0);
  const losers = trades.filter((trade) => trade.netPnl <= 0);
  return {
    label: 'HISTORICAL SIMULATION — NOT FUTURE PERFORMANCE',
    historicalTrades: trades.length,
    remaining: kept.length,
    winnersRetained: kept.filter((trade) => trade.netPnl > 0).length,
    winners: winners.length,
    losersRemoved: losers.length - kept.filter((trade) => trade.netPnl <= 0).length,
    losers: losers.length,
    before: performanceStats(trades),
    after: performanceStats(kept),
  };
}

/**
 * Candidate thresholds per entry feature. `parameter` is the NewLaunch setting (or `qualityGate.<field>`) a
 * recommendation would change; `analysisOnly` features have no setting and are reported, never applied.
 */
export const ENTRY_PARAMETER_GRID: Array<{ parameter: string; feature: string; kind: 'min' | 'max'; grid: number[]; analysisOnly?: boolean }> = [
  { parameter: 'minScore', feature: 'launchScore', kind: 'min', grid: [60, 65, 70, 75, 80, 85, 90] },
  { parameter: 'maxAgeSeconds', feature: 'tokenAgeSeconds', kind: 'max', grid: [10, 20, 30, 45, 60, 90] },
  { parameter: 'minLiquidityUsd', feature: 'liquidityUsd', kind: 'min', grid: [3_000, 5_000, 10_000, 20_000, 50_000] },
  { parameter: 'minUniqueBuyers', feature: 'uniqueBuyers', kind: 'min', grid: [5, 10, 15, 20, 30, 50] },
  { parameter: 'minBuySellRatio', feature: 'buySellRatio', kind: 'min', grid: [1, 1.5, 2, 3] },
  { parameter: 'buyVolumeRatio', feature: 'buyVolumeRatio', kind: 'min', grid: [1, 1.5, 2, 3], analysisOnly: true },
  { parameter: 'maxExhaustionScore', feature: 'exhaustionScore', kind: 'max', grid: [20, 30, 40, 50, 60, 70] },
  { parameter: 'maxPriceImpactPercent', feature: 'priceImpactPercent', kind: 'max', grid: [0.5, 1, 1.5, 2, 3] },
  { parameter: 'qualityGate.minDataQuality', feature: 'dataQuality', kind: 'min', grid: [60, 70, 80, 90] },
  { parameter: 'maxRiskScore', feature: 'riskScore', kind: 'max', grid: [30, 40, 50, 60, 70, 80] },
  { parameter: 'qualityGate.maxHolderConcentrationPercent', feature: 'holderConcentrationPercent', kind: 'max', grid: [5, 10, 15, 20] },
  { parameter: 'qualityGate.maxDevAllocationPercent', feature: 'devAllocationPercent', kind: 'max', grid: [2, 5, 10] },
  // Execution-quality features (exit capacity at entry): analysis only, they never bypass the capacity safety layer.
  { parameter: 'exitCapacityScoreAtEntry', feature: 'exitCapacityScoreAtEntry', kind: 'min', grid: [40, 50, 60, 70, 80], analysisOnly: true },
  { parameter: 'estimatedExitImpactPct', feature: 'estimatedExitImpactPct', kind: 'max', grid: [1, 2, 3, 5], analysisOnly: true },
];

export type ConfidenceLevel = 'LOW' | 'MEDIUM' | 'HIGH';

export interface EntryRecommendation {
  parameter: string;
  feature: string;
  kind: 'min' | 'max';
  currentValue: number | null;
  suggestedValue: number;
  sampleSize: number;
  trainingMetrics: { base: PerformanceStats; filtered: PerformanceStats };
  validationMetrics: { base: PerformanceStats; filtered: PerformanceStats };
  tradeRetention: number;
  winnerRetention: number | null;
  loserRejection: number | null;
  /** Share of POOR_ENTRY trades the filter would have removed (null when none were classified). */
  poorEntryRejection: number | null;
  analysisOnly: boolean;
  walkForwardStability: number | null;
  confidenceLevel: ConfidenceLevel;
  possibleOverfit: boolean;
  reason: string;
  warnings: string[];
}

export interface OptimizerOptions {
  minimumSampleSize: number;
  trainFraction: number;
  /** Minimum share of training trades a candidate filter must keep (avoids "trade nothing" solutions). */
  minimumRetention: number;
  minimumKeptTrades: number;
  walkForwardFolds: number;
}

export const DEFAULT_OPTIMIZER_OPTIONS: OptimizerOptions = { minimumSampleSize: 50, trainFraction: 0.7, minimumRetention: 0.25, minimumKeptTrades: 10, walkForwardFolds: 3 };

/** Chronological split: the first part tunes, the later part validates. Never shuffled. */
export function chronologicalSplit<T extends { closedAt: number }>(trades: ReadonlyArray<T>, trainFraction: number) {
  const ordered = [...trades].sort((a, b) => a.closedAt - b.closedAt);
  const cut = Math.floor(ordered.length * trainFraction);
  return { train: ordered.slice(0, cut), validation: ordered.slice(cut) };
}

/**
 * Multi-metric candidate score: expectancy improvement must come with a non-worse profit factor; the
 * improvement in total net P&L per original trade is weighted by retention so tiny, lucky subsets lose.
 */
function candidateScore(base: PerformanceStats, filtered: PerformanceStats, retention: number) {
  if (filtered.expectancy === null || base.expectancy === null) return Number.NEGATIVE_INFINITY;
  const expectancyGain = filtered.expectancy - base.expectancy;
  const pfOk = base.profitFactor === null || filtered.profitFactor === null || filtered.profitFactor >= base.profitFactor;
  const drawdownOk = filtered.maxDrawdown <= base.maxDrawdown * 1.05 + 1e-9;
  if (expectancyGain <= 0 || !pfOk || !drawdownOk) return Number.NEGATIVE_INFINITY;
  return expectancyGain * Math.sqrt(retention);
}

function evaluateCandidate(trades: ReadonlyArray<OptimizerTrade>, condition: EntryFilterCondition) {
  const kept = trades.filter((trade) => passesFilter(trade, [condition]));
  return { kept, base: performanceStats(trades), filtered: performanceStats(kept), retention: trades.length ? kept.length / trades.length : 0 };
}

export function optimizeEntryFilters(trades: ReadonlyArray<OptimizerTrade>, currentValues: Record<string, number | null>, options: OptimizerOptions = DEFAULT_OPTIMIZER_OPTIONS) {
  if (trades.length < options.minimumSampleSize) {
    return { sufficientData: false as const, sampleSize: trades.length, minimumSampleSize: options.minimumSampleSize, recommendations: [] as EntryRecommendation[] };
  }
  const { train, validation } = chronologicalSplit(trades, options.trainFraction);
  const recommendations: EntryRecommendation[] = [];
  for (const parameter of ENTRY_PARAMETER_GRID) {
    let best: { value: number; score: number; result: ReturnType<typeof evaluateCandidate> } | null = null;
    for (const value of parameter.grid) {
      const result = evaluateCandidate(train, { feature: parameter.feature, kind: parameter.kind, value });
      if (result.retention < options.minimumRetention || result.kept.length < options.minimumKeptTrades) continue;
      const score = candidateScore(result.base, result.filtered, result.retention);
      if (score > (best?.score ?? 0)) best = { value, score, result };
    }
    const current = currentValues[parameter.parameter] ?? null;
    if (!best || best.value === current) continue;
    const condition = { feature: parameter.feature, kind: parameter.kind, value: best.value };
    const validationResult = evaluateCandidate(validation, condition);
    const trainGain = (best.result.filtered.expectancy ?? 0) - (best.result.base.expectancy ?? 0);
    const validationGain = validationResult.kept.length ? (validationResult.filtered.expectancy ?? 0) - (validationResult.base.expectancy ?? 0) : Number.NEGATIVE_INFINITY;
    // Rolling walk-forward: tune on everything before a window, test the SAME value on the window.
    const ordered = [...trades].sort((a, b) => a.closedAt - b.closedAt);
    const foldSize = Math.floor(ordered.length / (options.walkForwardFolds + 1));
    let improvedFolds = 0;
    let testedFolds = 0;
    for (let fold = 1; fold <= options.walkForwardFolds && foldSize > 0; fold += 1) {
      const window = ordered.slice(fold * foldSize, (fold + 1) * foldSize);
      const result = evaluateCandidate(window, condition);
      if (!result.kept.length) continue;
      testedFolds += 1;
      if ((result.filtered.expectancy ?? 0) > (result.base.expectancy ?? 0)) improvedFolds += 1;
    }
    const stability = testedFolds ? improvedFolds / testedFolds : null;
    const possibleOverfit = trainGain > 0 && (validationGain <= 0 || validationGain < trainGain * 0.3);
    const all = evaluateCandidate(trades, condition);
    const winners = trades.filter((trade) => trade.netPnl > 0);
    const losers = trades.filter((trade) => trade.netPnl <= 0);
    const effect = Math.abs(best.result.base.averageLoser ?? 1) > 0 ? trainGain / Math.abs(best.result.base.averageLoser ?? 1) : 0;
    let confidenceLevel: ConfidenceLevel = 'LOW';
    if (!possibleOverfit && validationGain > 0 && (stability ?? 0) >= 0.5) confidenceLevel = 'MEDIUM';
    if (confidenceLevel === 'MEDIUM' && trades.length >= 150 && (stability ?? 0) >= 0.67 && effect >= 0.2) confidenceLevel = 'HIGH';
    const warnings: string[] = [];
    if (possibleOverfit) warnings.push('LEHETSÉGES TÚLILLESZTÉS: a tanuló szakaszon javított, a validációs szakaszon nem (vagy csak kis mértékben).');
    if (validationResult.kept.length < 10) warnings.push(`A validációs szakaszon csak ${validationResult.kept.length} trade maradt – kis minta.`);
    if (all.retention < 0.4) warnings.push(`A szűrő a trade-ek ${Math.round(all.retention * 100)}%-át tartaná meg – sokkal kevesebb belépés.`);
    recommendations.push({
      parameter: parameter.parameter,
      feature: parameter.feature,
      kind: parameter.kind,
      currentValue: current,
      suggestedValue: best.value,
      sampleSize: trades.length,
      trainingMetrics: { base: best.result.base, filtered: best.result.filtered },
      validationMetrics: { base: validationResult.base, filtered: validationResult.filtered },
      tradeRetention: all.retention,
      winnerRetention: winners.length ? all.kept.filter((trade) => trade.netPnl > 0).length / winners.length : null,
      loserRejection: losers.length ? 1 - all.kept.filter((trade) => trade.netPnl <= 0).length / losers.length : null,
      poorEntryRejection: (() => {
        const poor = trades.filter((trade) => trade.diagnosis === 'POOR_ENTRY');
        return poor.length ? 1 - all.kept.filter((trade) => trade.diagnosis === 'POOR_ENTRY').length / poor.length : null;
      })(),
      analysisOnly: Boolean(parameter.analysisOnly),
      walkForwardStability: stability,
      confidenceLevel,
      possibleOverfit,
      reason: `${parameter.kind === 'min' ? 'Az alacsonyabb' : 'A magasabb'} ${parameter.feature} értékű trade-ek várható értéke a tanuló szakaszon rosszabb volt (${(best.result.base.expectancy ?? 0).toFixed(3)} → ${(best.result.filtered.expectancy ?? 0).toFixed(3)} USDC/trade).`,
      warnings,
    });
  }
  return { sufficientData: true as const, sampleSize: trades.length, minimumSampleSize: options.minimumSampleSize, trainSize: train.length, validationSize: validation.length, recommendations };
}

// ---------------------------------------------------------------------------------------------
// Exit parameter simulation
// ---------------------------------------------------------------------------------------------

export interface ExitSimulationConfig {
  stopLossPercent: number | null;
  takeProfitPercent: number | null;
  breakEvenActivationPercent: number | null;
  trailingActivationPercent: number | null;
  trailingDistancePercent: number | null;
}

export interface ExitSimulationTrade {
  id: string;
  /** Actual realised net P&L and diagnostic class, to show which trades a policy would help or hurt. */
  actualNetPnl?: number;
  diagnosis?: string;
  entryAt: number;
  entryPrice: number;
  quantity: number;
  /** Stored observed prices after entry (market prices, chronological). */
  path: ReadonlyArray<{ t: number; price: number }>;
  feeBps: number;
  /** Estimated exit slippage (percent) applied to the simulated exit price. */
  exitSlippagePercent: number;
}

export type SimulationStatus = 'RESOLVED' | 'AMBIGUOUS_EVENT_ORDER' | 'LOW_RESOLUTION' | 'NO_EXIT_IN_DATA';

export interface ExitSimulationResult {
  status: SimulationStatus;
  exitReason: string | null;
  exitAt: number | null;
  netPnl: number | null;
  returnPercent: number | null;
}

/**
 * Replays the stored path through evaluateLongExit (the live Exit Engine). Policy for the unobserved
 * interval before the triggering observation:
 *  - AMBIGUOUS_EVENT_ORDER: an exit fires, but at the previous observation the price was CLOSER to the
 *    opposite exit level (e.g. 1% below the take profit, then a jump through the stop). The opposite level
 *    may have been touched first, so the outcome is unknown.
 *  - LOW_RESOLUTION: an exit fires after a gap longer than maxGapMs between observations.
 * Both are excluded from the metrics (never assumed profitable).
 */
export function simulateExit(trade: ExitSimulationTrade, config: ExitSimulationConfig, maxGapMs = 60_000): ExitSimulationResult {
  const entry = trade.entryPrice;
  let state: LongExitState = {
    entryPrice: entry,
    stopLossPrice: config.stopLossPercent ? entry * (1 - config.stopLossPercent / 100) : null,
    takeProfitPrice: config.takeProfitPercent ? entry * (1 + config.takeProfitPercent / 100) : null,
    trailingDistance: config.trailingDistancePercent ? config.trailingDistancePercent / 100 : null,
    trailingActivation: config.trailingActivationPercent ? config.trailingActivationPercent / 100 : null,
    breakEvenActivation: config.breakEvenActivationPercent ? config.breakEvenActivationPercent / 100 : null,
    roundTripCostFraction: 2 * trade.feeBps / 10_000,
    highestPrice: entry,
    lowestPrice: entry,
    trailingActive: false,
    trailingActivatedAt: null,
    trailingActivationPrice: null,
    trailingTriggerPrice: null,
    breakEvenAppliedAt: null,
  };
  // Trailing configured with activation 0 = armed from entry (explicit configuration only).
  if (config.trailingDistancePercent && config.trailingActivationPercent === 0) state.trailingActivation = null;
  let previous: { t: number; price: number } = { t: trade.entryAt, price: entry };
  const path = [...trade.path].filter((point) => point.t > trade.entryAt && point.price > 0).sort((a, b) => a.t - b.t);
  for (const point of path) {
    const stopSide = Math.max(state.stopLossPrice ?? 0, state.trailingActive ? state.trailingTriggerPrice ?? 0 : 0);
    const upSide = state.takeProfitPrice;
    const evaluation = evaluateLongExit(state, point.price, new Date(point.t));
    if (evaluation.exitReason) {
      const distance = (level: number) => Math.abs(level - previous.price) / previous.price;
      const upwardExit = evaluation.exitReason === 'TAKE_PROFIT';
      const ownDistance = upwardExit ? (upSide !== null ? distance(upSide) : Infinity) : (stopSide > 0 ? distance(stopSide) : Infinity);
      const oppositeDistance = upwardExit ? (stopSide > 0 ? distance(stopSide) : Infinity) : (upSide !== null ? distance(upSide) : Infinity);
      if (point.t - previous.t > maxGapMs) return { status: 'LOW_RESOLUTION', exitReason: evaluation.exitReason, exitAt: point.t, netPnl: null, returnPercent: null };
      if (oppositeDistance < ownDistance) return { status: 'AMBIGUOUS_EVENT_ORDER', exitReason: null, exitAt: point.t, netPnl: null, returnPercent: null };
      const exitPrice = point.price * (1 - trade.exitSlippagePercent / 100);
      const notional = trade.quantity * entry;
      const proceeds = trade.quantity * exitPrice;
      const netPnl = proceeds - notional - (notional + proceeds) * trade.feeBps / 10_000;
      return { status: 'RESOLVED', exitReason: evaluation.exitReason, exitAt: point.t, netPnl, returnPercent: netPnl / notional * 100 };
    }
    state = evaluation.state;
    previous = point;
  }
  return { status: 'NO_EXIT_IN_DATA', exitReason: null, exitAt: null, netPnl: null, returnPercent: null };
}

export interface ExitGridCell {
  x: number;
  y: number;
  resolved: number;
  /** GOOD_ENTRY_BAD_EXIT trades that would have ended better than they actually did. */
  improvedBadExits: number;
  badExitsEvaluated: number;
  /** Actually profitable trades that would have ended worse (e.g. stopped out early). */
  worsenedWinners: number;
  winnersEvaluated: number;
  ambiguous: number;
  lowResolution: number;
  noExitInData: number;
  stats: PerformanceStats | null;
}

/** Metrics for every (x, y) combination; no cell is labelled "best" — the trade-offs are shown as-is. */
export function exitParameterGrid(trades: ReadonlyArray<ExitSimulationTrade>, xs: number[], ys: number[], build: (x: number, y: number) => ExitSimulationConfig): ExitGridCell[] {
  const cells: ExitGridCell[] = [];
  for (const x of xs) {
    for (const y of ys) {
      const results = trades.map((trade) => ({ trade, result: simulateExit(trade, build(x, y)) }));
      const resolved = results.filter((item) => item.result.status === 'RESOLVED');
      const badExits = resolved.filter((item) => item.trade.diagnosis === 'GOOD_ENTRY_BAD_EXIT' && item.trade.actualNetPnl !== undefined);
      const winners = resolved.filter((item) => (item.trade.actualNetPnl ?? 0) > 0);
      cells.push({
        x, y,
        resolved: resolved.length,
        improvedBadExits: badExits.filter((item) => (item.result.netPnl ?? 0) > item.trade.actualNetPnl!).length,
        badExitsEvaluated: badExits.length,
        worsenedWinners: winners.filter((item) => (item.result.netPnl ?? 0) < item.trade.actualNetPnl!).length,
        winnersEvaluated: winners.length,
        ambiguous: results.filter((item) => item.result.status === 'AMBIGUOUS_EVENT_ORDER').length,
        lowResolution: results.filter((item) => item.result.status === 'LOW_RESOLUTION').length,
        noExitInData: results.filter((item) => item.result.status === 'NO_EXIT_IN_DATA').length,
        stats: resolved.length ? performanceStats(resolved.map((item) => ({ netPnl: item.result.netPnl ?? 0, closedAt: item.result.exitAt ?? item.trade.entryAt }))) : null,
      });
    }
  }
  return cells;
}
