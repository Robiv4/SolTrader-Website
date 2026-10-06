import { DEFAULT_RISK_THRESHOLDS } from '@soltrader/risk-engine';
import { describe, expect, it } from 'vitest';

import { discoverTokens, type TokenCandidate } from '../src/index.js';

const risk = { thresholds: DEFAULT_RISK_THRESHOLDS, source: 'test' };

const scoreFactors = {
  momentum: 80,
  volume: 80,
  volumeAcceleration: 70,
  buyPressure: 75,
  liquidity: 90,
  holderDistribution: 80,
  walletActivity: 60,
  marketConditions: 70,
};

const candidate: TokenCandidate = {
  address: 'candidate',
  liquidityUsd: 20_000,
  liquidityConcentrationPercent: 20,
  tokenAgeSeconds: 3_600,
  poolAgeSeconds: 3_600,
  volume24h: 12_000,
  transactionCount: 500,
  slippageEstimatePercent: 1,
  holderConcentrationPercent: 10,
  topHolderConcentrationPercent: 5,
  authority: { mintAuthorityRevoked: true, freezeAuthorityRevoked: true, metadataMutable: false },
  metadataAnomalyDetected: false,
  abnormalTradingActivity: false,
  volatilityPercent: 20,
  sellability: { checked: true, canSell: true, sellTaxPercent: 0 },
  scoreFactors,
};

describe('token discovery', () => {
  it('separates accepted and rejected candidates without making trade decisions', () => {
    const result = discoverTokens([
      candidate,
      { ...candidate, address: 'rejected', liquidityUsd: 1 },
    ], { risk });

    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].score.score).toBeGreaterThan(0);
    expect(result.rejected[0].risk.warnings).toContain('LOW_LIQUIDITY');
    expect(result.rejected[0].risk.hardBlockReasons).toContain('LIQUIDITY_BELOW_ABSOLUTE_MINIMUM');
    expect(result.rejected[0].risk.decision).toBe('REJECT');
    expect(result.rejected[0].accepted).toBe(false);
  });
});

