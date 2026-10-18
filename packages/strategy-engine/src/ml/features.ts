/**
 * ML feature schema + immutable feature snapshot builder (ML-FEATURES-v1).
 *
 * Single source of truth for feature semantics: the schema below is exported as JSON for the Python trainer
 * (ml/schema/features-v1.json) and the same column specs drive inference here, so training and serving use one
 * definition (train/serve consistency).
 *
 * Leakage rules:
 *  - every input series is cut at `snapshotAt` (observations with takenAt > snapshotAt are ignored);
 *  - every feature group records the time its data was observed (the real time, never back-dated);
 *  - CRITICAL groups (MARKET, SECURITY, RISK, AGE): observedAt > snapshotAt marks the snapshot INVALID_FOR_TRAINING
 *    (FUTURE_DATA_<group>; never silently fixed, and an ML PAPER decision refuses it);
 *  - OPTIONAL groups (SOCIAL): data that arrives after snapshotAt is EXCLUDED - all of its features are null, exactly as
 *    when it is not available - and listed in `lateDataExcluded`. That is not leakage: nothing of it is used. The
 *    ML-FEATURES-v1 meaning ("observed at or before snapshotAt, otherwise null") is unchanged;
 *  - outcome data never enters this module.
 *
 * Missing data stays null (never 0, never 50). Booleans are true / false / null (null = unknown).
 */
import {
  computeLaunchFeatures, computeLaunchScores, CRITICAL_TOKEN_EXTENSIONS, DEFAULT_NEW_LAUNCH_SETTINGS,
  type LaunchObservation, type LaunchSecurity, type LaunchState,
} from '../launch/index.js';
import type { SocialSnapshotResult } from '../social/index.js';

export const ML_FEATURE_VERSION = 'ML-FEATURES-v1';
/** Feature groups whose late data is excluded (null) instead of invalidating the snapshot. Critical groups are never here. */
export const ML_OPTIONAL_LATE_GROUPS: ReadonlyArray<string> = ['SOCIAL', 'COMMUNITY'];

export type MlFeatureType = 'number' | 'boolean' | 'category';
export type MlFeatureGroup = 'AGE' | 'MARKET' | 'STRUCTURE' | 'SECURITY' | 'RISK' | 'LAUNCH' | 'SOCIAL' | 'SOURCE' | 'COMMUNITY';

export interface MlFeatureSpec {
  name: string;
  group: MlFeatureGroup;
  type: MlFeatureType;
  description: string;
  /** Preprocessing applied identically in training and inference. */
  transform?: 'log1p' | 'signed_log1p';
  /** Allowed values of a category (one-hot encoded; unknown values -> all zeros + missing flag). */
  values?: string[];
}

/** ML-FEATURES-v1. Do not change the meaning of an entry; add a new version instead. */
export const ML_FEATURE_SCHEMA: MlFeatureSpec[] = [
  { name: 'source', group: 'SOURCE', type: 'category', values: ['PUMP_FUN', 'RAYDIUM', 'METEORA'], description: 'Discovery source' },
  { name: 'observationAgeSeconds', group: 'AGE', type: 'number', description: 'snapshotAt - detectedAt (s)' },
  { name: 'tokenAgeSeconds', group: 'AGE', type: 'number', description: 'snapshotAt - on-chain createdAt (s); null if createdAt unknown' },
  { name: 'tradableAgeSeconds', group: 'AGE', type: 'number', description: 'snapshotAt - first trade (s); null before the first trade' },
  { name: 'liquidityUsd', group: 'MARKET', type: 'number', transform: 'log1p', description: 'Liquidity (bonding curve: 2 x real SOL reserve in USD)' },
  { name: 'priceChangeSinceDetectionPct', group: 'MARKET', type: 'number', transform: 'signed_log1p', description: 'Price change since the first observation (%)' },
  { name: 'volumeUsd', group: 'MARKET', type: 'number', transform: 'log1p', description: 'Cumulative traded volume since detection (USD)' },
  { name: 'volume10sUsd', group: 'MARKET', type: 'number', transform: 'log1p', description: 'Volume in the last 10 s (null if not covered)' },
  { name: 'volume30sUsd', group: 'MARKET', type: 'number', transform: 'log1p', description: 'Volume in the last 30 s (null if not covered)' },
  { name: 'volume1mUsd', group: 'MARKET', type: 'number', transform: 'log1p', description: 'Volume in the last 60 s (null if not covered)' },
  { name: 'buyVolumeUsd', group: 'MARKET', type: 'number', transform: 'log1p', description: 'Cumulative buy volume (USD)' },
  { name: 'sellVolumeUsd', group: 'MARKET', type: 'number', transform: 'log1p', description: 'Cumulative sell volume (USD)' },
  { name: 'buyCount', group: 'MARKET', type: 'number', transform: 'log1p', description: 'Cumulative buys' },
  { name: 'sellCount', group: 'MARKET', type: 'number', transform: 'log1p', description: 'Cumulative sells' },
  { name: 'buySellRatio', group: 'MARKET', type: 'number', transform: 'log1p', description: 'Buy count / sell count' },
  { name: 'buySellVolumeRatio', group: 'MARKET', type: 'number', transform: 'log1p', description: 'Buy volume / sell volume' },
  { name: 'transactionRate', group: 'MARKET', type: 'number', transform: 'log1p', description: 'Transactions per second since detection' },
  { name: 'uniqueBuyers', group: 'MARKET', type: 'number', transform: 'log1p', description: 'Distinct buying wallets' },
  { name: 'uniqueSellers', group: 'MARKET', type: 'number', transform: 'log1p', description: 'Distinct selling wallets' },
  { name: 'uniqueBuyerGrowthPct', group: 'MARKET', type: 'number', transform: 'signed_log1p', description: 'Unique buyer growth over the observation (%)' },
  { name: 'priceVelocityPctPerMin', group: 'MARKET', type: 'number', transform: 'signed_log1p', description: 'Price change per minute (%)' },
  { name: 'volumeVelocityUsdPerMin', group: 'MARKET', type: 'number', transform: 'log1p', description: 'Volume per minute (USD)' },
  { name: 'transactionAcceleration', group: 'MARKET', type: 'number', transform: 'log1p', description: 'Recent-half / first-half transactions (> 1 accelerating)' },
  { name: 'buyVolumeAcceleration', group: 'MARKET', type: 'number', transform: 'log1p', description: 'Recent-half / first-half buy volume' },
  { name: 'liquidityChangePct', group: 'MARKET', type: 'number', transform: 'signed_log1p', description: 'Liquidity change since detection (%)' },
  { name: 'volatilityPct', group: 'MARKET', type: 'number', transform: 'log1p', description: 'Launch volatility (%)' },
  { name: 'drawdownFromHighPct', group: 'MARKET', type: 'number', description: 'Drawdown from the launch high (%, <= 0)' },
  { name: 'recentSellShare', group: 'MARKET', type: 'number', description: 'Sell share of recent transactions (0-1)' },
  { name: 'estimatedBuyImpactPct', group: 'STRUCTURE', type: 'number', transform: 'log1p', description: 'Price impact of the 20 USD reference order (%)' },
  { name: 'largestBuyerShare', group: 'STRUCTURE', type: 'number', description: 'Largest buyer share of buy volume (0-1)' },
  { name: 'buysPerBuyer', group: 'STRUCTURE', type: 'number', transform: 'log1p', description: 'Buys per distinct buyer' },
  { name: 'creatorSoldRatio', group: 'STRUCTURE', type: 'number', description: 'Creator sold / bought tokens (observed in the trade stream)' },
  { name: 'largestHolderSupplyShare', group: 'STRUCTURE', type: 'number', description: 'Largest observed wallet holding / total supply (trade stream, not on-chain holders)' },
  { name: 'creatorHoldingShare', group: 'STRUCTURE', type: 'number', description: 'Creator net holding / total supply (dev allocation, observed)' },
  { name: 'mintAuthorityRevoked', group: 'SECURITY', type: 'boolean', description: 'Mint authority revoked (null = unknown)' },
  { name: 'freezeAuthorityRevoked', group: 'SECURITY', type: 'boolean', description: 'Freeze authority revoked (null = unknown)' },
  { name: 'tokenProgram2022', group: 'SECURITY', type: 'boolean', description: 'Token-2022 program (null = unknown)' },
  { name: 'restrictedExtension', group: 'SECURITY', type: 'boolean', description: 'Has a transfer-restricting Token-2022 extension (null = unknown)' },
  { name: 'sellabilityVerified', group: 'SECURITY', type: 'boolean', description: 'Real sells observed from non-creator wallets' },
  { name: 'riskScore', group: 'RISK', type: 'number', description: 'Risk engine score at snapshot time (null = not assessed)' },
  { name: 'launchScore', group: 'LAUNCH', type: 'number', description: 'Launch Score (ML reference settings, not the per-user config)' },
  { name: 'launchMomentumScore', group: 'LAUNCH', type: 'number', description: 'Launch Momentum score' },
  { name: 'launchExhaustionScore', group: 'LAUNCH', type: 'number', description: 'Launch Exhaustion score' },
  { name: 'launchDataQuality', group: 'LAUNCH', type: 'number', description: 'Launch data quality (reference settings)' },
  { name: 'socialAvailable', group: 'SOCIAL', type: 'boolean', description: 'A social provider had usable data for this token' },
  { name: 'telegramMomentum', group: 'SOCIAL', type: 'number', description: 'Telegram Momentum (null = no Telegram data)' },
  { name: 'telegramQuality', group: 'SOCIAL', type: 'number', description: 'Telegram Quality' },
  { name: 'telegramSpam', group: 'SOCIAL', type: 'number', description: 'Telegram spam / coordination likelihood' },
  { name: 'telegramExhaustion', group: 'SOCIAL', type: 'number', description: 'Telegram exhaustion' },
  { name: 'telegramDataQuality', group: 'SOCIAL', type: 'number', description: 'Telegram data quality' },
  { name: 'telegramMessages1m', group: 'SOCIAL', type: 'number', transform: 'log1p', description: 'Telegram messages in the last minute' },
  { name: 'telegramMessages5m', group: 'SOCIAL', type: 'number', transform: 'log1p', description: 'Telegram messages in the last 5 minutes' },
  { name: 'telegramUniqueUsers5m', group: 'SOCIAL', type: 'number', transform: 'log1p', description: 'Telegram active users (5 min)' },
  { name: 'telegramUserGrowth1m', group: 'SOCIAL', type: 'number', description: 'Telegram active user growth (1 min)' },
  { name: 'telegramTop3Share', group: 'SOCIAL', type: 'number', description: 'Top-3 user share of Telegram messages' },
];

export type MlFeatureValue = number | boolean | string | null;
export type MlFeatures = Record<string, MlFeatureValue>;

export interface MlSnapshotInput {
  snapshotAt: number;
  source: string;
  detectedAt: number;
  createdAt: number | null;
  firstTradeAt: number | null;
  /** Launch state as known by the tracker (observations may extend past snapshotAt; they are cut here). */
  state: LaunchState | null;
  security: LaunchSecurity | null;
  /** When the security facts were read (null = never completed). */
  securityObservedAt: number | null;
  riskScore: number | null;
  riskObservedAt: number | null;
  social: SocialSnapshotResult | null;
  /** Price impact of the reference order (computed by the caller at snapshot time). */
  referenceImpactPct: number | null;
}

export interface MlFeatureSnapshotResult {
  featureVersion: string;
  snapshotAt: number;
  features: MlFeatures;
  /** Latest observation time per feature group (ms epoch, null = no data). */
  observedAt: Partial<Record<MlFeatureGroup, number | null>>;
  /** Share (0-100) of non-null features. */
  dataQuality: number;
  /** Optional groups whose data arrived after snapshotAt and was excluded (features null; real time kept in observedAt). */
  lateDataExcluded: MlFeatureGroup[];
  validForTraining: boolean;
  invalidReasons: string[];
  /** Last price at snapshot time (outcome reference; not a feature). */
  referencePriceUsd: number | null;
  referenceLiquidityUsd: number | null;
}

const finite = (value: number | null | undefined) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/** Volume over the trailing window, only if an observation at or before (snapshotAt - window) exists. */
function windowVolume(obs: LaunchObservation[], at: number, windowMs: number) {
  const last = obs[obs.length - 1];
  if (!last) return null;
  const start = [...obs].reverse().find((o) => o.takenAt <= at - windowMs);
  return start ? Math.max(0, last.volumeUsd - start.volumeUsd) : null;
}

/** Builds the immutable feature snapshot for one candidate at `snapshotAt` (pure, no I/O). */
export function buildMlFeatureSnapshot(input: MlSnapshotInput): MlFeatureSnapshotResult {
  const at = input.snapshotAt;
  const invalid: string[] = [];
  const observations = (input.state?.observations ?? []).filter((o) => o.takenAt <= at).sort((a, b) => a.takenAt - b.takenAt);
  const lastObservation = observations[observations.length - 1] ?? null;
  const state: LaunchState | null = input.state ? { ...input.state, observations } : null;
  const f = state && observations.length ? computeLaunchFeatures(state, at) : null;
  const security = input.security;
  const scores = f && security ? computeLaunchScores(f, security, { ...DEFAULT_NEW_LAUNCH_SETTINGS, enabled: true }) : null;
  const social = input.social && input.social.at <= at ? input.social : null;
  const telegram = social?.perSource.TELEGRAM ?? null;
  const extensions = security?.extensions ?? null;

  const features: MlFeatures = {
    source: input.source,
    observationAgeSeconds: Math.max(0, (at - input.detectedAt) / 1000),
    tokenAgeSeconds: input.createdAt !== null ? Math.max(0, (at - input.createdAt) / 1000) : null,
    tradableAgeSeconds: input.firstTradeAt !== null && input.firstTradeAt <= at ? (at - input.firstTradeAt) / 1000 : null,
    liquidityUsd: finite(f?.liquidityUsd),
    priceChangeSinceDetectionPct: finite(f?.priceChangeSinceDetection),
    volumeUsd: f ? finite(f.volumeUsd) : null,
    volume10sUsd: windowVolume(observations, at, 10_000),
    volume30sUsd: windowVolume(observations, at, 30_000),
    volume1mUsd: windowVolume(observations, at, 60_000),
    buyVolumeUsd: finite(lastObservation?.buyVolumeUsd),
    sellVolumeUsd: finite(lastObservation?.sellVolumeUsd),
    buyCount: lastObservation ? lastObservation.buyCount : null,
    sellCount: lastObservation ? lastObservation.sellCount : null,
    buySellRatio: finite(f?.buySellRatio),
    buySellVolumeRatio: finite(f?.buyVolumeSellVolumeRatio),
    transactionRate: finite(f?.transactionRate),
    uniqueBuyers: finite(f?.uniqueBuyers),
    uniqueSellers: finite(f?.uniqueSellers),
    uniqueBuyerGrowthPct: finite(f?.uniqueBuyerGrowth),
    priceVelocityPctPerMin: finite(f?.priceVelocity),
    volumeVelocityUsdPerMin: finite(f?.volumeVelocity),
    transactionAcceleration: finite(f?.transactionAcceleration),
    buyVolumeAcceleration: finite(f?.buyVolumeAcceleration),
    liquidityChangePct: finite(f?.liquidityChange),
    volatilityPct: finite(f?.launchVolatility),
    drawdownFromHighPct: finite(f?.drawdownFromLaunchHigh),
    recentSellShare: finite(f?.recentSellShare),
    estimatedBuyImpactPct: finite(input.referenceImpactPct),
    largestBuyerShare: finite(f?.largestBuyerShare),
    buysPerBuyer: finite(f?.buysPerBuyer),
    creatorSoldRatio: finite(f?.creatorSoldRatio),
    largestHolderSupplyShare: finite(f?.largestHolderSupplyShare),
    creatorHoldingShare: finite(input.state?.creatorHoldingShare ?? null),
    mintAuthorityRevoked: security?.mintAuthorityRevoked ?? null,
    freezeAuthorityRevoked: security?.freezeAuthorityRevoked ?? null,
    tokenProgram2022: security?.tokenProgram ? security.tokenProgram === 'spl-token-2022' : null,
    restrictedExtension: extensions ? extensions.some((name) => CRITICAL_TOKEN_EXTENSIONS.includes(name)) : null,
    sellabilityVerified: security ? security.sellability === 'VERIFIED' : null,
    riskScore: input.riskObservedAt !== null && input.riskObservedAt <= at ? finite(input.riskScore) : null,
    launchScore: finite(scores?.score),
    launchMomentumScore: finite(scores?.launchMomentumScore),
    launchExhaustionScore: finite(scores?.exhaustionScore),
    launchDataQuality: finite(scores?.dataQuality),
    socialAvailable: social ? social.dataQuality !== null : null,
    telegramMomentum: finite(telegram?.momentum),
    telegramQuality: finite(telegram?.quality),
    telegramSpam: finite(telegram?.spam),
    telegramExhaustion: finite(telegram?.exhaustion),
    telegramDataQuality: finite(telegram?.dataQuality),
    telegramMessages1m: finite(telegram?.messages['1m']),
    telegramMessages5m: finite(telegram?.messages['5m']),
    telegramUniqueUsers5m: finite(telegram?.uniqueActiveUsers['5m']),
    telegramUserGrowth1m: finite(telegram?.uniqueUserGrowth1m),
    telegramTop3Share: finite(telegram?.top3UserShare),
  };

  // ---- Leakage assertions: every group must have been observed at or before snapshotAt ----
  const observedAt: MlFeatureSnapshotResult['observedAt'] = {
    MARKET: lastObservation?.takenAt ?? null,
    SECURITY: input.securityObservedAt,
    RISK: input.riskObservedAt,
    SOCIAL: input.social?.at ?? null,
    AGE: at,
  };
  const lateDataExcluded: MlFeatureGroup[] = [];
  for (const [group, time] of Object.entries(observedAt) as Array<[MlFeatureGroup, number | null | undefined]>) {
    if (time === null || time === undefined || time <= at) continue;
    if (ML_OPTIONAL_LATE_GROUPS.includes(group)) lateDataExcluded.push(group);
    else invalid.push(`FUTURE_DATA_${group}`);
  }
  // Defence in depth: an excluded optional group must not contribute a single value.
  for (const group of lateDataExcluded) {
    for (const spec of ML_FEATURE_SCHEMA) if (spec.group === group && features[spec.name] !== null) invalid.push(`LATE_DATA_NOT_EXCLUDED_${spec.name}`);
  }
  if (input.securityObservedAt !== null && input.securityObservedAt > at) {
    // Security read after the snapshot: the values above must not be used either.
    for (const name of ['mintAuthorityRevoked', 'freezeAuthorityRevoked', 'tokenProgram2022', 'restrictedExtension']) features[name] = null;
  }
  for (const spec of ML_FEATURE_SCHEMA) if (!(spec.name in features)) invalid.push(`MISSING_DEFINITION_${spec.name}`);
  if (!lastObservation || finite(lastObservation.priceUsd) === null) invalid.push('NO_PRICE_AT_SNAPSHOT');

  const numeric = ML_FEATURE_SCHEMA.filter((spec) => spec.group !== 'SOCIAL' && spec.group !== 'SOURCE');
  const present = numeric.filter((spec) => features[spec.name] !== null && features[spec.name] !== undefined).length;
  return {
    featureVersion: ML_FEATURE_VERSION,
    snapshotAt: at,
    features,
    observedAt,
    dataQuality: Math.round(100 * present / numeric.length),
    lateDataExcluded,
    validForTraining: invalid.length === 0,
    invalidReasons: invalid,
    referencePriceUsd: finite(lastObservation?.priceUsd ?? null),
    referenceLiquidityUsd: finite(lastObservation?.liquidityUsd ?? null),
  };
}

/** JSON export of the schema for the Python trainer (written by `pnpm ml:schema`). */
export function mlFeatureSchemaJson() {
  return { featureVersion: ML_FEATURE_VERSION, features: ML_FEATURE_SCHEMA };
}
