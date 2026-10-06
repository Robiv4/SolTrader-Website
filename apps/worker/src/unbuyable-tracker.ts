import type { PrismaClient } from '@prisma/client';

/** The subset of the Redis client this tracker needs (kept small so tests can use an in-memory fake). */
export interface TrackerRedis {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options?: { EX?: number }): Promise<unknown>;
  del(key: string | string[]): Promise<unknown>;
  mGet(keys: string[]): Promise<Array<string | null>>;
}

export interface SkipSettings {
  /** 0 disables skipping. */
  afterMinutes: number;
  forMinutes: number;
}

export interface SkipRecord {
  since: string;
  until: string;
  reason: string;
}

/**
 * Reasons that describe the account, not the token (limits, cash, an already open position, cooldown).
 * They never count towards skipping a token, otherwise a full account would push good tokens out.
 */
const ACCOUNT_LEVEL_REASONS = new Set([
  'POSITION_ALREADY_OPEN',
  'MAX_CONCURRENT_POSITIONS',
  'DAILY_LOSS_LIMIT',
  'POSITION_LIMIT_OR_CASH_EXHAUSTED',
  'PAPER_ACCOUNT_UNAVAILABLE',
  'COOLDOWN_ACTIVE',
  'INVALID_POSITION_SIZE',
  'INSUFFICIENT_PAPER_CASH',
  'AMOUNT_ABOVE_EXPOSURE_LIMIT',
  'AMOUNT_ABOVE_MAX_POSITION_SIZE',
  // Decision-mode / AI bookkeeping says nothing about whether the token itself can be bought.
  'DECISION_MODE_AI_ACTIVE',
  'DECISION_MODE_STRATEGY_ACTIVE',
  'AI_ANALYSIS_EXPIRED',
  'AI_ANALYSIS_NOT_ACTIONABLE',
  'EMERGENCY_STOP_ACTIVE',
]);

const SETTINGS_CACHE_MS = 30_000;

export function countsTowardsSkip(reasons: string[]) {
  return reasons.length === 0 || reasons.some((reason) => !ACCOUNT_LEVEL_REASONS.has(reason));
}

/**
 * Tracks, per user and token, how long a token has been continuously blocked or unbuyable. Once the
 * streak reaches the user's `skipUnbuyableAfterMinutes`, the token is skipped for
 * `skipUnbuyableForMinutes`: the scanner, the strategy runner and automatic buying leave it out, so the
 * scanner's slots go to other tokens. A successful buy resets the streak.
 */
export class UnbuyableTokenTracker {
  private readonly settingsCache = new Map<string, { settings: SkipSettings; loadedAt: number }>();

  constructor(
    private readonly redis: TrackerRedis,
    private readonly prisma: Pick<PrismaClient, 'botConfig'>,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async settingsFor(userId: string): Promise<SkipSettings> {
    const cached = this.settingsCache.get(userId);
    if (cached && this.now() - cached.loadedAt < SETTINGS_CACHE_MS) return cached.settings;
    const config = await this.prisma.botConfig.findUnique({ where: { userId }, select: { skipUnbuyableAfterMinutes: true, skipUnbuyableForMinutes: true } });
    const settings = { afterMinutes: Math.max(0, config?.skipUnbuyableAfterMinutes ?? 0), forMinutes: Math.max(1, config?.skipUnbuyableForMinutes ?? 60) };
    this.settingsCache.set(userId, { settings, loadedAt: this.now() });
    return settings;
  }

  /**
   * Records that the token could not be bought (hard block or rejection) for this user.
   * Returns the new skip record when this failure started a skip, otherwise null.
   */
  async recordFailure(userId: string, tokenAddress: string, reasons: string[]): Promise<SkipRecord | null> {
    if (!countsTowardsSkip(reasons)) return null;
    const settings = await this.settingsFor(userId);
    if (settings.afterMinutes <= 0) return null;
    if (await this.isSkipped(userId, tokenAddress)) return null;

    const now = this.now();
    const streakKey = this.streakKey(userId, tokenAddress);
    const windowMs = settings.afterMinutes * 60_000;
    // A gap longer than the window (or 10 minutes, whichever is larger) without failures breaks the streak.
    const maxGapMs = Math.max(windowMs, 10 * 60_000);
    const raw = await this.redis.get(streakKey);
    const streak = raw ? JSON.parse(raw) as { first: number; last: number } : null;
    const first = streak && now - streak.last <= maxGapMs ? streak.first : now;

    if (now - first >= windowMs) {
      const record: SkipRecord = {
        since: new Date(now).toISOString(),
        until: new Date(now + settings.forMinutes * 60_000).toISOString(),
        reason: reasons.join(', ') || 'UNBUYABLE',
      };
      await this.redis.set(this.skipKey(userId, tokenAddress), JSON.stringify(record), { EX: settings.forMinutes * 60 });
      await this.redis.del(streakKey);
      return record;
    }
    await this.redis.set(streakKey, JSON.stringify({ first, last: now }), { EX: Math.ceil((maxGapMs * 2) / 1000) });
    return null;
  }

  async recordSuccess(userId: string, tokenAddress: string) {
    await this.redis.del(this.streakKey(userId, tokenAddress));
  }

  async isSkipped(userId: string, tokenAddress: string) {
    return (await this.redis.get(this.skipKey(userId, tokenAddress))) !== null;
  }

  /** userIds (from the given list) that currently skip the token. */
  async usersSkipping(userIds: string[], tokenAddress: string): Promise<Set<string>> {
    if (userIds.length === 0) return new Set();
    const values = await this.redis.mGet(userIds.map((userId) => this.skipKey(userId, tokenAddress)));
    return new Set(userIds.filter((_, index) => values[index] !== null));
  }

  private streakKey(userId: string, tokenAddress: string) {
    return `unbuyable:streak:${userId}:${tokenAddress}`;
  }

  private skipKey(userId: string, tokenAddress: string) {
    return unbuyableSkipKey(userId, tokenAddress);
  }
}

/** Redis key of an active skip; shared with the API, which shows skipped tokens on the dashboard. */
export function unbuyableSkipKey(userId: string, tokenAddress: string) {
  return `unbuyable:skip:${userId}:${tokenAddress}`;
}
