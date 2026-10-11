/**
 * Social collection + snapshot service (worker). Never on the exit path; entry decisions read the already computed
 * snapshot synchronously (`assess`) and never wait for a provider request.
 *
 * Staged, budgeted collection:
 *   stage 1 - identity: official links from the metadata URI (cheap, bounded concurrency);
 *   stage 2 - basic activity: provider queries at a slow cadence (also a deterministic ~10% sample of early-rejected
 *             launches, so filters can later be evaluated on rejected candidates too);
 *   stage 3 - deeper monitoring for candidates that passed basic security / liquidity / launch checks.
 */
import { Prisma, type PrismaClient } from '@prisma/client';
import {
  computeSocialSnapshot, computeSocialWindows, identityFromMetadata, matchSocialText, MIN_MATCH_CONFIDENCE,
  type OnchainContext, type SocialEvent, type SocialIdentity, type SocialSnapshotResult, type SocialSource, type SourceStatus,
} from '@soltrader/strategy-engine';
import { RollingPercentiles } from '@soltrader/trading-engine';

import { fetchTokenMetadata } from './metadata.js';
import { USABLE_PROVIDER_STATES, type RawSocialPost, type SocialDataProvider } from './providers.js';
import type { TelegramSourceRecord } from './telegram.js';

export type SocialStage = 1 | 2 | 3;

interface TrackedToken {
  identity: SocialIdentity;
  metadataUri: string | null;
  metadataState: 'PENDING' | 'RESOLVED' | 'UNAVAILABLE';
  stage: SocialStage;
  trackedAt: number;
  lastSeenAt: number;
  events: SocialEvent[];
  ambiguous: SocialEvent[];
  seen: Set<string>;
  coverage: Partial<Record<SocialSource, number>>;
  sinceId: Partial<Record<SocialSource, string | null>>;
  lastFetchAt: Partial<Record<SocialSource, number>>;
  lastSnapshot: SocialSnapshotResult | null;
  lastPersistAt: number;
  /** Member count samples (Telegram official source), newest last. */
  memberSamples: Array<{ t: number; count: number }>;
  /** Window metrics cache (recomputed when events change or after 1 s). */
  windowCache: { base: ReturnType<typeof computeSocialWindows>; eventCount: number } | null;
}

export interface SocialServiceLogger {
  info(payload: unknown, message?: string): void;
  warn(payload: unknown, message?: string): void;
}

export interface SocialServiceDeps {
  prisma: Pick<PrismaClient, 'socialSnapshot' | 'launchCandidate'> & Partial<Pick<PrismaClient, 'telegramSource' | 'token'>>;
  providers: SocialDataProvider[];
  logger: SocialServiceLogger;
  fetchMetadata?: typeof fetchTokenMetadata;
  now?: () => number;
  /** Optional AI social analysis (AI_SOCIAL_ANALYSIS_ENABLED, default false: zero LLM calls). Informational only. */
  aiEnabled?: boolean;
}

/** Raw text retention: events older than the longest window (30 min) are dropped from memory. */
const EVENT_RETENTION_MS = 31 * 60_000;

const MAX_EVENTS_PER_TOKEN = 2_000;
const STAGE_INTERVAL_MS: Record<SocialStage, number> = { 1: Number.POSITIVE_INFINITY, 2: 60_000, 3: 15_000 };
const IDLE_UNTRACK_MS = 30 * 60_000;
const PERSIST_INTERVAL_MS = 30_000;

/** Deterministic ~10% sample (by mint) of launches that are rejected early. */
export function inRejectedSample(mint: string, percent = 10) {
  let hash = 0;
  for (const char of mint) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % 100 < percent;
}

export class SocialService {
  private readonly tokens = new Map<string, TrackedToken>();
  private metadataQueue: string[] = [];
  private metadataInFlight = 0;
  private timer: ReturnType<typeof globalThis.setInterval> | null = null;
  private ticking = false;
  readonly metrics = {
    tokensTracked: 0, snapshotsPersisted: 0, metadataResolved: 0, metadataUnavailable: 0, assessLatency: new RollingPercentiles(), collectionLatency: new RollingPercentiles(),
    snapshotLatency: new RollingPercentiles(),
    /** Per provider: messages received / attributed / duplicates (same stable id) / ambiguous (ticker only) / unrelated. */
    bySource: {} as Partial<Record<SocialSource, { received: number; processed: number; duplicates: number; ambiguous: number; unrelated: number }>>,
  };

  constructor(private readonly deps: SocialServiceDeps) {}

  private now() {
    return this.deps.now?.() ?? Date.now();
  }

  start(intervalMs = 5_000) {
    this.timer = globalThis.setInterval(() => void this.tick(), intervalMs);
  }

  stop() {
    if (this.timer) globalThis.clearInterval(this.timer);
  }

  /** Registers / upgrades a token. Never decreases the stage; never does I/O on the caller's path. */
  track(input: { mint: string; symbol: string | null; name: string | null; metadataUri: string | null; stage: SocialStage }) {
    const now = this.now();
    const existing = this.tokens.get(input.mint);
    if (existing) {
      existing.lastSeenAt = now;
      if (input.stage > existing.stage) existing.stage = input.stage;
      if (!existing.metadataUri && input.metadataUri) existing.metadataUri = input.metadataUri;
      return;
    }
    this.tokens.set(input.mint, {
      identity: identityFromMetadata(input.mint, input.symbol, input.name, null), metadataUri: input.metadataUri, metadataState: 'PENDING', stage: input.stage,
      trackedAt: now, lastSeenAt: now, events: [], ambiguous: [], seen: new Set(), coverage: {}, sinceId: {}, lastFetchAt: {}, lastSnapshot: null, lastPersistAt: 0, windowCache: null, memberSamples: [],
    });
    this.metrics.tokensTracked += 1;
    this.metadataQueue.push(input.mint);
  }

  /** Last computed snapshot (no recomputation, no I/O) - for the live monitor list. */
  latest(mint: string) {
    const snapshot = this.tokens.get(mint)?.lastSnapshot ?? null;
    const telegram = snapshot?.perSource.TELEGRAM ?? null;
    return snapshot ? {
      socialScore: snapshot.socialScore, momentum: snapshot.momentumScore, spam: snapshot.spamScore, confirmation: snapshot.confirmation, freshness: snapshot.freshness, shadowDecision: snapshot.shadowDecision,
      providersUsed: snapshot.providersUsed, telegramMomentum: telegram?.momentum ?? null, telegramQuality: telegram?.quality ?? null, telegramSpam: telegram?.spam ?? null,
    } : null;
  }

  identity(mint: string) {
    return this.tokens.get(mint)?.identity ?? null;
  }

  /** Synchronous: freshest snapshot recomputed with the caller's on-chain context (events already collected). */
  /**
   * Social assessment as of `at` (the caller's decision / snapshot moment; default: now). Only events received and
   * created at or before `at` are used, and the result is never dated after `at`, so a feature snapshot taken at `at`
   * can use it (no late data, nothing back-dated: a cached window from an earlier moment keeps its own, earlier time).
   */
  assess(mint: string, onchain: OnchainContext | null, at?: number): SocialSnapshotResult | null {
    const token = this.tokens.get(mint);
    if (!token) return null;
    const started = globalThis.performance.now();
    const sources = this.sourceStatuses(token);
    let cache = token.windowCache;
    const now = at ?? this.now();
    // Window metrics only change with new events or time; within 1 s they are reused (per-user on-chain parts are cheap).
    // A cache computed after `now` (another caller, later clock) is never reused for an earlier moment.
    if (!cache || cache.eventCount !== token.events.length || now - cache.base.at >= 1_000 || cache.base.at > now) {
      cache = { base: computeSocialWindows(token.events, now, sources), eventCount: token.events.length };
      token.windowCache = cache;
    }
    const snapshot = computeSocialSnapshot({ events: token.events, ambiguousEvents: token.ambiguous, at: cache.base.at, sources, onchain, base: cache.base, memberSamples: token.memberSamples });
    token.lastSnapshot = snapshot;
    this.metrics.assessLatency.add(globalThis.performance.now() - started);
    return snapshot;
  }

  private sourceStatuses(token: TrackedToken): SourceStatus[] {
    return this.deps.providers.map((provider) => {
      const health = provider.health();
      const coverageStart = token.coverage[provider.source] ?? null;
      const usable = health.enabled && health.configured && USABLE_PROVIDER_STATES.has(health.state);
      const available = usable && coverageStart !== null;
      // Why a source is missing (never counted as zero activity): disabled, not configured, disconnected, or no source for this token.
      const reason = available ? null : !health.enabled ? 'DISABLED' : !health.configured ? 'NOT_CONFIGURED' : !usable ? health.state : 'NO_SOURCE_FOUND';
      return { source: provider.source, enabled: health.enabled, reason, available, state: health.state, coverageStart, lastSuccessAt: health.lastSuccessAt };
    });
  }

  /** Adds posts to a token (match confidence; ambiguous ones kept apart, never counted). */
  ingest(mint: string, posts: RawSocialPost[], options: { officialChannel?: boolean } = {}) {
    const token = this.tokens.get(mint);
    if (!token) return;
    for (const post of posts) {
      const counters = (this.metrics.bySource[post.source] ??= { received: 0, processed: 0, duplicates: 0, ambiguous: 0, unrelated: 0 });
      counters.received += 1;
      // Stable ids (tg:<chat>:<message>, x:<tweet>): a re-delivered message is never counted twice.
      if (token.seen.has(post.id)) {
        counters.duplicates += 1;
        continue;
      }
      token.seen.add(post.id);
      const official = Boolean(options.officialChannel || post.officialSource);
      const match = matchSocialText(token.identity, post.text, official);
      // Unrelated messages are dropped; ticker-only matches are kept apart as ambiguous (reported, never counted).
      if (match.basis === 'UNKNOWN') {
        counters.unrelated += 1;
        continue;
      }
      const event: SocialEvent = { ...post, matchBasis: match.basis, matchConfidence: match.confidence, fromOfficialChannel: official };
      if (match.confidence >= MIN_MATCH_CONFIDENCE) {
        token.events.push(event);
        counters.processed += 1;
      } else {
        token.ambiguous.push(event);
        counters.ambiguous += 1;
      }
    }
    if (token.seen.size > 10_000) token.seen = new Set([...token.seen].slice(-5_000));
    if (token.events.length > MAX_EVENTS_PER_TOKEN) token.events.splice(0, token.events.length - MAX_EVENTS_PER_TOKEN);
    if (token.ambiguous.length > 500) token.ambiguous.splice(0, token.ambiguous.length - 500);
  }

  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.now();
      await this.resolveMetadata();
      await this.collect(now);
      await this.persistSnapshots(now);
      for (const [mint, token] of this.tokens) {
        if (now - token.lastSeenAt > IDLE_UNTRACK_MS) {
          this.tokens.delete(mint);
          for (const provider of this.deps.providers) provider.release?.(mint);
          continue;
        }
        // Data minimisation: raw message text is kept in memory only while a window can use it.
        const cutoff = now - EVENT_RETENTION_MS;
        if (token.events.length && token.events[0].createdAt < cutoff) token.events = token.events.filter((event) => event.createdAt >= cutoff);
        if (token.ambiguous.length && token.ambiguous[0].createdAt < cutoff) token.ambiguous = token.ambiguous.filter((event) => event.createdAt >= cutoff);
      }
    } finally {
      this.ticking = false;
    }
  }

  private async resolveMetadata() {
    const fetcher = this.deps.fetchMetadata ?? fetchTokenMetadata;
    while (this.metadataQueue.length && this.metadataInFlight < 3) {
      const mint = this.metadataQueue.shift()!;
      const token = this.tokens.get(mint);
      if (!token) continue;
      this.metadataInFlight += 1;
      void fetcher(token.metadataUri).then(async (metadata) => {
        token.metadataState = metadata ? 'RESOLVED' : 'UNAVAILABLE';
        if (metadata) {
          token.identity = identityFromMetadata(mint, token.identity.symbol ?? (metadata.symbol as string | null), token.identity.name ?? (metadata.name as string | null), metadata);
          this.metrics.metadataResolved += 1;
          const image = typeof metadata.image === 'string' ? metadata.image : null;
          const links = { twitter: token.identity.officialX, telegram: token.identity.officialTelegram, website: token.identity.website, image, resolvedAt: new Date().toISOString() };
          await this.deps.prisma.launchCandidate.updateMany({ where: { mint }, data: { socialLinks: links as Prisma.InputJsonValue } }).catch(() => undefined);
          // Token logo for the UI (served through the API image proxy); a provider logo already stored wins.
          if (image) await this.deps.prisma.token?.updateMany({ where: { address: mint, imageUrl: null }, data: { imageUrl: image } }).catch(() => undefined);
        } else this.metrics.metadataUnavailable += 1;
      }).catch(() => {
        token.metadataState = 'UNAVAILABLE';
        this.metrics.metadataUnavailable += 1;
      }).finally(() => {
        this.metadataInFlight -= 1;
      });
    }
  }

  private async collect(now: number) {
    for (const provider of this.deps.providers) {
      const started = globalThis.performance.now();
      // Disabled providers (e.g. X_SOCIAL_ENABLED=false) are never called.
      if (!provider.health().enabled) continue;
      await provider.maintain?.().catch(() => undefined);
      if (provider.drain) {
        const posts = await provider.drain();
        // Bot inbox: the bot only sees groups it was added to. Coverage is only claimed for a token whose OFFICIAL
        // group delivered messages; silence elsewhere is unknown, not zero.
        for (const token of this.tokens.values()) {
          const official = token.identity.officialTelegram;
          const fromOfficial = posts.filter((post) => official && post.chatUsername === official);
          const others = posts.filter((post) => !(official && post.chatUsername === official));
          if (fromOfficial.length) {
            token.coverage[provider.source] ??= Math.min(...fromOfficial.map((post) => post.createdAt));
            this.ingest(token.identity.mint, fromOfficial, { officialChannel: true });
          }
          if (others.length) this.ingest(token.identity.mint, others);
        }
      }
      if (provider.fetchRecent) {
        // Priority: stage 3 first, then stage 2; within a stage the longest-waiting token first.
        const due = [...this.tokens.values()]
          .filter((token) => token.stage >= 2 && token.metadataState !== 'PENDING' && now - (token.lastFetchAt[provider.source] ?? 0) >= STAGE_INTERVAL_MS[token.stage])
          .sort((a, b) => b.stage - a.stage || (a.lastFetchAt[provider.source] ?? 0) - (b.lastFetchAt[provider.source] ?? 0))
          .slice(0, 5);
        for (const token of due) {
          token.lastFetchAt[provider.source] = now;
          const result = await provider.fetchRecent(token.identity, token.sinceId[provider.source] ?? null);
          if (!result) continue;
          token.sinceId[provider.source] = result.newestId;
          if (result.memberCount != null) {
            token.memberSamples.push({ t: now, count: result.memberCount });
            if (token.memberSamples.length > 120) token.memberSamples.splice(0, token.memberSamples.length - 120);
          }
          if (result.messageCoverage === false) continue;
          this.ingest(token.identity.mint, result.posts);
          if (token.coverage[provider.source] === undefined) {
            // Complete history -> covered since the token existed; a truncated page -> only from its oldest post.
            const oldest = result.posts.length ? Math.min(...result.posts.map((post) => post.createdAt)) : now;
            token.coverage[provider.source] = result.complete ? Math.min(token.trackedAt - 3_600_000, oldest) : oldest;
          }
        }
      }
      this.metrics.collectionLatency.add(globalThis.performance.now() - started);
    }
  }

  /** Stored snapshots (stage >= 2) for analytics / lead-lag; asynchronous and throttled. */
  private async persistSnapshots(now: number) {
    for (const token of this.tokens.values()) {
      if (token.stage < 2 || now - token.lastPersistAt < PERSIST_INTERVAL_MS) continue;
      const started = globalThis.performance.now();
      const snapshot = token.lastSnapshot && now - token.lastSnapshot.at < 10_000 ? token.lastSnapshot : computeSocialSnapshot({ events: token.events, ambiguousEvents: token.ambiguous, at: now, sources: this.sourceStatuses(token), onchain: null, memberSamples: token.memberSamples });
      this.metrics.snapshotLatency.add(globalThis.performance.now() - started);
      token.lastPersistAt = now;
      await this.deps.prisma.socialSnapshot.create({ data: {
        mint: token.identity.mint, at: new Date(snapshot.at), socialScore: snapshot.socialScore, momentumScore: snapshot.momentumScore, qualityScore: snapshot.qualityScore,
        spamScore: snapshot.spamScore, exhaustionScore: snapshot.exhaustionScore, dataQuality: snapshot.dataQuality, confirmation: snapshot.confirmation,
        shadowDecision: snapshot.shadowDecision, mentionTrend: snapshot.mentionTrend, tokenMatchConfidence: snapshot.tokenMatchConfidence !== null ? new Prisma.Decimal(snapshot.tokenMatchConfidence) : null,
        matchBasis: snapshot.matchBasis, mentions5m: snapshot.windows['5m']?.mentions ?? null, uniqueAuthors5m: snapshot.windows['5m']?.uniqueAuthors ?? null, freshness: snapshot.freshness,
        details: {
          windows: snapshot.windows, bySource: snapshot.bySource, reasons: snapshot.reasons, warnings: snapshot.warnings, sources: snapshot.sources, components: snapshot.components, identity: token.identity,
          perSource: snapshot.perSource, members: snapshot.members, providersUsed: snapshot.providersUsed, providersUnavailable: snapshot.providersUnavailable, providerWeights: snapshot.providerWeights,
        } as unknown as Prisma.InputJsonValue,
      } }).then(() => {
        this.metrics.snapshotsPersisted += 1;
      }).catch((error: unknown) => this.deps.logger.warn({ err: error instanceof Error ? error.message : String(error), mint: token.identity.mint }, 'Social snapshot persist failed'));
    }
  }

  /** Telegram source registry persistence (upsert by mint + username; best effort, never blocks collection). */
  recordTelegramSource(record: TelegramSourceRecord) {
    const delegate = this.deps.prisma.telegramSource;
    if (!delegate) return;
    const data = {
      telegramEntityId: record.chat?.id ?? null, telegramUrl: record.url, sourceType: record.chat?.type ?? 'UNKNOWN', officialStatus: record.officialStatus,
      lastVerifiedAt: record.lastVerifiedAt ? new Date(record.lastVerifiedAt) : null, matchBasis: record.matchBasis, matchConfidence: new Prisma.Decimal(record.matchConfidence),
      active: record.active, accessStatus: record.accessStatus,
    };
    void delegate.upsert({
      where: { mint_telegramUsername: { mint: record.mint, telegramUsername: record.username } },
      create: { mint: record.mint, telegramUsername: record.username, discoveredAt: new Date(record.discoveredAt), ...data },
      update: data,
    }).catch((error: unknown) => this.deps.logger.warn({ err: error instanceof Error ? error.message : String(error), mint: record.mint }, 'Telegram source persist failed'));
  }

  /**
   * Engine status from the ENABLED providers: HEALTHY (all usable), PARTIAL (some usable), DEGRADED (enabled but none
   * usable), NO_PROVIDER (nothing enabled and configured).
   */
  engineStatus() {
    const enabled = this.deps.providers.map((provider) => provider.health()).filter((health) => health.enabled && health.configured);
    if (!enabled.length) return 'NO_PROVIDER' as const;
    const healthy = enabled.filter((health) => health.state === 'ACTIVE' || health.state === 'CONNECTED');
    return healthy.length === enabled.length ? 'HEALTHY' as const : healthy.length ? 'PARTIAL' as const : 'DEGRADED' as const;
  }

  /** Provider health + cost / rate-limit metrics for the System page. */
  health() {
    const stages = [...this.tokens.values()].reduce<Record<string, number>>((counts, token) => {
      counts[`stage${token.stage}`] = (counts[`stage${token.stage}`] ?? 0) + 1;
      return counts;
    }, {});
    return {
      at: new Date(this.now()).toISOString(),
      providers: this.deps.providers.map((provider) => {
        const health = provider.health();
        const sorted = [...health.latencyMs].sort((a, b) => a - b);
        return { ...health, latencyMs: undefined, latencyP50Ms: sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : null, latencyP95Ms: sorted.length ? sorted[Math.floor((sorted.length - 1) * 0.95)] : null };
      }),
      engineStatus: this.engineStatus(), mode: 'MONITOR_ONLY', aiEnabled: Boolean(this.deps.aiEnabled),
      messages: this.metrics.bySource,
      telegramCoverage: this.telegramCoverage(),
      snapshotLatencyMs: this.metrics.snapshotLatency.summary(),
      tokensTracked: this.tokens.size, stages, metadataQueue: this.metadataQueue.length,
      metadataResolved: this.metrics.metadataResolved, metadataUnavailable: this.metrics.metadataUnavailable, snapshotsPersisted: this.metrics.snapshotsPersisted,
      assessLatencyMs: this.metrics.assessLatency.summary(), collectionLatencyMs: this.metrics.collectionLatency.summary(),
    };
  }

  /** Telegram coverage of the monitored (stage >= 2) tokens: with a readable source / with FRESH Telegram data. */
  private telegramCoverage() {
    const tokens = [...this.tokens.values()].filter((token) => token.stage >= 2);
    const covered = tokens.filter((token) => token.coverage.TELEGRAM !== undefined);
    const fresh = covered.filter((token) => token.lastSnapshot?.perSource.TELEGRAM?.freshness === 'FRESH');
    return { monitoredTokens: tokens.length, withSource: covered.length, fresh: fresh.length };
  }
}
