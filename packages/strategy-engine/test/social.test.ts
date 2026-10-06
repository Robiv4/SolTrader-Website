import { describe, expect, it } from 'vitest';

import {
  computeSocialSnapshot, confirmSocialOnchain, disabledAISocialAnalyzer, duplicateStats, identityFromMetadata, matchSocialText, safeAISocialAnalysis,
  type OnchainContext, type SocialEvent, type SourceStatus,
} from '../src/social/index.js';

const MINT = 'So1aNaMint1111111111111111111111111111111pump';
const AT = Date.parse('2026-10-02T12:00:30Z');
const identity = identityFromMetadata(MINT, 'ZORB', 'Zorbulator', { twitter: 'https://x.com/zorbulator', telegram: 'https://t.me/zorbchat', website: 'https://zorb.fun' });
const xSource = (coverageStart = AT - 3_600_000, available = true): SourceStatus => ({ source: 'X', available, state: available ? 'ACTIVE' : 'UNAVAILABLE', coverageStart, lastSuccessAt: available ? AT - 5_000 : null });
const tgSource = (available = true): SourceStatus => ({ source: 'TELEGRAM', available, state: available ? 'ACTIVE' : 'UNAVAILABLE', coverageStart: AT - 3_600_000, lastSuccessAt: available ? AT - 5_000 : null });
const onchain = (overrides: Partial<OnchainContext> = {}): OnchainContext => ({ launchScore: 80, launchMomentumScore: 70, exhaustionScore: 20, buySellRatio: 2, uniqueBuyers: 40, buyerTrend: 'ACCELERATING', liquidityChangePercent: 20, priceVelocity: 1, priceExtensionPercent: 30, ...overrides });

let sequence = 0;
function event(secondsAgo: number, author: string, text: string, overrides: Partial<SocialEvent> = {}): SocialEvent {
  const createdAt = AT - secondsAgo * 1000;
  const match = matchSocialText(identity, text);
  sequence += 1;
  return { id: `e${sequence}`, source: 'X', authorId: author, text, createdAt, receivedAt: createdAt + 500, likes: 3, reposts: 1, replies: 1, matchBasis: match.basis, matchConfidence: match.confidence, ...overrides };
}

/** Organic: rate rising over time, many authors, varied texts mentioning the mint. */
function organicEvents() {
  const events: SocialEvent[] = [];
  const phrases = ['looking at the chart of', 'interesting launch', 'who is holding', 'team seems active on', 'liquidity growing on', 'nice community around', 'early holders of', 'reading the site of', 'anyone checked', 'dev replied about'];
  for (let minute = 4; minute >= 0; minute -= 1) {
    const perMinute = minute === 0 ? 24 : minute === 1 ? 10 : 4;
    for (let index = 0; index < perMinute; index += 1) events.push(event(minute * 60 + (index * 59) / perMinute, `a${minute}-${index}`, `${phrases[(index + minute) % phrases.length]} ${MINT} ${index % 3 ? 'thoughts?' : ''} #${minute}${index}`));
  }
  return events;
}

describe('social intelligence (deterministic, no AI)', () => {
  it('organic growth: rising mentions + authors, low duplicates, buyers rising -> high momentum / quality, positive confirmation', () => {
    const snapshot = computeSocialSnapshot({ events: organicEvents(), at: AT, sources: [xSource()], onchain: onchain() });
    expect(snapshot.mentionTrend).toBe('ACCELERATING');
    expect(snapshot.momentumScore!).toBeGreaterThanOrEqual(60);
    expect(snapshot.qualityScore!).toBeGreaterThanOrEqual(60);
    expect(snapshot.spamScore!).toBeLessThan(40);
    expect(['STRONG_CONFIRMATION', 'MODERATE_CONFIRMATION']).toContain(snapshot.confirmation);
    expect(snapshot.shadowDecision).toBe('POSITIVE_CONFIRMATION');
    expect(snapshot.reasons).toEqual(expect.arrayContaining(['mentions accelerating']));
  });

  it('spam burst: 200 messages, 5 authors, ~85% duplicates -> high activity but high spam and low quality, never strong confirmation', () => {
    const events: SocialEvent[] = [];
    for (let index = 0; index < 200; index += 1) {
      const text = index % 7 === 0 ? `different words number ${index} about ${MINT}` : `🚀🚀 BUY ${MINT} NOW!!! 100x gem don't miss https://pump.fun/${MINT} 🚀`;
      events.push(event(280 - index * 1.4, `bot${index % 5}`, text));
    }
    const snapshot = computeSocialSnapshot({ events, at: AT, sources: [xSource()], onchain: onchain() });
    expect(snapshot.windows['5m']!.mentions).toBe(200);
    expect(snapshot.windows['5m']!.duplicateRatio!).toBeGreaterThan(0.8);
    expect(snapshot.spamScore!).toBeGreaterThanOrEqual(70);
    expect(snapshot.qualityScore!).toBeLessThan(40);
    expect(snapshot.confirmation).not.toBe('STRONG_CONFIRMATION');
    expect(snapshot.shadowDecision).toBe('AVOID');
    expect(snapshot.warnings.join(' ')).toMatch(/duplicate content/);
  });

  it('social hype without on-chain -> SOCIAL_ONLY_HYPE', () => {
    const snapshot = computeSocialSnapshot({ events: organicEvents(), at: AT, sources: [xSource()], onchain: onchain({ launchMomentumScore: 20, buyerTrend: 'STABLE', buySellRatio: 1 }) });
    expect(snapshot.confirmation).toBe('SOCIAL_ONLY_HYPE');
    expect(['WARNING', 'AVOID']).toContain(snapshot.shadowDecision);
  });

  it('on-chain without social -> ONCHAIN_LEADING (not rejected)', () => {
    const snapshot = computeSocialSnapshot({ events: [event(100, 'a', `one post about ${MINT}`)], at: AT, sources: [xSource()], onchain: onchain({ launchMomentumScore: 80 }) });
    expect(snapshot.confirmation).toBe('ONCHAIN_LEADING');
    expect(snapshot.shadowDecision).toBe('NEUTRAL');
  });

  it('ambiguous ticker: many "$ZORB"-style generic mentions without mint / link are not attributed', () => {
    const cat = identityFromMetadata(MINT, 'CAT', 'Cat', null);
    const match = matchSocialText(cat, 'buying more $CAT today');
    expect(match).toMatchObject({ basis: 'TICKER', ambiguous: true });
    expect(match.confidence).toBeLessThan(0.5);
    const ambiguousEvents = Array.from({ length: 50 }, (_, index) => ({ ...event(100 - index, `u${index}`, '$CAT to the moon'), matchBasis: 'TICKER' as const, matchConfidence: 0.1 }));
    const snapshot = computeSocialSnapshot({ events: ambiguousEvents, ambiguousEvents, at: AT, sources: [xSource()], onchain: onchain() });
    expect(snapshot.windows['5m']!.mentions).toBe(0);
    expect(snapshot.warnings.join(' ')).toMatch(/AMBIGUOUS_TOKEN_MATCH/);
    expect(matchSocialText(identity, `chart for ${MINT}`)).toMatchObject({ basis: 'MINT_ADDRESS', confidence: 1 });
    expect(matchSocialText(identity, 'follow https://x.com/zorbulator now')).toMatchObject({ basis: 'OFFICIAL_SOCIAL_LINK' });
  });

  it('X unavailable, Telegram available -> partial analysis with lower data quality, no crash', () => {
    const tgEvents = organicEvents().map((item) => ({ ...item, source: 'TELEGRAM' as const, likes: null, reposts: null, replies: null }));
    const both = computeSocialSnapshot({ events: tgEvents, at: AT, sources: [xSource(AT - 3_600_000, true), tgSource()], onchain: onchain() });
    const partial = computeSocialSnapshot({ events: tgEvents, at: AT, sources: [xSource(null, false), tgSource()], onchain: onchain() });
    expect(partial.momentumScore).not.toBeNull();
    expect(partial.dataQuality!).toBeLessThan(both.dataQuality!);
    expect(partial.bySource.TELEGRAM?.mentions5m).toBeGreaterThan(0);
  });

  it('all sources unavailable -> UNKNOWN everywhere (missing data is not negative evidence)', () => {
    const snapshot = computeSocialSnapshot({ events: [], at: AT, sources: [xSource(null, false), tgSource(false)], onchain: onchain() });
    expect(snapshot).toMatchObject({ socialScore: null, momentumScore: null, dataQuality: null, confirmation: 'UNKNOWN', shadowDecision: 'UNKNOWN' });
  });

  it('windows not covered by collection are not computed (no fabricated zero history)', () => {
    const snapshot = computeSocialSnapshot({ events: organicEvents(), at: AT, sources: [xSource(AT - 90_000)], onchain: onchain() });
    expect(snapshot.windows['1m']).not.toBeNull();
    expect(snapshot.windows['2m']).toBeNull();
    expect(snapshot.windows['5m']).toBeNull();
    expect(snapshot.mentionTrend).toBe('UNKNOWN');
  });

  it('no lookahead: scoring at 12:00:30 ignores events from 12:01:00', () => {
    const late = Array.from({ length: 100 }, (_, index) => event(-30, `late${index}`, `viral ${MINT} ${index}`));
    const without = computeSocialSnapshot({ events: organicEvents(), at: AT, sources: [xSource()], onchain: onchain() });
    const withLate = computeSocialSnapshot({ events: [...organicEvents(), ...late], at: AT, sources: [xSource()], onchain: onchain() });
    expect(withLate.windows['5m']!.mentions).toBe(without.windows['5m']!.mentions);
    expect(withLate.momentumScore).toBe(without.momentumScore);
  });

  it('exhaustion: high but decelerating attention + extended price + buyers decelerating', () => {
    const events: SocialEvent[] = [];
    for (let index = 0; index < 40; index += 1) events.push(event(61 + index * 1.4, `p${index}`, `${MINT} post ${index}`));
    for (let index = 0; index < 8; index += 1) events.push(event(index * 7, `n${index}`, `${MINT} later ${index}`));
    const snapshot = computeSocialSnapshot({ events, at: AT, sources: [xSource()], onchain: onchain({ priceExtensionPercent: 300, buyerTrend: 'DECELERATING' }) });
    expect(snapshot.mentionTrend).toBe('DECELERATING');
    expect(snapshot.exhaustionScore!).toBeGreaterThanOrEqual(80);
  });

  it('duplicate detection catches punctuation / number variants of a template', () => {
    const stats = duplicateStats(['Buy ZORB now!!! 100x', 'buy zorb now 250x', 'Buy ZORB now... 9x!!', 'what is the roadmap?']);
    expect(stats.duplicateRatio).toBe(0.5);
    expect(stats.questionRatio).toBe(0.25);
  });

  it('AI off / AI failure never affects the deterministic result', async () => {
    expect(await safeAISocialAnalysis(disabledAISocialAnalyzer, false, { identity, texts: [] })).toEqual({ aiSocialAvailable: false });
    const failing = { analyze: async () => { throw new Error('provider down'); } };
    expect(await safeAISocialAnalysis(failing, true, { identity, texts: ['x'] })).toMatchObject({ aiSocialAvailable: false, error: 'provider down' });
    expect(confirmSocialOnchain({ momentum: null, quality: null, spam: null, exhaustion: null, mentionTrend: 'UNKNOWN', dataQuality: null }, onchain()).state).toBe('UNKNOWN');
  });
});
