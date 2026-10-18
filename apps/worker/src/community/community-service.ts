/**
 * Community Intelligence service (worker, MONITOR_ONLY). Extends the existing Social Intelligence: Telegram / X come
 * from the SocialService snapshot, this service adds DEX Screener profile / promotion data, on-chain community
 * statistics from the existing launch trade stream and the optional LunarCrush adapter.
 *
 *  - `assess(mint, social, at)` is SYNCHRONOUS and never does I/O: it combines the data already collected and only the
 *    parts received at or before `at` (a later DEX / LunarCrush response is never used for an earlier snapshot);
 *  - collection runs in `tick()` (background timer): prioritised by stage (3 = passed basic checks first), batched
 *    (30 tokens per DEX Screener request), budgeted per provider, with backoff; it never throws;
 *  - nothing here is on the exit path, and no trade is made, blocked or sized by it.
 */
import { Prisma, type PrismaClient } from '@prisma/client';
import {
  computeCommunitySnapshot, computeOnchainCommunityStats, type CommunitySnapshotResult, type CommunitySourceId, type DexProfileObservation,
  type LunarObservation, type OnchainTradeEvent, type SocialSnapshotResult,
} from '@soltrader/strategy-engine';

import { DEXSCREENER_BATCH_SIZE, type DexScreenerClient, parseDexPairs } from './dexscreener.js';
import type { CommunityProviderHealth, HttpBudget } from './http-budget.js';
import type { LunarCrushClient } from './lunarcrush.js';

export type CommunityStage = 1 | 2 | 3;

interface TrackedCommunityToken {
  mint: string;
  stage: CommunityStage;
  trackedAt: number;
  lastSeenAt: number;
  trades: OnchainTradeEvent[];
  /** Newest last; a few kept so `assess` can pick the one known at its moment. */
  dex: DexProfileObservation[];
  lunar: LunarObservation[];
  lastDexAt: number;
  lastOrdersAt: number;
  lastLunarAt: number;
  orders: { receivedAt: number; value: { orders?: Array<{ type?: string; status?: string; paymentTimestamp?: number }>; boosts?: Array<{ amount?: number; paymentTimestamp?: number }> } } | null;
  lastPersistAt: number;
  last: CommunitySnapshotResult | null;
}

export interface CommunityServiceDeps {
  prisma?: Pick<PrismaClient, 'communitySnapshot'>;
  /**
   * Research social read (Social Intelligence collected independently of any user's social settings). Used when the
   * caller passes no social snapshot; must be time-correct for `at` and side-effect free.
   */
  social?: { assessAt(mint: string, at: number): SocialSnapshotResult | null };
  /** Read-only hand-over of the Telegram links found in an identity-confirmed DEX Screener profile. Must not throw. */
  onTelegramLinks?: (mint: string, links: string[], receivedAt: number) => void;
  dex: { client: DexScreenerClient; http: HttpBudget; cacheTtlMs: number } | null;
  lunar: { client: LunarCrushClient; http: HttpBudget; cacheTtlMs: number } | null;
  onchainEnabled: boolean;
  logger: { info(payload: unknown, message?: string): void; warn(payload: unknown, message?: string): void };
  now?: () => number;
}

const TRADE_RETENTION_MS = 6 * 60_000;
const MAX_TRADES_PER_TOKEN = 3_000;
const IDLE_UNTRACK_MS = 30 * 60_000;
const MAX_TRACKED = 2_000;
const DEX_REFRESH_MS: Record<CommunityStage, number> = { 1: 10 * 60_000, 2: 3 * 60_000, 3: 60_000 };
const ORDERS_REFRESH_MS = 5 * 60_000;
const PERSIST_INTERVAL_MS = 60_000;

/** Newest observation received at or before `at` (none = null). */
export function knownAt<T extends { receivedAt: number }>(list: T[], at: number): T | null {
  for (let index = list.length - 1; index >= 0; index -= 1) if (list[index].receivedAt <= at) return list[index];
  return null;
}

export class CommunityService {
  private readonly tokens = new Map<string, TrackedCommunityToken>();
  private ticking = false;
  private timer: ReturnType<typeof globalThis.setInterval> | null = null;
  readonly metrics = { tracked: 0, assessments: 0, snapshotsPersisted: 0, persistFailures: 0, tickFailures: 0, dexObservations: 0, lunarObservations: 0, identityMismatches: 0, notListed: 0, assessmentsWithTelegram: 0, telegramLinksForwarded: 0 };

  constructor(private readonly deps: CommunityServiceDeps) {}

  private now() {
    return this.deps.now?.() ?? Date.now();
  }

  start(intervalMs = 5_000) {
    this.timer = globalThis.setInterval(() => void this.tick(), intervalMs);
  }

  stop() {
    if (this.timer) globalThis.clearInterval(this.timer);
  }

  providerStatus(): Partial<Record<CommunitySourceId, 'ENABLED' | 'DISABLED' | 'NOT_CONFIGURED'>> {
    const state = (http: HttpBudget | undefined, present: boolean) => {
      if (!present || !http) return 'DISABLED' as const;
      const health = http.health();
      return !health.enabled ? 'DISABLED' as const : !health.configured ? 'NOT_CONFIGURED' as const : 'ENABLED' as const;
    };
    return { DEXSCREENER: state(this.deps.dex?.http, Boolean(this.deps.dex)), LUNARCRUSH: state(this.deps.lunar?.http, Boolean(this.deps.lunar)), ONCHAIN: this.deps.onchainEnabled ? 'ENABLED' : 'DISABLED' };
  }

  /** Registers / upgrades a token (never lowers the stage; no I/O). */
  track(mint: string, stage: CommunityStage) {
    const now = this.now();
    const existing = this.tokens.get(mint);
    if (existing) {
      existing.lastSeenAt = now;
      if (stage > existing.stage) existing.stage = stage;
      return;
    }
    if (this.tokens.size >= MAX_TRACKED) this.evictOldest();
    this.tokens.set(mint, { mint, stage, trackedAt: now, lastSeenAt: now, trades: [], dex: [], lunar: [], lastDexAt: 0, lastOrdersAt: 0, lastLunarAt: 0, orders: null, lastPersistAt: 0, last: null });
    this.metrics.tracked += 1;
  }

  /** Launch trade stream (synchronous, bounded). `usd` = traded SOL x SOL/USD; unknown SOL price -> not recorded. */
  onTrade(trade: { mint: string; wallet: string; isBuy: boolean; solAmount: number; receivedAt?: number }, solUsd: number | null) {
    if (!this.deps.onchainEnabled || !solUsd || !(solUsd > 0) || !(trade.solAmount > 0)) return;
    const token = this.tokens.get(trade.mint);
    if (!token) return;
    token.trades.push({ wallet: trade.wallet, isBuy: trade.isBuy, usd: trade.solAmount * solUsd, receivedAt: trade.receivedAt ?? this.now() });
    if (token.trades.length > MAX_TRADES_PER_TOKEN) token.trades.splice(0, token.trades.length - MAX_TRADES_PER_TOKEN);
  }

  /** Community snapshot at `at` (synchronous, no I/O). Only data received at or before `at` is used. */
  assess(mint: string, social: SocialSnapshotResult | null, at = this.now()): CommunitySnapshotResult | null {
    const token = this.tokens.get(mint);
    if (!token) return null;
    this.metrics.assessments += 1;
    const dex = knownAt(token.dex, at);
    if (dex && this.deps.dex) this.deps.dex.http.stats.cacheHits += 1;
    let socialAt = social;
    if (!socialAt && this.deps.social) {
      try {
        socialAt = this.deps.social.assessAt(mint, at);
      } catch {
        socialAt = null;
      }
    }
    const result = computeCommunitySnapshot({
      at, mint, social: socialAt,
      dex,
      // On-chain stats are computed AT `at` from the trades received by then.
      onchain: this.deps.onchainEnabled ? computeOnchainCommunityStats(token.trades, at) : null,
      lunar: knownAt(token.lunar, at),
      providers: this.providerStatus(),
    });
    if (!token.last || token.last.at <= at) token.last = result;
    if (result.sources.TELEGRAM.status === 'OK' || result.sources.TELEGRAM.status === 'WEAK') this.metrics.assessmentsWithTelegram += 1;
    return result;
  }

  latest(mint: string) {
    return this.tokens.get(mint)?.last ?? null;
  }

  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.now();
      await this.collectDex(now);
      await this.collectLunar(now);
      await this.persist(now);
      this.housekeeping(now);
    } catch (error) {
      this.metrics.tickFailures += 1;
      this.deps.logger.warn({ err: error instanceof Error ? error.message.slice(0, 200) : String(error) }, 'Community tick failed (trading unaffected)');
    } finally {
      this.ticking = false;
    }
  }

  private due(now: number) {
    return [...this.tokens.values()]
      .filter((token) => now - token.lastDexAt >= Math.max(this.deps.dex?.cacheTtlMs ?? 0, DEX_REFRESH_MS[token.stage]))
      .sort((a, b) => b.stage - a.stage || a.lastDexAt - b.lastDexAt);
  }

  private async collectDex(now: number) {
    const dex = this.deps.dex;
    if (!dex) return;
    // Batched: up to 30 tokens per request, as many requests as the budget allows this tick (max 3).
    const queue = this.due(now);
    for (let batchIndex = 0; batchIndex < 3 && queue.length && dex.http.available(); batchIndex += 1) {
      const batch = queue.splice(0, DEXSCREENER_BATCH_SIZE);
      for (const token of batch) token.lastDexAt = now;
      dex.http.stats.cacheMisses += batch.length;
      const pairs = await dex.client.tokens(batch.map((token) => token.mint));
      if (!pairs) {
        // Not made / failed: retry soon (not before the backoff ends; the budget decides).
        for (const token of batch) token.lastDexAt = now - DEX_REFRESH_MS[token.stage] + 15_000;
        continue;
      }
      const receivedAt = this.now();
      for (const token of batch) {
        const observation = parseDexPairs(token.mint, pairs.get(token.mint) ?? [], receivedAt, token.orders?.value ?? null);
        if (observation.pairFound && !observation.identityConfirmed) this.metrics.identityMismatches += 1;
        if (!observation.pairFound) this.metrics.notListed += 1;
        if (observation.identityConfirmed && observation.telegramLinks?.length && this.deps.onTelegramLinks) {
          try {
            this.deps.onTelegramLinks(token.mint, observation.telegramLinks, receivedAt);
            this.metrics.telegramLinksForwarded += observation.telegramLinks.length;
          } catch {
            // hand-over is best effort
          }
        }
        token.dex.push(observation);
        if (token.dex.length > 4) token.dex.splice(0, token.dex.length - 4);
        this.metrics.dexObservations += 1;
      }
    }
    // Paid orders / boost payments: only for listed tokens at stage >= 2, one request per token every 5 minutes.
    const ordersDue = [...this.tokens.values()].filter((token) => token.stage >= 2 && token.dex.at(-1)?.identityConfirmed && now - token.lastOrdersAt >= ORDERS_REFRESH_MS).sort((a, b) => b.stage - a.stage).slice(0, 3);
    for (const token of ordersDue) {
      if (!dex.http.available()) break;
      token.lastOrdersAt = now;
      const orders = await dex.client.orders(token.mint);
      if (!orders) continue;
      const receivedAt = this.now();
      token.orders = { receivedAt, value: orders };
      const latest = token.dex.at(-1);
      // A new observation (received now) carries the orders; earlier observations stay unchanged (time-correct).
      if (latest) {
        const parsed = parseDexPairs(token.mint, [], receivedAt, orders);
        token.dex.push({ ...latest, receivedAt, paidOrders: parsed.paidOrders, boostPayments: parsed.boostPayments });
      }
      if (token.dex.length > 4) token.dex.splice(0, token.dex.length - 4);
    }
  }

  private async collectLunar(now: number) {
    const lunar = this.deps.lunar;
    if (!lunar || !lunar.http.available()) return;
    // Only tokens that passed the basic checks (stage 3); the cache keeps requests rare.
    const due = [...this.tokens.values()].filter((token) => token.stage === 3 && now - token.lastLunarAt >= lunar.cacheTtlMs).slice(0, 2);
    for (const token of due) {
      token.lastLunarAt = now;
      const observation = await lunar.client.coin(token.mint, this.now());
      if (!observation) continue;
      token.lunar.push(observation);
      if (token.lunar.length > 3) token.lunar.splice(0, token.lunar.length - 3);
      this.metrics.lunarObservations += 1;
    }
  }

  /** Audit / UI history (stage >= 2, throttled, asynchronous). */
  private async persist(now: number) {
    const delegate = this.deps.prisma?.communitySnapshot;
    if (!delegate) return;
    for (const token of this.tokens.values()) {
      if (token.stage < 2 || now - token.lastPersistAt < PERSIST_INTERVAL_MS) continue;
      const snapshot = token.last && now - token.last.at < 15_000 ? token.last : this.assess(token.mint, null, now);
      if (!snapshot) continue;
      token.lastPersistAt = now;
      const f = snapshot.features;
      await delegate.create({ data: {
        mint: token.mint, at: new Date(snapshot.at), version: snapshot.version, mode: snapshot.mode, quality: snapshot.quality,
        communityScore: f.communityScore, dataQuality: f.communityDataQuality ?? 0, coverage: f.communityCoverage !== null ? new Prisma.Decimal(f.communityCoverage) : null,
        socialMomentum: f.socialMomentum, spamScore: f.socialSpamScore, mentions5m: f.mentions5m, uniqueAuthors5m: f.uniqueAuthors5m, onchainBuyers5m: f.onchainBuyers5m,
        buyerConcentration: f.buyerConcentration !== null ? new Prisma.Decimal(f.buyerConcentration) : null, paidPromotion: f.paidPromotionSignal,
        features: f as unknown as Prisma.InputJsonValue, sources: snapshot.sources as unknown as Prisma.InputJsonValue, components: { components: snapshot.components, weights: snapshot.weightsUsed } as Prisma.InputJsonValue,
        lateExcluded: snapshot.lateExcluded as Prisma.InputJsonValue, reasons: snapshot.reasons as Prisma.InputJsonValue,
      } }).then(() => {
        this.metrics.snapshotsPersisted += 1;
      }).catch((error: unknown) => {
        this.metrics.persistFailures += 1;
        if (this.metrics.persistFailures % 50 === 1) this.deps.logger.warn({ err: error instanceof Error ? error.message.slice(0, 200) : String(error) }, 'Community snapshot persist failed');
      });
    }
  }

  private housekeeping(now: number) {
    for (const [mint, token] of this.tokens) {
      if (now - token.lastSeenAt > IDLE_UNTRACK_MS) {
        this.tokens.delete(mint);
        continue;
      }
      const cutoff = now - TRADE_RETENTION_MS;
      if (token.trades.length && token.trades[0].receivedAt < cutoff) token.trades = token.trades.filter((trade) => trade.receivedAt >= cutoff);
    }
  }

  private evictOldest() {
    let oldest: TrackedCommunityToken | null = null;
    for (const token of this.tokens.values()) if (!oldest || token.lastSeenAt < oldest.lastSeenAt) oldest = token;
    if (oldest) this.tokens.delete(oldest.mint);
  }

  /** Provider health + coverage for the Community page (credential-free). */
  health() {
    const tokens = [...this.tokens.values()];
    const monitored = tokens.filter((token) => token.stage >= 2);
    const coverage = (filter: (token: TrackedCommunityToken) => boolean) => ({ monitored: monitored.length, covered: monitored.filter(filter).length });
    const providers: CommunityProviderHealth[] = [];
    if (this.deps.dex) providers.push(this.deps.dex.http.health({ coverage: { ...coverage((token) => Boolean(token.dex.at(-1)?.identityConfirmed)), notListed: this.metrics.notListed, identityMismatches: this.metrics.identityMismatches } }));
    if (this.deps.lunar) providers.push(this.deps.lunar.http.health({ coverage: coverage((token) => Boolean(token.lunar.at(-1)?.identityConfirmed)) }));
    providers.push({
      source: 'ONCHAIN', state: this.deps.onchainEnabled ? 'ACTIVE' : 'DISABLED', enabled: this.deps.onchainEnabled, configured: this.deps.onchainEnabled, requests: 0, successes: 0, errors: 0, rateLimitEvents: 0,
      cacheHits: 0, cacheMisses: 0, skippedBudget: 0, latencyP50Ms: null, latencyP95Ms: null, lastSuccessAt: null, lastError: null, backoffUntil: null, budgetPerMinute: 0,
      coverage: coverage((token) => token.trades.length > 0),
    });
    return {
      at: new Date(this.now()).toISOString(), mode: 'MONITOR_ONLY' as const, tracked: tokens.length, monitored: monitored.length,
      stages: tokens.reduce<Record<string, number>>((counts, token) => ({ ...counts, [`stage${token.stage}`]: (counts[`stage${token.stage}`] ?? 0) + 1 }), {}),
      providers, metrics: this.metrics,
    };
  }
}
