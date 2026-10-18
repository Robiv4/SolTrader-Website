/**
 * Token metadata discovery (Telegram links): pump.fun URI hand-over, URL validation / SSRF protection, IPFS gateway
 * rewrite, classified failures (DNS / HTTP / timeout / JSON / redirect), bounded retry with backoff. All network access
 * is mocked.
 */
import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { LaunchTracker } from '../src/launch/launch-tracker.js';
import { decodePumpFunEvent } from '../src/launch/providers.js';
import {
  isPrivateAddress, METADATA_RETRY_DELAYS_MS, metadataCandidates, resolveTokenMetadata, type Lookup, type MetadataFetch, type MetadataResult,
} from '../src/social/metadata.js';
import { SocialService } from '../src/social/social-service.js';

const CID_V1 = 'bafkreids77owtzy5vqef5aqadccck5ljigdkjeb2zbyxziporslkmqrria';
const CID_V0 = 'QmZWEuvDH5HJLfrria691TTk8GzsoC6A3h77wLudahR24Z';
const MINT = 'So1aNaMint1111111111111111111111111111111pump';
const publicLookup: Lookup = async () => [{ address: '104.18.1.1' }];
const response = (status: number, body = '', headers: Record<string, string> = {}) => ({ status, headers: { get: (name: string) => headers[name.toLowerCase()] ?? null }, text: async () => body });
const json = (value: unknown) => response(200, JSON.stringify(value), { 'content-type': 'application/json' });

describe('metadata URL validation (SSRF protection)', () => {
  it('IPFS URIs are fetched by CID from working gateways (ipfs.io / dweb.link answer HTTP 429 to everything)', () => {
    const expected = [`https://ipfs.filebase.io/ipfs/${CID_V1}`, `https://gateway.pinata.cloud/ipfs/${CID_V1}`];
    expect(metadataCandidates(`https://ipfs.io/ipfs/${CID_V1}`)).toEqual(expected);
    expect(metadataCandidates(`ipfs://${CID_V1}`)).toEqual(expected);
    expect(metadataCandidates(`ipfs://ipfs/${CID_V1}`)).toEqual(expected);
    expect(metadataCandidates(`https://${CID_V1}.ipfs.dweb.link/`)).toEqual(expected);
    expect(metadataCandidates(`https://chubby-amethyst-finch.myfilebase.com/ipfs/${CID_V1}`)).toEqual(expected);
    expect(metadataCandidates(`https://cf-ipfs.com/ipfs/${CID_V0}/meta.json`)[0]).toBe(`https://ipfs.filebase.io/ipfs/${CID_V0}/meta.json`);
    expect(metadataCandidates(`https://ipfs.io/ipfs/${CID_V1}`, { ipfsGateways: ['https://gw.example.org/ipfs/'] })).toEqual([`https://gw.example.org/ipfs/${CID_V1}`]);
  });

  it('allowlisted non-IPFS hosts only; everything else is rejected', () => {
    expect(metadataCandidates('https://metadata.j7tracker.io/metadata/rDwASoflez.json')).toEqual(['https://metadata.j7tracker.io/metadata/rDwASoflez.json']);
    expect(metadataCandidates('https://arweave.net/abc')).toHaveLength(1);
    for (const bad of [
      'http://ipfs.io/ipfs/' + CID_V1, 'https://evil.example.com/meta.json', 'https://localhost/x', 'https://169.254.169.254/latest/meta-data', 'https://[::1]/x',
      'https://user:pass@arweave.net/x', 'https://arweave.net:8443/x', 'https://ipfs.io/ipfs/not-a-cid', 'https://ipfs.io/', 'file:///etc/passwd', 'javascript:alert(1)', '',
    ]) expect(metadataCandidates(bad), bad).toEqual([]);
    expect(metadataCandidates('https://launcher.example.net/m.json', { extraHosts: ['launcher.example.net'] })).toHaveLength(1);
  });

  it('private / internal addresses are recognised', () => {
    for (const address of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) expect(isPrivateAddress(address), address).toBe(true);
    for (const address of ['104.18.1.1', '8.8.8.8', '2606:4700::1111']) expect(isPrivateAddress(address), address).toBe(false);
  });
});

describe('metadata fetching: classified failures, gateway fallback, redirects', () => {
  const meta = { name: 'Zorbulator', symbol: 'ZORB', telegram: 'https://t.me/ZorbChat', twitter: 'https://x.com/zorb', website: 'https://zorb.xyz', image: `https://ipfs.io/ipfs/${CID_V0}`, description: 'x'.repeat(50) };

  it('success: identity fields only; the logo passes the same rules', async () => {
    const result = await resolveTokenMetadata(`https://ipfs.io/ipfs/${CID_V1}`, {}, { lookup: publicLookup, fetch: async () => json(meta) });
    expect(result).toMatchObject({ status: 'RESOLVED', host: 'ipfs.filebase.io', metadata: { telegram: 'https://t.me/ZorbChat', name: 'Zorbulator', image: `https://ipfs.filebase.io/ipfs/${CID_V0}` } });
    expect(Object.keys((result as Extract<MetadataResult, { status: 'RESOLVED' }>).metadata)).not.toContain('description');
  });

  it('HTTP 429 on the first gateway: the next gateway is tried', async () => {
    const calls: string[] = [];
    const fetch: MetadataFetch = async (url) => {
      calls.push(new URL(url).hostname);
      return calls.length === 1 ? response(429, 'switching to a service worker gateway only') : json(meta);
    };
    const result = await resolveTokenMetadata(`https://ipfs.io/ipfs/${CID_V1}`, {}, { lookup: publicLookup, fetch });
    expect(calls).toEqual(['ipfs.filebase.io', 'gateway.pinata.cloud']);
    expect(result).toMatchObject({ status: 'RESOLVED', attempts: 2 });
  });

  it('each failure class is reported separately (transient vs permanent)', async () => {
    const run = (fetch: MetadataFetch, lookup: Lookup = publicLookup, uri = 'https://metadata.j7tracker.io/m.json') => resolveTokenMetadata(uri, {}, { fetch, lookup });
    expect(await resolveTokenMetadata(null)).toMatchObject({ status: 'FAILED', reason: 'MISSING_URI', transient: false });
    expect(await resolveTokenMetadata('https://evil.example.com/x.json')).toMatchObject({ reason: 'REJECTED_URL', transient: false, detail: 'evil.example.com' });
    expect(await run(async () => json({}), async () => { throw Object.assign(new Error('nx'), { code: 'ENOTFOUND' }); })).toMatchObject({ reason: 'DNS', transient: false });
    expect(await run(async () => json({}), async () => { throw Object.assign(new Error('again'), { code: 'EAI_AGAIN' }); })).toMatchObject({ reason: 'DNS', transient: true });
    expect(await run(async () => json({}), async () => [{ address: '10.0.0.5' }])).toMatchObject({ reason: 'PRIVATE_ADDRESS', transient: false });
    expect(await run(async () => response(404))).toMatchObject({ reason: 'HTTP', transient: false });
    expect(await run(async () => response(503))).toMatchObject({ reason: 'HTTP', transient: true });
    expect(await run(async () => response(429))).toMatchObject({ reason: 'RATE_LIMITED', transient: true });
    expect(await run(async () => { throw Object.assign(new Error('timeout'), { name: 'TimeoutError' }); })).toMatchObject({ reason: 'TIMEOUT', transient: true });
    expect(await run(async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }); })).toMatchObject({ reason: 'NETWORK', transient: true });
    expect(await run(async () => response(200, '<html>'))).toMatchObject({ reason: 'JSON', transient: false });
    expect(await run(async () => response(200, '[1,2]'))).toMatchObject({ reason: 'JSON' });
    expect(await run(async () => response(200, 'x'.repeat(70_000)))).toMatchObject({ reason: 'TOO_LARGE' });
    expect(await run(async () => response(200, '{}', { 'content-length': '999999' }))).toMatchObject({ reason: 'TOO_LARGE' });
  });

  it('redirects are followed manually and every target is checked again', async () => {
    const lookups: string[] = [];
    const lookup: Lookup = async (host) => {
      lookups.push(host);
      return host === 'internal.arweave.net' ? [{ address: '192.168.0.10' }] : [{ address: '104.18.1.1' }];
    };
    const redirect = (to: string): MetadataFetch => async (url) => (url.includes('arweave.net/start') ? response(302, '', { location: to }) : json(meta));
    expect(await resolveTokenMetadata('https://arweave.net/start', {}, { lookup, fetch: redirect('https://arweave.net/final') })).toMatchObject({ status: 'RESOLVED' });
    expect(await resolveTokenMetadata('https://arweave.net/start', {}, { lookup, fetch: redirect('https://evil.example.com/x') })).toMatchObject({ reason: 'REDIRECT_REJECTED', detail: 'evil.example.com' });
    expect(await resolveTokenMetadata('https://arweave.net/start', {}, { lookup, fetch: redirect('http://arweave.net/x') })).toMatchObject({ reason: 'REDIRECT_REJECTED' });
    // DNS rebinding style: an allowlisted name that resolves to a private address is refused.
    expect(await resolveTokenMetadata('https://arweave.net/start', {}, { lookup, fetch: redirect('https://internal.arweave.net/x') })).toMatchObject({ reason: 'PRIVATE_ADDRESS' });
    expect(lookups).toContain('internal.arweave.net');
    const loop: MetadataFetch = async () => response(301, '', { location: 'https://arweave.net/start' });
    expect(await resolveTokenMetadata('https://arweave.net/start', {}, { lookup, fetch: loop })).toMatchObject({ reason: 'REDIRECT_REJECTED', detail: 'TOO_MANY_REDIRECTS' });
  });
});

/** pump.fun CreateEvent ("Program data" payload) with the given strings. */
function createEventPayload(name: string, symbol: string, uri: string) {
  const text = (value: string) => {
    const bytes = Buffer.from(value, 'utf8');
    const length = Buffer.alloc(4);
    length.writeUInt32LE(bytes.length);
    return Buffer.concat([length, bytes]);
  };
  const discriminator = createHash('sha256').update('event:CreateEvent').digest().subarray(0, 8);
  const key = (seed: number) => Buffer.alloc(32, seed);
  return Buffer.concat([discriminator, text(name), text(symbol), text(uri), key(1), key(2), key(3)]).toString('base64');
}

describe('pump.fun metadata URI hand-over', () => {
  it('create event -> launch tracker -> social service resolver receives the same URI', async () => {
    const uri = `https://ipfs.io/ipfs/${CID_V1}`;
    const event = decodePumpFunEvent(createEventPayload('Zorbulator', 'ZORB', uri));
    expect(event).toMatchObject({ type: 'create', uri, name: 'Zorbulator' });
    const tracker = new LaunchTracker(60_000);
    tracker.add({ source: 'PUMP_FUN', mint: MINT, detectedAt: 1, createdAt: null, bondingCurve: 'B', poolAddress: 'B', quoteMint: 'W', creator: 'C', name: 'Zorbulator', symbol: 'ZORB', metadataUri: event!.type === 'create' ? event!.uri : null });
    const launch = tracker.launches.get(MINT)!;
    expect(launch.metadataUri).toBe(uri);
    const seen: Array<string | null> = [];
    const service = new SocialService({ prisma: { socialSnapshot: { create: async () => ({}) }, launchCandidate: { updateMany: async () => ({ count: 1 }) } } as never, providers: [], logger: { info: () => undefined, warn: () => undefined }, resolveMetadata: async (value) => { seen.push(value); return { status: 'FAILED', reason: 'HTTP', transient: false, detail: null, attempts: 1 }; } });
    service.track({ mint: MINT, symbol: launch.symbol, name: launch.name, metadataUri: launch.metadataUri, stage: 3 });
    await service.tick();
    await new Promise((resolve) => globalThis.setTimeout(resolve, 5));
    expect(seen).toEqual([uri]);
  });
});

describe('metadata retry / backoff in the social service', () => {
  function setup(results: MetadataResult[]) {
    let now = 1_000_000;
    const calls: number[] = [];
    const service = new SocialService({
      prisma: { socialSnapshot: { create: async () => ({}) }, launchCandidate: { updateMany: async () => ({ count: 1 }) } } as never, providers: [], logger: { info: () => undefined, warn: () => undefined }, now: () => now,
      resolveMetadata: async () => {
        calls.push(now);
        return results[Math.min(calls.length - 1, results.length - 1)];
      },
    });
    const tick = async () => {
      await service.tick();
      await new Promise((resolve) => globalThis.setTimeout(resolve, 5));
    };
    return { service, calls, tick, advance: (ms: number) => { now += ms; } };
  }
  const transient: MetadataResult = { status: 'FAILED', reason: 'TIMEOUT', transient: true, detail: null, attempts: 2 };
  const resolved: MetadataResult = { status: 'RESOLVED', metadata: { telegram: 'https://t.me/zorbchat', twitter: null, website: null, name: 'Zorbulator', symbol: 'ZORB', image: null }, host: 'ipfs.filebase.io', attempts: 1 };

  it('transient failure: retried after 30 s / 2 min / 8 min, then given up (bounded)', async () => {
    const h = setup([transient]);
    h.service.track({ mint: MINT, symbol: 'ZORB', name: 'Zorbulator', metadataUri: `ipfs://${CID_V1}`, stage: 3 });
    await h.tick();
    expect(h.calls).toHaveLength(1);
    await h.tick();
    expect(h.calls).toHaveLength(1);
    for (const delay of METADATA_RETRY_DELAYS_MS) {
      h.advance(delay);
      await h.tick();
    }
    expect(h.calls).toHaveLength(1 + METADATA_RETRY_DELAYS_MS.length);
    const health = h.service.health();
    expect(health.metadata).toMatchObject({ withUri: 1, retries: METADATA_RETRY_DELAYS_MS.length, resolved: 0, retryQueue: 0 });
    expect(health.metadata.failed.TIMEOUT).toBe(1 + METADATA_RETRY_DELAYS_MS.length);
    expect(health.metadata.states).toEqual({ UNAVAILABLE: 1 });
    h.advance(20 * 60_000);
    await h.tick();
    expect(h.calls).toHaveLength(1 + METADATA_RETRY_DELAYS_MS.length);
  });

  it('a retry that succeeds sets the official Telegram link', async () => {
    const h = setup([transient, resolved]);
    h.service.track({ mint: MINT, symbol: 'ZORB', name: 'Zorbulator', metadataUri: `ipfs://${CID_V1}`, stage: 3 });
    await h.tick();
    h.advance(METADATA_RETRY_DELAYS_MS[0]);
    await h.tick();
    expect(h.service.identity(MINT)?.officialTelegram).toBe('zorbchat');
    expect(h.service.health().metadata).toMatchObject({ resolved: 1, withTelegramLink: 1, byHost: { 'ipfs.filebase.io': 1 } });
  });

  it('missing URI is counted; a URI arriving later is resolved then', async () => {
    const seen: Array<string | null> = [];
    const service = new SocialService({
      prisma: { socialSnapshot: { create: async () => ({}) }, launchCandidate: { updateMany: async () => ({ count: 1 }) } } as never, providers: [], logger: { info: () => undefined, warn: () => undefined },
      resolveMetadata: async (uri) => {
        seen.push(uri);
        return uri ? resolved : resolveTokenMetadata(uri);
      },
    });
    const tick = async () => {
      await service.tick();
      await new Promise((resolve) => globalThis.setTimeout(resolve, 5));
    };
    service.track({ mint: MINT, symbol: 'ZORB', name: 'Zorbulator', metadataUri: null, stage: 3 });
    await tick();
    expect(service.health().metadata).toMatchObject({ missingUri: 1, withUri: 0 });
    expect(service.health().metadata.failed.MISSING_URI).toBe(1);
    service.track({ mint: MINT, symbol: 'ZORB', name: 'Zorbulator', metadataUri: `ipfs://${CID_V1}`, stage: 3 });
    await tick();
    expect(seen).toEqual([null, `ipfs://${CID_V1}`]);
    expect(service.identity(MINT)?.officialTelegram).toBe('zorbchat');
  });
});
