export interface RiskPolicy {
  maxPositionSize: number;
  maxDailyLoss: number;
  maxExposure: number;
  liveTradingEnabled: boolean;
}

export function validateRisk(policy: RiskPolicy): { valid: boolean; reason?: string } {
  if (policy.liveTradingEnabled && policy.maxDailyLoss <= 0) {
    return { valid: false, reason: 'Daily loss limit must be positive when live trading is enabled.' };
  }

  if (policy.maxPositionSize <= 0 || policy.maxExposure <= 0) {
    return { valid: false, reason: 'Position and exposure limits must be positive.' };
  }

  return { valid: true };
}

export type RiskRejectionReason =
  | 'LOW_LIQUIDITY'
  | 'HIGH_LIQUIDITY_CONCENTRATION'
  | 'TOKEN_TOO_OLD'
  | 'POOL_TOO_YOUNG'
  | 'LOW_VOLUME'
  | 'LOW_TRANSACTION_COUNT'
  | 'HIGH_PRICE_IMPACT'
  | 'HIGH_HOLDER_CONCENTRATION'
  | 'HIGH_TOP_HOLDER_CONCENTRATION'
  | 'MINT_AUTHORITY_ACTIVE'
  | 'FREEZE_AUTHORITY_ACTIVE'
  | 'METADATA_MUTABLE'
  | 'METADATA_ANOMALY'
  | 'ABNORMAL_ACTIVITY'
  | 'EXCESSIVE_VOLUME_TO_LIQUIDITY'
  | 'HIGH_VOLATILITY'
  | 'SELL_BLOCKED'
  | 'LIQUIDITY_BELOW_ABSOLUTE_MINIMUM'
  | 'EXTREME_PRICE_IMPACT'
  | 'MARKET_DATA_UNAVAILABLE'
  | 'MARKET_DATA_STALE'
  | 'INVALID_POOL'
  | 'INVALID_EXECUTION_ROUTE'
  | 'UNPRICED_EXECUTION'
  | 'MALFORMED_MARKET_DATA'
  | 'RISK_SCORE_TOO_HIGH';

export type RiskWarningCode =
  | RiskRejectionReason
  | 'SELLABILITY_NOT_VERIFIED'
  | 'HIGH_SELL_TAX'
  | 'BORDERLINE_LIQUIDITY_CONCENTRATION'
  | 'BORDERLINE_HOLDER_CONCENTRATION'
  /** On-chain security data (mint / freeze authority) could not be fetched: UNKNOWN, never assumed safe. */
  | 'RPC_SECURITY_DATA_UNAVAILABLE'
  | 'AUTHORITY_STATUS_UNKNOWN'
  /** Holder distribution could not be fetched (the conservative value is used, labelled as unknown). */
  | 'HOLDER_DATA_UNAVAILABLE';

export type RiskClassification = 'LOW' | 'MODERATE' | 'HIGH' | 'VERY_HIGH' | 'EXTREME' | 'BLOCKED';
export type RiskPolicyName = 'CONSERVATIVE' | 'BALANCED' | 'EXPLORATORY';

/** A hard-block decision is independent of measured risk classification. */
export type RiskDecision = 'ACCEPT' | 'WATCH' | 'REJECT';

export interface TokenAuthorityConfiguration {
  mintAuthorityRevoked: boolean;
  freezeAuthorityRevoked: boolean;
  metadataMutable: boolean;
}

export interface SellabilityCheck {
  /** Whether a real sellability probe (e.g. reverse-route quote) was performed. */
  checked: boolean;
  canSell: boolean;
  sellTaxPercent?: number;
}

export interface RiskFactorInput {
  address: string;
  liquidityUsd: number;
  liquidityConcentrationPercent: number;
  tokenAgeSeconds: number;
  poolAgeSeconds: number;
  volume24h: number;
  transactionCount: number;
  slippageEstimatePercent: number;
  holderConcentrationPercent: number;
  topHolderConcentrationPercent: number;
  authority: TokenAuthorityConfiguration;
  metadataAnomalyDetected: boolean;
  volatilityPercent: number;
  abnormalTradingActivity: boolean;
  /** Omitted when a real sellability probe is not technically available for this provider. */
  sellability?: SellabilityCheck;
  marketDataAvailable?: boolean;
  marketDataStale?: boolean;
  poolValid?: boolean;
  executionRouteAvailable?: boolean;
  executionPriceAvailable?: boolean;
  tokenDataValid?: boolean;
  /**
   * false = mint / freeze authority could not be read (RPC unavailable). The conservative authority values are kept for
   * scoring, but the decision is capped at WATCH with an infrastructure block (no automatic entry). Omitted = known.
   */
  authorityStatusKnown?: boolean;
  /** false = holder distribution unknown (conservative concentration used, reported as HOLDER_DATA_UNAVAILABLE). */
  holderDataAvailable?: boolean;
}

export interface RiskThresholds {
  minimumLiquidityUsd: number;
  maximumLiquidityConcentrationPercent: number;
  maximumTokenAgeSeconds: number;
  minimumPoolAgeSeconds: number;
  minimumVolume24hUsd: number;
  minimumTransactionCount: number;
  maximumSlippageEstimatePercent: number;
  maximumHolderConcentrationPercent: number;
  maximumTopHolderConcentrationPercent: number;
  rejectMutableMetadata: boolean;
  maximumVolatilityPercent: number;
  maximumVolumeToLiquidityRatio: number;
  lowRiskMax: number;
  moderateRiskMax: number;
  highRiskMax: number;
  veryHighRiskMax: number;
}

export interface HardBlockPolicy {
  minimumAbsoluteLiquidityUsd: number;
  extremePriceImpactPercent: number;
}

export interface RiskPositionMultipliers {
  LOW: number;
  MODERATE: number;
  HIGH: number;
  VERY_HIGH: number;
  EXTREME: number;
  BLOCKED: number;
}

export const DEFAULT_RISK_THRESHOLDS: RiskThresholds = {
  minimumLiquidityUsd: 5_000,
  maximumLiquidityConcentrationPercent: 60,
  maximumTokenAgeSeconds: 30 * 86_400,
  minimumPoolAgeSeconds: 300,
  minimumVolume24hUsd: 2_000,
  minimumTransactionCount: 50,
  maximumSlippageEstimatePercent: 5,
  maximumHolderConcentrationPercent: 40,
  maximumTopHolderConcentrationPercent: 20,
  rejectMutableMetadata: false,
  maximumVolatilityPercent: 80,
  maximumVolumeToLiquidityRatio: 20,
  lowRiskMax: 30,
  moderateRiskMax: 50,
  highRiskMax: 70,
  veryHighRiskMax: 85,
};

export const DEFAULT_HARD_BLOCK_POLICY: HardBlockPolicy = {
  minimumAbsoluteLiquidityUsd: 1_250,
  extremePriceImpactPercent: 25,
};

export const DEFAULT_RISK_POSITION_MULTIPLIERS: RiskPositionMultipliers = {
  LOW: 1,
  MODERATE: 0.75,
  HIGH: 0.35,
  VERY_HIGH: 0.15,
  EXTREME: 0,
  BLOCKED: 0,
};

export const DEFAULT_RISK_POLICY: RiskPolicyName = 'BALANCED';

export interface RiskFactors {
  liquidityRisk: number;
  liquidityConcentrationRisk: number;
  tokenAgeRisk: number;
  poolConditionRisk: number;
  holderDistributionRisk: number;
  topHolderConcentrationRisk: number;
  mintAuthorityRisk: number;
  freezeAuthorityRisk: number;
  metadataAnomalyRisk: number;
  volatilityRisk: number;
  volumeLiquidityRisk: number;
  priceImpactRisk: number;
  suspiciousActivityRisk: number;
  sellabilityRisk: number;
}

export type RiskWeights = { [factor in keyof RiskFactors]: number };

export const DEFAULT_RISK_WEIGHTS: RiskWeights = {
  liquidityRisk: 1.4,
  liquidityConcentrationRisk: 1,
  tokenAgeRisk: 0.6,
  poolConditionRisk: 0.8,
  holderDistributionRisk: 1,
  topHolderConcentrationRisk: 1.2,
  mintAuthorityRisk: 1.6,
  freezeAuthorityRisk: 1.6,
  metadataAnomalyRisk: 0.8,
  volatilityRisk: 0.8,
  volumeLiquidityRisk: 0.9,
  priceImpactRisk: 1,
  suspiciousActivityRisk: 1.2,
  sellabilityRisk: 1.4,
};

export interface RiskEngineConfig {
  thresholds: RiskThresholds;
  weights?: RiskWeights;
  hardBlockPolicy?: HardBlockPolicy;
  positionMultipliers?: RiskPositionMultipliers;
  riskPolicy?: RiskPolicyName;
  /** Provider/source information persisted alongside the assessment, e.g. "dexscreener+solana-rpc". */
  source?: string;
}

/**
 * Structured risk assessment for a single token at a point in time.
 * riskScore: 0 = lower measured risk, 100 = higher measured risk. This is a relative,
 * point-in-time measurement derived from the supplied factors — it is NOT a guarantee of safety.
 */
export interface RiskAssessment {
  address: string;
  timestamp: Date;
  riskScore: number;
  classification: RiskClassification;
  hardBlocked: boolean;
  hardBlockReasons: RiskRejectionReason[];
  riskPolicy: RiskPolicyName;
  positionMultiplier: number;
  decision: RiskDecision;
  factors: RiskFactors;
  weights: RiskWeights;
  rejectionReasons: RiskRejectionReason[];
  warnings: RiskWarningCode[];
  /** Infrastructure / data-quality blocks (not strategy rejections): automatic entries must not proceed. */
  dataQualityBlockReasons?: string[];
  source: string;
}

function clampPercent(value: number): number {
  if (Number.isNaN(value)) return 100;
  return Math.min(100, Math.max(0, value));
}

/** Risk increases as `value` moves from `safe` towards `bad` (and beyond). */
function riskAsValueIncreases(value: number, safe: number, bad: number): number {
  if (bad <= safe) return value >= bad ? 100 : 0;
  return clampPercent(((value - safe) / (bad - safe)) * 100);
}

/** Risk increases as `value` moves from `safe` (high, good) down towards `bad` (low, risky). */
function riskAsValueDecreases(value: number, safe: number, bad: number): number {
  if (safe <= bad) return value <= bad ? 100 : 0;
  return clampPercent(((safe - value) / (safe - bad)) * 100);
}

export function classifyRiskScore(
  score: number,
  thresholds: Pick<RiskThresholds, 'lowRiskMax' | 'moderateRiskMax' | 'highRiskMax' | 'veryHighRiskMax'> = DEFAULT_RISK_THRESHOLDS,
): Exclude<RiskClassification, 'BLOCKED'> {
  return score <= thresholds.lowRiskMax ? 'LOW'
    : score <= thresholds.moderateRiskMax ? 'MODERATE'
      : score <= thresholds.highRiskMax ? 'HIGH'
        : score <= thresholds.veryHighRiskMax ? 'VERY_HIGH'
          : 'EXTREME';
}

export class RiskRejectedError extends Error {
  constructor(readonly assessment: RiskAssessment) {
    super(`Token ${assessment.address} rejected by risk engine: ${assessment.rejectionReasons.join(', ') || 'risk score too high'}`);
    this.name = 'RiskRejectedError';
  }
}

/**
 * Non-bypassable gate for the orchestration layer: throws for any REJECT decision so a
 * misconfigured strategy can never act on a token the risk engine has rejected.
 */
export function enforceRiskGate(assessment: RiskAssessment): RiskAssessment {
  if (assessment.hardBlocked || assessment.decision === 'REJECT') {
    throw new RiskRejectedError(assessment);
  }
  return assessment;
}

export function assessRisk(input: RiskFactorInput, config: RiskEngineConfig = { thresholds: DEFAULT_RISK_THRESHOLDS }): RiskAssessment {
  const thresholds = config.thresholds;
  const weights = config.weights ?? DEFAULT_RISK_WEIGHTS;
  const hardBlockPolicy = config.hardBlockPolicy ?? DEFAULT_HARD_BLOCK_POLICY;
  const positionMultipliers = config.positionMultipliers ?? DEFAULT_RISK_POSITION_MULTIPLIERS;
  const riskPolicy = config.riskPolicy ?? DEFAULT_RISK_POLICY;
  const hardBlockReasons: RiskRejectionReason[] = [];
  const warnings: RiskWarningCode[] = [];

  const liquidityRisk = riskAsValueDecreases(input.liquidityUsd, thresholds.minimumLiquidityUsd * 4, thresholds.minimumLiquidityUsd * 0.25);
  if (input.liquidityUsd < thresholds.minimumLiquidityUsd) warnings.push('LOW_LIQUIDITY');
  if (input.liquidityUsd < hardBlockPolicy.minimumAbsoluteLiquidityUsd) hardBlockReasons.push('LIQUIDITY_BELOW_ABSOLUTE_MINIMUM');

  const liquidityConcentrationRisk = riskAsValueIncreases(input.liquidityConcentrationPercent, thresholds.maximumLiquidityConcentrationPercent * 0.5, thresholds.maximumLiquidityConcentrationPercent);
  if (input.liquidityConcentrationPercent > thresholds.maximumLiquidityConcentrationPercent) warnings.push('HIGH_LIQUIDITY_CONCENTRATION');
  else if (input.liquidityConcentrationPercent > thresholds.maximumLiquidityConcentrationPercent * 0.8) warnings.push('BORDERLINE_LIQUIDITY_CONCENTRATION');

  const tokenAgeRisk = riskAsValueIncreases(input.tokenAgeSeconds, thresholds.maximumTokenAgeSeconds * 0.5, thresholds.maximumTokenAgeSeconds);
  if (input.tokenAgeSeconds > thresholds.maximumTokenAgeSeconds) warnings.push('TOKEN_TOO_OLD');

  const poolConditionRisk = riskAsValueDecreases(input.poolAgeSeconds, thresholds.minimumPoolAgeSeconds * 6, thresholds.minimumPoolAgeSeconds);
  if (input.poolAgeSeconds < thresholds.minimumPoolAgeSeconds) warnings.push('POOL_TOO_YOUNG');

  const holderDistributionRisk = riskAsValueIncreases(input.holderConcentrationPercent, thresholds.maximumHolderConcentrationPercent * 0.6, thresholds.maximumHolderConcentrationPercent);
  if (input.holderDataAvailable === false) warnings.push('HOLDER_DATA_UNAVAILABLE');
  else if (input.holderConcentrationPercent > thresholds.maximumHolderConcentrationPercent) warnings.push('HIGH_HOLDER_CONCENTRATION');
  else if (input.holderConcentrationPercent > thresholds.maximumHolderConcentrationPercent * 0.8) warnings.push('BORDERLINE_HOLDER_CONCENTRATION');

  const topHolderConcentrationRisk = riskAsValueIncreases(input.topHolderConcentrationPercent, thresholds.maximumTopHolderConcentrationPercent * 0.5, thresholds.maximumTopHolderConcentrationPercent);
  if (input.holderDataAvailable !== false && input.topHolderConcentrationPercent > thresholds.maximumTopHolderConcentrationPercent) warnings.push('HIGH_TOP_HOLDER_CONCENTRATION');

  const mintAuthorityRisk = input.authority.mintAuthorityRevoked ? 0 : 100;
  const authorityUnknown = input.authorityStatusKnown === false;
  if (authorityUnknown) warnings.push('AUTHORITY_STATUS_UNKNOWN', 'RPC_SECURITY_DATA_UNAVAILABLE');
  else if (!input.authority.mintAuthorityRevoked) warnings.push('MINT_AUTHORITY_ACTIVE');

  const freezeAuthorityRisk = input.authority.freezeAuthorityRevoked ? 0 : 100;
  if (!authorityUnknown && !input.authority.freezeAuthorityRevoked) warnings.push('FREEZE_AUTHORITY_ACTIVE');

  if (input.authority.metadataMutable && thresholds.rejectMutableMetadata) warnings.push('METADATA_MUTABLE');

  const metadataAnomalyRisk = input.metadataAnomalyDetected ? 100 : 0;
  if (input.metadataAnomalyDetected) warnings.push('METADATA_ANOMALY');

  const volatilityRisk = riskAsValueIncreases(input.volatilityPercent, thresholds.maximumVolatilityPercent * 0.5, thresholds.maximumVolatilityPercent);
  if (input.volatilityPercent > thresholds.maximumVolatilityPercent) warnings.push('HIGH_VOLATILITY');

  const volumeToLiquidityRatio = input.liquidityUsd > 0 ? input.volume24h / input.liquidityUsd : Number.POSITIVE_INFINITY;
  const volumeLiquidityRisk = riskAsValueIncreases(volumeToLiquidityRatio, thresholds.maximumVolumeToLiquidityRatio * 0.5, thresholds.maximumVolumeToLiquidityRatio);
  if (volumeToLiquidityRatio > thresholds.maximumVolumeToLiquidityRatio) warnings.push('EXCESSIVE_VOLUME_TO_LIQUIDITY');
  if (input.volume24h < thresholds.minimumVolume24hUsd) warnings.push('LOW_VOLUME');
  if (input.transactionCount < thresholds.minimumTransactionCount) warnings.push('LOW_TRANSACTION_COUNT');

  const priceImpactRisk = riskAsValueIncreases(input.slippageEstimatePercent, thresholds.maximumSlippageEstimatePercent * 0.5, thresholds.maximumSlippageEstimatePercent);
  if (input.slippageEstimatePercent > thresholds.maximumSlippageEstimatePercent) warnings.push('HIGH_PRICE_IMPACT');
  if (input.slippageEstimatePercent > hardBlockPolicy.extremePriceImpactPercent) hardBlockReasons.push('EXTREME_PRICE_IMPACT');

  const suspiciousActivityRisk = input.abnormalTradingActivity ? 100 : 0;
  if (input.abnormalTradingActivity) warnings.push('ABNORMAL_ACTIVITY');

  let sellabilityRisk: number;
  if (!input.sellability || !input.sellability.checked) {
    sellabilityRisk = 50;
    warnings.push('SELLABILITY_NOT_VERIFIED');
  } else if (!input.sellability.canSell) {
    sellabilityRisk = 100;
    hardBlockReasons.push('SELL_BLOCKED');
  } else {
    const sellTax = input.sellability.sellTaxPercent ?? 0;
    sellabilityRisk = riskAsValueIncreases(sellTax, 5, 20);
    if (sellTax > 10) warnings.push('HIGH_SELL_TAX');
  }

  if (input.marketDataAvailable === false) hardBlockReasons.push('MARKET_DATA_UNAVAILABLE');
  if (input.marketDataStale === true) hardBlockReasons.push('MARKET_DATA_STALE');
  if (input.poolValid === false) hardBlockReasons.push('INVALID_POOL');
  if (input.executionRouteAvailable === false) hardBlockReasons.push('INVALID_EXECUTION_ROUTE');
  if (input.executionPriceAvailable === false) hardBlockReasons.push('UNPRICED_EXECUTION');
  if (input.tokenDataValid === false) hardBlockReasons.push('MALFORMED_MARKET_DATA');

  const numericInputs = [
    input.liquidityUsd, input.liquidityConcentrationPercent, input.tokenAgeSeconds, input.poolAgeSeconds,
    input.volume24h, input.transactionCount, input.slippageEstimatePercent, input.holderConcentrationPercent,
    input.topHolderConcentrationPercent, input.volatilityPercent,
  ];
  if (numericInputs.some((value) => !Number.isFinite(value)) || !input.address.trim()) {
    hardBlockReasons.push('MALFORMED_MARKET_DATA');
  }

  const factors: RiskFactors = {
    liquidityRisk,
    liquidityConcentrationRisk,
    tokenAgeRisk,
    poolConditionRisk,
    holderDistributionRisk,
    topHolderConcentrationRisk,
    mintAuthorityRisk,
    freezeAuthorityRisk,
    metadataAnomalyRisk,
    volatilityRisk,
    volumeLiquidityRisk,
    priceImpactRisk,
    suspiciousActivityRisk,
    sellabilityRisk,
  };

  const factorNames = Object.keys(factors) as Array<keyof RiskFactors>;
  const totalWeight = factorNames.reduce((sum, key) => sum + Math.max(0, weights[key]), 0);
  const weightedScore = totalWeight > 0
    ? factorNames.reduce((sum, key) => sum + factors[key] * Math.max(0, weights[key]), 0) / totalWeight
    : 0;
  const riskScore = clampPercent(Math.round(weightedScore));

  const hardBlocked = hardBlockReasons.length > 0;
  const classification: RiskClassification = hardBlocked ? 'BLOCKED' : classifyRiskScore(riskScore, thresholds);
  // Infrastructure / data-quality block: required security data UNKNOWN -> at most WATCH, never an automatic entry.
  const dataQualityBlockReasons = authorityUnknown ? ['RPC_SECURITY_DATA_UNAVAILABLE'] : [];
  const decision: RiskDecision = hardBlocked ? 'REJECT' : riskScore <= thresholds.lowRiskMax && !dataQualityBlockReasons.length ? 'ACCEPT' : 'WATCH';

  return {
    address: input.address,
    timestamp: new Date(),
    riskScore,
    classification,
    hardBlocked,
    hardBlockReasons: Array.from(new Set(hardBlockReasons)),
    riskPolicy,
    positionMultiplier: Math.min(1, Math.max(0, positionMultipliers[classification])),
    decision,
    factors,
    weights: { ...weights },
    rejectionReasons: Array.from(new Set(hardBlockReasons)),
    warnings: Array.from(new Set(warnings)),
    dataQualityBlockReasons,
    source: config.source ?? 'unknown',
  };
}

export interface TokenScoreFactors {
  momentum: number;
  volume: number;
  volumeAcceleration: number;
  buyPressure: number;
  liquidity: number;
  holderDistribution: number;
  walletActivity: number;
  marketConditions: number;
}

export type TokenScoreWeights = { [factor in keyof TokenScoreFactors]: number };

export interface TokenScoreResult {
  score: number;
  factors: TokenScoreFactors;
  weights: TokenScoreWeights;
}

export const DEFAULT_TOKEN_SCORE_WEIGHTS: TokenScoreWeights = {
  momentum: 1,
  volume: 1,
  volumeAcceleration: 1,
  buyPressure: 1,
  liquidity: 1,
  holderDistribution: 1,
  walletActivity: 1,
  marketConditions: 1,
};

export function calculateTokenScore(factors: TokenScoreFactors, weights: TokenScoreWeights = DEFAULT_TOKEN_SCORE_WEIGHTS): TokenScoreResult {
  const factorNames = Object.keys(factors) as Array<keyof TokenScoreFactors>;
  const totalWeight = factorNames.reduce((sum, factor) => sum + Math.max(0, weights[factor]), 0);
  if (totalWeight === 0) {
    throw new Error('At least one token score weight must be positive');
  }

  const weightedScore = factorNames.reduce((sum, factor) => sum + clampPercent(factors[factor]) * Math.max(0, weights[factor]), 0);
  return {
    score: clampPercent(Math.round(weightedScore / totalWeight)),
    factors: { ...factors },
    weights: { ...weights },
  };
}

export * from './decision.js';
