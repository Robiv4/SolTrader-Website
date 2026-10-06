import { ProviderRequestError, safeImageUrl, type Fetcher, type FetchResponse, type MarketDataProvider, type TokenMarketSnapshot, type TokenMetadata } from './index.js';

export interface PoolData {
  poolAddress: string;
  dexId: string;
  chainId: string;
  baseToken: TokenMetadata;
  quoteToken: TokenMetadata;
  priceUsd?: number;
  priceNative?: number;
  liquidityUsd?: number;
  liquidityBase?: number;
  liquidityQuote?: number;
  volume24h?: number;
  buyCount24h?: number;
  sellCount24h?: number;
  priceChange1h?: number;
  priceChange24h?: number;
  priceChange5m?: number;
  volume5m?: number;
  volume1h?: number;
  buyCount5m?: number;
  sellCount5m?: number;
  buyCount1h?: number;
  sellCount1h?: number;
  pairCreatedAt?: Date;
  fdv?: number;
  marketCap?: number;
  url?: string;
}

export interface RecentTrade {
  side: 'buy' | 'sell';
  priceUsd?: number;
  amountUsd?: number;
  timestamp: Date;
  signature?: string;
}

export interface DiscoveredTokenSummary {
  address: string;
  chainId: string;
  symbol?: string;
  name?: string;
  discoveredAt: Date;
  source: string;
}

function numberValue(value: unknown) {
  const text = typeof value === 'string' ? value.trim() : value;
  const parsed = typeof text === 'number' ? text : Number(text);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export class ProviderNotSupportedError extends Error {
  constructor(providerName: string, capability: string) {
    super(`Provider ${providerName} does not support ${capability}`);
    this.name = 'ProviderNotSupportedError';
  }
}

/**
 * Extended provider contract for the token-discovery pipeline. Implementations must return
 * only data obtained from a real upstream source; unsupported capabilities must throw
 * ProviderNotSupportedError rather than fabricating values.
 */
export interface TokenDataProvider extends MarketDataProvider {
  discoverTokens(limit?: number): Promise<DiscoveredTokenSummary[]>;
  getTokenMetrics(address: string): Promise<TokenMarketSnapshot | null>;
  getPrice(address: string): Promise<number | null>;
  getLiquidity(address: string): Promise<number | null>;
  getVolume(address: string): Promise<number | null>;
  getPoolData(address: string): Promise<PoolData[]>;
  getRecentTrades(address: string, limit?: number): Promise<RecentTrade[]>;
  getTokenMetadata(address: string): Promise<TokenMetadata | null>;
}

export abstract class BaseTokenDataProvider implements TokenDataProvider {
  abstract readonly name: string;
  abstract discoverTokens(limit?: number): Promise<DiscoveredTokenSummary[]>;
  abstract getPoolData(address: string): Promise<PoolData[]>;
  abstract getRecentTrades(address: string, limit?: number): Promise<RecentTrade[]>;

  async getTokenSnapshot(address: string): Promise<TokenMarketSnapshot | null> {
    return this.getTokenMetrics(address);
  }

  async getTokenMetrics(address: string): Promise<TokenMarketSnapshot | null> {
    const pools = await this.getPoolData(address);
    if (pools.length === 0) {
      return null;
    }

    const ranked = [...pools].filter((pool) => pool.chainId === 'solana' && pool.baseToken.address.toLowerCase() === address.toLowerCase()).sort((left, right) => {
      const completeness = (pool: PoolData) => [pool.priceUsd, pool.liquidityUsd, pool.volume24h, pool.baseToken.symbol].filter((value) => value !== undefined).length;
      return (right.liquidityUsd ?? 0) - (left.liquidityUsd ?? 0) || completeness(right) - completeness(left) || left.dexId.localeCompare(right.dexId) || left.poolAddress.localeCompare(right.poolAddress);
    });
    if (ranked.length === 0) return null;
    const primary = ranked[0];
    const total = (selector: (pool: PoolData) => number | undefined) => {
      const values = ranked.map(selector).filter((value): value is number => value !== undefined && Number.isFinite(value));
      return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) : undefined;
    };
    const now = new Date();
    const ageSeconds = primary.pairCreatedAt ? Math.max(0, Math.floor((now.getTime() - primary.pairCreatedAt.getTime()) / 1000)) : undefined;
    const buyCount = total((pool) => pool.buyCount24h);
    const sellCount = total((pool) => pool.sellCount24h);
    const transactionCount = buyCount !== undefined || sellCount !== undefined
      ? (buyCount ?? 0) + (sellCount ?? 0)
      : undefined;

    return {
      metadata: {
        address,
        symbol: primary.baseToken.symbol ?? ranked.map((pool) => pool.baseToken.symbol).find(Boolean),
        name: primary.baseToken.name ?? ranked.map((pool) => pool.baseToken.name).find(Boolean),
        tokenAgeSeconds: ageSeconds,
        poolAgeSeconds: ageSeconds,
        imageUrl: ranked.map((pool) => pool.baseToken.imageUrl).find(Boolean),
      },
      timestamp: now,
      priceUsd: primary.priceUsd,
      priceNative: primary.priceNative,
      liquidityUsd: total((pool) => pool.liquidityUsd),
      volume24h: total((pool) => pool.volume24h),
      transactionCount,
      buyCount24h: total((pool) => pool.buyCount24h),
      sellCount24h: total((pool) => pool.sellCount24h),
      priceChange1h: primary.priceChange1h,
      priceChange24h: primary.priceChange24h,
      // Short windows: price change of the primary pool; volumes and trade counts summed over all pools.
      priceChange5m: primary.priceChange5m,
      volume5m: total((pool) => pool.volume5m),
      volume1h: total((pool) => pool.volume1h),
      buyCount5m: total((pool) => pool.buyCount5m),
      sellCount5m: total((pool) => pool.sellCount5m),
      buyCount1h: total((pool) => pool.buyCount1h),
      sellCount1h: total((pool) => pool.sellCount1h),
      marketCap: primary.marketCap,
      fdv: primary.fdv,
      dexId: primary.dexId,
      poolAddress: primary.poolAddress,
      quoteToken: primary.quoteToken,
      provider: this.name,
      dataQuality: primary.priceUsd !== undefined && primary.priceUsd > 0
        ? primary.liquidityUsd !== undefined ? 'VALID' : 'PARTIAL'
        : 'INVALID',
    };
  }

  async getPrice(address: string): Promise<number | null> {
    const snapshot = await this.getTokenMetrics(address);
    return snapshot?.priceUsd ?? null;
  }

  async getLiquidity(address: string): Promise<number | null> {
    const snapshot = await this.getTokenMetrics(address);
    return snapshot?.liquidityUsd ?? null;
  }

  async getVolume(address: string): Promise<number | null> {
    const snapshot = await this.getTokenMetrics(address);
    return snapshot?.volume24h ?? null;
  }

  async getTokenMetadata(address: string): Promise<TokenMetadata | null> {
    const pools = await this.getPoolData(address);
    if (pools.length === 0) {
      return null;
    }
    const primary = pools[0];
    return { address, symbol: primary.baseToken.symbol, name: primary.baseToken.name };
  }
}

export interface DexscreenerProviderOptions {
  baseUrl?: string;
  timeoutMs?: number;
  retries?: number;
  fetcher?: Fetcher;
  chainId?: string;
}

const DEXSCREENER_DEFAULT_BASE_URL = 'https://api.dexscreener.com';

interface DexscreenerTokenProfile {
  chainId?: unknown;
  tokenAddress?: unknown;
  description?: unknown;
}

/**
 * Real Dexscreener public REST API adapter (no API key required). No data is fabricated:
 * fields with no upstream equivalent (e.g. raw trade fills) are left unsupported.
 */
export class DexscreenerProvider extends BaseTokenDataProvider {
  readonly name = 'dexscreener';

  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly fetcher: Fetcher;
  private readonly chainId: string;

  constructor(options: DexscreenerProviderOptions = {}) {
    super();
    this.baseUrl = options.baseUrl ?? DEXSCREENER_DEFAULT_BASE_URL;
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.retries = options.retries ?? 2;
    this.chainId = options.chainId ?? 'solana';
    this.fetcher = options.fetcher ?? ((input, init) => globalThis.fetch(input, init as unknown as Parameters<typeof globalThis.fetch>[1]));
  }

  private async request(path: string): Promise<unknown> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      const controller = new globalThis.AbortController();
      let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;
      try {
        const url = new URL(path, this.baseUrl);
        const request = this.fetcher(url, { signal: controller.signal });
        const response = await Promise.race([
          request,
          new Promise<FetchResponse>((_, reject) => {
            timeout = globalThis.setTimeout(() => {
              controller.abort();
              reject(new ProviderRequestError(`Provider ${this.name} timed out`));
            }, this.timeoutMs);
          }),
        ]);

        if (response.status === 429 || response.status >= 500) {
          throw new ProviderRequestError(`Provider ${this.name} returned HTTP ${response.status}`);
        }
        if (!response.ok) {
          throw new ProviderRequestError(`Provider ${this.name} returned HTTP ${response.status}`, false);
        }

        return await response.json();
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

  /**
   * Merges several DexScreener discovery feeds (latest profiles, latest and top boosts, community takeovers,
   * promoted tokens), keeping the first occurrence of each token. Each feed only yields ~7-20 Solana tokens,
   * so combining them keeps the scanner's rotating pool supplied. Fails only when every feed fails.
   */
  async discoverTokens(limit = 30): Promise<DiscoveredTokenSummary[]> {
    const feeds = ['/token-profiles/latest/v1', '/token-boosts/latest/v1', '/token-boosts/top/v1', '/community-takeovers/latest/v1', '/ads/latest/v1'];
    const results = await Promise.allSettled(feeds.map((path) => this.request(path)));
    const fulfilled = results.filter((result): result is PromiseFulfilledResult<unknown> => result.status === 'fulfilled');
    if (fulfilled.length === 0) {
      const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
      throw failure?.reason instanceof Error ? failure.reason : new ProviderRequestError(`Provider ${this.name} discovery failed`);
    }
    const seen = new Set<string>();
    const items = fulfilled.flatMap((result) => (Array.isArray(result.value) ? result.value : []) as DexscreenerTokenProfile[])
      .filter((item) => {
        if (!item || item.chainId !== this.chainId || typeof item.tokenAddress !== 'string' || seen.has(item.tokenAddress)) return false;
        seen.add(item.tokenAddress);
        return true;
      });

    const now = new Date();
    return items
      .slice(0, limit)
      .map((item) => ({
        address: item.tokenAddress as string,
        chainId: this.chainId,
        name: typeof item.description === 'string' ? item.description : undefined,
        discoveredAt: now,
        source: this.name,
      }));
  }

  async getPoolData(address: string): Promise<PoolData[]> {
    const payload = await this.request(`/latest/dex/tokens/${encodeURIComponent(address)}`);
    const pairs = (payload as { pairs?: unknown[] } | null)?.pairs;
    if (!Array.isArray(pairs)) {
      return [];
    }

    return pairs
      .filter((pair): pair is Record<string, unknown> => Boolean(pair) && typeof pair === 'object')
      .filter((pair) => pair.chainId === this.chainId)
      .map((pair) => this.parsePair(pair));
  }

  async getRecentTrades(): Promise<RecentTrade[]> {
    throw new ProviderNotSupportedError(this.name, 'getRecentTrades');
  }

  private parsePair(pair: Record<string, unknown>): PoolData {
    const baseToken = pair.baseToken as { address?: string; name?: string; symbol?: string } | undefined;
    const quoteToken = pair.quoteToken as { address?: string; name?: string; symbol?: string } | undefined;
    const info = pair.info as { imageUrl?: unknown } | undefined;
    const liquidity = pair.liquidity as { usd?: number; base?: number; quote?: number } | undefined;
    const volume = pair.volume as { m5?: number; h1?: number; h24?: number } | undefined;
    const priceChange = pair.priceChange as { m5?: number; h1?: number; h24?: number } | undefined;
    const txns = pair.txns as { m5?: { buys?: number; sells?: number }; h1?: { buys?: number; sells?: number }; h24?: { buys?: number; sells?: number } } | undefined;

    return {
      poolAddress: String(pair.pairAddress ?? ''),
      dexId: String(pair.dexId ?? 'unknown'),
      chainId: String(pair.chainId ?? this.chainId),
      baseToken: { address: baseToken?.address ?? '', symbol: baseToken?.symbol, name: baseToken?.name, imageUrl: safeImageUrl(info?.imageUrl) },
      quoteToken: { address: quoteToken?.address ?? '', symbol: quoteToken?.symbol, name: quoteToken?.name },
      priceUsd: numberValue(pair.priceUsd),
      priceNative: numberValue(pair.priceNative),
      liquidityUsd: numberValue(liquidity?.usd),
      liquidityBase: numberValue(liquidity?.base),
      liquidityQuote: numberValue(liquidity?.quote),
      volume24h: numberValue(volume?.h24),
      buyCount24h: numberValue(txns?.h24?.buys),
      sellCount24h: numberValue(txns?.h24?.sells),
      priceChange1h: numberValue(priceChange?.h1),
      priceChange24h: numberValue(priceChange?.h24),
      priceChange5m: numberValue(priceChange?.m5),
      volume5m: numberValue(volume?.m5),
      volume1h: numberValue(volume?.h1),
      buyCount5m: numberValue(txns?.m5?.buys),
      sellCount5m: numberValue(txns?.m5?.sells),
      buyCount1h: numberValue(txns?.h1?.buys),
      sellCount1h: numberValue(txns?.h1?.sells),
      pairCreatedAt: typeof pair.pairCreatedAt === 'number' ? new Date(pair.pairCreatedAt) : undefined,
      fdv: numberValue(pair.fdv),
      marketCap: numberValue(pair.marketCap),
      url: typeof pair.url === 'string' ? pair.url : undefined,
    };
  }
}

export interface MarketDataProviderFactoryEnvironment {
  MARKET_DATA_PROVIDER?: string;
  MARKET_DATA_REQUEST_TIMEOUT_MS?: string;
}

/**
 * Provider factory so the rest of the codebase depends on the TokenDataProvider abstraction
 * instead of a specific vendor. Add new `case` branches to support additional providers
 * (e.g. Birdeye, Helius) without touching callers.
 */
export function createMarketDataProvider(environment: MarketDataProviderFactoryEnvironment = process.env): TokenDataProvider {
  const providerName = (environment.MARKET_DATA_PROVIDER ?? 'dexscreener').toLowerCase();
  const timeoutMs = environment.MARKET_DATA_REQUEST_TIMEOUT_MS ? Number(environment.MARKET_DATA_REQUEST_TIMEOUT_MS) : undefined;

  switch (providerName) {
    case 'dexscreener':
      return new DexscreenerProvider({ timeoutMs });
    default:
      throw new Error(`Unsupported MARKET_DATA_PROVIDER "${providerName}". Supported providers: dexscreener`);
  }
}
