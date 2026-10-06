/**
 * Real price-path metrics of a LONG position, advanced one observed market price at a time.
 *
 *  - MFE (maximum favourable excursion): highest observed gain after entry, relative to the entry FILL
 *    price, never below 0 (at entry the unrealised gain is 0 by definition).
 *  - MAE (maximum adverse excursion): deepest observed loss after entry, never above 0.
 *  - Milestones: the first time (ms after entry) each +x% / -x% level was observed.
 *
 * Only observed prices are used; nothing between two observations is interpolated. Analytics only:
 * these values must never feed an entry decision (they are future information at entry time).
 */
export const PROFIT_MILESTONES = [3, 5, 10, 15, 20, 25, 50] as const;
export const LOSS_MILESTONES = [3, 5, 10, 15, 20, 25] as const;

export interface PathMetricState {
  entryPrice: number;
  entryAt: number;
  quantity: number;
  maxPrice: number | null;
  minPrice: number | null;
  timeToMaxMs: number | null;
  timeToMinMs: number | null;
  /** "+3" / "-5" -> ms after entry when first observed. */
  milestones: Record<string, number>;
  liquidityAtEntry: number | null;
  lastLiquidity: number | null;
  minLiquidity: number | null;
  sampleCount: number;
  lastPriceAt: number | null;
}

export interface PathMetricSummary {
  maxPriceAfterEntry: number | null;
  minPriceAfterEntry: number | null;
  mfePercent: number | null;
  mfeUsd: number | null;
  timeToMfeMs: number | null;
  maePercent: number | null;
  maeUsd: number | null;
  timeToMaeMs: number | null;
  milestones: Record<string, number>;
  liquidityChangePercent: number | null;
  sampleCount: number;
}

const positive = (value: number | null | undefined): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;

export function initPathMetric(entryPrice: number, entryAt: number, quantity: number, liquidityAtEntry: number | null = null): PathMetricState {
  return { entryPrice, entryAt, quantity, maxPrice: null, minPrice: null, timeToMaxMs: null, timeToMinMs: null, milestones: {}, liquidityAtEntry: positive(liquidityAtEntry) ? liquidityAtEntry : null, lastLiquidity: null, minLiquidity: null, sampleCount: 0, lastPriceAt: null };
}

/** Folds one observed price (and optional pool liquidity) into the path state. Earlier/duplicate samples are ignored. */
export function advancePathMetric(previous: PathMetricState, price: number, at: number, liquidityUsd?: number | null): PathMetricState {
  if (!positive(price) || !positive(previous.entryPrice) || at < previous.entryAt) return previous;
  if (previous.lastPriceAt !== null && at <= previous.lastPriceAt) return previous;
  const state: PathMetricState = { ...previous, milestones: { ...previous.milestones } };
  const elapsed = at - state.entryAt;
  if (state.maxPrice === null || price > state.maxPrice) {
    state.maxPrice = price;
    state.timeToMaxMs = elapsed;
  }
  if (state.minPrice === null || price < state.minPrice) {
    state.minPrice = price;
    state.timeToMinMs = elapsed;
  }
  const change = (price / state.entryPrice - 1) * 100;
  // Small tolerance: 120 / 100 - 1 is 0.19999999999999996 in floating point.
  const EPSILON = 1e-9;
  for (const level of PROFIT_MILESTONES) if (change >= level - EPSILON && state.milestones[`+${level}`] === undefined) state.milestones[`+${level}`] = elapsed;
  for (const level of LOSS_MILESTONES) if (change <= -level + EPSILON && state.milestones[`-${level}`] === undefined) state.milestones[`-${level}`] = elapsed;
  if (positive(liquidityUsd)) {
    state.lastLiquidity = liquidityUsd;
    state.minLiquidity = state.minLiquidity === null ? liquidityUsd : Math.min(state.minLiquidity, liquidityUsd);
  }
  state.sampleCount += 1;
  state.lastPriceAt = at;
  return state;
}

export function summarizePathMetric(state: PathMetricState): PathMetricSummary {
  const entry = state.entryPrice;
  const mfePercent = state.maxPrice === null ? null : Math.max(0, (state.maxPrice / entry - 1) * 100);
  const maePercent = state.minPrice === null ? null : Math.min(0, (state.minPrice / entry - 1) * 100);
  return {
    maxPriceAfterEntry: state.maxPrice,
    minPriceAfterEntry: state.minPrice,
    mfePercent,
    mfeUsd: state.maxPrice === null ? null : Math.max(0, (state.maxPrice - entry) * state.quantity),
    timeToMfeMs: mfePercent !== null && mfePercent > 0 ? state.timeToMaxMs : null,
    maePercent,
    maeUsd: state.minPrice === null ? null : Math.min(0, (state.minPrice - entry) * state.quantity),
    timeToMaeMs: maePercent !== null && maePercent < 0 ? state.timeToMinMs : null,
    milestones: state.milestones,
    liquidityChangePercent: state.liquidityAtEntry && state.lastLiquidity ? (state.lastLiquidity / state.liquidityAtEntry - 1) * 100 : null,
    sampleCount: state.sampleCount,
  };
}

/**
 * Backfill from stored, timestamped market snapshots between entry and exit. Returns null when there is
 * not enough real data (never fabricates a path).
 */
export function pathMetricFromSeries(points: ReadonlyArray<{ t: number; price: number; liquidityUsd?: number | null }>, entryPrice: number, entryAt: number, exitAt: number, quantity: number, liquidityAtEntry: number | null = null, minPoints = 3): PathMetricState | null {
  const window = points.filter((point) => point.t >= entryAt && point.t <= exitAt && positive(point.price)).sort((a, b) => a.t - b.t);
  if (window.length < minPoints) return null;
  return window.reduce((state, point) => advancePathMetric(state, point.price, point.t, point.liquidityUsd ?? null), initPathMetric(entryPrice, entryAt, quantity, liquidityAtEntry));
}
