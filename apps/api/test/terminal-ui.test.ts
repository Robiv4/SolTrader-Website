import crypto from 'node:crypto';

import { createClient } from 'redis';
import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { env } from '../src/config.js';
import { aggregateCandles, availableTimeframes, findGaps, GeckoTerminalOhlcv, parseGeckoOhlcv, parseStoredCandles, type Candle } from '../src/token-candles.js';
import { formatRawAmount, parseTokenAccounts, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, WalletPortfolioService, WSOL_MINT } from '../src/wallet-portfolio.js';
import { base58Encode, WalletChallengeStore } from '../src/wallet-verification.js';

process.env.ADMIN_EMAIL = 'admin@soltrader.local';
process.env.ADMIN_PASSWORD = 'AdminPass123!';

const { app } = await import('../src/app.js');

function createTestWallet() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url');
  return { address: base58Encode(raw), sign: (message: string) => crypto.sign(null, Buffer.from(message, 'utf8'), privateKey).toString('base64') };
}

const candle = (t: number, o: number, h: number, l: number, c: number, v = 1, n = 1): Candle => ({ t, o, h, l, c, v, n });

describe('wallet challenge (domain-bound, single-use, expiring)', () => {
  it('names the domain in the signed message and only accepts it for that domain', () => {
    const store = new WalletChallengeStore();
    const issued = store.issue('u1', 'a@b.c', 'Addr1', 'mainnet-beta', 'app.soltrader.test');
    expect(issued.message).toContain('Domain: app.soltrader.test');
    expect(issued.message).toContain('does not authorize any transaction');
    expect(store.consume('u1', 'Addr1', issued.nonce, 'evil.example')).toBeNull();
    // The failed attempt consumed the nonce: no retry with the right domain either (no replay window).
    expect(store.consume('u1', 'Addr1', issued.nonce, 'app.soltrader.test')).toBeNull();
  });

  it('is bound to user and address and can be used once', () => {
    const store = new WalletChallengeStore();
    const issued = store.issue('u1', 'a@b.c', 'Addr1', 'devnet', 'host');
    expect(store.consume('u2', 'Addr1', issued.nonce, 'host')).toBeNull();
    expect(store.consume('u1', 'Addr2', issued.nonce, 'host')).toBeNull();
    const again = store.issue('u1', 'a@b.c', 'Addr1', 'devnet', 'host');
    expect(store.consume('u1', 'Addr1', again.nonce, 'host')).toEqual({ message: again.message, network: 'devnet' });
    expect(store.consume('u1', 'Addr1', again.nonce, 'host')).toBeNull();
  });

  it('expires', () => {
    const store = new WalletChallengeStore(-1);
    const issued = store.issue('u1', 'a@b.c', 'Addr1', 'devnet', 'host');
    expect(store.consume('u1', 'Addr1', issued.nonce, 'host')).toBeNull();
  });
});

describe('wallet portfolio (read-only, exact amounts, no invented USD)', () => {
  it('formats raw amounts exactly with BigInt', () => {
    expect(formatRawAmount('123456789', 6)).toBe('123.456789');
    expect(formatRawAmount('1000000', 6)).toBe('1');
    expect(formatRawAmount('1', 9)).toBe('0.000000001');
    expect(formatRawAmount('123456789012345678901234567890', 9)).toBe('123456789012345678901.23456789');
    expect(formatRawAmount('42', 0)).toBe('42');
    expect(formatRawAmount('-5', 2)).toBe('0');
  });

  it('sums several accounts of one mint and drops empty / malformed accounts', () => {
    const account = (mint: string, amount: unknown, decimals: unknown) => ({ account: { data: { parsed: { info: { mint, tokenAmount: { amount, decimals } } } } } });
    const holdings = parseTokenAccounts({ value: [account('M1', '150', 2), account('M1', '50', 2), account('M2', '0', 6), account('M3', '1.5', 6), account('M4', '7', 'x')] }, 'spl-token');
    expect(holdings).toEqual([{ mint: 'M1', program: 'spl-token', amountRaw: '200', decimals: 2, amount: '2' }]);
    expect(parseTokenAccounts(null, 'spl-token')).toEqual([]);
  });

  function service(options: { prices?: Record<string, number>; network?: string; now?: () => number } = {}) {
    const calls: Array<{ network: string; method: string; programId?: string }> = [];
    const account = (mint: string, amount: string, decimals: number) => ({ account: { data: { parsed: { info: { mint, tokenAmount: { amount, decimals } } } } } });
    const svc = new WalletPortfolioService({
      rpcFor: (network) => async (method, params) => {
        const programId = (params[1] as { programId?: string } | undefined)?.programId;
        calls.push({ network, method, programId });
        if (method === 'getBalance') return { value: 2_500_000_000 };
        if (programId === TOKEN_PROGRAM_ID) return { value: [account('MintA', '5000000', 6)] };
        if (programId === TOKEN_2022_PROGRAM_ID) return { value: [account('MintB', '42', 0)] };
        throw new Error('unexpected');
      },
      priceOf: async (mint) => (options.prices && mint in options.prices ? { priceUsd: options.prices[mint], source: 'TEST' } : null),
      metadataOf: async () => new Map([['MintA', { symbol: 'AAA', name: 'Token A' }]]),
      now: options.now,
    });
    return { svc, calls };
  }

  it('reports SOL + SPL + Token-2022 and a total only when everything is priced', async () => {
    const full = service({ prices: { [WSOL_MINT]: 100, MintA: 2, MintB: 0.5 } });
    const portfolio = await full.svc.load('Owner', 'mainnet-beta');
    expect(portfolio.sol.balance).toBe(2.5);
    expect(portfolio.sol.valueUsd).toBe(250);
    expect(portfolio.tokens.map((token) => [token.mint, token.program, token.amount, token.valueUsd])).toEqual([['MintB', 'spl-token-2022', '42', 21], ['MintA', 'spl-token', '5', 10]]);
    expect(portfolio.totalUsd).toBe(281);

    const partial = service({ prices: { [WSOL_MINT]: 100, MintA: 2 } });
    const missing = await partial.svc.load('Owner', 'mainnet-beta');
    expect(missing.tokens.find((token) => token.mint === 'MintB')).toMatchObject({ priceUsd: null, valueUsd: null });
    expect(missing.totalUsd).toBeNull();
    expect(missing.unpricedTokens).toBe(1);
  });

  it('never prices devnet holdings and uses the wallet network RPC', async () => {
    const devnet = service({ prices: { [WSOL_MINT]: 100, MintA: 2, MintB: 1 } });
    const portfolio = await devnet.svc.load('Owner', 'devnet');
    expect(portfolio.sol.valueUsd).toBeNull();
    expect(portfolio.tokens.every((token) => token.valueUsd === null)).toBe(true);
    expect(portfolio.totalUsd).toBeNull();
    expect(new Set(devnet.calls.map((call) => call.network))).toEqual(new Set(['devnet']));
    // Read-only: only balance / token-account queries, never a transaction.
    expect(new Set(devnet.calls.map((call) => call.method))).toEqual(new Set(['getBalance', 'getTokenAccountsByOwner']));
  });

  it('caches per address + network and rate-limits forced refreshes per user', async () => {
    let now = 1_000_000;
    const { svc, calls } = service({ now: () => now });
    await svc.load('Owner', 'devnet');
    await svc.load('Owner', 'devnet');
    expect(calls.length).toBe(3);
    now += 31_000;
    await svc.load('Owner', 'devnet');
    expect(calls.length).toBe(6);
    expect(svc.canForce('u1')).toBe(true);
    expect(svc.canForce('u1')).toBe(false);
    expect(svc.canForce('u2')).toBe(true);
    now += 15_000;
    expect(svc.canForce('u1')).toBe(true);
  });
});

describe('token candles (real OHLCV only)', () => {
  it('aggregates base candles into coarser timeframes without inventing buckets', () => {
    const base = [candle(0, 1, 2, 0.5, 1.5, 10, 2), candle(5_000, 1.5, 3, 1.4, 2, 5, 1), candle(65_000, 2, 2.2, 1.9, 2.1, 1, 1)];
    expect(aggregateCandles(base, 60_000)).toEqual([
      { t: 0, o: 1, h: 3, l: 0.5, c: 2, v: 15, n: 3 },
      { t: 60_000, o: 2, h: 2.2, l: 1.9, c: 2.1, v: 1, n: 1 },
    ]);
    // Empty minutes between trades stay empty (gap) - no flat filler candles.
    const sparse = aggregateCandles([candle(0, 1, 1, 1, 1), candle(600_000, 2, 2, 2, 2)], 60_000);
    expect(sparse.map((item) => item.t)).toEqual([0, 600_000]);
    expect(findGaps(sparse.map((item) => item.t), 60_000 * 6)).toEqual([{ from: 0, to: 600_000 }]);
  });

  it('offers a timeframe only when the data fills at least MIN_CANDLES candles', () => {
    const base = Array.from({ length: 10 }, (_, index) => candle(index * 5_000, 1, 1, 1, 1));
    expect(availableTimeframes(base, 5_000, 0, 60_000)).toEqual(['5s']);
    expect(availableTimeframes([], 5_000, 0, 60_000)).toEqual([]);
  });

  it('validates stored and GeckoTerminal candles', () => {
    expect(parseStoredCandles({ a: JSON.stringify(candle(10, 1, 2, 1, 1)), b: 'not json', c: JSON.stringify(candle(5, 0, 1, 1, 1)), d: JSON.stringify({ t: 1 }) })).toEqual([candle(10, 1, 2, 1, 1)]);
    const gecko = parseGeckoOhlcv({ data: { attributes: { ohlcv_list: [[120, 2, 3, 1, 2.5, 100], [60, 1, 2, 0.9, 2, 50], [180, 'x', 1, 1, 1, 1], [240, 1, 0.5, 2, 1, 1]] } } });
    expect(gecko).toEqual([{ t: 60_000, o: 1, h: 2, l: 0.9, c: 2, v: 50 }, { t: 120_000, o: 2, h: 3, l: 1, c: 2.5, v: 100 }]);
    expect(parseGeckoOhlcv(null)).toEqual([]);
  });

  it('GeckoTerminal client is cached and rate limited', async () => {
    let requests = 0;
    const client = new GeckoTerminalOhlcv(async (url) => {
      requests += 1;
      if (url.includes('/pools?')) return { data: [{ attributes: { address: 'Pool1' } }] };
      return { data: { attributes: { ohlcv_list: [[60, 1, 2, 0.5, 1.5, 10]] } } };
    }, { perMinute: 2, now: () => 0 });
    expect(await client.candles('Mint', '1m')).toEqual({ pool: 'Pool1', candles: [{ t: 60_000, o: 1, h: 2, l: 0.5, c: 1.5, v: 10 }] });
    await client.candles('Mint', '1m');
    expect(requests).toBe(2);
    // Budget exhausted: no request, no candles for an uncached series.
    expect(await client.candles('Mint', '5m')).toBeNull();
    expect(requests).toBe(2);
    expect(await client.candles('Mint', '5s')).toBeNull();
  });
});

describe('terminal UI API routes', () => {
  const agent = request.agent(app);
  const redis = createClient({ url: env.REDIS_URL, ...(env.REDIS_PASSWORD ? { password: env.REDIS_PASSWORD } : {}) });
  const mint = `UiTestCandles${Date.now()}`;

  beforeEach(async () => {
    await agent.post('/api/auth/login').send({ email: 'admin@soltrader.local', password: 'AdminPass123!' });
  });
  afterEach(async () => {
    await agent.post('/api/auth/logout').send({});
  });
  afterAll(async () => {
    if (redis.isOpen) {
      await redis.del(`candles:5s:${mint}`);
      await redis.quit();
    }
  });

  it('requires authentication', async () => {
    const anonymous = request(app);
    expect((await anonymous.get('/api/wallet/overview')).status).toBe(401);
    expect((await anonymous.get(`/api/tokens/${mint}/candles`)).status).toBe(401);
    expect((await anonymous.get('/api/dashboard/overview')).status).toBe(401);
  });

  it('wallet overview never invents a portfolio without a linked wallet', async () => {
    const response = await agent.get('/api/wallet/overview');
    expect(response.status).toBe(200);
    if (!response.body.data.connected) expect(response.body.data.portfolio ?? null).toBeNull();
  });

  it('rejects a wallet signature for a challenge issued to another domain', async () => {
    const wallet = createTestWallet();
    const challenge = await agent.post('/api/settings/wallet/challenge').set('Origin', 'http://localhost:3000').send({ publicAddress: wallet.address, network: 'devnet' });
    expect(challenge.status).toBe(200);
    expect(challenge.body.data.message).toContain('Domain: localhost:3000');
    const connect = await agent.post('/api/settings/wallet/connect').set('Host', 'other.example').send({
      type: 'USER', publicAddress: wallet.address, network: 'devnet', provider: 'PHANTOM', label: 'x',
      nonce: challenge.body.data.nonce, signature: wallet.sign(challenge.body.data.message),
    });
    expect(connect.status).toBeGreaterThanOrEqual(400);
  });

  it('candles: line of stored samples when there is no real OHLCV, nothing fabricated', async () => {
    const to = Date.now();
    const response = await agent.get(`/api/tokens/${mint}/candles?from=${to - 3_600_000}&to=${to}`);
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ chartType: 'line', source: 'PRICE_SAMPLES', points: [], availableTimeframes: [], latestDataAt: null });
    expect(response.body.data.candles).toBeUndefined();
    expect((await agent.get(`/api/tokens/${mint}/candles?from=0&to=${to}`)).status).toBe(400);
  });

  it('candles: real trade-stream candles with timeframe selection and gaps', async () => {
    await redis.connect();
    const now = Date.now();
    const start = Math.floor((now - 30 * 60_000) / 60_000) * 60_000;
    const values: Record<string, string> = {};
    for (let index = 0; index < 12; index += 1) {
      const t = start + index * 5_000;
      values[String(t)] = JSON.stringify({ t, o: 1e-6, h: 2e-6, l: 0.5e-6, c: 1.5e-6, v: 10, n: 2, buys: 1, sells: 1 });
    }
    const late = start + 20 * 60_000;
    values[String(late)] = JSON.stringify({ t: late, o: 1e-6, h: 1e-6, l: 1e-6, c: 1e-6, v: 1, n: 1, buys: 1, sells: 0 });
    await redis.hSet(`candles:5s:${mint}`, values);
    const response = await agent.get(`/api/tokens/${mint}/candles?from=${now - 3_600_000}&to=${now}&tf=5s`);
    expect(response.status).toBe(200);
    const data = response.body.data;
    expect(data).toMatchObject({ chartType: 'candles', source: 'PUMP_FUN_TRADES', timeframe: '5s' });
    expect(data.availableTimeframes).toContain('5s');
    expect(data.candles).toHaveLength(13);
    expect(data.gaps).toEqual([{ from: start + 11 * 5_000, to: late }]);
    expect(data.overlays.simulated).toBe(true);
  });

  it('token trading context and dashboard overview have the documented shape', async () => {
    const trading = await agent.get(`/api/tokens/${mint}/trading`);
    expect(trading.status).toBe(200);
    expect(trading.body.data).toMatchObject({ ml: { paperDecision: null, shadowPrediction: null }, paperTrades: [], openPosition: null });
    const overview = await agent.get('/api/dashboard/overview');
    expect(overview.status).toBe(200);
    expect(overview.body.data).toHaveProperty('worker.alive');
    expect(overview.body.data).toHaveProperty('ml.decisionsToday');
    expect(Array.isArray(overview.body.data.newLaunch.recent)).toBe(true);
  });
});
