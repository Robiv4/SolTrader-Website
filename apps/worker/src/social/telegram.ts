/**
 * Telegram social provider (primary social source). Deterministic, read-only, MONITOR_ONLY.
 *
 * Access model (authorized data only):
 *  - MTProto user session (GramJS) created by the operator with `pnpm --filter @soltrader/worker telegram:login`.
 *    Reads PUBLIC channels / groups (by public username) and chats the account is already a member of.
 *    Private invite links are never resolved or joined; inaccessible chats are recorded as NO_ACCESS.
 *  - Optional bot inbox: groups the project's bot was ADDED to (forwarded by the API through Redis).
 *
 * Secrets (TELEGRAM_API_HASH / TELEGRAM_SESSION / TELEGRAM_BOT_TOKEN) never leave this process: they are not logged,
 * not part of health / diagnostics and never sent to the frontend.
 *
 * Never on the trading / exit path: the social service polls this provider in its own background tick.
 */
import { createHash } from 'node:crypto';

import type { MatchBasis, SocialIdentity } from '@soltrader/strategy-engine';
import { RollingPercentiles } from '@soltrader/trading-engine';

import { newHealth, type FetchContext, type FetchResult, type ProviderHealth, type RawSocialPost, type SocialDataProvider, type TelegramDiscoveryVia, type TelegramLinkCandidate } from './providers.js';

export type TelegramChatType = 'CHANNEL' | 'GROUP' | 'SUPERGROUP' | 'UNKNOWN';

export interface TelegramChat {
  id: string;
  username: string | null;
  type: TelegramChatType;
  title: string | null;
}

export interface TelegramMessage {
  id: number;
  chatId: string;
  senderId: string | null;
  text: string;
  /** ms epoch */
  date: number;
  replyToId: number | null;
  forwarded: boolean;
  forwards: number | null;
  views: number | null;
}

/** FLOOD_WAIT_x from Telegram: no request may be made before `seconds` passed. */
export class TelegramFloodWait extends Error {
  constructor(readonly seconds: number) {
    super(`FLOOD_WAIT_${seconds}`);
  }
}

export class TelegramAccessError extends Error {
  constructor(readonly code: 'NO_ACCESS' | 'NOT_FOUND' | 'NOT_AUTHORIZED', message?: string) {
    super(message ?? code);
  }
}

/** Minimal, library-independent MTProto surface (GramJS implementation below; tests use a mock). */
export interface TelegramGateway {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  /** Public username -> chat. Throws TelegramAccessError(NOT_FOUND | NO_ACCESS). */
  resolve(username: string): Promise<TelegramChat>;
  /** Messages with id > minId, newest first or any order (the provider sorts). */
  history(username: string, minId: number, limit: number): Promise<TelegramMessage[]>;
  /** Participant / subscriber count if Telegram exposes it, else null. */
  memberCount(username: string): Promise<number | null>;
  /** Searches chats the account can legitimately see for a query (here: the mint address). */
  searchGlobal(query: string, limit: number): Promise<Array<{ chat: TelegramChat; message: TelegramMessage }>>;
}

export interface TelegramInbox {
  /** Pops up to `count` raw JSON messages pushed by the API's Telegram bot. */
  popMany(count: number): Promise<string[]>;
}

export type TelegramOfficialStatus = 'OFFICIAL' | 'PROBABLE_OFFICIAL' | 'COMMUNITY' | 'UNKNOWN';
export type TelegramAccessStatus = 'ACCESSIBLE' | 'NO_ACCESS' | 'NOT_FOUND' | 'RATE_LIMITED' | 'UNKNOWN';

/** One row of the source registry (persisted as TelegramSource by the social service). */
export interface TelegramSourceRecord {
  mint: string;
  username: string;
  url: string;
  chat: TelegramChat | null;
  officialStatus: TelegramOfficialStatus;
  /**
   * Persisted provenance: OFFICIAL_SOCIAL_LINK = pump.fun metadata of the mint, DEXSCREENER_LINK = DEX Screener profile
   * whose pair base token is the mint, MINT_ADDRESS = public message containing the exact mint (Telegram search).
   */
  matchBasis: MatchBasis | 'VERIFIED_LINK' | 'DEXSCREENER_LINK';
  /** How the source was found (in memory / health; matchBasis carries it in the database). */
  via: TelegramDiscoveryVia;
  matchConfidence: number;
  accessStatus: TelegramAccessStatus;
  discoveredAt: number;
  lastVerifiedAt: number | null;
  active: boolean;
}

export interface TelegramProviderOptions {
  enabled: boolean;
  /** null = MTProto not configured (missing TELEGRAM_API_ID / TELEGRAM_API_HASH / TELEGRAM_SESSION). */
  gateway: TelegramGateway | null;
  inbox?: TelegramInbox | null;
  /** Max distinct chats polled at the same time (subscription cap). */
  maxMonitoredSources?: number;
  /** Mint-address searches per minute for community sources (0 = off). */
  globalSearchPerMinute?: number;
  historyLimit?: number;
  now?: () => number;
  /** Registry change (new source, verification, access change). Must not throw. */
  onSource?: (record: TelegramSourceRecord) => void;
  logger?: { warn(payload: unknown, message?: string): void; error(payload: unknown, message?: string): void };
}

interface ChatBuffer {
  chat: TelegramChat;
  messages: TelegramMessage[];
  cursor: number;
  lastFetchAt: number;
  /** The first fetch returned the chat's full history (fewer messages than the limit). */
  complete: boolean | null;
  members: number | null;
  membersAt: number;
  /** Mints using this chat (subscription reference count). */
  users: Set<string>;
}

const RESOLVE_TTL_MS = 6 * 3_600_000;
const RESOLVE_FAILURE_TTL_MS = 30 * 60_000;
const CHAT_REFETCH_MS = 5_000;
const MEMBER_REFRESH_MS = 60_000;
const BUFFER_RETENTION_MS = 31 * 60_000;
const SEARCH_REPEAT_MS = 10 * 60_000;
const MAX_SOURCES_PER_TOKEN = 3;
const MAX_COMMUNITY_SOURCES_PER_TOKEN = 2;
/** A message older than this at fetch time is history (never live community momentum). */
export const TELEGRAM_FRESH_MESSAGE_MS = BUFFER_RETENTION_MS;

/** Stable, non-reversible author id (no raw Telegram user id is stored). */
export function hashTelegramSender(senderId: string | null, chatId: string) {
  return `tg:${createHash('sha256').update(`soltrader-tg:${senderId ?? `chat:${chatId}`}`).digest('hex').slice(0, 20)}`;
}

/** Strips anything that could be a credential from an error message before it is stored in health / logs. */
export function sanitizeTelegramError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[A-Za-z0-9+/=_-]{32,}/g, '[redacted]').slice(0, 200);
}

export class TelegramSocialProvider implements SocialDataProvider {
  readonly source = 'TELEGRAM' as const;
  private readonly status: ProviderHealth;
  private readonly registry = new Map<string, Map<string, TelegramSourceRecord>>();
  private readonly resolutions = new Map<string, { chat: TelegramChat | null; access: TelegramAccessStatus; at: number }>();
  private readonly buffers = new Map<string, ChatBuffer>();
  /** Per (mint, chat) consumer cursor: each token reads every buffered message once. */
  private readonly consumers = new Map<string, number>();
  private readonly searchedAt = new Map<string, number>();
  private searchWindow = { start: 0, used: 0 };
  private connectedOnce = false;
  private connecting = false;
  private nextConnectAt = 0;
  private connectBackoffMs = 5_000;
  private rateLimitedUntil = 0;
  private readonly receivedTimes: number[] = [];
  private readonly processing = new RollingPercentiles();
  readonly metrics = {
    connectedSince: null as number | null, lastMessageAt: null as number | null, lastSyncAt: null as number | null,
    messagesReceived: 0, announcementsSkipped: 0, reconnects: 0, lastFloodWaitSeconds: null as number | null,
    searches: 0, sourcesSkippedCap: 0, sourcesNoAccess: 0, botMessagesReceived: 0,
    /** Mint searches that returned at least one usable chat / hits rejected by reason. */
    searchesWithHits: 0, searchHits: 0, searchHitsRejected: { NO_EXACT_MINT: 0, NO_PUBLIC_USERNAME: 0, BROADCAST_CHANNEL: 0, PER_TOKEN_LIMIT: 0 } as Record<string, number>,
    /** Sources registered per discovery route, and how many of them were readable (ACCESSIBLE). */
    sourcesByVia: { PUMP_FUN_METADATA: 0, DEXSCREENER: 0, TELEGRAM_SEARCH: 0 } as Record<TelegramDiscoveryVia, number>,
    accessibleByVia: { PUMP_FUN_METADATA: 0, DEXSCREENER: 0, TELEGRAM_SEARCH: 0 } as Record<TelegramDiscoveryVia, number>,
    /** Messages fetched that were recent (<= 31 min old) vs. older history (kept out of every window). */
    freshMessages: 0, historicalMessagesSkipped: 0, lastFreshMessageAt: null as number | null,
  };

  constructor(private readonly options: TelegramProviderOptions) {
    const configured = Boolean(options.gateway || options.inbox);
    this.status = newHealth('TELEGRAM', configured, options.enabled);
    if (options.enabled && options.gateway) this.status.state = 'DISCONNECTED';
  }

  private now() {
    return this.options.now?.() ?? Date.now();
  }

  private get mtprotoUsable() {
    return Boolean(this.options.enabled && this.options.gateway && this.options.gateway.isConnected() && this.now() >= this.rateLimitedUntil);
  }

  health(): ProviderHealth {
    const now = this.now();
    if (this.status.state === 'RATE_LIMITED' && now >= this.rateLimitedUntil) this.status.state = this.options.gateway?.isConnected() ? 'CONNECTED' : 'DISCONNECTED';
    while (this.receivedTimes.length && now - this.receivedTimes[0] > 60_000) this.receivedTimes.shift();
    const accessible = [...this.buffers.values()].filter((buffer) => buffer.users.size > 0);
    const matchedTokens = [...this.registry.values()].filter((sources) => [...sources.values()].some((record) => record.active && record.accessStatus === 'ACCESSIBLE')).length;
    return {
      ...this.status,
      latencyMs: [...this.status.latencyMs],
      details: {
        mtprotoConfigured: Boolean(this.options.gateway),
        botInboxConfigured: Boolean(this.options.inbox),
        connectedSince: this.metrics.connectedSince ? new Date(this.metrics.connectedSince).toISOString() : null,
        lastMessageAt: this.metrics.lastMessageAt ? new Date(this.metrics.lastMessageAt).toISOString() : null,
        lastSyncAt: this.metrics.lastSyncAt ? new Date(this.metrics.lastSyncAt).toISOString() : null,
        rateLimitedUntil: this.rateLimitedUntil > now ? new Date(this.rateLimitedUntil).toISOString() : null,
        lastFloodWaitSeconds: this.metrics.lastFloodWaitSeconds,
        reconnects: this.metrics.reconnects,
        messagesReceived: this.metrics.messagesReceived,
        botMessagesReceived: this.metrics.botMessagesReceived,
        announcementsSkipped: this.metrics.announcementsSkipped,
        eventsPerMinute: this.receivedTimes.length,
        sourcesMonitored: accessible.length,
        matchedTokens,
        sourcesNoAccess: this.metrics.sourcesNoAccess,
        sourcesSkippedCap: this.metrics.sourcesSkippedCap,
        globalSearches: this.metrics.searches,
        searchesWithHits: this.metrics.searchesWithHits,
        searchHits: this.metrics.searchHits,
        searchHitsRejected: this.metrics.searchHitsRejected,
        sourcesByVia: this.metrics.sourcesByVia,
        accessibleByVia: this.metrics.accessibleByVia,
        verifiedSources: [...this.registry.values()].reduce((count, sources) => count + [...sources.values()].filter((record) => record.active && record.accessStatus === 'ACCESSIBLE').length, 0),
        activeGroups: accessible.filter((buffer) => buffer.chat.type !== 'CHANNEL').length,
        activeChannels: accessible.filter((buffer) => buffer.chat.type === 'CHANNEL').length,
        freshMessages: this.metrics.freshMessages,
        historicalMessagesSkipped: this.metrics.historicalMessagesSkipped,
        lastFreshMessageAt: this.metrics.lastFreshMessageAt ? new Date(this.metrics.lastFreshMessageAt).toISOString() : null,
        processingLatencyMs: this.processing.summary(),
      },
    };
  }

  /** Connect / reconnect with exponential back-off; FLOOD_WAIT pauses everything until it expires. */
  async maintain() {
    const gateway = this.options.gateway;
    if (!this.options.enabled || !gateway || this.connecting) return;
    const now = this.now();
    if (now < this.rateLimitedUntil) {
      this.status.state = 'RATE_LIMITED';
      return;
    }
    if (gateway.isConnected()) {
      if (this.status.state === 'DISCONNECTED' || this.status.state === 'CONNECTING') this.status.state = 'CONNECTED';
      return;
    }
    if (this.status.state === 'CONNECTED' || this.status.state === 'DEGRADED') {
      this.status.state = 'DISCONNECTED';
      this.metrics.connectedSince = null;
    }
    if (now < this.nextConnectAt) return;
    this.connecting = true;
    this.status.state = 'CONNECTING';
    try {
      await gateway.connect();
      if (this.connectedOnce) this.metrics.reconnects += 1;
      this.connectedOnce = true;
      this.connectBackoffMs = 5_000;
      this.metrics.connectedSince = this.now();
      this.status.state = 'CONNECTED';
      this.status.lastError = null;
    } catch (error) {
      this.status.errors += 1;
      this.status.lastError = error instanceof TelegramAccessError && error.code === 'NOT_AUTHORIZED' ? 'SESSION_NOT_AUTHORIZED' : sanitizeTelegramError(error);
      if (error instanceof TelegramFloodWait) this.floodWait(error.seconds);
      else {
        this.status.state = 'DISCONNECTED';
        // An unauthorized session will not fix itself: retry rarely (the operator must run telegram:login).
        this.nextConnectAt = this.now() + (error instanceof TelegramAccessError ? 10 * 60_000 : this.connectBackoffMs);
        this.connectBackoffMs = Math.min(300_000, this.connectBackoffMs * 2);
        this.options.logger?.warn({ provider: 'TELEGRAM', error: this.status.lastError, retryInMs: this.nextConnectAt - this.now() }, 'Telegram connection failed');
      }
    } finally {
      this.connecting = false;
    }
  }

  private floodWait(seconds: number) {
    this.rateLimitedUntil = this.now() + Math.max(1, seconds) * 1_000 + 1_000;
    this.metrics.lastFloodWaitSeconds = seconds;
    this.status.rateLimitEvents += 1;
    this.status.state = 'RATE_LIMITED';
  }

  /** Request wrapper: latency, FLOOD_WAIT, disconnect detection. */
  private async call<T>(fn: () => Promise<T>): Promise<T> {
    const started = this.now();
    this.status.requests += 1;
    try {
      const result = await fn();
      this.status.latencyMs = [...this.status.latencyMs.slice(-199), this.now() - started];
      return result;
    } catch (error) {
      if (error instanceof TelegramFloodWait) this.floodWait(error.seconds);
      else if (!(error instanceof TelegramAccessError)) {
        this.status.errors += 1;
        this.status.lastError = sanitizeTelegramError(error);
        this.status.state = this.options.gateway?.isConnected() ? 'DEGRADED' : 'DISCONNECTED';
      }
      throw error;
    }
  }

  registryFor(mint: string) {
    return [...(this.registry.get(mint)?.values() ?? [])];
  }

  hasSource(mint: string) {
    if (!this.options.enabled) return null;
    return this.registryFor(mint).some((record) => record.active && record.accessStatus === 'ACCESSIBLE' && record.chat?.type !== 'CHANNEL');
  }

  private setRecord(record: TelegramSourceRecord) {
    let sources = this.registry.get(record.mint);
    if (!sources) {
      sources = new Map();
      this.registry.set(record.mint, sources);
    }
    sources.set(record.username, record);
    this.metrics.sourcesByVia[record.via] += 1;
    if (record.active && record.accessStatus === 'ACCESSIBLE') this.metrics.accessibleByVia[record.via] += 1;
    try {
      this.options.onSource?.({ ...record });
    } catch {
      // registry persistence is best effort
    }
  }

  /** Cached public-username resolution (success 6 h, failure 30 min). Never joins anything. */
  private async resolveCached(username: string): Promise<{ chat: TelegramChat | null; access: TelegramAccessStatus }> {
    const cached = this.resolutions.get(username);
    const now = this.now();
    if (cached && now - cached.at < (cached.chat ? RESOLVE_TTL_MS : RESOLVE_FAILURE_TTL_MS)) {
      this.status.cacheHits += 1;
      return cached;
    }
    try {
      const chat = await this.call(() => this.options.gateway!.resolve(username));
      const entry = { chat, access: 'ACCESSIBLE' as const, at: now };
      this.resolutions.set(username, entry);
      return entry;
    } catch (error) {
      if (error instanceof TelegramAccessError) {
        const entry = { chat: null, access: error.code === 'NOT_FOUND' ? 'NOT_FOUND' as const : 'NO_ACCESS' as const, at: now };
        this.resolutions.set(username, entry);
        return entry;
      }
      throw error;
    }
  }

  private monitoredChatCount() {
    return [...this.buffers.values()].filter((buffer) => buffer.users.size > 0).length;
  }

  /** Attaches a token to a chat buffer (one buffer per chat, shared by all tokens: no duplicate listeners). */
  private subscribe(mint: string, record: TelegramSourceRecord) {
    if (!record.chat) return false;
    let buffer = this.buffers.get(record.username);
    if (!buffer) {
      if (this.monitoredChatCount() >= (this.options.maxMonitoredSources ?? 50)) {
        this.metrics.sourcesSkippedCap += 1;
        return false;
      }
      buffer = { chat: record.chat, messages: [], cursor: 0, lastFetchAt: 0, complete: null, members: null, membersAt: 0, users: new Set() };
      this.buffers.set(record.username, buffer);
    }
    buffer.users.add(mint);
    return true;
  }

  /** A verified link (metadata of the mint / DEX Screener profile of the mint): resolved by public username, never joined. */
  private async registerLink(mint: string, username: string, via: Exclude<TelegramDiscoveryVia, 'TELEGRAM_SEARCH'>) {
    const now = this.now();
    const resolved = await this.resolveCached(username);
    if (resolved.access !== 'ACCESSIBLE') this.metrics.sourcesNoAccess += 1;
    const metadata = via === 'PUMP_FUN_METADATA';
    this.setRecord({
      mint, username, url: `https://t.me/${username}`, chat: resolved.chat,
      // Metadata of the mint itself is the strongest identity signal after the mint; a DEX Screener profile is
      // operator-submitted for that exact mint (paid, reviewed) but one step removed: PROBABLE_OFFICIAL.
      officialStatus: metadata ? 'OFFICIAL' : 'PROBABLE_OFFICIAL', matchBasis: metadata ? 'OFFICIAL_SOCIAL_LINK' : 'DEXSCREENER_LINK', matchConfidence: metadata ? 0.9 : 0.8, via,
      accessStatus: resolved.access, discoveredAt: now, lastVerifiedAt: resolved.chat ? now : null, active: resolved.access === 'ACCESSIBLE',
    });
  }

  /**
   * Discovery order: 1. official link from the mint's metadata, 2. verified DEX Screener link of the mint, 3. budgeted
   * public search for the exact mint address (only while no verified source is readable). A name / ticker is never
   * enough to attach a chat. Duplicates (same username via several routes) keep the strongest provenance.
   */
  private async discover(identity: SocialIdentity, links: TelegramLinkCandidate[] = []) {
    const now = this.now();
    const known = () => this.registry.get(identity.mint);
    if (identity.officialTelegram && !known()?.has(identity.officialTelegram)) await this.registerLink(identity.mint, identity.officialTelegram, 'PUMP_FUN_METADATA');
    for (const link of links) {
      if (known()?.has(link.username)) continue;
      await this.registerLink(identity.mint, link.username, link.via);
    }
    const perMinute = this.options.globalSearchPerMinute ?? 2;
    const hasVerified = [...(known()?.values() ?? [])].some((record) => (record.officialStatus === 'OFFICIAL' || record.officialStatus === 'PROBABLE_OFFICIAL') && record.active);
    if (perMinute <= 0 || hasVerified || now - (this.searchedAt.get(identity.mint) ?? 0) < SEARCH_REPEAT_MS) return;
    if (now - this.searchWindow.start >= 60_000) this.searchWindow = { start: now, used: 0 };
    if (this.searchWindow.used >= perMinute) return;
    this.searchWindow.used += 1;
    this.searchedAt.set(identity.mint, now);
    this.metrics.searches += 1;
    const hits = await this.call(() => this.options.gateway!.searchGlobal(identity.mint, 20));
    const chats = new Map<string, TelegramChat>();
    // Only public chats (with a username) whose message contains the exact mint address; broadcast channels only
    // announce (no community conversation) and are not attached as sources.
    for (const hit of hits) {
      if (!hit.message.text.includes(identity.mint)) this.metrics.searchHitsRejected.NO_EXACT_MINT += 1;
      else if (!hit.chat.username) this.metrics.searchHitsRejected.NO_PUBLIC_USERNAME += 1;
      else if (hit.chat.type === 'CHANNEL') this.metrics.searchHitsRejected.BROADCAST_CHANNEL += 1;
      else chats.set(hit.chat.username.toLowerCase(), hit.chat);
    }
    this.metrics.searchHits += chats.size;
    if (chats.size) this.metrics.searchesWithHits += 1;
    let added = 0;
    for (const [username, chat] of chats) {
      if (known()?.has(username)) continue;
      if (added >= MAX_COMMUNITY_SOURCES_PER_TOKEN) {
        this.metrics.searchHitsRejected.PER_TOKEN_LIMIT += 1;
        continue;
      }
      added += 1;
      this.setRecord({
        mint: identity.mint, username, url: `https://t.me/${username}`, chat, officialStatus: 'COMMUNITY', matchBasis: 'MINT_ADDRESS', matchConfidence: 0.6, via: 'TELEGRAM_SEARCH',
        accessStatus: 'ACCESSIBLE', discoveredAt: now, lastVerifiedAt: now, active: true,
      });
    }
  }

  private async refreshBuffer(username: string, buffer: ChatBuffer) {
    const now = this.now();
    if (now - buffer.lastFetchAt < CHAT_REFETCH_MS) {
      this.status.cacheHits += 1;
      return;
    }
    buffer.lastFetchAt = now;
    const limit = this.options.historyLimit ?? 100;
    const started = this.now();
    const messages = await this.call(() => this.options.gateway!.history(username, buffer.cursor, limit));
    const fresh = messages.filter((message) => message.id > buffer.cursor).sort((a, b) => a.id - b.id);
    if (buffer.complete === null) buffer.complete = messages.length < limit;
    if (fresh.length) {
      buffer.cursor = fresh[fresh.length - 1].id;
      buffer.messages.push(...fresh);
      this.metrics.messagesReceived += fresh.length;
      this.metrics.lastMessageAt = Math.max(this.metrics.lastMessageAt ?? 0, fresh[fresh.length - 1].date);
      for (let index = 0; index < fresh.length; index += 1) this.receivedTimes.push(now);
      // The first page of a chat is mostly history (possibly years old): counted apart, dropped below, never momentum.
      const recent = fresh.filter((message) => now - message.date <= TELEGRAM_FRESH_MESSAGE_MS && message.date <= now + 60_000);
      this.metrics.freshMessages += recent.length;
      this.metrics.historicalMessagesSkipped += fresh.length - recent.length;
      if (recent.length) this.metrics.lastFreshMessageAt = Math.max(this.metrics.lastFreshMessageAt ?? 0, ...recent.map((message) => message.date));
    }
    // Raw text retention: only the last 31 minutes (the longest window is 30 min) stay in memory.
    const cutoff = now - BUFFER_RETENTION_MS;
    buffer.messages = buffer.messages.filter((message) => message.date >= cutoff).slice(-2_000);
    this.processing.add(this.now() - started);
    this.metrics.lastSyncAt = this.now();
    this.status.lastSuccessAt = this.now();
    if (this.status.state !== 'RATE_LIMITED') this.status.state = 'CONNECTED';
    if (now - buffer.membersAt >= MEMBER_REFRESH_MS) {
      buffer.membersAt = now;
      buffer.members = await this.call(() => this.options.gateway!.memberCount(username)).catch((error: unknown) => {
        if (error instanceof TelegramFloodWait) throw error;
        return null;
      });
    }
  }

  async fetchRecent(identity: SocialIdentity, _sinceId: string | null = null, context: FetchContext = {}): Promise<FetchResult | null> {
    if (!this.mtprotoUsable) return null;
    try {
      await this.discover(identity, context.telegramLinks ?? []);
      const records = this.registryFor(identity.mint).filter((record) => record.active && record.accessStatus === 'ACCESSIBLE').slice(0, MAX_SOURCES_PER_TOKEN);
      if (!records.length) return null;
      const now = this.now();
      const posts: RawSocialPost[] = [];
      let messageSources = 0;
      let complete = true;
      let memberCount: number | null = null;
      for (const record of records) {
        if (!this.subscribe(identity.mint, record)) continue;
        const buffer = this.buffers.get(record.username)!;
        await this.refreshBuffer(record.username, buffer);
        if (record.officialStatus === 'OFFICIAL' && buffer.members !== null) memberCount = buffer.members;
        record.lastVerifiedAt = now;
        // Broadcast channels are announcements by admins, not community activity: they contribute member growth only.
        if (buffer.chat.type === 'CHANNEL') {
          const key = `${identity.mint}|${record.username}`;
          const unseen = buffer.messages.filter((message) => message.id > (this.consumers.get(key) ?? 0));
          this.metrics.announcementsSkipped += unseen.length;
          if (buffer.messages.length) this.consumers.set(key, buffer.messages[buffer.messages.length - 1].id);
          continue;
        }
        messageSources += 1;
        if (!buffer.complete) complete = false;
        const key = `${identity.mint}|${record.username}`;
        const cursor = this.consumers.get(key) ?? 0;
        for (const message of buffer.messages) {
          if (message.id <= cursor) continue;
          posts.push({
            id: `tg:${message.chatId}:${message.id}`, source: 'TELEGRAM', authorId: hashTelegramSender(message.senderId, message.chatId), text: message.text,
            createdAt: message.date, receivedAt: now, chatUsername: record.username, officialSource: record.officialStatus === 'OFFICIAL' || record.officialStatus === 'PROBABLE_OFFICIAL',
            forwarded: message.forwarded, forwards: message.forwards, replyToId: message.replyToId !== null ? `tg:${message.chatId}:${message.replyToId}` : null,
            likes: null, reposts: null, replies: null, views: message.views,
            // Search-found groups discuss many tokens: only messages with the exact mint are attributed.
            mintOnly: record.via === 'TELEGRAM_SEARCH',
          });
        }
        if (buffer.messages.length) this.consumers.set(key, buffer.messages[buffer.messages.length - 1].id);
      }
      if (!messageSources) return memberCount !== null ? { posts: [], newestId: null, complete: false, memberCount, messageCoverage: false } : null;
      return { posts, newestId: null, complete, memberCount, messageCoverage: true };
    } catch (error) {
      if (error instanceof TelegramFloodWait || error instanceof TelegramAccessError) return null;
      this.options.logger?.warn({ provider: 'TELEGRAM', error: sanitizeTelegramError(error) }, 'Telegram fetch failed');
      return null;
    }
  }

  /** Token no longer tracked: drop its cursors; chats nobody uses any more are unsubscribed (no leaks). */
  release(mint: string) {
    this.registry.delete(mint);
    this.searchedAt.delete(mint);
    for (const key of [...this.consumers.keys()]) if (key.startsWith(`${mint}|`)) this.consumers.delete(key);
    for (const [username, buffer] of this.buffers) {
      buffer.users.delete(mint);
      if (!buffer.users.size) this.buffers.delete(username);
    }
  }

  /** Bot inbox (optional): group messages forwarded by the API's bot. */
  async drain(): Promise<RawSocialPost[]> {
    if (!this.options.enabled || !this.options.inbox) return [];
    try {
      const raw = await this.options.inbox.popMany(500);
      return raw.flatMap((item) => {
        try {
          const message = JSON.parse(item) as { chatId: string; chatUsername: string | null; messageId: number; authorId: string; text: string; createdAt: number; receivedAt: number };
          this.metrics.botMessagesReceived += 1;
          return [{ id: `tg:${message.chatId}:${message.messageId}`, source: 'TELEGRAM' as const, authorId: `tg:${message.authorId}`, text: message.text, createdAt: message.createdAt, receivedAt: message.receivedAt, chatUsername: message.chatUsername?.toLowerCase() ?? null, likes: null, reposts: null, replies: null, views: null }];
        } catch {
          return [];
        }
      });
    } catch (error) {
      this.status.errors += 1;
      this.status.lastError = sanitizeTelegramError(error);
      return [];
    }
  }

  async stop() {
    await this.options.gateway?.disconnect().catch(() => undefined);
  }
}

/**
 * GramJS (`telegram` package, MTProto) gateway. FLOOD_WAIT is never slept on inside the library
 * (floodSleepThreshold 0): the provider backs off itself. Library logging is limited to errors and never includes
 * the session string.
 */
export async function createGramJsGateway(credentials: { apiId: number; apiHash: string; session: string }): Promise<TelegramGateway> {
  const { TelegramClient, Api, sessions, errors, Logger } = await import('telegram');
  const { LogLevel } = await import('telegram/extensions/Logger.js');
  const client = new TelegramClient(new sessions.StringSession(credentials.session), credentials.apiId, credentials.apiHash, {
    connectionRetries: 3, autoReconnect: true, floodSleepThreshold: 0, retryDelay: 2_000, baseLogger: new Logger(LogLevel.ERROR),
  });
  const entities = new Map<string, InstanceType<typeof Api.Channel> | InstanceType<typeof Api.Chat>>();

  const translate = (error: unknown): never => {
    if (error instanceof errors.FloodWaitError) throw new TelegramFloodWait(error.seconds);
    const code = (error as { errorMessage?: string })?.errorMessage ?? (error instanceof Error ? error.message : String(error));
    if (/CHANNEL_PRIVATE|CHAT_ADMIN_REQUIRED|CHANNEL_INVALID|USER_BANNED_IN_CHANNEL|CHAT_FORBIDDEN|INVITE_HASH/i.test(code)) throw new TelegramAccessError('NO_ACCESS', code);
    if (/USERNAME_NOT_OCCUPIED|USERNAME_INVALID|No user has|Cannot find any entity/i.test(code)) throw new TelegramAccessError('NOT_FOUND', code);
    if (/AUTH_KEY_UNREGISTERED|SESSION_REVOKED|SESSION_EXPIRED|USER_DEACTIVATED/i.test(code)) throw new TelegramAccessError('NOT_AUTHORIZED', code);
    throw error instanceof Error ? error : new Error(code);
  };
  const guarded = async <T>(fn: () => Promise<T>) => {
    try {
      return await fn();
    } catch (error) {
      return translate(error);
    }
  };
  const chatOf = (entity: unknown): TelegramChat => {
    if (entity instanceof Api.Channel) return { id: entity.id.toString(), username: entity.username?.toLowerCase() ?? null, type: entity.broadcast ? 'CHANNEL' : entity.megagroup ? 'SUPERGROUP' : 'UNKNOWN', title: entity.title ?? null };
    if (entity instanceof Api.Chat) return { id: entity.id.toString(), username: null, type: 'GROUP', title: entity.title ?? null };
    throw new TelegramAccessError('NOT_FOUND', 'NOT_A_CHAT');
  };
  const messageOf = (message: unknown, chatId: string): TelegramMessage | null => {
    if (!(message instanceof Api.Message)) return null;
    const replyTo = message.replyTo instanceof Api.MessageReplyHeader ? message.replyTo.replyToMsgId ?? null : null;
    return {
      id: message.id, chatId, senderId: message.senderId?.toString() ?? null, text: message.message ?? '', date: message.date * 1000,
      replyToId: replyTo, forwarded: Boolean(message.fwdFrom), forwards: message.forwards ?? null, views: message.views ?? null,
    };
  };
  const entityOf = async (username: string) => {
    const cached = entities.get(username);
    if (cached) return cached;
    const entity = await guarded(() => client.getEntity(username));
    if (!(entity instanceof Api.Channel) && !(entity instanceof Api.Chat)) throw new TelegramAccessError('NOT_FOUND', 'NOT_A_CHAT');
    entities.set(username, entity);
    return entity;
  };

  return {
    async connect() {
      await guarded(() => client.connect());
      const authorized = await guarded(() => client.checkAuthorization());
      if (!authorized) throw new TelegramAccessError('NOT_AUTHORIZED', 'SESSION_NOT_AUTHORIZED');
    },
    async disconnect() {
      await client.destroy().catch(() => undefined);
    },
    isConnected: () => Boolean(client.connected),
    async resolve(username) {
      return chatOf(await entityOf(username));
    },
    async history(username, minId, limit) {
      const entity = await entityOf(username);
      const chatId = entity.id.toString();
      const messages = await guarded(() => client.getMessages(entity, { limit, minId }));
      return messages.map((message) => messageOf(message, chatId)).filter((message): message is TelegramMessage => message !== null);
    },
    async memberCount(username) {
      const entity = await entityOf(username);
      if (entity instanceof Api.Channel) {
        const full = await guarded(() => client.invoke(new Api.channels.GetFullChannel({ channel: entity })));
        return full.fullChat instanceof Api.ChannelFull ? full.fullChat.participantsCount ?? null : null;
      }
      return entity.participantsCount ?? null;
    },
    async searchGlobal(query, limit) {
      const result = await guarded(() => client.invoke(new Api.messages.SearchGlobal({
        q: query, filter: new Api.InputMessagesFilterEmpty(), minDate: 0, maxDate: 0, offsetRate: 0, offsetPeer: new Api.InputPeerEmpty(), offsetId: 0, limit,
      })));
      if (!('messages' in result) || !('chats' in result)) return [];
      const chats = new Map<string, TelegramChat>();
      for (const chat of result.chats) {
        try {
          const mapped = chatOf(chat);
          chats.set(mapped.id, mapped);
        } catch {
          // users / forbidden chats are ignored
        }
      }
      return result.messages.flatMap((message) => {
        if (!(message instanceof Api.Message) || !(message.peerId instanceof Api.PeerChannel)) return [];
        const chat = chats.get(message.peerId.channelId.toString());
        const mapped = chat ? messageOf(message, chat.id) : null;
        return chat && mapped ? [{ chat, message: mapped }] : [];
      });
    },
  };
}
