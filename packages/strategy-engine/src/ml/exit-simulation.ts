/**
 * Target B: net PAPER result of a hypothetical New Launch PAPER entry at the snapshot, simulated on the stored SHADOW
 * price path (ML-LABELS-v1 buckets) with the documented New Launch exit rules and the PAPER cost model.
 *
 * Inputs are only the path recorded AFTER the snapshot (the label), never features. Conservative by construction:
 *  - inside one bucket the order of high and low is unknown: if a stop and a take-profit are both reachable, the STOP
 *    is assumed (pessimistic);
 *  - a trailing / break-even stop raised by a bucket's high only applies from the NEXT bucket;
 *  - a data gap or the end of observation (migration, budget) before the exit -> UNKNOWN (never guessed);
 *  - no exit within the observed hour -> marked to market at the last close (exit reason HORIZON).
 *
 * Costs (same formulas as the PAPER fill model in @soltrader/trading-engine paper-fills / paper-accounting):
 *   impact% = 0.1 + 100 * notional / (liquidity / 2 + notional)   (0.1% latency allowance without liquidity)
 *   BUY fill = price * (1 + impact%), SELL fill = price * (1 - impact%), fee = 0.30% of the filled notional per side.
 */
import type { OutcomePathState } from './outcomes.js';

export const SIM_EXIT_LABEL_VERSION = 'SIM-EXIT-v1';
const FEE_RATE = 30 / 10_000;
const LATENCY_SLIPPAGE_PERCENT = 0.1;

export interface SimExitRules {
  stopLossPercent: number;
  takeProfitPercent: number;
  breakEvenEnabled: boolean;
  breakEvenActivationPercent: number;
  breakEvenCostBufferPercent: number;
  trailingEnabled: boolean;
  trailingActivationPercent: number;
  trailingDistancePercent: number;
  maxHoldEnabled: boolean;
  maxHoldMinutes: number;
  liquiditySafetyExitEnabled: boolean;
  liquidityDropExitPercent: number;
}

export type SimExitReason = 'STOP_LOSS' | 'BREAK_EVEN' | 'TRAILING_STOP' | 'TAKE_PROFIT' | 'LIQUIDITY_SAFETY' | 'MAX_HOLD_TIME' | 'HORIZON';

export interface SimExitResult {
  status: 'RESOLVED' | 'UNKNOWN';
  reason: SimExitReason | null;
  unknownReason: string | null;
  exitOffsetMs: number | null;
  netReturnPct: number | null;
  grossReturnPct: number | null;
}

export function impactPercent(notionalUsd: number, liquidityUsd: number | null) {
  if (!(liquidityUsd !== null && liquidityUsd > 0) || !(notionalUsd > 0)) return LATENCY_SLIPPAGE_PERCENT;
  return Math.min(99, LATENCY_SLIPPAGE_PERCENT + 100 * notionalUsd / (liquidityUsd / 2 + notionalUsd));
}

const unknown = (why: string): SimExitResult => ({ status: 'UNKNOWN', reason: null, unknownReason: why, exitOffsetMs: null, netReturnPct: null, grossReturnPct: null });

/** Simulates one PAPER position of `positionUsd` opened at the snapshot's reference price. */
export function simulateNewLaunchExit(path: OutcomePathState, rules: SimExitRules, positionUsd = 20): SimExitResult {
  if (!(path.entryPrice > 0) || !path.buckets.length) return unknown('NO_PATH');
  const entryFill = path.entryPrice * (1 + impactPercent(positionUsd, path.entryLiquidity) / 100);
  const quantity = positionUsd / entryFill;
  const maxHoldMs = rules.maxHoldEnabled ? rules.maxHoldMinutes * 60_000 : Number.POSITIVE_INFINITY;
  let stop = entryFill * (1 - rules.stopLossPercent / 100);
  let stopReason: SimExitReason = 'STOP_LOSS';
  const takeProfit = entryFill * (1 + rules.takeProfitPercent / 100);
  let highest = entryFill;
  let trailingActive = false;
  const gapBefore = (absolute: number) => path.gaps.some(([from]) => from < absolute);

  const finish = (reason: SimExitReason, offsetMs: number, marketPrice: number, liquidity: number | null): SimExitResult => {
    const absolute = path.startAt + offsetMs;
    if (gapBefore(absolute)) return unknown('DATA_GAP_BEFORE_EXIT');
    const exitFill = marketPrice * (1 - impactPercent(quantity * marketPrice, liquidity ?? path.entryLiquidity) / 100);
    const proceeds = quantity * exitFill;
    const net = proceeds - proceeds * FEE_RATE - positionUsd - positionUsd * FEE_RATE;
    return { status: 'RESOLVED', reason, unknownReason: null, exitOffsetMs: offsetMs, netReturnPct: Math.round(net / positionUsd * 1e6) / 1e4, grossReturnPct: Math.round((marketPrice / path.entryPrice - 1) * 1e6) / 1e4 };
  };

  for (const [offset, high, low, close, , minLiquidity] of path.buckets) {
    if (offset >= maxHoldMs) return finish('MAX_HOLD_TIME', maxHoldMs, close, minLiquidity);
    if (path.endedAt !== null && path.startAt + offset > path.endedAt) return unknown('OBSERVATION_ENDED');
    // Stops first (pessimistic order inside a bucket), with the stop level known BEFORE this bucket.
    if (low <= stop) return finish(stopReason, offset, Math.min(stop, close > stop ? stop : close), minLiquidity);
    if (rules.liquiditySafetyExitEnabled && minLiquidity !== null && path.entryLiquidity && minLiquidity <= path.entryLiquidity * (1 - rules.liquidityDropExitPercent / 100)) {
      return finish('LIQUIDITY_SAFETY', offset, close, minLiquidity);
    }
    if (high >= takeProfit) return finish('TAKE_PROFIT', offset, takeProfit, minLiquidity);
    // Raise the stop for the next bucket.
    highest = Math.max(highest, high);
    if (rules.breakEvenEnabled && highest >= entryFill * (1 + rules.breakEvenActivationPercent / 100)) {
      const breakEven = entryFill * (1 + rules.breakEvenCostBufferPercent / 100);
      if (breakEven > stop) {
        stop = breakEven;
        stopReason = 'BREAK_EVEN';
      }
    }
    if (rules.trailingEnabled && (trailingActive || highest >= entryFill * (1 + rules.trailingActivationPercent / 100))) {
      trailingActive = true;
      const trailing = highest * (1 - rules.trailingDistancePercent / 100);
      if (trailing > stop) {
        stop = trailing;
        stopReason = 'TRAILING_STOP';
      }
    }
  }
  const last = path.buckets[path.buckets.length - 1];
  // A normal end of the observation window (HORIZON_REACHED) is mark-to-market at the last real bucket; any other end
  // (migration, budget, restart) leaves the rest of the position's life unobserved.
  if (path.endedAt !== null && path.endReason !== 'HORIZON_REACHED') return unknown('OBSERVATION_ENDED');
  return finish('HORIZON', last[0], last[3], last[5]);
}
