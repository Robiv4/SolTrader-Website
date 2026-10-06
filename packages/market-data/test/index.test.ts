import { describe, expect, it } from 'vitest';

import {
  HttpMarketDataProvider,
  MemoryMarketDataCache,
  RedisMarketDataCache,
  TokenMonitor,
  type MarketDataProvider,
  type TokenMarketSnapshot,
} from '../src/index.js';

const snapshot: TokenMarketSnapshot = {
  metadata: { address: 'TokenAddress', symbol: 'TKN', decimals: 9 },
  timestamp: new Date('2026-09-23T00:00:00.000Z'),
  priceUsd: 1.25,
  liquidityUsd: 1000,
  volume24h: 250,
  transactionCount: 12,
  buyVolume: 150,
  sellVolume: 100,
  provider: 'test-provider',
};

describe('HTTP market-data provider', () => {
  it('retries transient provider failures', async () => {
    let attempts = 0;
    const provider = new HttpMarketDataProvider('test-provider', 'https://provider.example.test/token', (payload, address, name) => ({
      ...snapshot,
      metadata: { ...snapshot.metadata, address },
      provider: name,
      priceUsd: (payload as { price: number }).price,
    }), {
      retries: 1,
      fetcher: async () => {
        attempts += 1;
        if (attempts === 1) {
          return { ok: false, status: 503 };
        }
        return { ok: true, status: 200, json: async () => ({ price: 2 }) };
      },
    });

    await expect(provider.getTokenSnapshot('TokenAddress')).resolves.toMatchObject({ priceUsd: 2 });
    expect(attempts).toBe(2);
  });

  it('fails a request after a timeout', async () => {
    const provider = new HttpMarketDataProvider('slow-provider', 'https://provider.example.test/token', () => snapshot, {
      timeoutMs: 5,
      retries: 0,
      fetcher: () => new Promise(() => undefined),
    });

    await expect(provider.getTokenSnapshot('TokenAddress')).rejects.toThrow('timed out');
  });
});

describe('market-data caches', () => {
  it('caches snapshots in memory', async () => {
    const cache = new MemoryMarketDataCache();
    await cache.set('token', snapshot, 30);
    await expect(cache.get('token')).resolves.toEqual(snapshot);
  });

  it('serializes snapshots through Redis', async () => {
    const values = new Map<string, string>();
    const client = {
      get: async (key: string) => values.get(key) ?? null,
      set: async (key: string, value: string) => {
        values.set(key, value);
      },
    };
    const cache = new RedisMarketDataCache(client);

    await cache.set('token', snapshot, 60);
    await expect(cache.get('token')).resolves.toEqual(snapshot);
    expect(values.get('soltrader:market-data:token')).toContain('TokenAddress');
  });
});

describe('token monitor', () => {
  it('isolates malformed provider data to one token', async () => {
    const provider: MarketDataProvider = {
      name: 'test-provider',
      getTokenSnapshot: async (address) => {
        if (address === 'malformed') {
          throw new Error('malformed provider payload');
        }
        return { ...snapshot, metadata: { ...snapshot.metadata, address } };
      },
    };
    const monitor = new TokenMonitor(provider, { cache: new MemoryMarketDataCache() });

    const results = await monitor.refreshTokens(['good', 'malformed']);
    expect(results[0]).toMatchObject({ address: 'good', ok: true });
    expect(results[1]).toMatchObject({ address: 'malformed', ok: false, error: 'malformed provider payload' });
  });

  it('does not poll with an invalid interval', () => {
    const provider: MarketDataProvider = { name: 'test-provider', getTokenSnapshot: async () => snapshot };
    const monitor = new TokenMonitor(provider);
    expect(() => monitor.startPolling(['token'], 0)).toThrow('Polling interval must be positive');
  });
});