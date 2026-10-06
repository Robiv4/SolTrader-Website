import type { DataQuality, MarketFeatures, MarketObservation } from './types.js';

const MINUTE = 60_000;

export interface FeatureEngineOptions {
  /** Snapshots older than this (relative to `now`) make the data STALE. */
  staleAfterMs?: number;
  /** Length of each of the three momentum windows. */
  momentumWindowMinutes?: number;
}

function positive(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function finite(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function percentChange(current: number | null, previous: number | null) {
  return positive(current) && positive(previous) ? (current / previous - 1) * 100 : null;
}

/** Sorted (oldest first), one observation per timestamp (the last one written wins). */
export function normalizeObservations(observations: MarketObservation[]) {
  const byTime = new Map<number, MarketObservation>();
  for (const observation of observations) {
    const time = observation.timestamp.getTime();
    if (Number.isFinite(time)) byTime.set(time, observation);
  }
  return [...byTime.values()].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
}

/**
 * The observation closest to `minutesAgo` before `reference`, if one lies within the tolerance
 * (max 45 s or 30% of the offset). Returns null rather than interpolating a value that was not observed.
 */
export function observationAt<T extends keyof MarketObservation>(observations: MarketObservation[], reference: Date, minutesAgo: number, field: T) {
  const target = reference.getTime() - minutesAgo * MINUTE;
  const tolerance = Math.max(45_000, minutesAgo * MINUTE * 0.3);
  let best: MarketObservation | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const observation of observations) {
    const value = observation[field];
    if (value === null || value === undefined) continue;
    const distance = Math.abs(observation.timestamp.getTime() - target);
    if (distance <= tolerance && distance < bestDistance) {
      best = observation;
      bestDistance = distance;
    }
  }
  return best ? best[field] : null;
}

function share(buys: number | null, sells: number | null) {
  if (!finite(buys) || !finite(sells) || buys + sells <= 0) return null;
  return buys / (buys + sells);
}

/**
 * Centralised feature calculation (MarketFeatureEngine). Uses the provider's rolling windows where they
 * exist (5m / 1h volume, trade counts, price change) and the persisted snapshot history for everything
 * that needs a time series (1m / 15m / 30m changes, acceleration, liquidity trend, recent high/low).
 */
export function computeMarketFeatures(input: MarketObservation[], now = new Date(), options: FeatureEngineOptions = {}): MarketFeatures {
  // A snapshot fetched a moment after `now` (same cycle) still counts; genuinely future rows do not.
  const observations = normalizeObservations(input).filter((observation) => observation.timestamp.getTime() <= now.getTime() + MINUTE);
  const latest = observations.at(-1) ?? null;
  const staleAfterMs = options.staleAfterMs ?? 2 * MINUTE;
  const window = options.momentumWindowMinutes ?? 5;
  const reference = latest?.timestamp ?? now;
  const at = <T extends keyof MarketObservation>(minutes: number, field: T) => observationAt(observations, reference, minutes, field) as MarketObservation[T] | null;

  const priceUsd = positive(latest?.priceUsd) ? latest!.priceUsd : null;
  const liquidityUsd = positive(latest?.liquidityUsd) ? latest!.liquidityUsd : null;
  const volume5m = finite(latest?.volume5m) ? latest!.volume5m : null;
  const volume1h = finite(latest?.volume1h) ? latest!.volume1h : null;
  const volume5mBaseline = volume5m !== null && volume1h !== null && volume1h >= volume5m ? (volume1h - volume5m) / 11 : null;
  const volumeSpikeRatio = volume5m !== null && positive(volume5mBaseline) ? volume5m / volume5mBaseline : null;
  const previousVolume5m = at(5, 'volume5m');
  const buys5m = finite(latest?.buyCount5m) ? latest!.buyCount5m : null;
  const sells5m = finite(latest?.sellCount5m) ? latest!.sellCount5m : null;
  const transactions5m = buys5m !== null && sells5m !== null ? buys5m + sells5m : null;

  const windows = [at(3 * window, 'priceUsd'), at(2 * window, 'priceUsd'), at(window, 'priceUsd')];
  const r1 = percentChange(windows[1], windows[0]);
  const r2 = percentChange(windows[2], windows[1]);
  const r3 = percentChange(priceUsd, windows[2]);
  const momentumWindows = r1 !== null && r2 !== null && r3 !== null ? [r1, r2, r3] as [number, number, number] : null;

  const last15 = observations.filter((observation) => observation.timestamp.getTime() >= reference.getTime() - 15 * MINUTE);
  const liquidityPeak15m = last15.map((observation) => observation.liquidityUsd).filter(positive).reduce<number | null>((peak, value) => (peak === null ? value : Math.max(peak, value)), null);
  const last30 = observations.filter((observation) => observation.timestamp.getTime() >= reference.getTime() - 30 * MINUTE);
  const prices30 = last30.map((observation) => observation.priceUsd).filter(positive);
  const recentHigh30m = prices30.length ? Math.max(...prices30) : null;
  const recentLow30m = prices30.length ? Math.min(...prices30) : null;

  const historyMinutes = observations.length > 1 ? (reference.getTime() - observations[0].timestamp.getTime()) / MINUTE : 0;
  const stale = !latest || now.getTime() - latest.timestamp.getTime() > staleAfterMs;
  const dataQuality: DataQuality = !latest || priceUsd === null ? 'INVALID' : stale ? 'STALE' : liquidityUsd === null || volume5m === null || buys5m === null ? 'PARTIAL' : 'VALID';

  return {
    evaluatedAt: now.toISOString(),
    priceUsd,
    liquidityUsd,
    priceChange1m: percentChange(priceUsd, at(1, 'priceUsd')),
    priceChange5m: finite(latest?.priceChange5m) ? latest!.priceChange5m : percentChange(priceUsd, at(5, 'priceUsd')),
    priceChange15m: percentChange(priceUsd, at(15, 'priceUsd')),
    priceChange30m: percentChange(priceUsd, at(30, 'priceUsd')),
    priceChange1h: finite(latest?.priceChange1h) ? latest!.priceChange1h : percentChange(priceUsd, at(60, 'priceUsd')),
    volume5m,
    volume1h,
    volume5mBaseline,
    volumeSpikeRatio,
    volumeAcceleration: volume5m !== null && positive(previousVolume5m) ? volume5m / previousVolume5m : null,
    buys5m,
    sells5m,
    transactions5m,
    buySellCountRatio: buys5m !== null && sells5m !== null ? (sells5m > 0 ? buys5m / sells5m : buys5m > 0 ? Math.min(99, buys5m) : null) : null,
    buyShare5m: share(buys5m, sells5m),
    buyShare1h: share(latest?.buyCount1h ?? null, latest?.sellCount1h ?? null),
    buyVolume5m: null,
    sellVolume5m: null,
    buySellVolumeRatio: null,
    averageTradeSizeUsd5m: volume5m !== null && positive(transactions5m) ? volume5m / transactions5m : null,
    liquidityChange5m: percentChange(liquidityUsd, at(5, 'liquidityUsd')),
    liquidityChange15m: percentChange(liquidityUsd, at(15, 'liquidityUsd')),
    liquidityPeak15m,
    liquidityDrawdownFromPeak15m: liquidityUsd !== null && positive(liquidityPeak15m) ? (liquidityUsd / liquidityPeak15m - 1) * 100 : null,
    momentumWindows,
    momentumVelocity: r3,
    momentumAcceleration: r3 !== null && r2 !== null ? r3 - r2 : null,
    recentHigh30m,
    recentLow30m,
    distanceFromRecentHighPercent: priceUsd !== null && positive(recentHigh30m) ? (priceUsd / recentHigh30m - 1) * 100 : null,
    historyMinutes,
    snapshotCount: observations.length,
    dataQuality,
  };
}
