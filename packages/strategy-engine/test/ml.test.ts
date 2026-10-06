/**
 * ML core: leakage protection, missing data, outcome labels, dataset determinism, train/serve parity (tests 105-113).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  buildMlDataset, buildMlFeatureSnapshot, computeCandidateOutcome, DEFAULT_NEW_LAUNCH_SETTINGS, evaluateNewLaunch, ML_FEATURE_SCHEMA, ML_META_COLUMNS,
  newOutcomePath, predictMl, recordPathPoint, validateArtifact,
  type LaunchObservation, type LaunchSecurity, type MlDatasetSourceRow, type MlModelArtifact, type SocialSnapshotResult,
} from '../src/index.js';

const T = Date.parse('2026-10-05T12:00:10Z');
const security: LaunchSecurity = { sellability: 'VERIFIED', mintAuthorityRevoked: true, freezeAuthorityRevoked: true, tokenProgram: 'spl-token', extensions: [], hardBlockReasons: [], warnings: [] };
const obs = (secondsFromT: number, price: number, extra: Partial<LaunchObservation> = {}): LaunchObservation => ({
  takenAt: T + secondsFromT * 1000, priceUsd: price, liquidityUsd: 10_000, buyCount: 10 + secondsFromT, sellCount: 2, volumeUsd: 500 + secondsFromT * 20,
  buyVolumeUsd: 400, sellVolumeUsd: 100, uniqueBuyers: 8, uniqueSellers: 2, ...extra,
});
const state = (observations: LaunchObservation[]) => ({ mint: 'M', detectedAt: T - 20_000, createdAt: T - 21_000, observations, largestBuyerShare: 0.2, buysPerBuyer: 1.2, creatorSoldRatio: 0, largestHolderSupplyShare: 0.03, priceImpactPercent: 1, observedSellers: 2 });
const base = { snapshotAt: T, source: 'PUMP_FUN', detectedAt: T - 20_000, createdAt: T - 21_000, firstTradeAt: T - 19_000, security, securityObservedAt: T - 5_000, riskScore: 40, riskObservedAt: T - 1_000, social: null, referenceImpactPct: 1.1 };

describe('ML feature snapshot: no look-ahead', () => {
  it('a future price update is not included (observations after snapshotAt are cut)', () => {
    const past = buildMlFeatureSnapshot({ ...base, state: state([obs(-20, 1), obs(-10, 1.1), obs(0, 1.2)]) });
    const withFuture = buildMlFeatureSnapshot({ ...base, state: state([obs(-20, 1), obs(-10, 1.1), obs(0, 1.2), obs(2, 5)]) });
    expect(withFuture.features).toEqual(past.features);
    expect(withFuture.referencePriceUsd).toBe(1.2);
    expect(withFuture.validForTraining).toBe(true);
  });

  it('a future Telegram snapshot is excluded and the snapshot is marked INVALID_FOR_TRAINING', () => {
    const social = { at: T + 2_000, dataQuality: 80, perSource: { TELEGRAM: { momentum: 90, messages: {}, uniqueActiveUsers: {} } } } as unknown as SocialSnapshotResult;
    const snapshot = buildMlFeatureSnapshot({ ...base, state: state([obs(-10, 1), obs(0, 1.1)]), social });
    expect(snapshot.features.telegramMomentum).toBeNull();
    expect(snapshot.validForTraining).toBe(false);
    expect(snapshot.invalidReasons).toEqual(expect.arrayContaining(['FUTURE_DATA_SOCIAL']));
  });

  it('security read after the snapshot -> invalid and the security values are not used', () => {
    const snapshot = buildMlFeatureSnapshot({ ...base, state: state([obs(-10, 1), obs(0, 1.1)]), securityObservedAt: T + 1 });
    expect(snapshot.validForTraining).toBe(false);
    expect(snapshot.features.mintAuthorityRevoked).toBeNull();
  });

  it('missing data stays null (no Telegram -> null, not 0; unknown authority -> null)', () => {
    const snapshot = buildMlFeatureSnapshot({ ...base, state: state([obs(-10, 1), obs(0, 1.1)]), security: { ...security, mintAuthorityRevoked: null, freezeAuthorityRevoked: null }, riskScore: null, riskObservedAt: null });
    expect(snapshot.features.telegramMomentum).toBeNull();
    expect(snapshot.features.socialAvailable).toBeNull();
    expect(snapshot.features.mintAuthorityRevoked).toBeNull();
    expect(snapshot.features.riskScore).toBeNull();
    // Volume over a window not covered by observations is unknown, not zero.
    expect(snapshot.features.volume1mUsd).toBeNull();
    expect(Object.keys(snapshot.features).sort()).toEqual(ML_FEATURE_SCHEMA.map((spec) => spec.name).sort());
  });
});

describe('ML outcomes (shadow)', () => {
  it('known synthetic path: returns, MFE / MAE, time-to-extremes and first-hit ordering', () => {
    const path = newOutcomePath(T, 1, 10_000);
    recordPathPoint(path, T + 5_000, 1.05);
    recordPathPoint(path, T + 20_000, 0.95);
    recordPathPoint(path, T + 40_000, 1.25);
    recordPathPoint(path, T + 200_000, 0.85);
    const outcome = computeCandidateOutcome(path, T + 3_700_000);
    expect(outcome.quality).toBe('COMPLETE');
    expect(outcome.horizons[30].returnPct).toBeCloseTo(-5, 6);
    expect(outcome.horizons[60]).toMatchObject({ mfePct: expect.closeTo(25, 6), maePct: expect.closeTo(-5, 6), timeToMfeS: 40, timeToMaeS: 20 });
    expect(outcome.horizons[300].maePct).toBeCloseTo(-15, 6);
    // +20 at 40 s happens before -10 (200 s): true; +25 before -20: -20 never reached, +25 reached -> true.
    expect(outcome.pathLabels.plus20BeforeMinus10).toBe(true);
    expect(outcome.pathLabels.plus10BeforeMinus10).toBe(true);
    expect(outcome.pathLabels.plus50BeforeMinus20).toBe(false);
    expect(outcome.events.reachedPlus25).toBe(true);
    expect(outcome.events.reachedMinus15).toBe(true);
    expect(outcome.events.reachedMinus20).toBe(false);
  });

  it('both thresholds crossed inside the same bucket -> UNKNOWN (never guessed)', () => {
    const path = newOutcomePath(T, 1, null);
    recordPathPoint(path, T + 1_000, 1.3);
    recordPathPoint(path, T + 1_500, 0.85);
    const outcome = computeCandidateOutcome(path, T + 3_700_000);
    expect(outcome.pathLabels.plus20BeforeMinus10).toBeNull();
  });

  it('incomplete path: later horizons invalid, label UNKNOWN when nothing was reached yet', () => {
    const path = newOutcomePath(T, 1, null);
    recordPathPoint(path, T + 30_000, 1.05);
    const partial = computeCandidateOutcome(path, T + 120_000);
    expect(partial.quality).toBe('PARTIAL');
    expect(partial.horizons[600].valid).toBe(false);
    expect(partial.pathLabels.plus20BeforeMinus10).toBeNull();
    // A stream gap inside the window also invalidates overlapping horizons.
    const gapped = newOutcomePath(T, 1, null);
    gapped.gaps.push([T + 100_000, T + 160_000]);
    const outcome = computeCandidateOutcome(gapped, T + 3_700_000);
    expect(outcome.horizons[60].valid).toBe(true);
    expect(outcome.horizons[300].valid).toBe(false);
    expect(outcome.failures.marketDataLost).toBe(true);
  });

  it('liquidity collapse + creator sell = rug-like (documented); price drop alone is not called a rug', () => {
    const path = newOutcomePath(T, 1, 10_000);
    recordPathPoint(path, T + 10_000, 0.3, 2_000);
    const noCreatorSell = computeCandidateOutcome(path, T + 3_700_000);
    expect(noCreatorSell.failures).toMatchObject({ liquidityCollapse: true, rugLikeFailure: false, extremeDrawdown: true });
    path.creatorSellAt = T + 9_000;
    expect(computeCandidateOutcome(path, T + 3_700_000).failures.rugLikeFailure).toBe(true);
  });
});

describe('ML dataset builder', () => {
  const row = (index: number, overrides: Partial<MlDatasetSourceRow> = {}): MlDatasetSourceRow => {
    const path = newOutcomePath(T + index * 60_000, 1, 10_000);
    recordPathPoint(path, path.startAt + 30_000, index % 3 === 0 ? 1.3 : 0.85);
    const snapshot = buildMlFeatureSnapshot({ ...base, snapshotAt: T + index * 60_000, state: state([obs(index * 60 - 5, 1), obs(index * 60, 1)]) });
    return {
      snapshotId: `s${index}`, candidateId: `c${index}`, mint: `m${index}`, source: 'PUMP_FUN', kind: 'AGE_30S', snapshotAt: snapshot.snapshotAt, featureVersion: 'ML-FEATURES-v1',
      features: snapshot.features, validForTraining: snapshot.validForTraining, invalidReasons: snapshot.invalidReasons, dataQuality: snapshot.dataQuality,
      decision: index % 2 ? 'WATCH' : 'REJECT', outcome: computeCandidateOutcome(path, path.startAt + 3_700_000), paperNetPnl: null, ...overrides,
    };
  };
  const config = { version: 'TEST-1', featureVersion: 'ML-FEATURES-v1', labelVersion: 'ML-LABELS-v1', target: 'plus20BeforeMinus10_30m', snapshotKind: 'AGE_30S', minDataQuality: 0 };

  it('is deterministic (same rows in any order -> identical CSV), one row per candidate, invalid rows excluded', () => {
    const rows = Array.from({ length: 12 }, (_, index) => row(index));
    rows.push(row(20, { candidateId: 'c3', snapshotId: 's20' }));
    rows.push(row(21, { validForTraining: false, invalidReasons: ['FUTURE_DATA_SOCIAL'] }));
    const a = buildMlDataset(rows, config);
    const b = buildMlDataset([...rows].reverse(), config);
    expect(a.csv).toBe(b.csv);
    expect(a.rows).toBe(12);
    expect(a.manifest.excluded).toMatchObject({ DUPLICATE_CANDIDATE: 1, INVALID_FOR_TRAINING: 1 });
    expect(a.manifest.leakageViolations).toBe(1);
    expect(a.manifest.decisions).toEqual({ REJECT: 6, WATCH: 6 });
  });

  it('outcome data never enters feature columns', () => {
    const { csv } = buildMlDataset([row(1)], config);
    const header = csv.split('\n')[0].split(',');
    const featureColumns = header.slice(ML_META_COLUMNS.length);
    expect(featureColumns.every((name) => ML_FEATURE_SCHEMA.some((spec) => spec.name === name))).toBe(true);
    expect(header.filter((name) => /mfe|mae|return|reached|outcome/i.test(name))).toEqual([]);
  });
});

describe('ML inference (train / serve parity with the Python trainer)', () => {
  const fixture = JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'ml-parity.json'), 'utf8')) as Record<string, { artifact: MlModelArtifact; rows: Array<{ features: Record<string, unknown>; probability: number }> }>;

  for (const algorithm of ['LR', 'LGBM']) {
    it(`${algorithm}: TypeScript predictions equal the Python model's probabilities`, () => {
      const artifact = validateArtifact(fixture[algorithm].artifact);
      for (const item of fixture[algorithm].rows) {
        const features = Object.fromEntries(Object.entries(item.features).map(([key, value]) => [key, typeof value === 'number' && ['mintAuthorityRevoked', 'freezeAuthorityRevoked', 'tokenProgram2022', 'restrictedExtension', 'sellabilityVerified', 'socialAvailable'].includes(key) ? value === 1 : value]));
        expect(predictMl(artifact, features as never).probability).toBeCloseTo(item.probability, 9);
      }
    });
  }

  it('corrupt / foreign artifacts are rejected', () => {
    expect(() => validateArtifact({ format: 'pickle' })).toThrow();
    expect(() => validateArtifact({ ...fixture.LR.artifact, columns: [{ name: 'x', feature: 'notAFeature', kind: 'value' }] })).toThrow(/unknown feature/);
  });
});

describe('Hard safety hierarchy (ML can never authorise a trade)', () => {
  it('sellability not verified -> the NewLaunch policy does not BUY, whatever any ML score would be', () => {
    const observations = Array.from({ length: 12 }, (_, i) => obs(i * 2 - 24, 1 + i / 50, { buyCount: 5 + i * 4, uniqueBuyers: 3 + i * 3, liquidityUsd: 30_000 }));
    const result = evaluateNewLaunch(state(observations), { ...security, sellability: 'NOT_VERIFIED' }, { riskScore: 40, classification: 'MODERATE', hardBlockReasons: [] }, { ...DEFAULT_NEW_LAUNCH_SETTINGS, enabled: true }, T);
    expect(result.decision).not.toBe('BUY');
  });
});
