/**
 * Chart data for the token page. Strict data-honesty rules:
 *  1. Real OHLCV only: candles come from actual time-stamped trades (the worker's pump.fun trade-stream candles) or from
 *     a reliable OHLCV provider (GeckoTerminal, pool tokens). Sampled price points are NEVER turned into candles.
 *  2. Without real OHLCV the chart is a line of the stored price points.
 *  3. Gaps (no trades / no samples) are reported, never filled. A timeframe is only offered when the data density
 *     supports it.
 */

export interface Candle { t: number; o: number; h: number; l: number; c: number; v: number; n?: number }
export interface PricePoint { t: number; price: number }

export const TIMEFRAMES: Record<string, number> = { '5s': 5_000, '15s': 15_000, '1m': 60_000, '5m': 300_000, '15m': 900_000, '1h': 3_600_000 };
/** Minimum number of candles in the window for a timeframe to be offered. */
export const MIN_CANDLES = 8;

/** Aggregates real base candles into a coarser timeframe (o = first, c = last, h = max, l = min, v / n = sum). */
export function aggregateCandles(base: Candle[], timeframeMs: number): Candle[] {
  const sorted = [...base].sort((a, b) => a.t - b.t);
  const out: Candle[] = [];
  for (const candle of sorted) {
    const bucket = Math.floor(candle.t / timeframeMs) * timeframeMs;
    const last = out.at(-1);
    if (last && last.t === bucket) {
      last.h = Math.max(last.h, candle.h);
      last.l = Math.min(last.l, candle.l);
      last.c = candle.c;
      last.v += candle.v;
      last.n = (last.n ?? 0) + (candle.n ?? 0);
    } else {
      out.push({ t: bucket, o: candle.o, h: candle.h, l: candle.l, c: candle.c, v: candle.v, n: candle.n ?? 0 });
    }
  }
  return out;
}

/** Intervals with no data longer than `minGapMs` (between consecutive candles / points). */
export function findGaps(times: number[], minGapMs: number) {
  const gaps: Array<{ from: number; to: number }> = [];
  const sorted = [...times].sort((a, b) => a - b);
  for (let index = 1; index < sorted.length; index += 1) if (sorted[index] - sorted[index - 1] > minGapMs) gaps.push({ from: sorted[index - 1], to: sorted[index] });
  return gaps;
}

/** Timeframes the base candles can fill in the window (base resolution or coarser, at least MIN_CANDLES candles). */
export function availableTimeframes(base: Candle[], baseMs: number, from: number, to: number) {
  const inWindow = base.filter((candle) => candle.t >= from && candle.t <= to);
  return Object.entries(TIMEFRAMES).filter(([, ms]) => ms >= baseMs && aggregateCandles(inWindow, ms).length >= MIN_CANDLES).map(([key]) => key);
}

/** Stored trade-stream candles (Redis hash values) -> validated candles. Invalid rows are dropped. */
export function parseStoredCandles(hash: Record<string, string>): Candle[] {
  const out: Candle[] = [];
  for (const value of Object.values(hash)) {
    try {
      const candle = JSON.parse(value) as Candle;
      const fields = [candle.t, candle.o, candle.h, candle.l, candle.c, candle.v];
      if (fields.every((field) => typeof field === 'number' && Number.isFinite(field)) && candle.o > 0 && candle.h >= candle.l && candle.l > 0) out.push(candle);
    } catch {
      // skip
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

/** GeckoTerminal ohlcv_list ([[unix_seconds, o, h, l, c, volume_usd], ...], newest first) -> candles. */
export function parseGeckoOhlcv(body: unknown): Candle[] {
  const list = (body as { data?: { attributes?: { ohlcv_list?: unknown[] } } } | null)?.data?.attributes?.ohlcv_list;
  if (!Array.isArray(list)) return [];
  const out: Candle[] = [];
  for (const row of list) {
    if (!Array.isArray(row) || row.length < 6) continue;
    const [t, o, h, l, c, v] = row.map(Number);
    if ([t, o, h, l, c, v].every(Number.isFinite) && o > 0 && h >= l && l > 0) out.push({ t: t * 1000, o, h, l, c, v });
  }
  return out.sort((a, b) => a.t - b.t);
}

/** GeckoTerminal endpoint path for a timeframe. */
export function geckoTimeframe(timeframe: string): { period: 'minute' | 'hour'; aggregate: number } | null {
  if (timeframe === '1m') return { period: 'minute', aggregate: 1 };
  if (timeframe === '5m') return { period: 'minute', aggregate: 5 };
  if (timeframe === '15m') return { period: 'minute', aggregate: 15 };
  if (timeframe === '1h') return { period: 'hour', aggregate: 1 };
  return null;
}

type FetchJson = (url: string) => Promise<unknown>;

/** GeckoTerminal client: cached, globally rate-limited (public API), never throws (null = unavailable). */
export class GeckoTerminalOhlcv {
  private readonly pools = new Map<string, { at: number; pool: string | null }>();
  private readonly series = new Map<string, { at: number; candles: Candle[] }>();
  private window = { start: 0, used: 0 };

  constructor(private readonly fetchJson: FetchJson, private readonly options: { perMinute?: number; now?: () => number } = {}) {}

  private now() {
    return this.options.now?.() ?? Date.now();
  }

  private allow() {
    if (this.now() - this.window.start >= 60_000) this.window = { start: this.now(), used: 0 };
    if (this.window.used >= (this.options.perMinute ?? 20)) return false;
    this.window.used += 1;
    return true;
  }

  private async pool(mint: string) {
    const cached = this.pools.get(mint);
    if (cached && this.now() - cached.at < 10 * 60_000) return cached.pool;
    if (!this.allow()) return cached?.pool ?? null;
    const body = await this.fetchJson(`https://api.geckoterminal.com/api/v2/networks/solana/tokens/${encodeURIComponent(mint)}/pools?page=1`).catch(() => null);
    const first = (body as { data?: Array<{ attributes?: { address?: string } }> } | null)?.data?.[0]?.attributes?.address ?? null;
    this.pools.set(mint, { at: this.now(), pool: first });
    return first;
  }

  async candles(mint: string, timeframe: string): Promise<{ candles: Candle[]; pool: string } | null> {
    const spec = geckoTimeframe(timeframe);
    if (!spec) return null;
    const pool = await this.pool(mint);
    if (!pool) return null;
    const key = `${pool}:${timeframe}`;
    const cached = this.series.get(key);
    if (cached && this.now() - cached.at < 30_000) return { candles: cached.candles, pool };
    if (!this.allow()) return cached ? { candles: cached.candles, pool } : null;
    const body = await this.fetchJson(`https://api.geckoterminal.com/api/v2/networks/solana/pools/${encodeURIComponent(pool)}/ohlcv/${spec.period}?aggregate=${spec.aggregate}&limit=300&currency=usd&token=base`).catch(() => null);
    const candles = parseGeckoOhlcv(body);
    if (!candles.length) return cached ? { candles: cached.candles, pool } : null;
    this.series.set(key, { at: this.now(), candles });
    return { candles, pool };
  }
}
