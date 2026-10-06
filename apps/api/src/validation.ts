import { z } from 'zod';

import { containsSensitiveField } from './secret-redaction.js';

export const botStatusSchema = z.object({
  status: z.enum(['STARTED', 'STOPPED', 'PAUSED', 'RESUMED', 'EMERGENCY_STOP']).optional(),
});

export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});

export const settingsSchema = z.object({
  tradingMode: z.enum(['PAPER', 'LIVE', 'SEMI_AUTO', 'SCANNER']).default('PAPER'),
  isLiveEnabled: z.boolean().default(false),
  isScannerEnabled: z.boolean().default(true),
  isPaperModeDefault: z.boolean().default(true),
  maxPositionSize: z.number().min(0).nullable().optional(),
  maxDailyLoss: z.number().min(0).nullable().optional(),
  riskThreshold: z.number().min(0).max(100).nullable().optional(),
  preferredQuoteCurrency: z.string().max(16).default('USDC'),
  maxTokenAgeHours: z.number().int().min(1).max(7200).nullable().optional(),
  minLiquidityUsd: z.number().positive().nullable().optional(),
  minVolumeUsd: z.number().positive().nullable().optional(),
  /** Minutes a token may stay blocked/unbuyable before it is skipped (0 = never skip). */
  skipUnbuyableAfterMinutes: z.number().int().min(0).max(1440).optional(),
  /** Minutes a skipped token stays out of scanning and automatic buying. */
  skipUnbuyableForMinutes: z.number().int().min(1).max(10080).optional(),
  /** Size of the scanner's rotating token pool / tokens shown in the token monitor. */
  maxMonitoredTokens: z.number().int().min(10).max(300).optional(),
});

export const riskSettingsSchema = z.object({
  riskPolicy: z.enum(['CONSERVATIVE', 'BALANCED', 'EXPLORATORY']).optional(),
  lowRiskMax: z.number().int().min(0).max(100).optional(),
  moderateRiskMax: z.number().int().min(0).max(100).optional(),
  highRiskMax: z.number().int().min(0).max(100).optional(),
  veryHighRiskMax: z.number().int().min(0).max(100).optional(),
  lowPositionMultiplier: z.number().min(0).max(1).optional(),
  moderatePositionMultiplier: z.number().min(0).max(1).optional(),
  highPositionMultiplier: z.number().min(0).max(1).optional(),
  veryHighPositionMultiplier: z.number().min(0).max(1).optional(),
  aiAnalysisEnabled: z.boolean().optional(),
  aiRequiredForHighRisk: z.boolean().optional(),
  aiRequiredForVeryHighRisk: z.boolean().optional(),
  allowManualPaperWatchBuy: z.boolean().optional(),
  maxPositionPercent: z.number().min(0).max(100).nullable().optional(),
  maxTotalExposurePercent: z.number().min(0).max(100).nullable().optional(),
  maxConcurrentPositions: z.number().int().min(1).max(50).nullable().optional(),
  dailyLossLimitPercent: z.number().min(0).max(100).nullable().optional(),
  maxSlippagePercent: z.number().min(0).max(100).nullable().optional(),
  minSignalScore: z.number().min(0).max(100).nullable().optional(),
  cooldownSeconds: z.number().int().min(0).max(3600).nullable().optional(),
  stopLossPercent: z.number().min(0).max(100).nullable().optional(),
  takeProfitPercent: z.number().min(0).max(100).nullable().optional(),
  trailingStopPercent: z.number().min(0).max(100).nullable().optional(),
  trailingActivationPercent: z.number().min(0).max(1000).nullable().optional(),
  breakEvenActivationPercent: z.number().min(0).max(1000).nullable().optional(),
});

const safeStrategyParamsSchema = z.record(z.unknown()).superRefine((params, context) => {
  if (containsSensitiveField(params)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Secrets must use server-side secret management, not strategy parameters.' });
  }
});

export const strategySettingsSchema = z.object({
  isEnabled: z.boolean().optional(),
  params: safeStrategyParamsSchema.optional(),
});

const walletProviderSchema = z.enum(['PHANTOM', 'SOLFLARE', 'BACKPACK', 'METAMASK', 'SOLLET', 'WALLETCONNECT', 'OTHER']);

export const walletChallengeSchema = z.object({
  publicAddress: z.string().trim().min(32).max(44).regex(/^[1-9A-HJ-NP-Za-km-z]+$/),
  network: z.enum(['mainnet-beta', 'testnet', 'devnet']).default('mainnet-beta'),
});

export const walletConnectSchema = z.object({
  type: z.enum(['USER', 'BOT_TRADING']).default('USER'),
  publicAddress: z.string().trim().min(32).max(44).regex(/^[1-9A-HJ-NP-Za-km-z]+$/).optional(),
  address: z.string().trim().min(32).max(44).regex(/^[1-9A-HJ-NP-Za-km-z]+$/).optional(),
  network: z.enum(['mainnet-beta', 'testnet', 'devnet', 'solana']).default('mainnet-beta').optional(),
  walletType: walletProviderSchema.default('PHANTOM').optional(),
  provider: walletProviderSchema.default('PHANTOM').optional(),
  label: z.string().min(1).max(80).optional(),
  isActive: z.boolean().optional(),
  /** Ownership proof for USER wallets: the nonce from /wallet/challenge and the wallet's signature of its message. */
  nonce: z.string().regex(/^[0-9a-f]{32}$/).optional(),
  signature: z.string().min(64).max(128).optional(),
}).transform((value) => ({
  ...value,
  publicAddress: value.publicAddress ?? value.address ?? '',
  network: value.network ?? 'mainnet-beta',
  provider: value.provider ?? value.walletType ?? 'PHANTOM',
}));

export const walletDisconnectSchema = z.object({
  type: z.enum(['USER', 'BOT_TRADING']).optional(),
  publicAddress: z.string().trim().min(32).max(44).regex(/^[1-9A-HJ-NP-Za-km-z]+$/).optional(),
  address: z.string().trim().min(32).max(44).regex(/^[1-9A-HJ-NP-Za-km-z]+$/).optional(),
});

export const notificationSettingsSchema = z.object({
  telegramEnabled: z.boolean().optional(),
  telegramChatId: z.string().trim().max(64).nullable().optional(),
  emailAlerts: z.boolean().optional(),
  pushAlerts: z.boolean().optional(),
});

export const closePositionSchema = z.object({
  reason: z.string().min(1).max(200).default('manual-close'),
});

export const signalQuerySchema = paginationSchema.extend({
  tokenAddress: z.string().optional(),
  mode: z.enum(['PAPER', 'LIVE', 'SEMI_AUTO', 'SCANNER']).optional(),
});

export const settingsUpdateSchema = settingsSchema.partial();
export const settingsRiskUpdateSchema = riskSettingsSchema.partial();
export const manualPaperBuySchema = z.object({
  tokenAddress: z.string().trim().min(32).max(64),
  requestedAmount: z.number().positive().finite().max(1_000_000),
  amountType: z.enum(['USDC', 'EQUITY_PERCENT']).default('USDC'),
});
export const settingsStrategyUpdateSchema = strategySettingsSchema.partial();
export const settingsNotificationUpdateSchema = notificationSettingsSchema.partial();

export const liveEnableSchema = z.object({
  confirmLiveTrading: z.literal(true),
});

const moduleSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  weight: z.number().min(0).max(10).optional(),
  minScore: z.number().min(0).max(100).optional(),
}).catchall(z.union([z.number().min(0).max(1_000_000), z.boolean()]));

/** Advanced strategy / composite signal settings (per user, stored in PostgreSQL). */
export const advancedStrategySettingsSchema = z.object({
  compositeEnabled: z.boolean().optional(),
  minimumConfirmations: z.number().int().min(1).max(8).optional(),
  minimumCompositeScore: z.number().int().min(0).max(100).optional(),
  penalizeUnavailable: z.boolean().optional(),
  exhaustionEnabled: z.boolean().optional(),
  exhaustionWarningThreshold: z.number().int().min(0).max(100).optional(),
  exhaustionStrongWarningThreshold: z.number().int().min(0).max(100).optional(),
  exhaustionBlockThreshold: z.number().int().min(0).max(100).optional(),
  exhaustionPolicy: z.enum(['BLOCK', 'WARN_ONLY']).optional(),
  exhaustionPenaltyWeight: z.number().min(0).max(5).optional(),
  liquidityOutflowExitEnabled: z.boolean().optional(),
  liquidityOutflowExitPercent: z.number().min(1).max(99).optional(),
  modules: z.record(z.enum(['Momentum', 'MomentumAcceleration', 'VolumeSpike', 'BuyPressure', 'ConfirmedBreakout', 'LiquidityInflow', 'RelativeStrength', 'PullbackContinuation', 'PumpExhaustion']), moduleSettingsSchema).optional(),
}).refine((value) => value.exhaustionWarningThreshold === undefined || value.exhaustionBlockThreshold === undefined || value.exhaustionWarningThreshold <= value.exhaustionBlockThreshold, {
  message: 'A figyelmeztetési küszöb nem lehet nagyobb a tiltási küszöbnél.',
});

/** Per-user AI token analysis settings (PostgreSQL). Provider credentials are never part of this. */
export const aiSettingsSchema = z.object({
  aiAnalysisEnabled: z.boolean().optional(),
  aiMinimumConfidence: z.number().int().min(50).max(100).optional(),
  aiRecheckSeconds: z.number().int().min(15).max(900).optional(),
  aiMaxAnalysesPerMinute: z.number().int().min(1).max(120).optional(),
  aiAllowHighRisk: z.boolean().optional(),
  aiAllowVeryHighRisk: z.boolean().optional(),
  aiDynamicExitSuggestionsEnabled: z.boolean().optional(),
  aiDecisionTtlSeconds: z.number().int().min(30).max(3600).optional(),
  aiUseExitParameters: z.boolean().optional(),
}).strict();

/** New Launch / Sniper settings (per user, PostgreSQL). System-level security rules are not settable. */
export const newLaunchSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  minAgeSeconds: z.number().int().min(0).max(600).optional(),
  maxAgeSeconds: z.number().int().min(10).max(3600).optional(),
  observationSeconds: z.number().int().min(2).max(600).optional(),
  cooldownSeconds: z.number().int().min(0).max(86_400).optional(),
  minTransactions: z.number().int().min(1).max(10_000).optional(),
  minUniqueBuyers: z.number().int().min(1).max(10_000).optional(),
  minBuySellRatio: z.number().min(0.1).max(100).optional(),
  minLaunchVolumeUsd: z.number().min(0).max(100_000_000).optional(),
  minScore: z.number().int().min(0).max(100).optional(),
  maxExhaustionScore: z.number().int().min(0).max(100).optional(),
  minLiquidityUsd: z.number().min(0).max(1_000_000_000).optional(),
  maxLiquidityUsd: z.number().min(0).max(1_000_000_000).nullable().optional(),
  maxPriceImpactPercent: z.number().min(0.1).max(50).optional(),
  liquidityOutflowWarningPercent: z.number().min(1).max(99).optional(),
  liquidityCriticalPercent: z.number().min(1).max(99).optional(),
  maxRiskScore: z.number().int().min(0).max(100).optional(),
  maxPositionPercent: z.number().min(0.1).max(10).optional(),
  maxConcurrentPositions: z.number().int().min(1).max(20).optional(),
  minObservedSellers: z.number().int().min(1).max(50).optional(),
  independentMode: z.boolean().optional(),
  useAiConfirmation: z.literal(false).optional(),
  // NewLaunch-only exit strategy.
  stopLossPercent: z.number().min(1).max(90).optional(),
  takeProfitPercent: z.number().min(1).max(1_000).optional(),
  breakEvenEnabled: z.boolean().optional(),
  breakEvenActivationPercent: z.number().min(0.5).max(500).optional(),
  breakEvenCostBufferPercent: z.number().min(0).max(10).optional(),
  dynamicPositionSizingEnabled: z.boolean().optional(),
  exitCapacityMode: z.enum(['MONITOR_ONLY', 'ENFORCE_PAPER']).optional(),
  maxEstimatedEntryImpactPct: z.number().min(0.1).max(50).optional(),
  maxEstimatedExitImpactPct: z.number().min(0.1).max(50).optional(),
  maxEstimatedRoundTripImpactPct: z.number().min(0.1).max(100).optional(),
  minExitCapacityScore: z.number().int().min(0).max(100).optional(),
  maxLiquidityUtilizationPct: z.number().min(0.1).max(100).optional(),
  minimumExecutablePosition: z.number().min(0).max(100_000).optional(),
  positionSizeStep: z.number().min(0.01).max(10_000).optional(),
  socialIntelligenceEnabled: z.boolean().optional(),
  socialDecisionMode: z.enum(['OFF', 'MONITOR_ONLY', 'ENFORCE_PAPER']).optional(),
  aiSocialAnalysisEnabled: z.boolean().optional(),
  trailingEnabled: z.boolean().optional(),
  // 0 = armed from entry: allowed only as an explicit choice.
  trailingActivationPercent: z.number().min(0).max(500).optional(),
  trailingDistancePercent: z.number().min(0.5).max(90).optional(),
  tieredTakeProfitEnabled: z.boolean().optional(),
  tieredTakeProfitLevels: z.array(z.object({ profitPercent: z.number().min(1).max(1_000), sellPercent: z.number().min(1).max(100) }).strict()).max(3).optional(),
  maxHoldEnabled: z.boolean().optional(),
  maxHoldMinutes: z.number().int().min(1).max(10_080).optional(),
  liquiditySafetyExitEnabled: z.boolean().optional(),
  liquidityDropExitPercent: z.number().min(1).max(99).optional(),
  minimumRecommendationSampleSize: z.number().int().min(20).max(5_000).optional(),
  qualityGate: z.object({
    mode: z.enum(['OFF', 'MONITOR_ONLY', 'ENFORCE_PAPER']).optional(),
    minLaunchScore: z.number().min(0).max(100).nullable().optional(),
    minUniqueBuyers: z.number().int().min(0).max(100_000).nullable().optional(),
    minLiquidityUsd: z.number().min(0).max(1_000_000_000).nullable().optional(),
    minBuySellRatio: z.number().min(0).max(100).nullable().optional(),
    maxExhaustionScore: z.number().min(0).max(100).nullable().optional(),
    maxPriceImpactPercent: z.number().min(0).max(100).nullable().optional(),
    maxHolderConcentrationPercent: z.number().min(0).max(100).nullable().optional(),
    maxDevAllocationPercent: z.number().min(0).max(100).nullable().optional(),
    minDataQuality: z.number().min(0).max(100).nullable().optional(),
  }).strict().optional(),
}).strict().refine((value) => value.minAgeSeconds === undefined || value.maxAgeSeconds === undefined || value.minAgeSeconds < value.maxAgeSeconds, { message: 'A minimum életkornak kisebbnek kell lennie a maximumnál.' });
