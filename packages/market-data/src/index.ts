import type { Prisma, PrismaClient } from '@prisma/client';

export interface TokenMetadata {
  address: string;
  symbol?: string;
  name?: string;
  decimals?: number;
  tokenAgeSeconds?: number;
  poolAgeSeconds?: number;
  /** Token logo URL from the provider (https only). */
  imageUrl?: string;
}

/** Only plain https image URLs are kept (no data:, javascript:, http:). */
export function safeImageUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 500) return undefined;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

export interface HolderData {
  count?: number;
  topHolders?: Array<{ address: string; percentage?: number }>;
  [key: string]: unknown;
}

export interface TokenMarketSnapshot {
  metadata: TokenMetadata;
  timestamp: Date;
  priceUsd?: number;
  priceNative?: number;
  liquidityUsd?: number;
  volume24h?: number;
  marketCap?: number;
  fdv?: number;
  transactionCount?: number;
  buyVolume?: number;
  sellVolume?: number;
  buyCount24h?: number;
  sellCount24h?: number;
  holderData?: HolderData;
  liquidityChange24h?: number;
  tradeActivity?: number;
  priceChange1h?: number;
  priceChange24h?: number;
  /** Rolling short windows as reported by the provider (undefined when the provider does not report them). */
  priceChange5m?: number;
  volume5m?: number;
  volume1h?: number;
  buyCount5m?: number;
  sellCount5m?: number;
  buyCount1h?: number;
  sellCount1h?: number;
  dexId?: string;
  poolAddress?: string;
  quoteToken?: TokenMetadata;
  provider: string;
  dataQuality?: 'VALID' | 'PARTIAL' | 'STALE' | 'INVALID';
}

export interface MarketDataProvider {
  readonly name: string;
  getTokenSnapshot(address: string): Promise<TokenMarketSnapshot | null>;
}

export interface MarketDataEnvironment {
  MARKET_DATA_PROVIDER_URL?: string;
  MARKET_DATA_CACHE_TTL_SECONDS?: string;
  MARKET_DATA_POLL_INTERVAL_MS?: string;
  MARKET_DATA_REQUEST_TIMEOUT_MS?: string;
}

export interface MarketDataRuntimeConfig {
  providerUrl: string;
  cacheTtlSeconds: number;
  pollIntervalMs: number;
  requestTimeoutMs: number;
}

function positiveInteger(value: string | undefined, name: string, fallback: number) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return parsed;
}

export function loadMarketDataRuntimeConfig(environment: MarketDataEnvironment = process.env): MarketDataRuntimeConfig {
  if (!environment.MARKET_DATA_PROVIDER_URL) {
    throw new Error('MARKET_DATA_PROVIDER_URL is required');
  }

  try {
    const url = new URL(environment.MARKET_DATA_PROVIDER_URL);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error();
    }
  } catch {
    throw new Error('MARKET_DATA_PROVIDER_URL must be a valid HTTP URL');
  }

  return {
    providerUrl: environment.MARKET_DATA_PROVIDER_URL,
    cacheTtlSeconds: positiveInteger(environment.MARKET_DATA_CACHE_TTL_SECONDS, 'MARKET_DATA_CACHE_TTL_SECONDS', 30),
    pollIntervalMs: positiveInteger(environment.MARKET_DATA_POLL_INTERVAL_MS, 'MARKET_DATA_POLL_INTERVAL_MS', 15_000),
    requestTimeoutMs: positiveInteger(environment.MARKET_DATA_REQUEST_TIMEOUT_MS, 'MARKET_DATA_REQUEST_TIMEOUT_MS', 5_000),
  };
}

export class CompositeMarketDataProvider implements MarketDataProvider {
  readonly name: string;

  constructor(private readonly providers: MarketDataProvider[], name = 'composite') {
    if (providers.length === 0) {
      throw new Error('At least one market-data provider is required');
    }
    this.name = name;
  }

  async getTokenSnapshot(address: string) {
    const errors: string[] = [];
    for (const provider of this.providers) {
      try {
        const snapshot = await provider.getTokenSnapshot(address);
        if (snapshot) {
          return snapshot;
        }
      } catch (error) {
        errors.push(`${provider.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (errors.length > 0) {
      throw new ProviderRequestError(`All market-data providers failed: ${errors.join('; ')}`);
    }
    return null;
  }
}

export interface RealtimeMarketDataProvider extends MarketDataProvider {
  subscribe(addresses: string[], onUpdate: (snapshot: TokenMarketSnapshot) => void, onError?: (error: Error) => void): Promise<() => Promise<void> | void>;
}

export type SnapshotParser = (payload: unknown, address: string, providerName: string) => TokenMarketSnapshot | null;
export type FetchResponse = { ok: boolean; status: number; json(): Promise<unknown> };
export type Fetcher = (input: URL, init: { headers?: Record<string, string>; signal: unknown }) => Promise<FetchResponse>;

export class ProviderRequestError extends Error {
  constructor(message: string, readonly retryable = true) {
    super(message);
    this.name = 'ProviderRequestError';
  }
}

export class HttpMarketDataProvider implements MarketDataProvider {
  constructor(
    readonly name: string,
    private readonly endpoint: string,
    private readonly parseSnapshot: SnapshotParser,
    private readonly options: { timeoutMs?: number; retries?: number; headers?: Record<string, string>; fetcher?: Fetcher } = {},
  ) {}

  async getTokenSnapshot(address: string): Promise<TokenMarketSnapshot | null> {
    const fetcher = this.options.fetcher ?? ((input, init) => globalThis.fetch(input, init as unknown as Parameters<typeof globalThis.fetch>[1]));
    const retries = this.options.retries ?? 2;
    let lastError: unknown;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const controller = new globalThis.AbortController();
      const timeoutMs = this.options.timeoutMs ?? 5_000;
      let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;
      try {
        const url = new URL(this.endpoint);
        url.searchParams.set('address', address);
        const request = fetcher(url, { headers: this.options.headers, signal: controller.signal });
        const response = await Promise.race([
          request,
          new Promise<FetchResponse>((_, reject) => {
            timeout = globalThis.setTimeout(() => {
              controller.abort();
              reject(new ProviderRequestError(`Provider ${this.name} timed out`));
            }, timeoutMs);
          }),
        ]);
        if (response.status === 429 || response.status >= 500) {
          throw new ProviderRequestError(`Provider ${this.name} returned HTTP ${response.status}`);
        }
        if (!response.ok) {
          throw new ProviderRequestError(`Provider ${this.name} returned HTTP ${response.status}`, false);
        }

        return this.parseSnapshot(await response.json(), address, this.name);
      } catch (error) {
        lastError = error instanceof Error && error.name === 'AbortError'
          ? new ProviderRequestError(`Provider ${this.name} timed out`)
          : error;
        if (lastError instanceof ProviderRequestError && !lastError.retryable) {
          throw lastError;
        }
      } finally {
        if (timeout) {
          globalThis.clearTimeout(timeout);
        }
      }
    }

    throw lastError instanceof Error ? lastError : new ProviderRequestError(`Provider ${this.name} failed`);
  }
}

export interface MarketDataCache {
  get(key: string): Promise<TokenMarketSnapshot | null>;
  set(key: string, snapshot: TokenMarketSnapshot, ttlSeconds: number): Promise<void>;
}

export class MemoryMarketDataCache implements MarketDataCache {
  private readonly entries = new Map<string, { snapshot: TokenMarketSnapshot; expiresAt: number }>();

  async get(key: string) {
    const entry = this.entries.get(key);
    if (!entry || entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return null;
    }

    return entry.snapshot;
  }

  async set(key: string, snapshot: TokenMarketSnapshot, ttlSeconds: number) {
    this.entries.set(key, { snapshot, expiresAt: Date.now() + ttlSeconds * 1000 });
  }
}

export interface RedisMarketDataClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options: { EX: number }): Promise<unknown>;
}

export class RedisMarketDataCache implements MarketDataCache {
  constructor(private readonly client: RedisMarketDataClient, private readonly prefix = 'soltrader:market-data') {}

  async get(key: string) {
    const value = await this.client.get(`${this.prefix}:${key}`);
    if (!value) {
      return null;
    }

    try {
      const parsed = JSON.parse(value) as TokenMarketSnapshot;
      return { ...parsed, timestamp: new Date(parsed.timestamp) };
    } catch {
      return null;
    }
  }

  async set(key: string, snapshot: TokenMarketSnapshot, ttlSeconds: number) {
    await this.client.set(`${this.prefix}:${key}`, JSON.stringify(snapshot), { EX: ttlSeconds });
  }
}

export interface MarketDataRepository {
  save(snapshot: TokenMarketSnapshot): Promise<void>;
}

export class PrismaMarketDataRepository implements MarketDataRepository {
  constructor(private readonly prisma: Pick<PrismaClient, 'token' | 'tokenMetric'>) {}

  async save(snapshot: TokenMarketSnapshot) {
    const metadata = snapshot.metadata;
    const token = await this.prisma.token.upsert({
      where: { address: metadata.address },
      update: {
        symbol: metadata.symbol ?? metadata.address.slice(0, 8),
        name: metadata.name,
        decimals: metadata.decimals,
        priceUsd: snapshot.priceUsd,
        marketCap: snapshot.marketCap,
        fdv: snapshot.fdv,
        volume24h: snapshot.volume24h,
        ...(metadata.imageUrl ? { imageUrl: metadata.imageUrl } : {}),
      },
      create: {
        address: metadata.address,
        symbol: metadata.symbol ?? metadata.address.slice(0, 8),
        name: metadata.name,
        decimals: metadata.decimals ?? 9,
        imageUrl: metadata.imageUrl ?? null,
        priceUsd: snapshot.priceUsd,
        marketCap: snapshot.marketCap,
        fdv: snapshot.fdv,
        volume24h: snapshot.volume24h,
      },
    });

    await this.prisma.tokenMetric.create({
      data: {
        tokenId: token.id,
        timestamp: snapshot.timestamp,
        priceUsd: snapshot.priceUsd,
        priceNative: snapshot.priceNative,
        liquidityUsd: snapshot.liquidityUsd,
        volume24h: snapshot.volume24h,
        marketCap: snapshot.marketCap,
        fdv: snapshot.fdv,
        transactionCount: snapshot.transactionCount,
        buyVolume: snapshot.buyVolume,
        sellVolume: snapshot.sellVolume,
        buyCount24h: snapshot.buyCount24h,
        sellCount24h: snapshot.sellCount24h,
        tokenAgeSeconds: metadata.tokenAgeSeconds,
        poolAgeSeconds: metadata.poolAgeSeconds,
        liquidityChange24h: snapshot.liquidityChange24h,
        tradeActivity: snapshot.tradeActivity,
        holders: snapshot.holderData?.count,
        holderData: snapshot.holderData as Prisma.InputJsonValue | undefined,
        priceChange1h: snapshot.priceChange1h,
        priceChange24h: snapshot.priceChange24h,
        priceChange5m: snapshot.priceChange5m,
        volume5m: snapshot.volume5m,
        volume1h: snapshot.volume1h,
        buyCount5m: snapshot.buyCount5m,
        sellCount5m: snapshot.sellCount5m,
        buyCount1h: snapshot.buyCount1h,
        sellCount1h: snapshot.sellCount1h,
        provider: snapshot.provider,
        dataQuality: snapshot.dataQuality,
        dexId: snapshot.dexId,
        poolAddress: snapshot.poolAddress,
        quoteToken: snapshot.quoteToken as Prisma.InputJsonValue | undefined,
      },
    });
  }
}

export interface MonitorResult {
  address: string;
  ok: boolean;
  snapshot?: TokenMarketSnapshot;
  error?: string;
}

export class TokenMonitor {
  private pollingTimer: ReturnType<typeof globalThis.setInterval> | undefined;

  constructor(
    private readonly provider: MarketDataProvider,
    private readonly dependencies: { cache?: MarketDataCache; repository?: MarketDataRepository; cacheTtlSeconds?: number } = {},
  ) {}

  async refreshToken(address: string): Promise<MonitorResult> {
    const cacheKey = address.toLowerCase();
    try {
      const cached = await this.dependencies.cache?.get(cacheKey);
      if (cached) {
        return { address, ok: true, snapshot: cached };
      }

      const snapshot = await this.provider.getTokenSnapshot(address);
      if (!snapshot) {
        return { address, ok: false, error: 'Provider returned no data' };
      }

      await this.dependencies.cache?.set(cacheKey, snapshot, this.dependencies.cacheTtlSeconds ?? 30);
      await this.dependencies.repository?.save(snapshot);
      return { address, ok: true, snapshot };
    } catch (error) {
      return { address, ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async refreshTokens(addresses: string[]) {
    return Promise.all(addresses.map((address) => this.refreshToken(address)));
  }

  startPolling(addresses: string[], intervalMs: number, onResult?: (results: MonitorResult[]) => void) {
    if (intervalMs <= 0) {
      throw new Error('Polling interval must be positive');
    }

    this.stopPolling();
    this.pollingTimer = globalThis.setInterval(() => {
      void this.refreshTokens(addresses).then((results) => onResult?.(results));
    }, intervalMs);
    return () => this.stopPolling();
  }

  stopPolling() {
    if (this.pollingTimer) {
      globalThis.clearInterval(this.pollingTimer);
      this.pollingTimer = undefined;
    }
  }
}

export function buildSignal(symbol: string, score: number) {
  const phase = score > 80 ? 'high-priority' : score > 60 ? 'monitoring' : 'watchlist';
  return { symbol, score, phase, source: 'scanner' as const };
}

export * from './providers.js';
