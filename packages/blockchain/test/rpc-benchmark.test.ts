/**
 * Reproducible BEFORE / AFTER RPC benchmark (test 76). No production metrics were collected before this change, so
 * the baseline is this synthetic workload replayed through the legacy code paths, against mocked providers that
 * reproduce the behaviour measured on 2026-10-04:
 *   primary  (api.mainnet-beta.solana.com): getAccountInfo OK, getTokenLargestAccounts -> 429 "specific RPC call"
 *   secondary (rpc.ankr.com/solana, no key): every call -> 403 "API key is not allowed to access blockchain"
 *   fallback (solana-rpc.publicnode.com): getAccountInfo OK, getTokenLargestAccounts -> "Request blocked"
 *
 * Workload: 200 scanner candidates x 3 rotation cycles (mint info + largest holders each), 200 NewLaunch mints
 * (security mint check), 50 of them overlapping with the scanner set.
 */
import { describe, expect, it } from 'vitest';

import { RpcProviderPool, type RpcConfig, type SolanaConnection } from '../src/index.js';
import { RPC_PRIORITY, SolanaRpcManager, type RpcTransport } from '../src/rpc-manager.js';

type Count = { network: number; byProvider: Record<string, number>; byMethod: Record<string, number>; rateLimited: number; forbidden: number; blocked: number; keys: Map<string, number> };
const newCount = (): Count => ({ network: 0, byProvider: {}, byMethod: {}, rateLimited: 0, forbidden: 0, blocked: 0, keys: new Map() });

/** Observed provider behaviour. Returns [httpStatus, body]. */
function reply(provider: string, method: string, params: unknown[]): [number, unknown] {
  const mintAccount = (mint: string) => ({ data: { program: 'spl-token', parsed: { info: { decimals: 6, supply: '1000000', mintAuthority: null, freezeAuthority: null, mint } } } });
  if (provider === 'secondary') return [403, { error: 'message: API key is not allowed to access blockchain, json-rpc code: -32052, rest code: 403' }];
  if (method === 'getTokenLargestAccounts') {
    return provider === 'primary'
      ? [429, { jsonrpc: '2.0', id: 1, error: { code: 429, message: 'Too many requests for a specific RPC call' } }]
      : [200, { jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'Request blocked' } }];
  }
  if (method === 'getMultipleAccounts') return [200, { jsonrpc: '2.0', id: 1, result: { context: { slot: 1 }, value: (params[0] as string[]).map(mintAccount) } }];
  return [200, { jsonrpc: '2.0', id: 1, result: { context: { slot: 1 }, value: mintAccount(String(params[0])) } }];
}

function record(count: Count, provider: string, method: string, params: unknown[], status: number, body: unknown) {
  count.network += 1;
  count.byProvider[provider] = (count.byProvider[provider] ?? 0) + 1;
  count.byMethod[method] = (count.byMethod[method] ?? 0) + 1;
  const key = `${method}|${JSON.stringify(params)}`;
  count.keys.set(key, (count.keys.get(key) ?? 0) + 1);
  if (status === 429) count.rateLimited += 1;
  if (status === 403) count.forbidden += 1;
  if (JSON.stringify(body).includes('Request blocked')) count.blocked += 1;
}

const URL_ROLE: Record<string, string> = { 'https://primary.test': 'primary', 'https://secondary.test': 'secondary', 'https://fallback.test': 'fallback' };
const SCANNER = Array.from({ length: 200 }, (_, index) => `SCAN${index}`);
const LAUNCHES = [...SCANNER.slice(0, 50), ...Array.from({ length: 150 }, (_, index) => `LAUNCH${index}`)];

/** Legacy path: RpcProviderPool (provider-wide cooldowns) for the scanner, direct primary call (+ pool) for NewLaunch. */
async function legacy() {
  const count = newCount();
  const call = async (provider: string, method: string, params: unknown[]) => {
    const [status, body] = reply(provider, method, params);
    record(count, provider, method, params, status, body);
    if (status !== 200) throw new Error(`${status}: ${JSON.stringify(body)}`);
    const parsed = body as { error?: { message: string }; result?: unknown };
    if (parsed.error) throw new Error(parsed.error.message);
    return parsed.result;
  };
  const config: RpcConfig = { network: 'mainnet-beta', commitment: 'confirmed', timeoutMs: 5_000, rateLimitCooldownMs: 30_000, endpoints: [{ name: 'primary', url: 'https://primary.test' }, { name: 'secondary', url: 'https://secondary.test' }, { name: 'fallback', url: 'https://fallback.test' }] };
  const pool = new RpcProviderPool(config, { create: (endpoint) => ({
    getSlot: async () => 1, getBalance: async () => 0, getTokenBalances: async () => [],
    getMintInfo: async (mint: string) => {
      const result = await call(endpoint.name, 'getAccountInfo', [mint, { encoding: 'jsonParsed', commitment: 'confirmed' }]) as { value: { data: { parsed: { info: Record<string, unknown> } } } };
      const info = result.value.data.parsed.info;
      return { address: mint, decimals: 6, supply: '1000000', mintAuthority: info.mintAuthority as string | null, freezeAuthority: info.freezeAuthority as string | null };
    },
    getTokenLargestHolders: async (mint: string) => {
      await call(endpoint.name, 'getTokenLargestAccounts', [mint, { commitment: 'confirmed' }]);
      return [];
    },
  } as SolanaConnection) });
  let scannerAuthorityKnown = 0;
  let launchAuthorityKnown = 0;
  for (let cycle = 0; cycle < 3; cycle += 1) {
    for (const mint of SCANNER) {
      // Legacy scanner: mint info THEN holders inside one try -> a holder failure discarded the mint info as well.
      try {
        await pool.getMintInfo(mint);
        await pool.getTokenLargestHolders(mint, 10);
        if (cycle === 0) scannerAuthorityKnown += 1;
      } catch {
        // "On-chain enrichment unavailable; using conservative defaults"
      }
    }
  }
  for (const mint of LAUNCHES) {
    try {
      await call('primary', 'getAccountInfo', [mint, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
      launchAuthorityKnown += 1;
    } catch {
      await pool.getMintInfo(mint).then(() => { launchAuthorityKnown += 1; }, () => undefined);
    }
  }
  return { count, logical: SCANNER.length * 3 * 2 + LAUNCHES.length, scannerAuthorityKnown, launchAuthorityKnown };
}

async function managed() {
  const count = newCount();
  const transport: RpcTransport = async ({ url, body }) => {
    const provider = URL_ROLE[url];
    const request = JSON.parse(body) as { method: string; params: unknown[] };
    const [status, payload] = reply(provider, request.method, request.params);
    record(count, provider, request.method, request.params, status, payload);
    return { status, headers: { get: (name: string) => (name === 'retry-after' && status === 429 ? '10' : null) }, text: async () => JSON.stringify(payload) };
  };
  const manager = new SolanaRpcManager({ providers: Object.entries(URL_ROLE).map(([url, role]) => ({ url, role: role as 'primary' })), transport, batchWindowMs: 5 });
  let scannerAuthorityKnown = 0;
  let launchAuthorityKnown = 0;
  for (let cycle = 0; cycle < 3; cycle += 1) {
    // The scanner processes tokens sequentially (one candidate at a time), as in production.
    for (const mint of SCANNER) {
      const options = { caller: 'TokenScanner', priority: RPC_PRIORITY.ENRICHMENT, subject: mint };
      const [mintInfo] = await Promise.allSettled([manager.getMintAccount(mint, options), manager.getTokenLargestAccounts(mint, options)]);
      if (cycle === 0 && mintInfo.status === 'fulfilled' && mintInfo.value) scannerAuthorityKnown += 1;
    }
  }
  // NewLaunch security checks arrive concurrently (bursts of launches) -> batched + deduplicated.
  const results = await Promise.allSettled(LAUNCHES.map((mint) => manager.getMintAccount(mint, { caller: 'NewLaunchSecurity', priority: RPC_PRIORITY.SECURITY, subject: mint })));
  launchAuthorityKnown = results.filter((result) => result.status === 'fulfilled' && result.value).length;
  return { count, logical: manager.totals.logicalRequests, scannerAuthorityKnown, launchAuthorityKnown, snapshot: manager.snapshot() };
}

const duplicatePct = (count: Count) => {
  const duplicates = [...count.keys.values()].reduce((sum, value) => sum + Math.max(0, value - 1), 0);
  return count.network ? duplicates / count.network * 100 : 0;
};

describe('RPC before / after benchmark (synthetic, reproducible)', () => {
  it('76. the managed path sends far fewer requests, never storms 429 / 403, and keeps the authority data', async () => {
    const before = await legacy();
    const after = await managed();
    const candidates = new Set([...SCANNER, ...LAUNCHES]).size;
    const row = (label: string, value: { count: Count; logical: number; scannerAuthorityKnown: number; launchAuthorityKnown: number }) => ({
      label, logicalRequests: value.logical, networkRequests: value.count.network, networkPerCandidate: +(value.count.network / candidates).toFixed(2),
      duplicatePct: +duplicatePct(value.count).toFixed(1), rateLimited429: value.count.rateLimited, forbidden403: value.count.forbidden, blocked: value.count.blocked,
      byMethod: value.count.byMethod, byProvider: value.count.byProvider,
      scannerAuthorityKnownPct: +(value.scannerAuthorityKnown / SCANNER.length * 100).toFixed(0), launchAuthorityKnownPct: +(value.launchAuthorityKnown / LAUNCHES.length * 100).toFixed(0),
    });
    const report = { candidates, before: row('BEFORE (legacy)', before), after: { ...row('AFTER (SolanaRpcManager)', after), cacheHitPct: +(after.snapshot.cacheHitRatePct ?? 0).toFixed(1), saved: after.snapshot.savedRequests } };
    console.log(`RPC_BENCHMARK ${JSON.stringify(report)}`);
    expect(after.count.network).toBeLessThan(before.count.network / 5);
    expect(after.count.rateLimited).toBeLessThanOrEqual(2);
    expect(after.count.forbidden).toBeLessThanOrEqual(2);
    expect(report.after.scannerAuthorityKnownPct).toBe(100);
    expect(report.before.scannerAuthorityKnownPct).toBe(0);
  }, 60_000);
});
