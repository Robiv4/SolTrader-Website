/**
 * Community Intelligence + ML-FEATURES-COMMUNITY-v1: missing data stays null (never 0), only data received by the
 * snapshot moment is used, unreliable identity is not used, the score is deterministic, the v1 schema is unchanged,
 * and the simulated-exit label (experiment B) follows the New Launch exit rules pessimistically.
 */
import { describe, expect, it } from 'vitest';

import {
  buildCommunityFeatureSnapshot, buildMlDataset, buildMlFeatureSnapshot, computeCommunitySnapshot, computeOnchainCommunityStats, DEFAULT_SIM_EXIT_RULES,
  featureSchemaFor, isSupportedFeatureVersion, ML_COMMUNITY_FEATURE_SCHEMA, ML_COMMUNITY_FEATURE_SPECS, ML_COMMUNITY_FEATURE_VERSION, ML_FEATURE_SCHEMA,
  ML_FEATURE_VERSION, simulateNewLaunchExit,
  type CommunityInput, type DexProfileObservation, type LaunchObservation, type LaunchSecurity, type OnchainTradeEvent, type OutcomePathState, type PathBucket,
  type SocialSnapshotResult,
} from '../src/index.js';

const T = Date.parse('2026-10-18T12:00:30Z');
const dex = (receivedAt: number, extra: Partial<DexProfileObservation> = {}): DexProfileObservation => ({
  receivedAt, pairFound: true, identityConfirmed: true, profilePresent: true, websites: 1, socials: { twitter: true, telegram: true, discord: false, other: 0 },
  activeBoosts: 0, paidOrders: [], boostPayments: [], pairCreatedAt: T - 60_000, liquidityUsd: 20_000, dexId: 'pumpfun', ...extra,
});
const trades = (count: number, at: number, usd = (index: number) => 10 + index): OnchainTradeEvent[] =>
  Array.from({ length: count }, (_, index) => ({ wallet: `W${index}`, isBuy: true, usd: usd(index), receivedAt: at - 50_000 + index * 1_000 }));
const social = (at: number) => ({
  at, tokenMatchConfidence: 0.9, socialScore: 70, momentumScore: 80, spamScore: 10,
  sources: [{ source: 'TELEGRAM', available: true, reason: null }, { source: 'X', available: false, reason: 'NOT_CONFIGURED' }],
  perSource: { TELEGRAM: { lastEventAt: at - 5_000, messages: { '5m': 40 } } },
  windows: { '1m': { mentions: 12, uniqueAuthors: 8 }, '5m': { mentions: 40, uniqueAuthors: 20, forwardedShare: 0.1, replyShare: 0.2 } },
}) as unknown as SocialSnapshotResult;
const input = (extra: Partial<CommunityInput> = {}): CommunityInput => ({ at: T, mint: 'MINT', social: null, dex: null, onchain: null, lunar: null, providers: { LUNARCRUSH: 'NOT_CONFIGURED', X: 'NOT_CONFIGURED' }, ...extra });

describe('community snapshot', () => {
  it('no data at all: every feature null (missing is never 0), quality NO_DATA, no score', () => {
    const result = computeCommunitySnapshot(input());
    expect(result.quality).toBe('NO_DATA');
    expect(result.features.communityScore).toBeNull();
    for (const [name, value] of Object.entries(result.features)) if (!['communityDataQuality', 'communityCoverage'].includes(name)) expect(value, name).toBeNull();
    expect(result.features.communityCoverage).toBe(0);
    expect(result.sources.LUNARCRUSH.status).toBe('NOT_CONFIGURED');
    expect(result.mode).toBe('MONITOR_ONLY');
  });

  it('uses social + DEX + on-chain known at the snapshot; deterministic weighted score', () => {
    const onchain = computeOnchainCommunityStats(trades(12, T), T);
    const a = computeCommunitySnapshot(input({ social: social(T), dex: dex(T - 10_000), onchain }));
    const b = computeCommunitySnapshot(input({ social: social(T), dex: dex(T - 10_000), onchain }));
    expect(a).toEqual(b);
    expect(a.features.communityScore).not.toBeNull();
    expect(a.features.mentions5m).toBe(40);
    expect(a.features.uniqueAuthors5m).toBe(20);
    expect(a.features.onchainBuyers5m).toBe(12);
    expect(a.features.dexSocialLinkCount).toBe(2);
    expect(Object.values(a.weightsUsed).reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 3);
    expect(a.sources.TELEGRAM.status).toBe('OK');
  });

  it('data received after the snapshot is excluded (LATE), never back-filled', () => {
    const result = computeCommunitySnapshot(input({ social: social(T + 2_000), dex: dex(T + 1_000) }));
    expect(result.lateExcluded).toEqual(expect.arrayContaining(['TELEGRAM', 'DEXSCREENER']));
    expect(result.features.mentions5m).toBeNull();
    expect(result.features.dexProfilePresent).toBeNull();
  });

  it('on-chain stats only count trades received by `at`', () => {
    const all = [...trades(5, T), { wallet: 'LATE', isBuy: true, usd: 999, receivedAt: T + 1 }];
    expect(computeOnchainCommunityStats(all, T).buyers5m).toBe(5);
  });

  it('DEX pair of another base token: UNRELIABLE_IDENTITY, profile not used', () => {
    const result = computeCommunitySnapshot(input({ dex: dex(T - 1_000, { identityConfirmed: false }) }));
    expect(result.sources.DEXSCREENER.status).toBe('UNRELIABLE_IDENTITY');
    expect(result.features.dexWebsitePresent).toBeNull();
  });

  it('stale DEX data is not used', () => {
    const result = computeCommunitySnapshot(input({ dex: dex(T - 20 * 60_000) }));
    expect(result.sources.DEXSCREENER.status).toBe('STALE');
    expect(result.features.dexProfilePresent).toBeNull();
  });

  it('paid promotion only counts payments made by the snapshot moment', () => {
    const later = computeCommunitySnapshot(input({ dex: dex(T - 1_000, { paidOrders: [{ type: 'tokenProfile', status: 'approved', paymentTimestamp: T + 60_000 }] }) }));
    const before = computeCommunitySnapshot(input({ dex: dex(T - 1_000, { paidOrders: [{ type: 'tokenProfile', status: 'approved', paymentTimestamp: T - 60_000 }] }) }));
    expect(later.features.paidPromotionSignal).toBe(false);
    expect(before.features.paidPromotionSignal).toBe(true);
  });

  it('bot-like identical buy amounts from different wallets raise repeatedAmountShare and concentration is measured', () => {
    const bots = computeOnchainCommunityStats(trades(10, T, () => 25), T);
    const organic = computeOnchainCommunityStats(trades(10, T), T);
    expect(bots.repeatedAmountShare!).toBeGreaterThan(organic.repeatedAmountShare!);
    const whale = computeOnchainCommunityStats([...trades(4, T), { wallet: 'WHALE', isBuy: true, usd: 5_000, receivedAt: T - 1_000 }], T);
    expect(whale.buyerHhi!).toBeGreaterThan(0.9);
  });

  it('LunarCrush record without the mint is never used', () => {
    const result = computeCommunitySnapshot(input({ providers: {}, lunar: { receivedAt: T - 1_000, identityConfirmed: false, galaxyScore: 70, altRank: 1, sentiment: 80, socialVolume: 100, interactions: 10, contributors: 5 } }));
    expect(result.sources.LUNARCRUSH.status).toBe('UNRELIABLE_IDENTITY');
    expect(result.features.lunarGalaxyScore).toBeNull();
  });
});

const security: LaunchSecurity = { sellability: 'VERIFIED', mintAuthorityRevoked: true, freezeAuthorityRevoked: true, tokenProgram: 'spl-token', extensions: [], hardBlockReasons: [], warnings: [] };
const obs = (seconds: number, price: number): LaunchObservation => ({ takenAt: T + seconds * 1000, priceUsd: price, liquidityUsd: 20_000, buyCount: 20 + seconds, sellCount: 4, volumeUsd: 900, buyVolumeUsd: 700, sellVolumeUsd: 200, uniqueBuyers: 14, uniqueSellers: 3 });
const launchState = { mint: 'MINT', detectedAt: T - 30_000, createdAt: T - 31_000, observations: [obs(-28, 1), obs(-10, 1.1), obs(0, 1.12)], largestBuyerShare: 0.2, buysPerBuyer: 1.2, creatorSoldRatio: 0, largestHolderSupplyShare: 0.03, priceImpactPercent: 1, observedSellers: 2 };
const base = { snapshotAt: T, source: 'PUMP_FUN', detectedAt: T - 30_000, createdAt: T - 31_000, firstTradeAt: T - 29_000, state: launchState, security, securityObservedAt: T - 5_000, riskScore: 40, riskObservedAt: T, referenceImpactPct: 1.1, social: null };

describe('ML-FEATURES-COMMUNITY-v1 snapshot', () => {
  it('v1 schema and v1 snapshots are unchanged; community = v1 + COMMUNITY group', () => {
    expect(ML_FEATURE_VERSION).toBe('ML-FEATURES-v1');
    expect(ML_FEATURE_SCHEMA.some((spec) => spec.group === 'COMMUNITY')).toBe(false);
    expect(ML_COMMUNITY_FEATURE_SCHEMA.slice(0, ML_FEATURE_SCHEMA.length)).toEqual(ML_FEATURE_SCHEMA);
    expect(featureSchemaFor(ML_COMMUNITY_FEATURE_VERSION)).toBe(ML_COMMUNITY_FEATURE_SCHEMA);
    expect(isSupportedFeatureVersion('ML-FEATURES-v999')).toBe(false);
    expect(() => featureSchemaFor('ML-FEATURES-v999')).toThrow();
    const v1 = buildMlFeatureSnapshot(base);
    const community = buildCommunityFeatureSnapshot({ ...base, community: null });
    for (const spec of ML_FEATURE_SCHEMA) expect(community.features[spec.name]).toEqual(v1.features[spec.name]);
    expect(community.featureVersion).toBe(ML_COMMUNITY_FEATURE_VERSION);
    for (const spec of ML_COMMUNITY_FEATURE_SPECS) expect(community.features[spec.name]).toBeNull();
  });

  it('a community snapshot computed after the moment is excluded (nulls, audited, still valid)', () => {
    const late = computeCommunitySnapshot(input({ at: T + 3_000, dex: dex(T + 1_000) }));
    const snapshot = buildCommunityFeatureSnapshot({ ...base, community: late });
    expect(snapshot.lateDataExcluded).toContain('COMMUNITY');
    expect(snapshot.observedAt.COMMUNITY).toBe(T + 3_000);
    for (const spec of ML_COMMUNITY_FEATURE_SPECS) expect(snapshot.features[spec.name]).toBeNull();
    expect(snapshot.validForTraining).toBe(true);
  });

  it('on-time community data fills the COMMUNITY group', () => {
    const community = computeCommunitySnapshot(input({ dex: dex(T - 1_000), onchain: computeOnchainCommunityStats(trades(8, T), T) }));
    const snapshot = buildCommunityFeatureSnapshot({ ...base, community });
    expect(snapshot.features.onchainBuyers5m).toBe(8);
    expect(snapshot.features.dexProfilePresent).toBe(true);
    expect(snapshot.lateDataExcluded).not.toContain('COMMUNITY');
  });
});

const path = (buckets: PathBucket[], extra: Partial<OutcomePathState> = {}): OutcomePathState => ({ startAt: T, entryPrice: 1, entryLiquidity: 20_000, buckets, gaps: [], endedAt: null, endReason: null, creatorSellAt: null, ...extra });

describe('simulated New Launch exit (experiment B label)', () => {
  it('stop loss hits first when a bucket touches both SL and TP (pessimistic)', () => {
    const result = simulateNewLaunchExit(path([[1_000, 1.5, 0.7, 1.2, 3, 20_000]]), DEFAULT_SIM_EXIT_RULES);
    expect(result.reason).toBe('STOP_LOSS');
    expect(result.netReturnPct!).toBeLessThan(-20);
  });

  it('take profit is net of fees and slippage (below the gross TP)', () => {
    const result = simulateNewLaunchExit(path([[1_000, 1.05, 0.99, 1.04, 3, 20_000], [2_000, 1.4, 1.1, 1.3, 3, 20_000]]), DEFAULT_SIM_EXIT_RULES);
    expect(result.reason).toBe('TAKE_PROFIT');
    expect(result.netReturnPct!).toBeGreaterThan(0);
    expect(result.netReturnPct!).toBeLessThan(DEFAULT_SIM_EXIT_RULES.takeProfitPercent);
  });

  it('a data gap before the exit or an early observation end gives UNKNOWN (no invented price)', () => {
    expect(simulateNewLaunchExit(path([[5_000, 1, 0.5, 0.6, 1, 20_000]], { gaps: [[T + 1_000, T + 4_000]] }), DEFAULT_SIM_EXIT_RULES).status).toBe('UNKNOWN');
    expect(simulateNewLaunchExit(path([[1_000, 1.02, 0.98, 1, 1, 20_000]], { endedAt: T + 2_000, endReason: 'MIGRATED' }), DEFAULT_SIM_EXIT_RULES)).toMatchObject({ status: 'UNKNOWN', unknownReason: 'OBSERVATION_ENDED' });
  });

  it('a normal end of the observation window is marked to market (HORIZON)', () => {
    const result = simulateNewLaunchExit(path([[1_000, 1.02, 0.98, 1.01, 1, 20_000]], { endedAt: T + 3_600_001, endReason: 'HORIZON_REACHED' }), DEFAULT_SIM_EXIT_RULES);
    expect(result).toMatchObject({ status: 'RESOLVED', reason: 'HORIZON' });
  });

  it('max hold closes at the configured time when enabled', () => {
    const rules = { ...DEFAULT_SIM_EXIT_RULES, maxHoldEnabled: true, maxHoldMinutes: 1 };
    const result = simulateNewLaunchExit(path([[30_000, 1.02, 0.98, 1, 1, 20_000], [70_000, 1.02, 0.98, 1.01, 1, 20_000]]), rules);
    expect(result).toMatchObject({ reason: 'MAX_HOLD_TIME', exitOffsetMs: 60_000 });
  });

  it('dataset: simExitNetPositive needs a complete outcome with a path; label from the simulation', () => {
    const snapshot = buildCommunityFeatureSnapshot({ ...base, community: null });
    const row = (id: string, buckets: PathBucket[] | null) => ({
      snapshotId: id, candidateId: `c-${id}`, mint: `m-${id}`, source: 'PUMP_FUN', kind: 'AGE_30S', snapshotAt: T, featureVersion: ML_COMMUNITY_FEATURE_VERSION,
      features: snapshot.features, validForTraining: true, invalidReasons: [], dataQuality: 90, decision: 'WATCH',
      outcome: { quality: 'COMPLETE', labelVersion: 'ML-LABELS-v1' } as never, outcomePath: buckets ? path(buckets) : null, paperNetPnl: null, paperExitAt: null, paperEntryStrategy: null,
    });
    const built = buildMlDataset([row('win', [[1_000, 1.4, 0.99, 1.3, 1, 20_000]]), row('loss', [[1_000, 1.01, 0.7, 0.75, 1, 20_000]]), row('nopath', null)], {
      version: 'TEST', featureVersion: ML_COMMUNITY_FEATURE_VERSION, labelVersion: 'ML-LABELS-v1', target: 'simExitNetPositive', snapshotKind: 'AGE_30S', minDataQuality: 50,
    });
    expect(built.rows).toBe(2);
    expect(built.manifest.positives).toBe(1);
    expect(built.manifest.excluded).toMatchObject({ NO_OUTCOME_PATH: 1 });
  });
});
