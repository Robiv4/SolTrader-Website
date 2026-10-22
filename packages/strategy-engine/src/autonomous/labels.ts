/**
 * AUTO-LABELS-v1: counterfactual training labels for the Autonomous ML engine from a recorded outcome path
 * (MlCandidateOutcome.path: 1 s / 5 s / 15 s buckets from the path start, up to 60 min).
 *
 *   ENTRY at t:    net result of buying the reference order at t and selling it at t + H (H = 10 min), after fees and
 *                  the PAPER impact model at the liquidity of each moment; plus the worst net result inside the horizon
 *                  (downside). The model also learns SKIP: rows with a negative expected value are SKIP examples.
 *   POSITION at t: hold advantage = net of selling at t + H_hold (2 min) minus net of selling now (both exit-side
 *                  costs included; entry costs are sunk and identical).
 *
 * Only what the path really shows is used. A label is EXCLUDED (never guessed) when the price at t is unknown, a data
 * gap overlaps [t, t + H], observation ended before t + H (migration, budget, restart) or the horizon is beyond the
 * path. Uncertainty is recorded: bucket resolution at the horizon and whether the liquidity had to be assumed.
 * No exit rule (stop loss / take profit / trailing) is part of any label.
 */
import { impactPercent } from '../ml/exit-simulation.js';
import { bucketSizeMs, type OutcomePathState } from '../ml/outcomes.js';

import { AUTONOMOUS_FEE_RATE, type AutonomousPositionState, type MarketSample } from './features.js';

export const AUTONOMOUS_LABEL_VERSION = 'AUTO-LABELS-v1';
export const ENTRY_HORIZON_MS = 600_000;
export const HOLD_HORIZON_MS = 120_000;
/** Decision points of replayed positions (after the path start = entry). */
export const REPLAY_POSITION_OFFSETS_MS = [30_000, 60_000, 120_000, 180_000, 300_000, 450_000, 600_000, 900_000, 1_200_000, 1_800_000];
const PATH_END_MS = 3_600_000;

export type LabelExclusion = 'NO_PATH' | 'BEFORE_PATH_START' | 'NO_PRICE_AT_T' | 'DATA_GAP' | 'OBSERVATION_ENDED' | 'HORIZON_BEYOND_PATH';

export interface PathPoint { price: number; liquidityUsd: number | null; resolutionMs: number; liquidityAssumed: boolean }

/**
 * Price known AT `absolute` (close of the last bucket that ended by then; the path start price before any bucket).
 * `forward` = price used for a future exit at `absolute` (close of the bucket containing it: resolution = bucket size).
 */
export function pathPriceAt(path: OutcomePathState, absolute: number, mode: 'known' | 'forward'): PathPoint | null {
  const offset = absolute - path.startAt;
  if (offset < 0 || !(path.entryPrice > 0)) return null;
  let price = path.entryPrice;
  let liquidity: number | null = path.entryLiquidity;
  let resolution = 0;
  for (const [start, , , close, , minLiquidity] of path.buckets) {
    const end = start + bucketSizeMs(start);
    const usable = mode === 'known' ? end <= offset : start <= offset;
    if (!usable) break;
    price = close;
    if (minLiquidity !== null) liquidity = minLiquidity;
    resolution = mode === 'forward' && end > offset ? bucketSizeMs(start) : 0;
  }
  return { price, liquidityUsd: liquidity, resolutionMs: resolution, liquidityAssumed: liquidity === path.entryLiquidity && path.buckets.every(([, , , , , minLiquidity]) => minLiquidity === null) };
}

/** Lowest price inside (from, to] (bucket lows; conservative for downside). */
function lowestBetween(path: OutcomePathState, from: number, to: number) {
  let low: number | null = null;
  for (const [start, , bucketLow] of path.buckets) {
    const absoluteStart = path.startAt + start;
    if (absoluteStart + bucketSizeMs(start) <= from || absoluteStart > to) continue;
    low = low === null ? bucketLow : Math.min(low, bucketLow);
  }
  return low;
}

function horizonExclusion(path: OutcomePathState | null, t: number, horizonMs: number): LabelExclusion | null {
  if (!path) return 'NO_PATH';
  if (t < path.startAt) return 'BEFORE_PATH_START';
  const end = t + horizonMs;
  if (end - path.startAt > PATH_END_MS) return 'HORIZON_BEYOND_PATH';
  if (path.gaps.some(([from, to]) => from < end && to > t)) return 'DATA_GAP';
  if (path.endedAt !== null && path.endedAt < end && path.endReason !== 'HORIZON_REACHED') return 'OBSERVATION_ENDED';
  if (path.endedAt === null && path.persistedAt !== undefined && path.persistedAt < end) return 'OBSERVATION_ENDED';
  return null;
}

const netOf = (quantity: number, exitPrice: number, liquidity: number | null, costBasisUsd: number) => {
  const proceeds = quantity * exitPrice * (1 - impactPercent(quantity * exitPrice, liquidity) / 100) * (1 - AUTONOMOUS_FEE_RATE);
  return (proceeds / costBasisUsd - 1) * 100;
};

export interface EntryLabel {
  status: 'LABELLED' | 'EXCLUDED';
  exclusion: LabelExclusion | null;
  netReturnPct: number | null;
  downsideNetPct: number | null;
  grossReturnPct: number | null;
  /** Fees + impact of the round trip (gross - net). */
  costPct: number | null;
  /** Entry impact part of the cost (for liquidity stress tests). */
  entryImpactPct: number | null;
  exitImpactPct: number | null;
  horizonResolutionMs: number | null;
  liquidityAssumed: boolean;
  labelEndAt: number;
}

export function labelEntry(path: OutcomePathState | null, t: number, referenceOrderUsd = 20, horizonMs = ENTRY_HORIZON_MS): EntryLabel {
  const empty = (exclusion: LabelExclusion): EntryLabel => ({ status: 'EXCLUDED', exclusion, netReturnPct: null, downsideNetPct: null, grossReturnPct: null, costPct: null, entryImpactPct: null, exitImpactPct: null, horizonResolutionMs: null, liquidityAssumed: false, labelEndAt: t + horizonMs });
  const exclusion = horizonExclusion(path, t, horizonMs);
  if (exclusion) return empty(exclusion);
  const now = pathPriceAt(path!, t, 'known');
  const later = pathPriceAt(path!, t + horizonMs, 'forward');
  if (!now || !later) return empty('NO_PRICE_AT_T');
  const entryImpact = impactPercent(referenceOrderUsd, now.liquidityUsd);
  const fill = now.price * (1 + entryImpact / 100);
  const quantity = referenceOrderUsd / fill;
  const costBasis = referenceOrderUsd * (1 + AUTONOMOUS_FEE_RATE);
  const net = netOf(quantity, later.price, later.liquidityUsd, costBasis);
  const low = lowestBetween(path!, t, t + horizonMs) ?? later.price;
  const downside = Math.min(net, netOf(quantity, low, later.liquidityUsd, costBasis));
  const gross = (later.price / now.price - 1) * 100;
  return {
    status: 'LABELLED', exclusion: null, netReturnPct: net, downsideNetPct: downside, grossReturnPct: gross, costPct: gross - net, entryImpactPct: entryImpact,
    exitImpactPct: impactPercent(quantity * later.price, later.liquidityUsd), horizonResolutionMs: later.resolutionMs, liquidityAssumed: now.liquidityAssumed || later.liquidityAssumed, labelEndAt: t + horizonMs,
  };
}

export interface PositionLabel {
  status: 'LABELLED' | 'EXCLUDED';
  exclusion: LabelExclusion | null;
  /** Net of selling at t + H minus net of selling now (percentage points of the cost basis). */
  holdAdvantagePct: number | null;
  sellNowNetPct: number | null;
  sellLaterNetPct: number | null;
  horizonResolutionMs: number | null;
  liquidityAssumed: boolean;
  labelEndAt: number;
}

export function labelPosition(path: OutcomePathState | null, t: number, position: Pick<AutonomousPositionState, 'quantity' | 'entryFillPrice'>, horizonMs = HOLD_HORIZON_MS): PositionLabel {
  const empty = (exclusion: LabelExclusion): PositionLabel => ({ status: 'EXCLUDED', exclusion, holdAdvantagePct: null, sellNowNetPct: null, sellLaterNetPct: null, horizonResolutionMs: null, liquidityAssumed: false, labelEndAt: t + horizonMs });
  const exclusion = horizonExclusion(path, t, horizonMs);
  if (exclusion) return empty(exclusion);
  const now = pathPriceAt(path!, t, 'known');
  const later = pathPriceAt(path!, t + horizonMs, 'forward');
  if (!now || !later) return empty('NO_PRICE_AT_T');
  const costBasis = position.quantity * position.entryFillPrice * (1 + AUTONOMOUS_FEE_RATE);
  const sellNow = netOf(position.quantity, now.price, now.liquidityUsd, costBasis);
  const sellLater = netOf(position.quantity, later.price, later.liquidityUsd, costBasis);
  return { status: 'LABELLED', exclusion: null, holdAdvantagePct: sellLater - sellNow, sellNowNetPct: sellNow, sellLaterNetPct: sellLater, horizonResolutionMs: later.resolutionMs, liquidityAssumed: now.liquidityAssumed || later.liquidityAssumed, labelEndAt: t + horizonMs };
}

/** Market samples known at `t` from a path (start price + closes of buckets that ended by t; cumulative trades). */
export function pathSamples(path: OutcomePathState, t: number): MarketSample[] {
  const samples: MarketSample[] = [{ t: path.startAt, price: path.entryPrice, liquidityUsd: path.entryLiquidity, tradeCount: 0 }];
  let trades = 0;
  let liquidity = path.entryLiquidity;
  for (const [start, , , close, count, minLiquidity] of path.buckets) {
    const end = path.startAt + start + bucketSizeMs(start);
    if (end > t) break;
    trades += count;
    if (minLiquidity !== null) liquidity = minLiquidity;
    samples.push({ t: end, price: close, liquidityUsd: liquidity, tradeCount: trades });
  }
  return samples;
}

/**
 * Replayed position state at t: entry of the reference order at the path start, highs / lows from buckets that ended
 * by t only (no look-ahead).
 */
export function replayPosition(path: OutcomePathState, t: number, referenceOrderUsd = 20): AutonomousPositionState | null {
  if (!(path.entryPrice > 0) || t < path.startAt) return null;
  const entryImpactPct = impactPercent(referenceOrderUsd, path.entryLiquidity);
  const fill = path.entryPrice * (1 + entryImpactPct / 100);
  let high = path.entryPrice;
  let low = path.entryPrice;
  for (const [start, bucketHigh, bucketLow] of path.buckets) {
    if (path.startAt + start + bucketSizeMs(start) > t) break;
    high = Math.max(high, bucketHigh);
    low = Math.min(low, bucketLow);
  }
  return { openedAt: path.startAt, entryFillPrice: fill, entryMarketPrice: path.entryPrice, entryNotionalUsd: referenceOrderUsd, entryImpactPct, highestPrice: high, lowestPrice: low, quantity: referenceOrderUsd / fill, partiallySold: false };
}
