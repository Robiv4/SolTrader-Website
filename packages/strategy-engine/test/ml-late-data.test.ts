/**
 * Late social data vs. real leakage (FUTURE_DATA_SOCIAL fix): late optional social data is excluded (null, audited, not
 * back-dated) without invalidating the snapshot; late critical data (security / risk) still invalidates it.
 * ML-FEATURES-v1 compatibility: the excluded snapshot is exactly the "social not available" input the v1 models know.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  buildMlFeatureSnapshot, ML_FEATURE_SCHEMA, ML_FEATURE_VERSION, ML_OPTIONAL_LATE_GROUPS, predictMl, validateArtifact, vectorize,
  type LaunchObservation, type LaunchSecurity, type MlModelArtifact, type SocialSnapshotResult,
} from '../src/index.js';

const T = Date.parse('2026-10-05T12:00:30Z');
const security: LaunchSecurity = { sellability: 'VERIFIED', mintAuthorityRevoked: true, freezeAuthorityRevoked: true, tokenProgram: 'spl-token', extensions: [], hardBlockReasons: [], warnings: [] };
const obs = (seconds: number, price: number): LaunchObservation => ({ takenAt: T + seconds * 1000, priceUsd: price, liquidityUsd: 20_000, buyCount: 20 + seconds, sellCount: 4, volumeUsd: 900 + seconds * 20, buyVolumeUsd: 700, sellVolumeUsd: 200, uniqueBuyers: 14, uniqueSellers: 3 });
const launchState = { mint: 'M', detectedAt: T - 30_000, createdAt: T - 31_000, observations: [obs(-28, 1), obs(-20, 1.05), obs(-10, 1.1), obs(0, 1.12), obs(3, 9)], largestBuyerShare: 0.2, buysPerBuyer: 1.2, creatorSoldRatio: 0, largestHolderSupplyShare: 0.03, priceImpactPercent: 1, observedSellers: 2 };
const base = { snapshotAt: T, source: 'PUMP_FUN', detectedAt: T - 30_000, createdAt: T - 31_000, firstTradeAt: T - 29_000, state: launchState, security, securityObservedAt: T - 5_000, riskScore: 40, riskObservedAt: T, referenceImpactPct: 1.1 };
const socialAt = (at: number) => ({
  at, dataQuality: 85, perSource: { TELEGRAM: { momentum: 95, quality: 80, spam: 5, exhaustion: 10, dataQuality: 90, messages: { '1m': 40, '5m': 120 }, uniqueActiveUsers: { '5m': 33 }, uniqueUserGrowth1m: 12, top3UserShare: 0.2 } },
}) as unknown as SocialSnapshotResult;
const SOCIAL_FEATURES = ML_FEATURE_SCHEMA.filter((spec) => spec.group === 'SOCIAL').map((spec) => spec.name);

describe('late social data is excluded, never leaked (task 2 / 3 / 5)', () => {
  it('a snapshot whose only late input is social: not one social feature is used, the rest is identical to "no social"', () => {
    const late = buildMlFeatureSnapshot({ ...base, social: socialAt(T + 1_500) });
    const none = buildMlFeatureSnapshot({ ...base, social: null });
    expect(SOCIAL_FEATURES.length).toBeGreaterThan(5);
    for (const name of SOCIAL_FEATURES) expect(late.features[name]).toBeNull();
    expect(late.features).toEqual(none.features);
    expect(late.dataQuality).toBe(none.dataQuality);
    expect(late).toMatchObject({ validForTraining: true, invalidReasons: [], lateDataExcluded: ['SOCIAL'] });
    // Audit: the real social time stays recorded (later than the snapshot) - nothing is back-dated.
    expect(late.observedAt.SOCIAL).toBe(T + 1_500);
    expect(late.snapshotAt).toBe(T);
    // Market data after the snapshot (the 9.0 price at +3 s) is cut as before.
    expect(late.referencePriceUsd).toBe(1.12);
  });

  it('social observed at or before the snapshot is used', () => {
    const onTime = buildMlFeatureSnapshot({ ...base, social: socialAt(T) });
    expect(onTime.features.telegramMomentum).toBe(95);
    expect(onTime.lateDataExcluded).toEqual([]);
    expect(onTime.validForTraining).toBe(true);
  });

  it('only SOCIAL is an optional group; critical groups are never excluded silently', () => {
    expect(ML_OPTIONAL_LATE_GROUPS).toEqual(['SOCIAL']);
  });
});

describe('real leakage stays invalid (task 4)', () => {
  it('security read after the snapshot: invalid, security values not used (also together with late social)', () => {
    const snapshot = buildMlFeatureSnapshot({ ...base, securityObservedAt: T + 1, social: socialAt(T + 1_000) });
    expect(snapshot.validForTraining).toBe(false);
    expect(snapshot.invalidReasons).toContain('FUTURE_DATA_SECURITY');
    expect(snapshot.invalidReasons).not.toContain('FUTURE_DATA_SOCIAL');
    expect(snapshot.features.mintAuthorityRevoked).toBeNull();
    expect(snapshot.lateDataExcluded).toEqual(['SOCIAL']);
  });

  it('risk computed after the snapshot: invalid and the risk score is not used', () => {
    const snapshot = buildMlFeatureSnapshot({ ...base, riskObservedAt: T + 500 });
    expect(snapshot.invalidReasons).toContain('FUTURE_DATA_RISK');
    expect(snapshot.features.riskScore).toBeNull();
    expect(snapshot.validForTraining).toBe(false);
  });
});

describe('ML-FEATURES-v1 compatibility (task 7)', () => {
  const fixture = JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'ml-parity.json'), 'utf8')) as Record<string, { artifact: MlModelArtifact }>;

  it('schema and version unchanged (the exported features-v1.json still matches)', () => {
    const exported = JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'ml', 'schema', 'features-v1.json'), 'utf8')) as { featureVersion: string; features: Array<{ name: string; group: string }> };
    expect(ML_FEATURE_VERSION).toBe('ML-FEATURES-v1');
    expect(exported.featureVersion).toBe(ML_FEATURE_VERSION);
    expect(exported.features.map((spec) => `${spec.name}:${spec.group}`)).toEqual(ML_FEATURE_SCHEMA.map((spec) => `${spec.name}:${spec.group}`));
  });

  for (const algorithm of ['LR', 'LGBM']) {
    it(`${algorithm}: a late-social snapshot is the same model input as "no social" (same vector, same probability)`, () => {
      const artifact = validateArtifact(fixture[algorithm].artifact);
      const late = buildMlFeatureSnapshot({ ...base, social: socialAt(T + 2_000) });
      const none = buildMlFeatureSnapshot({ ...base, social: null });
      const a = vectorize(late.features, artifact);
      const b = vectorize(none.features, artifact);
      expect(a.map((value) => (Number.isNaN(value) ? 'NaN' : value))).toEqual(b.map((value) => (Number.isNaN(value) ? 'NaN' : value)));
      expect(predictMl(artifact, late.features).probability).toBe(predictMl(artifact, none.features).probability);
      expect(Number.isFinite(predictMl(artifact, late.features).probability)).toBe(true);
    });
  }
});
