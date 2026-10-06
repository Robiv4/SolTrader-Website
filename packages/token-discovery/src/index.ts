import {
  assessRisk,
  calculateTokenScore,
  enforceRiskGate,
  type RiskAssessment,
  type RiskEngineConfig,
  type RiskFactorInput,
  type TokenScoreFactors,
  type TokenScoreResult,
  type TokenScoreWeights,
} from '@soltrader/risk-engine';

export interface TokenCandidate extends RiskFactorInput {
  scoreFactors: TokenScoreFactors;
}

export interface DiscoveryConfig {
  risk: RiskEngineConfig;
  scoreWeights?: TokenScoreWeights;
}

export interface DiscoveredToken {
  candidate: TokenCandidate;
  risk: RiskAssessment;
  score: TokenScoreResult;
  accepted: boolean;
}

export interface DiscoveryResult {
  accepted: DiscoveredToken[];
  rejected: DiscoveredToken[];
}

export function evaluateCandidate(candidate: TokenCandidate, config: DiscoveryConfig): DiscoveredToken {
  const risk = assessRisk(candidate, config.risk);
  const score = calculateTokenScore(candidate.scoreFactors, config.scoreWeights);
  return {
    candidate,
    risk,
    score,
    accepted: risk.decision !== 'REJECT',
  };
}

/** Re-exported for orchestration layers that must hard-gate strategy evaluation on risk decisions. */
export { enforceRiskGate };

export function discoverTokens(candidates: TokenCandidate[], config: DiscoveryConfig): DiscoveryResult {
  const accepted: DiscoveredToken[] = [];
  const rejected: DiscoveredToken[] = [];

  for (const candidate of candidates) {
    const result = evaluateCandidate(candidate, config);
    if (result.accepted) {
      accepted.push(result);
    } else {
      rejected.push(result);
    }
  }

  return { accepted, rejected };
}

export * from './normalize.js';
export * from './filter.js';
export * from './strategy-input.js';

