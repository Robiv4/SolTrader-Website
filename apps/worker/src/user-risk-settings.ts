import type { PrismaClient } from '@prisma/client';
import { DEFAULT_RISK_POSITION_MULTIPLIERS, type RiskPolicyName } from '@soltrader/risk-engine';
import type { UserScanSettings } from '@soltrader/token-discovery';

// System-level defaults for risk dimensions not yet exposed as per-user settings in the schema.
const DEFAULT_MAX_HOLDER_CONCENTRATION_PERCENT = 40;
const DEFAULT_MAX_TOP_HOLDER_CONCENTRATION_PERCENT = 20;
const DEFAULT_MAX_LIQUIDITY_CONCENTRATION_PERCENT = 60;
const DEFAULT_MAX_VOLATILITY_PERCENT = 80;
const DEFAULT_MINIMUM_TRANSACTION_COUNT = 50;
const DEFAULT_MIN_LIQUIDITY_USD = 5_000;
const DEFAULT_MIN_VOLUME_USD = 2_000;
const DEFAULT_MAX_TOKEN_AGE_HOURS = 168;
const DEFAULT_MAX_SLIPPAGE_PERCENT = 3;

type BotConfigWithRisk = Awaited<ReturnType<PrismaClient['botConfig']['findMany']>>[number] & {
  user: { riskConfigs: Array<{
    maxSlippagePercent: unknown;
    riskPolicy: RiskPolicyName;
    lowRiskMax: number;
    moderateRiskMax: number;
    highRiskMax: number;
    veryHighRiskMax: number;
    lowPositionMultiplier: unknown;
    moderatePositionMultiplier: unknown;
    highPositionMultiplier: unknown;
    veryHighPositionMultiplier: unknown;
  }> };
};

/**
 * Risk-engine settings of every user whose bot runs (RUNNING, PAPER / SEMI_AUTO, no emergency stop), loaded strictly
 * from PostgreSQL. Used by New Launch for its risk assessment. Independent of the retired token scanner: the legacy
 * BotConfig.isScannerEnabled column is no longer read anywhere.
 */
export async function loadActiveUserRiskSettings(prisma: Pick<PrismaClient, 'botConfig'>): Promise<UserScanSettings[]> {
  const configs = (await prisma.botConfig.findMany({
    where: { status: 'RUNNING', tradingMode: { in: ['PAPER', 'SEMI_AUTO'] }, isEmergencyStop: false },
    include: { user: { include: { riskConfigs: true } } },
  })) as unknown as BotConfigWithRisk[];

  return configs.map((config) => {
    const risk = config.user.riskConfigs[0];
    return {
      userId: config.userId,
      minLiquidityUsd: config.minLiquidityUsd ? Number(config.minLiquidityUsd) : DEFAULT_MIN_LIQUIDITY_USD,
      minVolumeUsd: config.minVolumeUsd ? Number(config.minVolumeUsd) : DEFAULT_MIN_VOLUME_USD,
      maxTokenAgeSeconds: (config.maxTokenAgeHours ?? DEFAULT_MAX_TOKEN_AGE_HOURS) * 3600,
      maxSlippagePercent: risk?.maxSlippagePercent ? Number(risk.maxSlippagePercent) : DEFAULT_MAX_SLIPPAGE_PERCENT,
      maxHolderConcentrationPercent: DEFAULT_MAX_HOLDER_CONCENTRATION_PERCENT,
      maxTopHolderConcentrationPercent: DEFAULT_MAX_TOP_HOLDER_CONCENTRATION_PERCENT,
      maxLiquidityConcentrationPercent: DEFAULT_MAX_LIQUIDITY_CONCENTRATION_PERCENT,
      maxVolatilityPercent: DEFAULT_MAX_VOLATILITY_PERCENT,
      minimumTransactionCount: DEFAULT_MINIMUM_TRANSACTION_COUNT,
      rejectMutableMetadata: false,
      riskPolicy: risk?.riskPolicy ?? 'BALANCED',
      lowRiskMax: risk?.lowRiskMax ?? 30,
      moderateRiskMax: risk?.moderateRiskMax ?? 50,
      highRiskMax: risk?.highRiskMax ?? 70,
      veryHighRiskMax: risk?.veryHighRiskMax ?? 85,
      positionMultipliers: risk ? {
        ...DEFAULT_RISK_POSITION_MULTIPLIERS,
        LOW: Math.min(1, Number(risk.lowPositionMultiplier)),
        MODERATE: Math.min(1, Number(risk.moderatePositionMultiplier)),
        HIGH: Math.min(1, Number(risk.highPositionMultiplier)),
        VERY_HIGH: Math.min(1, Number(risk.veryHighPositionMultiplier)),
      } : DEFAULT_RISK_POSITION_MULTIPLIERS,
      source: 'worker-scanner',
    };
  });
}
