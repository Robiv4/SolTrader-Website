/**
 * Community Intelligence (COMMUNITY-v1, pure, no I/O). Normalises what is known about a token's community at a moment
 * `at` from several independent sources into one auditable snapshot:
 *
 *   TELEGRAM / X   the existing Social Intelligence snapshot (SocialSnapshotResult)
 *   DEXSCREENER    official public API: token profile, website / social links, active boosts, paid orders
 *   ONCHAIN        buyer / seller activity of the existing launch trade stream (no extra RPC / Helius request)
 *   LUNARCRUSH     optional (API key): only when the response is explicitly tied to the token's mint address
 *
 * Rules:
 *  - TIME-CORRECT: a source contributes only data received at or before `at` (later data is excluded, never back-dated);
 *  - MISSING != ZERO: a source without data is NO_DATA (its features are null), never a zero score; the Community
 *    Score is null when too little is known;
 *  - IDENTITY: a DEX / LunarCrush record is only used when it names exactly this mint (UNRELIABLE_IDENTITY otherwise);
 *  - unique wallets are wallets, not people; a paid boost is an analysis feature, not a scam verdict;
 *  - MONITOR_ONLY: nothing here makes, blocks or sizes a trade.
 */
import type { SocialSnapshotResult } from '../social/index.js';

export const COMMUNITY_ENGINE_VERSION = 'COMMUNITY-v1';
export const COMMUNITY_MODE = 'MONITOR_ONLY' as const;

export type CommunitySourceId = 'TELEGRAM' | 'X' | 'DEXSCREENER' | 'ONCHAIN' | 'LUNARCRUSH';
export const COMMUNITY_SOURCES: CommunitySourceId[] = ['TELEGRAM', 'X', 'DEXSCREENER', 'ONCHAIN', 'LUNARCRUSH'];

/**
 * OK          data, usable and good enough
 * WEAK        data, but thin (little activity / low quality)
 * NO_DATA     source usable, nothing known for this token (NOT a zero score)
 * STALE       data older than the source's freshness limit at `at`
 * LATE        data only arrived after `at` (excluded from this snapshot)
 * UNRELIABLE_IDENTITY  the record cannot be tied to this exact mint
 * NOT_CONFIGURED / DISABLED  provider off or without credentials
 */
export type CommunitySourceStatus = 'OK' | 'WEAK' | 'NO_DATA' | 'STALE' | 'LATE' | 'UNRELIABLE_IDENTITY' | 'NOT_CONFIGURED' | 'DISABLED';

/** Freshness limits per source (data older than this at `at` is STALE). */
export const COMMUNITY_STALE_AFTER_MS: Record<CommunitySourceId, number> = {
  TELEGRAM: 5 * 60_000, X: 10 * 60_000, DEXSCREENER: 10 * 60_000, ONCHAIN: 30_000, LUNARCRUSH: 60 * 60_000,
};

export interface DexProfileObservation {
  /** When our request returned (the moment the data became known to us). */
  receivedAt: number;
  /** A pair for this token was listed. */
  pairFound: boolean;
  /** The listed pair's base token address equals the mint exactly. */
  identityConfirmed: boolean;
  /** Token profile present (DEX Screener token profile / pair info block). */
  profilePresent: boolean;
  websites: number;
  socials: { twitter: boolean; telegram: boolean; discord: boolean; other: number };
  /** `boosts.active` of the pair (null = not exposed). */
  activeBoosts: number | null;
  /** Paid orders (token profile, community takeover, ads) with their payment time. */
  paidOrders: Array<{ type: string; status: string; paymentTimestamp: number | null }>;
  boostPayments: Array<{ amount: number | null; paymentTimestamp: number | null }>;
  pairCreatedAt: number | null;
  liquidityUsd: number | null;
  dexId: string | null;
}

export interface OnchainTradeEvent {
  wallet: string;
  isBuy: boolean;
  usd: number;
  /** When the trade became known (received from the stream). */
  receivedAt: number;
}

export interface OnchainCommunityStats {
  at: number;
  /** Trades known at `at` inside the last 5 minutes. */
  trades5m: number;
  buyers1m: number;
  buyersPrev1m: number;
  buyers5m: number;
  /** Distinct wallets whose first buy is inside the last minute (share of buyers1m). */
  newBuyerShare1m: number | null;
  /** Buyer concentration (Herfindahl index of buy volume, 0-1; 1 = one wallet). */
  buyerHhi: number | null;
  top3BuyerShare: number | null;
  /** Sells >= the large-sell threshold in the last 5 minutes. */
  largeSells5m: number;
  largeSellVolumeUsd5m: number;
  /** Share of buys in the last 5 minutes that repeat an already seen (rounded) USD amount from another wallet. */
  repeatedAmountShare: number | null;
  lastTradeAt: number | null;
}

export interface LunarObservation {
  receivedAt: number;
  /** The response named this exact mint (contract address); otherwise the record is not used. */
  identityConfirmed: boolean;
  galaxyScore: number | null;
  altRank: number | null;
  sentiment: number | null;
  socialVolume: number | null;
  interactions: number | null;
  contributors: number | null;
}

export interface CommunitySourceView {
  status: CommunitySourceStatus;
  /** When the used data was received (null = none). */
  receivedAt: number | null;
  ageSeconds: number | null;
  reason: string | null;
}

export interface CommunityFeatures {
  communityScore: number | null;
  communityDataQuality: number | null;
  communityCoverage: number | null;
  communityDataAgeSeconds: number | null;
  socialMomentum: number | null;
  socialSpamScore: number | null;
  mentions5m: number | null;
  uniqueAuthors5m: number | null;
  communityGrowth: number | null;
  telegramConversationRatio: number | null;
  telegramForwardedShare: number | null;
  telegramReplyShare: number | null;
  organicInterestScore: number | null;
  dexProfilePresent: boolean | null;
  dexWebsitePresent: boolean | null;
  dexSocialLinkCount: number | null;
  dexActiveBoosts: number | null;
  paidPromotionSignal: boolean | null;
  onchainBuyers5m: number | null;
  buyerWalletGrowth: number | null;
  buyerConcentration: number | null;
  top3BuyerShare: number | null;
  largeSells5m: number | null;
  repeatedAmountShare: number | null;
  socialOnchainDivergence: number | null;
  lunarGalaxyScore: number | null;
  lunarSentiment: number | null;
  lunarSocialVolume: number | null;
}

export type CommunityQuality = 'GOOD' | 'WEAK' | 'NO_DATA' | 'STALE' | 'UNRELIABLE_IDENTITY';

export interface CommunitySnapshotResult {
  version: string;
  mode: typeof COMMUNITY_MODE;
  at: number;
  mint: string;
  sources: Record<CommunitySourceId, CommunitySourceView>;
  features: CommunityFeatures;
  /** Components of the Community Score (0-100 each, null = not available) and the weights actually used. */
  components: Record<string, number | null>;
  weightsUsed: Record<string, number>;
  quality: CommunityQuality;
  /** Sources that had data but only after `at` (excluded). */
  lateExcluded: CommunitySourceId[];
  reasons: string[];
}

export interface CommunityInput {
  at: number;
  mint: string;
  social: SocialSnapshotResult | null;
  dex: DexProfileObservation | null;
  onchain: OnchainCommunityStats | null;
  lunar: LunarObservation | null;
  /** Provider availability (configuration); a disabled / not configured provider is reported as such. */
  providers: Partial<Record<CommunitySourceId, 'ENABLED' | 'DISABLED' | 'NOT_CONFIGURED'>>;
}

const finite = (value: number | null | undefined) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const clamp = (value: number, min = 0, max = 100) => Math.max(min, Math.min(max, value));
const round = (value: number | null, digits = 4) => (value === null ? null : Math.round(value * 10 ** digits) / 10 ** digits);

/**
 * Community Score weights (documented, deterministic). Each component is 0-100; the score is the weighted mean of the
 * AVAILABLE components (weights renormalised). It is null unless at least two components are available and at least
 * one of them is social activity or on-chain breadth.
 *
 *   socialActivity  0.30  Social Intelligence socialScore (Telegram / X activity, quality, momentum)
 *   organicInterest 0.25  organicInterestScore (see below)
 *   onchainBreadth  0.25  buyer breadth: 60 x (1 - buyerHhi) + 40 x min(1, log10(1 + buyers5m) / 2)
 *   profile         0.10  DEX profile completeness: profile 20 + website 30 + min(3, social links) x 16.7
 *   cleanliness     0.10  100 - socialSpamScore
 *
 * organicInterestScore (0-100, null without social AND on-chain data): mean of the available parts
 *   - author diversity  100 x min(1, uniqueAuthors5m / max(1, mentions5m) / 0.6)
 *   - conversation      100 x min(1, replyShare / 0.3)            (Telegram replies)
 *   - low forwarding    100 x (1 - forwardedShare)
 *   - buyer diversity   100 x (1 - buyerHhi)
 *   - non-repetitive    100 x (1 - repeatedAmountShare)
 */
export const COMMUNITY_SCORE_WEIGHTS: Record<string, number> = { socialActivity: 0.3, organicInterest: 0.25, onchainBreadth: 0.25, profile: 0.1, cleanliness: 0.1 };

/** Large-sell threshold (USD) of the on-chain stats. */
export const LARGE_SELL_USD = 500;

/** Pure on-chain community statistics at `at` from stream trades (only trades received at or before `at`). */
export function computeOnchainCommunityStats(trades: OnchainTradeEvent[], at: number, largeSellUsd = LARGE_SELL_USD): OnchainCommunityStats {
  const known = trades.filter((trade) => trade.receivedAt <= at && Number.isFinite(trade.usd) && trade.usd >= 0);
  const inWindow = (from: number, to: number) => known.filter((trade) => trade.receivedAt > from && trade.receivedAt <= to);
  const last5m = inWindow(at - 300_000, at);
  const buyersIn = (list: OnchainTradeEvent[]) => new Set(list.filter((trade) => trade.isBuy).map((trade) => trade.wallet));
  const buyers1m = buyersIn(inWindow(at - 60_000, at));
  const buyersPrev1m = buyersIn(inWindow(at - 120_000, at - 60_000));
  const firstBuy = new Map<string, number>();
  for (const trade of known) if (trade.isBuy && !firstBuy.has(trade.wallet)) firstBuy.set(trade.wallet, trade.receivedAt);
  const newBuyers = [...buyers1m].filter((wallet) => (firstBuy.get(wallet) ?? 0) > at - 60_000).length;
  const buyVolume = new Map<string, number>();
  for (const trade of last5m) if (trade.isBuy) buyVolume.set(trade.wallet, (buyVolume.get(trade.wallet) ?? 0) + trade.usd);
  const total = [...buyVolume.values()].reduce((sum, value) => sum + value, 0);
  const shares = total > 0 ? [...buyVolume.values()].map((value) => value / total).sort((a, b) => b - a) : [];
  const buys5m = last5m.filter((trade) => trade.isBuy);
  // Bot-like repetition: identical rounded USD amounts from DIFFERENT wallets.
  const amountWallets = new Map<number, Set<string>>();
  let repeated = 0;
  for (const trade of buys5m) {
    const key = Math.round(trade.usd * 100);
    const wallets = amountWallets.get(key) ?? new Set<string>();
    if (wallets.size && !wallets.has(trade.wallet)) repeated += 1;
    wallets.add(trade.wallet);
    amountWallets.set(key, wallets);
  }
  const largeSells = last5m.filter((trade) => !trade.isBuy && trade.usd >= largeSellUsd);
  return {
    at,
    trades5m: last5m.length,
    buyers1m: buyers1m.size,
    buyersPrev1m: buyersPrev1m.size,
    buyers5m: buyersIn(last5m).size,
    newBuyerShare1m: buyers1m.size ? newBuyers / buyers1m.size : null,
    buyerHhi: shares.length ? shares.reduce((sum, share) => sum + share * share, 0) : null,
    top3BuyerShare: shares.length ? shares.slice(0, 3).reduce((sum, share) => sum + share, 0) : null,
    largeSells5m: largeSells.length,
    largeSellVolumeUsd5m: largeSells.reduce((sum, trade) => sum + trade.usd, 0),
    repeatedAmountShare: buys5m.length >= 3 ? repeated / buys5m.length : null,
    lastTradeAt: known.length ? Math.max(...known.map((trade) => trade.receivedAt)) : null,
  };
}

const emptyView = (status: CommunitySourceStatus, reason: string | null = null): CommunitySourceView => ({ status, receivedAt: null, ageSeconds: null, reason });

function timedView(receivedAt: number | null, at: number, source: CommunitySourceId, weak: boolean): CommunitySourceView {
  if (receivedAt === null) return emptyView('NO_DATA');
  if (receivedAt > at) return { status: 'LATE', receivedAt, ageSeconds: null, reason: 'RECEIVED_AFTER_SNAPSHOT' };
  const age = at - receivedAt;
  if (age > COMMUNITY_STALE_AFTER_MS[source]) return { status: 'STALE', receivedAt, ageSeconds: Math.round(age / 1000), reason: 'OLDER_THAN_FRESHNESS_LIMIT' };
  return { status: weak ? 'WEAK' : 'OK', receivedAt, ageSeconds: Math.round(age / 1000), reason: null };
}

/** Builds the community snapshot at `at` (pure, deterministic). */
export function computeCommunitySnapshot(input: CommunityInput): CommunitySnapshotResult {
  const { at } = input;
  const reasons: string[] = [];
  const lateExcluded: CommunitySourceId[] = [];
  const configured = (source: CommunitySourceId) => input.providers[source] ?? 'ENABLED';
  const sources = {} as Record<CommunitySourceId, CommunitySourceView>;

  // ---- Social (Telegram / X) from the existing Social Intelligence snapshot ----
  const social = input.social && input.social.at <= at ? input.social : null;
  if (input.social && input.social.at > at) lateExcluded.push('TELEGRAM');
  for (const source of ['TELEGRAM', 'X'] as const) {
    if (configured(source) !== 'ENABLED') {
      sources[source] = emptyView(configured(source) === 'DISABLED' ? 'DISABLED' : 'NOT_CONFIGURED');
      continue;
    }
    const status = social?.sources.find((item) => item.source === source);
    const per = social?.perSource[source];
    const lastEventAt = per?.lastEventAt ?? null;
    if (!social || !status) sources[source] = emptyView(input.social && input.social.at > at ? 'LATE' : 'NO_DATA');
    else if (!status.available) sources[source] = emptyView(status.reason === 'DISABLED' ? 'DISABLED' : status.reason === 'NOT_CONFIGURED' ? 'NOT_CONFIGURED' : 'NO_DATA', status.reason);
    else if (social.tokenMatchConfidence !== null && social.tokenMatchConfidence < 0.5) sources[source] = emptyView('UNRELIABLE_IDENTITY', 'LOW_MATCH_CONFIDENCE');
    else sources[source] = timedView(lastEventAt ?? social.at, at, source, (per?.messages['5m'] ?? 0) < 3);
  }
  const socialUsable = (['TELEGRAM', 'X'] as const).some((source) => sources[source].status === 'OK' || sources[source].status === 'WEAK');
  const window5m = socialUsable ? social?.windows['5m'] ?? null : null;
  const window1m = socialUsable ? social?.windows['1m'] ?? null : null;

  // ---- DEX Screener ----
  let dex: DexProfileObservation | null = null;
  if (configured('DEXSCREENER') !== 'ENABLED') sources.DEXSCREENER = emptyView(configured('DEXSCREENER') === 'DISABLED' ? 'DISABLED' : 'NOT_CONFIGURED');
  else if (!input.dex) sources.DEXSCREENER = emptyView('NO_DATA');
  else if (input.dex.receivedAt > at) {
    sources.DEXSCREENER = { status: 'LATE', receivedAt: input.dex.receivedAt, ageSeconds: null, reason: 'RECEIVED_AFTER_SNAPSHOT' };
    lateExcluded.push('DEXSCREENER');
  } else if (input.dex.pairFound && !input.dex.identityConfirmed) sources.DEXSCREENER = { ...emptyView('UNRELIABLE_IDENTITY', 'BASE_TOKEN_MISMATCH'), receivedAt: input.dex.receivedAt };
  else if (!input.dex.pairFound) sources.DEXSCREENER = { ...emptyView('NO_DATA', 'NOT_LISTED'), receivedAt: input.dex.receivedAt };
  else {
    sources.DEXSCREENER = timedView(input.dex.receivedAt, at, 'DEXSCREENER', !input.dex.profilePresent);
    if (sources.DEXSCREENER.status === 'OK' || sources.DEXSCREENER.status === 'WEAK') dex = input.dex;
  }

  // ---- On-chain (existing trade stream) ----
  let onchain: OnchainCommunityStats | null = null;
  if (configured('ONCHAIN') !== 'ENABLED') sources.ONCHAIN = emptyView(configured('ONCHAIN') === 'DISABLED' ? 'DISABLED' : 'NOT_CONFIGURED');
  else if (!input.onchain || input.onchain.trades5m === 0) sources.ONCHAIN = emptyView('NO_DATA');
  else if (input.onchain.at > at) {
    sources.ONCHAIN = { status: 'LATE', receivedAt: input.onchain.at, ageSeconds: null, reason: 'RECEIVED_AFTER_SNAPSHOT' };
    lateExcluded.push('ONCHAIN');
  } else {
    // The stats are computed AT the snapshot moment from the trades known then: a quiet minute is a measured fact.
    sources.ONCHAIN = timedView(input.onchain.at, at, 'ONCHAIN', input.onchain.buyers5m < 3);
    if (sources.ONCHAIN.status === 'OK' || sources.ONCHAIN.status === 'WEAK') onchain = input.onchain;
  }

  // ---- LunarCrush (optional) ----
  let lunar: LunarObservation | null = null;
  if (configured('LUNARCRUSH') !== 'ENABLED') sources.LUNARCRUSH = emptyView(configured('LUNARCRUSH') === 'DISABLED' ? 'DISABLED' : 'NOT_CONFIGURED');
  else if (!input.lunar) sources.LUNARCRUSH = emptyView('NO_DATA', 'NOT_COVERED');
  else if (input.lunar.receivedAt > at) {
    sources.LUNARCRUSH = { status: 'LATE', receivedAt: input.lunar.receivedAt, ageSeconds: null, reason: 'RECEIVED_AFTER_SNAPSHOT' };
    lateExcluded.push('LUNARCRUSH');
  } else if (!input.lunar.identityConfirmed) sources.LUNARCRUSH = { ...emptyView('UNRELIABLE_IDENTITY', 'MINT_NOT_CONFIRMED'), receivedAt: input.lunar.receivedAt };
  else {
    sources.LUNARCRUSH = timedView(input.lunar.receivedAt, at, 'LUNARCRUSH', false);
    if (sources.LUNARCRUSH.status === 'OK') lunar = input.lunar;
  }

  // ---- Features (null = unknown) ----
  const mentions5m = finite(window5m?.mentions);
  const uniqueAuthors5m = finite(window5m?.uniqueAuthors);
  const growth = window1m && window5m && window5m.mentions > 0 ? (window1m.mentions * 5) / window5m.mentions : null;
  const conversation = mentions5m && mentions5m > 0 && uniqueAuthors5m !== null ? uniqueAuthors5m / mentions5m : null;
  const forwardedShare = finite(window5m?.forwardedShare);
  const replyShare = finite(window5m?.replyShare);
  const buyerGrowth = onchain && onchain.buyersPrev1m > 0 ? (onchain.buyers1m / onchain.buyersPrev1m - 1) * 100 : null;
  const promotionKnown = dex ? [...dex.paidOrders.filter((order) => order.status === 'approved' || order.status === 'processing'), ...dex.boostPayments].some((item) => item.paymentTimestamp !== null && item.paymentTimestamp <= at) || (dex.activeBoosts ?? 0) > 0 : null;

  const organicParts = [
    conversation !== null ? 100 * Math.min(1, conversation / 0.6) : null,
    replyShare !== null ? 100 * Math.min(1, replyShare / 0.3) : null,
    forwardedShare !== null ? 100 * (1 - forwardedShare) : null,
    onchain?.buyerHhi !== null && onchain?.buyerHhi !== undefined ? 100 * (1 - onchain.buyerHhi) : null,
    onchain?.repeatedAmountShare !== null && onchain?.repeatedAmountShare !== undefined ? 100 * (1 - onchain.repeatedAmountShare) : null,
  ].filter((value): value is number => value !== null);
  const organicInterest = organicParts.length ? organicParts.reduce((sum, value) => sum + value, 0) / organicParts.length : null;

  const socialMomentum = socialUsable ? finite(social?.momentumScore) : null;
  const onchainMomentum = buyerGrowth !== null ? 50 + 50 * Math.tanh(buyerGrowth / 100) : null;
  const components: Record<string, number | null> = {
    socialActivity: socialUsable ? finite(social?.socialScore) : null,
    organicInterest,
    onchainBreadth: onchain && onchain.buyerHhi !== null ? clamp(60 * (1 - onchain.buyerHhi) + 40 * Math.min(1, Math.log10(1 + onchain.buyers5m) / 2)) : null,
    profile: dex ? clamp((dex.profilePresent ? 20 : 0) + (dex.websites > 0 ? 30 : 0) + Math.min(3, (dex.socials.twitter ? 1 : 0) + (dex.socials.telegram ? 1 : 0) + (dex.socials.discord ? 1 : 0) + dex.socials.other) * 16.7) : null,
    cleanliness: socialUsable && finite(social?.spamScore) !== null ? clamp(100 - social!.spamScore!) : null,
  };
  const available = Object.entries(components).filter(([, value]) => value !== null) as Array<[string, number]>;
  const anchored = components.socialActivity !== null || components.onchainBreadth !== null;
  const weightTotal = available.reduce((sum, [key]) => sum + COMMUNITY_SCORE_WEIGHTS[key], 0);
  const weightsUsed = Object.fromEntries(available.map(([key]) => [key, round(COMMUNITY_SCORE_WEIGHTS[key] / weightTotal, 4) ?? 0]));
  const communityScore = available.length >= 2 && anchored ? Math.round(available.reduce((sum, [key, value]) => sum + value * COMMUNITY_SCORE_WEIGHTS[key], 0) / weightTotal) : null;
  if (communityScore === null) reasons.push(available.length < 2 ? 'TOO_FEW_COMPONENTS' : 'NO_SOCIAL_OR_ONCHAIN_ANCHOR');

  const enabled = COMMUNITY_SOURCES.filter((source) => sources[source].status !== 'DISABLED' && sources[source].status !== 'NOT_CONFIGURED');
  const withData = enabled.filter((source) => sources[source].status === 'OK' || sources[source].status === 'WEAK');
  const good = enabled.filter((source) => sources[source].status === 'OK');
  const ages = withData.map((source) => sources[source].ageSeconds).filter((value): value is number => value !== null);
  const dataQuality = enabled.length ? Math.round(100 * (good.length + 0.5 * (withData.length - good.length)) / enabled.length) : 0;
  const unreliable = enabled.some((source) => sources[source].status === 'UNRELIABLE_IDENTITY');
  const stale = enabled.some((source) => sources[source].status === 'STALE');
  const quality: CommunityQuality = withData.length === 0 ? (unreliable ? 'UNRELIABLE_IDENTITY' : stale ? 'STALE' : 'NO_DATA') : communityScore !== null && communityScore >= 50 && good.length >= 2 ? 'GOOD' : 'WEAK';

  const features: CommunityFeatures = {
    communityScore,
    communityDataQuality: dataQuality,
    communityCoverage: enabled.length ? round(withData.length / enabled.length) : null,
    communityDataAgeSeconds: ages.length ? Math.min(...ages) : null,
    socialMomentum,
    socialSpamScore: socialUsable ? finite(social?.spamScore) : null,
    mentions5m,
    uniqueAuthors5m,
    communityGrowth: round(growth),
    telegramConversationRatio: round(conversation),
    telegramForwardedShare: round(forwardedShare),
    telegramReplyShare: round(replyShare),
    organicInterestScore: organicInterest === null ? null : Math.round(organicInterest),
    dexProfilePresent: dex ? dex.profilePresent : null,
    dexWebsitePresent: dex ? dex.websites > 0 : null,
    dexSocialLinkCount: dex ? (dex.socials.twitter ? 1 : 0) + (dex.socials.telegram ? 1 : 0) + (dex.socials.discord ? 1 : 0) + dex.socials.other : null,
    dexActiveBoosts: dex ? finite(dex.activeBoosts) : null,
    paidPromotionSignal: promotionKnown,
    onchainBuyers5m: onchain ? onchain.buyers5m : null,
    buyerWalletGrowth: round(buyerGrowth, 2),
    buyerConcentration: round(onchain?.buyerHhi ?? null),
    top3BuyerShare: round(onchain?.top3BuyerShare ?? null),
    largeSells5m: onchain ? onchain.largeSells5m : null,
    repeatedAmountShare: round(onchain?.repeatedAmountShare ?? null),
    // Hype ahead of buyers (> 0) or buyers ahead of the chatter (< 0); null unless both are measured.
    socialOnchainDivergence: socialMomentum !== null && onchainMomentum !== null ? round((socialMomentum - onchainMomentum) / 100) : null,
    lunarGalaxyScore: lunar ? finite(lunar.galaxyScore) : null,
    lunarSentiment: lunar ? finite(lunar.sentiment) : null,
    lunarSocialVolume: lunar ? finite(lunar.socialVolume) : null,
  };
  return { version: COMMUNITY_ENGINE_VERSION, mode: COMMUNITY_MODE, at, mint: input.mint, sources, features, components, weightsUsed, quality, lateExcluded, reasons };
}
