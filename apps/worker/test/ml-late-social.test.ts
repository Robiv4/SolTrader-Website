/* eslint-disable @typescript-eslint/no-explicit-any -- test fakes */
/**
 * FUTURE_DATA_SOCIAL regression (worker): the social assessment is made as of the caller's moment; a social result that
 * still arrives late is excluded (null) and audited; the ML PAPER decision then works on the on-time market data instead
 * of failing with FEATURE_LEAKAGE; SHADOW and ML PAPER build identical features at the same moment.
 */
import { describe, expect, it } from 'vitest';

import { MockSocialProvider } from '../src/social/providers.js';
import { SocialService } from '../src/social/social-service.js';

import { runScenario } from './helpers/ml-scenario.js';

const MINT = 'So1aNaMint1111111111111111111111111111111pump';
const onchain = { launchScore: 80, launchMomentumScore: 70, exhaustionScore: 20, buySellRatio: 2, uniqueBuyers: 40, buyerTrend: 'ACCELERATING' as const, liquidityChangePercent: 10, priceVelocity: 1, priceExtensionPercent: 20 };
const logger = { info: () => undefined, warn: () => undefined };
const prisma = { socialSnapshot: { create: async (args: { data: unknown }) => args.data }, launchCandidate: { updateMany: async () => ({ count: 1 }) } } as never;

/** A social source that is always late: every assessment is dated `delayMs` after the caller's moment. */
function lateSocial(delayMs: number) {
  return (now: () => number) => ({
    track: () => undefined,
    latest: () => null,
    assess: (_mint: string, _onchain: unknown, at?: number) => ({
      at: (at ?? now()) + delayMs, dataQuality: 90, socialScore: 80, momentumScore: 90, qualityScore: 80, shadowDecision: 'NEUTRAL', reasons: [], warnings: [], windows: {}, components: {}, bySource: {}, sources: [], providersUsed: [], providersUnavailable: [], providerWeights: {}, members: { count: null, growth5m: null },
      perSource: { TELEGRAM: { momentum: 99, quality: 90, spam: 1, exhaustion: 1, dataQuality: 95, messages: { '1m': 50, '5m': 200 }, uniqueActiveUsers: { '5m': 60 }, uniqueUserGrowth1m: 30, top3UserShare: 0.1 } },
    }),
  });
}

describe('social assessment as of the decision moment (root cause)', () => {
  it('never dated after `at`, ignores events received after `at`, never reuses a cache built later', async () => {
    const x = new MockSocialProvider('X');
    let now = Date.parse('2026-10-02T12:00:00Z');
    const service = new SocialService({ prisma, providers: [x], logger, fetchMetadata: async () => ({ twitter: 'https://x.com/zorbulator', telegram: null, website: null, name: 'Zorbulator', symbol: 'ZORB' }), now: () => now });
    service.track({ mint: MINT, symbol: 'ZORB', name: 'Zorbulator', metadataUri: 'https://ipfs.io/ipfs/Qm', stage: 3 });
    await service.tick();
    await new Promise((resolve) => globalThis.setTimeout(resolve, 5));
    const receivedAt = now + 16_000;
    for (let index = 0; index < 30; index += 1) x.posts.push({ id: `p${index}`, source: 'X', authorId: `a${index}`, text: `chart of ${MINT} ${index}`, createdAt: now - 60_000 + index * 1_000, receivedAt, likes: 1, reposts: 0, replies: 0 });
    now = receivedAt;
    await service.tick();
    // Latest assessment (builds the cache at `now`).
    const current = service.assess(MINT, onchain)!;
    expect(current.at).toBe(now);
    expect(current.windows['5m']!.mentions).toBe(30);
    // An earlier decision moment: the later cache is not reused, the posts received afterwards are not visible.
    const earlier = service.assess(MINT, onchain, now - 500)!;
    expect(earlier.at).toBeLessThanOrEqual(now - 500);
    expect(earlier.windows['5m']?.mentions ?? 0).toBe(0);
  });
});

describe('ML PAPER with late social data', () => {
  it('late social: ML BUY on the on-time market data (no FEATURE_LEAKAGE), social excluded and audited', async () => {
    const run = await runScenario({ mode: 'ML', probability: 0.95 }, { shadow: true, social: lateSocial(1_500) });
    const decision = run.paperDecisions[0];
    expect(decision).toMatchObject({ mlDecision: 'ML_BUY', errorReason: null, lateDataExcluded: ['SOCIAL'] });
    for (const [name, value] of Object.entries(decision.features)) if (name.startsWith('telegram') || name === 'socialAvailable') expect(value).toBeNull();
    // Audit: the real (late) social time is stored, later than the snapshot - never back-dated.
    expect(decision.observedAt.SOCIAL).toBe(decision.snapshotAt.getTime() + 1_500);
    expect(run.record.signals).toHaveLength(1);
    // The SHADOW snapshot of the same moment is valid (late social is not leakage) and records the exclusion.
    const shadow = (run.record.ml.mlFeatureSnapshot ?? []).find((row: any) => row.kind === 'AGE_30S');
    expect(shadow).toMatchObject({ validForTraining: true, invalidReasons: [], lateDataExcluded: ['SOCIAL'] });
  }, 60_000);

  it('6. SHADOW and ML PAPER build identical features at the same moment (also with on-time social)', async () => {
    for (const social of [lateSocial(1_500), lateSocial(0)]) {
      const run = await runScenario({ mode: 'ML', probability: 0.95 }, { shadow: true, social });
      const decision = run.paperDecisions[0];
      const shadow = (run.record.ml.mlFeatureSnapshot ?? []).find((row: any) => row.kind === 'AGE_30S');
      expect(shadow.snapshotAt.getTime()).toBe(decision.snapshotAt.getTime());
      expect(decision.features).toEqual(shadow.features);
      expect(decision.dataQuality).toBe(shadow.dataQuality);
    }
  }, 60_000);

  it('on-time social is used by the decision (not excluded)', async () => {
    const run = await runScenario({ mode: 'ML', probability: 0.95 }, { social: lateSocial(0) });
    expect(run.paperDecisions[0].features.telegramMomentum).toBe(99);
    expect(run.paperDecisions[0].lateDataExcluded).toEqual([]);
  }, 60_000);
});
