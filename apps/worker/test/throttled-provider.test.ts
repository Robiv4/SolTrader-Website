import type { TokenDataProvider, TokenMarketSnapshot } from '@soltrader/market-data';
import { describe, expect, it } from 'vitest';

import { ThrottledTokenDataProvider } from '../src/throttled-provider.js';

function setup(behaviour: { metrics?: () => Promise<TokenMarketSnapshot | null>; discover?: () => Promise<Array<{ address: string }>> } = {}) {
  let now = 0;
  const sleeps: number[] = [];
  const calls = { metrics: 0, discover: 0 };
  const inner = {
    name: 'test',
    getTokenMetrics: async () => { calls.metrics += 1; return behaviour.metrics ? behaviour.metrics() : { metadata: { address: 'A' }, timestamp: new Date(now), priceUsd: 1 }; },
    discoverTokens: async () => { calls.discover += 1; return (behaviour.discover ? await behaviour.discover() : [{ address: 'A' }]) as never; },
  } as unknown as TokenDataProvider;
  const provider = new ThrottledTokenDataProvider(inner, {
    requestsPerMinute: 60,
    now: () => now,
    sleep: async (ms) => { sleeps.push(ms); now += ms; },
  });
  return { provider, calls, sleeps, advance: (ms: number) => { now += ms; } };
}

describe('throttled market-data provider', () => {
  it('caches snapshots and de-duplicates concurrent requests', async () => {
    const { provider, calls, advance } = setup();
    await Promise.all([provider.getTokenMetrics('A'), provider.getTokenMetrics('a')]);
    await provider.getTokenMetrics('A');
    expect(calls.metrics).toBe(1);
    advance(21_000);
    await provider.getTokenMetrics('A');
    expect(calls.metrics).toBe(2);
  });

  it('spaces upstream requests to the configured rate', async () => {
    const { provider, sleeps } = setup();
    await provider.getTokenMetrics('A');
    await provider.getTokenMetrics('B');
    await provider.getTokenMetrics('C');
    // 60 requests per minute => one second between upstream calls.
    expect(sleeps).toEqual([1000, 1000]);
  });

  it('pauses all upstream calls after HTTP 429', async () => {
    let fail = true;
    const { provider, sleeps } = setup({ metrics: async () => { if (fail) { fail = false; throw new Error('Provider dexscreener returned HTTP 429'); } return null; } });
    await expect(provider.getTokenMetrics('A')).rejects.toThrow('429');
    await provider.getTokenMetrics('B');
    expect(sleeps.at(-1)).toBeGreaterThanOrEqual(29_000);
  });

  it('keeps using the last good discovery list when the feed fails', async () => {
    let fail = false;
    const { provider, calls, advance } = setup({ discover: async () => { if (fail) throw new Error('HTTP 429'); return [{ address: 'A' }, { address: 'B' }]; } });
    expect((await provider.discoverTokens(10)).length).toBe(2);
    expect((await provider.discoverTokens(10)).length).toBe(2);
    expect(calls.discover).toBe(1);
    fail = true;
    advance(61_000);
    expect((await provider.discoverTokens(10)).map((token) => token.address)).toEqual(['A', 'B']);
  });
});
