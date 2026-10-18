/**
 * Community providers + service: request budget / 429 / 5xx / timeout backoff never throw, DEX Screener identity is the
 * base token only, LunarCrush without a key makes no request, and `assess` only uses data received by its moment.
 * Provider outages only remove community data (the service keeps working).
 */
import { describe, expect, it, vi } from 'vitest';

import { CommunityService } from '../src/community/community-service.js';
import { DexScreenerClient, parseDexPairs } from '../src/community/dexscreener.js';
import { type FetchLike, HttpBudget } from '../src/community/http-budget.js';
import { LunarCrushClient, parseLunarCoin } from '../src/community/lunarcrush.js';

const MINT = 'So1MintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const logger = { info: () => undefined, warn: () => undefined };
const response = (status: number, body: unknown = {}, headers: Record<string, string> = {}) => ({ ok: status >= 200 && status < 300, status, headers: { get: (name: string) => headers[name.toLowerCase()] ?? null }, json: async () => body });
const budget = (fetch: FetchLike, clock: { t: number }, perMinute = 10) => new HttpBudget({ source: 'TEST', enabled: true, configured: true, perMinute, timeoutMs: 1_000, backoffBaseMs: 2_000, backoffMaxMs: 60_000, fetch, now: () => clock.t });
const pair = (base: string, extra: Record<string, unknown> = {}) => ({ dexId: 'pumpfun', baseToken: { address: base }, quoteToken: { address: 'So11111111111111111111111111111111111111112' }, liquidity: { usd: 15_000 }, info: { imageUrl: 'https://x/y.png', websites: [{ url: 'https://site' }], socials: [{ type: 'twitter', url: 'https://x.com/a' }, { type: 'telegram', url: 'https://t.me/a' }] }, boosts: { active: 2 }, ...extra });

describe('HttpBudget', () => {
  it('per-minute budget: requests beyond it are not made', async () => {
    const clock = { t: 1_000_000 };
    const fetch = vi.fn(async () => response(200, []));
    const http = budget(fetch, clock, 2);
    for (let index = 0; index < 4; index += 1) await http.getJson('https://example/a');
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(http.stats.skippedBudget).toBe(2);
    clock.t += 60_000;
    expect(http.available()).toBe(true);
  });

  it('429 -> RATE_LIMITED until Retry-After; 5xx -> DEGRADED with exponential backoff; never throws', async () => {
    const clock = { t: 1_000_000 };
    const fetch = vi.fn<FetchLike>().mockResolvedValueOnce(response(429, {}, { 'retry-after': '30' })).mockResolvedValue(response(503));
    const http = budget(fetch, clock);
    expect(await http.getJson('https://example/a')).toBeNull();
    expect(http.health().state).toBe('RATE_LIMITED');
    clock.t += 29_000;
    expect(http.available()).toBe(false);
    clock.t += 1_000;
    expect(await http.getJson('https://example/a')).toBeNull();
    expect(http.health().state).toBe('DEGRADED');
    const until = Date.parse(http.health().backoffUntil!);
    expect(until - clock.t).toBe(4_000); // 2 failures: base x 2
  });

  it('timeout / network error is DEGRADED, the error text carries no URL or header', async () => {
    const clock = { t: 1_000_000 };
    const fetch = vi.fn<FetchLike>().mockRejectedValue(Object.assign(new Error('timeout'), { name: 'TimeoutError' }));
    const http = budget(fetch, clock);
    expect(await http.getJson('https://example/a?key=SECRET', { Authorization: 'Bearer SECRET' })).toBeNull();
    expect(http.health()).toMatchObject({ state: 'DEGRADED', lastError: 'TIMEOUT' });
    expect(JSON.stringify(http.health())).not.toContain('SECRET');
  });

  it('a success resets the backoff', async () => {
    const clock = { t: 1_000_000 };
    const fetch = vi.fn<FetchLike>().mockResolvedValueOnce(response(500)).mockResolvedValue(response(200, []));
    const http = budget(fetch, clock);
    await http.getJson('https://example/a');
    clock.t += 2_000;
    expect(await http.getJson('https://example/a')).toEqual({ status: 200, body: [] });
    expect(http.health().state).toBe('ACTIVE');
  });
});

describe('DEX Screener', () => {
  it('identity = base token equals the mint; best pair by liquidity; profile / socials / boosts parsed', () => {
    const observation = parseDexPairs(MINT, [pair(MINT, { liquidity: { usd: 100 } }), pair(MINT)], 5, { orders: [{ type: 'tokenProfile', status: 'approved', paymentTimestamp: 4 }] });
    expect(observation).toMatchObject({ pairFound: true, identityConfirmed: true, profilePresent: true, websites: 1, activeBoosts: 2, liquidityUsd: 15_000, receivedAt: 5 });
    expect(observation.socials).toEqual({ twitter: true, telegram: true, discord: false, other: 0 });
    expect(observation.paidOrders).toHaveLength(1);
  });

  it('a pair that only quotes the mint is NOT an identity match', () => {
    const observation = parseDexPairs(MINT, [pair('OTHER', { quoteToken: { address: MINT } })], 5);
    expect(observation).toMatchObject({ pairFound: true, identityConfirmed: false, profilePresent: false, activeBoosts: null });
  });

  it('batches up to 30 mints in one request and maps pairs back by mint', async () => {
    const clock = { t: 1_000_000 };
    const fetch = vi.fn<FetchLike>().mockResolvedValue(response(200, [pair(MINT)]));
    const client = new DexScreenerClient(budget(fetch, clock));
    const mints = [MINT, ...Array.from({ length: 40 }, (_, index) => `M${index}`)];
    const result = await client.tokens(mints);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0][0]).split('/').at(-1)!.split(',')).toHaveLength(30);
    expect(result!.get(MINT)).toHaveLength(1);
  });
});

describe('LunarCrush (optional)', () => {
  it('without a key: no request at all', async () => {
    const fetch = vi.fn<FetchLike>();
    const client = new LunarCrushClient(budget(fetch, { t: 0 }), null);
    expect(await client.coin(MINT, 1)).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('identity only when the response names the mint; missing fields stay null', () => {
    expect(parseLunarCoin(MINT, { data: { galaxy_score: 61, symbol: 'X' } }, 1)).toMatchObject({ identityConfirmed: false, galaxyScore: 61, sentiment: null });
    expect(parseLunarCoin(MINT, { data: { contract_address: MINT } }, 1)?.identityConfirmed).toBe(true);
  });
});

describe('CommunityService', () => {
  const service = (fetch: FetchLike, clock: { t: number }) => {
    const http = budget(fetch, clock);
    return new CommunityService({ logger, onchainEnabled: true, now: () => clock.t, dex: { http, client: new DexScreenerClient(http), cacheTtlMs: 60_000 }, lunar: null });
  };

  it('assess at an earlier moment never uses a DEX response received later', async () => {
    const clock = { t: 1_000_000 };
    const community = service(vi.fn<FetchLike>().mockResolvedValue(response(200, [pair(MINT)])), clock);
    community.track(MINT, 3);
    const before = clock.t;
    clock.t += 5_000;
    await community.tick();
    expect(community.assess(MINT, null, before)!.features.dexProfilePresent).toBeNull();
    expect(community.assess(MINT, null, clock.t)!.features.dexProfilePresent).toBe(true);
  });

  it('on-chain stats from the trade stream; trades after `at` are not counted', () => {
    const clock = { t: 1_000_000 };
    const community = service(vi.fn<FetchLike>(), clock);
    community.track(MINT, 3);
    for (let index = 0; index < 5; index += 1) community.onTrade({ mint: MINT, wallet: `W${index}`, isBuy: true, solAmount: 0.1, receivedAt: clock.t - 10_000 + index }, 150);
    community.onTrade({ mint: MINT, wallet: 'LATE', isBuy: true, solAmount: 0.1, receivedAt: clock.t + 1_000 }, 150);
    expect(community.assess(MINT, null, clock.t)!.features.onchainBuyers5m).toBe(5);
    // Unknown SOL price: the trade is not recorded (no invented USD value).
    community.onTrade({ mint: MINT, wallet: 'NOPRICE', isBuy: true, solAmount: 1, receivedAt: clock.t - 1 }, null);
    expect(community.assess(MINT, null, clock.t)!.features.onchainBuyers5m).toBe(5);
  });

  it('provider outage: tick never throws, assess still works (DEX NO_DATA), health reports DEGRADED', async () => {
    const clock = { t: 1_000_000 };
    const community = service(vi.fn<FetchLike>().mockRejectedValue(new Error('ECONNRESET')), clock);
    community.track(MINT, 3);
    await expect(community.tick()).resolves.toBeUndefined();
    const result = community.assess(MINT, null, clock.t)!;
    expect(result.sources.DEXSCREENER.status).toBe('NO_DATA');
    expect(community.health().providers.find((provider) => provider.source === 'TEST')!.state).toBe('DEGRADED');
  });

  it('untracked token: assess returns null (no data invented)', () => {
    expect(service(vi.fn<FetchLike>(), { t: 0 }).assess('UNKNOWN', null, 1)).toBeNull();
  });
});
