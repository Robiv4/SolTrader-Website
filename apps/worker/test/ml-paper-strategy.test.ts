/* eslint-disable @typescript-eslint/no-explicit-any -- in-memory prisma fakes */

import { describe, expect, it } from 'vitest';

import { runScenario } from './helpers/ml-scenario.js';

describe('Selectable entry strategy in New Launch', () => {
  it('1. DEFAULT strategy is unchanged by the ML PAPER engine (identical decisions and BUY signal)', async () => {
    const baseline = await runScenario({ mode: 'DEFAULT', engine: 'none' });
    const withEngine = await runScenario({ mode: 'DEFAULT', engine: 'real', probability: 0.99 });
    expect(baseline.record.signals).toHaveLength(1);
    expect(baseline.record.signals[0].entryStrategy).toBe('DEFAULT');
    expect(withEngine.record.decisions).toEqual(baseline.record.decisions);
    expect(withEngine.record.signals).toEqual(baseline.record.signals);
    expect(withEngine.paperDecisions).toHaveLength(0);
  }, 30_000);

  it('3. ML BUY: exactly one BUY signal, made by the ML (never a second, rule-based one)', async () => {
    const ml = await runScenario({ mode: 'ML', probability: 0.95 });
    expect(ml.paperDecisions).toHaveLength(1);
    expect(ml.paperDecisions[0]).toMatchObject({ mlDecision: 'ML_BUY', modelVersion: 'M1', snapshotKind: 'AGE_30S' });
    expect(ml.record.signals).toHaveLength(1);
    expect(ml.record.signals[0]).toMatchObject({ entryStrategy: 'ML', ml: { modelVersion: 'M1', decisionId: ml.paperDecisions[0].id, snapshotKind: 'AGE_30S' } });
    expect(ml.paperDecisions[0].outcome).toBe('SIGNALED');
    // The entry follows the decision (decided at the 30 s point; the signal can only come at / after it).
    expect(ml.paperDecisions[0].snapshotAt.getTime() - ml.paperDecisions[0].detectedAt.getTime()).toBeGreaterThanOrEqual(30_000);
  }, 30_000);

  it('3. ML SKIP: no entry although the rule-based strategy would have bought', async () => {
    const skip = await runScenario({ mode: 'ML', probability: 0.2 });
    expect(skip.paperDecisions[0]).toMatchObject({ mlDecision: 'ML_SKIP', outcome: 'SKIPPED' });
    expect(skip.record.signals).toHaveLength(0);
    // The rule-based decision is still recorded for comparison (it says BUY, nothing was bought).
    expect(skip.record.decisions.some((decision: any) => decision.decision === 'BUY')).toBe(true);
  }, 30_000);

  it('6 / 8. broken model or crashing engine: no entry, no fallback, the tick keeps working (data collection unchanged)', async () => {
    const baseline = await runScenario({ mode: 'DEFAULT', engine: 'none' });
    const revoked = await runScenario({ mode: 'ML', approved: false });
    expect(revoked.record.signals).toHaveLength(0);
    expect(revoked.paperDecisions[0]).toMatchObject({ mlDecision: 'ML_ERROR', errorReason: 'MODEL_NOT_PAPER_APPROVED' });
    // Same rule-based evaluation step by step (in ML mode it keeps being logged after the would-be BUY, for comparison).
    const prefix = (run: typeof baseline) => run.record.decisions.slice(0, baseline.record.decisions.length);
    expect(prefix(revoked)).toEqual(baseline.record.decisions);
    const crashing = await runScenario({ mode: 'ML', engine: 'throwing' });
    expect(crashing.record.signals).toHaveLength(0);
    expect(prefix(crashing)).toEqual(baseline.record.decisions);
  }, 30_000);

  it('10. SHADOW collection is identical in DEFAULT and ML mode; PAPER decisions are stored separately', async () => {
    const shadowOnly = await runScenario({ mode: 'DEFAULT', engine: 'none' }, { shadow: true });
    const withMlPaper = await runScenario({ mode: 'ML', probability: 0.95 }, { shadow: true });
    const kinds = (run: typeof shadowOnly) => (run.record.ml.mlFeatureSnapshot ?? []).map((row) => `${row.kind}:${row.featureVersion}`);
    expect(kinds(withMlPaper)).toEqual(kinds(shadowOnly));
    expect(kinds(shadowOnly)).toEqual(expect.arrayContaining(['AGE_15S:ML-FEATURES-v1', 'AGE_30S:ML-FEATURES-v1', 'AGE_60S:ML-FEATURES-v1']));
    // The PAPER engine never writes SHADOW tables (no shadow prediction / snapshot / outcome rows from it).
    expect((withMlPaper.record.ml.mlPrediction ?? []).length).toBe((shadowOnly.record.ml.mlPrediction ?? []).length);
    expect(withMlPaper.record.ml.mlPaperDecision).toBeUndefined();
    expect(withMlPaper.paperDecisions).toHaveLength(1);
  }, 60_000);
});
