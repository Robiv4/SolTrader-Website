/**
 * Images: token logos (proxied) and user profile pictures.
 *
 * Token logo proxy (GET /api/token-images/:address): the browser never contacts third-party hosts. Sources in order:
 * Token.imageUrl (DexScreener info.imageUrl / metadata image) -> LaunchCandidate.socialLinks.image -> DexScreener's CDN
 * by mint. SSRF-safe: https only, host allowlist (also for redirects), 4 s timeout, size cap, max 4 parallel fetches,
 * content sniffed by magic bytes (PNG / JPEG / GIF / WebP only - never SVG / HTML). Results are cached in memory.
 *
 * Profile pictures: PNG / JPEG / WebP data URL from the client (already resized to 128x128), <= 200 KB, verified by
 * magic bytes, stored in User.avatarImage, served to the owner and administrators only.
 */
import type { PrismaClient } from '@prisma/client';
import type { Response } from 'express';

const IMAGE_HOSTS = [
  /^dd\.dexscreener\.com$/, /^cdn\.dexscreener\.com$/,
  /^ipfs\.io$/, /^cf-ipfs\.com$/, /^gateway\.pinata\.cloud$/, /\.mypinata\.cloud$/, /^arweave\.net$/, /\.arweave\.net$/, /^dweb\.link$/, /\.ipfs\.dweb\.link$/,
  /^nftstorage\.link$/, /\.ipfs\.nftstorage\.link$/, /^ipfs\.pump\.fun$/, /^metadata\.pump\.fun$/, /^pump\.mypinata\.cloud$/,
  // Gateway the worker rewrites IPFS logo URLs to (ipfs.io answers HTTP 429 to every path request).
  /^ipfs\.filebase\.io$/,
];
const MAX_TOKEN_IMAGE_BYTES = 1_500_000;
export const MAX_AVATAR_BYTES = 200_000;
const HIT_TTL_MS = 6 * 3_600_000;
const MISS_TTL_MS = 30 * 60_000;
const MAX_CACHE_ENTRIES = 400;
const MAX_PARALLEL_FETCHES = 4;

export type ImageMime = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

/** Content sniffing: only raster formats that browsers render without script execution. */
export function sniffImage(bytes: Uint8Array): ImageMime | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return 'image/gif';
  if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP') return 'image/webp';
  return null;
}

export function allowedImageUrl(value: string | null | undefined): URL | null {
  if (!value) return null;
  const normalized = value.startsWith('ipfs://') ? `https://ipfs.io/ipfs/${value.slice(7).replace(/^ipfs\//, '')}` : value;
  try {
    const url = new URL(normalized);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    return IMAGE_HOSTS.some((pattern) => pattern.test(url.hostname.toLowerCase())) ? url : null;
  } catch {
    return null;
  }
}

/** Sends image bytes with headers that keep the browser from treating them as anything else. */
export function sendImage(res: Response, bytes: Uint8Array, mime: string, maxAgeSeconds: number) {
  res.setHeader('Content-Type', mime);
  res.setHeader('Cache-Control', `private, max-age=${maxAgeSeconds}`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  // The web app (another origin in development) embeds these images.
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  return res.end(Buffer.from(bytes));
}

type Fetcher = (url: string, init: { signal: globalThis.AbortSignal; redirect: 'manual'; headers: Record<string, string> }) => Promise<globalThis.Response>;

export function createTokenImageProxy(deps: { prisma: Pick<PrismaClient, 'token' | 'launchCandidate'>; fetcher?: Fetcher; now?: () => number }) {
  const cache = new Map<string, { bytes: Uint8Array | null; mime: ImageMime | null; at: number }>();
  const inFlight = new Map<string, Promise<{ bytes: Uint8Array; mime: ImageMime } | null>>();
  let active = 0;
  const waiters: Array<() => void> = [];
  const now = () => deps.now?.() ?? Date.now();
  const fetcher: Fetcher = deps.fetcher ?? ((url, init) => globalThis.fetch(url, init));

  async function slot<T>(work: () => Promise<T>) {
    if (active >= MAX_PARALLEL_FETCHES) await new Promise<void>((resolve) => waiters.push(resolve));
    active += 1;
    try {
      return await work();
    } finally {
      active -= 1;
      waiters.shift()?.();
    }
  }

  async function download(start: URL): Promise<{ bytes: Uint8Array; mime: ImageMime } | null> {
    let url = start;
    // Follow at most 2 redirects, each target must pass the allowlist again.
    for (let hop = 0; hop < 3; hop += 1) {
      const response = await fetcher(url.toString(), { signal: globalThis.AbortSignal.timeout(4_000), redirect: 'manual', headers: { Accept: 'image/png,image/jpeg,image/webp,image/gif' } });
      if (response.status >= 300 && response.status < 400) {
        const next = allowedImageUrl(response.headers.get('location') ? new URL(response.headers.get('location')!, url).toString() : null);
        if (!next) return null;
        url = next;
        continue;
      }
      if (!response.ok) return null;
      const length = Number(response.headers.get('content-length'));
      if (Number.isFinite(length) && length > MAX_TOKEN_IMAGE_BYTES) return null;
      const reader = response.body?.getReader();
      if (!reader) return null;
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > MAX_TOKEN_IMAGE_BYTES) {
          await reader.cancel().catch(() => undefined);
          return null;
        }
        chunks.push(value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      const mime = sniffImage(bytes);
      return mime ? { bytes, mime } : null;
    }
    return null;
  }

  async function resolve(address: string) {
    const [token, candidate] = await Promise.all([
      deps.prisma.token.findUnique({ where: { address }, select: { imageUrl: true } }).catch(() => null),
      deps.prisma.launchCandidate.findUnique({ where: { mint: address }, select: { socialLinks: true } }).catch(() => null),
    ]);
    const links = candidate?.socialLinks && typeof candidate.socialLinks === 'object' ? candidate.socialLinks as Record<string, unknown> : {};
    const sources = [token?.imageUrl ?? null, typeof links.image === 'string' ? links.image : null, `https://dd.dexscreener.com/ds-data/tokens/solana/${address}.png`];
    for (const source of sources) {
      const url = allowedImageUrl(source);
      if (!url) continue;
      const image = await slot(() => download(url)).catch(() => null);
      if (image) return image;
    }
    return null;
  }

  return async function get(address: string): Promise<{ bytes: Uint8Array; mime: ImageMime } | null> {
    const cached = cache.get(address);
    if (cached && now() - cached.at < (cached.bytes ? HIT_TTL_MS : MISS_TTL_MS)) return cached.bytes && cached.mime ? { bytes: cached.bytes, mime: cached.mime } : null;
    let pending = inFlight.get(address);
    if (!pending) {
      pending = resolve(address).finally(() => inFlight.delete(address));
      inFlight.set(address, pending);
    }
    const result = await pending;
    cache.set(address, { bytes: result?.bytes ?? null, mime: result?.mime ?? null, at: now() });
    if (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value as string);
    return result;
  };
}

/** Validates a client-supplied profile picture data URL; returns the decoded bytes or an error message. */
export function parseAvatarDataUrl(value: unknown): { bytes: Buffer; mime: ImageMime } | { error: string } {
  if (typeof value !== 'string') return { error: 'Hiányzó kép' };
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(value);
  if (!match) return { error: 'Csak PNG, JPEG vagy WebP kép tölthető fel' };
  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length || bytes.length > MAX_AVATAR_BYTES) return { error: 'A kép legfeljebb 200 KB lehet' };
  const mime = sniffImage(bytes);
  if (!mime || mime === 'image/gif' || mime !== match[1]) return { error: 'A fájl nem érvényes PNG / JPEG / WebP kép' };
  return { bytes, mime };
}
