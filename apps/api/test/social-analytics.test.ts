import { describe, expect, it } from 'vitest';

import type { LaunchTradeRow } from '../src/new-launch-analytics.js';
import { buildSocialAnalytics } from '../src/social-analytics.js';
import { buildTelegramAnalytics } from '../src/telegram-analytics.js';

function row(index: number, netPnl: number, social: Record<string, unknown> | null, extra: Partial<LaunchTradeRow> = {}): LaunchTradeRow {
  return {
    id: `t${index}`, positionId: null, tokenId: 'tok', tokenAddress: `mint${index}`, symbol: `S${index}`, entryAt: index * 1_000, closedAt: index * 1_000 + 500, netPnl, size: 20, quantity: 1,
    returnPercent: netPnl * 5, holdMs: 500, exitReason: null, exitGroup: 'OTHER', configVersion: 'NL-v2', features: { launchMomentumScore: 70, tokenAgeSeconds: 20, exhaustionScore: 30 } as Record<string, number | null>,
    riskClassification: null, entryPrice: 1, exitPrice: 1, path: null, pathSource: null, mfePercent: 10, maePercent: -5, captureRatio: null, givebackPercent: null,
    diagnosis: netPnl > 0 ? 'SUCCESSFUL_EXIT' : 'POOR_ENTRY', breakEvenAppliedAtMs: null, trailingActivatedAtMs: null, trailingActivationPrice: null, trailingFinalStop: null, highestPrice: null,
    trailingMonotonic: null, liquidityAtEntry: null, exitLiquidity: null, liquidityChangePercent: null, exitBuySellRatio: null, exitConfig: null, qualityGate: null,
    latency: { observationMs: null, securityMs: null, decisionMs: null, executionMs: null, totalMs: null, postObservationMs: null }, forensics: null,
    prices: { detected: null, decision: null, requested: null, fill: null, exitTrigger: null, exitFill: null }, fees: 0, entrySlippage: null, exitSlippage: null,
    entryMarketPrice: null, exitMarketPrice: null, capacityAtEntry: null, exitCapacityAtTrigger: null, socialAtEntry: social, ...extra,
  } as LaunchTradeRow;
}

describe('social analytics', () => {
  it('missing social data is its own group and always passes hypothetical filters (never negative evidence)', () => {
    const rows = [
      row(1, 2, { available: true, socialScore: 80, spam: 10, shadowDecision: 'POSITIVE_CONFIRMATION', mentionTrend: 'ACCELERATING', exhaustion: 10 }),
      row(2, -1, { available: true, socialScore: 20, spam: 80, shadowDecision: 'AVOID', mentionTrend: 'DECELERATING', exhaustion: 70 }),
      row(3, -1, { available: false, shadowDecision: 'UNKNOWN' }),
      row(4, 3, null),
    ];
    const result = buildSocialAnalytics(rows, [], null);
    expect(result.tradesWithSocial).toBe(2);
    expect(result.scoreBuckets.find((bucket) => bucket.key === 'UNKNOWN')?.trades).toBe(2);
    const avoid = result.filters.find((filter) => filter.id === 'NOT_AVOID')!;
    expect(avoid.all).toMatchObject({ tradesRemoved: 1, losersRemoved: 1, winnersRemoved: 0, poorEntriesRemoved: 1, winnerRetentionPct: 100 });
    expect(avoid.validation).toBeNull();
    expect(result.sampleNote).toBe('INSUFFICIENT_SAMPLE');
    expect(result.momentumTrend.find((bucket) => bucket.key === 'RISING')?.trades).toBe(1);
  });

  it('overview counts coverage from decisions (rejected candidates included)', () => {
    const result = buildSocialAnalytics([], [
      { mint: 'a', decision: 'REJECT', socialSummary: { available: true, socialScore: 40, x: { mentions5m: 3 }, telegram: null, freshness: 'FRESH' } },
      { mint: 'b', decision: 'BUY', socialSummary: { available: false } },
    ], null);
    expect(result.overview).toMatchObject({ tokens: 2, tokensWithSocial: 1, coveragePct: 50, xCoveragePct: 50, telegramCoveragePct: 0 });
  });
});

describe('telegram analytics', () => {
  const tgRow = (index: number, netPnl: number, momentum: number, extra: Record<string, unknown> = {}) => row(index, netPnl, {
    available: true, telegramFeatures: { momentum, quality: 60, spam: momentum > 80 ? 75 : 20, exhaustion: 10, dataQuality: 70, uniqueActiveUsers5m: 20, confirmation: 'MODERATE_CONFIRMATION', freshness: 'FRESH', ...extra },
  }, { features: { launchMomentumScore: 70, launchScore: 84, tokenAgeSeconds: 25 } as Record<string, number | null> });
  const context = { health: null, sources: { total: 0, accessible: 0, official: 0, community: 0, noAccess: 0 } };

  it('historical trades without Telegram collection are TELEGRAM_DATA_NOT_AVAILABLE (no backfill), never "low"', () => {
    const rows = Array.from({ length: 10 }, (_, index) => row(index, index % 2 ? 1 : -1, { available: true, socialScore: 50 }));
    const result = buildTelegramAnalytics(rows, [], context);
    expect(result.dataStatus).toBe('TELEGRAM_DATA_NOT_AVAILABLE');
    expect(result.momentumBuckets.find((bucket) => bucket.key === 'TELEGRAM_DATA_NOT_AVAILABLE')?.trades).toBe(10);
    expect(result.momentumBuckets.filter((bucket) => bucket.key !== 'TELEGRAM_DATA_NOT_AVAILABLE').every((bucket) => bucket.trades === 0)).toBe(true);
    // Filters never remove trades without Telegram data.
    expect(result.filters.every((filter) => filter.all.tradesRemoved === 0)).toBe(true);
  });

  it('buckets, Launch Score x TG, entry age x TG, small-N warnings and PF-first filter ranking', () => {
    const rows = [
      ...Array.from({ length: 12 }, (_, index) => tgRow(index, index % 3 ? 2 : -1, 75)),
      ...Array.from({ length: 12 }, (_, index) => tgRow(20 + index, index % 3 ? -2 : 1, 20)),
      row(40, 3, null),
    ];
    const result = buildTelegramAnalytics(rows, [{ mint: 'mint1', decision: 'BUY', socialSummary: { telegramFeatures: { dataQuality: 70, freshness: 'FRESH', momentum: 75 } } }, { mint: 'mint2', decision: 'REJECT', socialSummary: { available: false } }], context);
    expect(result.tradesWithTelegram).toBe(24);
    expect(result.tradesWithoutTelegram).toBe(1);
    expect(result.overview.coveragePct).toBe(50);
    expect(result.momentumBuckets.find((bucket) => bucket.key === '71–85')).toMatchObject({ trades: 12, wins: 8, losses: 4 });
    expect(result.launchScoreByTelegram.find((cell) => cell.key === '80–89 × TG HIGH')?.trades).toBe(12);
    expect(result.entryAgeByTelegram.find((cell) => cell.key === '11–30 mp × TG LOW')?.trades).toBe(12);
    expect(result.filters[0].warnings.join(' ')).toContain('SMALL_SAMPLE');
    // Ranked by profit factor after the filter (not by win rate): removing the weak-TG losers ranks first.
    expect(result.filters[0].id).toBe('TG_MOMENTUM_GE_40');
  });
});
