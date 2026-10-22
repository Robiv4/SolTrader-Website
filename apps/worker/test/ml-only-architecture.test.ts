/* eslint-disable @typescript-eslint/no-explicit-any -- in-memory fakes */
/**
 * SolTrader 3.0 ML-only architecture (ML_ONLY_ARCHITECTURE_ENABLED) through the real New Launch service, SHADOW
 * collection and ML PAPER engine (in-memory fakes, no database, no network):
 *  - without a model: data collection runs (snapshots, outcomes, social / community tracking), no BUY at all;
 *  - data collection does not depend on users, models, BUY signals or DEFAULT thresholds;
 *  - only the selected, approved model may enter; an unusable model never falls back to DEFAULT;
 *  - pause stops entries only; the flag OFF keeps the legacy behaviour unchanged.
 */
import { describe, expect, it } from 'vitest';

import { runScenario } from './helpers/ml-scenario.js';

const ML_ROW = { userId: 'u1', strategyMode: 'ML', modelVersion: 'M1', buyThreshold: 0.7, decisionWindowSeconds: 30, minLiquidityUsd: null };

function collectors() {
  const social: string[] = [];
  const community: string[] = [];
  return {
    social,
    community,
    socialFactory: () => ({ track: (input: { mint: string }) => social.push(input.mint), assess: () => null, latest: () => null }) as any,
    communityService: { track: (mint: string) => community.push(mint), onTrade: () => undefined, assess: () => null } as any,
  };
}

const snapshotsOf = (run: Awaited<ReturnType<typeof runScenario>>) => run.record.ml.mlFeatureSnapshot ?? [];

describe('ML-only: no trading model -> DATA_COLLECTION', () => {
  it('legacy baseline (flag off): the DEFAULT strategy buys in this scenario', async () => {
    const legacy = await runScenario({ mode: 'DEFAULT', engine: 'none' });
    expect(legacy.record.signals.length).toBeGreaterThan(0);
    expect(legacy.record.signals.every((signal: any) => signal.entryStrategy === 'DEFAULT')).toBe(true);
  }, 60_000);

  it('no model selected: no BUY of any kind, but snapshots (AGE_30S = outcome tracking point) and social / community collection run', async () => {
    const c = collectors();
    const run = await runScenario({ mode: 'DEFAULT', settingsRows: [] }, { mlOnly: true, shadow: true, social: c.socialFactory, community: c.communityService });
    expect(run.record.signals).toEqual([]);
    expect(run.paperDecisions).toEqual([]);
    expect(snapshotsOf(run).some((row: any) => row.kind === 'AGE_30S')).toBe(true);
    expect(c.social.length).toBeGreaterThan(0);
    expect(c.community.length).toBeGreaterThan(0);
    // The rule-based evaluation is still recorded (data / comparison), it just cannot buy.
    expect(run.record.decisions.length).toBeGreaterThan(0);
  }, 60_000);

  it('an old DEFAULT selection is treated as "no trading model" (no DEFAULT entries in ML-only mode)', async () => {
    const run = await runScenario({ mode: 'DEFAULT' }, { mlOnly: true });
    expect(run.record.signals).toEqual([]);
    expect(run.paperDecisions).toEqual([]);
  }, 60_000);

  it('no New Launch user at all: data collection still runs (independent of users and strategies)', async () => {
    const c = collectors();
    const run = await runScenario({ mode: 'ML', noUsers: true }, { mlOnly: true, shadow: true, social: c.socialFactory, community: c.communityService });
    expect(run.record.decisions).toEqual([]);
    expect(run.record.signals).toEqual([]);
    expect(snapshotsOf(run).filter((row: any) => row.kind === 'AGE_30S')).toHaveLength(1);
    expect(snapshotsOf(run)[0].decision).toBe('NOT_EVALUATED');
    expect(new Set(c.social)).toEqual(new Set([snapshotsOf(run)[0].mint]));
    expect(c.community.length).toBeGreaterThan(0);
  }, 60_000);
});

describe('ML-only: only the selected, approved model may enter', () => {
  it('selected approved model: ML entries of that model only, never a DEFAULT entry', async () => {
    const run = await runScenario({ mode: 'ML', probability: 0.95, settingsRows: [ML_ROW] }, { mlOnly: true });
    expect(run.paperDecisions[0]).toMatchObject({ mlDecision: 'ML_BUY', modelVersion: 'M1' });
    expect(run.record.signals).toHaveLength(1);
    expect(run.record.signals[0]).toMatchObject({ entryStrategy: 'ML', ml: expect.objectContaining({ modelVersion: 'M1' }) });
  }, 60_000);

  it('model revoked / missing / retired: MODEL_UNAVAILABLE, no entries and no DEFAULT fallback', async () => {
    for (const registryRows of [[{ version: 'M1', paperApproved: false, status: 'SHADOW', featureVersion: 'ML-FEATURES-v1' }], [], [{ version: 'M1', paperApproved: true, status: 'RETIRED', featureVersion: 'ML-FEATURES-v1' }], [{ version: 'M1', paperApproved: true, status: 'SHADOW', featureVersion: 'ML-FEATURES-v999' }]]) {
      const run = await runScenario({ mode: 'ML', probability: 0.95, settingsRows: [ML_ROW], registryRows }, { mlOnly: true });
      expect(run.record.signals).toEqual([]);
      expect(run.paperDecisions).toEqual([]);
    }
  }, 120_000);

  it('trading paused: no new entries (data collection continues)', async () => {
    const run = await runScenario({ mode: 'ML', probability: 0.95, settingsRows: [{ ...ML_ROW, tradingPaused: true }] }, { mlOnly: true, shadow: true });
    expect(run.record.signals).toEqual([]);
    expect(snapshotsOf(run).length).toBeGreaterThan(0);
  }, 60_000);

  it('below the threshold the model skips: it does not buy everything', async () => {
    const run = await runScenario({ mode: 'ML', probability: 0.3, settingsRows: [ML_ROW] }, { mlOnly: true });
    expect(run.paperDecisions[0]).toMatchObject({ mlDecision: 'ML_SKIP' });
    expect(run.record.signals).toEqual([]);
  }, 60_000);

  it('flag off: legacy ML mode unchanged (same entry as before)', async () => {
    const legacy = await runScenario({ mode: 'ML', probability: 0.95 });
    const mlOnly = await runScenario({ mode: 'ML', probability: 0.95, settingsRows: [ML_ROW] }, { mlOnly: true });
    expect(legacy.record.signals.map((signal: any) => signal.entryStrategy)).toEqual(['ML']);
    expect(mlOnly.paperDecisions[0].features).toEqual(legacy.paperDecisions[0].features);
  }, 60_000);
});
