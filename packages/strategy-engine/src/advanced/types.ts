/** One timestamped market observation (a persisted TokenMetric row or the current provider snapshot). */
export interface MarketObservation {
  timestamp: Date;
  priceUsd: number | null;
  liquidityUsd: number | null;
  /** Provider rolling windows; null when the provider did not report them. */
  volume5m: number | null;
  volume1h: number | null;
  buyCount5m: number | null;
  sellCount5m: number | null;
  buyCount1h: number | null;
  sellCount1h: number | null;
  priceChange5m: number | null;
  priceChange1h: number | null;
  priceChange24h: number | null;
}

export type DataQuality = 'VALID' | 'PARTIAL' | 'STALE' | 'INVALID';

/**
 * Features derived once per token and shared by every module. A field is null whenever it cannot be
 * derived from real observations (never estimated from 24h aggregates or filled with defaults).
 */
export interface MarketFeatures {
  evaluatedAt: string;
  priceUsd: number | null;
  liquidityUsd: number | null;
  priceChange1m: number | null;
  priceChange5m: number | null;
  priceChange15m: number | null;
  priceChange30m: number | null;
  priceChange1h: number | null;
  volume5m: number | null;
  volume1h: number | null;
  /** Average 5-minute volume of the previous 55 minutes: (volume1h - volume5m) / 11. */
  volume5mBaseline: number | null;
  volumeSpikeRatio: number | null;
  /** volume5m now / volume5m observed ~5 minutes ago. */
  volumeAcceleration: number | null;
  buys5m: number | null;
  sells5m: number | null;
  transactions5m: number | null;
  buySellCountRatio: number | null;
  buyShare5m: number | null;
  buyShare1h: number | null;
  /** Not reported by the current provider: always null unless a provider supplies buy/sell volume. */
  buyVolume5m: number | null;
  sellVolume5m: number | null;
  buySellVolumeRatio: number | null;
  averageTradeSizeUsd5m: number | null;
  liquidityChange5m: number | null;
  liquidityChange15m: number | null;
  liquidityPeak15m: number | null;
  liquidityDrawdownFromPeak15m: number | null;
  /** Price change of the three consecutive momentum windows (oldest first), in percent. */
  momentumWindows: [number, number, number] | null;
  momentumVelocity: number | null;
  momentumAcceleration: number | null;
  recentHigh30m: number | null;
  recentLow30m: number | null;
  distanceFromRecentHighPercent: number | null;
  historyMinutes: number;
  snapshotCount: number;
  dataQuality: DataQuality;
}

export const ADVANCED_MODULE_NAMES = [
  'Momentum',
  'MomentumAcceleration',
  'VolumeSpike',
  'BuyPressure',
  'ConfirmedBreakout',
  'LiquidityInflow',
  'RelativeStrength',
  'PullbackContinuation',
] as const;
export type PositiveModuleName = (typeof ADVANCED_MODULE_NAMES)[number];
export type AdvancedModuleName = PositiveModuleName | 'PumpExhaustion';

export type StrategyResultStatus = 'OK' | 'WARMING_UP' | 'UNAVAILABLE' | 'DISABLED';

/** Standard output of every signal module. Modules analyse; they never place orders. */
export interface StrategyResult {
  strategy: AdvancedModuleName;
  enabled: boolean;
  available: boolean;
  status: StrategyResultStatus;
  /** Machine-readable reason when not available (e.g. INSUFFICIENT_MARKET_DATA, WARMING_UP). */
  unavailableReason: string | null;
  triggered: boolean;
  /** 0-100; null when not available (never a placeholder score). */
  score: number | null;
  /** 0-1: how complete the inputs were. */
  confidence: number;
  reasons: string[];
  warnings: string[];
  features: Record<string, number | boolean | string | null>;
  requiredHistoryMinutes: number;
  evaluatedAt: string;
}

export interface CandidateFeatures {
  tokenAddress: string;
  features: MarketFeatures;
}

export interface ModuleContext {
  features: MarketFeatures;
  observations: MarketObservation[];
  now: Date;
  /** Other candidates of the current scan cycle (for cross-sectional modules). */
  universe?: CandidateFeatures[];
  tokenAddress?: string;
}
