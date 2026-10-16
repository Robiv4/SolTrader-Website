/**
 * ML PAPER entry policy (pure, no I/O). An approved ML model may replace ONLY the strategic entry signal of the
 * rule-based New Launch strategy (score / activity thresholds). Every mandatory safety, risk and liquidity rule stays in
 * force and is evaluated here independently of the rule-based decision order (no early return can hide a blocker).
 *
 * Timing: the model is trained on snapshots taken at a fixed point after detection (e.g. AGE_30S). The ML decision is
 * made exactly once, at that point, from the features known at that moment; it is never re-made later with newer data
 * and never back-dated. An entry may follow only after the decision (inside a short window, safety re-checked).
 */
import { evaluateLaunchSecurityBlocks, type LaunchSecurity, type NewLaunchSettings, type NewLaunchStrategyResult } from '../launch/index.js';

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
 * Fraud / honeypot protection of an ML BUY (mandatory in every mode; no setting, model score or threshold overrides it).
 *
 * A separate, documented security decision built only from the existing, verifiable token-security rules - never a
 * single score, and no single soft indicator is treated as fraud on its own:
 *  - SELLABILITY_FAILED        the sell check ran and failed (honeypot evidence)
 *  - SELL_BLOCKED              the risk engine's sell check reported "cannot sell" (honeypot evidence)
 *  - SELLABILITY_NOT_VERIFIED  sellability not proven yet (unknown is never "safe"; separate code from a failed check)
 *  - MINT_AUTHORITY_ACTIVE     the creator can still mint (supply dilution / rug)
 *  - FREEZE_AUTHORITY_ACTIVE   the creator can freeze holder accounts (honeypot mechanism)
 *  - CRITICAL_TOKEN_EXTENSION / UNSUPPORTED_TRANSFER_RESTRICTION  Token-2022 transfer hooks, permanent delegate,
 *                              non-transferable / paused tokens, transfer fees (sell can be blocked or taxed)
 *  - CREATOR_SELLING           the creator dumped >= 50% of its holding (rug pull)
 *  - CRITICAL_LIQUIDITY        critical liquidity drain (rug pull)
 *  - SECURITY_CHECK_PENDING / RPC_SECURITY_DATA_UNAVAILABLE  authorities / token program unknown (fail closed)
 *  - any hard block reported by the token security lookup itself
 */
export const ML_FRAUD_PROTECTION_CODES = new Set([
  'SELLABILITY_FAILED', 'SELL_BLOCKED', 'SELLABILITY_NOT_VERIFIED', 'MINT_AUTHORITY_ACTIVE', 'FREEZE_AUTHORITY_ACTIVE',
  'CRITICAL_TOKEN_EXTENSION', 'UNSUPPORTED_TRANSFER_RESTRICTION', 'CREATOR_SELLING', 'CRITICAL_LIQUIDITY',
  'SECURITY_CHECK_PENDING', 'RPC_SECURITY_DATA_UNAVAILABLE',
]);
/** Honeypot evidence (a sell check actually failed), shown separately from "not yet verified". */
export const ML_HONEYPOT_CODES = new Set(['SELLABILITY_FAILED', 'SELL_BLOCKED']);

export type MlTokenSecurityStatus = 'PASSED' | 'BLOCKED' | 'UNVERIFIED';
export type MlBlockerCategory = 'TOKEN_SECURITY' | 'MARKET_EXECUTION' | 'RISK';

/** Which mandatory layer a blocker belongs to (DEFAULT strategy filters are never ML blockers). */
export function mlBlockerCategory(code: string, securityHardBlocks: readonly string[] = []): MlBlockerCategory {
  if (ML_FRAUD_PROTECTION_CODES.has(code) || securityHardBlocks.includes(code)) return 'TOKEN_SECURITY';
  if (code.startsWith('RISK_') || code === 'RISK_NOT_CLASSIFIED') return 'RISK';
  return 'MARKET_EXECUTION';
}

/** Mandatory fraud / honeypot decision for a token (see ML_FRAUD_PROTECTION_CODES). */
export function mlTokenSecurityCheck(security: LaunchSecurity, features: Pick<NewLaunchStrategyResult['features'], 'liquidityChange' | 'creatorSoldRatio'>, liquidityCriticalPercent: number, riskHardBlocks: readonly string[] = []) {
  const blockers = new Set<string>(evaluateLaunchSecurityBlocks(security));
  for (const reason of riskHardBlocks) if (ML_HONEYPOT_CODES.has(reason)) blockers.add(reason);
  if (security.sellability === 'FAILED') blockers.add('SELLABILITY_FAILED');
  else if (security.sellability !== 'VERIFIED') blockers.add('SELLABILITY_NOT_VERIFIED');
  if (security.mintAuthorityRevoked === null || security.freezeAuthorityRevoked === null || security.tokenProgram === null) blockers.add(security.rpcUnavailable ? 'RPC_SECURITY_DATA_UNAVAILABLE' : 'SECURITY_CHECK_PENDING');
  if (security.mintAuthorityRevoked === false) blockers.add('MINT_AUTHORITY_ACTIVE');
  if (features.liquidityChange !== null && features.liquidityChange <= -liquidityCriticalPercent) blockers.add('CRITICAL_LIQUIDITY');
  if (features.creatorSoldRatio !== null && features.creatorSoldRatio >= 0.5) blockers.add('CREATOR_SELLING');
  const list = [...blockers];
  // UNVERIFIED: only "not yet known" reasons (may still clear inside the decision window); BLOCKED: real evidence.
  const pendingOnly = list.length > 0 && list.every((code) => code === 'SELLABILITY_NOT_VERIFIED' || code === 'SECURITY_CHECK_PENDING' || code === 'RPC_SECURITY_DATA_UNAVAILABLE');
  const status: MlTokenSecurityStatus = list.length === 0 ? 'PASSED' : pendingOnly ? 'UNVERIFIED' : 'BLOCKED';
  return { status, blockers: list, honeypot: list.some((code) => ML_HONEYPOT_CODES.has(code)) };
}

/**
 * Mandatory checks for an ML BUY (empty list = may proceed to PAPER execution, which applies position size, open
 * position, daily loss, emergency stop and exit-capacity limits on top). Unknown data never counts as safe.
 *
 * Three layers, nothing else: (1) fraud / honeypot protection (mlTokenSecurityCheck), (2) market / execution data
 * (price, liquidity, price impact, risk-engine market hard blocks), (3) risk limits. The DEFAULT strategy's decision,
 * scores, activity thresholds, timing settings and optional filters are never consulted (see ML_IGNORED_DEFAULT_FILTERS).
 */
export function mlEntrySafetyBlockers(input: MlEntrySafetyInput): string[] {
  const { result, security, settings } = input;
  const f = result.features;
  // (1) Fraud / honeypot protection.
  const blockers = new Set<string>(mlTokenSecurityCheck(security, f, settings.liquidityCriticalPercent, input.riskHardBlockReasons).blockers);
  // Hard blocks of the security lookup and the risk engine (market data, pool, route, pricing, extreme impact).
  for (const reason of [...result.hardBlockReasons, ...input.riskHardBlockReasons]) blockers.add(reason);
  // (3) Risk.
  if (input.riskScore === null) blockers.add('RISK_NOT_ASSESSED');
  else if (input.riskScore > settings.maxRiskScore) blockers.add('RISK_SCORE_ABOVE_LAUNCH_MAXIMUM');
  // (2) Valid market data, liquidity and price impact (fail-closed on unknown values).
  if (f.priceUsd === null || !(f.priceUsd > 0)) blockers.add('MARKET_PRICE_UNKNOWN');
  if (f.liquidityUsd === null || f.liquidityUsd < settings.minLiquidityUsd) blockers.add('LIQUIDITY_BELOW_MINIMUM');
  if (f.estimatedPriceImpact === null) blockers.add('PRICE_IMPACT_UNKNOWN');
  else if (f.estimatedPriceImpact > settings.maxPriceImpactPercent) blockers.add('PRICE_IMPACT_TOO_HIGH');
  return [...blockers];
}

/** Blockers that can never clear later for this candidate (the ML BUY is resolved as SAFETY_BLOCKED at once). */
export const ML_PERMANENT_BLOCKERS = new Set(['SELLABILITY_FAILED', 'SELL_BLOCKED', 'CRITICAL_LIQUIDITY', 'CREATOR_SELLING', 'FREEZE_AUTHORITY_ACTIVE', 'CRITICAL_TOKEN_EXTENSION', 'UNSUPPORTED_TRANSFER_RESTRICTION']);

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
