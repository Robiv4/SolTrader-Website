/**
 * ML-FEATURES-COMMUNITY-v1 = every ML-FEATURES-v1 feature (same names, same meaning, same values) + the COMMUNITY group.
 *
 * A separate feature version, so models trained on ML-FEATURES-v1 (e.g. ML-LGBM-NL-DATASET-v3-s42) keep receiving exactly
 * their own inputs. The COMMUNITY group is an OPTIONAL late group: community data received after `snapshotAt` is
 * EXCLUDED (all community features null) and recorded in `lateDataExcluded` - never back-dated into an earlier snapshot.
 */
import type { CommunitySnapshotResult } from '../community/index.js';

import { buildMlFeatureSnapshot, ML_FEATURE_SCHEMA, ML_FEATURE_VERSION, type MlFeatureSnapshotResult, type MlFeatureSpec, type MlSnapshotInput } from './features.js';

export const ML_COMMUNITY_FEATURE_VERSION = 'ML-FEATURES-COMMUNITY-v1';

/** COMMUNITY group (definitions; null = unknown, never 0). */
export const ML_COMMUNITY_FEATURE_SPECS: MlFeatureSpec[] = [
  { name: 'communityScore', group: 'COMMUNITY', type: 'number', description: 'Community Score 0-100 (null = too little data; see COMMUNITY_SCORE_WEIGHTS)' },
  { name: 'communityDataQuality', group: 'COMMUNITY', type: 'number', description: 'Share of enabled community sources with usable data (0-100)' },
  { name: 'communityCoverage', group: 'COMMUNITY', type: 'number', description: 'Enabled community sources with data / enabled sources (0-1)' },
  { name: 'communityDataAgeSeconds', group: 'COMMUNITY', type: 'number', transform: 'log1p', description: 'Age of the freshest used community data at snapshot time (s)' },
  { name: 'socialMomentum', group: 'COMMUNITY', type: 'number', description: 'Social Intelligence momentum (Telegram / X)' },
  { name: 'socialSpamScore', group: 'COMMUNITY', type: 'number', description: 'Social spam / coordination score' },
  { name: 'mentions5m', group: 'COMMUNITY', type: 'number', transform: 'log1p', description: 'Attributed social mentions in the last 5 minutes' },
  { name: 'uniqueAuthors5m', group: 'COMMUNITY', type: 'number', transform: 'log1p', description: 'Distinct social authors in the last 5 minutes' },
  { name: 'communityGrowth', group: 'COMMUNITY', type: 'number', transform: 'log1p', description: 'Mention rate last minute vs 5-minute average (1 = flat)' },
  { name: 'telegramConversationRatio', group: 'COMMUNITY', type: 'number', description: 'Unique authors / messages (5 min): broad conversation vs few posters' },
  { name: 'telegramForwardedShare', group: 'COMMUNITY', type: 'number', description: 'Share of forwarded messages (5 min)' },
  { name: 'telegramReplyShare', group: 'COMMUNITY', type: 'number', description: 'Share of reply messages (5 min): real conversation' },
  { name: 'organicInterestScore', group: 'COMMUNITY', type: 'number', description: 'Organic interest 0-100 (author / buyer diversity, conversation, low repetition)' },
  { name: 'dexProfilePresent', group: 'COMMUNITY', type: 'boolean', description: 'DEX Screener token profile / info block present' },
  { name: 'dexWebsitePresent', group: 'COMMUNITY', type: 'boolean', description: 'Website listed on DEX Screener' },
  { name: 'dexSocialLinkCount', group: 'COMMUNITY', type: 'number', description: 'Social links listed on DEX Screener' },
  { name: 'dexActiveBoosts', group: 'COMMUNITY', type: 'number', transform: 'log1p', description: 'Active DEX Screener boosts of the pair' },
  { name: 'paidPromotionSignal', group: 'COMMUNITY', type: 'boolean', description: 'Paid DEX Screener promotion (order / boost) paid at or before the snapshot' },
  { name: 'onchainBuyers5m', group: 'COMMUNITY', type: 'number', transform: 'log1p', description: 'Distinct buying wallets in the last 5 minutes (wallets, not people)' },
  { name: 'buyerWalletGrowth', group: 'COMMUNITY', type: 'number', transform: 'signed_log1p', description: 'Buying wallets last minute vs the minute before (%)' },
  { name: 'buyerConcentration', group: 'COMMUNITY', type: 'number', description: 'Herfindahl index of buy volume (5 min, 0-1)' },
  { name: 'top3BuyerShare', group: 'COMMUNITY', type: 'number', description: 'Top-3 wallet share of buy volume (5 min)' },
  { name: 'largeSells5m', group: 'COMMUNITY', type: 'number', transform: 'log1p', description: 'Sells >= 500 USD in the last 5 minutes' },
  { name: 'repeatedAmountShare', group: 'COMMUNITY', type: 'number', description: 'Share of buys repeating another wallet\'s exact USD amount (bot pattern)' },
  { name: 'socialOnchainDivergence', group: 'COMMUNITY', type: 'number', description: 'Social momentum minus on-chain buyer momentum (-1..1; > 0 hype ahead of buyers)' },
  { name: 'lunarGalaxyScore', group: 'COMMUNITY', type: 'number', description: 'LunarCrush Galaxy Score (only when tied to this mint)' },
  { name: 'lunarSentiment', group: 'COMMUNITY', type: 'number', description: 'LunarCrush sentiment (only when tied to this mint)' },
  { name: 'lunarSocialVolume', group: 'COMMUNITY', type: 'number', transform: 'log1p', description: 'LunarCrush social volume (only when tied to this mint)' },
];

export const ML_COMMUNITY_FEATURE_SCHEMA: MlFeatureSpec[] = [...ML_FEATURE_SCHEMA, ...ML_COMMUNITY_FEATURE_SPECS];

/** Supported feature versions -> schema (single registry for training, validation and inference). */
export const ML_FEATURE_SCHEMAS: Record<string, MlFeatureSpec[]> = {
  [ML_FEATURE_VERSION]: ML_FEATURE_SCHEMA,
  [ML_COMMUNITY_FEATURE_VERSION]: ML_COMMUNITY_FEATURE_SCHEMA,
};

export function featureSchemaFor(featureVersion: string): MlFeatureSpec[] {
  const schema = ML_FEATURE_SCHEMAS[featureVersion];
  if (!schema) throw new Error(`Unknown feature version ${featureVersion}`);
  return schema;
}

export function isSupportedFeatureVersion(featureVersion: string) {
  return featureVersion in ML_FEATURE_SCHEMAS;
}

/**
 * Community feature snapshot at `snapshotAt`: the v1 snapshot (unchanged builder) + the COMMUNITY group from a community
 * snapshot computed at or before `snapshotAt`. A later community snapshot is excluded (features null, COMMUNITY listed
 * in lateDataExcluded; its real time kept in observedAt).
 */
export function buildCommunityFeatureSnapshot(input: MlSnapshotInput & { community: CommunitySnapshotResult | null }): MlFeatureSnapshotResult {
  const base = buildMlFeatureSnapshot(input);
  const at = input.snapshotAt;
  const community = input.community && input.community.at <= at ? input.community : null;
  const features = { ...base.features };
  for (const spec of ML_COMMUNITY_FEATURE_SPECS) {
    const value = community ? (community.features as unknown as Record<string, number | boolean | null>)[spec.name] : null;
    features[spec.name] = value === undefined ? null : value;
  }
  const lateDataExcluded = [...base.lateDataExcluded];
  if (input.community && input.community.at > at) lateDataExcluded.push('COMMUNITY');
  const invalid = [...base.invalidReasons];
  // Defence in depth: an excluded community snapshot must not leave a single value behind.
  if (lateDataExcluded.includes('COMMUNITY')) for (const spec of ML_COMMUNITY_FEATURE_SPECS) if (features[spec.name] !== null) invalid.push(`LATE_DATA_NOT_EXCLUDED_${spec.name}`);
  if (community && community.lateExcluded.length === 0 && Object.values(community.sources).some((source) => source.receivedAt !== null && source.receivedAt > at && (source.status === 'OK' || source.status === 'WEAK'))) invalid.push('FUTURE_DATA_COMMUNITY');
  return {
    ...base,
    featureVersion: ML_COMMUNITY_FEATURE_VERSION,
    features,
    observedAt: { ...base.observedAt, COMMUNITY: input.community?.at ?? null },
    lateDataExcluded,
    validForTraining: invalid.length === 0,
    invalidReasons: invalid,
  };
}

/** JSON export of the community schema for the Python trainer (ml/schema/features-community-v1.json). */
export function mlCommunityFeatureSchemaJson() {
  return { featureVersion: ML_COMMUNITY_FEATURE_VERSION, features: ML_COMMUNITY_FEATURE_SCHEMA };
}
