import { socialBlocksEntry } from '@soltrader/strategy-engine';
import { describe, expect, it } from 'vitest';

import { safeMetadataUrl } from '../src/social/metadata.js';
import { MockSocialProvider, XSocialProvider } from '../src/social/providers.js';
import { inRejectedSample, SocialService } from '../src/social/social-service.js';
import { TelegramSocialProvider } from '../src/social/telegram.js';

const MINT = 'So1aNaMint1111111111111111111111111111111pump';
const onchain = { launchScore: 80, launchMomentumScore: 70, exhaustionScore: 20, buySellRatio: 2, uniqueBuyers: 40, buyerTrend: 'ACCELERATING' as const, liquidityChangePercent: 10, priceVelocity: 1, priceExtensionPercent: 20 };
const prisma = () => {
  const snapshots: unknown[] = [];
  return { snapshots, client: { socialSnapshot: { create: async (args: { data: unknown }) => { snapshots.push(args.data); return args.data; } }, launchCandidate: { updateMany: async () => ({ count: 1 }) } } as never };
};
const logger = { info: () => undefined, warn: () => undefined };

describe('social collection service', () => {
  it('metadata fetching is restricted to public IPFS / Arweave gateways over https (SSRF protection)', () => {
    const cid = 'QmZWEuvDH5HJLfrria691TTk8GzsoC6A3h77wLudahR24Z';
    // ipfs.io (public path gateway retired: HTTP 429 on every request) is rewritten to a working gateway by CID.
    expect(safeMetadataUrl(`https://ipfs.io/ipfs/${cid}`)).toBe(`https://ipfs.filebase.io/ipfs/${cid}`);
    expect(safeMetadataUrl(`ipfs://${cid}`)).toBe(`https://ipfs.filebase.io/ipfs/${cid}`);
    expect(safeMetadataUrl('https://ipfs.io/ipfs/QmAbc')).toBeNull();
    expect(safeMetadataUrl('http://ipfs.io/ipfs/QmAbc')).toBeNull();
    expect(safeMetadataUrl('https://localhost/x')).toBeNull();
    expect(safeMetadataUrl('https://169.254.169.254/latest/meta-data')).toBeNull();
    expect(safeMetadataUrl('https://evil.example.com/meta.json')).toBeNull();
    expect(safeMetadataUrl('https://user:pass@ipfs.io/ipfs/x')).toBeNull();
  });

  it('X without a bearer token is NOT_CONFIGURED and makes no request; budget and 429 back-off are respected', async () => {
    let calls = 0;
    const unconfigured = new XSocialProvider({ bearerToken: null, maxRequestsPer15Min: 10, fetch: async () => { calls += 1; throw new Error('no'); } });
    expect(await unconfigured.fetchRecent({ mint: MINT, symbol: 'Z', name: 'Z', officialX: null, officialTelegram: null, website: null }, null)).toBeNull();
    expect(unconfigured.health().state).toBe('NOT_CONFIGURED');
    expect(calls).toBe(0);
    const limited = new XSocialProvider({ bearerToken: 'test-token', maxRequestsPer15Min: 1, fetch: async () => { calls += 1; return { ok: false, status: 429, headers: { get: () => String(Math.floor(Date.now() / 1000) + 60) }, json: async () => ({}) }; } });
    const identity = { mint: MINT, symbol: 'Z', name: 'Z', officialX: 'zorb', officialTelegram: null, website: null };
    expect(await limited.fetchRecent(identity, null)).toBeNull();
    expect(limited.health()).toMatchObject({ state: 'RATE_LIMITED', rateLimitEvents: 1 });
    expect(await limited.fetchRecent(identity, null)).toBeNull();
    expect(calls).toBe(1);
    // The query never searches a bare ticker.
    expect(XSocialProvider.query(identity)).not.toMatch(/\$Z\b/);
    expect(XSocialProvider.query(identity)).toContain(MINT);
  });

  it('collects, attributes and scores (deterministic, AI off); unrelated posts are dropped, ticker-only kept as ambiguous', async () => {
    const x = new MockSocialProvider('X');
    const db = prisma();
    let now = Date.parse('2026-10-02T12:00:00Z');
    const service = new SocialService({ prisma: db.client, providers: [x], logger, fetchMetadata: async () => ({ twitter: 'https://x.com/zorbulator', telegram: null, website: null, name: 'Zorbulator', symbol: 'ZORB' }), now: () => now });
    service.track({ mint: MINT, symbol: 'ZORB', name: 'Zorbulator', metadataUri: 'https://ipfs.io/ipfs/Qm', stage: 3 });
    await service.tick();
    await new Promise((resolve) => globalThis.setTimeout(resolve, 5));
    expect(service.identity(MINT)?.officialX).toBe('zorbulator');
    for (let index = 0; index < 30; index += 1) x.posts.push({ id: `p${index}`, source: 'X', authorId: `a${index}`, text: `chart of ${MINT} looks fine ${index}`, createdAt: now - 60_000 + index * 1_000, receivedAt: now, likes: 2, reposts: 0, replies: 1 });
    x.posts.push({ id: 'cat', source: 'X', authorId: 'c', text: 'buying $ZORB lol', createdAt: now - 1_000, receivedAt: now, likes: 0 });
    x.posts.push({ id: 'unrelated', source: 'X', authorId: 'u', text: 'weather is nice', createdAt: now - 1_000, receivedAt: now });
    now += 16_000;
    await service.tick();
    const snapshot = service.assess(MINT, onchain)!;
    expect(snapshot.windows['5m']!.mentions).toBe(30);
    expect(snapshot.ambiguousMentions5m).toBe(1);
    expect(snapshot.momentumScore).not.toBeNull();
    expect(snapshot.dataQuality).not.toBeNull();
    expect(db.snapshots.length).toBeGreaterThanOrEqual(1);
  });

  it('provider failure: X down + Telegram alive -> partial; all down -> UNKNOWN; nothing throws', async () => {
    const x = new MockSocialProvider('X');
    x.failing = true;
    const tg = new TelegramSocialProvider({ enabled: true, gateway: null, inbox: { popMany: async () => [JSON.stringify({ chatId: '1', chatUsername: 'zorbchat', messageId: 1, authorId: 'h1', text: 'gm', createdAt: Date.now() - 1_000, receivedAt: Date.now() })] } });
    const service = new SocialService({ prisma: prisma().client, providers: [x, tg], logger, fetchMetadata: async () => ({ twitter: null, telegram: 'https://t.me/zorbchat', website: null, name: null, symbol: null }) });
    service.track({ mint: MINT, symbol: 'ZORB', name: 'Zorbulator', metadataUri: null, stage: 3 });
    await service.tick();
    await new Promise((resolve) => globalThis.setTimeout(resolve, 5));
    await service.tick();
    const partial = service.assess(MINT, onchain)!;
    expect(partial.sources.find((source) => source.source === 'TELEGRAM')?.available).toBe(true);
    expect(partial.sources.find((source) => source.source === 'X')?.available).toBe(false);

    const none = new SocialService({ prisma: prisma().client, providers: [new XSocialProvider({ bearerToken: null, maxRequestsPer15Min: 1 }), new TelegramSocialProvider({ enabled: false, gateway: null })], logger, fetchMetadata: async () => null });
    none.track({ mint: MINT, symbol: 'ZORB', name: null, metadataUri: null, stage: 3 });
    await none.tick();
    expect(none.assess(MINT, onchain)).toMatchObject({ socialScore: null, confirmation: 'UNKNOWN', shadowDecision: 'UNKNOWN' });
  });

  it('rejected-candidate sampling is deterministic (~10%)', () => {
    const sample = Array.from({ length: 2_000 }, (_, index) => inRejectedSample(`mint${index}abcdef`)).filter(Boolean).length;
    expect(sample).toBeGreaterThan(120);
    expect(sample).toBeLessThan(280);
    expect(inRejectedSample('fixed-mint')).toBe(inRejectedSample('fixed-mint'));
  });

  it('MONITOR_ONLY never changes a NewLaunch decision, whatever the social score (only ENFORCE_PAPER + AVOID removes a BUY)', () => {
    for (const shadowDecision of ['POSITIVE_CONFIRMATION', 'NEUTRAL', 'WARNING', 'AVOID', 'UNKNOWN'] as const) {
      expect(socialBlocksEntry({ decision: 'BUY', mode: 'MONITOR_ONLY', shadowDecision })).toBe(false);
      expect(socialBlocksEntry({ decision: 'BUY', mode: 'OFF', shadowDecision })).toBe(false);
      // Social can never turn a REJECT / WATCH into a BUY.
      expect(socialBlocksEntry({ decision: 'REJECT', mode: 'ENFORCE_PAPER', shadowDecision })).toBe(false);
    }
    expect(socialBlocksEntry({ decision: 'BUY', mode: 'ENFORCE_PAPER', shadowDecision: 'AVOID' })).toBe(true);
    expect(socialBlocksEntry({ decision: 'BUY', mode: 'ENFORCE_PAPER', shadowDecision: 'POSITIVE_CONFIRMATION' })).toBe(false);
  });
});
