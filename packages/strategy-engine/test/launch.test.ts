import { describe, expect, it } from 'vitest';

import {
  bondingCurveBuyImpactPercent,
  computeLaunchFeatures,
  DEFAULT_NEW_LAUNCH_SETTINGS,
  evaluateLaunchSecurityBlocks,
  evaluateNewLaunch,
  type LaunchObservation,
  type LaunchSecurity,
  type LaunchState,
  type NewLaunchRiskInput,
  type NewLaunchSettings,
} from '../src/index.js';

const NOW = Date.UTC(2026, 8, 29, 12, 0, 0);
const settings: NewLaunchSettings = { ...DEFAULT_NEW_LAUNCH_SETTINGS, enabled: true };
const safe: LaunchSecurity = { sellability: 'VERIFIED', mintAuthorityRevoked: true, freezeAuthorityRevoked: true, tokenProgram: 'spl-token', extensions: [], hardBlockReasons: [], warnings: [] };
const risk: NewLaunchRiskInput = { riskScore: 50, classification: 'HIGH', hardBlockReasons: [] };

/** Healthy launch: 30 s old, accelerating buys from many distinct wallets, rising liquidity, small impact. */
function healthy(overrides: Partial<LaunchState> = {}, observation?: (index: number, base: LaunchObservation) => LaunchObservation): LaunchState {
  const observations: LaunchObservation[] = [];
  for (let i = 0; i <= 13; i += 1) {
    const progress = i / 13;
    const buys = Math.round(4 + 56 * progress ** 1.4);
    const sells = Math.round(1 + 9 * progress);
    const base: LaunchObservation = {
      takenAt: NOW - (13 - i) * 2_000,
      priceUsd: 0.00001 * (1 + 0.2 * progress),
      liquidityUsd: 30_000 + 4_000 * progress,
      buyCount: buys,
      sellCount: sells,
      volumeUsd: 500 + 6_500 * progress ** 1.3,
      buyVolumeUsd: 400 + 5_600 * progress ** 1.3,
      sellVolumeUsd: 100 + 900 * progress,
      uniqueBuyers: Math.round(3 + 32 * progress),
      uniqueSellers: Math.round(1 + 4 * progress),
    };
    observations.push(observation ? observation(i, base) : base);
  }
  return {
    mint: 'MintHealthy1111111111111111111111111111111',
    detectedAt: NOW - 28_000,
    createdAt: NOW - 30_000,
    observations,
    largestBuyerShare: 0.1,
    buysPerBuyer: 1.3,
    creatorSoldRatio: 0,
    largestHolderSupplyShare: 0.04,
    priceImpactPercent: 1.2,
    observedSellers: 3,
    ...overrides,
  };
}

describe('NewLaunchStrategy', () => {
  it('healthy launch with verified sellability -> BUY with a high score', () => {
    const result = evaluateNewLaunch(healthy(), safe, risk, settings, NOW);
    expect(result.reasons).toEqual(['ALL_LAUNCH_CONDITIONS_MET']);
    expect(result.decision).toBe('BUY');
    expect(result.score).toBeGreaterThanOrEqual(settings.minScore);
    expect(result.dataQuality).toBeGreaterThanOrEqual(80);
  });

  it('bad launch (one wallet dominates, collapsing activity, liquidity leaving) scores lower and is not bought', () => {
    const bad = healthy({ largestBuyerShare: 0.8, buysPerBuyer: 6, priceImpactPercent: 6 }, (i, base) => ({
      ...base,
      priceUsd: 0.00001 * (i < 7 ? 1 + i * 0.3 : 3.1 - (i - 7) * 0.2),
      liquidityUsd: 30_000 - i * 1_500,
      buyCount: Math.min(40, 6 * i),
      sellCount: i < 7 ? 1 : 1 + (i - 7) * 8,
      uniqueBuyers: Math.min(4, 1 + i),
    }));
    const good = evaluateNewLaunch(healthy(), safe, risk, settings, NOW);
    const result = evaluateNewLaunch(bad, safe, risk, settings, NOW);
    expect(result.decision).not.toBe('BUY');
    expect(result.score!).toBeLessThan(good.score!);
  });

  it('sellability FAILED -> REJECT (hard block, never bypassed)', () => {
    const result = evaluateNewLaunch(healthy(), { ...safe, sellability: 'FAILED' }, risk, settings, NOW);
    expect(result.decision).toBe('REJECT');
    expect(result.status).toBe('BLOCKED');
    expect(result.hardBlockReasons).toContain('SELLABILITY_FAILED');
  });

  it('unknown / unverified sellability is never treated as safe -> WATCH', () => {
    const result = evaluateNewLaunch(healthy(), { ...safe, sellability: 'NOT_VERIFIED' }, risk, settings, NOW);
    expect(result.decision).toBe('WATCH');
    expect(result.reasons).toContain('SELLABILITY_NOT_VERIFIED');
  });

  it('unknown authority status -> WATCH (SECURITY_CHECK_PENDING)', () => {
    const result = evaluateNewLaunch(healthy(), { ...safe, mintAuthorityRevoked: null, freezeAuthorityRevoked: null }, risk, settings, NOW);
    expect(result.decision).toBe('WATCH');
    expect(result.reasons).toContain('SECURITY_CHECK_PENDING');
  });

  it('observation window in progress -> WATCH even when everything else looks good', () => {
    const young = healthy({ detectedAt: NOW - 4_000, createdAt: NOW - 20_000 });
    const result = evaluateNewLaunch(young, safe, risk, settings, NOW);
    expect(result.decision).toBe('WATCH');
    expect(result.reasons).toEqual(['OBSERVATION_IN_PROGRESS']);
  });

  it('younger than the minimum age -> WATCH (warming up)', () => {
    const result = evaluateNewLaunch(healthy({ createdAt: NOW - 2_000, detectedAt: NOW - 2_000 }), safe, risk, settings, NOW);
    expect(result.decision).toBe('WATCH');
    expect(result.status).toBe('WARMING_UP');
  });

  it('outside the launch window -> REJECT expired', () => {
    const result = evaluateNewLaunch(healthy({ createdAt: NOW - 200_000 }), safe, risk, settings, NOW);
    expect(result.decision).toBe('REJECT');
    expect(result.reasons).toContain('LAUNCH_WINDOW_EXPIRED');
  });

  it('freeze authority / critical Token-2022 extension / creator selling / risk hard block -> REJECT', () => {
    expect(evaluateNewLaunch(healthy(), { ...safe, freezeAuthorityRevoked: false }, risk, settings, NOW).decision).toBe('REJECT');
    expect(evaluateLaunchSecurityBlocks({ ...safe, tokenProgram: 'spl-token-2022', extensions: ['transferHook'] })).toContain('CRITICAL_TOKEN_EXTENSION');
    expect(evaluateNewLaunch(healthy({ creatorSoldRatio: 0.9 }), safe, risk, settings, NOW).reasons).toContain('CREATOR_SELLING');
    expect(evaluateNewLaunch(healthy(), safe, { ...risk, hardBlockReasons: ['HONEYPOT'] }, settings, NOW).decision).toBe('REJECT');
  });

  it('liquidity below the minimum or too large price impact -> WATCH, not BUY', () => {
    const lowLiquidity = healthy({}, (_i, base) => ({ ...base, liquidityUsd: 3_000 }));
    expect(evaluateNewLaunch(lowLiquidity, safe, risk, settings, NOW).reasons).toContain('LIQUIDITY_BELOW_MINIMUM');
    expect(evaluateNewLaunch(healthy({ priceImpactPercent: 9 }), safe, risk, settings, NOW).reasons).toContain('PRICE_IMPACT_TOO_HIGH');
    expect(evaluateNewLaunch(healthy({ priceImpactPercent: null }), safe, risk, settings, NOW).reasons).toContain('PRICE_IMPACT_UNKNOWN');
  });

  it('unique buyers are wallets, not transactions (unknown buyers -> WATCH)', () => {
    const unknownBuyers = healthy({}, (_i, base) => ({ ...base, uniqueBuyers: null }));
    const result = evaluateNewLaunch(unknownBuyers, safe, risk, settings, NOW);
    expect(result.decision).toBe('WATCH');
    expect(result.reasons).toContain('UNIQUE_BUYERS_UNKNOWN');
  });

  it('features are computed from real observations only', () => {
    const features = computeLaunchFeatures(healthy(), NOW);
    expect(features.ageSeconds).toBe(30);
    expect(features.snapshotCount).toBe(14);
    expect(features.priceChangeSinceDetection).toBeCloseTo(20, 5);
    expect(features.uniqueBuyers).toBe(35);
    expect(features.transactionAcceleration!).toBeGreaterThan(1);
  });

  it('bonding curve impact follows the constant product formula', () => {
    // 30 SOL / 1.073B tokens virtual reserves; 1 SOL buy moves the average price by ~1/30.
    const impact = bondingCurveBuyImpactPercent(30, 1_073_000_000, 1)!;
    expect(impact).toBeGreaterThan(3);
    expect(impact).toBeLessThan(3.5);
    expect(bondingCurveBuyImpactPercent(0, 1, 1)).toBeNull();
  });
});
