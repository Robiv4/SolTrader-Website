/**
 * SolanaRpcManager (tests 60-75): dedup, batching, cache policy, 429 / 403 / timeout handling, circuit breaker,
 * retry budget, priority queue, expiration, connection reuse and a NewLaunch-style load simulation.
 * Mocked transports only - no network.
 */
import { describe, expect, it } from 'vitest';

import { maskRpcUrl, RPC_PRIORITY, RpcAllProvidersFailedError, RpcRequestDroppedError, SolanaRpcManager, type RpcTransport } from '../src/rpc-manager.js';

type Reply = { status?: number; body?: unknown; headers?: Record<string, string>; delayMs?: number; timeout?: boolean };
type Handler = (method: string, params: unknown[]) => Reply;

const URLS = { primary: 'https://primary.example.test', secondary: 'https://secondary.example.test/solana', fallback: 'https://fallback.example.test' };
const ok = (result: unknown): Reply => ({ status: 200, body: { jsonrpc: '2.0', id: 1, result } });
const mintAccount = (mint: string, mintAuthority: string | null = null) => ({ context: { slot: 1 }, value: { data: { program: 'spl-token', parsed: { info: { decimals: 6, supply: '1000', mintAuthority, freezeAuthority: null, mint } } } } });

function harness(handlers: Partial<Record<keyof typeof URLS, Handler>>, options: { clock?: { now: number } } = {}) {
  const calls: Array<{ provider: string; method: string; params: unknown[] }> = [];
  const transport: RpcTransport = async ({ url, body, timeoutMs }) => {
    const provider = (Object.entries(URLS).find(([, value]) => value === url)?.[0] ?? 'unknown') as keyof typeof URLS;
    const request = JSON.parse(body) as { method: string; params: unknown[] };
    calls.push({ provider, method: request.method, params: request.params });
    const reply = handlers[provider]?.(request.method, request.params) ?? ok(null);
    if (reply.delayMs || reply.timeout) await new Promise((resolve) => globalThis.setTimeout(resolve, Math.min(reply.delayMs ?? timeoutMs, timeoutMs)));
    if (reply.timeout || (reply.delayMs ?? 0) >= timeoutMs) {
      const error = new Error('The operation was aborted due to timeout');
      error.name = 'TimeoutError';
      throw error;
    }
    return { status: reply.status ?? 200, headers: { get: (name: string) => reply.headers?.[name.toLowerCase()] ?? null }, text: async () => JSON.stringify(reply.body ?? null) };
  };
  const clock = options.clock;
  const manager = new SolanaRpcManager({
    providers: (Object.keys(handlers) as Array<keyof typeof URLS>).map((role) => ({ role, url: URLS[role] })),
    transport, timeoutMs: 50, batchWindowMs: 5, random: () => 0.5, rateLimitBaseMs: 1_000,
    ...(clock ? { now: () => clock.now } : {}),
  });
  return { manager, calls };
}
const opts = (overrides: Partial<Parameters<SolanaRpcManager['request']>[2]> = {}) => ({ caller: 'Test', priority: RPC_PRIORITY.ENRICHMENT, ...overrides });

describe('SolanaRpcManager', () => {
  it('60. dedup: 100 simultaneous identical getAccountInfo(X) -> 1 network request, 100 results', async () => {
    const { manager, calls } = harness({ primary: (method, params) => (method === 'getAccountInfo' ? ok(mintAccount(String(params[0]))) : ok(null)) });
    const results = await Promise.all(Array.from({ length: 100 }, () => manager.request('getAccountInfo', ['MINT_X', { encoding: 'jsonParsed' }], opts({ batchable: false }))));
    expect(calls).toHaveLength(1);
    expect(results.every((result) => (result as { value: unknown }).value !== null)).toBe(true);
    expect(manager.totals.dedupHits).toBe(99);
  });

  it('61. different requests (A vs B, or different options) are never merged', async () => {
    const { manager, calls } = harness({ primary: (_method, params) => ok({ value: params[0] }) });
    const [a, b, c] = await Promise.all([
      manager.request('getAccountInfo', ['A', { encoding: 'jsonParsed' }], opts({ batchable: false })),
      manager.request('getAccountInfo', ['B', { encoding: 'jsonParsed' }], opts({ batchable: false })),
      manager.request('getAccountInfo', ['A', { encoding: 'base64' }], opts({ batchable: false })),
    ]);
    expect(calls).toHaveLength(3);
    expect([a, b, c]).toEqual([{ value: 'A' }, { value: 'B' }, { value: 'A' }]);
  });

  it('62. batching: compatible account reads become one getMultipleAccounts, results mapped back per caller', async () => {
    const { manager, calls } = harness({ primary: (method, params) => (method === 'getMultipleAccounts' ? ok({ context: { slot: 9 }, value: (params[0] as string[]).map((key) => (key === 'MISSING' ? null : { key })) }) : ok(null)) });
    const keys = ['K1', 'K2', 'K3', 'MISSING', 'K5'];
    const results = await Promise.all(keys.map((key) => manager.request('getAccountInfo', [key, { encoding: 'jsonParsed', commitment: 'confirmed' }], opts())));
    expect(calls.map((call) => call.method)).toEqual(['getMultipleAccounts']);
    expect(results).toEqual(keys.map((key) => ({ context: { slot: 9 }, value: key === 'MISSING' ? null : { key } })));
    // Critical traffic never waits for a batch window.
    await manager.request('getAccountInfo', ['K9', { encoding: 'jsonParsed' }], opts({ priority: RPC_PRIORITY.CRITICAL_EXIT }));
    expect(calls.at(-1)?.method).toBe('getAccountInfo');
  });

  it('63. cache: static/slow lookup within TTL served from cache, refreshed after TTL', async () => {
    const clock = { now: 1_000_000 };
    const { manager, calls } = harness({ primary: () => ok(mintAccount('M')) }, { clock });
    const first = await manager.getMintAccount('M', opts({ batchable: false }));
    const second = await manager.getMintAccount('M', opts({ batchable: false }));
    expect(first).toEqual(second);
    expect(calls).toHaveLength(1);
    clock.now += 31_000;
    await manager.getMintAccount('M', opts({ batchable: false }));
    expect(calls).toHaveLength(2);
  });

  it('64. dynamic data (balance, blockhash, sends) is not served from a long cache', async () => {
    const clock = { now: 1_000_000 };
    let balance = 1;
    const { manager, calls } = harness({ primary: (method) => ok(method === 'getBalance' ? { value: balance++ } : { blockhash: `h${calls.length}` }) }, { clock });
    const a = await manager.request('getBalance', ['W'], opts({ cacheTtlMs: 60_000 }));
    clock.now += 2_500; // getBalance is capped at 2 s whatever the caller asks
    const b = await manager.request('getBalance', ['W'], opts({ cacheTtlMs: 60_000 }));
    expect(a).not.toEqual(b);
    await manager.request('getLatestBlockhash', [], opts({ cacheTtlMs: 60_000 }));
    await manager.request('getLatestBlockhash', [], opts({ cacheTtlMs: 60_000 }));
    expect(calls.filter((call) => call.method === 'getLatestBlockhash')).toHaveLength(2);
  });

  it('65. 429 on primary: cooldown with back-off (Retry-After respected), failover, no tight retry loop', async () => {
    const clock = { now: 1_000_000 };
    const { manager, calls } = harness({
      primary: (method) => (method === 'getTokenLargestAccounts' ? { status: 429, headers: { 'retry-after': '10' }, body: { jsonrpc: '2.0', error: { code: 429, message: 'Too many requests for a specific RPC call' } } } : ok({ value: 'p' })),
      fallback: () => ok({ value: [] }),
    }, { clock });
    for (let index = 0; index < 20; index += 1) await manager.request('getTokenLargestAccounts', [`M${index}`], opts());
    // Primary saw exactly one getTokenLargestAccounts; the method cooldown (10 s) routed the rest to the fallback.
    expect(calls.filter((call) => call.provider === 'primary' && call.method === 'getTokenLargestAccounts')).toHaveLength(1);
    expect(calls.filter((call) => call.provider === 'fallback')).toHaveLength(20);
    // Method-scoped: other methods on the primary keep working.
    await manager.request('getSlot', [], opts());
    expect(calls.at(-1)?.provider).toBe('primary');
    const snapshot = manager.snapshot();
    expect(snapshot.totals.rateLimited).toBe(1);
    expect(snapshot.providers[0].methodCooldowns[0]).toMatchObject({ method: 'getTokenLargestAccounts' });
    clock.now += 10_001;
    await manager.request('getTokenLargestAccounts', ['AFTER'], opts());
    expect(calls.filter((call) => call.provider === 'primary' && call.method === 'getTokenLargestAccounts')).toHaveLength(2);
    // Still limited: the next cooldown grows past Retry-After (exponential), so a dead method is probed less and less.
    expect(manager.snapshot().providers[0].methodCooldowns[0].remainingMs).toBeGreaterThanOrEqual(10_000);
  });

  it('66. 403 on secondary: FORBIDDEN (configuration), not retried, others continue', async () => {
    const { manager, calls } = harness({
      primary: () => ({ status: 503, body: 'down' }),
      secondary: () => ({ status: 403, body: { error: 'message: API key is not allowed to access blockchain, json-rpc code: -32052, rest code: 403' } }),
      fallback: () => ok(7),
    });
    for (let index = 0; index < 10; index += 1) expect(await manager.request('getSlot', [], opts({ cacheTtlMs: 0 }))).toBe(7);
    expect(calls.filter((call) => call.provider === 'secondary')).toHaveLength(1);
    const secondary = manager.snapshot().providers.find((provider) => provider.role === 'secondary')!;
    expect(secondary.status).toBe('FORBIDDEN');
    expect(secondary.forbiddenReason).toContain('API key is not allowed');
    expect(manager.snapshot().alerts.map((alert) => alert.code)).toContain('RPC_PROVIDER_FORBIDDEN');
  });

  it('67. timeout: bounded per attempt, provider degraded, logical request does not hang', async () => {
    const { manager } = harness({ fallback: () => ({ timeout: true }) });
    const started = Date.now();
    await expect(manager.request('getSlot', [], opts({ cacheTtlMs: 0 }))).rejects.toBeInstanceOf(RpcAllProvidersFailedError);
    expect(Date.now() - started).toBeLessThan(500);
    await expect(manager.request('getSlot', [], opts({ cacheTtlMs: 0 }))).rejects.toThrow();
    await expect(manager.request('getSlot', [], opts({ cacheTtlMs: 0 }))).rejects.toThrow();
    const fallback = manager.snapshot().providers[0];
    expect(fallback.timeouts).toBe(3);
    expect(fallback.status).toBe('TIMEOUT');
  });

  it('68/72. all providers fail: one attempt per provider (retry budget), normalized error, no amplification', async () => {
    const { manager, calls } = harness({ primary: () => ({ status: 500, body: 'x' }), secondary: () => ({ status: 502, body: 'x' }), fallback: () => ({ status: 503, body: 'x' }) });
    const error = await manager.request('getAccountInfo', ['M', {}], opts({ batchable: false })).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RpcAllProvidersFailedError);
    expect((error as RpcAllProvidersFailedError).attempts).toHaveLength(3);
    expect(calls).toHaveLength(3);
    // 10 more logical requests: at most 3 network attempts each (and fewer once circuits open).
    for (let index = 0; index < 10; index += 1) await manager.request('getAccountInfo', [`M${index}`, {}], opts({ batchable: false })).catch(() => undefined);
    expect(calls.length).toBeLessThanOrEqual(3 + 30);
    expect(manager.snapshot().alerts.map((alert) => alert.code)).toContain('RPC_ALL_PROVIDERS_UNAVAILABLE');
  });

  it('invalid request is not failed over (every provider would reject it)', async () => {
    const { manager, calls } = harness({ primary: () => ok(null), fallback: () => ok(null) });
    const bad = harness({ primary: () => ({ status: 200, body: { jsonrpc: '2.0', error: { code: -32602, message: 'Invalid param: WrongSize' } } }), fallback: () => ok(1) });
    await expect(bad.manager.request('getAccountInfo', ['short', {}], opts({ batchable: false }))).rejects.toMatchObject({ kind: 'INVALID_REQUEST' });
    expect(bad.calls).toHaveLength(1);
    expect(calls).toHaveLength(0);
    void manager;
  });

  it('method unsupported ("Request blocked") is remembered per provider (capability map)', async () => {
    const { manager, calls } = harness({
      primary: () => ok(1),
      fallback: (method) => (method === 'getTokenLargestAccounts' ? { status: 200, body: { jsonrpc: '2.0', error: { code: -32602, message: 'Request blocked' } } } : ok(2)),
    });
    // Primary first is limited for this method (simulated by removing it): use fallback-only ordering via a 429 first.
    const only = harness({ fallback: (method) => (method === 'getTokenLargestAccounts' ? { status: 200, body: { jsonrpc: '2.0', error: { code: -32602, message: 'Request blocked' } } } : ok(2)) });
    await expect(only.manager.request('getTokenLargestAccounts', ['M1'], opts())).rejects.toBeInstanceOf(RpcAllProvidersFailedError);
    await expect(only.manager.request('getTokenLargestAccounts', ['M2'], opts())).rejects.toBeInstanceOf(RpcAllProvidersFailedError);
    expect(only.calls).toHaveLength(1);
    expect(only.manager.snapshot().providers[0].unsupportedMethods).toEqual(['getTokenLargestAccounts']);
    expect(await only.manager.request('getSlot', [], opts({ cacheTtlMs: 0 }))).toBe(2);
    void manager;
    void calls;
  });

  it('HTTP 403 + "Request blocked" is a METHOD block, not a forbidden provider (other methods keep working)', async () => {
    const { manager, calls } = harness({ fallback: (method) => (method === 'getTokenLargestAccounts' ? { status: 403, body: { jsonrpc: '2.0', error: { code: -32602, message: 'Request blocked' } } } : ok(3)) });
    await expect(manager.request('getTokenLargestAccounts', ['M'], opts())).rejects.toBeInstanceOf(RpcAllProvidersFailedError);
    expect(await manager.request('getSlot', [], opts({ cacheTtlMs: 0 }))).toBe(3);
    const fallback = manager.snapshot().providers[0];
    expect(fallback.status).not.toBe('FORBIDDEN');
    expect(fallback.unsupportedMethods).toEqual(['getTokenLargestAccounts']);
    expect(calls).toHaveLength(2);
  });

  it('short rate-limit cooldown: later requests wait it out (backpressure) instead of failing', async () => {
    let limited = true;
    const transport: RpcTransport = async () => {
      const status = limited ? 429 : 200;
      limited = false;
      return { status, headers: { get: () => null }, text: async () => JSON.stringify(status === 429 ? { error: { code: 429, message: 'Too Many Requests' } } : { jsonrpc: '2.0', result: 42 }) };
    };
    const manager = new SolanaRpcManager({ providers: [{ role: 'primary', url: 'https://only.test' }], transport, rateLimitBaseMs: 400, random: () => 0.5 });
    await expect(manager.request('getSlot', [], opts({ cacheTtlMs: 0 }))).rejects.toBeInstanceOf(RpcAllProvidersFailedError);
    // Inside the ~400 ms cooldown (long enough to survive a loaded test runner): it waits, then succeeds.
    expect(await manager.request('getSlot', [], opts({ cacheTtlMs: 0 }))).toBe(42);
    expect(manager.totals.rateLimitWaits).toBeGreaterThanOrEqual(1);
  });

  it('client-side RPS limit: a burst is spread over time instead of provoking 429s', async () => {
    const sent: number[] = [];
    const transport: RpcTransport = async () => {
      sent.push(Date.now());
      return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ jsonrpc: '2.0', result: 1 }) };
    };
    const manager = new SolanaRpcManager({ providers: [{ role: 'primary', url: 'https://only.test' }], transport, maxRps: 5, deadlineMs: { 4: 5_000 } });
    await Promise.all(Array.from({ length: 12 }, (_, index) => manager.request('getBalance', [`W${index}`], opts())));
    expect(sent).toHaveLength(12);
    // No 1-second window contains more than 5 sends.
    for (const time of sent) expect(sent.filter((other) => other >= time && other < time + 1_000).length).toBeLessThanOrEqual(5);
  }, 10_000);

  it('70. priority: 1,000 queued enrichment requests cannot starve one critical exit request', async () => {
    const order: string[] = [];
    const { manager } = harness({ primary: (method, params) => {
      order.push(String(params[0]));
      return { ...ok(1), delayMs: 2 };
    } });
    const enrichment = Array.from({ length: 1_000 }, (_, index) => manager.request('getBalance', [`E${index}`], opts({ priority: RPC_PRIORITY.ENRICHMENT, deadlineMs: 60_000 })).catch(() => undefined));
    await new Promise((resolve) => globalThis.setTimeout(resolve, 5));
    await manager.request('getBalance', ['CRITICAL'], opts({ priority: RPC_PRIORITY.CRITICAL_EXIT }));
    // The critical request ran within the first slots, not after 1,000 enrichment requests.
    expect(order.indexOf('CRITICAL')).toBeLessThan(30);
    await Promise.all(enrichment);
  }, 20_000);

  it('71. expiration: queued work for an expired candidate is dropped, never sent', async () => {
    let alive = true;
    const { manager, calls } = harness({ primary: () => ({ ...ok(1), delayMs: 10 }) });
    const blockers = Array.from({ length: 6 }, (_, index) => manager.request('getBalance', [`B${index}`], opts({ deadlineMs: 60_000 })));
    const queued = manager.request('getBalance', ['DEAD'], opts({ isRelevant: () => alive, deadlineMs: 60_000 }));
    alive = false;
    await expect(queued).rejects.toBeInstanceOf(RpcRequestDroppedError);
    await Promise.all(blockers);
    expect(calls.some((call) => call.params[0] === 'DEAD')).toBe(false);
    expect(manager.totals.droppedExpired).toBe(1);
  });

  it('73. circuit breaker: CLOSED -> OPEN after repeated failures, HALF_OPEN after cooldown, CLOSED after a good probe', async () => {
    const clock = { now: 1_000_000 };
    let healthy = false;
    const { manager } = harness({ primary: () => (healthy ? ok(5) : { status: 503, body: 'x' }) }, { clock });
    for (let index = 0; index < 3; index += 1) await manager.request('getSlot', [], opts({ cacheTtlMs: 0 })).catch(() => undefined);
    expect(manager.snapshot().providers[0].circuit).toBe('OPEN');
    await expect(manager.request('getSlot', [], opts({ cacheTtlMs: 0 }))).rejects.toThrow(/CIRCUIT_OPEN/);
    clock.now += 15_001;
    healthy = true;
    expect(await manager.request('getSlot', [], opts({ cacheTtlMs: 0, priority: RPC_PRIORITY.SECURITY }))).toBe(5);
    expect(manager.snapshot().providers[0].circuit).toBe('CLOSED');
  });

  it('74. connection reuse: one manager per process, providers deduplicated, secrets masked', () => {
    const same = new SolanaRpcManager({ providers: [{ role: 'primary', url: 'https://a.example' }, { role: 'secondary', url: 'https://a.example' }] });
    expect(same.providerCount).toBe(1);
    expect(same.snapshot().alerts.map((alert) => alert.code)).toContain('RPC_REDUNDANCY_LOW');
    expect(maskRpcUrl('https://mainnet.helius-rpc.com/?api-key=SECRET123')).toBe('https://mainnet.helius-rpc.com/***');
    expect(maskRpcUrl('https://rpc.ankr.com/solana/0123456789abcdef0123456789abcdef')).toBe('https://rpc.ankr.com/***');
    expect(JSON.stringify(new SolanaRpcManager({ providers: [{ role: 'primary', url: 'https://x.example/?api-key=TOPSECRET' }] }).snapshot())).not.toContain('TOPSECRET');
  });

  it('75/76. NewLaunch load simulation: dedup + cache + batching cut network requests; 429 does not storm', async () => {
    // Provider model from the observed environment: primary limits getTokenLargestAccounts per method (429),
    // secondary is forbidden (no key), fallback blocks getTokenLargestAccounts. Account reads succeed.
    const { manager, calls } = harness({
      primary: (method, params) => (method === 'getTokenLargestAccounts'
        ? { status: 429, headers: { 'retry-after': '10' }, body: { jsonrpc: '2.0', error: { code: 429, message: 'Too many requests for a specific RPC call' } } }
        : method === 'getMultipleAccounts' ? ok({ context: { slot: 1 }, value: (params[0] as string[]).map((key) => mintAccount(key).value) }) : ok(mintAccount(String(params[0])))),
      secondary: () => ({ status: 403, body: { error: 'message: API key is not allowed to access blockchain' } }),
      fallback: (method) => (method === 'getTokenLargestAccounts' ? { status: 200, body: { jsonrpc: '2.0', error: { code: -32602, message: 'Request blocked' } } } : ok(mintAccount('F'))),
    });
    const candidates = Array.from({ length: 300 }, (_, index) => `MINT${index}`);
    // Each candidate: security (NewLaunch) + scanner enrichment both read the mint, 3 re-evaluations, holders once.
    const work: Array<Promise<unknown>> = [];
    for (let round = 0; round < 3; round += 1) {
      for (const mint of candidates) {
        work.push(manager.getMintAccount(mint, opts({ caller: 'NewLaunchSecurity', priority: RPC_PRIORITY.SECURITY, subject: mint })));
        work.push(manager.getMintAccount(mint, opts({ caller: 'TokenScanner', subject: mint })));
        if (round === 0) work.push(manager.getTokenLargestAccounts(mint, opts({ caller: 'TokenScanner', subject: mint })).catch(() => null));
      }
      await Promise.all(work);
    }
    const snapshot = manager.snapshot();
    const logical = snapshot.totals.logicalRequests;
    const network = snapshot.totals.networkRequests;
    // 300 x (2 x 3 mint reads + 1 holder read) = 2,100 logical requests.
    expect(logical).toBe(2_100);
    // Mint reads: batched once (cache serves later rounds); holders: one 429 + one 403 + one "blocked", then skipped.
    expect(network).toBeLessThan(40);
    // Only requests already in flight when the first 429 / "blocked" answer arrived reach the providers (bounded by
    // the concurrency limit of 8 per wave); everything after that is skipped by the cooldown / capability map.
    const holderCalls = calls.filter((call) => call.method === 'getTokenLargestAccounts');
    expect(holderCalls.length).toBeLessThanOrEqual(2 * 8 + 2);
    expect(holderCalls.filter((call) => call.provider === 'primary').length).toBeLessThanOrEqual(9);
    expect(calls.filter((call) => call.provider === 'secondary').length).toBeLessThanOrEqual(8);
    expect(snapshot.totals.rateLimited).toBeLessThanOrEqual(9);
    expect(snapshot.savedRequests.cache + snapshot.savedRequests.dedup + snapshot.savedRequests.batching).toBeGreaterThan(1_500);
  });
});
