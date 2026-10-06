/**
 * Telegram-only social analytics for NewLaunch (MONITOR_ONLY). Uses ONLY the Telegram features frozen at each
 * decision / entry (`telegramFeatures` in the stored social summary): no lookahead, no backfill. Trades entered before
 * Telegram collection existed are TELEGRAM_DATA_NOT_AVAILABLE - their own group, never "low".
 *
 * Diagnostics only: nothing here changes the strategy. Filters are ranked by profit factor / expectancy / P&L /
 * drawdown / winner retention (never by win rate) and validated chronologically (70/30) when the sample allows.
 */
import type { LaunchTradeRow } from './new-launch-analytics.js';

type Json = Record<string, unknown>;
const record = (value: unknown): Json => (value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {});
const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const average = (values: Array<number | null | undefined>) => {
  const known = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  return known.length ? known.reduce((sum, value) => sum + value, 0) / known.length : null;
};

export const NOT_AVAILABLE = 'TELEGRAM_DATA_NOT_AVAILABLE';
/** Telegram activity level from Telegram Momentum: LOW < 40 <= MEDIUM <= 60 < HIGH. */
export const TELEGRAM_LEVELS = { low: 40, high: 60, spamLow: 30, spamHigh: 60, highOnchainMomentum: 60 };
const SCORE_BUCKETS = ['0–30', '31–50', '51–70', '71–85', '86–100'];

const features = (row: LaunchTradeRow) => record(record(row.socialAtEntry).telegramFeatures);
const hasTelegram = (row: LaunchTradeRow) => Object.keys(features(row)).length > 0 && num(features(row).dataQuality) !== null;

export function tradeStats(rows: LaunchTradeRow[]) {
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
    trades: rows.length, wins: winners.length, losses: losers.length,
    winRate: rows.length ? winners.length / rows.length * 100 : null,
    netPnl: rows.reduce((sum, row) => sum + row.netPnl, 0),
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
    expectancy: rows.length ? rows.reduce((sum, row) => sum + row.netPnl, 0) / rows.length : null,
    averageMfePercent: average(rows.map((row) => row.mfePercent)),
    averageMaePercent: average(rows.map((row) => row.maePercent)),
    maxDrawdown: rows.length >= 5 ? drawdown : null,
    smallSample: rows.length < 20,
  };
}

function group(rows: LaunchTradeRow[], keyOf: (row: LaunchTradeRow) => string, order: string[]) {
  const groups = new Map<string, LaunchTradeRow[]>(order.map((key) => [key, []]));
  for (const row of rows) {
    const key = keyOf(row);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.entries()].map(([key, items]) => ({ key, ...tradeStats(items) }));
}

const scoreBucket = (value: number | null) => (value === null ? NOT_AVAILABLE : value <= 30 ? '0–30' : value <= 50 ? '31–50' : value <= 70 ? '51–70' : value <= 85 ? '71–85' : '86–100');
export const telegramLevel = (row: LaunchTradeRow) => {
  if (!hasTelegram(row)) return NOT_AVAILABLE;
  const momentum = num(features(row).momentum);
  if (momentum === null) return NOT_AVAILABLE;
  return momentum < TELEGRAM_LEVELS.low ? 'TG LOW' : momentum <= TELEGRAM_LEVELS.high ? 'TG MEDIUM' : 'TG HIGH';
};

/** Hypothetical filter: trades without Telegram data always pass (missing data is not negative evidence). */
function evaluateFilter(rows: LaunchTradeRow[], keep: (row: LaunchTradeRow) => boolean) {
  const kept = rows.filter((row) => !hasTelegram(row) || keep(row));
  const removed = rows.filter((row) => hasTelegram(row) && !keep(row));
  const before = tradeStats(rows);
  const after = tradeStats(kept);
  const winners = rows.filter((row) => row.netPnl > 0).length;
  const winnersRemoved = removed.filter((row) => row.netPnl > 0).length;
  return {
    tradesRemoved: removed.length, losersRemoved: removed.length - winnersRemoved, winnersRemoved,
    poorEntriesRemoved: removed.filter((row) => row.diagnosis === 'POOR_ENTRY').length,
    winnerRetentionPct: winners ? (winners - winnersRemoved) / winners * 100 : null,
    netPnlBefore: before.netPnl, netPnlAfter: after.netPnl, netPnlChange: after.netPnl - before.netPnl,
    profitFactorBefore: before.profitFactor, profitFactorAfter: after.profitFactor,
    expectancyBefore: before.expectancy, expectancyAfter: after.expectancy,
    maxDrawdownBefore: before.maxDrawdown, maxDrawdownAfter: after.maxDrawdown,
  };
}

export const TELEGRAM_FILTERS: Array<{ id: string; label: string; keep: (row: LaunchTradeRow) => boolean }> = [
  { id: 'TG_MOMENTUM_GE_40', label: 'Telegram Momentum ≥ 40', keep: (row) => (num(features(row).momentum) ?? 100) >= 40 },
  { id: 'TG_QUALITY_GE_50', label: 'Telegram Quality ≥ 50', keep: (row) => (num(features(row).quality) ?? 100) >= 50 },
  { id: 'TG_SPAM_LT_60', label: 'Telegram Spam < 60', keep: (row) => (num(features(row).spam) ?? 0) < 60 },
  { id: 'TG_USERS_GE_10', label: 'Aktív felhasználók (5 p) ≥ 10', keep: (row) => (num(features(row).uniqueActiveUsers5m) ?? 100) >= 10 },
  { id: 'TG_NO_HYPE_DIVERGENCE', label: 'Nem SOCIAL_ONLY_HYPE / DIVERGENCE', keep: (row) => !['SOCIAL_ONLY_HYPE', 'DIVERGENCE'].includes(String(features(row).confirmation)) },
  { id: 'TG_EXHAUSTION_LT_60', label: 'Telegram Exhaustion < 60', keep: (row) => (num(features(row).exhaustion) ?? 0) < 60 },
];

/** Ranking key: PF, then expectancy, P&L change, lower drawdown, winner retention (win rate deliberately not used). */
function rankFilters<T extends { all: ReturnType<typeof evaluateFilter> }>(filters: T[]) {
  const desc = (a: number | null, b: number | null) => (b ?? -Infinity) - (a ?? -Infinity);
  return [...filters].sort((a, b) => desc(a.all.profitFactorAfter, b.all.profitFactorAfter)
    || desc(a.all.expectancyAfter, b.all.expectancyAfter)
    || desc(a.all.netPnlChange, b.all.netPnlChange)
    || (a.all.maxDrawdownAfter ?? Infinity) - (b.all.maxDrawdownAfter ?? Infinity)
    || desc(a.all.winnerRetentionPct, b.all.winnerRetentionPct));
}

export interface TelegramAnalyticsContext {
  /** Live provider health (`social:health` from the worker); null when the worker has not published it. */
  health: Json | null;
  /** Rows of the TelegramSource registry (no credentials). */
  sources: { total: number; accessible: number; official: number; community: number; noAccess: number };
}

export function buildTelegramAnalytics(rows: LaunchTradeRow[], decisions: Array<{ mint: string; decision: string; socialSummary: unknown }>, context: TelegramAnalyticsContext) {
  const withTelegram = rows.filter(hasTelegram);
  const health = record(context.health);
  const provider = record((Array.isArray(health.providers) ? health.providers : []).find((item) => record(item).source === 'TELEGRAM'));
  const details = record(provider.details);
  const summaries = decisions.map((decision) => ({ mint: decision.mint, decision: decision.decision, tg: record(record(decision.socialSummary).telegramFeatures) }));
  const mints = new Set(summaries.map((item) => item.mint));
  const covered = summaries.filter((item) => num(item.tg.dataQuality) !== null);
  const coveredMints = new Set(covered.map((item) => item.mint));
  const freshMints = new Set(covered.filter((item) => item.tg.freshness === 'FRESH').map((item) => item.mint));
  const messages = record(record(health.messages).TELEGRAM);
  const tgCoverage = record(health.telegramCoverage);

  const overview = {
    enabled: provider.enabled === true,
    state: provider.state ?? 'UNKNOWN',
    engineStatus: health.engineStatus ?? 'UNKNOWN',
    monitoredTokens: num(tgCoverage.monitoredTokens),
    matchedSources: context.sources.accessible,
    sources: context.sources,
    decisions: summaries.length,
    tokens: mints.size,
    coveragePct: mints.size ? coveredMints.size / mints.size * 100 : null,
    freshCoveragePct: mints.size ? freshMints.size / mints.size * 100 : null,
    messagesReceived: num(messages.received) ?? num(details.messagesReceived),
    messagesProcessed: num(messages.processed),
    averageUniqueUsers5m: average(covered.map((item) => num(item.tg.uniqueActiveUsers5m))),
    averageMomentum: average(covered.map((item) => num(item.tg.momentum))),
    averageQuality: average(covered.map((item) => num(item.tg.quality))),
    averageSpam: average(covered.map((item) => num(item.tg.spam))),
    averageDataQuality: average(covered.map((item) => num(item.tg.dataQuality))),
  };

  const order = [...SCORE_BUCKETS, NOT_AVAILABLE];
  const levelOrder = ['TG LOW', 'TG MEDIUM', 'TG HIGH', NOT_AVAILABLE];
  const level = (value: number | null, low: number, high: number) => (value === null ? NOT_AVAILABLE : value < low ? 'LOW' : value <= high ? 'MEDIUM' : 'HIGH');
  const cross = (first: (row: LaunchTradeRow) => string | null, firstOrder: string[]) => firstOrder.flatMap((a) => levelOrder.map((b) => {
    const items = rows.filter((row) => first(row) === a && telegramLevel(row) === b);
    return { key: `${a} × ${b}`, first: a, telegram: b, ...tradeStats(items) };
  }));
  const launchBucket = (row: LaunchTradeRow) => {
    const score = row.features.launchScore;
    return score === null || score === undefined ? null : score >= 90 ? '90–100' : score >= 80 ? '80–89' : score >= 70 ? '70–79' : null;
  };
  const ageBucket = (row: LaunchTradeRow) => {
    const age = row.features.tokenAgeSeconds;
    return age === null || age === undefined ? null : age <= 10 ? '0–10 mp' : age <= 30 ? '11–30 mp' : age <= 60 ? '31–60 mp' : age <= 90 ? '61–90 mp' : null;
  };
  const tgOnchain = (row: LaunchTradeRow) => {
    const tg = telegramLevel(row);
    const onchain = row.features.launchMomentumScore;
    if (tg === NOT_AVAILABLE || onchain === null || onchain === undefined) return NOT_AVAILABLE;
    return `${tg === 'TG HIGH' ? 'HIGH' : 'LOW'} TELEGRAM + ${onchain >= TELEGRAM_LEVELS.highOnchainMomentum ? 'HIGH' : 'LOW'} ONCHAIN`;
  };

  const ordered = [...rows].sort((a, b) => a.closedAt - b.closedAt);
  const split = Math.floor(ordered.length * 0.7);
  const filters = rankFilters(TELEGRAM_FILTERS.map((filter) => {
    const all = evaluateFilter(rows, filter.keep);
    const warnings = [
      withTelegram.length < 50 ? 'SMALL_SAMPLE: kevesebb mint 50 Telegram-adatos trade' : null,
      all.tradesRemoved > 0 && all.tradesRemoved < 5 ? 'FEW_REMOVED: 5-nél kevesebb trade-et szűrne' : null,
      ordered.length < 50 ? 'NO_VALIDATION: 50 trade alatt nincs 70/30 validáció' : null,
    ].filter(Boolean);
    return {
      id: filter.id, label: filter.label, all, warnings,
      validation: ordered.length >= 50 ? { discovery: evaluateFilter(ordered.slice(0, split), filter.keep), holdout: evaluateFilter(ordered.slice(split), filter.keep) } : null,
    };
  }));

  const sampleNote = withTelegram.length === 0 ? NOT_AVAILABLE : withTelegram.length < 50 ? 'INSUFFICIENT_SAMPLE' : withTelegram.length < 100 ? 'EXPLORATORY (50+)' : withTelegram.length < 200 ? 'MORE_USEFUL (100+)' : 'STRONGER_EVIDENCE (200+)';
  return {
    dataStatus: withTelegram.length ? 'AVAILABLE' : NOT_AVAILABLE,
    levels: TELEGRAM_LEVELS,
    overview,
    tradesWithTelegram: withTelegram.length,
    tradesWithoutTelegram: rows.length - withTelegram.length,
    tradesTotal: rows.length,
    sampleNote,
    momentumBuckets: group(rows, (row) => (hasTelegram(row) ? scoreBucket(num(features(row).momentum)) : NOT_AVAILABLE), order),
    qualityBuckets: group(rows, (row) => (hasTelegram(row) ? scoreBucket(num(features(row).quality)) : NOT_AVAILABLE), order),
    spam: group(rows, (row) => (hasTelegram(row) ? level(num(features(row).spam), TELEGRAM_LEVELS.spamLow, TELEGRAM_LEVELS.spamHigh) : NOT_AVAILABLE), ['LOW', 'MEDIUM', 'HIGH', NOT_AVAILABLE]),
    telegramOnchainMatrix: group(rows, tgOnchain, ['HIGH TELEGRAM + HIGH ONCHAIN', 'HIGH TELEGRAM + LOW ONCHAIN', 'LOW TELEGRAM + HIGH ONCHAIN', 'LOW TELEGRAM + LOW ONCHAIN', NOT_AVAILABLE]),
    launchScoreByTelegram: cross(launchBucket, ['70–79', '80–89', '90–100']),
    entryAgeByTelegram: cross(ageBucket, ['0–10 mp', '11–30 mp', '31–60 mp', '61–90 mp']),
    confirmation: group(rows, (row) => (hasTelegram(row) ? String(features(row).confirmation ?? 'UNKNOWN') : NOT_AVAILABLE), ['STRONG_CONFIRMATION', 'MODERATE_CONFIRMATION', 'TELEGRAM_LEADING', 'ONCHAIN_LEADING', 'DIVERGENCE', 'SOCIAL_ONLY_HYPE', 'WEAK_ACTIVITY', 'UNKNOWN', NOT_AVAILABLE]),
    diagnosis: ['POOR_ENTRY', 'GOOD_ENTRY_BAD_EXIT', 'SUCCESSFUL_EXIT', 'NORMAL_LOSS', 'UNCLASSIFIED'].map((diagnosis) => {
      const items = withTelegram.filter((row) => row.diagnosis === diagnosis);
      return {
        diagnosis, trades: items.length,
        averageMomentum: average(items.map((row) => num(features(row).momentum))), averageQuality: average(items.map((row) => num(features(row).quality))),
        averageSpam: average(items.map((row) => num(features(row).spam))), averageUniqueUsers5m: average(items.map((row) => num(features(row).uniqueActiveUsers5m))),
      };
    }),
    filters,
  };
}
