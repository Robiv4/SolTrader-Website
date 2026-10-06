import type { AdvancedModuleName, PositiveModuleName } from './types.js';

export interface ModuleSettings {
  enabled: boolean;
  weight: number;
  minScore: number;
  [parameter: string]: number | boolean;
}

export type ExhaustionPolicy = 'BLOCK' | 'WARN_ONLY';

export interface AdvancedStrategySettings {
  compositeEnabled: boolean;
  minimumConfirmations: number;
  minimumCompositeScore: number;
  penalizeUnavailable: boolean;
  exhaustionEnabled: boolean;
  exhaustionWarningThreshold: number;
  exhaustionStrongWarningThreshold: number;
  exhaustionBlockThreshold: number;
  exhaustionPolicy: ExhaustionPolicy;
  exhaustionPenaltyWeight: number;
  liquidityOutflowExitEnabled: boolean;
  liquidityOutflowExitPercent: number;
  modules: Record<AdvancedModuleName, ModuleSettings>;
}

/**
 * Defaults for PAPER experimentation (not claims of optimality). Every value can be changed per user;
 * the composite signal is OFF by default, so existing users keep their current entry behaviour.
 */
export const DEFAULT_MODULE_SETTINGS: Record<AdvancedModuleName, ModuleSettings> = {
  Momentum: { enabled: true, weight: 1.0, minScore: 60 },
  // Momentum windows are fixed at 5 minutes: features are computed once per token and shared by all users.
  MomentumAcceleration: { enabled: true, weight: 1.2, minScore: 60, extremeMovePercent: 80 },
  VolumeSpike: { enabled: true, weight: 1.2, minScore: 60, minSpikeRatio: 2, minTransactions5m: 20 },
  BuyPressure: { enabled: true, weight: 1.1, minScore: 60, minBuySellRatio: 1.5, minAverageTradeUsd: 25, minVolume5mUsd: 2_000 },
  ConfirmedBreakout: { enabled: true, weight: 1.1, minScore: 65, lookbackMinutes: 30, confirmationMinutes: 2, volumeConfirmationRequired: true, minVolumeRatio: 1.5, maxExtensionPercent: 25, minLiquidityUsd: 10_000 },
  LiquidityInflow: { enabled: true, weight: 0.7, minScore: 60, minGrowthPercent: 15, outflowWarningPercent: 25, criticalOutflowPercent: 50 },
  RelativeStrength: { enabled: true, weight: 1.0, minScore: 70, minCandidateSample: 10 },
  PullbackContinuation: { enabled: true, weight: 1.0, minScore: 60, lookbackMinutes: 30, minImpulsePercent: 15, minRetracementPercent: 20, maxRetracementPercent: 65, minReclaimPercent: 3 },
  PumpExhaustion: { enabled: true, weight: 0, minScore: 0, extremeMovePercent: 100 },
};

export const DEFAULT_ADVANCED_SETTINGS: AdvancedStrategySettings = {
  compositeEnabled: false,
  minimumConfirmations: 3,
  minimumCompositeScore: 65,
  penalizeUnavailable: false,
  exhaustionEnabled: true,
  exhaustionWarningThreshold: 40,
  exhaustionStrongWarningThreshold: 70,
  exhaustionBlockThreshold: 85,
  exhaustionPolicy: 'BLOCK',
  exhaustionPenaltyWeight: 0.5,
  liquidityOutflowExitEnabled: false,
  liquidityOutflowExitPercent: 50,
  modules: DEFAULT_MODULE_SETTINGS,
};

export const POSITIVE_MODULES: readonly PositiveModuleName[] = ['Momentum', 'MomentumAcceleration', 'VolumeSpike', 'BuyPressure', 'ConfirmedBreakout', 'LiquidityInflow', 'RelativeStrength', 'PullbackContinuation'];

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Persisted row (or null) merged over the defaults; unknown keys and wrong types are ignored. */
export function resolveAdvancedSettings(row: Partial<Record<keyof AdvancedStrategySettings, unknown>> | null | undefined): AdvancedStrategySettings {
  const settings: AdvancedStrategySettings = { ...DEFAULT_ADVANCED_SETTINGS, modules: JSON.parse(JSON.stringify(DEFAULT_MODULE_SETTINGS)) as AdvancedStrategySettings['modules'] };
  if (!row) return settings;
  const numberOr = (value: unknown, fallback: number) => (finite(Number(value)) && value !== null && value !== '' ? Number(value) : fallback);
  settings.compositeEnabled = typeof row.compositeEnabled === 'boolean' ? row.compositeEnabled : settings.compositeEnabled;
  settings.penalizeUnavailable = typeof row.penalizeUnavailable === 'boolean' ? row.penalizeUnavailable : settings.penalizeUnavailable;
  settings.exhaustionEnabled = typeof row.exhaustionEnabled === 'boolean' ? row.exhaustionEnabled : settings.exhaustionEnabled;
  settings.liquidityOutflowExitEnabled = typeof row.liquidityOutflowExitEnabled === 'boolean' ? row.liquidityOutflowExitEnabled : settings.liquidityOutflowExitEnabled;
  settings.minimumConfirmations = numberOr(row.minimumConfirmations, settings.minimumConfirmations);
  settings.minimumCompositeScore = numberOr(row.minimumCompositeScore, settings.minimumCompositeScore);
  settings.exhaustionWarningThreshold = numberOr(row.exhaustionWarningThreshold, settings.exhaustionWarningThreshold);
  settings.exhaustionStrongWarningThreshold = numberOr(row.exhaustionStrongWarningThreshold, settings.exhaustionStrongWarningThreshold);
  settings.exhaustionBlockThreshold = numberOr(row.exhaustionBlockThreshold, settings.exhaustionBlockThreshold);
  settings.exhaustionPenaltyWeight = numberOr(row.exhaustionPenaltyWeight, settings.exhaustionPenaltyWeight);
  settings.liquidityOutflowExitPercent = numberOr(row.liquidityOutflowExitPercent, settings.liquidityOutflowExitPercent);
  settings.exhaustionPolicy = row.exhaustionPolicy === 'WARN_ONLY' ? 'WARN_ONLY' : 'BLOCK';
  const modules = (row.modules && typeof row.modules === 'object' ? row.modules : {}) as Record<string, Record<string, unknown>>;
  for (const name of Object.keys(settings.modules) as AdvancedModuleName[]) {
    const stored = modules[name];
    if (!stored || typeof stored !== 'object') continue;
    for (const [key, fallback] of Object.entries(settings.modules[name])) {
      const value = stored[key];
      if (typeof fallback === 'boolean' && typeof value === 'boolean') settings.modules[name][key] = value;
      if (typeof fallback === 'number' && finite(value)) settings.modules[name][key] = value;
    }
  }
  settings.modules.PumpExhaustion.enabled = settings.exhaustionEnabled;
  return settings;
}

export function numberSetting(settings: ModuleSettings, key: string, fallback: number) {
  const value = settings[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function booleanSetting(settings: ModuleSettings, key: string, fallback: boolean) {
  const value = settings[key];
  return typeof value === 'boolean' ? value : fallback;
}
