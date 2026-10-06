import { normalizeQualityGate, type QualityGateSettings } from './quality-gate.js';

/**
 * New Launch / Sniper: pure feature calculation, scoring and decision policy for very young tokens.
 * Everything here works on real observations; unknown inputs stay null (never treated as safe or positive).
 */

/** Aggregated launch activity at one point in time (cumulative since detection). */
export interface LaunchObservation {
  takenAt: number;
  priceUsd: number | null;
  liquidityUsd: number | null;
  buyCount: number;
  sellCount: number;
  /** Total traded volume (USD). */
  volumeUsd: number;
  /** Buy/sell split of the volume; null when the source only reports the total. */
  buyVolumeUsd: number | null;
  sellVolumeUsd: number | null;
  /** Distinct buying wallets (null when the source cannot tell wallets apart). */
  uniqueBuyers: number | null;
  uniqueSellers: number | null;
}

export interface LaunchState {
  mint: string;
  detectedAt: number;
  /** On-chain creation time when known. */
  createdAt: number | null;
  observations: LaunchObservation[];
  /** Share (0-1) of total buy volume from the single largest buyer; null = unknown. */
  largestBuyerShare: number | null;
  /** Average buy transactions per distinct buyer; null = unknown. */
  buysPerBuyer: number | null;
  /** Creator's sold / bought token ratio (0-1+); null = unknown. */
  creatorSoldRatio: number | null;
  /** Largest single wallet's share of total supply bought so far (0-1); null = unknown. */
  largestHolderSupplyShare: number | null;
  /** Estimated price impact (%) of the actual intended order size; null = unknown. */
  priceImpactPercent: number | null;
  /** Distinct wallets (excluding the creator) with at least one successful sell. */
  observedSellers: number | null;
  /** Creator's net token holdings as a share of total supply (dev allocation); null = unknown. */
  creatorHoldingShare?: number | null;
}

export interface LaunchFeatures {
  ageSeconds: number;
  observedSeconds: number;
  snapshotCount: number;
  priceUsd: number | null;
  liquidityUsd: number | null;
  priceChangeSinceDetection: number | null;
  priceVelocity: number | null;
  volumeUsd: number;
  volumeVelocity: number | null;
  buyCountVelocity: number | null;
  sellCountVelocity: number | null;
  transactionCount: number;
  transactionRate: number | null;
  buySellRatio: number | null;
  buyVolumeSellVolumeRatio: number | null;
  liquidityChange: number | null;
  uniqueBuyers: number | null;
  uniqueSellers: number | null;
  uniqueBuyerGrowth: number | null;
  estimatedPriceImpact: number | null;
  launchHigh: number | null;
  drawdownFromLaunchHigh: number | null;
  distanceFromLaunchHigh: number | null;
  launchVolatility: number | null;
  /** Recent-half vs first-half activity ratios (> 1 = accelerating). */
  transactionAcceleration: number | null;
  buyVolumeAcceleration: number | null;
  recentSellShare: number | null;
  earlySellShare: number | null;
  largestBuyerShare: number | null;
  buysPerBuyer: number | null;
  creatorSoldRatio: number | null;
  largestHolderSupplyShare: number | null;
  observedSellers: number | null;
}

function ratio(a: number, b: number) {
  return b > 0 ? a / b : a > 0 ? Math.min(99, a) : null;
}

function pct(current: number | null, previous: number | null) {
  return current !== null && previous !== null && previous > 0 ? (current / previous - 1) * 100 : null;
}

/** LaunchFeatureEngine: derives launch features from the observation series (oldest first). */
export function computeLaunchFeatures(state: LaunchState, now: number): LaunchFeatures {
  const obs = [...state.observations].filter((o) => o.takenAt <= now).sort((a, b) => a.takenAt - b.takenAt);
  const first = obs[0] ?? null;
  const last = obs.at(-1) ?? null;
  const start = state.createdAt ?? state.detectedAt;
  const observedSeconds = first && last ? (last.takenAt - first.takenAt) / 1000 : 0;
  const prices = obs.map((o) => o.priceUsd).filter((p): p is number => p !== null && p > 0);
  const launchHigh = prices.length ? Math.max(...prices) : null;
  const price = last?.priceUsd ?? null;
  const mid = obs.length >= 3 ? obs[Math.floor(obs.length / 2)] : null;
  const half = (from: LaunchObservation | null, to: LaunchObservation | null) => (from && to && to.takenAt > from.takenAt ? { dt: (to.takenAt - from.takenAt) / 1000, tx: (to.buyCount + to.sellCount) - (from.buyCount + from.sellCount), buyVol: to.buyVolumeUsd !== null && from.buyVolumeUsd !== null ? to.buyVolumeUsd - from.buyVolumeUsd : undefined, sells: to.sellCount - from.sellCount, buys: to.buyCount - from.buyCount } : null);
  const early = half(first, mid);
  const recent = half(mid, last);
  const perSecond = (value: number | undefined, dt: number | undefined) => (value !== undefined && dt && dt > 0 ? value / dt : null);
  const accel = (a: number | null, b: number | null) => (a !== null && b !== null ? (a > 0 ? b / a : b > 0 ? 3 : 1) : null);
  const returns: number[] = [];
  for (let i = 1; i < prices.length; i += 1) returns.push(prices[i] / prices[i - 1] - 1);
  const mean = returns.length ? returns.reduce((s, r) => s + r, 0) / returns.length : 0;
  const volatility = returns.length >= 2 ? Math.sqrt(returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length) * 100 : null;
  const txTotal = last ? last.buyCount + last.sellCount : 0;
  const buyersGrowth = first && last && first.uniqueBuyers !== null && last.uniqueBuyers !== null && observedSeconds > 0 ? (last.uniqueBuyers - first.uniqueBuyers) / observedSeconds : null;
  const share = (h: ReturnType<typeof half>) => (h && h.buys + h.sells > 0 ? h.sells / (h.buys + h.sells) : null);
  return {
    ageSeconds: Math.max(0, (now - start) / 1000),
    observedSeconds,
    snapshotCount: obs.length,
    priceUsd: price,
    liquidityUsd: last?.liquidityUsd ?? null,
    priceChangeSinceDetection: pct(price, first?.priceUsd ?? null),
    priceVelocity: observedSeconds > 0 ? (pct(price, first?.priceUsd ?? null) ?? 0) / observedSeconds : null,
    volumeUsd: last ? last.volumeUsd : 0,
    volumeVelocity: first && last && observedSeconds > 0 ? (last.volumeUsd - first.volumeUsd) / observedSeconds : null,
    buyCountVelocity: first && last && observedSeconds > 0 ? (last.buyCount - first.buyCount) / observedSeconds : null,
    sellCountVelocity: first && last && observedSeconds > 0 ? (last.sellCount - first.sellCount) / observedSeconds : null,
    transactionCount: txTotal,
    transactionRate: first && last && observedSeconds > 0 ? (txTotal - (first.buyCount + first.sellCount)) / observedSeconds : null,
    buySellRatio: last ? ratio(last.buyCount, last.sellCount) : null,
    buyVolumeSellVolumeRatio: last && last.buyVolumeUsd !== null && last.sellVolumeUsd !== null ? ratio(last.buyVolumeUsd, last.sellVolumeUsd) : null,
    liquidityChange: pct(last?.liquidityUsd ?? null, first?.liquidityUsd ?? null),
    uniqueBuyers: last?.uniqueBuyers ?? null,
    uniqueSellers: last?.uniqueSellers ?? null,
    uniqueBuyerGrowth: buyersGrowth,
    estimatedPriceImpact: state.priceImpactPercent,
    launchHigh,
    drawdownFromLaunchHigh: price !== null && launchHigh ? (price / launchHigh - 1) * 100 : null,
    distanceFromLaunchHigh: price !== null && launchHigh ? (1 - price / launchHigh) * 100 : null,
    launchVolatility: volatility,
    transactionAcceleration: accel(perSecond(early?.tx, early?.dt), perSecond(recent?.tx, recent?.dt)),
    buyVolumeAcceleration: accel(perSecond(early?.buyVol, early?.dt), perSecond(recent?.buyVol, recent?.dt)),
    recentSellShare: share(recent),
    earlySellShare: share(early),
    largestBuyerShare: state.largestBuyerShare,
    buysPerBuyer: state.buysPerBuyer,
    creatorSoldRatio: state.creatorSoldRatio,
    largestHolderSupplyShare: state.largestHolderSupplyShare,
    observedSellers: state.observedSellers,
  };
}

export interface NewLaunchSettings {
  enabled: boolean;
  minAgeSeconds: number;
  maxAgeSeconds: number;
  observationSeconds: number;
  cooldownSeconds: number;
  minTransactions: number;
  minUniqueBuyers: number;
  minBuySellRatio: number;
  minLaunchVolumeUsd: number;
  minScore: number;
  maxExhaustionScore: number;
  minLiquidityUsd: number;
  maxLiquidityUsd: number | null;
  maxPriceImpactPercent: number;
  liquidityOutflowWarningPercent: number;
  liquidityCriticalPercent: number;
  maxRiskScore: number;
  maxPositionPercent: number;
  maxConcurrentPositions: number;
  minObservedSellers: number;
  independentMode: boolean;
  useAiConfirmation: boolean;
  // --- NewLaunch-only exit strategy (independent of the Strategy / AI exit settings) ---
  stopLossPercent: number;
  takeProfitPercent: number;
  breakEvenEnabled: boolean;
  breakEvenActivationPercent: number;
  /** Break-even stop = entry fill * (1 + breakEvenCostBufferPercent / 100); 0.6 = the two PAPER fees. */
  breakEvenCostBufferPercent: number;
  trailingEnabled: boolean;
  trailingActivationPercent: number;
  trailingDistancePercent: number;
  /** Prepared only: tiered take-profit is not executed yet (see NewLaunchExitConfig.tieredTakeProfit). */
  tieredTakeProfitEnabled: boolean;
  maxHoldEnabled: boolean;
  maxHoldMinutes: number;
  liquiditySafetyExitEnabled: boolean;
  liquidityDropExitPercent: number;
  minimumRecommendationSampleSize: number;
  // --- Exit capacity / dynamic position sizing (execution quality, not token direction) ---
  /** Computes the exit capacity and the liquidity-aware recommended size for every NewLaunch entry. */
  dynamicPositionSizingEnabled: boolean;
  /** MONITOR_ONLY records the recommendation (size unchanged); ENFORCE_PAPER applies it (reduce / reject). */
  exitCapacityMode: 'MONITOR_ONLY' | 'ENFORCE_PAPER';
  maxEstimatedEntryImpactPct: number;
  maxEstimatedExitImpactPct: number;
  maxEstimatedRoundTripImpactPct: number;
  minExitCapacityScore: number;
  maxLiquidityUtilizationPct: number;
  minimumExecutablePosition: number;
  positionSizeStep: number;
  // --- Social Intelligence (deterministic, no AI required) ---
  socialIntelligenceEnabled: boolean;
  /** OFF | MONITOR_ONLY (default: observe + store what it would recommend) | ENFORCE_PAPER (AVOID can only remove an entry). */
  socialDecisionMode: 'OFF' | 'MONITOR_ONLY' | 'ENFORCE_PAPER';
  /** Optional AI social layer; never required, default off. */
  aiSocialAnalysisEnabled: boolean;
}

export const DEFAULT_NEW_LAUNCH_SETTINGS: NewLaunchSettings = {
  enabled: false,
  minAgeSeconds: 5,
  maxAgeSeconds: 90,
  observationSeconds: 10,
  cooldownSeconds: 60,
  minTransactions: 15,
  minUniqueBuyers: 10,
  minBuySellRatio: 1.5,
  minLaunchVolumeUsd: 2_000,
  minScore: 70,
  maxExhaustionScore: 70,
  minLiquidityUsd: 10_000,
  maxLiquidityUsd: null,
  maxPriceImpactPercent: 3,
  liquidityOutflowWarningPercent: 25,
  liquidityCriticalPercent: 50,
  maxRiskScore: 80,
  maxPositionPercent: 1,
  maxConcurrentPositions: 2,
  minObservedSellers: 1,
  independentMode: true,
  useAiConfirmation: false,
  // Experimental PAPER defaults; not claimed to be optimal.
  stopLossPercent: 20,
  takeProfitPercent: 25,
  breakEvenEnabled: true,
  breakEvenActivationPercent: 10,
  breakEvenCostBufferPercent: 0.6,
  trailingEnabled: true,
  trailingActivationPercent: 15,
  trailingDistancePercent: 8,
  tieredTakeProfitEnabled: false,
  maxHoldEnabled: false,
  maxHoldMinutes: 30,
  liquiditySafetyExitEnabled: true,
  liquidityDropExitPercent: 50,
  minimumRecommendationSampleSize: 50,
  dynamicPositionSizingEnabled: true,
  exitCapacityMode: 'MONITOR_ONLY',
  maxEstimatedEntryImpactPct: 3,
  maxEstimatedExitImpactPct: 3,
  maxEstimatedRoundTripImpactPct: 6,
  minExitCapacityScore: 50,
  maxLiquidityUtilizationPct: 5,
  minimumExecutablePosition: 5,
  positionSizeStep: 1,
  socialIntelligenceEnabled: true,
  socialDecisionMode: 'MONITOR_ONLY',
  aiSocialAnalysisEnabled: false,
};

/** Effective exit configuration of a NewLaunch position; snapshotted at entry and never rewritten. */
export interface NewLaunchExitConfig {
  stopLossPercent: number;
  takeProfitPercent: number;
  breakEvenEnabled: boolean;
  breakEvenActivationPercent: number | null;
  /** Break-even stop formula: entryFill * (1 + breakEvenCostBufferPercent / 100). */
  breakEvenCostBufferPercent: number | null;
  trailingEnabled: boolean;
  trailingActivationPercent: number | null;
  trailingDistancePercent: number | null;
  tieredTakeProfitEnabled: boolean;
  maxHoldEnabled: boolean;
  maxHoldMinutes: number | null;
  liquiditySafetyEnabled: boolean;
  liquidityDropExitPercent: number | null;
}

export function newLaunchExitConfig(settings: NewLaunchSettings): NewLaunchExitConfig {
  return {
    stopLossPercent: settings.stopLossPercent,
    takeProfitPercent: settings.takeProfitPercent,
    breakEvenEnabled: settings.breakEvenEnabled,
    breakEvenActivationPercent: settings.breakEvenEnabled ? settings.breakEvenActivationPercent : null,
    breakEvenCostBufferPercent: settings.breakEvenEnabled ? settings.breakEvenCostBufferPercent : null,
    trailingEnabled: settings.trailingEnabled,
    // Trailing never arms from entry unless explicitly configured with activation 0.
    trailingActivationPercent: settings.trailingEnabled ? settings.trailingActivationPercent : null,
    trailingDistancePercent: settings.trailingEnabled ? settings.trailingDistancePercent : null,
    tieredTakeProfitEnabled: settings.tieredTakeProfitEnabled,
    maxHoldEnabled: settings.maxHoldEnabled,
    maxHoldMinutes: settings.maxHoldEnabled ? settings.maxHoldMinutes : null,
    liquiditySafetyEnabled: settings.liquiditySafetyExitEnabled,
    liquidityDropExitPercent: settings.liquiditySafetyExitEnabled ? settings.liquidityDropExitPercent : null,
  };
}

/**
 * Exit capacity settings. They define a configuration only once enforced: in MONITOR_ONLY nothing about the trades
 * changes, so the thresholds are excluded from the version fingerprint (switching to ENFORCE_PAPER creates a new version).
 */
export function newLaunchCapacityConfig(settings: NewLaunchSettings) {
  return {
    dynamicPositionSizingEnabled: settings.dynamicPositionSizingEnabled,
    exitCapacityMode: settings.exitCapacityMode,
    maxEstimatedEntryImpactPct: settings.maxEstimatedEntryImpactPct,
    maxEstimatedExitImpactPct: settings.maxEstimatedExitImpactPct,
    maxEstimatedRoundTripImpactPct: settings.maxEstimatedRoundTripImpactPct,
    minExitCapacityScore: settings.minExitCapacityScore,
    maxLiquidityUtilizationPct: settings.maxLiquidityUtilizationPct,
    minimumExecutablePosition: settings.minimumExecutablePosition,
    positionSizeStep: settings.positionSizeStep,
  };
}

/** Entry-side settings that define a NewLaunch configuration version (exit settings are versioned separately). */
export const NEW_LAUNCH_ENTRY_KEYS = ['minAgeSeconds', 'maxAgeSeconds', 'observationSeconds', 'cooldownSeconds', 'minTransactions', 'minUniqueBuyers', 'minBuySellRatio', 'minLaunchVolumeUsd', 'minScore', 'maxExhaustionScore', 'minLiquidityUsd', 'maxLiquidityUsd', 'maxPriceImpactPercent', 'liquidityOutflowWarningPercent', 'liquidityCriticalPercent', 'maxRiskScore', 'maxPositionPercent', 'maxConcurrentPositions', 'minObservedSellers'] as const;

export function newLaunchEntryConfig(settings: NewLaunchSettings) {
  return Object.fromEntries(NEW_LAUNCH_ENTRY_KEYS.map((key) => [key, settings[key]])) as Pick<NewLaunchSettings, (typeof NEW_LAUNCH_ENTRY_KEYS)[number]>;
}

export type SellabilityState = 'VERIFIED' | 'NOT_VERIFIED' | 'FAILED';

/** Security facts of the token; null/UNKNOWN is never treated as safe. */
export interface LaunchSecurity {
  sellability: SellabilityState;
  mintAuthorityRevoked: boolean | null;
  freezeAuthorityRevoked: boolean | null;
  tokenProgram: 'spl-token' | 'spl-token-2022' | null;
  /** Token-2022 extensions present on the mint. */
  extensions: string[] | null;
  hardBlockReasons: string[];
  warnings: string[];
  /** The last security lookup failed on every RPC provider (infrastructure block, not a strategy rejection). */
  rpcUnavailable?: boolean;
}

/** Token-2022 extensions that can restrict or tax transfers: automatic entry is blocked. */
export const CRITICAL_TOKEN_EXTENSIONS = ['transferHook', 'permanentDelegate', 'nonTransferable', 'defaultAccountState', 'pausable', 'confidentialTransferMint'];

export function evaluateLaunchSecurityBlocks(security: LaunchSecurity) {
  const blocks = [...security.hardBlockReasons];
  if (security.sellability === 'FAILED') blocks.push('SELLABILITY_FAILED');
  if (security.freezeAuthorityRevoked === false) blocks.push('FREEZE_AUTHORITY_ACTIVE');
  if (security.extensions?.some((extension) => CRITICAL_TOKEN_EXTENSIONS.includes(extension))) blocks.push('CRITICAL_TOKEN_EXTENSION');
  if (security.extensions?.includes('transferFeeConfig')) blocks.push('UNSUPPORTED_TRANSFER_RESTRICTION');
  return [...new Set(blocks)];
}

export interface LaunchScores {
  launchMomentumScore: number | null;
  exhaustionScore: number | null;
  liquidityScore: number | null;
  buyerQualityScore: number | null;
  buyPressureScore: number | null;
  securityScore: number;
  dataQuality: number;
  score: number | null;
}

const clamp = (value: number) => Math.max(0, Math.min(100, Math.round(value)));

export function launchDataQuality(features: LaunchFeatures, settings: NewLaunchSettings) {
  let quality = 0;
  const expectedSnapshots = Math.max(2, Math.floor(settings.observationSeconds / 2));
  quality += 35 * Math.min(1, features.snapshotCount / expectedSnapshots);
  quality += 25 * Math.min(1, features.transactionCount / Math.max(1, settings.minTransactions));
  if (features.priceUsd !== null) quality += 15;
  if (features.liquidityUsd !== null) quality += 10;
  if (features.uniqueBuyers !== null) quality += 10;
  if (features.estimatedPriceImpact !== null) quality += 5;
  return clamp(quality);
}

/** Launch-specific momentum (first seconds/minutes), not the MomentumStrategy score. */
export function launchMomentumScore(f: LaunchFeatures): number | null {
  if (f.snapshotCount < 2 || f.priceChangeSinceDetection === null) return null;
  let score = 40;
  const move = f.priceChangeSinceDetection;
  if (move > 0 && move <= 60) score += Math.min(20, move / 2);
  else if (move > 150) score -= 15;
  else if (move < -10) score -= 20;
  if (f.transactionAcceleration !== null) score += f.transactionAcceleration >= 1.2 ? 12 : f.transactionAcceleration < 0.6 ? -12 : 0;
  if (f.buyVolumeAcceleration !== null) score += f.buyVolumeAcceleration >= 1.2 ? 10 : f.buyVolumeAcceleration < 0.5 ? -12 : 0;
  if (f.uniqueBuyerGrowth !== null) score += Math.min(12, f.uniqueBuyerGrowth * 6);
  if (f.liquidityChange !== null) score += f.liquidityChange >= 0 ? 6 : f.liquidityChange < -20 ? -20 : -5;
  if (f.estimatedPriceImpact !== null && f.estimatedPriceImpact > 5) score -= 10;
  if (f.largestBuyerShare !== null && f.largestBuyerShare > 0.5) score -= 12;
  return clamp(score);
}

export function launchExhaustionScore(f: LaunchFeatures): number | null {
  if (f.snapshotCount < 2 || f.priceChangeSinceDetection === null) return null;
  let score = 0;
  const move = f.priceChangeSinceDetection;
  score += Math.max(0, Math.min(30, 30 * move / 150));
  if (f.transactionAcceleration !== null && f.transactionAcceleration < 0.5) score += 20;
  if (f.buyVolumeAcceleration !== null && f.buyVolumeAcceleration < 0.5) score += 15;
  if (f.recentSellShare !== null && f.earlySellShare !== null && f.recentSellShare > f.earlySellShare + 0.15) score += 15;
  if (f.distanceFromLaunchHigh !== null && f.distanceFromLaunchHigh > 15) score += 10;
  if (move > 50 && f.liquidityChange !== null && f.liquidityChange < move / 4) score += 10;
  return clamp(score);
}

export function launchLiquidityScore(f: LaunchFeatures, settings: NewLaunchSettings): number | null {
  if (f.liquidityUsd === null) return null;
  if (settings.maxLiquidityUsd !== null && f.liquidityUsd > settings.maxLiquidityUsd) return 20;
  if (f.liquidityUsd < settings.minLiquidityUsd) return clamp(50 * f.liquidityUsd / Math.max(1, settings.minLiquidityUsd));
  let score = 60 + Math.min(30, 30 * Math.log(f.liquidityUsd / settings.minLiquidityUsd) / Math.log(5));
  if (f.liquidityChange !== null) score += f.liquidityChange >= 0 ? 10 : f.liquidityChange < -settings.liquidityOutflowWarningPercent ? -30 : -5;
  return clamp(score);
}

/** Buyer quality: distinct wallets, not transaction counts (20 buys from one wallet is one buyer). */
export function launchBuyerQualityScore(f: LaunchFeatures, settings: NewLaunchSettings): number | null {
  if (f.uniqueBuyers === null) return null;
  let score = 50 * Math.min(1, f.uniqueBuyers / Math.max(1, settings.minUniqueBuyers * 2));
  if (f.largestBuyerShare !== null) score += 30 * (1 - Math.min(1, f.largestBuyerShare / 0.6));
  if (f.buysPerBuyer !== null) score += f.buysPerBuyer <= 1.5 ? 20 : f.buysPerBuyer <= 3 ? 10 : 0;
  return clamp(score);
}

export function launchBuyPressureScore(f: LaunchFeatures): number | null {
  if (f.transactionCount === 0) return null;
  const count = f.buySellRatio ?? 1;
  const volume = f.buyVolumeSellVolumeRatio ?? count;
  const countShare = count / (count + 1);
  const volumeShare = volume / (volume + 1);
  let score = 100 * (0.4 * countShare + 0.6 * volumeShare);
  if (f.recentSellShare !== null && f.earlySellShare !== null && f.recentSellShare > f.earlySellShare + 0.15) score -= 10;
  return clamp(score);
}

export function launchSecurityScore(security: LaunchSecurity) {
  let score = 0;
  if (security.sellability === 'VERIFIED') score += 40;
  if (security.mintAuthorityRevoked === true) score += 20;
  if (security.freezeAuthorityRevoked === true) score += 20;
  if (security.tokenProgram === 'spl-token') score += 20;
  else if (security.tokenProgram === 'spl-token-2022' && security.extensions && !security.extensions.some((extension) => CRITICAL_TOKEN_EXTENSIONS.includes(extension) || extension === 'transferFeeConfig')) score += 15;
  return clamp(score);
}

/** NewLaunchScore: weighted launch factors, scaled by data quality, minus exhaustion and concentration penalties. */
export function computeLaunchScores(f: LaunchFeatures, security: LaunchSecurity, settings: NewLaunchSettings): LaunchScores {
  const momentum = launchMomentumScore(f);
  const exhaustion = launchExhaustionScore(f);
  const liquidity = launchLiquidityScore(f, settings);
  const buyerQuality = launchBuyerQualityScore(f, settings);
  const buyPressure = launchBuyPressureScore(f);
  const securityScore = launchSecurityScore(security);
  const dataQuality = launchDataQuality(f, settings);
  const parts: Array<[number | null, number]> = [[momentum, 0.25], [buyerQuality, 0.2], [buyPressure, 0.15], [liquidity, 0.15], [securityScore, 0.15], [f.estimatedPriceImpact === null ? null : clamp(100 - f.estimatedPriceImpact * 10), 0.1]];
  const known = parts.filter(([value]) => value !== null) as Array<[number, number]>;
  const weight = parts.reduce((sum, [, w]) => sum + w, 0);
  const knownWeight = known.reduce((sum, [, w]) => sum + w, 0);
  // Unknown parts do not add points: the average is over all weights, so missing data lowers the score.
  let score: number | null = knownWeight > 0 ? known.reduce((sum, [value, w]) => sum + value * w, 0) / weight : null;
  if (score !== null) {
    score *= 0.5 + 0.5 * dataQuality / 100;
    if (exhaustion !== null) score -= 0.5 * Math.max(0, exhaustion - 40);
    if (f.largestBuyerShare !== null && f.largestBuyerShare > 0.4) score -= Math.min(15, (f.largestBuyerShare - 0.4) * 50);
    score = clamp(score);
  }
  return { launchMomentumScore: momentum, exhaustionScore: exhaustion, liquidityScore: liquidity, buyerQualityScore: buyerQuality, buyPressureScore: buyPressure, securityScore, dataQuality, score };
}

export type NewLaunchDecision = 'BUY' | 'WATCH' | 'REJECT';
export type NewLaunchStatus = 'WARMING_UP' | 'OBSERVING' | 'EVALUATED' | 'BLOCKED' | 'EXPIRED';

export interface NewLaunchStrategyResult extends LaunchScores {
  available: boolean;
  decision: NewLaunchDecision;
  status: NewLaunchStatus;
  confidence: number;
  reasons: string[];
  warnings: string[];
  hardBlockReasons: string[];
  detectedAt: string;
  evaluatedAt: string;
  features: LaunchFeatures;
}

export interface NewLaunchRiskInput {
  riskScore: number | null;
  classification: string | null;
  hardBlockReasons: string[];
}

/**
 * NewLaunchStrategy decision policy. BUY only when every requirement passes; unknown data and unverified
 * sellability lead to WATCH, never to BUY. Hard security blocks always reject.
 */
export function evaluateNewLaunch(state: LaunchState, security: LaunchSecurity, risk: NewLaunchRiskInput, settings: NewLaunchSettings, now: number): NewLaunchStrategyResult {
  const features = computeLaunchFeatures(state, now);
  const scores = computeLaunchScores(features, security, settings);
  const reasons: string[] = [];
  const warnings: string[] = [...security.warnings];
  const blocks = [...new Set([...evaluateLaunchSecurityBlocks(security), ...risk.hardBlockReasons])];
  const result = (decision: NewLaunchDecision, status: NewLaunchStatus): NewLaunchStrategyResult => ({
    ...scores,
    available: status !== 'WARMING_UP',
    decision,
    status,
    confidence: scores.dataQuality / 100,
    reasons,
    warnings,
    hardBlockReasons: blocks,
    detectedAt: new Date(state.detectedAt).toISOString(),
    evaluatedAt: new Date(now).toISOString(),
    features,
  });
  if (security.mintAuthorityRevoked === false) warnings.push('MINT_AUTHORITY_ACTIVE');
  if (security.mintAuthorityRevoked === null || security.freezeAuthorityRevoked === null) warnings.push('AUTHORITY_STATUS_UNKNOWN');
  if (features.largestBuyerShare !== null && features.largestBuyerShare > 0.4) warnings.push('SINGLE_WALLET_DOMINATES_BUYS');
  if (features.largestHolderSupplyShare !== null && features.largestHolderSupplyShare > 0.2) warnings.push('HIGH_EARLY_SUPPLY_CONCENTRATION');
  if (features.liquidityChange !== null && features.liquidityChange <= -settings.liquidityOutflowWarningPercent) warnings.push('LIQUIDITY_OUTFLOW');

  if (blocks.length) {
    reasons.push(...blocks);
    return result('REJECT', 'BLOCKED');
  }
  if (features.ageSeconds > settings.maxAgeSeconds) {
    reasons.push('LAUNCH_WINDOW_EXPIRED');
    return result('REJECT', 'EXPIRED');
  }
  if (features.liquidityChange !== null && features.liquidityChange <= -settings.liquidityCriticalPercent) {
    reasons.push('CRITICAL_LIQUIDITY');
    return result('REJECT', 'BLOCKED');
  }
  if (features.creatorSoldRatio !== null && features.creatorSoldRatio >= 0.5) {
    reasons.push('CREATOR_SELLING');
    return result('REJECT', 'EVALUATED');
  }
  if (features.ageSeconds < settings.minAgeSeconds) {
    reasons.push('LAUNCH_TOO_YOUNG');
    return result('WATCH', 'WARMING_UP');
  }
  if ((now - state.detectedAt) / 1000 < settings.observationSeconds) {
    reasons.push('OBSERVATION_IN_PROGRESS');
    return result('WATCH', 'WARMING_UP');
  }
  if (scores.dataQuality < 40 || scores.score === null) {
    reasons.push('INSUFFICIENT_LAUNCH_DATA');
    return result('WATCH', 'OBSERVING');
  }
  if (scores.exhaustionScore !== null && scores.exhaustionScore > settings.maxExhaustionScore) {
    reasons.push('LAUNCH_EXHAUSTED');
    return result('REJECT', 'EVALUATED');
  }
  if (risk.riskScore !== null && risk.riskScore > settings.maxRiskScore) {
    reasons.push('RISK_SCORE_ABOVE_LAUNCH_MAXIMUM');
    return result('REJECT', 'EVALUATED');
  }
  if (settings.maxLiquidityUsd !== null && features.liquidityUsd !== null && features.liquidityUsd > settings.maxLiquidityUsd) {
    reasons.push('LIQUIDITY_ABOVE_MAXIMUM');
    return result('REJECT', 'EVALUATED');
  }
  // Remaining requirements can still be met while the token is inside the launch window: WATCH.
  const waiting: string[] = [];
  if (security.sellability !== 'VERIFIED') waiting.push('SELLABILITY_NOT_VERIFIED');
  // Unknown authority status is not safe: wait until it is confirmed.
  if (security.mintAuthorityRevoked === null || security.freezeAuthorityRevoked === null || security.tokenProgram === null) waiting.push(security.rpcUnavailable ? 'RPC_SECURITY_DATA_UNAVAILABLE' : 'SECURITY_CHECK_PENDING');
  if (security.mintAuthorityRevoked === false) waiting.push('MINT_AUTHORITY_ACTIVE');
  if (risk.riskScore === null) waiting.push('RISK_NOT_ASSESSED');
  if (features.liquidityUsd === null || features.liquidityUsd < settings.minLiquidityUsd) waiting.push('LIQUIDITY_BELOW_MINIMUM');
  if (features.estimatedPriceImpact === null) waiting.push('PRICE_IMPACT_UNKNOWN');
  else if (features.estimatedPriceImpact > settings.maxPriceImpactPercent) waiting.push('PRICE_IMPACT_TOO_HIGH');
  if (features.transactionCount < settings.minTransactions) waiting.push('TRANSACTIONS_BELOW_MINIMUM');
  if (features.uniqueBuyers === null) waiting.push('UNIQUE_BUYERS_UNKNOWN');
  else if (features.uniqueBuyers < settings.minUniqueBuyers) waiting.push('UNIQUE_BUYERS_BELOW_MINIMUM');
  if (features.buySellRatio === null || features.buySellRatio < settings.minBuySellRatio) waiting.push('BUY_SELL_RATIO_BELOW_MINIMUM');
  if (features.volumeUsd < settings.minLaunchVolumeUsd) waiting.push('LAUNCH_VOLUME_BELOW_MINIMUM');
  if (scores.score < settings.minScore) waiting.push('LAUNCH_SCORE_BELOW_MINIMUM');
  if (waiting.length) {
    reasons.push(...waiting);
    return result('WATCH', 'EVALUATED');
  }
  reasons.push('ALL_LAUNCH_CONDITIONS_MET');
  return result('BUY', 'EVALUATED');
}

/** Constant-product (x*y=k) price impact of buying with `quoteIn` against virtual reserves (e.g. pump.fun curve). */
export function bondingCurveBuyImpactPercent(virtualQuote: number, virtualBase: number, quoteIn: number) {
  if (!(virtualQuote > 0) || !(virtualBase > 0) || !(quoteIn > 0)) return null;
  const spot = virtualQuote / virtualBase;
  const baseOut = virtualBase - (virtualQuote * virtualBase) / (virtualQuote + quoteIn);
  if (!(baseOut > 0)) return null;
  const average = quoteIn / baseOut;
  return (average / spot - 1) * 100;
}


export interface ResolvedNewLaunchSettings extends NewLaunchSettings {
  /** Active experiment/config version (NL-v1, NL-v2, ...). */
  configVersion: string;
  qualityGate: QualityGateSettings;
  /** Prepared tiered take-profit levels (not executed while tieredTakeProfitEnabled is false). */
  tieredTakeProfitLevels: Array<{ profitPercent: number; sellPercent: number }>;
}

/** A persisted NewLaunchConfig row (or null) merged over the PAPER experiment defaults (shared by API and worker). */
export function resolveNewLaunchSettings(row: Record<string, unknown> | null | undefined): ResolvedNewLaunchSettings {
  const settings = { ...DEFAULT_NEW_LAUNCH_SETTINGS };
  if (row) {
    for (const key of Object.keys(settings) as Array<keyof NewLaunchSettings>) {
      const value = row[key];
      if (value === undefined) continue;
      if (key === 'maxLiquidityUsd') (settings as Record<string, unknown>)[key] = value === null ? null : Number(value);
      else if (key === 'exitCapacityMode') settings.exitCapacityMode = value === 'ENFORCE_PAPER' ? 'ENFORCE_PAPER' : 'MONITOR_ONLY';
      else if (key === 'socialDecisionMode') settings.socialDecisionMode = value === 'ENFORCE_PAPER' ? 'ENFORCE_PAPER' : value === 'OFF' ? 'OFF' : 'MONITOR_ONLY';
      else if (typeof settings[key] === 'boolean') (settings as Record<string, unknown>)[key] = Boolean(value);
      else if (value !== null && Number.isFinite(Number(value))) (settings as Record<string, unknown>)[key] = Number(value);
    }
  }
  const levels = Array.isArray(row?.tieredTakeProfitLevels) ? (row!.tieredTakeProfitLevels as Array<Record<string, unknown>>)
    .map((level) => ({ profitPercent: Number(level.profitPercent), sellPercent: Number(level.sellPercent) }))
    .filter((level) => Number.isFinite(level.profitPercent) && Number.isFinite(level.sellPercent)) : [];
  return {
    ...settings,
    configVersion: typeof row?.configVersion === 'string' && row.configVersion ? row.configVersion : 'NL-v1',
    qualityGate: normalizeQualityGate(row?.qualityGate ?? null),
    tieredTakeProfitLevels: levels,
  };
}

export * from './quality-gate.js';
