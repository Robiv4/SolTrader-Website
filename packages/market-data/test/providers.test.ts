import { describe, expect, it } from 'vitest';

import { DexscreenerProvider } from '../src/providers.js';

describe('Dexscreener normalization', () => {
  it('keeps tiny prices and selects one deterministic Solana pool', async () => {
    const provider = new DexscreenerProvider({
      fetcher: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          pairs: [
            {
              chainId: 'ethereum',
              pairAddress: 'wrong-chain',
              dexId: 'other',
              baseToken: { address: 'TOKEN', symbol: 'BAD' },
              quoteToken: { address: 'USDC', symbol: 'USDC' },
              priceUsd: '999',
              liquidity: { usd: 999_999 },
            },
            {
              chainId: 'solana',
              pairAddress: 'thin-pool',
              dexId: 'raydium',
              baseToken: { address: 'TOKEN', symbol: 'TKN' },
              quoteToken: { address: 'USDC', symbol: 'USDC' },
              priceUsd: '0.000000042',
              liquidity: { usd: 1_000 },
              marketCap: '1234567.89',
              fdv: '2345678.90',
            },
            {
              chainId: 'solana',
              pairAddress: 'deep-pool',
              dexId: 'orca',
              baseToken: { address: 'TOKEN', symbol: 'TKN' },
              quoteToken: { address: 'USDC', symbol: 'USDC' },
              priceUsd: '0.000000042',
              liquidity: { usd: 10_000 },
              marketCap: '1234567.89',
              fdv: '2345678.90',
            },
          ],
        }),
      }),
    });

    const snapshot = await provider.getTokenMetrics('TOKEN');
    expect(snapshot?.priceUsd).toBe(0.000000042);
    expect(snapshot?.marketCap).toBe(1234567.89);
    expect(snapshot?.fdv).toBe(2345678.9);
    expect(snapshot?.poolAddress).toBe('deep-pool');
    expect(snapshot?.dexId).toBe('orca');
  });
});
describe('Dexscreener short windows', () => {
  function providerWith(pairs: unknown[]) {
    return new DexscreenerProvider({ fetcher: async () => ({ ok: true, status: 200, json: async () => ({ pairs }) }) as never });
  }
  const pair = (address: string, overrides: Record<string, unknown>) => ({
    chainId: 'solana', pairAddress: address, dexId: 'raydium', baseToken: { address: 'TOKEN', symbol: 'TKN' }, quoteToken: { address: 'SOL', symbol: 'SOL' },
    priceUsd: '0.5', liquidity: { usd: 50_000 }, ...overrides,
  });

  it('reads the 5m/1h windows and sums volumes and trade counts across pools', async () => {
    const snapshot = await providerWith([
      pair('a', { volume: { m5: 1_000, h1: 9_000, h24: 50_000 }, txns: { m5: { buys: 10, sells: 5 }, h1: { buys: 100, sells: 80 } }, priceChange: { m5: 2.5, h1: 7, h24: 20 } }),
      pair('b', { liquidity: { usd: 10_000 }, volume: { m5: 500, h1: 1_000 }, txns: { m5: { buys: 3, sells: 2 }, h1: { buys: 10, sells: 10 } }, priceChange: { m5: -9 } }),
    ]).getTokenMetrics('TOKEN');
    expect(snapshot).toMatchObject({ volume5m: 1_500, volume1h: 10_000, buyCount5m: 13, sellCount5m: 7, buyCount1h: 110, sellCount1h: 90, priceChange5m: 2.5 });
  });

  it('leaves the windows undefined when the provider does not report them (no fabrication)', async () => {
    const snapshot = await providerWith([pair('a', { volume: { h24: 50_000 }, txns: { h24: { buys: 10, sells: 5 } } })]).getTokenMetrics('TOKEN');
    expect(snapshot?.volume5m).toBeUndefined();
    expect(snapshot?.buyCount5m).toBeUndefined();
    expect(snapshot?.priceChange5m).toBeUndefined();
    expect(snapshot?.buyVolume).toBeUndefined();
  });
});
