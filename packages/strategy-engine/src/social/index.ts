/**
 * Social Intelligence Engine - deterministic core (no LLM anywhere in this module).
 *
 * It measures attention (velocity, acceleration, independent participants), its quality (diversity, concentration,
 * duplicate content), coordination/spam likelihood, late-stage exhaustion and whether on-chain activity confirms it.
 * It does NOT assume high activity = good token, and it never overrides security / risk / sellability.
 *
 * Missing data is never fabricated: a window that is not fully covered by collection is not computed, an unavailable
 * metric stays null, and with no usable source every score is null (UNKNOWN).
 */

export type SocialSource = 'X' | 'TELEGRAM';
export type MatchBasis = 'MINT_ADDRESS' | 'OFFICIAL_SOCIAL_LINK' | 'EXACT_PROJECT_NAME' | 'TICKER' | 'MULTI_SIGNAL_MATCH' | 'UNKNOWN';

export interface SocialIdentity {
  mint: string;
  symbol: string | null;
  name: string | null;
  /** Official handles / links from token metadata (null = not published). */
  officialX: string | null;
  officialTelegram: string | null;
  website: string | null;
}

export interface SocialEvent {
  id: string;
  source: SocialSource;
  /** Opaque author id (never a secret). */
  authorId: string;
  text: string;
  /** Time on the platform (post / message time). */
  createdAt: number;
  receivedAt: number;
  likes?: number | null;
  reposts?: number | null;
  replies?: number | null;
  views?: number | null;
  authorFollowers?: number | null;
  authorCreatedAt?: number | null;
  /** Set when the message comes from the token's official channel (e.g. its Telegram group). */
  fromOfficialChannel?: boolean;
  /** Telegram: the message is a forward / how often it was forwarded (channels expose this). */
  forwarded?: boolean;
  forwards?: number | null;
  matchBasis: MatchBasis;
  matchConfidence: number;
}

// ---------------------------------------------------------------------------------------------
// Identity resolution
// ---------------------------------------------------------------------------------------------

/** Tickers / names too generic to identify a token on their own. */
const GENERIC = new Set(['ai', 'cat', 'dog', 'pepe', 'sol', 'moon', 'inu', 'meme', 'coin', 'token', 'the', 'pump', 'gem', 'elon', 'trump', 'doge', 'frog', 'baby', 'king', 'x', 'usa', 'btc', 'eth']);

const handleOf = (value: string | null) => {
  if (!value) return null;
  // Private invite links (t.me/+..., t.me/joinchat/...) have no public username: never resolved, never joined.
  if (/(?:t\.me|telegram\.me)\/(?:\+|joinchat\/)/i.test(value)) return null;
  const match = /(?:x\.com|twitter\.com|t\.me|telegram\.me)\/(?:s\/)?@?([A-Za-z0-9_]{3,})/i.exec(value);
  if (match) return match[1].toLowerCase();
  const plain = value.trim().replace(/^@/, '');
  return /^[A-Za-z0-9_]{3,64}$/.test(plain) ? plain.toLowerCase() : null;
};
const domainOf = (value: string | null) => {
  if (!value) return null;
  try {
    return new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
};

/** Normalised official social identity from token metadata (pump.fun metadata JSON: twitter / telegram / website). */
export function identityFromMetadata(mint: string, symbol: string | null, name: string | null, metadata: Record<string, unknown> | null): SocialIdentity {
  const text = (key: string) => (metadata && typeof metadata[key] === 'string' && (metadata[key] as string).trim() ? (metadata[key] as string).trim() : null);
  return { mint, symbol, name, officialX: handleOf(text('twitter')), officialTelegram: handleOf(text('telegram')), website: domainOf(text('website')) };
}

/**
 * How reliably a text refers to THIS token. Ticker-only matches never reach the confidence needed to count
 * (AMBIGUOUS_TOKEN_MATCH); the mint address or an official link does.
 */
export function matchSocialText(identity: SocialIdentity, text: string, fromOfficialChannel = false): { basis: MatchBasis; confidence: number; ambiguous: boolean } {
  const lower = text.toLowerCase();
  if (lower.includes(identity.mint.toLowerCase())) return { basis: 'MINT_ADDRESS', confidence: 1, ambiguous: false };
  if (fromOfficialChannel) return { basis: 'OFFICIAL_SOCIAL_LINK', confidence: 0.9, ambiguous: false };
  const officialX = identity.officialX ? new RegExp(`(?:x\\.com|twitter\\.com)/${identity.officialX}\\b|@${identity.officialX}\\b`, 'i') : null;
  const officialTg = identity.officialTelegram ? new RegExp(`t(?:elegram)?\\.me/${identity.officialTelegram}\\b`, 'i') : null;
  if ((officialX && officialX.test(text)) || (officialTg && officialTg.test(text)) || (identity.website && lower.includes(identity.website))) return { basis: 'OFFICIAL_SOCIAL_LINK', confidence: 0.85, ambiguous: false };
  const symbol = identity.symbol?.toLowerCase() ?? null;
  const name = identity.name?.toLowerCase().trim() ?? null;
  const hasTicker = Boolean(symbol && new RegExp(`\\$${symbol.replace(/[^a-z0-9]/g, '')}\\b`, 'i').test(text));
  const nameUsable = Boolean(name && name.length >= 4 && !GENERIC.has(name));
  const hasName = Boolean(nameUsable && lower.includes(name!));
  if (hasTicker && hasName) return { basis: 'MULTI_SIGNAL_MATCH', confidence: GENERIC.has(symbol!) ? 0.55 : 0.7, ambiguous: false };
  if (hasName) return { basis: 'EXACT_PROJECT_NAME', confidence: 0.5, ambiguous: false };
  if (hasTicker) return { basis: 'TICKER', confidence: GENERIC.has(symbol!) || symbol!.length <= 3 ? 0.1 : 0.25, ambiguous: true };
  return { basis: 'UNKNOWN', confidence: 0, ambiguous: true };
}

/** Events below this confidence are reported as ambiguous and never counted as the token's attention. */
export const MIN_MATCH_CONFIDENCE = 0.5;

// ---------------------------------------------------------------------------------------------
// Deterministic text heuristics (no sentiment claims)
// ---------------------------------------------------------------------------------------------

const URL_PATTERN = /https?:\/\/\S+|\b[a-z0-9-]+\.(?:com|io|xyz|fun|app|net|org|me)\/?\S*/gi;
const CTA = ['buy', 'ape', 'aped', 'send it', 'sending', '100x', '1000x', 'moon', 'pump', 'gem', 'don\'t miss', 'dont miss', 'get in', 'last chance', 'early', 'lfg', 'bullish', 'next 100x'];
const WARNING = ['rug', 'rugged', 'scam', 'honeypot', 'dump', 'dumped', 'jeet', 'beware', 'avoid', 'fake', 'dev sold', 'bundle', 'bundled'];

/** Normalised text: lower case, links / numbers / mints replaced, emoji and punctuation removed. */
export function normalizeSocialText(text: string) {
  return text.toLowerCase()
    .replace(URL_PATTERN, ' <url> ')
    .replace(/[1-9A-HJ-NP-Za-km-z]{32,44}/g, ' <mint> ')
    .replace(/\d+([.,]\d+)?/g, ' <n> ')
    .replace(/[^\p{L}<>\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function shingles(text: string) {
  const words = text.split(' ').filter(Boolean);
  const set = new Set<string>();
  if (words.length < 3) set.add(words.join(' '));
  for (let index = 0; index + 2 < words.length; index += 1) set.add(`${words[index]} ${words[index + 1]} ${words[index + 2]}`);
  return set;
}

function jaccard(a: Set<string>, b: Set<string>) {
  let intersection = 0;
  for (const item of a) if (b.has(item)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union ? intersection / union : 0;
}

/** Exact (normalised hash) and near-duplicate (word-3-gram Jaccard >= 0.8) detection; bounded comparisons. */
export function duplicateStats(texts: string[]) {
  const seenExact = new Set<string>();
  const recent: Array<Set<string>> = [];
  let duplicates = 0;
  const urls = new Map<string, number>();
  let cta = 0;
  let warnings = 0;
  let questions = 0;
  for (const text of texts) {
    const normalized = normalizeSocialText(text);
    for (const url of text.match(URL_PATTERN) ?? []) urls.set(url.toLowerCase(), (urls.get(url.toLowerCase()) ?? 0) + 1);
    const lower = text.toLowerCase();
    if (CTA.some((word) => lower.includes(word))) cta += 1;
    if (WARNING.some((word) => new RegExp(`\\b${word}\\b`).test(lower))) warnings += 1;
    if (text.includes('?')) questions += 1;
    if (seenExact.has(normalized)) {
      duplicates += 1;
      continue;
    }
    const grams = shingles(normalized);
    if (normalized.length >= 12 && recent.some((other) => jaccard(grams, other) >= 0.8)) duplicates += 1;
    seenExact.add(normalized);
    recent.push(grams);
    if (recent.length > 200) recent.shift();
  }
  const repeatedUrlMessages = [...urls.values()].filter((count) => count > 1).reduce((sum, count) => sum + count, 0);
  const total = texts.length;
  return {
    duplicateRatio: total ? duplicates / total : null,
    repeatedUrlRatio: total ? Math.min(1, repeatedUrlMessages / total) : null,
    callToActionRatio: total ? cta / total : null,
    warningKeywordCount: warnings,
    questionRatio: total ? questions / total : null,
  };
}

// ---------------------------------------------------------------------------------------------
// Windows (no lookahead, no fabricated history)
// ---------------------------------------------------------------------------------------------

export const SOCIAL_WINDOWS_MS = { '30s': 30_000, '1m': 60_000, '2m': 120_000, '5m': 300_000, '10m': 600_000, '15m': 900_000, '30m': 1_800_000 } as const;
export type SocialWindowKey = keyof typeof SOCIAL_WINDOWS_MS;

export interface WindowMetrics {
  mentions: number;
  uniqueAuthors: number;
  mentionsPerMinute: number;
  /** Sum of likes + reposts + replies over events that expose them; null when none does. */
  engagements: number | null;
  views: number | null;
  topAuthorShare: number | null;
  top3AuthorShare: number | null;
  duplicateRatio: number | null;
  repeatedUrlRatio: number | null;
  callToActionRatio: number | null;
  warningKeywordCount: number;
  questionRatio: number | null;
  /** Sum of forward counts where the platform exposes them (null = not exposed). */
  forwards: number | null;
}

/** Events visible at `at` (created and received no later than `at`) within the window. */
export function eventsInWindow(events: SocialEvent[], at: number, windowMs: number, minConfidence = MIN_MATCH_CONFIDENCE) {
  return events.filter((event) => event.matchConfidence >= minConfidence && event.receivedAt <= at && event.createdAt <= at && event.createdAt > at - windowMs);
}

export function windowMetrics(events: SocialEvent[], windowMs: number): WindowMetrics {
  const authors = new Map<string, number>();
  for (const event of events) authors.set(event.authorId, (authors.get(event.authorId) ?? 0) + 1);
  const counts = [...authors.values()].sort((a, b) => b - a);
  const withEngagement = events.filter((event) => event.likes != null || event.reposts != null || event.replies != null);
  const withViews = events.filter((event) => event.views != null);
  const dup = duplicateStats(events.map((event) => event.text));
  return {
    mentions: events.length,
    uniqueAuthors: authors.size,
    mentionsPerMinute: events.length / (windowMs / 60_000),
    engagements: withEngagement.length ? withEngagement.reduce((sum, event) => sum + (event.likes ?? 0) + (event.reposts ?? 0) + (event.replies ?? 0), 0) : null,
    views: withViews.length ? withViews.reduce((sum, event) => sum + (event.views ?? 0), 0) : null,
    forwards: events.some((event) => event.forwards != null) ? events.reduce((sum, event) => sum + (event.forwards ?? 0), 0) : null,
    topAuthorShare: events.length ? counts[0] / events.length : null,
    top3AuthorShare: events.length ? counts.slice(0, 3).reduce((sum, count) => sum + count, 0) / events.length : null,
    ...dup,
  };
}

export type Trend = 'ACCELERATING' | 'STABLE' | 'DECELERATING' | 'UNKNOWN';

/** Rate in the last `windowMs` vs the window before it (both must be fully covered by collection). */
export function trendOf(current: number | null, previous: number | null, minimumAbsoluteChange = 2): Trend {
  if (current === null || previous === null) return 'UNKNOWN';
  if (current >= previous * 1.5 && current - previous >= minimumAbsoluteChange) return 'ACCELERATING';
  if (current <= previous / 1.5 && previous - current >= minimumAbsoluteChange) return 'DECELERATING';
  return 'STABLE';
}

// ---------------------------------------------------------------------------------------------
// Snapshot + scores
// ---------------------------------------------------------------------------------------------

export interface SourceStatus {
  source: SocialSource;
  /** Provider switched on by configuration (a disabled provider is never "missing evidence"). */
  enabled?: boolean;
  /** Why the source is unavailable for this token (DISABLED, NOT_CONFIGURED, NO_SOURCE_FOUND, RATE_LIMITED, ...). */
  reason?: string | null;
  /** Provider usable (configured + healthy) and collection covering the token since `coverageStart`. */
  available: boolean;
  state: string;
  coverageStart: number | null;
  lastSuccessAt: number | null;
}

export interface OnchainContext {
  launchScore: number | null;
  launchMomentumScore: number | null;
  exhaustionScore: number | null;
  buySellRatio: number | null;
  uniqueBuyers: number | null;
  /** Unique buyers / buy count in the last 30 s vs the 30 s before (on-chain acceleration). */
  buyerTrend: Trend;
  /** Buy volume in the last 30 s vs the 30 s before (optional). */
  volumeTrend?: Trend;
  liquidityChangePercent: number | null;
  priceVelocity: number | null;
  /** Price change since detection (percent): how extended the move already is. */
  priceExtensionPercent: number | null;
}

export interface SocialSnapshotResult {
  at: number;
  windows: Partial<Record<SocialWindowKey, WindowMetrics | null>>;
  bySource: Partial<Record<SocialSource, { mentions1m: number | null; mentions5m: number | null; uniqueAuthors5m: number | null; trend: Trend }>>;
  mentionTrend: Trend;
  authorTrend: Trend;
  engagementTrend: Trend;
  ambiguousMentions5m: number;
  tokenMatchConfidence: number | null;
  matchBasis: MatchBasis;
  momentumScore: number | null;
  qualityScore: number | null;
  spamScore: number | null;
  exhaustionScore: number | null;
  dataQuality: number | null;
  socialScore: number | null;
  components: Record<string, number | null>;
  confirmation: ConfirmationState;
  shadowDecision: ShadowDecision;
  reasons: string[];
  warnings: string[];
  freshness: 'FRESH' | 'AGING' | 'STALE' | 'UNKNOWN';
  dataAgeMs: number | null;
  sources: SourceStatus[];
  /** Score provenance: which providers contributed, which did not (and why), and their actual weight (share of events). */
  providersUsed: SocialSource[];
  providersUnavailable: Array<{ source: SocialSource; reason: string }>;
  providerWeights: Partial<Record<SocialSource, number>>;
  lastEventAt: number | null;
  /** Member counts (Telegram) - null when the platform does not expose them. */
  members: { count: number | null; growth1m: number | null; growth5m: number | null; growth15m: number | null };
  /** Per-provider sub-scores (e.g. TelegramMomentum / Quality / Spam / Exhaustion / DataQuality). */
  perSource: Partial<Record<SocialSource, SourceScores>>;
}

export interface SourceScores {
  momentum: number | null;
  quality: number | null;
  spam: number | null;
  exhaustion: number | null;
  dataQuality: number | null;
  messagesPerMinute5m: number | null;
  messages: Partial<Record<SocialWindowKey, number | null>>;
  uniqueActiveUsers: Partial<Record<SocialWindowKey, number | null>>;
  messageTrend: Trend;
  userTrend: Trend;
  uniqueUserGrowth1m: number | null;
  duplicateRatio: number | null;
  topUserShare: number | null;
  top3UserShare: number | null;
  forwards5m: number | null;
  lastEventAt: number | null;
  freshness: 'FRESH' | 'AGING' | 'STALE' | 'UNKNOWN';
  confirmation: ConfirmationState;
}

export type ConfirmationState = 'STRONG_CONFIRMATION' | 'MODERATE_CONFIRMATION' | 'SOCIAL_LEADING' | 'TELEGRAM_LEADING' | 'ONCHAIN_LEADING' | 'DIVERGENCE' | 'SOCIAL_ONLY_HYPE' | 'WEAK_ACTIVITY' | 'UNKNOWN';
export type ShadowDecision = 'POSITIVE_CONFIRMATION' | 'NEUTRAL' | 'WARNING' | 'AVOID' | 'UNKNOWN';

const clamp = (value: number) => Math.max(0, Math.min(100, value));
const round = (value: number | null) => (value === null ? null : Math.round(value));

/** Is window [at - w, at] fully covered by at least one available source? */
function covered(sources: SourceStatus[], at: number, windowMs: number) {
  return sources.some((source) => source.available && source.coverageStart !== null && source.coverageStart <= at - windowMs);
}

/**
 * Computes every social metric / score at time `at` from events known at `at` (no lookahead).
 * Documented scoring (all deterministic):
 *  Momentum (0-100) = rate 5m: min(40, 20*log2(1+mentions/min)) + acceleration (ACCELERATING 25 / STABLE 10 / DECELERATING 0)
 *                     + author growth (min(20, 4 * new unique authors last 1m vs previous 1m)) + engagement (min(15, 5*log2(1+engagements/min)))
 *  Quality  (0-100) = 30*author diversity(unique/mentions) + 25*(1-top3 share) + 25*(1-duplicate ratio) + 10*match confidence + 10*completeness
 *  Spam     (0-100) = 35*duplicate ratio + 25*max(0, top3 share-0.4)/0.6 + 15*repeated-URL ratio + 15*call-to-action ratio + 10*[mentions per author > 5]
 *  Exhaustion (0-100) = 30*[attention high but decelerating] + 15*[engagement decelerating] + 30*min(1, price extension/200%) + 25*[on-chain buyers decelerating]
 *  DataQuality (0-100) = 30 per available source (max 60) + 15*match confidence + 15*[5m window covered] + 10*[fresh]
 *  SocialScore = 0.35*Momentum + 0.35*Quality + 0.15*(100-Spam) + 0.15*DataQuality - 0.2*Exhaustion   (null when DataQuality is null)
 */
/** The expensive, on-chain independent part (window metrics incl. duplicate detection); cacheable per token. */
export function computeSocialWindows(events: SocialEvent[], at: number, sources: SourceStatus[]) {
  const windows: SocialSnapshotResult['windows'] = {};
  for (const [key, ms] of Object.entries(SOCIAL_WINDOWS_MS) as Array<[SocialWindowKey, number]>) {
    windows[key] = covered(sources, at, ms) ? windowMetrics(eventsInWindow(events, at, ms), ms) : null;
  }
  const prev1m = covered(sources, at, 120_000) ? windowMetrics(eventsInWindow(events, at - 60_000, 60_000), 60_000) : null;
  return { at, windows, prev1m };
}

export function computeSocialSnapshot(input: { events: SocialEvent[]; at: number; sources: SourceStatus[]; onchain: OnchainContext | null; ambiguousEvents?: SocialEvent[]; base?: ReturnType<typeof computeSocialWindows>; memberSamples?: Array<{ t: number; count: number }>; nested?: boolean }): SocialSnapshotResult {
  const { at, sources } = input;
  const available = sources.filter((source) => source.available);
  const reasons: string[] = [];
  const warnings: string[] = [];
  const base0 = input.base && input.base.at === at ? input.base : computeSocialWindows(input.events, at, sources);
  const windows = base0.windows;
  const last1m = windows['1m'];
  const prev1m = base0.prev1m;
  const mentionTrend = trendOf(last1m?.mentionsPerMinute ?? null, prev1m?.mentionsPerMinute ?? null);
  const authorTrend = trendOf(last1m?.uniqueAuthors ?? null, prev1m?.uniqueAuthors ?? null);
  const engagementTrend = last1m?.engagements != null && prev1m?.engagements != null ? trendOf(last1m.engagements, prev1m.engagements, 5) : 'UNKNOWN';
  const bySource: SocialSnapshotResult['bySource'] = {};
  for (const source of sources) {
    const own = input.events.filter((event) => event.source === source.source);
    const one = covered([source], at, 60_000) ? eventsInWindow(own, at, 60_000).length : null;
    const before = covered([source], at, 120_000) ? eventsInWindow(own, at - 60_000, 60_000).length : null;
    const five = covered([source], at, 300_000) ? windowMetrics(eventsInWindow(own, at, 300_000), 300_000) : null;
    bySource[source.source] = { mentions1m: one, mentions5m: five?.mentions ?? null, uniqueAuthors5m: five?.uniqueAuthors ?? null, trend: trendOf(one, before) };
  }
  const visible = input.events.filter((event) => event.receivedAt <= at && event.createdAt <= at);
  const confidences = visible.map((event) => event.matchConfidence);
  const tokenMatchConfidence = confidences.length ? Math.max(...confidences) : null;
  const strongest = visible.slice().sort((a, b) => b.matchConfidence - a.matchConfidence)[0];
  const ambiguous = (input.ambiguousEvents ?? []).filter((event) => event.receivedAt <= at && event.createdAt > at - 300_000).length;
  if (ambiguous > 0) warnings.push(`AMBIGUOUS_TOKEN_MATCH: ${ambiguous} ticker-only mention(s) in 5m not counted`);

  const lastEventAt = visible.length ? Math.max(...visible.map((event) => event.receivedAt)) : null;
  const lastSuccess = available.map((source) => source.lastSuccessAt).filter((value): value is number => value !== null);
  const dataAgeMs = lastSuccess.length ? at - Math.max(...lastSuccess) : null;
  const freshness: SocialSnapshotResult['freshness'] = dataAgeMs === null ? 'UNKNOWN' : dataAgeMs <= 30_000 ? 'FRESH' : dataAgeMs <= 120_000 ? 'AGING' : 'STALE';
  if (freshness === 'STALE') warnings.push('SOCIAL_DATA_STALE');

  // ---- Provenance ----
  const providersUsed = available.map((source) => source.source);
  const providersUnavailable = sources.filter((source) => !source.available).map((source) => ({ source: source.source, reason: source.reason ?? (source.enabled === false ? 'DISABLED' : 'UNAVAILABLE') }));
  const windowEvents = eventsInWindow(input.events, at, 300_000);
  const providerWeights: Partial<Record<SocialSource, number>> = {};
  for (const source of providersUsed) providerWeights[source] = windowEvents.length ? windowEvents.filter((event) => event.source === source).length / windowEvents.length : 1 / providersUsed.length;
  // ---- Member growth (only from real samples bracketing the window; otherwise unknown) ----
  const samples = [...(input.memberSamples ?? [])].filter((sample) => sample.t <= at).sort((a, b) => a.t - b.t);
  const memberAt = (time: number) => [...samples].reverse().find((sample) => sample.t <= time) ?? null;
  const latestMember = memberAt(at);
  const growth = (windowMs: number) => {
    const start = memberAt(at - windowMs);
    return latestMember && start && start.t >= at - windowMs * 1.5 ? latestMember.count - start.count : null;
  };
  const members = { count: latestMember?.count ?? null, growth1m: growth(60_000), growth5m: growth(300_000), growth15m: growth(900_000) };

  if (!available.length) {
    return {
      at, windows, bySource, mentionTrend: 'UNKNOWN', authorTrend: 'UNKNOWN', engagementTrend: 'UNKNOWN', ambiguousMentions5m: ambiguous, tokenMatchConfidence, matchBasis: strongest?.matchBasis ?? 'UNKNOWN',
      momentumScore: null, qualityScore: null, spamScore: null, exhaustionScore: null, dataQuality: null, socialScore: null, components: {},
      confirmation: 'UNKNOWN', shadowDecision: 'UNKNOWN', reasons, warnings: [...warnings, 'NO_SOCIAL_SOURCE_AVAILABLE'], freshness: 'UNKNOWN', dataAgeMs: null, sources,
      providersUsed, providersUnavailable, providerWeights, lastEventAt, members, perSource: {},
    };
  }

  const five = windows['5m'];
  const base = five ?? windows['2m'] ?? last1m ?? null;
  // ---- Momentum ----
  let momentum: number | null = null;
  if (base) {
    // Each component counts only when its data exists; the sum is normalised by the maximum of the AVAILABLE
    // components, so a platform that does not expose engagement / members is not scored as zero.
    const parts: Array<[number, number]> = [[Math.min(40, 20 * Math.log2(1 + base.mentionsPerMinute)), 40]];
    if (mentionTrend !== 'UNKNOWN') parts.push([mentionTrend === 'ACCELERATING' ? 25 : mentionTrend === 'STABLE' ? 10 : 0, 25]);
    if (last1m && prev1m) parts.push([Math.min(20, 4 * Math.max(0, last1m.uniqueAuthors - prev1m.uniqueAuthors)), 20]);
    if (base.engagements !== null) parts.push([Math.min(15, 5 * Math.log2(1 + base.engagements / (five ? 5 : 1))), 15]);
    if (members.growth5m !== null) parts.push([Math.min(10, Math.max(0, members.growth5m) / 5), 10]);
    momentum = clamp(100 * parts.reduce((sum, [value]) => sum + value, 0) / parts.reduce((sum, [, max]) => sum + max, 0));
    if (mentionTrend === 'ACCELERATING') reasons.push('mentions accelerating');
    if (authorTrend === 'ACCELERATING') reasons.push('unique authors increasing');
    if (mentionTrend === 'DECELERATING') warnings.push('mentions decelerating');
  }
  // ---- Quality / Spam (need activity) ----
  let quality: number | null = null;
  let spam: number | null = null;
  if (base && base.mentions > 0) {
    const diversity = base.uniqueAuthors / base.mentions;
    const completeness = (base.engagements !== null ? 0.5 : 0) + (available.length >= 2 ? 0.5 : 0.25);
    quality = clamp(30 * diversity + 25 * (1 - (base.top3AuthorShare ?? 1)) + 25 * (1 - (base.duplicateRatio ?? 0)) + 10 * (tokenMatchConfidence ?? 0) + 10 * completeness);
    spam = clamp(35 * (base.duplicateRatio ?? 0) + 25 * Math.max(0, (base.top3AuthorShare ?? 0) - 0.4) / 0.6 + 15 * (base.repeatedUrlRatio ?? 0) + 15 * (base.callToActionRatio ?? 0) + (base.mentions / Math.max(1, base.uniqueAuthors) > 5 ? 10 : 0));
    if ((base.duplicateRatio ?? 0) >= 0.4) warnings.push(`${Math.round((base.duplicateRatio ?? 0) * 100)}% duplicate content`);
    if ((base.top3AuthorShare ?? 0) >= 0.6) warnings.push(`activity concentrated: top 3 authors ${Math.round((base.top3AuthorShare ?? 0) * 100)}%`);
    if (base.warningKeywordCount > 0) warnings.push(`${base.warningKeywordCount} message(s) with rug/scam warning keywords`);
    if (diversity >= 0.6 && base.uniqueAuthors >= 5) reasons.push('activity distributed across many independent authors');
  } else if (base) {
    reasons.push('no matched social activity in the window');
  }
  // ---- Exhaustion ----
  let exhaustion: number | null = null;
  if (base) {
    const attentionHigh = base.mentionsPerMinute >= 5;
    const extension = input.onchain?.priceExtensionPercent ?? null;
    // Unknown inputs are left out (normalised by the available maximum); engagement falls back to unique-user growth.
    const parts: Array<[number, number]> = [];
    if (mentionTrend !== 'UNKNOWN') parts.push([attentionHigh && mentionTrend === 'DECELERATING' ? 30 : 0, 30]);
    if (engagementTrend !== 'UNKNOWN') parts.push([engagementTrend === 'DECELERATING' ? 15 : 0, 15]);
    else if (authorTrend !== 'UNKNOWN') parts.push([attentionHigh && authorTrend === 'DECELERATING' ? 15 : 0, 15]);
    if (extension !== null) parts.push([30 * Math.min(1, Math.max(0, extension) / 200), 30]);
    if (input.onchain?.buyerTrend && input.onchain.buyerTrend !== 'UNKNOWN') parts.push([input.onchain.buyerTrend === 'DECELERATING' ? 25 : 0, 25]);
    exhaustion = parts.length ? clamp(100 * parts.reduce((sum, [value]) => sum + value, 0) / parts.reduce((sum, [, max]) => sum + max, 0)) : null;
    if (extension !== null && extension >= 100) warnings.push(`price already extended +${Math.round(extension)}%`);
  }
  // ---- Data quality ----
  // Data quality (evidence, not attention): one source 30, a second +15; identity 15; full 5m window 15; freshness 10;
  // observation depth up to 15 (10+ matched messages in 5m). Telegram-only can reach 85 - the missing X lowers
  // CONFIDENCE, it never halves the social score itself.
  const depth = base ? Math.min(1, base.mentions / 10) : 0;
  const dataQuality = clamp((available.length >= 1 ? 30 : 0) + (available.length >= 2 ? 15 : 0) + 15 * (tokenMatchConfidence ?? 0) + (five ? 15 : 0) + (freshness === 'FRESH' ? 10 : freshness === 'AGING' ? 5 : 0) + 15 * depth);
  const socialScore = momentum === null ? null : clamp(0.35 * momentum + 0.35 * (quality ?? 0) + 0.15 * (100 - (spam ?? 0)) + 0.15 * dataQuality - 0.2 * (exhaustion ?? 0));

  const confirmation = confirmSocialOnchain({ momentum, quality, spam, exhaustion, mentionTrend, dataQuality, providersUsed }, input.onchain);
  if (confirmation.state === 'STRONG_CONFIRMATION' || confirmation.state === 'MODERATE_CONFIRMATION') reasons.push('on-chain buying confirms social growth');
  if (confirmation.state === 'SOCIAL_ONLY_HYPE') warnings.push('social attention without on-chain confirmation');
  const shadowDecision = shadowDecisionOf({ spam, exhaustion, confirmation: confirmation.state, dataQuality });
  void lastEventAt;
  return {
    at, windows, bySource, mentionTrend, authorTrend, engagementTrend, ambiguousMentions5m: ambiguous, tokenMatchConfidence, matchBasis: strongest?.matchBasis ?? 'UNKNOWN',
    momentumScore: round(momentum), qualityScore: round(quality), spamScore: round(spam), exhaustionScore: round(exhaustion), dataQuality: round(dataQuality), socialScore: round(socialScore),
    components: { momentum: round(momentum), quality: round(quality), spamPenalty: spam === null ? null : round(0.15 * spam), dataQuality: round(dataQuality), exhaustionPenalty: exhaustion === null ? null : round(0.2 * exhaustion) },
    confirmation: confirmation.state, shadowDecision, reasons, warnings, freshness, dataAgeMs, sources,
    providersUsed, providersUnavailable, providerWeights, lastEventAt, members,
    perSource: input.nested ? {} : perSourceScores(input, available),
  };
}

/** Per-provider sub-scores: the same deterministic formulas on that provider's events only. */
function perSourceScores(input: Parameters<typeof computeSocialSnapshot>[0], available: SourceStatus[]): SocialSnapshotResult['perSource'] {
  const result: SocialSnapshotResult['perSource'] = {};
  for (const source of available) {
    const own = input.events.filter((event) => event.source === source.source);
    const snapshot = computeSocialSnapshot({ ...input, events: own, sources: [source], base: undefined, nested: true, ambiguousEvents: [], memberSamples: source.source === 'TELEGRAM' ? input.memberSamples : [] });
    const window = (key: SocialWindowKey) => snapshot.windows[key] ?? null;
    const keys: SocialWindowKey[] = ['30s', '1m', '2m', '5m', '10m', '15m', '30m'];
    const last = window('1m');
    const prev = covered([source], input.at, 120_000) ? windowMetrics(eventsInWindow(own, input.at - 60_000, 60_000), 60_000) : null;
    result[source.source] = {
      momentum: snapshot.momentumScore, quality: snapshot.qualityScore, spam: snapshot.spamScore, exhaustion: snapshot.exhaustionScore, dataQuality: snapshot.dataQuality,
      messagesPerMinute5m: window('5m')?.mentionsPerMinute ?? null,
      messages: Object.fromEntries(keys.map((key) => [key, window(key)?.mentions ?? null])),
      uniqueActiveUsers: Object.fromEntries(keys.map((key) => [key, window(key)?.uniqueAuthors ?? null])),
      messageTrend: snapshot.mentionTrend, userTrend: snapshot.authorTrend,
      uniqueUserGrowth1m: last && prev ? last.uniqueAuthors - prev.uniqueAuthors : null,
      duplicateRatio: window('5m')?.duplicateRatio ?? null, topUserShare: window('5m')?.topAuthorShare ?? null, top3UserShare: window('5m')?.top3AuthorShare ?? null,
      forwards5m: window('5m')?.forwards ?? null,
      lastEventAt: snapshot.lastEventAt,
      freshness: snapshot.freshness,
      confirmation: snapshot.confirmation,
    };
  }
  return result;
}

/**
 * Social <-> on-chain confirmation. "On-chain strength" = the existing Launch Momentum score (fallback: buy/sell ratio).
 * Thresholds: social strong = momentum >= 60 and quality >= 50; on-chain strong >= 60, weak < 35.
 */
export function confirmSocialOnchain(social: { momentum: number | null; quality: number | null; spam: number | null; exhaustion: number | null; mentionTrend: Trend; dataQuality: number | null; providersUsed?: SocialSource[] }, onchain: OnchainContext | null): { state: ConfirmationState; onchainStrength: number | null } {
  if (social.momentum === null || social.dataQuality === null) return { state: 'UNKNOWN', onchainStrength: null };
  const onchainStrength = onchain?.launchMomentumScore ?? (onchain?.buySellRatio != null ? clamp((onchain.buySellRatio - 1) * 50 + 30) : null);
  if (onchainStrength === null) return { state: 'UNKNOWN', onchainStrength };
  const socialStrong = social.momentum >= 60 && (social.quality ?? 0) >= 50;
  if (social.momentum < 30 && onchainStrength < 40) return { state: 'WEAK_ACTIVITY', onchainStrength };
  if (social.mentionTrend === 'ACCELERATING' && onchain?.buyerTrend === 'DECELERATING') return { state: 'DIVERGENCE', onchainStrength };
  if (social.mentionTrend === 'DECELERATING' && onchain?.buyerTrend === 'ACCELERATING' && social.momentum >= 45) return { state: 'DIVERGENCE', onchainStrength };
  if (social.momentum >= 60 && onchainStrength < 35) return { state: 'SOCIAL_ONLY_HYPE', onchainStrength };
  // Strong: on-chain strong, liquidity not draining, buy volume not falling, low spam / exhaustion.
  const liquidityOk = onchain?.liquidityChangePercent == null || onchain.liquidityChangePercent >= -10;
  const volumeOk = onchain?.volumeTrend !== 'DECELERATING';
  if (socialStrong && onchainStrength >= 60 && liquidityOk && volumeOk && (social.exhaustion ?? 0) < 60 && (social.spam ?? 0) < 50) return { state: 'STRONG_CONFIRMATION', onchainStrength };
  if (social.momentum >= 45 && onchainStrength >= 45) return { state: 'MODERATE_CONFIRMATION', onchainStrength };
  if (onchainStrength >= 60 && social.momentum < 45) return { state: 'ONCHAIN_LEADING', onchainStrength };
  if (social.momentum >= 45 && social.mentionTrend === 'ACCELERATING') {
    const telegramOnly = social.providersUsed?.length === 1 && social.providersUsed[0] === 'TELEGRAM';
    return { state: telegramOnly ? 'TELEGRAM_LEADING' : 'SOCIAL_LEADING', onchainStrength };
  }
  return { state: 'WEAK_ACTIVITY', onchainStrength };
}

/** What the social layer WOULD recommend (only applied in ENFORCE_PAPER, where AVOID can remove an entry, never add one). */
export function shadowDecisionOf(input: { spam: number | null; exhaustion: number | null; confirmation: ConfirmationState; dataQuality: number | null }): ShadowDecision {
  if (input.dataQuality === null || input.confirmation === 'UNKNOWN') return 'UNKNOWN';
  if ((input.spam ?? 0) >= 70 || (input.confirmation === 'SOCIAL_ONLY_HYPE' && (input.exhaustion ?? 0) >= 60)) return 'AVOID';
  if ((input.spam ?? 0) >= 50 || (input.exhaustion ?? 0) >= 60 || input.confirmation === 'DIVERGENCE' || input.confirmation === 'SOCIAL_ONLY_HYPE') return 'WARNING';
  if ((input.confirmation === 'STRONG_CONFIRMATION' || input.confirmation === 'MODERATE_CONFIRMATION') && (input.spam ?? 0) < 40) return 'POSITIVE_CONFIRMATION';
  return 'NEUTRAL';
}

/**
 * The ONLY place where social data may affect a NewLaunch decision: in ENFORCE_PAPER an AVOID can remove a BUY.
 * It can never add a BUY, change size / exits / risk, and in OFF / MONITOR_ONLY it never changes anything.
 */
export function socialBlocksEntry(input: { decision: string; mode: 'OFF' | 'MONITOR_ONLY' | 'ENFORCE_PAPER'; shadowDecision: ShadowDecision | null | undefined }) {
  return input.decision === 'BUY' && input.mode === 'ENFORCE_PAPER' && input.shadowDecision === 'AVOID';
}

/** On-chain buyer acceleration from the stored observation series (last 30 s vs the 30 s before). */
export function buyerTrendFromObservations(observations: Array<{ takenAt: number; buyCount: number; uniqueBuyers: number | null }>, at: number): Trend {
  const before = (time: number) => [...observations].reverse().find((item) => item.takenAt <= time) ?? null;
  const now = before(at);
  const mid = before(at - 30_000);
  const start = before(at - 60_000);
  if (!now || !mid || !start) return 'UNKNOWN';
  const value = (item: typeof now) => item.uniqueBuyers ?? item.buyCount;
  return trendOf(value(now) - value(mid), value(mid) - value(start), 2);
}

/** Compact summary stored with every NewLaunch decision (rejected candidates included). */
export function socialSummary(snapshot: SocialSnapshotResult | null) {
  if (!snapshot) return { available: false, shadowDecision: 'UNKNOWN' as ShadowDecision };
  return {
    available: snapshot.dataQuality !== null,
    at: new Date(snapshot.at).toISOString(),
    socialScore: snapshot.socialScore, momentum: snapshot.momentumScore, quality: snapshot.qualityScore, spam: snapshot.spamScore,
    exhaustion: snapshot.exhaustionScore, dataQuality: snapshot.dataQuality, confirmation: snapshot.confirmation, shadowDecision: snapshot.shadowDecision,
    mentionTrend: snapshot.mentionTrend, tokenMatchConfidence: snapshot.tokenMatchConfidence, matchBasis: snapshot.matchBasis, freshness: snapshot.freshness,
    mentions5m: snapshot.windows['5m']?.mentions ?? null, uniqueAuthors5m: snapshot.windows['5m']?.uniqueAuthors ?? null,
    x: snapshot.bySource.X ?? null, telegram: snapshot.bySource.TELEGRAM ?? null,
    providers: snapshot.sources.map((source) => ({ source: source.source, state: source.state, available: source.available, reason: source.reason ?? null })),
    providersUsed: snapshot.providersUsed, providersUnavailable: snapshot.providersUnavailable, providerWeights: snapshot.providerWeights,
    // Telegram shadow features (null = not available; historical trades without collection stay TELEGRAM_DATA_NOT_AVAILABLE).
    telegramFeatures: snapshot.perSource.TELEGRAM ? {
      momentum: snapshot.perSource.TELEGRAM.momentum, quality: snapshot.perSource.TELEGRAM.quality, spam: snapshot.perSource.TELEGRAM.spam,
      exhaustion: snapshot.perSource.TELEGRAM.exhaustion, dataQuality: snapshot.perSource.TELEGRAM.dataQuality,
      messageVelocity: snapshot.perSource.TELEGRAM.messagesPerMinute5m, messageAcceleration: snapshot.perSource.TELEGRAM.messageTrend,
      uniqueActiveUsers5m: snapshot.perSource.TELEGRAM.uniqueActiveUsers['5m'] ?? null, uniqueUserGrowth1m: snapshot.perSource.TELEGRAM.uniqueUserGrowth1m,
      duplicateRatio: snapshot.perSource.TELEGRAM.duplicateRatio, activityConcentration: snapshot.perSource.TELEGRAM.top3UserShare,
      confirmation: snapshot.perSource.TELEGRAM.confirmation, freshness: snapshot.perSource.TELEGRAM.freshness,
      lastEventAt: snapshot.perSource.TELEGRAM.lastEventAt, memberCount: snapshot.members.count, memberGrowth5m: snapshot.members.growth5m,
    } : null,
  };
}

// ---------------------------------------------------------------------------------------------
// Optional AI layer (OFF by default; never required)
// ---------------------------------------------------------------------------------------------

export interface AISocialResult {
  aiSocialAvailable: boolean;
  sentiment?: 'POSITIVE' | 'NEUTRAL' | 'NEGATIVE' | 'MIXED';
  narrative?: string;
  discussionQuality?: number;
  scamWarningInterpretation?: string;
  promotionContext?: string;
  error?: string;
}

export interface AISocialAnalyzer {
  analyze(input: { identity: SocialIdentity; texts: string[] }): Promise<AISocialResult>;
}

/** Default: no AI. */
export const disabledAISocialAnalyzer: AISocialAnalyzer = { analyze: async () => ({ aiSocialAvailable: false }) };

/** Any AI failure degrades to `aiSocialAvailable: false`; the deterministic core is never affected. */
export async function safeAISocialAnalysis(analyzer: AISocialAnalyzer | null, enabled: boolean, input: Parameters<AISocialAnalyzer['analyze']>[0], timeoutMs = 3_000): Promise<AISocialResult> {
  if (!enabled || !analyzer) return { aiSocialAvailable: false };
  try {
    return await Promise.race([analyzer.analyze(input), new Promise<AISocialResult>((resolve) => globalThis.setTimeout(() => resolve({ aiSocialAvailable: false, error: 'TIMEOUT' }), timeoutMs))]);
  } catch (error) {
    return { aiSocialAvailable: false, error: error instanceof Error ? error.message : 'AI_SOCIAL_FAILED' };
  }
}
