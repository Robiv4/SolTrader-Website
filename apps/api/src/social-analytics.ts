/**
 * NewLaunch Social analytics. Uses ONLY the social snapshot stored at each decision / entry (no lookahead: later
 * viral activity can never score an earlier entry). Missing social data is its own group (UNKNOWN), never "low".
 * Nothing here recommends a threshold below the optimizer's minimum sample; results are diagnostics, not predictions.
 */
import type { LaunchTradeRow } from './new-launch-analytics.js';

type Json = Record<string, unknown>;
const record = (value: unknown): Json => (value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {});
const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const average = (values: Array<number | null | undefined>) => {
  const known = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  return known.length ? known.reduce((sum, value) => sum + value, 0) / known.length : null;
};
const median = (values: Array<number | null | undefined>) => {
  const known = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value)).sort((a, b) => a - b);
  return known.length ? known[Math.floor((known.length - 1) / 2)] : null;
};

export const SOCIAL_THRESHOLDS = { highSocialScore: 60, highOnchainMomentum: 60, spamLow: 30, spamHigh: 60, exhaustionLow: 30, exhaustionHigh: 60 };

function stats(rows: LaunchTradeRow[]) {
  const winners = rows.filter((row) => row.netPnl > 0);
  const losers = rows.filter((row) => row.netPnl <= 0);
  const grossWin = winners.reduce((sum, row) => sum + row.netPnl, 0);
  const grossLoss = -losers.reduce((sum, row) => sum + row.netPnl, 0);
  let peak = 0;
  let equity = 0;
  let drawdown = 0;
  for (const row of [...rows].sort((a, b) => a.closedAt - b.closedAt)) {
    equity += row.netPnl;
    peak = Math.max(peak, equity);
    drawdown = Math.max(drawdown, peak - equity);
  }
  return {
    trades: rows.length,
    winRate: rows.length ? winners.length / rows.length * 100 : null,
    netPnl: rows.reduce((sum, row) => sum + row.netPnl, 0),
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
    expectancy: rows.length ? rows.reduce((sum, row) => sum + row.netPnl, 0) / rows.length : null,
    averageWinner: winners.length ? grossWin / winners.length : null,
    averageLoser: losers.length ? -grossLoss / losers.length : null,
    averageMfePercent: average(rows.map((row) => row.mfePercent)),
    averageMaePercent: average(rows.map((row) => row.maePercent)),
    maxDrawdown: rows.length >= 5 ? drawdown : null,
  };
}

const social = (row: LaunchTradeRow) => record(row.socialAtEntry);
const available = (row: LaunchTradeRow) => social(row).available === true;

function group(rows: LaunchTradeRow[], keyOf: (row: LaunchTradeRow) => string, order: string[]) {
  const groups = new Map<string, LaunchTradeRow[]>(order.map((key) => [key, []]));
  for (const row of rows) {
    const key = keyOf(row);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.entries()].map(([key, items]) => ({ key, ...stats(items) }));
}

/** A hypothetical filter: social-unknown trades always pass (missing data is not negative evidence). */
function evaluateFilter(rows: LaunchTradeRow[], keep: (row: LaunchTradeRow) => boolean) {
  const kept = rows.filter((row) => !available(row) || keep(row));
  const removed = rows.filter((row) => available(row) && !keep(row));
  const before = stats(rows);
  const after = stats(kept);
  const winners = rows.filter((row) => row.netPnl > 0).length;
  return {
    tradesRemoved: removed.length,
    losersRemoved: removed.filter((row) => row.netPnl <= 0).length,
    poorEntriesRemoved: removed.filter((row) => row.diagnosis === 'POOR_ENTRY').length,
    winnersRemoved: removed.filter((row) => row.netPnl > 0).length,
    winnerRetentionPct: winners ? (winners - removed.filter((row) => row.netPnl > 0).length) / winners * 100 : null,
    tradeRetentionPct: rows.length ? kept.length / rows.length * 100 : null,
    netPnlChange: after.netPnl - before.netPnl,
    profitFactorBefore: before.profitFactor, profitFactorAfter: after.profitFactor,
    expectancyBefore: before.expectancy, expectancyAfter: after.expectancy,
    maxDrawdownBefore: before.maxDrawdown, maxDrawdownAfter: after.maxDrawdown,
  };
}

export const SOCIAL_FILTERS: Array<{ id: string; label: string; keep: (row: LaunchTradeRow) => boolean }> = [
  { id: 'SCORE_GE_40', label: 'Social Score ≥ 40', keep: (row) => (num(social(row).socialScore) ?? 100) >= 40 },
  { id: 'SPAM_LT_60', label: 'Spam Score < 60', keep: (row) => (num(social(row).spam) ?? 0) < 60 },
  { id: 'NOT_AVOID', label: 'Árnyékdöntés nem AVOID', keep: (row) => social(row).shadowDecision !== 'AVOID' },
  { id: 'NO_SOCIAL_ONLY_HYPE', label: 'Nem SOCIAL_ONLY_HYPE', keep: (row) => social(row).confirmation !== 'SOCIAL_ONLY_HYPE' },
  { id: 'EXHAUSTION_LT_60', label: 'Social Exhaustion < 60', keep: (row) => (num(social(row).exhaustion) ?? 0) < 60 },
];

export function buildSocialAnalytics(rows: LaunchTradeRow[], decisions: Array<{ mint: string; decision: string; socialSummary: unknown }>, leadLag: { pairs: number; socialFirst: number; priceFirst: number; medianLagMs: number | null; resolutionMs: number } | null) {
  const withSocial = rows.filter(available);
  // ---- Overview (all decisions in the window, rejected candidates included) ----
  const summaries: Array<Json & { mint: string; decision: string }> = decisions.map((decision) => ({ ...record(decision.socialSummary), mint: decision.mint, decision: decision.decision }));
  const mints = new Set(summaries.map((item) => item.mint));
  const mintsWithSocial = new Set(summaries.filter((item) => item.available === true).map((item) => item.mint));
  const withX = new Set(summaries.filter((item) => num(record(item.x).mentions5m) !== null).map((item) => item.mint));
  const withTelegram = new Set(summaries.filter((item) => num(record(item.telegram).mentions5m) !== null).map((item) => item.mint));
  const availableSummaries = summaries.filter((item) => item.available === true);
  const overview = {
    decisions: summaries.length,
    tokens: mints.size,
    tokensWithSocial: mintsWithSocial.size,
    coveragePct: mints.size ? mintsWithSocial.size / mints.size * 100 : null,
    xCoveragePct: mints.size ? withX.size / mints.size * 100 : null,
    telegramCoveragePct: mints.size ? withTelegram.size / mints.size * 100 : null,
    averageSocialScore: average(availableSummaries.map((item) => num(item.socialScore))),
    averageMomentum: average(availableSummaries.map((item) => num(item.momentum))),
    averageSpam: average(availableSummaries.map((item) => num(item.spam))),
    averageDataQuality: average(availableSummaries.map((item) => num(item.dataQuality))),
    staleRatePct: availableSummaries.length ? availableSummaries.filter((item) => item.freshness === 'STALE').length / availableSummaries.length * 100 : null,
    shadowDecisionCounts: summaries.reduce<Record<string, number>>((counts, item) => {
      const key = String(item.shadowDecision ?? 'UNKNOWN');
      counts[key] = (counts[key] ?? 0) + 1;
      return counts;
    }, {}),
    boughtVsRejected: ['BUY', 'WATCH', 'REJECT'].map((decision) => {
      const items = availableSummaries.filter((item) => item.decision === decision);
      return { decision, count: items.length, averageSocialScore: average(items.map((item) => num(item.socialScore))), averageSpam: average(items.map((item) => num(item.spam))) };
    }),
  };

  const scoreBucket = (row: LaunchTradeRow) => {
    const score = available(row) ? num(social(row).socialScore) : null;
    if (score === null) return 'UNKNOWN';
    return score <= 30 ? '0–30' : score <= 50 ? '31–50' : score <= 70 ? '51–70' : score <= 85 ? '71–85' : '86–100';
  };
  const t = SOCIAL_THRESHOLDS;
  const matrix = (row: LaunchTradeRow) => {
    const score = available(row) ? num(social(row).socialScore) : null;
    const onchain = row.features.launchMomentumScore;
    if (score === null || onchain === null) return 'UNKNOWN';
    return `${score >= t.highSocialScore ? 'HIGH' : 'LOW'} SOCIAL + ${onchain >= t.highOnchainMomentum ? 'HIGH' : 'LOW'} ONCHAIN`;
  };
  const capacityClass = (row: LaunchTradeRow) => String(record(record(row.capacityAtEntry).atEntry).classification ?? 'UNKNOWN');
  const capacityMatrix = (row: LaunchTradeRow) => {
    const score = available(row) ? num(social(row).socialScore) : null;
    const cls = capacityClass(row);
    if (score === null || cls === 'UNKNOWN') return 'UNKNOWN';
    return `${score >= t.highSocialScore ? 'HIGH' : 'LOW'} SOCIAL + ${['EXCELLENT', 'GOOD'].includes(cls) ? 'GOOD' : 'POOR'} EXIT CAPACITY`;
  };
  const level = (value: number | null, low: number, high: number) => (value === null ? 'UNKNOWN' : value < low ? 'LOW' : value <= high ? 'MEDIUM' : 'HIGH');

  // ---- Hypothetical filters (+ chronological validation when the sample allows it) ----
  const ordered = [...rows].sort((a, b) => a.closedAt - b.closedAt);
  const split = Math.floor(ordered.length * 0.7);
  const filters = SOCIAL_FILTERS.map((filter) => ({
    id: filter.id, label: filter.label,
    all: evaluateFilter(rows, filter.keep),
    validation: ordered.length >= 50 ? { discovery: evaluateFilter(ordered.slice(0, split), filter.keep), holdout: evaluateFilter(ordered.slice(split), filter.keep) } : null,
  }));

  const sampleNote = withSocial.length < 50 ? 'INSUFFICIENT_SAMPLE' : withSocial.length < 100 ? 'EXPLORATORY (50+)' : withSocial.length < 200 ? 'MORE_USEFUL (100+)' : 'STRONGER_EVIDENCE (200+)';
  const winners = withSocial.filter((row) => row.netPnl > 0);
  const losers = withSocial.filter((row) => row.netPnl <= 0);
  return {
    thresholds: SOCIAL_THRESHOLDS,
    overview,
    tradesWithSocial: withSocial.length,
    tradesTotal: rows.length,
    sampleNote,
    scoreBuckets: group(rows, scoreBucket, ['0–30', '31–50', '51–70', '71–85', '86–100', 'UNKNOWN']),
    socialOnchainMatrix: group(rows, matrix, ['HIGH SOCIAL + HIGH ONCHAIN', 'HIGH SOCIAL + LOW ONCHAIN', 'LOW SOCIAL + HIGH ONCHAIN', 'LOW SOCIAL + LOW ONCHAIN', 'UNKNOWN']),
    momentumTrend: group(rows, (row) => (available(row) ? ({ ACCELERATING: 'RISING', STABLE: 'FLAT', DECELERATING: 'FALLING' } as Record<string, string>)[String(social(row).mentionTrend)] ?? 'UNKNOWN' : 'UNKNOWN'), ['RISING', 'FLAT', 'FALLING', 'UNKNOWN']),
    spam: group(rows, (row) => (available(row) ? level(num(social(row).spam), t.spamLow, t.spamHigh) : 'UNKNOWN'), ['LOW', 'MEDIUM', 'HIGH', 'UNKNOWN']).map((item) => item),
    exhaustion: group(rows, (row) => (available(row) ? level(num(social(row).exhaustion), t.exhaustionLow, t.exhaustionHigh) : 'UNKNOWN'), ['LOW', 'MEDIUM', 'HIGH', 'UNKNOWN']).map((item) => ({
      ...item,
      medianEntryAgeSeconds: median(rows.filter((row) => (available(row) ? level(num(social(row).exhaustion), t.exhaustionLow, t.exhaustionHigh) : 'UNKNOWN') === item.key).map((row) => row.features.tokenAgeSeconds)),
      averagePumpExhaustion: average(rows.filter((row) => (available(row) ? level(num(social(row).exhaustion), t.exhaustionLow, t.exhaustionHigh) : 'UNKNOWN') === item.key).map((row) => row.features.exhaustionScore)),
    })),
    confirmation: group(rows, (row) => (available(row) ? String(social(row).confirmation ?? 'UNKNOWN') : 'UNKNOWN'), ['STRONG_CONFIRMATION', 'MODERATE_CONFIRMATION', 'SOCIAL_LEADING', 'ONCHAIN_LEADING', 'DIVERGENCE', 'SOCIAL_ONLY_HYPE', 'WEAK_ACTIVITY', 'UNKNOWN']),
    socialCapacityMatrix: group(rows, capacityMatrix, ['HIGH SOCIAL + GOOD EXIT CAPACITY', 'HIGH SOCIAL + POOR EXIT CAPACITY', 'LOW SOCIAL + GOOD EXIT CAPACITY', 'LOW SOCIAL + POOR EXIT CAPACITY', 'UNKNOWN']),
    diagnosisVsSocial: ['POOR_ENTRY', 'GOOD_ENTRY_BAD_EXIT', 'SUCCESSFUL_EXIT', 'NORMAL_LOSS', 'UNCLASSIFIED'].map((diagnosis) => {
      const items = withSocial.filter((row) => row.diagnosis === diagnosis);
      return { diagnosis, trades: items.length, averageSocialScore: average(items.map((row) => num(social(row).socialScore))), averageMomentum: average(items.map((row) => num(social(row).momentum))), averageSpam: average(items.map((row) => num(social(row).spam))), averageExhaustion: average(items.map((row) => num(social(row).exhaustion))) };
    }),
    winnersVsLosers: {
      winners: { trades: winners.length, averageSocialScore: average(winners.map((row) => num(social(row).socialScore))), averageMomentum: average(winners.map((row) => num(social(row).momentum))) },
      losers: { trades: losers.length, averageSocialScore: average(losers.map((row) => num(social(row).socialScore))), averageMomentum: average(losers.map((row) => num(social(row).momentum))) },
    },
    filters,
    leadLag,
  };
}
