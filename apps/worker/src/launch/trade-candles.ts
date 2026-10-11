/**
 * Real OHLCV candles from the pump.fun trade stream the worker already receives (no extra RPC / provider requests).
 *
 * - Every candle is built from actual, time-stamped trades: price = SOL paid / tokens received of that trade, in USD
 *   at the current SOL price; volume = traded SOL in USD. Buckets without trades produce NO candle (a gap), never an
 *   interpolated one. Trades without a known SOL/USD price are not converted (nothing is invented).
 * - Bucket time = the trade's on-chain block time (second resolution); arrival order breaks ties inside a second.
 * - Storage: one Redis hash per mint (field = bucket start, value = candle JSON), short TTL. The database, the ML
 *   snapshots and the price-tracking semantics are untouched.
 */

export interface TradeCandle {
  /** Bucket start (ms epoch). */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  /** Traded volume in USD. */
  v: number;
  /** Number of trades / buys / sells in the bucket. */
  n: number;
  buys: number;
  sells: number;
}

export interface CandleStore {
  hSet(key: string, values: Record<string, string>): Promise<unknown>;
  expire(key: string, seconds: number): Promise<unknown>;
}

export interface CandleTrade {
  mint: string;
  isBuy: boolean;
  solAmount: number;
  tokenAmount: number;
  /** On-chain block time (ms). */
  timestamp: number;
  receivedAt?: number;
}

export const CANDLE_BUCKET_MS = 5_000;
export const CANDLE_KEY_PREFIX = 'candles:5s:';
const MAX_CLOCK_SKEW_MS = 10 * 60_000;

/** Pure: applies one trade to a candle (or starts it). */
export function applyTrade(candle: TradeCandle | undefined, bucket: number, price: number, volumeUsd: number, isBuy: boolean): TradeCandle {
  if (!candle) return { t: bucket, o: price, h: price, l: price, c: price, v: volumeUsd, n: 1, buys: isBuy ? 1 : 0, sells: isBuy ? 0 : 1 };
  candle.h = Math.max(candle.h, price);
  candle.l = Math.min(candle.l, price);
  candle.c = price;
  candle.v += volumeUsd;
  candle.n += 1;
  if (isBuy) candle.buys += 1;
  else candle.sells += 1;
  return candle;
}

export class TradeCandleAggregator {
  private readonly candles = new Map<string, Map<number, TradeCandle>>();
  private readonly dirty = new Map<string, Set<number>>();
  private readonly lastSeen = new Map<string, number>();
  readonly metrics = { trades: 0, skippedNoSolPrice: 0, skippedInvalid: 0, flushedBuckets: 0, flushFailures: 0 };

  constructor(private readonly deps: { store: CandleStore; ttlSeconds?: number; retentionMs?: number; maxMints?: number; now?: () => number }) {}

  private now() {
    return this.deps.now?.() ?? Date.now();
  }

  /** Synchronous: called from the trade handler; never throws. */
  record(trade: CandleTrade, solUsd: number | null) {
    try {
      if (!solUsd || !(solUsd > 0)) {
        this.metrics.skippedNoSolPrice += 1;
        return;
      }
      if (!(trade.solAmount > 0) || !(trade.tokenAmount > 0) || !Number.isFinite(trade.solAmount) || !Number.isFinite(trade.tokenAmount)) {
        this.metrics.skippedInvalid += 1;
        return;
      }
      const received = trade.receivedAt ?? this.now();
      // On-chain time when plausible; a wildly off block time falls back to the arrival time.
      const at = Number.isFinite(trade.timestamp) && Math.abs(trade.timestamp - received) <= MAX_CLOCK_SKEW_MS ? trade.timestamp : received;
      const bucket = Math.floor(at / CANDLE_BUCKET_MS) * CANDLE_BUCKET_MS;
      const price = (trade.solAmount / trade.tokenAmount) * solUsd;
      let series = this.candles.get(trade.mint);
      if (!series) {
        if (this.candles.size >= (this.deps.maxMints ?? 1_500)) this.evictOldest();
        series = new Map();
        this.candles.set(trade.mint, series);
      }
      series.set(bucket, applyTrade(series.get(bucket), bucket, price, trade.solAmount * solUsd, trade.isBuy));
      let marks = this.dirty.get(trade.mint);
      if (!marks) {
        marks = new Set();
        this.dirty.set(trade.mint, marks);
      }
      marks.add(bucket);
      this.lastSeen.set(trade.mint, received);
      this.metrics.trades += 1;
    } catch {
      this.metrics.skippedInvalid += 1;
    }
  }

  private evictOldest() {
    let oldest: string | null = null;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [mint, at] of this.lastSeen) if (at < oldestAt) {
      oldest = mint;
      oldestAt = at;
    }
    if (oldest) {
      this.candles.delete(oldest);
      this.dirty.delete(oldest);
      this.lastSeen.delete(oldest);
    }
  }

  /** Writes the changed buckets (only those) and drops old in-memory candles. */
  async flush() {
    const ttl = this.deps.ttlSeconds ?? 6 * 3600;
    const retention = this.deps.retentionMs ?? 2 * 3600_000;
    const now = this.now();
    for (const [mint, buckets] of [...this.dirty.entries()]) {
      this.dirty.delete(mint);
      const series = this.candles.get(mint);
      if (!series) continue;
      const values: Record<string, string> = {};
      for (const bucket of buckets) {
        const candle = series.get(bucket);
        if (candle) values[String(bucket)] = JSON.stringify(candle);
      }
      if (!Object.keys(values).length) continue;
      const key = `${CANDLE_KEY_PREFIX}${mint}`;
      try {
        await this.deps.store.hSet(key, values);
        await this.deps.store.expire(key, ttl);
        this.metrics.flushedBuckets += Object.keys(values).length;
      } catch {
        this.metrics.flushFailures += 1;
        // Retry these buckets on the next flush.
        const again = this.dirty.get(mint) ?? new Set<number>();
        for (const bucket of buckets) again.add(bucket);
        this.dirty.set(mint, again);
      }
    }
    for (const [mint, series] of this.candles) {
      for (const bucket of series.keys()) if (now - bucket > retention) series.delete(bucket);
      if (!series.size) {
        this.candles.delete(mint);
        this.lastSeen.delete(mint);
      }
    }
  }

  snapshot() {
    return { ...this.metrics, mints: this.candles.size };
  }
}
