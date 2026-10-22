/**
 * ML-FEATURES-AUTONOMOUS-v1: one schema for both decision kinds of the Autonomous ML engine.
 *
 *   ENTRY    - a token candidate at a decision point (BUY / SKIP / WAIT);
 *   POSITION - an open (real or replayed) position at a decision point (HOLD / SELL / PARTIAL_SELL).
 *
 * Feature set = ML-FEATURES-COMMUNITY-v1 (v1 market / structure / security / risk / social + COMMUNITY), the "entry
 * context", plus the groups below. For POSITION rows the entry context is FROZEN at entry (the snapshot the position
 * was opened on), so live inference and replayed training rows see identical inputs; the current state comes from
 * DYNAMICS / EXECUTION / POSITION / PORTFOLIO, computed at the decision moment.
 *
 * Time correctness: every input carries its own observation time; samples after `at` are cut, groups whose data is
 * newer than `at` are excluded (null, listed in lateDataExcluded, real time kept in observedAt). Missing = null, never 0.
 */
import { ML_COMMUNITY_FEATURE_SCHEMA } from '../ml/community-features.js';
import { impactPercent } from '../ml/exit-simulation.js';
import type { MlFeatureGroup, MlFeatureSnapshotResult, MlFeatureSpec, MlFeatures } from '../ml/features.js';

export const ML_AUTONOMOUS_FEATURE_VERSION = 'ML-FEATURES-AUTONOMOUS-v1';
/** PAPER fee per side (same as the PAPER execution engine: 30 bps). */
export const AUTONOMOUS_FEE_RATE = 30 / 10_000;
export type AutonomousDecisionKind = 'ENTRY' | 'POSITION';
export const MARKET_REGIMES = ['HOT', 'NORMAL', 'COLD'] as const;

const spec = (name: string, group: MlFeatureGroup, description: string, extra: Partial<MlFeatureSpec> = {}): MlFeatureSpec => ({ name, group, type: 'number', description, ...extra });

export const ML_AUTONOMOUS_EXTRA_SPECS: MlFeatureSpec[] = [
  spec('decisionKind', 'POSITION', 'ENTRY (candidate) or POSITION (open position)', { type: 'category', values: ['ENTRY', 'POSITION'] }),
  // DYNAMICS: price / liquidity / trade samples up to the decision moment.
  spec('ret30sPct', 'DYNAMICS', 'Price change over the last 30 s (%)', { transform: 'signed_log1p' }),
  spec('ret1mPct', 'DYNAMICS', 'Price change over the last 1 min (%)', { transform: 'signed_log1p' }),
  spec('ret5mPct', 'DYNAMICS', 'Price change over the last 5 min (%)', { transform: 'signed_log1p' }),
  spec('ret15mPct', 'DYNAMICS', 'Price change over the last 15 min (%)', { transform: 'signed_log1p' }),
  spec('volatility1mPct', 'DYNAMICS', 'Std. dev. of sample-to-sample log returns, last 1 min (%)'),
  spec('volatility5mPct', 'DYNAMICS', 'Std. dev. of sample-to-sample log returns, last 5 min (%)'),
  spec('acceleration1mPct', 'DYNAMICS', '1 min return now minus the 1 min return one minute earlier (%)', { transform: 'signed_log1p' }),
  spec('liquidityChange1mPct', 'DYNAMICS', 'Liquidity change over 1 min (%)', { transform: 'signed_log1p' }),
  spec('liquidityChange5mPct', 'DYNAMICS', 'Liquidity change over 5 min (%)', { transform: 'signed_log1p' }),
  spec('tradeRate1m', 'DYNAMICS', 'Trades per minute, last minute', { transform: 'log1p' }),
  spec('tradeRateChange1m', 'DYNAMICS', 'Trades last minute / trades the minute before', { transform: 'log1p' }),
  spec('drawdownFromHigh5mPct', 'DYNAMICS', 'Price below the 5 min high (%)'),
  spec('newBuyerShare1m', 'DYNAMICS', 'Share of last-minute buyers buying for the first time (on-chain stream)'),
  spec('returningBuyerShare1m', 'DYNAMICS', 'Share of last-minute buyers that bought before'),
  spec('buyers1m', 'DYNAMICS', 'Distinct buyers in the last minute', { transform: 'log1p' }),
  spec('sampleSpanSeconds', 'DYNAMICS', 'Seconds of price history available before the decision', { transform: 'log1p' }),
  // EXECUTION: cost of acting now at the current liquidity.
  spec('liquidityNowUsd', 'EXECUTION', 'Liquidity at the decision moment (USD)', { transform: 'log1p' }),
  spec('estimatedEntryImpactPct', 'EXECUTION', 'Impact of the reference entry order now (%)'),
  spec('estimatedExitImpactPct', 'EXECUTION', 'Impact of selling the (reference / open) position now (%)'),
  spec('exitCapacityRatio', 'EXECUTION', 'Position notional / (liquidity / 2): how much of the pool an exit needs'),
  spec('roundTripCostPct', 'EXECUTION', 'Fees + entry impact + exit impact of a round trip now (%)'),
  spec('quoteAgeSeconds', 'EXECUTION', 'Age of the price used (s)'),
  // REGIME: market-wide state from the launches observed in the last minutes.
  spec('marketRegime', 'REGIME', 'HOT / NORMAL / COLD from launch rate and recent launch returns', { type: 'category', values: [...MARKET_REGIMES] }),
  spec('marketLaunchRate10m', 'REGIME', 'New launches per minute, last 10 min', { transform: 'log1p' }),
  spec('marketMedianLaunchReturnPct', 'REGIME', 'Median return since detection of the launches detected 3-10 min ago (%)', { transform: 'signed_log1p' }),
  spec('marketPositiveLaunchShare', 'REGIME', 'Share of the launches detected 3-10 min ago that trade above their first price'),
  // POSITION: only for POSITION rows (ENTRY rows: null).
  spec('positionOpen', 'POSITION', 'The row is an open position', { type: 'boolean' }),
  spec('unrealizedNetPct', 'POSITION', 'Net result if sold now (fees + exit impact included, % of entry notional)', { transform: 'signed_log1p' }),
  spec('grossReturnPct', 'POSITION', 'Market price now vs entry fill (%)', { transform: 'signed_log1p' }),
  spec('mfePct', 'POSITION', 'Maximum favourable excursion since entry (%)', { transform: 'signed_log1p' }),
  spec('maePct', 'POSITION', 'Maximum adverse excursion since entry (%)', { transform: 'signed_log1p' }),
  spec('drawdownFromPeakPct', 'POSITION', 'Price below the highest price since entry (%)'),
  spec('holdSeconds', 'POSITION', 'Seconds since entry', { transform: 'log1p' }),
  spec('costsIncurredPct', 'POSITION', 'Entry fee + entry impact paid (%)'),
  spec('expectedExitCostPct', 'POSITION', 'Exit fee + exit impact if sold now (%)'),
  spec('partiallySold', 'POSITION', 'Part of the position was sold already', { type: 'boolean' }),
  // PORTFOLIO: the account at the decision moment.
  spec('portfolioExposurePct', 'PORTFOLIO', 'Open position value / account equity (%)'),
  spec('openPositions', 'PORTFOLIO', 'Open positions of the account'),
  spec('accountDayPnlPct', 'PORTFOLIO', 'Realised + unrealised P&L today / equity at day start (%)', { transform: 'signed_log1p' }),
];

export const ML_AUTONOMOUS_FEATURE_SCHEMA: MlFeatureSpec[] = [...ML_COMMUNITY_FEATURE_SCHEMA, ...ML_AUTONOMOUS_EXTRA_SPECS];
export const ML_AUTONOMOUS_GROUPS: MlFeatureGroup[] = ['DYNAMICS', 'EXECUTION', 'REGIME', 'POSITION', 'PORTFOLIO'];

export function mlAutonomousFeatureSchemaJson() {
  return { featureVersion: ML_AUTONOMOUS_FEATURE_VERSION, features: ML_AUTONOMOUS_FEATURE_SCHEMA };
}

/** One market sample; `tradeCount` is cumulative (monotone) or null when unknown. */
export interface MarketSample { t: number; price: number | null; liquidityUsd: number | null; tradeCount: number | null }

export interface AutonomousPositionState {
  openedAt: number;
  /** Entry fill (incl. impact) and the market price at entry. */
  entryFillPrice: number;
  entryMarketPrice: number;
  entryNotionalUsd: number;
  entryImpactPct: number;
  /** Highest / lowest market price since entry, from data known by `at`. */
  highestPrice: number;
  lowestPrice: number;
  /** Quantity still held (tokens). */
  quantity: number;
  partiallySold: boolean;
}

export interface AutonomousSnapshotInput {
  kind: AutonomousDecisionKind;
  at: number;
  /** Entry context: ML-FEATURES-COMMUNITY-v1 snapshot (ENTRY: at the decision; POSITION: frozen at entry). */
  base: MlFeatureSnapshotResult;
  samples: MarketSample[];
  /** Price used for decisions / execution and when it was observed. */
  quote: { price: number; liquidityUsd: number | null; at: number } | null;
  onchain?: { at: number; newBuyerShare1m: number | null; buyers1m: number | null } | null;
  regime?: { at: number; launchRate10m: number | null; medianLaunchReturnPct: number | null; positiveLaunchShare: number | null } | null;
  position?: AutonomousPositionState | null;
  portfolio?: { at: number; exposurePct: number | null; openPositions: number; dayPnlPct: number | null } | null;
  /** Reference entry order (USD) for ENTRY rows. */
  referenceOrderUsd?: number;
}

export interface AutonomousSnapshotResult {
  featureVersion: string;
  kind: AutonomousDecisionKind;
  at: number;
  features: MlFeatures;
  observedAt: Partial<Record<MlFeatureGroup, number | null>>;
  lateDataExcluded: MlFeatureGroup[];
  dataQuality: number;
  validForTraining: boolean;
  invalidReasons: string[];
  referencePriceUsd: number | null;
  referenceLiquidityUsd: number | null;
}

const round = (value: number | null, digits = 4) => (value === null || !Number.isFinite(value) ? null : Math.round(value * 10 ** digits) / 10 ** digits);
const pct = (now: number | null, before: number | null) => (now !== null && before !== null && before > 0 ? (now / before - 1) * 100 : null);

/** Latest sample at or before `t` (samples sorted ascending). */
function sampleAt(samples: MarketSample[], t: number, field: 'price' | 'liquidityUsd' | 'tradeCount') {
  for (let index = samples.length - 1; index >= 0; index -= 1) if (samples[index].t <= t && samples[index][field] !== null) return samples[index];
  return null;
}

function volatility(samples: MarketSample[], from: number, to: number) {
  const prices = samples.filter((sample) => sample.t > from && sample.t <= to && sample.price !== null && sample.price > 0).map((sample) => sample.price as number);
  if (prices.length < 3) return null;
  const returns = prices.slice(1).map((price, index) => Math.log(price / prices[index]));
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  return Math.sqrt(returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / returns.length) * 100;
}

/** Market regime from launch activity (deterministic; null without data). */
export function marketRegimeOf(regime: AutonomousSnapshotInput['regime']) {
  if (!regime || regime.medianLaunchReturnPct === null || regime.launchRate10m === null) return null;
  if (regime.medianLaunchReturnPct >= 5 && regime.launchRate10m >= 1) return 'HOT';
  if (regime.medianLaunchReturnPct <= -10 || regime.launchRate10m < 0.2) return 'COLD';
  return 'NORMAL';
}

export function buildAutonomousSnapshot(input: AutonomousSnapshotInput): AutonomousSnapshotResult {
  const { at } = input;
  const invalid: string[] = [];
  const late: MlFeatureGroup[] = [];
  if (input.base.snapshotAt > at) invalid.push('FUTURE_DATA_BASE');
  if (!input.base.validForTraining) invalid.push(...input.base.invalidReasons.map((reason) => `BASE_${reason}`));
  const samples = input.samples.filter((sample) => sample.t <= at).sort((a, b) => a.t - b.t);
  const quote = input.quote && input.quote.at <= at ? input.quote : null;
  if (input.quote && input.quote.at > at) late.push('EXECUTION');
  const priceNow = quote?.price ?? sampleAt(samples, at, 'price')?.price ?? null;
  const liquidityNow = quote?.liquidityUsd ?? sampleAt(samples, at, 'liquidityUsd')?.liquidityUsd ?? null;
  const priceAgo = (ms: number) => sampleAt(samples, at - ms, 'price')?.price ?? null;
  const liquidityAgo = (ms: number) => sampleAt(samples, at - ms, 'liquidityUsd')?.liquidityUsd ?? null;
  const tradesAgo = (ms: number) => sampleAt(samples, at - ms, 'tradeCount')?.tradeCount ?? null;
  const tradesNow = sampleAt(samples, at, 'tradeCount')?.tradeCount ?? null;
  const trades1m = tradesNow !== null && tradesAgo(60_000) !== null ? tradesNow - tradesAgo(60_000)! : null;
  const tradesPrev = tradesAgo(60_000) !== null && tradesAgo(120_000) !== null ? tradesAgo(60_000)! - tradesAgo(120_000)! : null;
  const ret1m = pct(priceNow, priceAgo(60_000));
  const ret1mBefore = pct(priceAgo(60_000), priceAgo(120_000));
  const high5m = samples.filter((sample) => sample.t > at - 300_000 && sample.price !== null).reduce<number | null>((max, sample) => Math.max(max ?? 0, sample.price as number), null);
  const onchain = input.onchain && input.onchain.at <= at ? input.onchain : null;
  if (input.onchain && input.onchain.at > at) late.push('DYNAMICS');
  const regime = input.regime && input.regime.at <= at ? input.regime : null;
  if (input.regime && input.regime.at > at) late.push('REGIME');
  const portfolio = input.portfolio && input.portfolio.at <= at ? input.portfolio : null;
  if (input.portfolio && input.portfolio.at > at) late.push('PORTFOLIO');
  const position = input.kind === 'POSITION' ? input.position ?? null : null;
  if (input.kind === 'POSITION' && !position) invalid.push('POSITION_STATE_MISSING');

  const referenceOrderUsd = input.referenceOrderUsd ?? 20;
  const positionValue = position && priceNow !== null ? position.quantity * priceNow : null;
  const exitNotional = position ? positionValue : referenceOrderUsd;
  const entryImpact = liquidityNow !== null ? impactPercent(referenceOrderUsd, liquidityNow) : null;
  const exitImpact = liquidityNow !== null && exitNotional !== null ? impactPercent(exitNotional, liquidityNow) : null;
  const feePct = AUTONOMOUS_FEE_RATE * 100;
  const grossNow = position && priceNow !== null ? (priceNow / position.entryFillPrice - 1) * 100 : null;
  // Net if the remaining quantity were sold now: proceeds after exit impact + fee vs its cost basis incl. the entry fee.
  const netIfSold = position && priceNow !== null && exitImpact !== null
    ? ((position.quantity * priceNow * (1 - exitImpact / 100) * (1 - AUTONOMOUS_FEE_RATE)) / (position.quantity * position.entryFillPrice * (1 + AUTONOMOUS_FEE_RATE)) - 1) * 100
    : null;

  const features: MlFeatures = {
    ...input.base.features,
    decisionKind: input.kind,
    ret30sPct: round(pct(priceNow, priceAgo(30_000))),
    ret1mPct: round(ret1m),
    ret5mPct: round(pct(priceNow, priceAgo(300_000))),
    ret15mPct: round(pct(priceNow, priceAgo(900_000))),
    volatility1mPct: round(volatility(samples, at - 60_000, at)),
    volatility5mPct: round(volatility(samples, at - 300_000, at)),
    acceleration1mPct: round(ret1m !== null && ret1mBefore !== null ? ret1m - ret1mBefore : null),
    liquidityChange1mPct: round(pct(liquidityNow, liquidityAgo(60_000))),
    liquidityChange5mPct: round(pct(liquidityNow, liquidityAgo(300_000))),
    tradeRate1m: trades1m,
    tradeRateChange1m: round(trades1m !== null && tradesPrev !== null && tradesPrev > 0 ? trades1m / tradesPrev : null),
    drawdownFromHigh5mPct: round(priceNow !== null && high5m !== null && high5m > 0 ? (1 - priceNow / high5m) * 100 : null),
    newBuyerShare1m: round(onchain?.newBuyerShare1m ?? null),
    returningBuyerShare1m: round(onchain?.newBuyerShare1m !== null && onchain?.newBuyerShare1m !== undefined ? 1 - onchain.newBuyerShare1m : null),
    buyers1m: onchain?.buyers1m ?? null,
    sampleSpanSeconds: samples.length ? Math.round((at - samples[0].t) / 1000) : null,
    liquidityNowUsd: round(liquidityNow, 2),
    estimatedEntryImpactPct: round(entryImpact),
    estimatedExitImpactPct: round(exitImpact),
    exitCapacityRatio: round(exitNotional !== null && liquidityNow !== null && liquidityNow > 0 ? exitNotional / (liquidityNow / 2) : null, 6),
    roundTripCostPct: round(entryImpact !== null && exitImpact !== null ? 2 * feePct + entryImpact + exitImpact : null),
    quoteAgeSeconds: quote ? round((at - quote.at) / 1000, 1) : null,
    marketRegime: marketRegimeOf(regime),
    marketLaunchRate10m: round(regime?.launchRate10m ?? null),
    marketMedianLaunchReturnPct: round(regime?.medianLaunchReturnPct ?? null),
    marketPositiveLaunchShare: round(regime?.positiveLaunchShare ?? null),
    positionOpen: input.kind === 'POSITION' ? Boolean(position) : null,
    unrealizedNetPct: round(netIfSold),
    grossReturnPct: round(grossNow),
    mfePct: round(position ? (position.highestPrice / position.entryFillPrice - 1) * 100 : null),
    maePct: round(position ? (position.lowestPrice / position.entryFillPrice - 1) * 100 : null),
    drawdownFromPeakPct: round(position && priceNow !== null && position.highestPrice > 0 ? (1 - priceNow / position.highestPrice) * 100 : null),
    holdSeconds: position ? Math.max(0, Math.round((at - position.openedAt) / 1000)) : null,
    costsIncurredPct: round(position ? feePct + position.entryImpactPct : null),
    expectedExitCostPct: round(position && exitImpact !== null ? feePct + exitImpact : null),
    partiallySold: position ? position.partiallySold : null,
    portfolioExposurePct: round(portfolio?.exposurePct ?? null),
    openPositions: portfolio ? portfolio.openPositions : null,
    accountDayPnlPct: round(portfolio?.dayPnlPct ?? null),
  };
  // Late optional inputs leave no value behind.
  if (late.includes('REGIME')) for (const name of ['marketRegime', 'marketLaunchRate10m', 'marketMedianLaunchReturnPct', 'marketPositiveLaunchShare']) features[name] = null;
  const nonNull = ML_AUTONOMOUS_FEATURE_SCHEMA.filter((item) => features[item.name] !== null && features[item.name] !== undefined).length;
  const lastSample = samples.length ? samples[samples.length - 1].t : null;
  return {
    featureVersion: ML_AUTONOMOUS_FEATURE_VERSION,
    kind: input.kind,
    at,
    features,
    observedAt: {
      ...input.base.observedAt,
      DYNAMICS: lastSample !== null || onchain ? Math.max(lastSample ?? 0, onchain?.at ?? 0) : null,
      EXECUTION: quote?.at ?? lastSample,
      REGIME: input.regime?.at ?? null,
      POSITION: position ? at : null,
      PORTFOLIO: input.portfolio?.at ?? null,
    },
    lateDataExcluded: [...input.base.lateDataExcluded, ...late],
    dataQuality: Math.round(100 * nonNull / ML_AUTONOMOUS_FEATURE_SCHEMA.length),
    validForTraining: invalid.length === 0,
    invalidReasons: invalid,
    referencePriceUsd: priceNow,
    referenceLiquidityUsd: liquidityNow,
  };
}
