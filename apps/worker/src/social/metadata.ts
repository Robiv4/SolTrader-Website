/**
 * Stage 1 identity discovery: official social links from the token's metadata JSON (pump.fun create event `uri`).
 *
 * The URI is creator-controlled, so fetching is restricted (SSRF protection):
 *  - https only, no credentials / custom ports, hostname allowlist (no IP literals, no internal names);
 *  - every resolved address must be public (private / loopback / link-local / CGNAT / ULA addresses are refused);
 *  - redirects are followed manually (max 3) and every target passes the same checks;
 *  - 64 KiB size cap, per-request timeout, JSON object only; only identity fields are kept.
 *
 * IPFS: the public path gateways ipfs.io / dweb.link (and w3s.link / nftstorage.link, which redirect there) answer
 * every request with HTTP 429 "switching to a service worker gateway only" (verified 2026-10-18), and cf-ipfs.com /
 * ipfs.pump.fun no longer resolve. Most pump.fun URIs are https://ipfs.io/ipfs/<CID>, so the CID is extracted from any
 * IPFS-style URL and fetched from working gateways in order (default: ipfs.filebase.io, gateway.pinata.cloud). The
 * content is addressed by its CID, so the gateway does not change what is read.
 *
 * Metadata is untrusted: it only feeds social identity (MONITOR_ONLY), never a trading decision.
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export const DEFAULT_IPFS_GATEWAYS = ['https://ipfs.filebase.io/ipfs/', 'https://gateway.pinata.cloud/ipfs/'];
/**
 * Non-IPFS metadata hosts. arweave.net: permanent storage gateway. j7tracker.io / uxento.io / rapidlaunch.io: launch
 * tools that host the metadata of ~1/3 of pump.fun tokens in a 2026-10-18 sample (39 tokens: ipfs.io 22,
 * metadata.j7tracker.io 9, meta.uxento.io 3, *.myfilebase.com 2, gateway.pinata.cloud 1, m.rapidlaunch.io 1).
 */
export const DEFAULT_METADATA_HOSTS = ['arweave.net', '*.arweave.net', 'metadata.j7tracker.io', 'meta.uxento.io', 'm.rapidlaunch.io'];
/** Hosts that are IPFS gateways: the URL is rewritten to the configured gateways (path /ipfs/<cid> or <cid>.ipfs.<host>). */
const IPFS_GATEWAY_HOST = /(^|\.)(ipfs\.io|dweb\.link|w3s\.link|nftstorage\.link|cf-ipfs\.com|cloudflare-ipfs\.com|ipfs\.pump\.fun|gateway\.pinata\.cloud|mypinata\.cloud|myfilebase\.com|ipfs\.filebase\.io|4everland\.io)$/i;
const CID = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{50,})$/;
const MAX_BYTES = 64 * 1024;
const MAX_REDIRECTS = 3;

export type MetadataFailure = 'MISSING_URI' | 'REJECTED_URL' | 'DNS' | 'PRIVATE_ADDRESS' | 'HTTP' | 'RATE_LIMITED' | 'TIMEOUT' | 'NETWORK' | 'TOO_LARGE' | 'JSON' | 'REDIRECT_REJECTED';
export interface TokenMetadata { twitter: string | null; telegram: string | null; website: string | null; name: string | null; symbol: string | null; image: string | null }
export type MetadataResult =
  | { status: 'RESOLVED'; metadata: TokenMetadata; host: string; attempts: number }
  | { status: 'FAILED'; reason: MetadataFailure; transient: boolean; detail: string | null; attempts: number };

export interface MetadataConfig {
  ipfsGateways?: string[];
  extraHosts?: string[];
  timeoutMs?: number;
}

type Target = { kind: 'IPFS'; cid: string; path: string } | { kind: 'HTTPS'; url: URL };

const hostMatches = (host: string, patterns: string[]) => patterns.some((pattern) => (pattern.startsWith('*.') ? host.endsWith(pattern.slice(1)) : host === pattern));

/** Parses a metadata URI: IPFS content (any gateway / ipfs://) or an allowlisted https URL; null = rejected. */
export function metadataTarget(uri: string | null | undefined, extraHosts: string[] = []): Target | null {
  if (!uri) return null;
  const trimmed = uri.trim();
  if (/^ipfs:\/\//i.test(trimmed)) {
    const [cid, ...rest] = trimmed.slice(7).replace(/^ipfs\//i, '').split('/');
    return CID.test(cid) ? { kind: 'IPFS', cid, path: rest.length ? `/${rest.map(encodeURIComponent).join('/')}` : '' } : null;
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || url.port || isIP(host.replace(/^\[|\]$/g, '')) !== 0) return null;
  if (IPFS_GATEWAY_HOST.test(host)) {
    const sub = /^([a-z0-9]+)\.ipfs\./i.exec(host);
    if (sub && CID.test(sub[1])) return { kind: 'IPFS', cid: sub[1], path: url.pathname === '/' ? '' : url.pathname };
    const match = /^\/ipfs\/([^/]+)(\/.*)?$/.exec(url.pathname);
    if (match && CID.test(match[1])) return { kind: 'IPFS', cid: match[1], path: match[2] ?? '' };
    return null;
  }
  return hostMatches(host, [...DEFAULT_METADATA_HOSTS, ...extraHosts.map((item) => item.toLowerCase())]) ? { kind: 'HTTPS', url } : null;
}

/** Ordered fetch candidates for a URI (IPFS: one URL per configured gateway). */
export function metadataCandidates(uri: string | null | undefined, config: MetadataConfig = {}): string[] {
  const target = metadataTarget(uri, config.extraHosts);
  if (!target) return [];
  if (target.kind === 'HTTPS') return [target.url.toString()];
  return (config.ipfsGateways?.length ? config.ipfsGateways : DEFAULT_IPFS_GATEWAYS).map((gateway) => `${gateway.replace(/\/?$/, '/')}${target.cid}${target.path}`);
}

/** Compatibility helper: first fetch candidate (null = rejected). */
export function safeMetadataUrl(uri: string | null | undefined, config: MetadataConfig = {}) {
  return metadataCandidates(uri, config)[0] ?? null;
}

/** True for addresses that must never be fetched (loopback, private, link-local, CGNAT, multicast, ULA, mapped). */
export function isPrivateAddress(address: string) {
  const v4 = /^(?:::ffff:)?(\d+)\.(\d+)\.(\d+)\.(\d+)$/i.exec(address);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  const lower = address.toLowerCase();
  return lower === '::' || lower === '::1' || /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower) || /^ff/.test(lower) || lower.startsWith('::ffff:') || lower.startsWith('64:ff9b:');
}

export type MetadataFetch = (input: string, init: { signal: globalThis.AbortSignal; redirect: 'manual'; headers: Record<string, string> }) => Promise<{ status: number; headers: { get(name: string): string | null }; text(): Promise<string> }>;
export type Lookup = (host: string) => Promise<Array<{ address: string }>>;

export interface MetadataDeps {
  fetch?: MetadataFetch;
  lookup?: Lookup;
}

const defaultLookup: Lookup = (host) => dnsLookup(host, { all: true, verbatim: true });
const fail = (reason: MetadataFailure, transient: boolean, detail: string | null = null) => ({ status: 'FAILED' as const, reason, transient, detail, attempts: 0 });

/** Only the identity fields are kept (each string capped); the logo must pass the same rules as the metadata URL. */
function pickIdentity(record: Record<string, unknown>, config: MetadataConfig): TokenMetadata {
  const pick = (key: string) => (typeof record[key] === 'string' && (record[key] as string).trim() ? (record[key] as string).trim().slice(0, 300) : null);
  const extensions = record.extensions && typeof record.extensions === 'object' ? record.extensions as Record<string, unknown> : {};
  const fromExtensions = (key: string) => (typeof extensions[key] === 'string' ? (extensions[key] as string).trim().slice(0, 300) || null : null);
  return {
    twitter: pick('twitter') ?? fromExtensions('twitter'), telegram: pick('telegram') ?? fromExtensions('telegram'), website: pick('website') ?? fromExtensions('website'),
    name: pick('name'), symbol: pick('symbol'), image: safeMetadataUrl(pick('image'), config),
  };
}

/** One URL, redirects followed manually with the same checks. */
async function fetchOne(start: string, config: MetadataConfig, deps: MetadataDeps): Promise<MetadataResult> {
  const fetcher = deps.fetch ?? (globalThis.fetch as unknown as MetadataFetch);
  const lookup = deps.lookup ?? defaultLookup;
  let current = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const url = new URL(current);
    let addresses: Array<{ address: string }>;
    try {
      addresses = await lookup(url.hostname);
    } catch (error) {
      const code = (error as { code?: string }).code ?? 'DNS';
      return fail('DNS', code === 'EAI_AGAIN' || code === 'ETIMEOUT', code);
    }
    if (!addresses.length || addresses.some((entry) => isPrivateAddress(entry.address))) return fail('PRIVATE_ADDRESS', false, url.hostname);
    let response: Awaited<ReturnType<MetadataFetch>>;
    try {
      response = await fetcher(url.toString(), { signal: globalThis.AbortSignal.timeout(config.timeoutMs ?? 6_000), redirect: 'manual', headers: { Accept: 'application/json' } });
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      if (name === 'TimeoutError' || name === 'AbortError') return fail('TIMEOUT', true);
      const code = (error as { cause?: { code?: string } }).cause?.code ?? null;
      if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return fail('DNS', code === 'EAI_AGAIN', code);
      return fail('NETWORK', true, code);
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) return fail('HTTP', false, `HTTP ${response.status} without location`);
      const next = new URL(location, url);
      // A redirect target must be an acceptable metadata URL itself (https, allowlisted host / IPFS gateway).
      if (!metadataTarget(next.toString(), config.extraHosts)) return fail('REDIRECT_REJECTED', false, next.hostname);
      current = next.toString();
      continue;
    }
    if (response.status === 429) return fail('RATE_LIMITED', true, `HTTP 429 ${url.hostname}`);
    if (response.status < 200 || response.status >= 300) return fail('HTTP', response.status >= 500, `HTTP ${response.status} ${url.hostname}`);
    const length = Number(response.headers.get('content-length'));
    if (Number.isFinite(length) && length > MAX_BYTES) return fail('TOO_LARGE', false);
    const text = await response.text();
    if (text.length > MAX_BYTES) return fail('TOO_LARGE', false);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return fail('JSON', false);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fail('JSON', false);
    return { status: 'RESOLVED', metadata: pickIdentity(parsed as Record<string, unknown>, config), host: url.hostname, attempts: 0 };
  }
  return fail('REDIRECT_REJECTED', false, 'TOO_MANY_REDIRECTS');
}

/**
 * Resolves the metadata of one URI: candidates tried in order until one succeeds. The failure reported is the most
 * informative one (a permanent failure on every candidate is permanent; any transient failure makes it transient).
 */
export async function resolveTokenMetadata(uri: string | null | undefined, config: MetadataConfig = {}, deps: MetadataDeps = {}): Promise<MetadataResult> {
  if (!uri || !uri.trim()) return { ...fail('MISSING_URI', false), attempts: 0 };
  const candidates = metadataCandidates(uri, config);
  if (!candidates.length) return { ...fail('REJECTED_URL', false, (() => { try { return new URL(uri).hostname; } catch { return null; } })()), attempts: 0 };
  let last: MetadataResult | null = null;
  let transient = false;
  for (const [index, candidate] of candidates.entries()) {
    const result = await fetchOne(candidate, config, deps);
    if (result.status === 'RESOLVED') return { ...result, attempts: index + 1 };
    transient ||= result.transient;
    last = result;
  }
  return { ...(last as Extract<MetadataResult, { status: 'FAILED' }>), transient, attempts: candidates.length };
}

/** Compatibility wrapper (identity fields or null). */
export async function fetchTokenMetadata(uri: string | null | undefined, config: MetadataConfig = {}, deps: MetadataDeps = {}): Promise<TokenMetadata | null> {
  const result = await resolveTokenMetadata(uri, config, deps);
  return result.status === 'RESOLVED' ? result.metadata : null;
}

/** Retry schedule for transient failures (attempt 1 = first retry). */
export const METADATA_RETRY_DELAYS_MS = [30_000, 120_000, 480_000];
