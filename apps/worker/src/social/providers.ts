/**
 * Social data providers (vendor-independent). Only officially / legitimately accessible data:
 *  - X: official API v2 recent search with a server-side bearer token (X_API_BEARER_TOKEN). Without a token the
 *    provider is NOT_CONFIGURED and contributes nothing (no scraping).
 *    X is OPTIONAL and disabled by default (X_SOCIAL_ENABLED=false): the provider then makes zero requests.
 *  - Telegram (primary): MTProto user session (see ./telegram.ts) for public channels / groups, plus the optional bot
 *    inbox (groups the project's bot was ADDED to). Private chats are never joined or read without access.
 * Unavailable metrics are returned as null, never estimated.
 */
import type { SocialIdentity, SocialSource } from '@soltrader/strategy-engine';

export interface RawSocialPost {
  id: string;
  source: SocialSource;
  authorId: string;
  text: string;
  createdAt: number;
  receivedAt: number;
  likes?: number | null;
  reposts?: number | null;
  replies?: number | null;
  views?: number | null;
  authorFollowers?: number | null;
  authorCreatedAt?: number | null;
  /** Telegram: public username of the chat the message came from. */
  chatUsername?: string | null;
  /** Telegram: the message comes from the token's registered OFFICIAL source. */
  officialSource?: boolean;
  forwarded?: boolean;
  forwards?: number | null;
  replyToId?: string | null;
  /**
   * Only count the message when it contains the token's exact mint address (sources found by mint search, e.g. call
   * groups that discuss many tokens: a ticker / name match there is not reliable enough).
   */
  mintOnly?: boolean;
}

/** How a Telegram source of a token was found (provenance, strongest first). */
export type TelegramDiscoveryVia = 'PUMP_FUN_METADATA' | 'DEXSCREENER' | 'TELEGRAM_SEARCH';

/** Telegram links of a token from verified sources (metadata of the mint itself / DEX Screener profile of the mint). */
export interface TelegramLinkCandidate {
  username: string;
  via: Exclude<TelegramDiscoveryVia, 'TELEGRAM_SEARCH'>;
  receivedAt: number;
}

export interface FetchContext {
  telegramLinks?: TelegramLinkCandidate[];
}

export interface ProviderHealth {
  source: SocialSource;
  state: ProviderState;
  /** Switched on by configuration (X_SOCIAL_ENABLED / TELEGRAM_SOCIAL_ENABLED). */
  enabled: boolean;
  configured: boolean;
  lastSuccessAt: number | null;
  lastError: string | null;
  requests: number;
  rateLimitEvents: number;
  cacheHits: number;
  errors: number;
  /** Request latency samples (ms) of the last requests. */
  latencyMs: number[];
  /** Cost is only reported when the provider exposes it (X / Telegram do not). */
  cost: null;
  /** Provider specific, credential-free diagnostics (connection, sources, counters). */
  details?: Record<string, unknown>;
}

export type ProviderState = 'ACTIVE' | 'CONNECTED' | 'CONNECTING' | 'NOT_CONFIGURED' | 'DISABLED' | 'RATE_LIMITED' | 'DEGRADED' | 'DISCONNECTED' | 'UNAVAILABLE';

/** States in which already collected data of a provider may be used (freshness still decides how much). */
export const USABLE_PROVIDER_STATES: ReadonlySet<ProviderState> = new Set(['ACTIVE', 'CONNECTED', 'RATE_LIMITED', 'DEGRADED']);

export interface FetchResult {
  posts: RawSocialPost[];
  newestId: string | null;
  complete: boolean;
  /** Telegram: member count samples of the token's sources (null when not exposed). */
  memberCount?: number | null;
  /** false = the source exposes no community messages (e.g. a broadcast channel): member data only, no message coverage. */
  messageCoverage?: boolean;
}

export interface SocialDataProvider {
  readonly source: SocialSource;
  health(): ProviderHealth;
  /** Pull providers: recent posts for one token (null = request not made: budget, backoff, not configured). */
  fetchRecent?(identity: SocialIdentity, sinceId: string | null, context?: FetchContext): Promise<FetchResult | null>;
  /** Push providers: posts received since the last drain. */
  drain?(): Promise<RawSocialPost[]>;
  /** Periodic housekeeping (connect / reconnect); never throws. */
  maintain?(): Promise<void>;
  /** The token is no longer tracked: release its subscriptions / cursors. */
  release?(mint: string): void;
  /** Does this provider currently have a readable source for the token? (null = not applicable) */
  hasSource?(mint: string): boolean | null;
}

export function newHealth(source: SocialSource, configured: boolean, enabled = true): ProviderHealth {
  return { source, state: !enabled ? 'DISABLED' : configured ? 'ACTIVE' : 'NOT_CONFIGURED', enabled, configured: enabled && configured, lastSuccessAt: null, lastError: null, requests: 0, rateLimitEvents: 0, cacheHits: 0, errors: 0, latencyMs: [], cost: null };
}

type Fetch = (input: string, init?: { headers?: Record<string, string>; signal?: globalThis.AbortSignal }) => Promise<{ ok: boolean; status: number; headers: { get(name: string): string | null }; json(): Promise<unknown> }>;

/** X API v2 recent search (official). Request budget per 15 minutes + backoff on 429 using the reset header. */
export class XSocialProvider implements SocialDataProvider {
  readonly source = 'X' as const;
  private readonly status: ProviderHealth;
  private window: { start: number; used: number } = { start: 0, used: 0 };
  private blockedUntil = 0;

  constructor(private readonly options: { enabled?: boolean; bearerToken: string | null; maxRequestsPer15Min: number; fetch?: Fetch; now?: () => number }) {
    this.status = newHealth('X', Boolean(options.bearerToken), options.enabled ?? true);
  }

  private now() {
    return this.options.now?.() ?? Date.now();
  }

  health() {
    if (this.status.configured && this.status.state === 'RATE_LIMITED' && this.now() >= this.blockedUntil) this.status.state = 'ACTIVE';
    return { ...this.status, latencyMs: [...this.status.latencyMs] };
  }

  /** Budget left in the current 15-minute window. */
  budgetLeft() {
    const now = this.now();
    if (now - this.window.start >= 900_000) this.window = { start: now, used: 0 };
    return Math.max(0, this.options.maxRequestsPer15Min - this.window.used);
  }

  /** Query: the mint address and the token's official X account / links (a ticker alone is never searched). */
  static query(identity: SocialIdentity) {
    const parts = [`"${identity.mint}"`];
    if (identity.officialX) parts.push(`@${identity.officialX}`, `url:"x.com/${identity.officialX}"`);
    if (identity.website) parts.push(`url:"${identity.website}"`);
    return `(${parts.join(' OR ')}) -is:retweet`;
  }

  async fetchRecent(identity: SocialIdentity, sinceId: string | null) {
    // Disabled (default) or no token: zero requests.
    if (!this.status.enabled || !this.options.bearerToken) return null;
    const now = this.now();
    if (now < this.blockedUntil || this.budgetLeft() <= 0) return null;
    this.window.used += 1;
    this.status.requests += 1;
    const params = new globalThis.URLSearchParams({
      query: XSocialProvider.query(identity), max_results: '100', 'tweet.fields': 'created_at,public_metrics,author_id',
      expansions: 'author_id', 'user.fields': 'created_at,public_metrics,verified',
    });
    if (sinceId) params.set('since_id', sinceId);
    const started = now;
    try {
      const response = await (this.options.fetch ?? (globalThis.fetch as unknown as Fetch))(`https://api.x.com/2/tweets/search/recent?${params}`, { headers: { Authorization: `Bearer ${this.options.bearerToken}` }, signal: globalThis.AbortSignal.timeout(8_000) });
      this.status.latencyMs = [...this.status.latencyMs.slice(-199), this.now() - started];
      if (response.status === 429) {
        const reset = Number(response.headers.get('x-rate-limit-reset'));
        this.blockedUntil = Number.isFinite(reset) && reset > 0 ? reset * 1000 : now + 60_000;
        this.status.rateLimitEvents += 1;
        this.status.state = 'RATE_LIMITED';
        return null;
      }
      if (!response.ok) throw new Error(`X API HTTP ${response.status}`);
      const body = await response.json() as { data?: Array<{ id: string; text: string; author_id: string; created_at: string; public_metrics?: { like_count?: number; retweet_count?: number; reply_count?: number; impression_count?: number } }>; includes?: { users?: Array<{ id: string; created_at?: string; public_metrics?: { followers_count?: number } }> }; meta?: { newest_id?: string; result_count?: number; next_token?: string } };
      const users = new Map((body.includes?.users ?? []).map((user) => [user.id, user]));
      const receivedAt = this.now();
      const posts: RawSocialPost[] = (body.data ?? []).map((tweet) => ({
        id: `x:${tweet.id}`, source: 'X', authorId: `x:${tweet.author_id}`, text: tweet.text, createdAt: Date.parse(tweet.created_at), receivedAt,
        likes: tweet.public_metrics?.like_count ?? null, reposts: tweet.public_metrics?.retweet_count ?? null, replies: tweet.public_metrics?.reply_count ?? null,
        views: tweet.public_metrics?.impression_count ?? null,
        authorFollowers: users.get(tweet.author_id)?.public_metrics?.followers_count ?? null,
        authorCreatedAt: users.get(tweet.author_id)?.created_at ? Date.parse(users.get(tweet.author_id)!.created_at!) : null,
      }));
      this.status.state = 'ACTIVE';
      this.status.lastSuccessAt = receivedAt;
      this.status.lastError = null;
      // A full page means older matching posts may exist: coverage then only starts at the oldest returned post.
      return { posts, newestId: body.meta?.newest_id ?? sinceId, complete: !body.meta?.next_token };
    } catch (error) {
      this.status.errors += 1;
      this.status.state = 'DEGRADED';
      this.status.lastError = error instanceof Error ? error.message : String(error);
      return null;
    }
  }
}

/** Deterministic in-memory provider for tests / simulations. */
export class MockSocialProvider implements SocialDataProvider {
  readonly status: ProviderHealth;
  posts: RawSocialPost[] = [];
  failing = false;

  constructor(readonly source: SocialSource) {
    this.status = newHealth(source, true);
  }

  health() {
    return { ...this.status, state: this.failing ? 'UNAVAILABLE' as const : this.status.state };
  }

  async fetchRecent() {
    if (this.failing) return null;
    this.status.lastSuccessAt = Date.now();
    return { posts: this.posts.splice(0), newestId: null, complete: true };
  }
}
