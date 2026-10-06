import type { AiTokenAnalysisInput } from './input.js';
import type { AiDecision, AiTokenAnalysis } from './schema.js';

/** Per-user AI settings (stored in PostgreSQL). */
export interface AiUserSettings {
  aiAnalysisEnabled: boolean;
  aiMinimumConfidence: number;
  aiRecheckSeconds: number;
  aiMaxAnalysesPerMinute: number;
  aiAllowHighRisk: boolean;
  aiAllowVeryHighRisk: boolean;
  aiDynamicExitSuggestionsEnabled: boolean;
  aiDecisionTtlSeconds: number;
  aiUseExitParameters: boolean;
}

export const DEFAULT_AI_USER_SETTINGS: AiUserSettings = {
  aiAnalysisEnabled: false,
  aiMinimumConfidence: 75,
  aiRecheckSeconds: 30,
  aiMaxAnalysesPerMinute: 10,
  aiAllowHighRisk: true,
  aiAllowVeryHighRisk: false,
  aiDynamicExitSuggestionsEnabled: false,
  aiDecisionTtlSeconds: 180,
  aiUseExitParameters: false,
};

/** Which system is allowed to create automatic entries for a user. Exactly one, never both. */
export type DecisionSource = 'AI' | 'STRATEGY';
export function automaticEntryDecisionSource(settings: Pick<AiUserSettings, 'aiAnalysisEnabled'> | null | undefined): DecisionSource {
  return settings?.aiAnalysisEnabled === true ? 'AI' : 'STRATEGY';
}

export type EffectiveDecision = AiDecision | 'NONE';

/**
 * Centralised policy from the model's raw decision to the effective one. BUY below the minimum confidence
 * becomes WATCH; risk classes the user did not allow become SKIP. Hard blocks are handled before any AI call.
 */
export function effectiveAiDecision(analysis: AiTokenAnalysis, settings: AiUserSettings, riskClassification: string | null): { decision: EffectiveDecision; reason: string | null } {
  if (riskClassification === 'EXTREME' || riskClassification === 'BLOCKED') return { decision: 'SKIP', reason: 'RISK_CLASS_NOT_ELIGIBLE' };
  if (riskClassification === 'VERY_HIGH' && !settings.aiAllowVeryHighRisk) return { decision: 'SKIP', reason: 'AI_VERY_HIGH_RISK_NOT_ALLOWED' };
  if (riskClassification === 'HIGH' && !settings.aiAllowHighRisk) return { decision: 'SKIP', reason: 'AI_HIGH_RISK_NOT_ALLOWED' };
  if (analysis.decision === 'BUY' && analysis.confidence < settings.aiMinimumConfidence) return { decision: 'WATCH', reason: 'AI_CONFIDENCE_BELOW_THRESHOLD' };
  return { decision: analysis.decision, reason: null };
}

/** Seconds until the same user/token may be analysed again when nothing significant changed. */
export function recheckDelaySeconds(decision: EffectiveDecision, settings: AiUserSettings) {
  if (decision === 'SKIP') return Math.max(120, settings.aiDecisionTtlSeconds);
  if (decision === 'NONE') return 60;
  return Math.max(15, settings.aiRecheckSeconds);
}

/** Never re-analyse faster than this, even after a significant change. */
export const MIN_REANALYSIS_SECONDS = 15;

/** A market change large enough to justify a new analysis before the recheck timer expires. */
export function isSignificantChange(previous: AiTokenAnalysisInput, next: AiTokenAnalysisInput): string | null {
  const ratio = (a: number | null, b: number | null) => (a !== null && b !== null && a > 0 && b > 0 ? b / a : null);
  const price = ratio(previous.market.priceUsd, next.market.priceUsd);
  if (price !== null && Math.abs(price - 1) >= 0.03) return 'PRICE_MOVE';
  const volume = ratio(previous.market.volume5m, next.market.volume5m);
  if (volume !== null && (volume >= 1.5 || volume <= 0.5)) return 'VOLUME_CHANGE';
  const liquidity = ratio(previous.market.liquidityUsd, next.market.liquidityUsd);
  if (liquidity !== null && Math.abs(liquidity - 1) >= 0.1) return 'LIQUIDITY_CHANGE';
  if (previous.market.buyShare5m !== null && next.market.buyShare5m !== null && Math.abs(next.market.buyShare5m - previous.market.buyShare5m) >= 0.1) return 'BUY_PRESSURE_CHANGE';
  if (previous.risk.classification !== next.risk.classification) return 'RISK_CLASS_CHANGE';
  if (previous.exhaustionScore !== null && next.exhaustionScore !== null && Math.abs(next.exhaustionScore - previous.exhaustionScore) >= 15) return 'EXHAUSTION_CHANGE';
  const accelerating = (input: AiTokenAnalysisInput) => (input.market.momentumAcceleration ?? 0) > 0 && (input.market.momentumWindows5m?.at(-1) ?? 0) > 0;
  if (!accelerating(previous) && accelerating(next)) return 'MOMENTUM_ACCELERATING';
  return null;
}

/** Final position size: the AI can only reduce the deterministic risk-engine size, never increase it. */
export function applyAiPositionMultiplier(riskAdjustedSize: number, normalSize: number, aiMultiplier: number | null) {
  if (aiMultiplier === null || !Number.isFinite(aiMultiplier)) return riskAdjustedSize;
  const aiSuggested = normalSize * Math.min(1, Math.max(0, aiMultiplier));
  return Math.min(riskAdjustedSize, aiSuggested);
}
