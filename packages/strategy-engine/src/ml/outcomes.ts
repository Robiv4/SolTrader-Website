/**
 * Shadow outcome tracking (ML-LABELS-v1): what really happened after an immutable feature snapshot.
 *
 * The price path is stored compactly as time buckets (1 s for the first 2 min, 5 s up to 10 min, 15 s up to
 * 60 min) with high / low / close per bucket, so MFE / MAE stay exact and first-hit ordering is exact across
 * buckets. If an up and a down threshold are first crossed inside the SAME bucket the order is unknowable from the
 * stored path -> the label is UNKNOWN (never guessed).
 *
 * Data validity: on a bonding curve the price only moves on trades, so "no trade" means "unchanged price" WHILE the
 * trade stream is healthy. Stream gaps (and the end of observation, e.g. migration off the curve) are recorded;
 * a horizon overlapping a gap or ending after the end of observation is not valid.
 */
export const ML_LABEL_VERSION = 'ML-LABELS-v1';
export const OUTCOME_HORIZONS_S = [10, 30, 60, 120, 300, 600, 900, 1800, 3600] as const;
export type OutcomeHorizon = (typeof OUTCOME_HORIZONS_S)[number];
export const EVENT_UP_LEVELS = [3, 5, 10, 15, 20, 25, 50] as const;
export const EVENT_DOWN_LEVELS = [3, 5, 10, 15, 20, 25] as const;
export const PATH_LABELS = [
  { name: 'plus10BeforeMinus10', up: 10, down: 10 },
  { name: 'plus20BeforeMinus10', up: 20, down: 10 },
  { name: 'plus20BeforeMinus15', up: 20, down: 15 },
  { name: 'plus25BeforeMinus20', up: 25, down: 20 },
  { name: 'plus50BeforeMinus20', up: 50, down: 20 },
] as const;
const LAST_HORIZON_MS = OUTCOME_HORIZONS_S[OUTCOME_HORIZONS_S.length - 1] * 1000;
/** Event and path labels are evaluated within this horizon. */
export const LABEL_HORIZON_S = 1800;

/** One bucket: [offsetMs (bucket start from snapshot), high, low, close, trades, minLiquidity|null]. */
export type PathBucket = [number, number, number, number, number, number | null];

export interface OutcomePathState {
  startAt: number;
  entryPrice: number;
  entryLiquidity: number | null;
  buckets: PathBucket[];
  /** Intervals [fromMs, toMs] (absolute) without trustworthy data (stream down, polling gap). */
  gaps: Array<[number, number]>;
  /** Observation ended (migration, budget, tracker stop); null = still observing. */
  endedAt: number | null;
  endReason: string | null;
  /** Creator sold tokens after the snapshot (trade stream), absolute time of the first such sell. */
  creatorSellAt: number | null;
  /**
   * Time of the last persisted copy of this path (absolute ms). Data up to this time is trustworthy apart from the
   * recorded gaps; after a worker restart the unobserved interval starts here (not at the last trade).
   */
  persistedAt?: number;
}

export function bucketSizeMs(offsetMs: number) {
  return offsetMs < 120_000 ? 1_000 : offsetMs < 600_000 ? 5_000 : 15_000;
}

export function newOutcomePath(startAt: number, entryPrice: number, entryLiquidity: number | null): OutcomePathState {
  return { startAt, entryPrice, entryLiquidity, buckets: [], gaps: [], endedAt: null, endReason: null, creatorSellAt: null };
}

/** Adds one observed price (trade / market data). Points before the snapshot or after the end are ignored. */
export function recordPathPoint(path: OutcomePathState, at: number, price: number, liquidity: number | null = null) {
  if (!(price > 0) || at < path.startAt || (path.endedAt !== null && at > path.endedAt)) return;
  const offset = at - path.startAt;
  if (offset > LAST_HORIZON_MS) return;
  const size = bucketSizeMs(offset);
  const start = Math.floor(offset / size) * size;
  const last = path.buckets[path.buckets.length - 1];
  if (last && last[0] === start) {
    last[1] = Math.max(last[1], price);
    last[2] = Math.min(last[2], price);
    last[3] = price;
    last[4] += 1;
    if (liquidity !== null) last[5] = last[5] === null ? liquidity : Math.min(last[5], liquidity);
  } else if (!last || start > last[0]) {
    path.buckets.push([start, price, price, price, 1, liquidity]);
  }
}


export interface HorizonOutcome {
  valid: boolean;
  returnPct: number | null;
  mfePct: number | null;
  maePct: number | null;
  highestPrice: number | null;
  lowestPrice: number | null;
  timeToMfeS: number | null;
  timeToMaeS: number | null;
}

export type TriState = boolean | null;

export interface CandidateOutcomeResult {
  labelVersion: string;
  quality: 'COMPLETE' | 'PARTIAL' | 'INSUFFICIENT';
  validHorizons: number[];
  horizons: Record<string, HorizonOutcome>;
  /** reachedPlusX / reachedMinusX within LABEL_HORIZON_S (true / false / null = unknown). */
  events: Record<string, TriState>;
  /** First-hit ordering labels within LABEL_HORIZON_S (true / false / null = unknown or ambiguous). */
  pathLabels: Record<string, TriState>;
  failures: {
    /** Bonding-curve / pool liquidity fell >= 70 % below the snapshot liquidity within 30 min. */
    liquidityCollapse: TriState;
    /** Liquidity collapse AND the creator sold after the snapshot (documented rug-like pattern, not proof). */
    rugLikeFailure: TriState;
    /** MAE <= -50 % within 30 min. */
    extremeDrawdown: TriState;
    /** Observation ended (or a data gap) before 30 min. */
    marketDataLost: boolean;
    /** Not observable without a real sell attempt: always null in v1. */
    sellabilityFailureAfterEntry: null;
  };
}

/** Evaluates all horizons and labels at time `now` (pure; deterministic for the same path). */
export function computeCandidateOutcome(path: OutcomePathState, now: number): CandidateOutcomeResult {
  const observedUntil = Math.min(now, path.endedAt ?? Number.POSITIVE_INFINITY);
  const entry = path.entryPrice;
  const pct = (price: number) => (price / entry - 1) * 100;
  const gapIn = (from: number, to: number) => path.gaps.some(([start, end]) => start < to && end > from);

  const horizons: Record<string, HorizonOutcome> = {};
  const validHorizons: number[] = [];
  for (const horizon of OUTCOME_HORIZONS_S) {
    const endAt = path.startAt + horizon * 1000;
    const valid = endAt <= observedUntil && !gapIn(path.startAt, endAt);
    const inside = path.buckets.filter((bucket) => bucket[0] < horizon * 1000);
    if (!valid) {
      horizons[horizon] = { valid: false, returnPct: null, mfePct: null, maePct: null, highestPrice: null, lowestPrice: null, timeToMfeS: null, timeToMaeS: null };
      continue;
    }
    validHorizons.push(horizon);
    let high = entry;
    let low = entry;
    let highAt = 0;
    let lowAt = 0;
    for (const bucket of inside) {
      if (bucket[1] > high) {
        high = bucket[1];
        highAt = bucket[0];
      }
      if (bucket[2] < low) {
        low = bucket[2];
        lowAt = bucket[0];
      }
    }
    // Price at the horizon: last close at or before it (unchanged price between trades on a healthy stream).
    const close = inside.length ? inside[inside.length - 1][3] : entry;
    horizons[horizon] = {
      valid: true, returnPct: pct(close), mfePct: pct(high), maePct: pct(low), highestPrice: high, lowestPrice: low,
      timeToMfeS: high > entry ? highAt / 1000 : null, timeToMaeS: low < entry ? lowAt / 1000 : null,
    };
  }

  const labelEnd = path.startAt + LABEL_HORIZON_S * 1000;
  const labelWindowValid = labelEnd <= observedUntil && !gapIn(path.startAt, labelEnd);
  // Data is trustworthy up to the first gap / end of observation.
  const firstGap = path.gaps.filter(([, end]) => end > path.startAt).map(([start]) => start).sort((a, b) => a - b)[0] ?? Number.POSITIVE_INFINITY;
  const trustedUntil = Math.min(observedUntil, firstGap, labelEnd);
  const trusted = path.buckets.filter((bucket) => path.startAt + bucket[0] < trustedUntil);

  const firstHit = (predicate: (bucket: PathBucket) => boolean) => trusted.find(predicate)?.[0] ?? null;
  const events: Record<string, TriState> = {};
  for (const level of EVENT_UP_LEVELS) {
    const hit = firstHit((bucket) => pct(bucket[1]) >= level);
    events[`reachedPlus${level}`] = hit !== null ? true : labelWindowValid ? false : null;
  }
  for (const level of EVENT_DOWN_LEVELS) {
    const hit = firstHit((bucket) => pct(bucket[2]) <= -level);
    events[`reachedMinus${level}`] = hit !== null ? true : labelWindowValid ? false : null;
  }
  const pathLabels: Record<string, TriState> = {};
  for (const label of PATH_LABELS) {
    const up = firstHit((bucket) => pct(bucket[1]) >= label.up);
    const down = firstHit((bucket) => pct(bucket[2]) <= -label.down);
    if (up !== null && down !== null) pathLabels[label.name] = up === down ? null : up < down;
    else if (up !== null) pathLabels[label.name] = true;
    else if (down !== null) pathLabels[label.name] = false;
    // Neither threshold within the full, gap-free window: the target was not reached.
    else pathLabels[label.name] = labelWindowValid ? false : null;
  }

  const minLiquidity = trusted.reduce<number | null>((min, bucket) => (bucket[5] === null ? min : min === null ? bucket[5] : Math.min(min, bucket[5])), null);
  const liquidityCollapse: TriState = path.entryLiquidity && path.entryLiquidity > 0
    ? (minLiquidity !== null && minLiquidity <= path.entryLiquidity * 0.3 ? true : labelWindowValid ? false : null)
    : null;
  const mae30 = horizons[LABEL_HORIZON_S]?.valid ? horizons[LABEL_HORIZON_S].maePct : null;
  const extremeDrawdown: TriState = firstHit((bucket) => pct(bucket[2]) <= -50) !== null ? true : mae30 !== null ? false : null;
  const creatorSold = path.creatorSellAt !== null && path.creatorSellAt <= trustedUntil;
  const quality = validHorizons.includes(LABEL_HORIZON_S) ? 'COMPLETE' : validHorizons.length ? 'PARTIAL' : 'INSUFFICIENT';
  return {
    labelVersion: ML_LABEL_VERSION,
    quality,
    validHorizons,
    horizons,
    events,
    pathLabels,
    failures: {
      liquidityCollapse,
      rugLikeFailure: liquidityCollapse === true ? creatorSold : liquidityCollapse === false ? false : null,
      extremeDrawdown,
      marketDataLost: (path.endedAt !== null && path.endedAt < labelEnd) || gapIn(path.startAt, labelEnd),
      sellabilityFailureAfterEntry: null,
    },
  };
}
