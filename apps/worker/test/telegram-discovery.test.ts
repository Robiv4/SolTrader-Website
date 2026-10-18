/**
 * Telegram discovery + message collection + Community ML integration (mock MTProto gateway, mock DEX Screener; no
 * network, no Telegram session, no database).
 *
 *  - discovery order: pump.fun metadata link > verified DEX Screener link > exact-mint search; name / ticker never attach;
 *  - link validation (private invites never resolved), duplicates, search hit filtering, FLOOD_WAIT;
 *  - historical messages never count as fresh momentum; messages only reach the right token;
 *  - an accessible, verified group's fresh messages reach the ML-FEATURES-COMMUNITY-v1 features time-correctly.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildCommunityFeatureSnapshot, ML_COMMUNITY_FEATURE_SPECS, ML_COMMUNITY_FEATURE_VERSION, ML_FEATURE_SCHEMA, ML_FEATURE_VERSION, normalizeTelegramLink,
  type LaunchSecurity,
} from '@soltrader/strategy-engine';
import { describe, expect, it } from 'vitest';

import { CommunityService } from '../src/community/community-service.js';
import { DexScreenerClient } from '../src/community/dexscreener.js';
import { type FetchLike, HttpBudget } from '../src/community/http-budget.js';
import type { MetadataResult } from '../src/social/metadata.js';
import { SocialService } from '../src/social/social-service.js';
import {
  TelegramAccessError, TelegramFloodWait, TelegramSocialProvider,
  type TelegramChat, type TelegramGateway, type TelegramMessage, type TelegramSourceRecord,
} from '../src/social/telegram.js';

const MINT = 'ZorbMint11111111111111111111111111111111pump';
const OTHER = 'OthrMint22222222222222222222222222222222pump';
const T0 = Date.parse('2026-10-18T12:00:00Z');
const logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

class Gateway implements TelegramGateway {
  connected = true;
  resolveCalls: string[] = [];
  searchCalls: string[] = [];
  searchResult: Array<{ chat: TelegramChat; message: TelegramMessage }> = [];
  floodOnSearch: number | null = null;
  chats = new Map<string, { chat: TelegramChat; messages: TelegramMessage[] }>();

  addChat(username: string, type: TelegramChat['type'] = 'SUPERGROUP') {
    this.chats.set(username, { chat: { id: `${this.chats.size + 100}`, username, type, title: username }, messages: [] });
    return this.chats.get(username)!.chat;
  }

  push(username: string, message: Partial<TelegramMessage> & { senderId: string; text: string; date: number }) {
    const chat = this.chats.get(username)!;
    chat.messages.push({ id: chat.messages.length + 1, chatId: chat.chat.id, replyToId: null, forwarded: false, forwards: null, views: null, ...message });
  }

  async connect() { this.connected = true; }
  async disconnect() { this.connected = false; }
  isConnected() { return this.connected; }
  async resolve(username: string) {
    this.resolveCalls.push(username);
    const chat = this.chats.get(username);
    if (!chat) throw new TelegramAccessError('NOT_FOUND');
    return chat.chat;
  }
  async history(username: string, minId: number, limit: number) {
    return (this.chats.get(username)?.messages ?? []).filter((message) => message.id > minId).slice(-limit).reverse();
  }
  async memberCount() { return 1_000; }
  async searchGlobal(query: string) {
    this.searchCalls.push(query);
    if (this.floodOnSearch !== null) {
      const seconds = this.floodOnSearch;
      this.floodOnSearch = null;
      throw new TelegramFloodWait(seconds);
    }
    return this.searchResult;
  }
}

const meta = (telegram: string | null): MetadataResult => ({ status: 'RESOLVED', metadata: { telegram, twitter: null, website: null, name: 'Zorbulator', symbol: 'ZORB', image: null }, host: 'ipfs.filebase.io', attempts: 1 });

function setup(options: { telegram?: string | null; searchPerMinute?: number } = {}) {
  let now = T0;
  const gateway = new Gateway();
  const records: TelegramSourceRecord[] = [];
  const telegram = new TelegramSocialProvider({ enabled: true, gateway, now: () => now, globalSearchPerMinute: options.searchPerMinute ?? 0, onSource: (record) => records.push(record) });
  const service = new SocialService({
    prisma: { socialSnapshot: { create: async () => ({}) }, launchCandidate: { updateMany: async () => ({ count: 1 }) } } as never,
    providers: [telegram], logger, now: () => now,
    resolveMetadata: async () => meta(options.telegram === undefined ? 'https://t.me/ZorbChat' : options.telegram),
  });
  const tick = async () => {
    await service.tick();
    await new Promise((resolve) => globalThis.setTimeout(resolve, 5));
  };
  return { gateway, telegram, service, records, tick, now: () => now, advance: (ms: number) => { now += ms; } };
}

describe('Telegram link normalisation', () => {
  it('accepts public t.me / telegram.me / tg:// / @handle forms, rejects private, reserved, bots and other hosts', () => {
    for (const [input, username] of [
      ['https://t.me/ZorbChat', 'zorbchat'], ['http://telegram.me/zorbchat/123', 'zorbchat'], ['t.me/s/zorbchat', 'zorbchat'], ['www.t.me/zorbchat?start=1', 'zorbchat'],
      ['tg://resolve?domain=zorbchat', 'zorbchat'], ['@ZorbChat', 'zorbchat'], ['zorbchat', 'zorbchat'], ['https://telegram.dog/zorb_portal', 'zorb_portal'],
    ] as const) expect(normalizeTelegramLink(input), input).toEqual({ username, url: `https://t.me/${username}` });
    for (const [input, reason] of [
      ['https://t.me/+AbCdEf123', 'PRIVATE_INVITE'], ['https://t.me/joinchat/AAAA', 'PRIVATE_INVITE'], ['https://t.me/c/123/45', 'PRIVATE_INVITE'],
      ['https://t.me/addstickers/zorb', 'RESERVED_PATH'], ['https://t.me/share/url?url=x', 'RESERVED_PATH'], ['https://x.com/zorbchat', 'NOT_TELEGRAM'],
      ['https://zorb.xyz/telegram', 'NOT_TELEGRAM'], ['https://t.me/ab', 'INVALID_USERNAME'], ['https://t.me/zorb__chat', 'INVALID_USERNAME'], ['https://t.me/1zorbchat', 'INVALID_USERNAME'],
      ['https://t.me/zorbbuybot', 'BOT'], ['', 'EMPTY'], ['coming soon', 'INVALID_USERNAME'],
    ] as const) expect(normalizeTelegramLink(input), input).toEqual({ rejected: reason });
  });
});

describe('Telegram discovery', () => {
  it('1. official link from the mint metadata: OFFICIAL / OFFICIAL_SOCIAL_LINK / PUMP_FUN_METADATA, no search', async () => {
    const h = setup({ searchPerMinute: 5 });
    h.gateway.addChat('zorbchat');
    h.service.track({ mint: MINT, symbol: 'ZORB', name: 'Zorbulator', metadataUri: 'ipfs://x', stage: 3 });
    await h.tick();
    await h.tick();
    expect(h.records[0]).toMatchObject({ username: 'zorbchat', officialStatus: 'OFFICIAL', matchBasis: 'OFFICIAL_SOCIAL_LINK', via: 'PUMP_FUN_METADATA', accessStatus: 'ACCESSIBLE', active: true });
    expect(h.gateway.searchCalls).toEqual([]);
    expect(h.telegram.health().details).toMatchObject({ verifiedSources: 1, activeGroups: 1, accessibleByVia: { PUMP_FUN_METADATA: 1 } });
  });

  it('a private invite link is never resolved or joined; the token stays without a Telegram source', async () => {
    const h = setup({ telegram: 'https://t.me/+SecretInvite' });
    h.service.track({ mint: MINT, symbol: 'ZORB', name: 'Zorbulator', metadataUri: 'ipfs://x', stage: 3 });
    await h.tick();
    await h.tick();
    expect(h.gateway.resolveCalls).toEqual([]);
    expect(h.records).toEqual([]);
    expect(h.service.health().metadata.telegramLinkRejected).toEqual({ PRIVATE_INVITE: 1 });
  });

  it('2. verified DEX Screener link: PROBABLE_OFFICIAL / DEXSCREENER_LINK; duplicates and invalid links are dropped', async () => {
    const h = setup({ telegram: null });
    h.gateway.addChat('zorbdex');
    h.service.track({ mint: MINT, symbol: 'ZORB', name: 'Zorbulator', metadataUri: 'ipfs://x', stage: 3 });
    expect(h.service.addTelegramLink(MINT, 'https://t.me/ZorbDex', 'DEXSCREENER', T0)).toBe(true);
    expect(h.service.addTelegramLink(MINT, 'https://telegram.me/zorbdex', 'DEXSCREENER', T0)).toBe(false);
    expect(h.service.addTelegramLink(MINT, 'https://t.me/+private', 'DEXSCREENER', T0)).toBe(false);
    expect(h.service.addTelegramLink(OTHER, 'https://t.me/zorbdex', 'DEXSCREENER', T0)).toBe(false);
    await h.tick();
    await h.tick();
    expect(h.records).toHaveLength(1);
    expect(h.records[0]).toMatchObject({ username: 'zorbdex', officialStatus: 'PROBABLE_OFFICIAL', matchBasis: 'DEXSCREENER_LINK', via: 'DEXSCREENER', matchConfidence: 0.8 });
    expect(h.service.health().externalTelegramLinks).toEqual({ accepted: 1, rejected: { PRIVATE_INVITE: 1 } });
  });

  it('3. mint search only without a verified source; only public groups whose message has the exact mint; per-token limit', async () => {
    const h = setup({ telegram: null, searchPerMinute: 5 });
    const message = (chat: TelegramChat, text: string): { chat: TelegramChat; message: TelegramMessage } => ({ chat, message: { id: 1, chatId: chat.id, senderId: '1', text, date: T0, replyToId: null, forwarded: false, forwards: null, views: null } });
    const calls = h.gateway.addChat('callgroup');
    const calls2 = h.gateway.addChat('degenroom');
    const calls3 = h.gateway.addChat('thirdroom');
    const channel = h.gateway.addChat('pumpalerts', 'CHANNEL');
    const ticker = h.gateway.addChat('tickerroom');
    h.gateway.searchResult = [
      message(calls, `ape ${MINT} now`), message(calls2, `CA: ${MINT}`), message(calls3, `${MINT} 🚀`), message(channel, `new: ${MINT}`),
      message({ id: '9', username: null, type: 'SUPERGROUP', title: 'private' }, `${MINT}`), message(ticker, '$ZORB Zorbulator is next'),
    ];
    h.service.track({ mint: MINT, symbol: 'ZORB', name: 'Zorbulator', metadataUri: 'ipfs://x', stage: 3 });
    await h.tick();
    await h.tick();
    expect(h.gateway.searchCalls).toEqual([MINT]);
    expect(h.records.map((record) => record.username)).toEqual(['callgroup', 'degenroom']);
    expect(h.records.every((record) => record.officialStatus === 'COMMUNITY' && record.matchBasis === 'MINT_ADDRESS' && record.via === 'TELEGRAM_SEARCH')).toBe(true);
    expect(h.telegram.health().details).toMatchObject({ globalSearches: 1, searchesWithHits: 1, searchHits: 3, searchHitsRejected: { NO_EXACT_MINT: 1, NO_PUBLIC_USERNAME: 1, BROADCAST_CHANNEL: 1, PER_TOKEN_LIMIT: 1 } });
    // Repeat window: no second search for the same mint within 10 minutes.
    h.advance(60_000);
    await h.tick();
    expect(h.gateway.searchCalls).toHaveLength(1);
  });

  it('FLOOD_WAIT during search: no throw, RATE_LIMITED, no Telegram request until it expires', async () => {
    const h = setup({ telegram: null, searchPerMinute: 5 });
    h.gateway.floodOnSearch = 30;
    h.service.track({ mint: MINT, symbol: 'ZORB', name: 'Zorbulator', metadataUri: 'ipfs://x', stage: 3 });
    await h.tick();
    await expect(h.tick()).resolves.toBeUndefined();
    expect(h.telegram.health().state).toBe('RATE_LIMITED');
    h.service.track({ mint: OTHER, symbol: 'OTH', name: 'Other', metadataUri: 'ipfs://y', stage: 3 });
    h.advance(20_000);
    await h.tick();
    await h.tick();
    expect(h.gateway.searchCalls).toHaveLength(1);
    h.advance(15_000);
    await h.tick();
    expect(h.gateway.searchCalls.length).toBeGreaterThan(1);
  });
});

describe('Telegram messages: freshness and attribution', () => {
  it('years-old history is counted apart and never becomes momentum; fresh messages are counted', async () => {
    const h = setup();
    h.gateway.addChat('zorbchat');
    const old = Date.parse('2024-06-01T10:00:00Z');
    for (let index = 0; index < 20; index += 1) h.gateway.push('zorbchat', { senderId: `old${index}`, text: `gm ${index}`, date: old + index * 1000 });
    h.gateway.push('zorbchat', { senderId: 'u1', text: 'just bought, chart looks good', date: T0 - 60_000 });
    h.gateway.push('zorbchat', { senderId: 'u2', text: 'devs are active', date: T0 - 30_000, replyToId: 21 });
    h.service.track({ mint: MINT, symbol: 'ZORB', name: 'Zorbulator', metadataUri: 'ipfs://x', stage: 3 });
    await h.tick();
    await h.tick();
    expect(h.telegram.health().details).toMatchObject({ freshMessages: 2, historicalMessagesSkipped: 20, lastFreshMessageAt: new Date(T0 - 30_000).toISOString() });
    const snapshot = h.service.assessAt(MINT, T0)!;
    expect(snapshot.windows['5m']).toMatchObject({ mentions: 2, uniqueAuthors: 2 });
    expect(snapshot.windows['30m']!.mentions).toBe(2);
  });

  it('search-found groups: only messages with the exact mint count; messages reach only the token they belong to', async () => {
    const h = setup({ telegram: null, searchPerMinute: 5 });
    const group = h.gateway.addChat('callgroup');
    const hit = (mint: string) => ({ chat: group, message: { id: 1, chatId: group.id, senderId: '1', text: mint, date: T0, replyToId: null, forwarded: false, forwards: null, views: null } });
    h.gateway.searchResult = [hit(MINT), hit(OTHER)];
    h.gateway.push('callgroup', { senderId: 'a', text: `buy ${MINT}`, date: T0 - 20_000 });
    h.gateway.push('callgroup', { senderId: 'b', text: '$ZORB Zorbulator looks strong', date: T0 - 15_000 });
    h.gateway.push('callgroup', { senderId: 'c', text: `other one ${OTHER}`, date: T0 - 10_000 });
    h.service.track({ mint: MINT, symbol: 'ZORB', name: 'Zorbulator', metadataUri: 'ipfs://x', stage: 3 });
    h.service.track({ mint: OTHER, symbol: 'OTH', name: 'Other', metadataUri: 'ipfs://y', stage: 3 });
    await h.tick();
    await h.tick();
    expect(h.service.assessAt(MINT, T0)!.windows['5m']!.mentions).toBe(1);
    expect(h.service.assessAt(OTHER, T0)!.windows['5m']!.mentions).toBe(1);
    expect(h.service.health().messages.TELEGRAM).toMatchObject({ processed: 2 });
  });
});

const security: LaunchSecurity = { sellability: 'VERIFIED', mintAuthorityRevoked: true, freezeAuthorityRevoked: true, tokenProgram: 'spl-token', extensions: [], hardBlockReasons: [], warnings: [] };
function baseSnapshotInput(at: number) {
  const observations = Array.from({ length: 10 }, (_, i) => ({ takenAt: at - 30_000 + i * 3_000, priceUsd: 0.00001, liquidityUsd: 30_000, buyCount: 3 + i, sellCount: 1, volumeUsd: 100 + i * 40, buyVolumeUsd: 80, sellVolumeUsd: 20, uniqueBuyers: 2 + i, uniqueSellers: 1 }));
  const state = { mint: MINT, detectedAt: at - 30_000, createdAt: at - 31_000, observations, largestBuyerShare: 0.1, buysPerBuyer: 1.2, creatorSoldRatio: 0, largestHolderSupplyShare: 0.04, priceImpactPercent: 1, observedSellers: 3 };
  return { snapshotAt: at, source: 'PUMP_FUN', detectedAt: at - 30_000, createdAt: at - 31_000, firstTradeAt: at - 29_000, state, security, securityObservedAt: at - 5_000, riskScore: 40, riskObservedAt: at, social: null, referenceImpactPct: 1 };
}

describe('verified group -> Community ML features (end to end, time-correct)', () => {
  it('fresh messages of an accessible official group fill the Telegram community features; later messages never leak back', async () => {
    const h = setup();
    h.gateway.addChat('zorbchat');
    h.gateway.push('zorbchat', { senderId: 'old', text: 'ancient', date: Date.parse('2024-06-01T10:00:00Z') });
    const authors = ['a', 'b', 'c', 'd', 'a', 'e'];
    authors.forEach((author, index) => h.gateway.push('zorbchat', { senderId: author, text: `msg ${index} about the project`, date: T0 - 120_000 + index * 15_000, replyToId: index % 2 ? index : null, forwarded: index === 5 }));
    h.service.track({ mint: MINT, symbol: 'ZORB', name: 'Zorbulator', metadataUri: 'ipfs://x', stage: 3 });
    const before = h.now();
    await h.tick();
    await h.tick();
    const received = h.now();
    // Community service reads the research collection itself (no user social settings involved).
    const community = new CommunityService({ logger, onchainEnabled: false, dex: null, lunar: null, now: h.now, social: { assessAt: (mint, at) => h.service.assessAt(mint, at) } });
    community.track(MINT, 3);
    const result = community.assess(MINT, null, received)!;
    expect(result.sources.TELEGRAM.status).toBe('OK');
    const snapshot = buildCommunityFeatureSnapshot({ ...baseSnapshotInput(received), community: result });
    expect(snapshot.featureVersion).toBe(ML_COMMUNITY_FEATURE_VERSION);
    expect(snapshot.validForTraining).toBe(true);
    expect(snapshot.lateDataExcluded).not.toContain('COMMUNITY');
    expect(snapshot.features).toMatchObject({ mentions5m: 6, uniqueAuthors5m: 5, telegramReplyShare: 0.5 });
    expect(snapshot.features.telegramForwardedShare).toBeCloseTo(1 / 6, 3);
    expect(snapshot.features.telegramConversationRatio).toBeCloseTo(5 / 6, 3);
    expect(snapshot.features.socialMomentum).not.toBeNull();
    expect(snapshot.features.socialSpamScore).not.toBeNull();
    expect(snapshot.features.organicInterestScore).not.toBeNull();
    // Messages created later than the snapshot moment are not in it, even after they were received.
    h.gateway.push('zorbchat', { senderId: 'late', text: 'late message', date: received + 20_000 });
    h.advance(30_000);
    await h.tick();
    const again = community.assess(MINT, null, received)!;
    expect(again.features.mentions5m).toBe(6);
    // A moment before the messages were received: no Telegram data at all (missing, not zero).
    const early = community.assess(MINT, null, before - 60_000)!;
    expect(early.sources.TELEGRAM.status).not.toBe('OK');
    expect(early.features.mentions5m).toBeNull();
  });

  it('no Telegram source: Telegram features are null, never 0', () => {
    const community = new CommunityService({ logger, onchainEnabled: false, dex: null, lunar: null, social: { assessAt: () => null } });
    community.track(MINT, 3);
    const result = community.assess(MINT, null, T0)!;
    for (const name of ['mentions5m', 'uniqueAuthors5m', 'socialMomentum', 'socialSpamScore', 'communityGrowth', 'telegramConversationRatio', 'telegramForwardedShare', 'telegramReplyShare', 'socialOnchainDivergence'] as const) expect(result.features[name], name).toBeNull();
  });
});

describe('DEX Screener -> Telegram discovery hand-over', () => {
  const budget = (fetch: FetchLike) => new HttpBudget({ source: 'DEXSCREENER', enabled: true, configured: true, perMinute: 10, timeoutMs: 1_000, backoffBaseMs: 1_000, backoffMaxMs: 10_000, fetch, now: () => T0 });
  const response = (body: unknown) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => body });
  const pair = (base: string, quote: string) => ({ dexId: 'pumpswap', baseToken: { address: base }, quoteToken: { address: quote }, liquidity: { usd: 9_000 }, info: { socials: [{ type: 'telegram', url: 'https://t.me/ZorbDex' }] } });

  it('only an identity-confirmed profile (pair base token = mint) forwards its Telegram link', async () => {
    const forwarded: Array<[string, string[]]> = [];
    const run = async (pairs: unknown[]) => {
      const http = budget(async () => response(pairs));
      const community = new CommunityService({ logger, onchainEnabled: false, now: () => T0, lunar: null, dex: { http, client: new DexScreenerClient(http), cacheTtlMs: 0 }, onTelegramLinks: (mint, links) => forwarded.push([mint, links]) });
      community.track(MINT, 3);
      await community.tick();
    };
    await run([pair('SomeOtherBase', MINT)]);
    expect(forwarded).toEqual([]);
    await run([pair(MINT, 'So11111111111111111111111111111111111111112')]);
    expect(forwarded).toEqual([[MINT, ['https://t.me/ZorbDex']]]);
  });
});

describe('ML feature schema compatibility', () => {
  it('community schema = v1 schema + the documented COMMUNITY features (names unchanged, exported JSON identical)', () => {
    expect(ML_FEATURE_VERSION).toBe('ML-FEATURES-v1');
    const here = path.dirname(fileURLToPath(import.meta.url));
    const exported = JSON.parse(readFileSync(path.join(here, '..', '..', '..', 'ml', 'schema', 'features-community-v1.json'), 'utf8')) as { featureVersion: string; features: Array<{ name: string }> };
    expect(exported.featureVersion).toBe(ML_COMMUNITY_FEATURE_VERSION);
    expect(exported.features.map((spec) => spec.name)).toEqual([...ML_FEATURE_SCHEMA, ...ML_COMMUNITY_FEATURE_SPECS].map((spec) => spec.name));
    for (const name of ['socialMomentum', 'socialSpamScore', 'mentions5m', 'uniqueAuthors5m', 'communityGrowth', 'telegramConversationRatio', 'telegramForwardedShare', 'telegramReplyShare', 'organicInterestScore', 'socialOnchainDivergence']) {
      expect(ML_COMMUNITY_FEATURE_SPECS.some((spec) => spec.name === name), name).toBe(true);
    }
  });
});
