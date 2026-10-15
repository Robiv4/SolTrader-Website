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
export const ML_PAPER_THRESHOLD_MIN = 0.05;
export const ML_PAPER_THRESHOLD_MAX = 0.9;
export const ML_PAPER_WINDOW_MAX_SECONDS = 30;

/** Rule-based reasons the ML decision replaces (strategic entry signal only). Everything else is a safety blocker. */
export const ML_STRATEGY_ONLY_REASONS = [
  'TRANSACTIONS_BELOW_MINIMUM', 'UNIQUE_BUYERS_UNKNOWN', 'UNIQUE_BUYERS_BELOW_MINIMUM', 'BUY_SELL_RATIO_BELOW_MINIMUM',
  'LAUNCH_VOLUME_BELOW_MINIMUM', 'LAUNCH_SCORE_BELOW_MINIMUM', 'LAUNCH_EXHAUSTED',
] as const;

/**
 * DEFAULT-strategy preferences that never veto an ML entry (ML-only mode). They are still computed and stored next to the
 * ML decision for comparison, but the ML model alone makes the strategic BUY / SKIP decision:
 *  - the rule-based BUY / WATCH / REJECT decision and its score / momentum / exhaustion / activity thresholds;
 *  - the DEFAULT timing window (min. age, observation length, max. age): the ML decides at its own trained snapshot point;
 *  - the optional entry quality gate and the Social Intelligence AVOID filter;
 *  - the DEFAULT "max. liquidity" preference (a strategy preference, not a safety limit).
 */
export const ML_IGNORED_DEFAULT_FILTERS = [
  ...ML_STRATEGY_ONLY_REASONS,
  'LAUNCH_TOO_YOUNG', 'OBSERVATION_IN_PROGRESS', 'LAUNCH_WINDOW_EXPIRED', 'LIQUIDITY_ABOVE_MAXIMUM', 'INSUFFICIENT_LAUNCH_DATA',
  'QUALITY_GATE_FAILED', 'SOCIAL_AVOID',
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
  /** Safety / risk limits only (no DEFAULT strategy preference is read here). */
  settings: Pick<NewLaunchSettings, 'liquidityCriticalPercent' | 'maxRiskScore' | 'minLiquidityUsd' | 'maxPriceImpactPercent'>;
  detectedAt: number;
  now: number;
}

/**
 * Mandatory checks for an ML BUY (empty list = may proceed to PAPER execution, which applies position size, open
 * position, daily loss, emergency stop and exit-capacity limits on top). Unknown data never counts as safe.
 *
 * Only security, rug-pull, risk and market-data facts are read from `result` (its features and hard blocks); the
 * DEFAULT strategy's decision, scores and timing settings are never consulted (see ML_IGNORED_DEFAULT_FILTERS).
 */
export function mlEntrySafetyBlockers(input: MlEntrySafetyInput): string[] {
  const { result, security, settings } = input;
  const f = result.features;
  // Security (sellability failed, freeze authority, critical / transfer-fee extensions) + risk-engine hard blocks.
  const blockers = new Set<string>([...result.hardBlockReasons, ...input.riskHardBlockReasons]);
  if (security.sellability === 'FAILED') blockers.add('SELLABILITY_FAILED');
  if (security.sellability !== 'VERIFIED') blockers.add('SELLABILITY_NOT_VERIFIED');
  if (security.mintAuthorityRevoked === null || security.freezeAuthorityRevoked === null || security.tokenProgram === null) blockers.add(security.rpcUnavailable ? 'RPC_SECURITY_DATA_UNAVAILABLE' : 'SECURITY_CHECK_PENDING');
  if (security.mintAuthorityRevoked === false) blockers.add('MINT_AUTHORITY_ACTIVE');
  // Rug-pull signals.
  if (f.liquidityChange !== null && f.liquidityChange <= -settings.liquidityCriticalPercent) blockers.add('CRITICAL_LIQUIDITY');
  if (f.creatorSoldRatio !== null && f.creatorSoldRatio >= 0.5) blockers.add('CREATOR_SELLING');
  // Risk.
  if (input.riskScore === null) blockers.add('RISK_NOT_ASSESSED');
  else if (input.riskScore > settings.maxRiskScore) blockers.add('RISK_SCORE_ABOVE_LAUNCH_MAXIMUM');
  // Valid market data, liquidity and price impact (fail-closed on unknown values).
  if (f.priceUsd === null || !(f.priceUsd > 0)) blockers.add('MARKET_PRICE_UNKNOWN');
  if (f.liquidityUsd === null || f.liquidityUsd < settings.minLiquidityUsd) blockers.add('LIQUIDITY_BELOW_MINIMUM');
  if (f.estimatedPriceImpact === null) blockers.add('PRICE_IMPACT_UNKNOWN');
  else if (f.estimatedPriceImpact > settings.maxPriceImpactPercent) blockers.add('PRICE_IMPACT_TOO_HIGH');
  return [...blockers];
}

/**
 * Token-security blockers (token contract / authority / sellability / rug-pull facts). Only these may be switched off by
 * the user's experimental "token-security checks OFF" ML PAPER mode. Market data, price, liquidity, price impact, risk and
 * every account / execution limit stay mandatory in every mode.
 */
export const ML_TOKEN_SAFETY_BLOCKERS = new Set([
  'SELLABILITY_FAILED', 'SELLABILITY_NOT_VERIFIED', 'SECURITY_CHECK_PENDING', 'RPC_SECURITY_DATA_UNAVAILABLE',
  'MINT_AUTHORITY_ACTIVE', 'FREEZE_AUTHORITY_ACTIVE', 'CRITICAL_TOKEN_EXTENSION', 'UNSUPPORTED_TRANSFER_RESTRICTION',
  'CREATOR_SELLING', 'CRITICAL_LIQUIDITY', 'SELL_BLOCKED',
]);

/**
 * Splits ML BUY blockers by the user's token-security setting. With checks ON everything is enforced (unchanged). With
 * checks OFF the token-security blockers (incl. any hard block reported by the token security lookup itself) are only
 * returned as `ignored` warnings; everything else stays enforced.
 */
export function applyTokenSafetySetting(blockers: string[], tokenSafetyChecksEnabled: boolean, securityHardBlocks: string[] = []) {
  if (tokenSafetyChecksEnabled) return { enforced: blockers, ignored: [] as string[] };
  const securityOrigin = new Set(securityHardBlocks);
  const isTokenSafety = (reason: string) => ML_TOKEN_SAFETY_BLOCKERS.has(reason) || securityOrigin.has(reason);
  return { enforced: blockers.filter((reason) => !isTokenSafety(reason)), ignored: blockers.filter(isTokenSafety) };
}

/** Blockers that can never clear later for this candidate (the ML BUY is resolved as SAFETY_BLOCKED at once). */
export const ML_PERMANENT_BLOCKERS = new Set(['SELLABILITY_FAILED', 'CRITICAL_LIQUIDITY', 'CREATOR_SELLING', 'FREEZE_AUTHORITY_ACTIVE', 'CRITICAL_TOKEN_EXTENSION', 'UNSUPPORTED_TRANSFER_RESTRICTION']);

/**
 * Strategic conviction of an ML entry for the central risk decision: the model probability (0-100) against the approved
 * threshold. Replaces the DEFAULT Launch Score there, so the risk policy's extra conviction rules for HIGH / VERY_HIGH risk
 * (e.g. CONSERVATIVE + HIGH requires >= 80) are judged on the ML's own probability, never skipped.
 */
export function mlRiskConviction(probability: number | null, threshold: number | null) {
  const signalScore = probability !== null && Number.isFinite(probability) ? Math.round(probability * 1000) / 10 : Number.NaN;
  const bounded = threshold !== null && Number.isFinite(threshold) ? Math.min(ML_PAPER_THRESHOLD_MAX, Math.max(ML_PAPER_THRESHOLD_MIN, threshold)) : ML_PAPER_THRESHOLD_MAX;
  return { signalScore, minimumSignalScore: Math.round(bounded * 1000) / 10 };
}
