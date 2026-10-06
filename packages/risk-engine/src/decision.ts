import type { RiskClassification, RiskPolicyName, RiskPositionMultipliers } from './index.js';

export type AIAnalysis = {
  opportunityScore: number;
  confidence: number;
  marketStructure: 'BULLISH' | 'BEARISH' | 'NEUTRAL' | 'UNCLEAR';
  momentum: 'STRONG' | 'MODERATE' | 'WEAK' | 'NEGATIVE';
  liquidityQuality: 'GOOD' | 'ACCEPTABLE' | 'POOR';
  riskAssessment: 'ACCEPTABLE' | 'HIGH_RISK' | 'VERY_HIGH_RISK' | 'AVOID';
  warnings: string[];
  reasons: string[];
};

export interface AITokenAnalysisInput {
  tokenAddress: string;
  riskScore: number;
  riskClassification: RiskClassification;
  factors: Record<string, number>;
  warnings: string[];
  market: { priceUsd?: number; liquidityUsd?: number; volume24h?: number; priceChange1h?: number; priceChange24h?: number };
  strategy: { name: string; signalScore: number; reasons: string[] };
}

export interface AITokenAnalyst {
  analyzeToken(input: AITokenAnalysisInput, signal?: { readonly aborted: boolean }): Promise<unknown>;
}

const enumValues = {
  marketStructure: ['BULLISH', 'BEARISH', 'NEUTRAL', 'UNCLEAR'],
  momentum: ['STRONG', 'MODERATE', 'WEAK', 'NEGATIVE'],
  liquidityQuality: ['GOOD', 'ACCEPTABLE', 'POOR'],
  riskAssessment: ['ACCEPTABLE', 'HIGH_RISK', 'VERY_HIGH_RISK', 'AVOID'],
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPercent(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 20 && value.every((item) => typeof item === 'string' && item.length <= 200);
}

/** Validate provider output before any trading decision consumes it. */
export function validateAIAnalysis(value: unknown): AIAnalysis | null {
  if (!isRecord(value)) return null;
  const expectedKeys = ['opportunityScore', 'confidence', 'marketStructure', 'momentum', 'liquidityQuality', 'riskAssessment', 'warnings', 'reasons'];
  if (Object.keys(value).length !== expectedKeys.length || expectedKeys.some((key) => !(key in value))) return null;
  if (!isPercent(value.opportunityScore) || !isPercent(value.confidence)) return null;
  if (!Object.entries(enumValues).every(([key, allowed]) => allowed.includes(value[key] as never))) return null;
  if (!isStringList(value.warnings) || !isStringList(value.reasons)) return null;
  return value as AIAnalysis;
}

export interface FinalTradeDecisionInput {
  tradingMode: 'PAPER' | 'SEMI_AUTO' | 'LIVE' | 'SCANNER';
  classification: RiskClassification;
  riskPolicy: RiskPolicyName;
  hardBlocked: boolean;
  hardBlockReasons: string[];
  riskScore: number;
  signalScore: number;
  minimumSignalScore: number;
  normalPositionSize: number;
  positionMultipliers: RiskPositionMultipliers;
  aiAnalysisEnabled: boolean;
  aiRequiredForHighRisk: boolean;
  aiRequiredForVeryHighRisk: boolean;
  aiAnalysis?: AIAnalysis;
  aiUnavailable?: boolean;
  warnings?: string[];
  preTradeRejectionReasons?: string[];
}

export interface FinalTradeDecision {
  decision: 'APPROVED' | 'APPROVED_REDUCED_SIZE' | 'REJECTED' | 'BLOCKED';
  reasons: string[];
  warnings: string[];
  riskScore: number;
  riskClassification: RiskClassification;
  signalScore: number;
  aiOpportunityScore?: number;
  aiConfidence?: number;
  normalPositionSize: number;
  riskAdjustedPositionSize: number;
  positionMultiplier: number;
}

export function decideFinalTrade(input: FinalTradeDecisionInput): FinalTradeDecision {
  const warnings = [...(input.warnings ?? [])];
  const multiplier = input.classification === 'BLOCKED' ? 0
    : Math.min(1, Math.max(0, input.positionMultipliers[input.classification]));
  const result = (
    decision: FinalTradeDecision['decision'],
    reasons: string[],
    positionMultiplier = 0,
  ): FinalTradeDecision => ({
    decision,
    reasons,
    warnings,
    riskScore: input.riskScore,
    riskClassification: input.classification,
    signalScore: input.signalScore,
    aiOpportunityScore: input.aiAnalysis?.opportunityScore,
    aiConfidence: input.aiAnalysis?.confidence,
    normalPositionSize: input.normalPositionSize,
    positionMultiplier,
    riskAdjustedPositionSize: Math.min(input.normalPositionSize, input.normalPositionSize * positionMultiplier),
  });

  if (input.hardBlocked || input.classification === 'BLOCKED') {
    return result('BLOCKED', input.hardBlockReasons.length > 0 ? input.hardBlockReasons : ['HARD_BLOCKED']);
  }
  if (input.preTradeRejectionReasons && input.preTradeRejectionReasons.length > 0) {
    return result('REJECTED', input.preTradeRejectionReasons);
  }
  if (!Number.isFinite(input.normalPositionSize) || input.normalPositionSize <= 0) {
    return result('REJECTED', ['INVALID_POSITION_SIZE']);
  }
  if (!Number.isFinite(input.signalScore) || input.signalScore < input.minimumSignalScore) {
    return result('REJECTED', ['SIGNAL_SCORE_BELOW_MINIMUM']);
  }
  if (input.classification === 'EXTREME') return result('REJECTED', ['EXTREME_RISK_CLASSIFICATION']);
  // PAPER and SEMI_AUTO both execute simulated orders (SEMI_AUTO additionally needs the user's explicit
  // approval of every entry), so high-risk entries are allowed there; never in LIVE.
  const simulatedExecution = input.tradingMode === 'PAPER' || input.tradingMode === 'SEMI_AUTO';
  if (input.classification === 'HIGH' || input.classification === 'VERY_HIGH') {
    if (!simulatedExecution) return result('REJECTED', ['HIGH_RISK_AUTOMATION_PAPER_ONLY']);
  }
  if (input.riskPolicy === 'CONSERVATIVE' && input.classification === 'VERY_HIGH') {
    return result('REJECTED', ['RISK_POLICY_CONSERVATIVE_LIMIT']);
  }
  if (input.riskPolicy === 'CONSERVATIVE' && input.classification === 'HIGH' && input.signalScore < 80) {
    return result('REJECTED', ['CONSERVATIVE_HIGH_RISK_SIGNAL_REQUIREMENT']);
  }
  if (input.riskPolicy === 'BALANCED' && input.classification === 'VERY_HIGH' && input.signalScore < 80) {
    return result('REJECTED', ['BALANCED_VERY_HIGH_RISK_REQUIREMENT']);
  }
  if (input.riskPolicy === 'EXPLORATORY' && !simulatedExecution) {
    return result('REJECTED', ['EXPLORATORY_POLICY_PAPER_ONLY']);
  }
  if (input.riskPolicy === 'EXPLORATORY' && input.classification === 'VERY_HIGH' && input.signalScore < 75) {
    return result('REJECTED', ['EXPLORATORY_VERY_HIGH_RISK_REQUIREMENT']);
  }

  const aiRequired = input.classification === 'HIGH' && input.aiRequiredForHighRisk
    || input.classification === 'VERY_HIGH' && input.aiRequiredForVeryHighRisk;
  if (aiRequired && (!input.aiAnalysisEnabled || input.aiUnavailable || !input.aiAnalysis)) {
    return result('REJECTED', ['AI_ANALYSIS_UNAVAILABLE']);
  }
  if (input.aiAnalysis?.riskAssessment === 'AVOID' || input.aiAnalysis?.riskAssessment === 'VERY_HIGH_RISK') {
    return result('REJECTED', ['AI_CONFIRMATION_FAILED']);
  }

  const reasons = [input.classification === 'HIGH' || input.classification === 'VERY_HIGH' ? 'HIGH_RISK_CLASSIFICATION' : 'RISK_POLICY_PASSED'];
  if (input.aiAnalysis) reasons.push('AI_CONFIRMATION_PASSED');
  return result(multiplier < 1 ? 'APPROVED_REDUCED_SIZE' : 'APPROVED', reasons, multiplier);
}