import { z } from 'zod';

/** Version of the analysis prompt + schema; stored with every AiAnalysis so results stay attributable. */
export const AI_PROMPT_VERSION = 'token-entry-v1';

export const AI_DECISIONS = ['BUY', 'WATCH', 'SKIP'] as const;
export type AiDecision = (typeof AI_DECISIONS)[number];

/** Server-defined safe bounds for everything the model may suggest. */
export const AI_OUTPUT_BOUNDS = {
  positionMultiplier: { min: 0, max: 1 },
  stopLossPercent: { min: 1, max: 50 },
  takeProfitPercent: { min: 1, max: 500 },
  trailingActivationPercent: { min: 0, max: 500 },
  trailingDistancePercent: { min: 0.5, max: 50 },
  recheckSeconds: { min: 15, max: 900 },
  maxListItems: 8,
  maxTextLength: 300,
} as const;

const score = z.number().finite().min(0).max(100);
const text = z.string().trim().min(1).max(AI_OUTPUT_BOUNDS.maxTextLength);
const bounded = (bounds: { min: number; max: number }) => z.number().finite().min(bounds.min).max(bounds.max).nullable();

/** The only shape a model answer may have. Anything else is rejected (AI_ANALYSIS_INVALID). */
export const aiTokenAnalysisSchema = z.object({
  decision: z.enum(AI_DECISIONS),
  confidence: score,
  entryQuality: score,
  marketStrength: score,
  momentumQuality: score,
  liquidityQuality: score,
  timingQuality: score,
  exhaustionRisk: score,
  recommendedPositionMultiplier: z.number().finite().min(AI_OUTPUT_BOUNDS.positionMultiplier.min).max(AI_OUTPUT_BOUNDS.positionMultiplier.max),
  suggestedStopLossPercent: bounded(AI_OUTPUT_BOUNDS.stopLossPercent),
  suggestedTakeProfitPercent: bounded(AI_OUTPUT_BOUNDS.takeProfitPercent),
  suggestedTrailingActivationPercent: bounded(AI_OUTPUT_BOUNDS.trailingActivationPercent),
  suggestedTrailingDistancePercent: bounded(AI_OUTPUT_BOUNDS.trailingDistancePercent),
  recheckSeconds: z.number().int().min(AI_OUTPUT_BOUNDS.recheckSeconds.min).max(AI_OUTPUT_BOUNDS.recheckSeconds.max),
  reasons: z.array(text).max(AI_OUTPUT_BOUNDS.maxListItems),
  warnings: z.array(text).max(AI_OUTPUT_BOUNDS.maxListItems),
}).strict();

export type AiTokenAnalysis = z.infer<typeof aiTokenAnalysisSchema>;

/** Validates untrusted model output; returns null (never a partially trusted object) when it does not conform. */
export function validateAiTokenAnalysis(value: unknown): { ok: true; analysis: AiTokenAnalysis } | { ok: false; error: string } {
  const parsed = aiTokenAnalysisSchema.safeParse(value);
  if (parsed.success) return { ok: true, analysis: parsed.data };
  return { ok: false, error: parsed.error.issues.slice(0, 5).map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ') };
}

/** JSON schema sent to providers that support structured output (mirrors aiTokenAnalysisSchema). */
export const AI_OUTPUT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['decision', 'confidence', 'entryQuality', 'marketStrength', 'momentumQuality', 'liquidityQuality', 'timingQuality', 'exhaustionRisk', 'recommendedPositionMultiplier', 'suggestedStopLossPercent', 'suggestedTakeProfitPercent', 'suggestedTrailingActivationPercent', 'suggestedTrailingDistancePercent', 'recheckSeconds', 'reasons', 'warnings'],
  properties: {
    decision: { type: 'string', enum: [...AI_DECISIONS] },
    confidence: { type: 'number', description: 'Analysis score 0-100 (not a probability of profit).' },
    entryQuality: { type: 'number' },
    marketStrength: { type: 'number' },
    momentumQuality: { type: 'number' },
    liquidityQuality: { type: 'number' },
    timingQuality: { type: 'number' },
    exhaustionRisk: { type: 'number' },
    recommendedPositionMultiplier: { type: 'number', description: 'Between 0 and 1; can only reduce the risk-engine position size.' },
    suggestedStopLossPercent: { type: ['number', 'null'] },
    suggestedTakeProfitPercent: { type: ['number', 'null'] },
    suggestedTrailingActivationPercent: { type: ['number', 'null'] },
    suggestedTrailingDistancePercent: { type: ['number', 'null'] },
    recheckSeconds: { type: 'integer', description: 'Suggested seconds until the next analysis (15-900).' },
    reasons: { type: 'array', items: { type: 'string' }, description: 'Short reasons in Hungarian (max 8).' },
    warnings: { type: 'array', items: { type: 'string' }, description: 'Short warnings in Hungarian (max 8).' },
  },
} as const;
