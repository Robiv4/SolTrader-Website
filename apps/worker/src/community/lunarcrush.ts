/**
 * LunarCrush (optional, paid API v4, https://lunarcrush.com/developers):
 *   GET https://lunarcrush.com/api4/public/coins/{coin}/v1   Authorization: Bearer <LUNARCRUSH_API_KEY>
 * The endpoint path is verified (401 without a key, 404 for unknown paths); the response fields could not be verified
 * without a subscription, so they are read defensively (any missing field = null) and nothing is ever estimated.
 *
 * Identity: new Solana launches are rarely covered. A response is only used when it explicitly contains the token's
 * mint address (contract address) - a symbol or name match is never enough. Without the key / with LUNARCRUSH_ENABLED
 * false the adapter is NOT_CONFIGURED / DISABLED and makes zero requests.
 */
import type { LunarObservation } from '@soltrader/strategy-engine';

import type { HttpBudget } from './http-budget.js';

export const LUNARCRUSH_BASE_URL = 'https://lunarcrush.com/api4/public';

const finite = (value: unknown) => {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof number === 'number' && Number.isFinite(number) ? number : null;
};

/** True when any string value in the object equals the mint (case-sensitive base58). */
function mentionsMint(value: unknown, mint: string, depth = 0): boolean {
  if (depth > 5 || value === null || value === undefined) return false;
  if (typeof value === 'string') return value === mint;
  if (Array.isArray(value)) return value.some((item) => mentionsMint(item, mint, depth + 1));
  if (typeof value === 'object') return Object.values(value as Record<string, unknown>).some((item) => mentionsMint(item, mint, depth + 1));
  return false;
}

/** Pure: response body -> observation (first present field name wins; unknown names = null). */
export function parseLunarCoin(mint: string, body: unknown, receivedAt: number): LunarObservation | null {
  const data = (body && typeof body === 'object' && 'data' in (body as Record<string, unknown>) ? (body as { data: unknown }).data : body) as Record<string, unknown> | null;
  if (!data || typeof data !== 'object') return null;
  const pick = (...names: string[]) => {
    for (const name of names) {
      const value = finite(data[name]);
      if (value !== null) return value;
    }
    return null;
  };
  return {
    receivedAt,
    identityConfirmed: mentionsMint(data, mint),
    galaxyScore: pick('galaxy_score'),
    altRank: pick('alt_rank'),
    sentiment: pick('sentiment'),
    socialVolume: pick('social_volume_24h', 'social_volume'),
    interactions: pick('interactions_24h', 'interactions'),
    contributors: pick('social_contributors', 'contributors_active', 'contributors'),
  };
}

export class LunarCrushClient {
  constructor(private readonly http: HttpBudget, private readonly apiKey: string | null, private readonly baseUrl = LUNARCRUSH_BASE_URL) {}

  async coin(mint: string, now: number): Promise<LunarObservation | null> {
    if (!this.apiKey) return null;
    const result = await this.http.getJson(`${this.baseUrl}/coins/${encodeURIComponent(mint)}/v1`, { Authorization: `Bearer ${this.apiKey}` });
    if (!result || result.body === null) return null;
    return parseLunarCoin(mint, result.body, now);
  }
}
