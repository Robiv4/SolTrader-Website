/**
 * DEX Screener official public API (https://docs.dexscreener.com/api/reference), no key:
 *   GET /tokens/v1/solana/{addresses}     up to 30 comma-separated token addresses -> pairs (info.websites / socials,
 *                                          boosts.active, liquidity.usd, pairCreatedAt, baseToken.address)
 *   GET /orders/v1/solana/{tokenAddress}  paid orders (type / status / paymentTimestamp) and boost payments
 * Response shapes verified against the live API. Identity: a pair counts only when baseToken.address equals the mint
 * exactly (a pair where the token is only the quote side is UNRELIABLE_IDENTITY). Unknown / unlisted = null data.
 */
import type { DexProfileObservation } from '@soltrader/strategy-engine';

import type { HttpBudget } from './http-budget.js';

export const DEXSCREENER_BASE_URL = 'https://api.dexscreener.com';
export const DEXSCREENER_BATCH_SIZE = 30;

interface DexPair {
  dexId?: string;
  pairAddress?: string;
  baseToken?: { address?: string };
  quoteToken?: { address?: string };
  liquidity?: { usd?: number };
  pairCreatedAt?: number;
  info?: { imageUrl?: string; websites?: Array<{ url?: string }>; socials?: Array<{ type?: string; url?: string }> };
  boosts?: { active?: number };
}

interface DexOrders {
  orders?: Array<{ type?: string; status?: string; paymentTimestamp?: number }>;
  boosts?: Array<{ amount?: number; paymentTimestamp?: number }>;
}

const finite = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/** Pure: pairs of one token -> observation (best pair by liquidity among pairs whose BASE token is the mint). */
export function parseDexPairs(mint: string, pairs: unknown, receivedAt: number, orders: DexOrders | null = null): DexProfileObservation {
  const list = (Array.isArray(pairs) ? pairs : []) as DexPair[];
  const relevant = list.filter((pair) => pair.baseToken?.address === mint || pair.quoteToken?.address === mint);
  const own = relevant.filter((pair) => pair.baseToken?.address === mint).sort((a, b) => (finite(b.liquidity?.usd) ?? 0) - (finite(a.liquidity?.usd) ?? 0));
  const best = own[0] ?? null;
  const socials = best?.info?.socials ?? [];
  const type = (value: string | undefined) => (value ?? '').toLowerCase();
  return {
    receivedAt,
    pairFound: relevant.length > 0,
    identityConfirmed: best !== null,
    profilePresent: Boolean(best?.info && (best.info.imageUrl || best.info.websites?.length || best.info.socials?.length)),
    websites: best?.info?.websites?.filter((site) => typeof site.url === 'string' && site.url).length ?? 0,
    socials: {
      twitter: socials.some((social) => ['twitter', 'x'].includes(type(social.type))),
      telegram: socials.some((social) => type(social.type) === 'telegram'),
      discord: socials.some((social) => type(social.type) === 'discord'),
      other: socials.filter((social) => !['twitter', 'x', 'telegram', 'discord'].includes(type(social.type))).length,
    },
    activeBoosts: best ? finite(best.boosts?.active) ?? 0 : null,
    paidOrders: (orders?.orders ?? []).map((order) => ({ type: String(order.type ?? 'unknown'), status: String(order.status ?? 'unknown'), paymentTimestamp: finite(order.paymentTimestamp) })),
    boostPayments: (orders?.boosts ?? []).map((boost) => ({ amount: finite(boost.amount), paymentTimestamp: finite(boost.paymentTimestamp) })),
    pairCreatedAt: finite(best?.pairCreatedAt),
    liquidityUsd: finite(best?.liquidity?.usd),
    dexId: best?.dexId ?? null,
  };
}

export class DexScreenerClient {
  constructor(private readonly http: HttpBudget, private readonly baseUrl = DEXSCREENER_BASE_URL) {}

  /** Pairs for up to 30 mints in ONE request; null = request not made / failed (callers keep their old data). */
  async tokens(mints: string[]): Promise<Map<string, unknown[]> | null> {
    const batch = [...new Set(mints)].slice(0, DEXSCREENER_BATCH_SIZE);
    if (!batch.length) return new Map();
    const result = await this.http.getJson(`${this.baseUrl}/tokens/v1/solana/${batch.map(encodeURIComponent).join(',')}`);
    if (!result) return null;
    const pairs = (Array.isArray(result.body) ? result.body : []) as DexPair[];
    const byMint = new Map<string, unknown[]>(batch.map((mint) => [mint, []]));
    for (const pair of pairs) {
      for (const mint of [pair.baseToken?.address, pair.quoteToken?.address]) if (mint && byMint.has(mint)) byMint.get(mint)!.push(pair);
    }
    return byMint;
  }

  async orders(mint: string): Promise<DexOrders | null> {
    const result = await this.http.getJson(`${this.baseUrl}/orders/v1/solana/${encodeURIComponent(mint)}`);
    if (!result) return null;
    // Older response form: a bare array of orders.
    if (Array.isArray(result.body)) return { orders: result.body as DexOrders['orders'], boosts: [] };
    return (result.body ?? { orders: [], boosts: [] }) as DexOrders;
  }
}
