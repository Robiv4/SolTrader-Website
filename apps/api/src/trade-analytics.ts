/**
 * Closed-trade analytics. Definitions (all on FINAL NET realized P&L, open positions excluded):
 *   win            = netPnl > 0; loss = netPnl < 0 (a trade that is gross-positive but net-negative is a LOSS)
 *   winRate        = wins / closed trades * 100
 *   profitFactor   = sum(net of winners) / |sum(net of losers)|; null when there are no losers (undefined ratio)
 *   expectancy     = total net P&L / closed trades
 *   maxDrawdown    = largest peak-to-trough fall of the realized equity curve (initialBalance + cumulative net),
 *                    in USD and in percent of the peak equity at that time
 *   fees, slippage = informational; both are already inside netPnl (fees deducted once, slippage inside fills)
 */

export interface AnalyticsTrade {
  netPnl: number;
  grossPnl: number;
  fees: number;
  slippage: number;
  size: number;
  entryPrice: number | null;
  exitPrice: number | null;
  entryAt: Date | null;
  exitAt: Date | null;
  strategy: string;
  exitReason: string;
  riskClassification: string;
  signalScore: number | null;
  manual: boolean;
  highestPrice: number | null;
  lowestPrice: number | null;
  trailingActivationPercent: number | null;
  trailingActivationPrice: number | null;
  trailingActivatedAt: Date | null;
  token?: string;
  aiConfirmed?: boolean;
  /** Signal context at entry (null for trades opened before signal analysis was recorded). */
  primaryStrategy?: string | null;
  confirmations?: string[] | null;
  compositeScore?: number | null;
  exhaustionScore?: number | null;
  /** STRATEGY | AI | MANUAL_PAPER */
  decisionSource?: string;
  aiConfidence?: number | null;
  /** NewLaunch entry facts (null for other trades). */
  launchScore?: number | null;
  launchAgeSeconds?: number | null;
  launchLiquidityUsd?: number | null;
  breakEvenApplied?: boolean;
}

export interface GroupStats {
  name: string;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  netPnl: number;
  profitFactor: number | null;
  averageReturnPercent: number;
  averageTradeDurationMs: number;
  fees: number;
  slippage: number;
  expectancy: number;
  averageWin: number;
  averageLoss: number;
  /** Peak-to-trough of the group's cumulative net P&L (USD); null below 5 trades where it is not meaningful. */
  maxDrawdown: number | null;
}

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

export function profitFactor(netPnls: number[]) {
  const gains = sum(netPnls.filter((value) => value > 0));
  const losses = Math.abs(sum(netPnls.filter((value) => value < 0)));
  if (losses === 0) return gains > 0 ? null : 0;
  return gains / losses;
}

function durationMs(trade: AnalyticsTrade) {
  return trade.entryAt && trade.exitAt ? Math.max(0, trade.exitAt.getTime() - trade.entryAt.getTime()) : 0;
}

function returnPercent(trade: AnalyticsTrade) {
  return trade.size > 0 ? trade.netPnl / trade.size * 100 : 0;
}

export function groupStats(name: string, rows: AnalyticsTrade[]): GroupStats {
  const wins = rows.filter((row) => row.netPnl > 0).length;
  const losses = rows.filter((row) => row.netPnl < 0).length;
  return {
    name,
    trades: rows.length,
    wins,
    losses,
    winRate: rows.length ? wins / rows.length * 100 : 0,
    netPnl: sum(rows.map((row) => row.netPnl)),
    profitFactor: profitFactor(rows.map((row) => row.netPnl)),
    averageReturnPercent: rows.length ? sum(rows.map(returnPercent)) / rows.length : 0,
    averageTradeDurationMs: rows.length ? sum(rows.map(durationMs)) / rows.length : 0,
    fees: sum(rows.map((row) => row.fees)),
    slippage: sum(rows.map((row) => row.slippage)),
    expectancy: rows.length ? sum(rows.map((row) => row.netPnl)) / rows.length : 0,
    averageWin: wins ? sum(rows.filter((row) => row.netPnl > 0).map((row) => row.netPnl)) / wins : 0,
    averageLoss: losses ? sum(rows.filter((row) => row.netPnl < 0).map((row) => row.netPnl)) / losses : 0,
    maxDrawdown: rows.length >= 5 ? realizedDrawdown(rows.map((row) => row.netPnl), 0).maxDrawdown : null,
  };
}

export function groupBy(rows: AnalyticsTrade[], key: (row: AnalyticsTrade) => string, order?: string[]) {
  const groups = new Map<string, AnalyticsTrade[]>();
  for (const row of rows) {
    const name = key(row);
    groups.set(name, [...(groups.get(name) ?? []), row]);
  }
  const entries = [...groups.entries()].map(([name, group]) => groupStats(name, group));
  return order ? entries.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name)) : entries.sort((a, b) => b.trades - a.trades);
}

export const SIGNAL_SCORE_BUCKETS = ['0–39', '40–49', '50–59', '60–69', '70–79', '80–89', '90–100', 'n/a'];
export function signalScoreBucket(score: number | null) {
  if (score === null || !Number.isFinite(score)) return 'n/a';
  if (score < 40) return '0–39';
  if (score >= 90) return '90–100';
  const low = Math.floor(score / 10) * 10;
  return `${low}–${low + 9}`;
}

export const HOLDING_BUCKETS = ['< 1 perc', '1–5 perc', '5–15 perc', '15–60 perc', '1–4 óra', '> 4 óra'];
export function holdingBucket(ms: number) {
  const minutes = ms / 60_000;
  if (minutes < 1) return '< 1 perc';
  if (minutes < 5) return '1–5 perc';
  if (minutes < 15) return '5–15 perc';
  if (minutes < 60) return '15–60 perc';
  if (minutes < 240) return '1–4 óra';
  return '> 4 óra';
}

export const SIZE_BUCKETS = ['< 10 USDC', '10–50 USDC', '50–100 USDC', '100–250 USDC', '≥ 250 USDC'];
export function sizeBucket(size: number) {
  if (size < 10) return '< 10 USDC';
  if (size < 50) return '10–50 USDC';
  if (size < 100) return '50–100 USDC';
  if (size < 250) return '100–250 USDC';
  return '≥ 250 USDC';
}

/** Max drawdown of the realized equity curve, in USD and in percent of the running peak. */
export function realizedDrawdown(netPnlsInExitOrder: number[], initialBalance: number) {
  let equity = initialBalance;
  let peak = initialBalance;
  let maxAbs = 0;
  let maxPercent = 0;
  for (const pnl of netPnlsInExitOrder) {
    equity += pnl;
    peak = Math.max(peak, equity);
    const drawdown = peak - equity;
    maxAbs = Math.max(maxAbs, drawdown);
    if (peak > 0) maxPercent = Math.max(maxPercent, drawdown / peak * 100);
  }
  return { maxDrawdown: maxAbs, maxDrawdownPercent: maxPercent };
}

/** Round-trip fee fraction (entry + exit) used for the net break-even price. */
const ROUND_TRIP_FEE_FRACTION = 0.006;

export function trailingDiagnostics(rows: AnalyticsTrade[]) {
  const trailing = rows.filter((row) => row.exitReason === 'TRAILING_STOP');
  const withPeak = trailing.filter((row) => row.entryPrice && row.highestPrice);
  const mfe = withPeak.map((row) => (row.highestPrice! / row.entryPrice! - 1) * 100);
  const withLow = trailing.filter((row) => row.entryPrice && row.lowestPrice);
  const mae = withLow.map((row) => (row.lowestPrice! / row.entryPrice! - 1) * 100);
  const peakToFill = trailing.filter((row) => row.highestPrice && row.exitPrice).map((row) => (1 - row.exitPrice! / row.highestPrice!) * 100);
  // Activation facts are only stored for trades opened with an activation threshold; legacy trades were
  // armed from entry (activation price = entry fill), which is recorded as such rather than invented.
  const activationGains = trailing.map((row) => {
    if (!row.entryPrice) return null;
    const activationPrice = row.trailingActivationPrice ?? (row.trailingActivationPercent ? null : row.entryPrice);
    return activationPrice ? (activationPrice / row.entryPrice - 1) * 100 : null;
  }).filter((value): value is number => value !== null);
  const netBreakEvenGain = ROUND_TRIP_FEE_FRACTION * 100;
  const activatedBelowBreakEven = trailing.filter((row) => {
    if (!row.entryPrice) return false;
    const activationPrice = row.trailingActivationPrice ?? (row.trailingActivationPercent ? null : row.entryPrice);
    return activationPrice !== null && activationPrice < row.entryPrice * (1 + ROUND_TRIP_FEE_FRACTION);
  }).length;
  const peakNeverAboveBreakEven = withPeak.filter((row) => row.highestPrice! < row.entryPrice! * (1 + ROUND_TRIP_FEE_FRACTION)).length;
  const average = (values: number[]) => (values.length ? sum(values) / values.length : null);
  return {
    trailingExits: trailing.length,
    profitable: trailing.filter((row) => row.netPnl > 0).length,
    losing: trailing.filter((row) => row.netPnl < 0).length,
    averageNetPnl: average(trailing.map((row) => row.netPnl)),
    averageMaxFavorableExcursionPercent: average(mfe),
    averageMaxAdverseExcursionPercent: average(mae),
    averageGainAtActivationPercent: average(activationGains),
    averagePeakToFillPercent: average(peakToFill),
    activatedBelowNetBreakEven: activatedBelowBreakEven,
    peakNeverAboveNetBreakEven: peakNeverAboveBreakEven,
    netBreakEvenGainPercent: netBreakEvenGain,
    flagged: trailing.length > 0 && activatedBelowBreakEven > 0,
  };
}

export const AI_CONFIDENCE_BUCKETS = ['< 50', '50–59', '60–69', '70–79', '80–89', '90–100'];
export function aiConfidenceBucket(confidence: number) {
  if (confidence < 50) return '< 50';
  if (confidence >= 90) return '90–100';
  const low = Math.floor(confidence / 10) * 10;
  return `${low}–${low + 9}`;
}

export const DECISION_SOURCES = ['STRATEGY', 'AI', 'NEW_LAUNCH', 'MANUAL_PAPER'];

export interface AiDecisionEvent {
  tokenId: string;
  effectiveDecision: string;
  createdAt: Date;
}

/**
 * AI decision funnel per user: decision counts and what happened after a WATCH on the same token
 * (the next different decision): WATCH -> BUY, WATCH -> SKIP, and the average time to BUY.
 */
export function aiDecisionFunnel(events: AiDecisionEvent[]) {
  const counts = { BUY: 0, WATCH: 0, SKIP: 0, NONE: 0 } as Record<string, number>;
  for (const event of events) counts[event.effectiveDecision] = (counts[event.effectiveDecision] ?? 0) + 1;
  const byToken = new Map<string, AiDecisionEvent[]>();
  for (const event of [...events].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) byToken.set(event.tokenId, [...(byToken.get(event.tokenId) ?? []), event]);
  let watchToBuy = 0;
  let watchToSkip = 0;
  const delays: number[] = [];
  for (const sequence of byToken.values()) {
    let watchStart: Date | null = null;
    for (const event of sequence) {
      if (event.effectiveDecision === 'WATCH') {
        watchStart ??= event.createdAt;
      } else if (watchStart && (event.effectiveDecision === 'BUY' || event.effectiveDecision === 'SKIP')) {
        if (event.effectiveDecision === 'BUY') {
          watchToBuy += 1;
          delays.push(event.createdAt.getTime() - watchStart.getTime());
        } else {
          watchToSkip += 1;
        }
        watchStart = null;
      }
    }
  }
  return {
    buy: counts.BUY ?? 0,
    watch: counts.WATCH ?? 0,
    skip: counts.SKIP ?? 0,
    failed: counts.NONE ?? 0,
    watchToBuy,
    watchToSkip,
    averageWatchToBuyMs: delays.length ? sum(delays) / delays.length : null,
  };
}

export const LAUNCH_SCORE_BUCKETS = ['< 60', '60–69', '70–79', '80–89', '90–100'];
export const LAUNCH_AGE_BUCKETS = ['0–10 mp', '11–30 mp', '31–60 mp', '61–90 mp', '> 90 mp'];
export const LAUNCH_LIQUIDITY_BUCKETS = ['< $10k', '$10k–25k', '$25k–50k', '$50k–100k', '≥ $100k'];
export const LAUNCH_EXIT_GROUPS = ['STOP_LOSS', 'TAKE_PROFIT', 'TRAILING_STOP', 'BREAK_EVEN', 'LIQUIDITY_SAFETY', 'MANUAL', 'OTHER'];

function launchExitGroup(row: AnalyticsTrade) {
  if (row.exitReason === 'STOP_LOSS') return row.breakEvenApplied ? 'BREAK_EVEN' : 'STOP_LOSS';
  if (row.exitReason === 'TAKE_PROFIT' || row.exitReason === 'TRAILING_STOP') return row.exitReason;
  if (row.exitReason === 'LIQUIDITY_OUTFLOW') return 'LIQUIDITY_SAFETY';
  if (row.exitReason === 'manual-close') return 'MANUAL';
  return 'OTHER';
}

/** NewLaunch-only analytics (kept separate from Strategy / AI / Manual). Scores are not probabilities of profit. */
export function newLaunchAnalytics(rowsInExitOrder: AnalyticsTrade[]) {
  const rows = rowsInExitOrder.filter((row) => row.decisionSource === 'NEW_LAUNCH');
  const average = (values: Array<number | null | undefined>) => {
    const known = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
    return known.length ? sum(known) / known.length : null;
  };
  const scoreBucket = (score: number) => (score < 60 ? '< 60' : score >= 90 ? '90–100' : `${Math.floor(score / 10) * 10}–${Math.floor(score / 10) * 10 + 9}`);
  const ageBucket = (age: number) => (age <= 10 ? '0–10 mp' : age <= 30 ? '11–30 mp' : age <= 60 ? '31–60 mp' : age <= 90 ? '61–90 mp' : '> 90 mp');
  const liquidityBucket = (liquidity: number) => (liquidity < 10_000 ? '< $10k' : liquidity < 25_000 ? '$10k–25k' : liquidity < 50_000 ? '$25k–50k' : liquidity < 100_000 ? '$50k–100k' : '≥ $100k');
  return {
    summary: { ...groupStats('NEW_LAUNCH', rows), maxDrawdown: rows.length ? realizedDrawdown(rows.map((row) => row.netPnl), 0).maxDrawdown : 0, averageEntryAgeSeconds: average(rows.map((row) => row.launchAgeSeconds)), averageLaunchScore: average(rows.map((row) => row.launchScore)), averageEntryLiquidityUsd: average(rows.map((row) => row.launchLiquidityUsd)) },
    byLaunchScore: groupBy(rows.filter((row) => typeof row.launchScore === 'number'), (row) => scoreBucket(row.launchScore!), LAUNCH_SCORE_BUCKETS),
    byEntryAge: groupBy(rows.filter((row) => typeof row.launchAgeSeconds === 'number'), (row) => ageBucket(row.launchAgeSeconds!), LAUNCH_AGE_BUCKETS),
    byEntryLiquidity: groupBy(rows.filter((row) => typeof row.launchLiquidityUsd === 'number'), (row) => liquidityBucket(row.launchLiquidityUsd!), LAUNCH_LIQUIDITY_BUCKETS),
    byExitReason: groupBy(rows, launchExitGroup, LAUNCH_EXIT_GROUPS),
  };
}

export const EXHAUSTION_BUCKETS = ['0–19', '20–39', '40–59', '60–79', '80–100'];
export function exhaustionBucket(score: number) {
  if (score < 20) return '0–19';
  if (score < 40) return '20–39';
  if (score < 60) return '40–59';
  if (score < 80) return '60–79';
  return '80–100';
}

/** Trades containing each confirmation (a trade can appear in several rows). */
export function confirmationPerformance(rows: AnalyticsTrade[]) {
  const withContext = rows.filter((row) => Array.isArray(row.confirmations));
  const modules = [...new Set(withContext.flatMap((row) => row.confirmations!))].sort();
  return modules.map((module) => groupStats(module, withContext.filter((row) => row.confirmations!.includes(module)))).sort((a, b) => b.trades - a.trades);
}

/** Exact confirmation sets and every confirmed pair, most frequent first. */
export function combinationPerformance(rows: AnalyticsTrade[], limit = 15) {
  const withContext = rows.filter((row) => Array.isArray(row.confirmations) && row.confirmations.length > 0);
  const exact = groupBy(withContext, (row) => [...row.confirmations!].sort().join(' + ')).slice(0, limit);
  const pairs = new Map<string, AnalyticsTrade[]>();
  for (const row of withContext) {
    const modules = [...new Set(row.confirmations!)].sort();
    for (let i = 0; i < modules.length; i += 1) {
      for (let j = i + 1; j < modules.length; j += 1) {
        const key = `${modules[i]} + ${modules[j]}`;
        pairs.set(key, [...(pairs.get(key) ?? []), row]);
      }
    }
  }
  const pairStats = [...pairs.entries()].map(([name, group]) => groupStats(name, group)).sort((a, b) => b.trades - a.trades).slice(0, limit);
  return { exact, pairs: pairStats };
}

export function computeTradeAnalytics(rowsInExitOrder: AnalyticsTrade[], initialBalance: number) {
  const nets = rowsInExitOrder.map((row) => row.netPnl);
  const wins = nets.filter((value) => value > 0);
  const losses = nets.filter((value) => value < 0);
  const totalNetPnl = sum(nets);
  const auto = rowsInExitOrder.filter((row) => !row.manual);
  return {
    totalTrades: rowsInExitOrder.length,
    wins: wins.length,
    losses: losses.length,
    winRate: nets.length ? wins.length / nets.length * 100 : 0,
    lossRate: nets.length ? losses.length / nets.length * 100 : 0,
    averageWin: wins.length ? sum(wins) / wins.length : 0,
    averageLoss: losses.length ? sum(losses) / losses.length : 0,
    profitFactor: profitFactor(nets),
    expectancy: nets.length ? totalNetPnl / nets.length : 0,
    realizedPnl: totalNetPnl,
    grossPnl: sum(rowsInExitOrder.map((row) => row.grossPnl)),
    totalFees: sum(rowsInExitOrder.map((row) => row.fees)),
    totalSlippage: sum(rowsInExitOrder.map((row) => row.slippage)),
    averageTradeDurationMs: rowsInExitOrder.length ? sum(rowsInExitOrder.map(durationMs)) / rowsInExitOrder.length : 0,
    ...realizedDrawdown(nets, initialBalance),
    executionSourcePerformance: groupBy(rowsInExitOrder, (row) => (row.manual ? 'MANUAL_PAPER' : 'AUTOMATIC'), ['AUTOMATIC', 'MANUAL_PAPER']),
    strategyPerformance: groupBy(rowsInExitOrder, (row) => row.strategy),
    automaticStrategyPerformance: groupBy(auto, (row) => row.strategy),
    exitReasonDistribution: groupBy(rowsInExitOrder, (row) => row.exitReason),
    riskClassificationPerformance: groupBy(rowsInExitOrder, (row) => row.riskClassification),
    signalScorePerformance: groupBy(auto, (row) => signalScoreBucket(row.signalScore), SIGNAL_SCORE_BUCKETS),
    holdingDurationPerformance: groupBy(rowsInExitOrder, (row) => holdingBucket(durationMs(row)), HOLDING_BUCKETS),
    positionSizePerformance: groupBy(rowsInExitOrder, (row) => sizeBucket(row.size), SIZE_BUCKETS),
    trailingDiagnostics: trailingDiagnostics(rowsInExitOrder),
    primaryStrategyPerformance: groupBy(rowsInExitOrder, (row) => row.primaryStrategy ?? row.strategy),
    signalContextTrades: rowsInExitOrder.filter((row) => Array.isArray(row.confirmations)).length,
    confirmationPerformance: confirmationPerformance(rowsInExitOrder),
    combinationPerformance: combinationPerformance(rowsInExitOrder),
    compositeScorePerformance: groupBy(rowsInExitOrder.filter((row) => typeof row.compositeScore === 'number'), (row) => signalScoreBucket(row.compositeScore!), SIGNAL_SCORE_BUCKETS),
    newLaunch: newLaunchAnalytics(rowsInExitOrder),
    decisionSourcePerformance: groupBy(rowsInExitOrder, (row) => row.decisionSource ?? (row.manual ? 'MANUAL_PAPER' : 'STRATEGY'), DECISION_SOURCES),
    aiConfidencePerformance: groupBy(rowsInExitOrder.filter((row) => row.decisionSource === 'AI' && typeof row.aiConfidence === 'number'), (row) => aiConfidenceBucket(row.aiConfidence!), AI_CONFIDENCE_BUCKETS),
    exhaustionScorePerformance: groupBy(rowsInExitOrder.filter((row) => typeof row.exhaustionScore === 'number'), (row) => exhaustionBucket(row.exhaustionScore!), EXHAUSTION_BUCKETS),
  };
}
