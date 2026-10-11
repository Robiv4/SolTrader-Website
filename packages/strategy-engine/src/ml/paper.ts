/**
 * ML PAPER entry policy (pure, no I/O). An approved ML model may replace ONLY the strategic entry signal of the
 * rule-based New Launch strategy (score / activity thresholds). Every mandatory safety, risk and liquidity rule stays in
 * force and is evaluated here independently of the rule-based decision order (no early return can hide a blocker).
 *
 * Timing: the model is trained on snapshots taken at a fixed point after detection (e.g. AGE_30S). The ML decision is
 * made exactly once, at that point, from the features known at that moment; it is never re-made later with newer data
 * and never back-dated. An entry may follow only after the decision (inside a short window, safety re-checked).
 */
import type { LaunchSecurity, NewLaunchSettings, NewLaunchStrategyResult } from '../launch/index.js';

/** Snapshot kinds an ML PAPER model may be trained on, with their prediction point (ms after detection). */
export const ML_PAPER_SNAPSHOT_POINTS: Record<string, number> = { AGE_15S: 15_000, AGE_30S: 30_000, AGE_60S: 60_000 };
/** A prediction point missed by more than this (worker busy / restarted) is skipped, never decided late. */
export const ML_PAPER_POINT_TOLERANCE_MS = 10_000;
export const ML_PAPER_THRESHOLD_MIN = 0.5;
export const ML_PAPER_THRESHOLD_MAX = 0.9;
export const ML_PAPER_WINDOW_MAX_SECONDS = 30;

/** Rule-based reasons the ML decision replaces (strategic entry signal only). Everything else is a safety blocker. */
export const ML_STRATEGY_ONLY_REASONS = [
  'TRANSACTIONS_BELOW_MINIMUM', 'UNIQUE_BUYERS_UNKNOWN', 'UNIQUE_BUYERS_BELOW_MINIMUM', 'BUY_SELL_RATIO_BELOW_MINIMUM',
  'LAUNCH_VOLUME_BELOW_MINIMUM', 'LAUNCH_SCORE_BELOW_MINIMUM', 'LAUNCH_EXHAUSTED',
] as const;

export type MlPaperTiming = 'WAIT' | 'DECIDE' | 'MISSED';

/** Where a candidate is relative to the model's prediction point. */
export function mlDecisionTiming(detectedAt: number, snapshotAgeMs: number, now: number): MlPaperTiming {
  const age = now - detectedAt;
  if (age < snapshotAgeMs) return 'WAIT';
  return age > snapshotAgeMs + ML_PAPER_POINT_TOLERANCE_MS ? 'MISSED' : 'DECIDE';
}

/** ML BUY vs SKIP for a calibrated probability (threshold clamped to the allowed range). */
export function classifyMlProbability(probability: number, threshold: number): 'ML_BUY' | 'ML_SKIP' {
  const bounded = Math.min(ML_PAPER_THRESHOLD_MAX, Math.max(ML_PAPER_THRESHOLD_MIN, threshold));
  return Number.isFinite(probability) && probability >= bounded ? 'ML_BUY' : 'ML_SKIP';
}

/** An ML BUY may only be executed after its decision and within the configured window. */
export function mlBuyWindowOpen(decidedAt: number, windowSeconds: number, now: number) {
  const window = Math.min(ML_PAPER_WINDOW_MAX_SECONDS, Math.max(0, windowSeconds)) * 1000;
  return now >= decidedAt && now - decidedAt <= window;
}

export interface MlEntrySafetyInput {
  result: NewLaunchStrategyResult;
  security: LaunchSecurity;
  riskScore: number | null;
  /** Risk-engine hard blocks (already filtered for waitable launch blocks). */
  riskHardBlockReasons: string[];
  settings: Pick<NewLaunchSettings, 'maxAgeSeconds' | 'minAgeSeconds' | 'observationSeconds' | 'liquidityCriticalPercent' | 'maxRiskScore' | 'maxLiquidityUsd' | 'minLiquidityUsd' | 'maxPriceImpactPercent'>;
  detectedAt: number;
  now: number;
}

/**
 * Mandatory checks for an ML BUY (empty list = may proceed to PAPER execution, which applies position size, open
 * position, daily loss, emergency stop and exit-capacity limits on top). Unknown data never counts as safe.
 */
export function mlEntrySafetyBlockers(input: MlEntrySafetyInput): string[] {
  const { result, security, settings } = input;
  const f = result.features;
  const blockers = new Set<string>([...result.hardBlockReasons, ...input.riskHardBlockReasons]);
  if (security.sellability === 'FAILED') blockers.add('SELLABILITY_FAILED');
  if (f.ageSeconds > settings.maxAgeSeconds) blockers.add('LAUNCH_WINDOW_EXPIRED');
  if (f.liquidityChange !== null && f.liquidityChange <= -settings.liquidityCriticalPercent) blockers.add('CRITICAL_LIQUIDITY');
  if (f.creatorSoldRatio !== null && f.creatorSoldRatio >= 0.5) blockers.add('CREATOR_SELLING');
  if (f.ageSeconds < settings.minAgeSeconds) blockers.add('LAUNCH_TOO_YOUNG');
  if ((input.now - input.detectedAt) / 1000 < settings.observationSeconds) blockers.add('OBSERVATION_IN_PROGRESS');
  if (result.dataQuality < 40 || result.score === null) blockers.add('INSUFFICIENT_LAUNCH_DATA');
  if (input.riskScore === null) blockers.add('RISK_NOT_ASSESSED');
  else if (input.riskScore > settings.maxRiskScore) blockers.add('RISK_SCORE_ABOVE_LAUNCH_MAXIMUM');
  if (settings.maxLiquidityUsd !== null && f.liquidityUsd !== null && f.liquidityUsd > settings.maxLiquidityUsd) blockers.add('LIQUIDITY_ABOVE_MAXIMUM');
  if (security.sellability !== 'VERIFIED') blockers.add('SELLABILITY_NOT_VERIFIED');
  if (security.mintAuthorityRevoked === null || security.freezeAuthorityRevoked === null || security.tokenProgram === null) blockers.add(security.rpcUnavailable ? 'RPC_SECURITY_DATA_UNAVAILABLE' : 'SECURITY_CHECK_PENDING');
  if (security.mintAuthorityRevoked === false) blockers.add('MINT_AUTHORITY_ACTIVE');
  if (f.liquidityUsd === null || f.liquidityUsd < settings.minLiquidityUsd) blockers.add('LIQUIDITY_BELOW_MINIMUM');
  if (f.estimatedPriceImpact === null) blockers.add('PRICE_IMPACT_UNKNOWN');
  else if (f.estimatedPriceImpact > settings.maxPriceImpactPercent) blockers.add('PRICE_IMPACT_TOO_HIGH');
  return [...blockers];
}

/** Blockers that can never clear later for this candidate (the ML BUY is resolved as SAFETY_BLOCKED at once). */
export const ML_PERMANENT_BLOCKERS = new Set(['SELLABILITY_FAILED', 'LAUNCH_WINDOW_EXPIRED', 'CRITICAL_LIQUIDITY', 'CREATOR_SELLING', 'FREEZE_AUTHORITY_ACTIVE', 'CRITICAL_TOKEN_EXTENSION', 'UNSUPPORTED_TRANSFER_RESTRICTION', 'LIQUIDITY_ABOVE_MAXIMUM']);
