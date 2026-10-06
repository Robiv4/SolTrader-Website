import type { TokenMarketSnapshot } from '@soltrader/market-data';
import type { StrategyMarketData } from '@soltrader/strategy-engine';

/** A previously persisted TokenMetric row, ordered newest-first (index 0 is the just-saved current cycle). */
export interface HistoricalMetricPoint {
  timestamp: Date;
  priceUsd?: number;
  volume24h?: number;
  liquidityUsd?: number;
  buyCount24h?: number;
  sellCount24h?: number;
}

const CONSOLIDATION_WINDOW = 10;
/** Relative distance within which a prior observation counts as a test of a price level. */
const LEVEL_TOLERANCE = 0.03;

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function buyPressureFromCounts(buyCount?: number, sellCount?: number): number | undefined {
  if (buyCount === undefined || sellCount === undefined || buyCount + sellCount === 0) {
    return undefined;
  }
  return clampPercent((buyCount / (buyCount + sellCount)) * 100);
}

/**
 * Derives strategy-engine inputs strictly from real, previously observed data: the current
 * snapshot plus our own historical TokenMetric time series (`history`, newest-first). Fields
 * that require prior observations are left undefined — never fabricated — when history is
 * insufficient; strategies treat an undefined value as "condition not met".
 */
export function buildStrategyMarketData(
  address: string,
  current: TokenMarketSnapshot,
  history: HistoricalMetricPoint[],
  riskScore: number,
): StrategyMarketData {
  const prior = history[1];
  // Exclude the just-saved current cycle so resistance/support/averages reflect prior history only.
  const priorWindow = history.slice(1, CONSOLIDATION_WINDOW + 1);
  const windowPrices = priorWindow.map((point) => point.priceUsd).filter((price): price is number => price !== undefined);
  const windowVolumes = priorWindow.map((point) => point.volume24h).filter((v): v is number => v !== undefined);
  const windowLiquidity = priorWindow.map((point) => point.liquidityUsd).filter((v): v is number => v !== undefined);

  const currentPrice = current.priceUsd;
  const currentBuyPressure = buyPressureFromCounts(current.buyCount24h, current.sellCount24h);
  const priorBuyPressure = prior ? buyPressureFromCounts(prior.buyCount24h, prior.sellCount24h) : undefined;

  const shortTermMomentum = current.priceChange1h !== undefined
    ? clampPercent(50 + current.priceChange1h * 2)
    : undefined;

  const volumeAcceleration = current.volume24h !== undefined && prior?.volume24h && prior.volume24h > 0
    ? clampPercent(50 + ((current.volume24h - prior.volume24h) / prior.volume24h) * 100)
    : undefined;

  const liquidityStability = current.liquidityUsd !== undefined && windowLiquidity.length >= 2
    ? clampPercent(100 - coefficientOfVariation(windowLiquidity) * 100)
    : undefined;

  // Price levels (USD) used for the derived features below.
  const resistanceLevel = windowPrices.length >= 2 ? Math.max(...windowPrices) : undefined;
  const supportLevel = windowPrices.length >= 2 ? Math.min(...windowPrices) : undefined;
  // Strategies compare every feature against 0-100 thresholds, so resistance/support are exported as
  // level-strength scores (how often prior observations tested the level), never as raw prices.
  const resistance = resistanceLevel !== undefined && resistanceLevel > 0 ? levelStrength(windowPrices, resistanceLevel) : undefined;
  const support = supportLevel !== undefined && supportLevel > 0
    ? currentPrice !== undefined && currentPrice < supportLevel * (1 - LEVEL_TOLERANCE) ? 0 : levelStrength(windowPrices, supportLevel)
    : undefined;

  const localConsolidation = windowPrices.length >= 3 && resistanceLevel !== undefined && supportLevel !== undefined && resistanceLevel > 0
    ? clampPercent(100 - ((resistanceLevel - supportLevel) / resistanceLevel) * 100)
    : undefined;

  const breakout = currentPrice !== undefined && resistanceLevel !== undefined && resistanceLevel > 0
    ? clampPercent(50 + ((currentPrice - resistanceLevel) / resistanceLevel) * 100)
    : undefined;

  const volumeConfirmation = current.volume24h !== undefined && windowVolumes.length >= 2
    ? clampPercent(50 + ((current.volume24h - average(windowVolumes)) / average(windowVolumes)) * 100)
    : undefined;

  const initialImpulse = windowPrices.length >= 3 && supportLevel !== undefined && supportLevel > 0 && resistanceLevel !== undefined
    ? clampPercent(((resistanceLevel - supportLevel) / supportLevel) * 100)
    : undefined;

  const retracement = currentPrice !== undefined && resistanceLevel !== undefined && supportLevel !== undefined && resistanceLevel > supportLevel
    ? clampPercent(((resistanceLevel - currentPrice) / (resistanceLevel - supportLevel)) * 100)
    : undefined;

  const renewedBuyingPressure = currentBuyPressure !== undefined && priorBuyPressure !== undefined
    ? clampPercent(50 + (currentBuyPressure - priorBuyPressure))
    : undefined;

  return {
    token: address,
    timestamp: current.timestamp,
    riskScore,
    shortTermMomentum,
    volumeAcceleration,
    buyPressure: currentBuyPressure,
    liquidityStability,
    localConsolidation,
    resistance,
    breakout,
    volumeConfirmation,
    initialImpulse,
    retracement,
    support,
    renewedBuyingPressure,
  };
}

/** 0-100: share of the (up to three) required tests of a price level found in the prior window. */
function levelStrength(prices: number[], level: number): number {
  const touches = prices.filter((price) => Math.abs(price - level) / level <= LEVEL_TOLERANCE).length;
  return clampPercent((touches / Math.min(prices.length, 3)) * 100);
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function coefficientOfVariation(values: number[]): number {
  const mean = average(values);
  if (mean === 0) return 0;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance) / mean;
}
