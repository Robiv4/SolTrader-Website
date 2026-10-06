import { DEFAULT_RISK_POSITION_MULTIPLIERS, DEFAULT_RISK_THRESHOLDS, type RiskEngineConfig, type RiskPolicyName, type RiskPositionMultipliers } from '@soltrader/risk-engine';

import type { TokenCandidate } from './index.js';

/**
 * Per-user token filter/risk thresholds sourced from PostgreSQL (BotConfig + RiskConfig).
 * The scanner must never use values supplied directly by the frontend/request body.
 */
export interface UserScanSettings {
  userId: string;
  minLiquidityUsd: number;
  minVolumeUsd: number;
  maxTokenAgeSeconds: number;
  maxSlippagePercent: number;
  maxHolderConcentrationPercent: number;
  maxTopHolderConcentrationPercent: number;
  maxLiquidityConcentrationPercent: number;
  maxVolatilityPercent: number;
  minimumTransactionCount: number;
  rejectMutableMetadata: boolean;
  riskPolicy: RiskPolicyName;
  lowRiskMax: number;
  moderateRiskMax: number;
  highRiskMax: number;
  veryHighRiskMax: number;
  positionMultipliers: RiskPositionMultipliers;
  source: string;
}

/** User score thresholds are risk factors, not silent discovery rejection rules. */
export function filterCandidateForUser(candidate: TokenCandidate, settings: UserScanSettings): boolean {
  void candidate;
  void settings;
  return true;
}

export function toRiskEngineConfig(settings: UserScanSettings): RiskEngineConfig {
  return {
    thresholds: {
      ...DEFAULT_RISK_THRESHOLDS,
      minimumLiquidityUsd: settings.minLiquidityUsd,
      minimumVolume24hUsd: settings.minVolumeUsd,
      minimumTransactionCount: settings.minimumTransactionCount,
      maximumTokenAgeSeconds: settings.maxTokenAgeSeconds,
      maximumSlippageEstimatePercent: settings.maxSlippagePercent,
      maximumHolderConcentrationPercent: settings.maxHolderConcentrationPercent,
      maximumTopHolderConcentrationPercent: settings.maxTopHolderConcentrationPercent,
      maximumLiquidityConcentrationPercent: settings.maxLiquidityConcentrationPercent,
      rejectMutableMetadata: settings.rejectMutableMetadata,
      maximumVolatilityPercent: settings.maxVolatilityPercent,
      lowRiskMax: settings.lowRiskMax,
      moderateRiskMax: settings.moderateRiskMax,
      highRiskMax: settings.highRiskMax,
      veryHighRiskMax: settings.veryHighRiskMax,
    },
    riskPolicy: settings.riskPolicy,
    positionMultipliers: settings.positionMultipliers ?? DEFAULT_RISK_POSITION_MULTIPLIERS,
    source: settings.source,
  };
}
