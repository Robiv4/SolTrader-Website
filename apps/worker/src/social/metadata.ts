/**
 * Stage 1 identity discovery: official social links from the token's metadata JSON (pump.fun create event `uri`).
 *
 * The URI is creator-controlled, so fetching is restricted (SSRF protection): https only, an allowlist of public
 * IPFS / Arweave gateways, a size cap and a short timeout. Anything else is skipped (identity then falls back to
 * name / ticker, which never reaches a confident match on its own).
 */
const ALLOWED_HOSTS = [/^ipfs\.io$/, /^cf-ipfs\.com$/, /^gateway\.pinata\.cloud$/, /\.mypinata\.cloud$/, /^arweave\.net$/, /^dweb\.link$/, /\.ipfs\.dweb\.link$/, /^nftstorage\.link$/, /\.ipfs\.nftstorage\.link$/, /^ipfs\.pump\.fun$/, /^metadata\.pump\.fun$/];
const MAX_BYTES = 64 * 1024;

export function safeMetadataUrl(uri: string | null | undefined): string | null {
  if (!uri) return null;
  const normalized = uri.startsWith('ipfs://') ? `https://ipfs.io/ipfs/${uri.slice(7).replace(/^ipfs\//, '')}` : uri;
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  return ALLOWED_HOSTS.some((pattern) => pattern.test(url.hostname.toLowerCase())) ? url.toString() : null;
}

type Fetch = (input: string, init?: { signal?: globalThis.AbortSignal; redirect?: 'error' }) => Promise<{ ok: boolean; headers: { get(name: string): string | null }; text(): Promise<string> }>;

export async function fetchTokenMetadata(uri: string | null | undefined, fetcher: Fetch = globalThis.fetch as unknown as Fetch): Promise<Record<string, unknown> | null> {
  const url = safeMetadataUrl(uri);
  if (!url) return null;
  // Redirects are refused (a redirect could point to an internal address).
  const response = await fetcher(url, { signal: globalThis.AbortSignal.timeout(3_000), redirect: 'error' });
  if (!response.ok) return null;
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_BYTES) return null;
  const text = await response.text();
  if (text.length > MAX_BYTES) return null;
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  // Only the fields used for identity are kept.
  const pick = (key: string) => (typeof record[key] === 'string' ? (record[key] as string).slice(0, 300) : null);
  // The logo URL passes the same allowlist (IPFS / Arweave gateways, https) as the metadata itself.
  return { twitter: pick('twitter'), telegram: pick('telegram'), website: pick('website'), name: pick('name'), symbol: pick('symbol'), image: safeMetadataUrl(pick('image')) };
}
