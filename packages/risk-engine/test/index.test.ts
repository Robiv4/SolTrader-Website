import { describe, expect, it } from 'vitest';

import {
  assessRisk,
  calculateTokenScore,
  decideFinalTrade,
  DEFAULT_RISK_POSITION_MULTIPLIERS,
  DEFAULT_RISK_THRESHOLDS,
  enforceRiskGate,
  RiskRejectedError,
  type RiskFactorInput,
  type RiskThresholds,
  type TokenScoreFactors,
} from '../src/index.js';

const thresholds: RiskThresholds = {
  ...DEFAULT_RISK_THRESHOLDS,
  minimumLiquidityUsd: 10_000,
  minimumVolume24hUsd: 5_000,
  minimumTransactionCount: 100,
  maximumTokenAgeSeconds: 86_400 * 30,
  minimumPoolAgeSeconds: 600,
  maximumSlippageEstimatePercent: 3,
  maximumHolderConcentrationPercent: 25,
  maximumTopHolderConcentrationPercent: 15,
  maximumLiquidityConcentrationPercent: 50,
  rejectMutableMetadata: true,
  maximumVolatilityPercent: 40,
  maximumVolumeToLiquidityRatio: 10,
};

const healthyInput: RiskFactorInput = {
  address: 'token',
  liquidityUsd: 100_000,
  liquidityConcentrationPercent: 15,
  tokenAgeSeconds: 86_400,
  poolAgeSeconds: 86_400,
  volume24h: 10_000,
  transactionCount: 200,
  slippageEstimatePercent: 1,
  holderConcentrationPercent: 10,
  topHolderConcentrationPercent: 5,
  authority: { mintAuthorityRevoked: true, freezeAuthorityRevoked: true, metadataMutable: false },
  metadataAnomalyDetected: false,
  volatilityPercent: 10,
  abnormalTradingActivity: false,
  sellability: { checked: true, canSell: true, sellTaxPercent: 0 },
};

function assess(overrides: Partial<RiskFactorInput>) {
  return assessRisk({ ...healthyInput, ...overrides }, { thresholds, source: 'unit-test' });
}

describe('risk score direction', () => {
  it('scores a healthy candidate near zero (0 = lower measured risk)', () => {
    const result = assess({});
    expect(result.riskScore).toBeLessThanOrEqual(10);
    expect(result.decision).toBe('ACCEPT');
    expect(result.rejectionReasons).toHaveLength(0);
  });

  it('scores a maximally bad candidate near one hundred (100 = higher measured risk)', () => {
    const result = assess({
      liquidityUsd: 0,
      liquidityConcentrationPercent: 100,
      tokenAgeSeconds: 86_400 * 365,
      poolAgeSeconds: 0,
      volume24h: 0,
      transactionCount: 0,
      slippageEstimatePercent: 100,
      holderConcentrationPercent: 100,
      topHolderConcentrationPercent: 100,
      authority: { mintAuthorityRevoked: false, freezeAuthorityRevoked: false, metadataMutable: true },
      metadataAnomalyDetected: true,
      volatilityPercent: 100,
      abnormalTradingActivity: true,
      sellability: { checked: true, canSell: false },
    });
    expect(result.riskScore).toBeGreaterThanOrEqual(90);
    expect(result.decision).toBe('REJECT');
  });
});

describe('soft risk factors affect warnings without hard blocking', () => {
  const cases: Array<[string, Partial<RiskFactorInput>, string]> = [
    ['liquidity', { liquidityUsd: 8_000 }, 'LOW_LIQUIDITY'],
    ['liquidity concentration', { liquidityConcentrationPercent: 90 }, 'HIGH_LIQUIDITY_CONCENTRATION'],
    ['token age', { tokenAgeSeconds: 100_000_000 }, 'TOKEN_TOO_OLD'],
    ['pool age', { poolAgeSeconds: 1 }, 'POOL_TOO_YOUNG'],
    ['volume', { volume24h: 1 }, 'LOW_VOLUME'],
    ['transaction count', { transactionCount: 1 }, 'LOW_TRANSACTION_COUNT'],
    ['price impact', { slippageEstimatePercent: 10 }, 'HIGH_PRICE_IMPACT'],
    ['holder distribution', { holderConcentrationPercent: 40 }, 'HIGH_HOLDER_CONCENTRATION'],
    ['top holder concentration', { topHolderConcentrationPercent: 30 }, 'HIGH_TOP_HOLDER_CONCENTRATION'],
    ['mint authority', { authority: { mintAuthorityRevoked: false, freezeAuthorityRevoked: true, metadataMutable: false } }, 'MINT_AUTHORITY_ACTIVE'],
    ['freeze authority', { authority: { mintAuthorityRevoked: true, freezeAuthorityRevoked: false, metadataMutable: false } }, 'FREEZE_AUTHORITY_ACTIVE'],
    ['metadata mutability', { authority: { mintAuthorityRevoked: true, freezeAuthorityRevoked: true, metadataMutable: true } }, 'METADATA_MUTABLE'],
    ['metadata anomaly', { metadataAnomalyDetected: true }, 'METADATA_ANOMALY'],
    ['extreme volatility', { volatilityPercent: 90 }, 'HIGH_VOLATILITY'],
    ['volume/liquidity relationship', { volume24h: 5_000_000, liquidityUsd: 20_000 }, 'EXCESSIVE_VOLUME_TO_LIQUIDITY'],
    ['suspicious activity', { abnormalTradingActivity: true }, 'ABNORMAL_ACTIVITY'],
  ];

  it.each(cases)('flags %s risk as %s without hard blocking', (_label, override, reason) => {
    const result = assess(override);
    expect(result.warnings).toContain(reason);
    expect(result.hardBlocked).toBe(false);
    expect(result.decision).not.toBe('REJECT');
  });

  it('warns (but does not reject) when sellability was never checked', () => {
    const result = assess({ sellability: undefined });
    expect(result.warnings).toContain('SELLABILITY_NOT_VERIFIED');
    expect(result.decision).toBe('ACCEPT');
  });
});

describe('ACCEPT / WATCH / REJECT decision thresholds', () => {
  it('returns WATCH when every soft factor sits exactly at its threshold with no hard rejection', () => {
    const result = assess({
      liquidityUsd: 10_000,
      liquidityConcentrationPercent: 50,
      tokenAgeSeconds: 86_400 * 30,
      poolAgeSeconds: 600,
      volume24h: 100_000,
      transactionCount: 100,
      slippageEstimatePercent: 3,
      holderConcentrationPercent: 25,
      topHolderConcentrationPercent: 15,
      volatilityPercent: 40,
      sellability: { checked: true, canSell: true, sellTaxPercent: 20 },
    });
    expect(result.rejectionReasons).toHaveLength(0);
    expect(result.decision).toBe('WATCH');
  });

  it('classifies a high aggregate score without turning it into a hard block', () => {
    const strictThresholds: RiskThresholds = { ...thresholds, lowRiskMax: 5, moderateRiskMax: 10, highRiskMax: 70, veryHighRiskMax: 85 };
    const result = assessRisk({
      ...healthyInput,
      liquidityConcentrationPercent: 35,
      holderConcentrationPercent: 20,
      topHolderConcentrationPercent: 12,
    }, { thresholds: strictThresholds, source: 'unit-test' });

    expect(result.hardBlocked).toBe(false);
    expect(result.classification).toBe('HIGH');
    expect(result.decision).toBe('WATCH');
  });

  it('hard-blocks confirmed sellability failure and malformed or stale market data', () => {
    expect(assess({ sellability: { checked: true, canSell: false } }).hardBlockReasons).toContain('SELL_BLOCKED');
    expect(assess({ marketDataAvailable: false }).hardBlockReasons).toContain('MARKET_DATA_UNAVAILABLE');
    expect(assess({ marketDataStale: true }).hardBlockReasons).toContain('MARKET_DATA_STALE');
    expect(assess({ executionPriceAvailable: false }).hardBlockReasons).toContain('UNPRICED_EXECUTION');
    expect(assess({ liquidityUsd: Number.NaN }).hardBlockReasons).toContain('MALFORMED_MARKET_DATA');
  });

  it('keeps configured risk classification thresholds independent from hard blocks', () => {
    const result = assessRisk({
      ...healthyInput,
      volatilityPercent: 100,
      authority: { mintAuthorityRevoked: false, freezeAuthorityRevoked: false, metadataMutable: false },
      holderConcentrationPercent: 100,
      liquidityConcentrationPercent: 100,
    }, { thresholds: { ...thresholds, lowRiskMax: 5, moderateRiskMax: 10, highRiskMax: 70, veryHighRiskMax: 85 } });
    expect(result.hardBlocked).toBe(false);
    expect(result.classification).toBe('HIGH');
    expect(result.warnings).toEqual(expect.arrayContaining(['HIGH_VOLATILITY', 'MINT_AUTHORITY_ACTIVE', 'FREEZE_AUTHORITY_ACTIVE', 'HIGH_HOLDER_CONCENTRATION', 'HIGH_LIQUIDITY_CONCENTRATION']));
  });
});

describe('risk gate', () => {
  it('allows ACCEPT/WATCH assessments through untouched', () => {
    const result = assess({});
    expect(enforceRiskGate(result)).toBe(result);
  });

  it('throws RiskRejectedError for REJECT decisions so strategies cannot bypass it', () => {
    const result = assess({ liquidityUsd: 1 });
    expect(() => enforceRiskGate(result)).toThrow(RiskRejectedError);
  });
});

describe('token score calculations', () => {
  const factors: TokenScoreFactors = {
    momentum: 80,
    volume: 60,
    volumeAcceleration: 40,
    buyPressure: 70,
    liquidity: 90,
    holderDistribution: 50,
    walletActivity: 30,
    marketConditions: 60,
  };

  it('calculates a weighted score from configurable factors', () => {
    const result = calculateTokenScore(factors, { ...Object.fromEntries(Object.keys(factors).map((key) => [key, 1])) } as TokenScoreFactors);
    expect(result.score).toBe(60);
  });

  it('rejects an all-zero weight configuration', () => {
    expect(() => calculateTokenScore(factors, Object.fromEntries(Object.keys(factors).map((key) => [key, 0])) as TokenScoreFactors)).toThrow();
  });
});

describe('final trade decisions', () => {
  const baseDecision = {
    tradingMode: 'PAPER' as const,
    classification: 'HIGH' as const,
    riskPolicy: 'BALANCED' as const,
    hardBlocked: false,
    hardBlockReasons: [],
    riskScore: 53,
    signalScore: 84,
    minimumSignalScore: 60,
    normalPositionSize: 20,
    positionMultipliers: { ...DEFAULT_RISK_POSITION_MULTIPLIERS },
    aiAnalysisEnabled: false,
    aiRequiredForHighRisk: false,
    aiRequiredForVeryHighRisk: false,
  };

  it('allows a HIGH paper trade with a reduced position', () => {
    const result = decideFinalTrade(baseDecision);
    expect(result.decision).toBe('APPROVED_REDUCED_SIZE');
    expect(result.riskAdjustedPositionSize).toBe(7);
  });

  it('never lets AI override a hard block', () => {
    const result = decideFinalTrade({
      ...baseDecision,
      hardBlocked: true,
      hardBlockReasons: ['SELLABILITY_FAILED'],
      classification: 'BLOCKED',
      aiAnalysisEnabled: true,
      aiAnalysis: {
        opportunityScore: 95,
        confidence: 90,
        marketStructure: 'BULLISH',
        momentum: 'STRONG',
        liquidityQuality: 'GOOD',
        riskAssessment: 'ACCEPTABLE',
        warnings: [],
        reasons: [],
      },
    });
    expect(result.decision).toBe('BLOCKED');
    expect(result.reasons).toContain('SELLABILITY_FAILED');
  });

  it('requires AI for configured high risk and fails safely when unavailable', () => {
    const result = decideFinalTrade({ ...baseDecision, aiAnalysisEnabled: true, aiRequiredForHighRisk: true, aiUnavailable: true });
    expect(result.decision).toBe('REJECTED');
    expect(result.reasons).toContain('AI_ANALYSIS_UNAVAILABLE');
  });

  it('lets an explicit manual paper request bypass only the automatic signal threshold', () => {
    const result = decideFinalTrade({ ...baseDecision, minimumSignalScore: 70, signalScore: 40 });
    expect(result.decision).toBe('REJECTED');
    const manualResult = decideFinalTrade({ ...baseDecision, minimumSignalScore: 0, signalScore: 40 });
    expect(manualResult.decision).toBe('APPROVED_REDUCED_SIZE');
  });

  it('allows high-risk entries in SEMI_AUTO, where every entry is approved by the user and executed as PAPER', () => {
    const result = decideFinalTrade({ ...baseDecision, riskPolicy: 'EXPLORATORY', tradingMode: 'SEMI_AUTO' });
    expect(result.decision).toBe('APPROVED_REDUCED_SIZE');
  });

  it('does not carry exploratory paper permissions into live mode', () => {
    const result = decideFinalTrade({ ...baseDecision, riskPolicy: 'EXPLORATORY', tradingMode: 'LIVE' });
    expect(result.decision).toBe('REJECTED');
    expect(result.reasons).toContain('HIGH_RISK_AUTOMATION_PAPER_ONLY');
  });
});
