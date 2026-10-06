import type { DiscoveredTokenSummary, PoolData, RecentTrade, TokenDataProvider, TokenMarketSnapshot, TokenMetadata } from '@soltrader/market-data';

export interface ThrottledProviderOptions {
  /** Upper bound of upstream requests per minute (DexScreener allows ~300/min on token endpoints). */
  requestsPerMinute?: number;
  /** How long a token snapshot is reused. */
  snapshotTtlMs?: number;
  /** How long a discovery result is reused (5 feeds per refresh; the feeds are limited to ~60 req/min). */
  discoveryTtlMs?: number;
  /** Global pause after the upstream answers HTTP 429. */
  rateLimitCooldownMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Wraps the market-data provider shared by the scanner, the strategy runner and paper execution so that
 * together they stay under the upstream rate limit: snapshots are cached and de-duplicated, discovery is
 * cached (falling back to the last good list on errors), requests are spaced out, and an HTTP 429 pauses
 * all upstream calls for a while instead of hammering the API.
 */
export class ThrottledTokenDataProvider implements TokenDataProvider {
  readonly name: string;
  private readonly minIntervalMs: number;
  private readonly snapshotTtlMs: number;
  private readonly discoveryTtlMs: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly snapshots = new Map<string, { value: TokenMarketSnapshot | null; at: number }>();
  private readonly inflight = new Map<string, Promise<TokenMarketSnapshot | null>>();
  private discovery?: { value: DiscoveredTokenSummary[]; at: number; limit: number };
  private nextSlot = 0;
  private pausedUntil = 0;

  constructor(private readonly inner: TokenDataProvider, options: ThrottledProviderOptions = {}) {
    this.name = inner.name;
    this.minIntervalMs = 60_000 / (options.requestsPerMinute ?? 240);
    this.snapshotTtlMs = options.snapshotTtlMs ?? 20_000;
    this.discoveryTtlMs = options.discoveryTtlMs ?? 30_000;
    this.cooldownMs = options.rateLimitCooldownMs ?? 30_000;
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => globalThis.setTimeout(resolve, ms)));
  }

  async discoverTokens(limit = 30): Promise<DiscoveredTokenSummary[]> {
    const cached = this.discovery;
    if (cached && cached.limit >= limit && this.now() - cached.at < this.discoveryTtlMs) return cached.value.slice(0, limit);
    try {
      const value = await this.schedule(() => this.inner.discoverTokens(limit));
      this.discovery = { value, at: this.now(), limit };
      return value;
    } catch (error) {
      // Keep scanning the last good list while the feed is unavailable or rate limited.
      if (cached) return cached.value.slice(0, limit);
      throw error;
    }
  }

  async getTokenMetrics(address: string): Promise<TokenMarketSnapshot | null> {
    return this.getFreshTokenMetrics(address, this.snapshotTtlMs);
  }

  /** Like getTokenMetrics, but reuses a cached snapshot only when it is younger than `maxAgeMs` (entries and exits). */
  async getFreshTokenMetrics(address: string, maxAgeMs: number): Promise<TokenMarketSnapshot | null> {
    const key = address.toLowerCase();
    const cached = this.snapshots.get(key);
    if (cached && this.now() - cached.at < Math.min(maxAgeMs, this.snapshotTtlMs)) return cached.value;
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const request = this.schedule(() => this.inner.getTokenMetrics(address))
      .then((value) => {
        this.snapshots.set(key, { value, at: this.now() });
        this.pruneSnapshots();
        return value;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, request);
    return request;
  }

  async getPrice(address: string) {
    return (await this.getTokenMetrics(address))?.priceUsd ?? null;
  }

  async getLiquidity(address: string) {
    return (await this.getTokenMetrics(address))?.liquidityUsd ?? null;
  }

  async getVolume(address: string) {
    return (await this.getTokenMetrics(address))?.volume24h ?? null;
  }

  async getTokenMetadata(address: string): Promise<TokenMetadata | null> {
    return (await this.getTokenMetrics(address))?.metadata ?? null;
  }

  getPoolData(address: string): Promise<PoolData[]> {
    return this.schedule(() => this.inner.getPoolData(address));
  }

  getRecentTrades(address: string, limit?: number): Promise<RecentTrade[]> {
    return this.schedule(() => this.inner.getRecentTrades(address, limit));
  }

  getTokenSnapshot(address: string) {
    return this.getTokenMetrics(address);
  }

  /** Spaces upstream calls out and honours a global pause after HTTP 429. */
  private async schedule<T>(call: () => Promise<T>): Promise<T> {
    const now = this.now();
    const slot = Math.max(now, this.nextSlot, this.pausedUntil);
    this.nextSlot = slot + this.minIntervalMs;
    if (slot > now) await this.sleep(slot - now);
    try {
      return await call();
    } catch (error) {
      if (error instanceof Error && /\b429\b/.test(error.message)) this.pausedUntil = this.now() + this.cooldownMs;
      throw error;
    }
  }

  private pruneSnapshots() {
    if (this.snapshots.size < 2000) return;
    const cutoff = this.now() - this.snapshotTtlMs;
    for (const [key, entry] of this.snapshots) if (entry.at < cutoff) this.snapshots.delete(key);
  }
}
