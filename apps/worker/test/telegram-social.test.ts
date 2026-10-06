/**
 * Telegram-first Social Intelligence (tests 75-88). A mock MTProto gateway replaces GramJS: no network, no account.
 */
import {
  computeSocialSnapshot, matchSocialText, identityFromMetadata, socialBlocksEntry,
  type OnchainContext, type SocialEvent, type SourceStatus,
} from '@soltrader/strategy-engine';
import { describe, expect, it } from 'vitest';

import { XSocialProvider } from '../src/social/providers.js';
import { SocialService } from '../src/social/social-service.js';
import {
  hashTelegramSender, sanitizeTelegramError, TelegramAccessError, TelegramFloodWait, TelegramSocialProvider,
  type TelegramChat, type TelegramGateway, type TelegramMessage, type TelegramSourceRecord,
} from '../src/social/telegram.js';

const MINT = 'So1aNaMint1111111111111111111111111111111pump';
const T0 = Date.parse('2026-10-04T12:00:00Z');
const logger = { info: () => undefined, warn: () => undefined, error: () => undefined };
const onchain = (overrides: Partial<OnchainContext> = {}): OnchainContext => ({ launchScore: 80, launchMomentumScore: 70, exhaustionScore: 20, buySellRatio: 2, uniqueBuyers: 40, buyerTrend: 'ACCELERATING', liquidityChangePercent: 10, priceVelocity: 1, priceExtensionPercent: 20, ...overrides });

class MockGateway implements TelegramGateway {
  connected = false;
  connectCalls = 0;
  historyCalls = 0;
  failConnect = false;
  floodOnNextHistory: number | null = null;
  chats = new Map<string, { chat: TelegramChat; messages: TelegramMessage[]; members: number | null }>();

  addChat(username: string, type: TelegramChat['type'] = 'SUPERGROUP', members: number | null = 500) {
    this.chats.set(username, { chat: { id: `${this.chats.size + 100}`, username, type, title: username }, messages: [], members });
  }

  push(username: string, message: Partial<TelegramMessage> & { senderId: string; text: string; date: number }) {
    const chat = this.chats.get(username)!;
    chat.messages.push({ id: chat.messages.length + 1, chatId: chat.chat.id, replyToId: null, forwarded: false, forwards: null, views: null, ...message });
  }

  async connect() {
    this.connectCalls += 1;
    if (this.failConnect) throw new Error('network down');
    this.connected = true;
  }

  async disconnect() {
    this.connected = false;
  }

  isConnected() {
    return this.connected;
  }

  async resolve(username: string) {
    const chat = this.chats.get(username);
    if (!chat) throw new TelegramAccessError('NOT_FOUND');
    return chat.chat;
  }

  async history(username: string, minId: number, limit: number) {
    this.historyCalls += 1;
    if (this.floodOnNextHistory !== null) {
      const seconds = this.floodOnNextHistory;
      this.floodOnNextHistory = null;
      throw new TelegramFloodWait(seconds);
    }
    return this.chats.get(username)!.messages.filter((message) => message.id > minId).slice(-limit).reverse();
  }

  async memberCount(username: string) {
    return this.chats.get(username)?.members ?? null;
  }

  async searchGlobal() {
    return [];
  }
}

function setup(options: { telegram?: boolean; x?: boolean; gateway?: MockGateway | null; official?: string | null } = {}) {
  let now = T0;
  const clock = () => now;
  const gateway = options.gateway === undefined ? new MockGateway() : options.gateway;
  const records: TelegramSourceRecord[] = [];
  const telegram = new TelegramSocialProvider({ enabled: options.telegram ?? true, gateway, now: clock, globalSearchPerMinute: 0, onSource: (record) => records.push(record) });
  let xCalls = 0;
  const x = new XSocialProvider({ enabled: options.x ?? false, bearerToken: 'test-bearer', maxRequestsPer15Min: 10, now: clock, fetch: async () => { xCalls += 1; throw new Error('should not be called'); } });
  const snapshots: unknown[] = [];
  const prisma = { socialSnapshot: { create: async (args: { data: unknown }) => { snapshots.push(args.data); return args.data; } }, launchCandidate: { updateMany: async () => ({ count: 1 }) } } as never;
  const official = options.official === undefined ? 'zorbchat' : options.official;
  const service = new SocialService({ prisma, providers: [telegram, x], logger, now: clock, fetchMetadata: async () => ({ twitter: null, telegram: official ? `https://t.me/${official}` : null, website: null, name: 'Zorbulator', symbol: 'ZORB' }) });
  return {
    gateway, telegram, x, service, records, snapshots,
    xCalls: () => xCalls,
    advance: (ms: number) => { now += ms; },
    now: () => now,
    /** Two ticks: metadata (async) then collection. */
    async warmUp() {
      service.track({ mint: MINT, symbol: 'ZORB', name: 'Zorbulator', metadataUri: 'https://ipfs.io/ipfs/Qm', stage: 3 });
      await service.tick();
      await new Promise((resolve) => globalThis.setTimeout(resolve, 5));
      await service.tick();
    },
  };
}

// Engine-level helpers: Telegram-only events.
const AT = Date.parse('2026-10-04T12:10:00Z');
const identity = identityFromMetadata(MINT, 'ZORB', 'Zorbulator', { telegram: 'https://t.me/zorbchat' });
const tg = (available = true): SourceStatus => ({ source: 'TELEGRAM', enabled: true, available, state: available ? 'CONNECTED' : 'DISCONNECTED', coverageStart: available ? AT - 3_600_000 : null, lastSuccessAt: available ? AT - 3_000 : null, reason: available ? null : 'DISCONNECTED' });
const xDisabled: SourceStatus = { source: 'X', enabled: false, available: false, state: 'DISABLED', coverageStart: null, lastSuccessAt: null, reason: 'DISABLED' };
let sequence = 0;
function tgEvent(secondsAgo: number, author: string, text: string): SocialEvent {
  sequence += 1;
  const match = matchSocialText(identity, text, true);
  return { id: `tg:1:${sequence}`, source: 'TELEGRAM', authorId: author, text, createdAt: AT - secondsAgo * 1000, receivedAt: AT - secondsAgo * 1000 + 300, likes: null, reposts: null, replies: null, matchBasis: match.basis, matchConfidence: match.confidence, fromOfficialChannel: true };
}
const phrases = ['chart looks healthy', 'who is still holding', 'dev answered in voice chat', 'liquidity added', 'nice community here', 'buying a bit more', 'what is the roadmap', 'just joined from the site', 'cto vibes', 'volume picking up'];
/** Organic Telegram growth: messages and users rising minute over minute. */
function organicTelegram(users: number, messages: number) {
  const events: SocialEvent[] = [];
  for (let index = 0; index < messages; index += 1) {
    const secondsAgo = Math.floor(290 * Math.pow(1 - index / messages, 2));
    events.push(tgEvent(secondsAgo, `u${index % users}`, `${phrases[index % phrases.length]} #${index}`));
  }
  return events;
}

describe('Telegram-first social intelligence', () => {
  it('75. Telegram only: score from Telegram alone, X disabled is not counted as zero (no 50/50 halving), provenance recorded', async () => {
    const env = setup();
    env.gateway!.addChat('zorbchat');
    for (let index = 0; index < 40; index += 1) env.gateway!.push('zorbchat', { senderId: `user${index % 25}`, text: `${phrases[index % phrases.length]} ${index}`, date: T0 - 240_000 + index * 6_000 });
    await env.warmUp();
    const snapshot = env.service.assess(MINT, onchain())!;
    expect(snapshot.providersUsed).toEqual(['TELEGRAM']);
    expect(snapshot.providersUnavailable).toEqual([{ source: 'X', reason: 'DISABLED' }]);
    expect(snapshot.providerWeights).toEqual({ TELEGRAM: 1 });
    expect(snapshot.socialScore).not.toBeNull();
    expect(snapshot.perSource.TELEGRAM?.uniqueActiveUsers['5m']).toBe(25);
    expect(env.records[0]).toMatchObject({ username: 'zorbchat', officialStatus: 'OFFICIAL', matchBasis: 'OFFICIAL_SOCIAL_LINK', accessStatus: 'ACCESSIBLE' });
    // Same events scored with and without the disabled X entry: identical (X absence never halves the score).
    const events = organicTelegram(40, 120);
    const withX = computeSocialSnapshot({ events, at: AT, sources: [tg(), xDisabled], onchain: onchain() });
    const alone = computeSocialSnapshot({ events, at: AT, sources: [tg()], onchain: onchain() });
    expect(withX.socialScore).toBe(alone.socialScore);
    expect(withX.momentumScore).toBe(alone.momentumScore);
    expect(withX.dataQuality).toBe(alone.dataQuality);
    // Telegram has no likes / reposts: momentum is normalised over available components (not penalised for them).
    expect(alone.momentumScore!).toBeGreaterThan(50);
  });

  it('76. X off: zero X requests, DISABLED state, no error', async () => {
    const env = setup({ x: false });
    env.gateway!.addChat('zorbchat');
    await env.warmUp();
    env.advance(60_000);
    await env.service.tick();
    expect(env.xCalls()).toBe(0);
    expect(env.x.health()).toMatchObject({ state: 'DISABLED', enabled: false, requests: 0, errors: 0 });
  });

  it('77. Telegram off: no connection attempt, no request, DISABLED; X-only would still work', async () => {
    const gateway = new MockGateway();
    const env = setup({ telegram: false, gateway });
    await env.warmUp();
    expect(gateway.connectCalls).toBe(0);
    expect(gateway.historyCalls).toBe(0);
    expect(env.telegram.health()).toMatchObject({ state: 'DISABLED', enabled: false });
    const snapshot = env.service.assess(MINT, onchain())!;
    expect(snapshot.providersUnavailable).toEqual(expect.arrayContaining([{ source: 'TELEGRAM', reason: 'DISABLED' }]));
  });

  it('78. both off -> NO_PROVIDER; scores null / UNKNOWN (missing data is not negative evidence)', async () => {
    const env = setup({ telegram: false, x: false });
    await env.warmUp();
    expect(env.service.engineStatus()).toBe('NO_PROVIDER');
    expect(env.service.health().engineStatus).toBe('NO_PROVIDER');
    expect(env.service.assess(MINT, onchain())).toMatchObject({ socialScore: null, momentumScore: null, confirmation: 'UNKNOWN', shadowDecision: 'UNKNOWN' });
    // Enabled but credentials missing (no gateway) -> NOT_CONFIGURED, no crash.
    const missing = new TelegramSocialProvider({ enabled: true, gateway: null });
    expect(missing.health()).toMatchObject({ state: 'NOT_CONFIGURED', configured: false });
  });

  it('79. disconnect: data marked unavailable, reconnect with back-off, reconnect counted', async () => {
    const env = setup();
    env.gateway!.addChat('zorbchat');
    env.gateway!.push('zorbchat', { senderId: 'a', text: 'gm', date: T0 - 10_000 });
    await env.warmUp();
    expect(env.telegram.health().state).toBe('CONNECTED');
    env.gateway!.connected = false;
    env.gateway!.failConnect = true;
    env.advance(1_000);
    await env.service.tick();
    expect(env.telegram.health().state).toBe('DISCONNECTED');
    expect(env.service.assess(MINT, onchain())!.sources.find((source) => source.source === 'TELEGRAM')).toMatchObject({ available: false, reason: 'DISCONNECTED' });
    const attempts = env.gateway!.connectCalls;
    await env.service.tick();
    expect(env.gateway!.connectCalls).toBe(attempts); // back-off: no immediate retry
    env.gateway!.failConnect = false;
    env.advance(11_000);
    await env.service.tick();
    expect(env.telegram.health()).toMatchObject({ state: 'CONNECTED' });
    expect(env.telegram.health().details?.reconnects).toBe(1);
  });

  it('80. FLOOD_WAIT: RATE_LIMITED, no request until it expires, then resumes', async () => {
    const env = setup();
    env.gateway!.addChat('zorbchat');
    await env.warmUp();
    env.gateway!.floodOnNextHistory = 30;
    env.advance(16_000);
    await env.service.tick();
    expect(env.telegram.health()).toMatchObject({ state: 'RATE_LIMITED', rateLimitEvents: 1 });
    const calls = env.gateway!.historyCalls;
    env.advance(16_000);
    await env.service.tick();
    expect(env.gateway!.historyCalls).toBe(calls);
    env.advance(16_000);
    await env.service.tick();
    expect(env.gateway!.historyCalls).toBeGreaterThan(calls);
    expect(env.telegram.health().state).toBe('CONNECTED');
  });

  it('81. duplicate message (re-delivery / restart) is counted once by its stable id', async () => {
    const env = setup();
    env.gateway!.addChat('zorbchat');
    env.gateway!.push('zorbchat', { senderId: 'a', text: 'first', date: T0 - 5_000 });
    await env.warmUp();
    const post = { id: 'tg:100:1', source: 'TELEGRAM' as const, authorId: hashTelegramSender('a', '100'), text: 'first', createdAt: T0 - 5_000, receivedAt: T0, officialSource: true };
    env.service.ingest(MINT, [post, post]);
    const snapshot = env.service.assess(MINT, onchain())!;
    expect(snapshot.windows['5m']?.mentions).toBe(1);
    expect(env.service.health().messages.TELEGRAM?.duplicates).toBe(2);
    // Sender ids are hashed: the raw Telegram user id is never stored.
    expect(post.authorId).not.toContain('a:');
    expect(hashTelegramSender('a', '1')).toBe(hashTelegramSender('a', '2'));
  });

  it('82. 100 messages from 3 users vs 100 messages from 70 users: concentration -> lower quality, higher spam', () => {
    const concentrated = computeSocialSnapshot({ events: organicTelegram(3, 100), at: AT, sources: [tg(), xDisabled], onchain: onchain() });
    const spread = computeSocialSnapshot({ events: organicTelegram(70, 100), at: AT, sources: [tg(), xDisabled], onchain: onchain() });
    expect(spread.qualityScore!).toBeGreaterThan(concentrated.qualityScore! + 20);
    expect(concentrated.spamScore!).toBeGreaterThan(spread.spamScore!);
    expect(concentrated.perSource.TELEGRAM?.top3UserShare).toBeCloseTo(1, 5);
    expect(spread.perSource.TELEGRAM?.uniqueActiveUsers['5m']).toBe(70);
  });

  it('83. shill burst: 200 near-identical messages from 5 accounts in a minute -> high spam, never a positive confirmation', () => {
    const burst = Array.from({ length: 200 }, (_, index) => tgEvent(index % 60, `s${index % 5}`, `BUY NOW 100x 🚀 join https://t.me/zorbchat ${index % 7}`));
    const snapshot = computeSocialSnapshot({ events: burst, at: AT, sources: [tg(), xDisabled], onchain: onchain() });
    expect(snapshot.spamScore!).toBeGreaterThanOrEqual(60);
    expect(snapshot.qualityScore!).toBeLessThan(40);
    expect(['WARNING', 'AVOID']).toContain(snapshot.shadowDecision);
    expect(snapshot.confirmation).not.toBe('STRONG_CONFIRMATION');
  });

  it('84. Telegram hype without on-chain confirmation -> SOCIAL_ONLY_HYPE', () => {
    const snapshot = computeSocialSnapshot({ events: organicTelegram(60, 150), at: AT, sources: [tg(), xDisabled], onchain: onchain({ launchMomentumScore: 10, buySellRatio: 0.9, buyerTrend: 'STABLE' }) });
    expect(snapshot.confirmation).toBe('SOCIAL_ONLY_HYPE');
    expect(['WARNING', 'AVOID']).toContain(snapshot.shadowDecision);
    // Accelerating Telegram while on-chain buyers fade is a divergence (warning), not confirmation.
    const diverging = computeSocialSnapshot({ events: organicTelegram(60, 150), at: AT, sources: [tg(), xDisabled], onchain: onchain({ launchMomentumScore: 10, buyerTrend: 'DECELERATING' }) });
    expect(diverging.confirmation).toBe('DIVERGENCE');
  });

  it('85. Telegram + on-chain together -> confirmation; Telegram accelerating ahead of on-chain -> TELEGRAM_LEADING', () => {
    const confirmed = computeSocialSnapshot({ events: organicTelegram(60, 150), at: AT, sources: [tg(), xDisabled], onchain: onchain({ launchMomentumScore: 80 }) });
    expect(['STRONG_CONFIRMATION', 'MODERATE_CONFIRMATION']).toContain(confirmed.confirmation);
    // Liquidity draining blocks STRONG.
    const draining = computeSocialSnapshot({ events: organicTelegram(60, 150), at: AT, sources: [tg(), xDisabled], onchain: onchain({ launchMomentumScore: 80, liquidityChangePercent: -30 }) });
    expect(draining.confirmation).not.toBe('STRONG_CONFIRMATION');
    const leading = computeSocialSnapshot({ events: organicTelegram(60, 150), at: AT, sources: [tg(), xDisabled], onchain: onchain({ launchMomentumScore: 40, buySellRatio: 1.1, buyerTrend: 'STABLE' }) });
    expect(leading.confirmation).toBe('TELEGRAM_LEADING');
  });

  it('86. no lookahead: messages after the scoring time (or received later) are ignored', () => {
    const past = organicTelegram(30, 60);
    const future = [tgEvent(-30, 'late1', 'from the future'), { ...tgEvent(10, 'late2', 'created before, received after'), receivedAt: AT + 5_000 }];
    const a = computeSocialSnapshot({ events: past, at: AT, sources: [tg()], onchain: onchain() });
    const b = computeSocialSnapshot({ events: [...past, ...future], at: AT, sources: [tg()], onchain: onchain() });
    expect(b.windows['5m']?.mentions).toBe(a.windows['5m']?.mentions);
    expect(b.socialScore).toBe(a.socialScore);
  });

  it('87. MONITOR_ONLY: Telegram data never changes BUY (only ENFORCE_PAPER + AVOID could remove one; Telegram never adds one)', () => {
    for (const shadowDecision of ['POSITIVE_CONFIRMATION', 'NEUTRAL', 'WARNING', 'AVOID', 'UNKNOWN'] as const) {
      expect(socialBlocksEntry({ decision: 'BUY', mode: 'MONITOR_ONLY', shadowDecision })).toBe(false);
      expect(socialBlocksEntry({ decision: 'REJECT', mode: 'ENFORCE_PAPER', shadowDecision })).toBe(false);
    }
  });

  it('88. secrets and access: no credential in health / errors; private invite links are never resolved; channel-only = member data only', async () => {
    const env = setup({ official: null });
    const serialized = JSON.stringify(env.telegram.health());
    expect(serialized).not.toMatch(/session|apiHash|api_hash|bearer/i);
    expect(sanitizeTelegramError(new Error('failed with 1BAAOMTQ5LjE1NC4xNjcuNTAAUBsdkjfhskdjfhskdjfhskjdfhksjdhfksjdhf'))).toContain('[redacted]');
    // Private invite links have no public username: identity keeps no Telegram handle -> nothing to resolve or join.
    expect(identityFromMetadata(MINT, null, null, { telegram: 'https://t.me/+AbCdEfGhIjK' }).officialTelegram).toBeNull();
    expect(identityFromMetadata(MINT, null, null, { telegram: 'https://t.me/joinchat/AbCdEf' }).officialTelegram).toBeNull();

    // Broadcast channel: announcements are not community activity -> no message coverage, but member samples.
    const channel = setup({ official: 'zorbnews' });
    channel.gateway!.addChat('zorbnews', 'CHANNEL', 1_000);
    channel.gateway!.push('zorbnews', { senderId: 'admin', text: 'listing soon', date: T0 - 5_000 });
    await channel.warmUp();
    const snapshot = channel.service.assess(MINT, onchain())!;
    expect(snapshot.sources.find((source) => source.source === 'TELEGRAM')).toMatchObject({ available: false, reason: 'NO_SOURCE_FOUND' });
    expect(snapshot.members.count).toBe(1_000);
    expect(channel.telegram.health().details?.announcementsSkipped).toBe(1);
  });

  it('subscriptions: two tokens sharing one chat use one buffer (one history call); release frees it (no leaks)', async () => {
    const gateway = new MockGateway();
    gateway.addChat('shared');
    gateway.push('shared', { senderId: 'a', text: `${MINT} and ${MINT.replace('1111', '2222')}`, date: T0 - 1_000 });
    let now = T0;
    const provider = new TelegramSocialProvider({ enabled: true, gateway, now: () => now, globalSearchPerMinute: 0 });
    await provider.maintain();
    const idA = { mint: MINT, symbol: null, name: null, officialX: null, officialTelegram: 'shared', website: null };
    const idB = { ...idA, mint: MINT.replace('1111', '2222') };
    const a = await provider.fetchRecent(idA);
    const b = await provider.fetchRecent(idB);
    expect(gateway.historyCalls).toBe(1);
    expect(a?.posts).toHaveLength(1);
    expect(b?.posts).toHaveLength(1);
    expect(provider.health().details?.sourcesMonitored).toBe(1);
    provider.release(idA.mint);
    expect(provider.health().details?.sourcesMonitored).toBe(1);
    provider.release(idB.mint);
    expect(provider.health().details?.sourcesMonitored).toBe(0);
    now += 1;
  });

  it('member growth is computed only from real samples; missing samples stay unknown', () => {
    const events = organicTelegram(20, 40);
    const withMembers = computeSocialSnapshot({ events, at: AT, sources: [tg()], onchain: onchain(), memberSamples: [{ t: AT - 300_000, count: 400 }, { t: AT - 60_000, count: 430 }, { t: AT, count: 450 }] });
    expect(withMembers.members).toMatchObject({ count: 450, growth1m: 20, growth5m: 50 });
    expect(withMembers.members.growth15m).toBeNull();
    const without = computeSocialSnapshot({ events, at: AT, sources: [tg()], onchain: onchain() });
    expect(without.members).toEqual({ count: null, growth1m: null, growth5m: null, growth15m: null });
  });
});
