/**
 * ML PAPER entry policy (pure): prediction timing, threshold, mandatory safety blockers and the PAPER research target.
 */
import { describe, expect, it } from 'vitest';

import {
  buildMlDataset, buildMlFeatureSnapshot, classifyMlProbability, computeCandidateOutcome, DEFAULT_NEW_LAUNCH_SETTINGS, evaluateNewLaunch, ML_PAPER_POINT_TOLERANCE_MS,
  ML_IGNORED_DEFAULT_FILTERS, ML_PERMANENT_BLOCKERS, ML_STRATEGY_ONLY_REASONS, mlBuyWindowOpen, mlRiskConviction, applyTokenSafetySetting, ML_TOKEN_SAFETY_BLOCKERS, mlDecisionTiming, mlEntrySafetyBlockers, newOutcomePath, recordPathPoint,
  type LaunchObservation, type LaunchSecurity, type MlDatasetSourceRow,
} from '../src/index.js';

const T = Date.parse('2026-10-05T12:00:00Z');
const safe: LaunchSecurity = { sellability: 'VERIFIED', mintAuthorityRevoked: true, freezeAuthorityRevoked: true, tokenProgram: 'spl-token', extensions: [], hardBlockReasons: [], warnings: [] };
const settings = { ...DEFAULT_NEW_LAUNCH_SETTINGS, enabled: true, minLiquidityUsd: 10_000, maxPriceImpactPercent: 3, maxRiskScore: 80, minAgeSeconds: 5, maxAgeSeconds: 90, observationSeconds: 10 };

/** A launch whose activity is BELOW the rule thresholds (rule-based strategy: WATCH) but that is otherwise safe. */
function weakButSafeLaunch(overrides: Partial<LaunchObservation> = {}) {
  const observations: LaunchObservation[] = Array.from({ length: 15 }, (_, i) => ({
    takenAt: T - 30_000 + i * 2_000, priceUsd: 0.00001 * (1 + i / 100), liquidityUsd: 30_000, buyCount: 3 + i, sellCount: 1 + Math.floor(i / 4),
    volumeUsd: 100 + i * 40, buyVolumeUsd: 80 + i * 30, sellVolumeUsd: 20 + i * 10, uniqueBuyers: 2 + Math.floor(i / 2), uniqueSellers: 1, ...overrides,
  }));
  return { mint: 'M', detectedAt: T - 30_000, createdAt: T - 31_000, observations, largestBuyerShare: 0.1, buysPerBuyer: 1.2, creatorSoldRatio: 0, largestHolderSupplyShare: 0.04, priceImpactPercent: 1, observedSellers: 3 };
}

function blockersFor(security: LaunchSecurity, riskScore: number | null, state = weakButSafeLaunch(), extra: Partial<typeof settings> = {}) {
  const config = { ...settings, ...extra };
  const result = evaluateNewLaunch(state, security, { riskScore, classification: riskScore === null ? null : 'MODERATE', hardBlockReasons: [] }, config, T);
  return { result, blockers: mlEntrySafetyBlockers({ result, security, riskScore, riskHardBlockReasons: [], settings: config, detectedAt: T - 30_000, now: T }) };
}

describe('ML PAPER timing: one decision at the trained snapshot point', () => {
  it('waits before the point, decides inside the tolerance, never decides late (no back-dating)', () => {
    expect(mlDecisionTiming(T, 30_000, T + 29_999)).toBe('WAIT');
    expect(mlDecisionTiming(T, 30_000, T + 30_000)).toBe('DECIDE');
    expect(mlDecisionTiming(T, 30_000, T + 30_000 + ML_PAPER_POINT_TOLERANCE_MS)).toBe('DECIDE');
    expect(mlDecisionTiming(T, 30_000, T + 30_001 + ML_PAPER_POINT_TOLERANCE_MS)).toBe('MISSED');
  });

  it('an ML BUY can only be executed after the decision and inside the window', () => {
    expect(mlBuyWindowOpen(T, 10, T - 1)).toBe(false);
    expect(mlBuyWindowOpen(T, 10, T)).toBe(true);
    expect(mlBuyWindowOpen(T, 10, T + 10_000)).toBe(true);
    expect(mlBuyWindowOpen(T, 10, T + 10_001)).toBe(false);
    // The window can never exceed 30 s, whatever is stored.
    expect(mlBuyWindowOpen(T, 600, T + 31_000)).toBe(false);
  });

  it('ML BUY / ML SKIP at the threshold, threshold clamped to 0.05-0.90, invalid probabilities never buy', () => {
    expect(classifyMlProbability(0.72, 0.7)).toBe('ML_BUY');
    expect(classifyMlProbability(0.69, 0.7)).toBe('ML_SKIP');
    expect(classifyMlProbability(0.04, 0.01)).toBe('ML_SKIP');
    expect(classifyMlProbability(0.05, 0.01)).toBe('ML_BUY');
    expect(classifyMlProbability(0.95, 0.99)).toBe('ML_BUY');
    expect(classifyMlProbability(Number.NaN, 0.5)).toBe('ML_SKIP');
  });
});

describe('ML BUY cannot bypass mandatory safety (test 4)', () => {
  it('a weak-but-safe launch: the rule strategy waits, the ML may decide (only strategy reasons differ)', () => {
    const { result, blockers } = blockersFor(safe, 40);
    expect(result.decision).toBe('WATCH');
    expect(result.reasons.every((reason) => (ML_STRATEGY_ONLY_REASONS as readonly string[]).includes(reason))).toBe(true);
    expect(blockers).toEqual([]);
  });

  const cases: Array<[string, () => string[], string]> = [
    ['sellability not verified', () => blockersFor({ ...safe, sellability: 'NOT_VERIFIED' }, 40).blockers, 'SELLABILITY_NOT_VERIFIED'],
    ['honeypot (sell failed)', () => blockersFor({ ...safe, sellability: 'FAILED' }, 40).blockers, 'SELLABILITY_FAILED'],
    ['freeze authority active', () => blockersFor({ ...safe, freezeAuthorityRevoked: false }, 40).blockers, 'FREEZE_AUTHORITY_ACTIVE'],
    ['mint authority active', () => blockersFor({ ...safe, mintAuthorityRevoked: false }, 40).blockers, 'MINT_AUTHORITY_ACTIVE'],
    ['authorities unknown after an RPC outage', () => blockersFor({ ...safe, mintAuthorityRevoked: null, rpcUnavailable: true }, 40).blockers, 'RPC_SECURITY_DATA_UNAVAILABLE'],
    ['critical token extension', () => blockersFor({ ...safe, extensions: ['transferHook'] }, 40).blockers, 'CRITICAL_TOKEN_EXTENSION'],
    ['liquidity below minimum', () => blockersFor(safe, 40, weakButSafeLaunch({ liquidityUsd: 2_000 })).blockers, 'LIQUIDITY_BELOW_MINIMUM'],
    ['risk not assessed', () => blockersFor(safe, null).blockers, 'RISK_NOT_ASSESSED'],
    ['risk above the launch maximum', () => blockersFor(safe, 95).blockers, 'RISK_SCORE_ABOVE_LAUNCH_MAXIMUM'],
    ['price impact too high', () => blockersFor(safe, 40, weakButSafeLaunch(), { maxPriceImpactPercent: 0.5 }).blockers, 'PRICE_IMPACT_TOO_HIGH'],
    ['creator dumping (rug pull)', () => blockersFor(safe, 40, { ...weakButSafeLaunch(), creatorSoldRatio: 0.8 }).blockers, 'CREATOR_SELLING'],
    ['no market price', () => blockersFor(safe, 40, weakButSafeLaunch({ priceUsd: null })).blockers, 'MARKET_PRICE_UNKNOWN'],
  ];
  for (const [name, run, expected] of cases) {
    it(`${name} -> ${expected}`, () => {
      expect(run()).toContain(expected);
    });
  }

  it('permanent blockers end an ML BUY at once; waitable ones (pending checks) may still clear inside the window', () => {
    expect(ML_PERMANENT_BLOCKERS.has('SELLABILITY_FAILED')).toBe(true);
    expect(ML_PERMANENT_BLOCKERS.has('CREATOR_SELLING')).toBe(true);
    expect(ML_PERMANENT_BLOCKERS.has('SELLABILITY_NOT_VERIFIED')).toBe(false);
  });
});

describe('ML-only mode: DEFAULT strategy preferences never veto an ML BUY', () => {
  it('5. a low DEFAULT Launch Score / weak activity is not a blocker (only safety facts are read)', () => {
    const { result, blockers } = blockersFor(safe, 40, weakButSafeLaunch(), { minScore: 100, minTransactions: 10_000, minUniqueBuyers: 10_000, minBuySellRatio: 50 });
    expect(result.decision).not.toBe('BUY');
    expect(blockers).toEqual([]);
  });

  it('DEFAULT timing window and max. liquidity preference are ignored; their reason codes are documented as ignored', () => {
    expect(blockersFor(safe, 40, weakButSafeLaunch(), { minAgeSeconds: 600, observationSeconds: 600, maxAgeSeconds: 5, maxLiquidityUsd: 1_000 }).blockers).toEqual([]);
    for (const code of ['LAUNCH_TOO_YOUNG', 'OBSERVATION_IN_PROGRESS', 'LAUNCH_WINDOW_EXPIRED', 'LIQUIDITY_ABOVE_MAXIMUM', 'QUALITY_GATE_FAILED', 'SOCIAL_AVOID', 'LAUNCH_SCORE_BELOW_MINIMUM']) {
      expect(ML_IGNORED_DEFAULT_FILTERS as readonly string[]).toContain(code);
    }
  });

  it('safety codes are never in the ignored list', () => {
    for (const code of ['SELLABILITY_NOT_VERIFIED', 'SELLABILITY_FAILED', 'FREEZE_AUTHORITY_ACTIVE', 'MINT_AUTHORITY_ACTIVE', 'LIQUIDITY_BELOW_MINIMUM', 'PRICE_IMPACT_TOO_HIGH', 'RISK_NOT_ASSESSED', 'CREATOR_SELLING', 'CRITICAL_LIQUIDITY']) {
      expect(ML_IGNORED_DEFAULT_FILTERS as readonly string[]).not.toContain(code);
    }
  });

  it('risk-decision conviction comes from the ML probability vs. its threshold (not the DEFAULT score)', () => {
    expect(mlRiskConviction(0.83, 0.3)).toEqual({ signalScore: 83, minimumSignalScore: 30 });
    // CONSERVATIVE + HIGH risk needs >= 80: a 0.5 probability does not satisfy it, 0.85 does.
    expect(mlRiskConviction(0.5, 0.3).signalScore).toBeLessThan(80);
    // Missing / invalid probability never passes (NaN fails every minimum).
    expect(Number.isNaN(mlRiskConviction(null, 0.3).signalScore)).toBe(true);
    expect(mlRiskConviction(0.9, 2).minimumSignalScore).toBe(90);
  });
});

describe('Optional token-security vetoes (experimental ML PAPER mode)', () => {
  const all = ['SELLABILITY_NOT_VERIFIED', 'FREEZE_AUTHORITY_ACTIVE', 'MINT_AUTHORITY_ACTIVE', 'CRITICAL_TOKEN_EXTENSION', 'CREATOR_SELLING', 'CRITICAL_LIQUIDITY', 'HONEYPOT_SUSPECTED', 'LIQUIDITY_BELOW_MINIMUM', 'PRICE_IMPACT_TOO_HIGH', 'MARKET_PRICE_UNKNOWN', 'RISK_NOT_ASSESSED', 'MARKET_DATA_STALE'];

  it('checks ON: everything is enforced (unchanged)', () => {
    expect(applyTokenSafetySetting(all, true, ['HONEYPOT_SUSPECTED'])).toEqual({ enforced: all, ignored: [] });
  });

  it('checks OFF: only token-security blockers (incl. hard blocks of the security lookup) become ignored warnings', () => {
    const { enforced, ignored } = applyTokenSafetySetting(all, false, ['HONEYPOT_SUSPECTED']);
    expect(ignored).toEqual(['SELLABILITY_NOT_VERIFIED', 'FREEZE_AUTHORITY_ACTIVE', 'MINT_AUTHORITY_ACTIVE', 'CRITICAL_TOKEN_EXTENSION', 'CREATOR_SELLING', 'CRITICAL_LIQUIDITY', 'HONEYPOT_SUSPECTED']);
    expect(enforced).toEqual(['LIQUIDITY_BELOW_MINIMUM', 'PRICE_IMPACT_TOO_HIGH', 'MARKET_PRICE_UNKNOWN', 'RISK_NOT_ASSESSED', 'MARKET_DATA_STALE']);
  });

  it('market, liquidity, price impact and risk codes are never token-security codes', () => {
    for (const code of ['LIQUIDITY_BELOW_MINIMUM', 'PRICE_IMPACT_TOO_HIGH', 'PRICE_IMPACT_UNKNOWN', 'MARKET_PRICE_UNKNOWN', 'RISK_NOT_ASSESSED', 'RISK_NOT_CLASSIFIED', 'RISK_SCORE_ABOVE_LAUNCH_MAXIMUM', 'MARKET_DATA_STALE', 'UNPRICED_EXECUTION']) {
      expect(ML_TOKEN_SAFETY_BLOCKERS.has(code)).toBe(false);
    }
  });
});

describe('PAPER research target (task 12): real trade results only, never invented', () => {
  const row = (index: number, overrides: Partial<MlDatasetSourceRow> = {}): MlDatasetSourceRow => {
    const path = newOutcomePath(T + index * 60_000, 1, 10_000);
    recordPathPoint(path, path.startAt + 30_000, 1.3);
    const state = weakButSafeLaunch();
    const snapshot = buildMlFeatureSnapshot({ snapshotAt: T, source: 'PUMP_FUN', detectedAt: T - 30_000, createdAt: T - 31_000, firstTradeAt: T - 29_000, state, security: safe, securityObservedAt: T - 5_000, riskScore: 40, riskObservedAt: T - 1_000, social: null, referenceImpactPct: 1 });
    return {
      snapshotId: `s${index}`, candidateId: `c${index}`, mint: `m${index}`, source: 'PUMP_FUN', kind: 'AGE_30S', snapshotAt: T + index * 60_000, featureVersion: 'ML-FEATURES-v1',
      features: snapshot.features, validForTraining: true, invalidReasons: [], dataQuality: snapshot.dataQuality, decision: 'WATCH',
      outcome: computeCandidateOutcome(path, path.startAt + 3_700_000), paperNetPnl: null, paperExitAt: null, paperEntryStrategy: null, ...overrides,
    };
  };
  const config = { version: 'T', featureVersion: 'ML-FEATURES-v1', labelVersion: 'ML-LABELS-v1', target: 'paperNetPositive', snapshotKind: 'AGE_30S', minDataQuality: 0 };

  it('only candidates with a closed PAPER trade, label = net > 0, label_end = trade exit, flagged selection-biased', () => {
    const rows = [
      row(1, { paperNetPnl: 2.5, paperExitAt: T + 600_000, paperEntryStrategy: 'ML' }),
      row(2, { paperNetPnl: -1.2, paperExitAt: T + 900_000, paperEntryStrategy: 'DEFAULT' }),
      row(3),
    ];
    const built = buildMlDataset(rows, config);
    expect(built.rows).toBe(2);
    expect(built.manifest.excluded).toEqual({ NO_CLOSED_PAPER_TRADE: 1 });
    expect(built.manifest.selectionBiased).toBe(true);
    expect(built.manifest.paperTradesByStrategy).toEqual({ ML: 1, DEFAULT: 1 });
    const lines = built.csv.trim().split('\n').slice(1).map((line) => line.split(','));
    expect(lines.map((cells) => [cells[6], cells[8]])).toEqual([[String(T + 600_000), '1'], [String(T + 900_000), '0']]);
  });

  it('the market-opportunity target keeps every eligible candidate (not only the bought ones): no selection bias', () => {
    const rows = [row(1, { paperNetPnl: 2.5, paperExitAt: T + 600_000, paperEntryStrategy: 'ML' }), row(2), row(3)];
    const built = buildMlDataset(rows, { ...config, target: 'plus20BeforeMinus10_30m' });
    expect(built.rows).toBe(3);
    expect(built.manifest.selectionBiased).toBe(false);
  });
});
