/* eslint-disable @typescript-eslint/no-explicit-any -- in-memory prisma fakes */
/**
 * ML-only entry strategy: the approved ML model alone makes the strategic BUY / SKIP decision. The DEFAULT strategy's
 * decision, thresholds, timing window, quality gate and social filter never veto it; mandatory safety always does.
 */
import { describe, expect, it } from 'vitest';

import { runScenario } from './helpers/ml-scenario.js';

const decisionsOf = (run: Awaited<ReturnType<typeof runScenario>>) => run.record.decisions.map((row: any) => row.decision);

describe('ML-only entries: the DEFAULT strategy never vetoes an ML BUY', () => {
  it('1. DEFAULT never buys (score threshold unreachable), ML BUY + all safety green -> one ML PAPER entry signal', async () => {
    const config = { minScore: 100, minTransactions: 100_000, minUniqueBuyers: 100_000 };
    const baseline = await runScenario({ mode: 'DEFAULT', engine: 'none', config });
    expect(decisionsOf(baseline)).not.toContain('BUY');
    expect(baseline.record.signals).toHaveLength(0);

    const ml = await runScenario({ mode: 'ML', probability: 0.95, config });
    expect(decisionsOf(ml)).not.toContain('BUY');
    expect(ml.paperDecisions[0]).toMatchObject({ mlDecision: 'ML_BUY', outcome: 'SIGNALED' });
    expect(ml.paperDecisions[0].baseDecision).not.toBe('BUY');
    expect(ml.record.signals).toEqual([expect.objectContaining({ entryStrategy: 'ML' })]);
  }, 30_000);

  it('5. an enforced DEFAULT quality gate (low Launch Score) blocks DEFAULT entries but not the ML entry; it is stored for comparison', async () => {
    const config = { qualityGate: { mode: 'ENFORCE_PAPER', minLaunchScore: 100 } };
    const defaultRun = await runScenario({ mode: 'DEFAULT', engine: 'none', config });
    expect(defaultRun.record.signals).toHaveLength(0);

    const ml = await runScenario({ mode: 'ML', probability: 0.95, config });
    expect(ml.record.signals).toHaveLength(1);
    expect(ml.paperDecisions[0].baseReasons).toContain('COMPARE_QUALITY_GATE_WOULD_BLOCK');
    // The gate verdict travels with the signal for comparison only; PAPER execution does not apply it to ML entries.
    expect(ml.record.signalMetadata[0].launch.qualityGate).toMatchObject({ blocksEntry: true, appliesToEntry: false });
  }, 30_000);

  it('DEFAULT timing settings (min. age, observation, max. age) do not stop the ML decision at its own snapshot point', async () => {
    const late = await runScenario({ mode: 'ML', probability: 0.95, config: { minAgeSeconds: 100, observationSeconds: 100 } });
    expect(late.record.signals).toHaveLength(1);
    // The DEFAULT launch window is already over at the 30 s point; the ML is still evaluated there.
    const shortWindow = await runScenario({ mode: 'ML', probability: 0.95, config: { maxAgeSeconds: 10 } });
    expect(shortWindow.paperDecisions[0]).toMatchObject({ mlDecision: 'ML_BUY', outcome: 'SIGNALED' });
  }, 60_000);

  it('2. DEFAULT would buy, ML SKIP -> no entry at all', async () => {
    const skip = await runScenario({ mode: 'ML', probability: 0.2 });
    expect(decisionsOf(skip)).toContain('BUY');
    expect(skip.paperDecisions[0]).toMatchObject({ mlDecision: 'ML_SKIP', outcome: 'SKIPPED' });
    expect(skip.record.signals).toHaveLength(0);
  }, 30_000);
});

describe('Mandatory safety still blocks an ML BUY', () => {
  it('3. freeze authority active (token not safely sellable) -> ML BUY resolved as SAFETY_BLOCKED, no signal', async () => {
    const run = await runScenario({ mode: 'ML', probability: 0.95, mint: { mintAuthority: null, freezeAuthority: 'Freeze111', tokenProgram: 'spl-token', extensions: [] } });
    expect(run.paperDecisions[0]).toMatchObject({ mlDecision: 'ML_BUY', outcome: 'SAFETY_BLOCKED' });
    expect(run.paperDecisions[0].safetyBlockers).toContain('FREEZE_AUTHORITY_ACTIVE');
    expect(run.record.signals).toHaveLength(0);
  }, 30_000);

  it('4. insufficient liquidity -> the ML BUY expires unexecuted with the blocking rule recorded', async () => {
    const run = await runScenario({ mode: 'ML', probability: 0.95, config: { minLiquidityUsd: 50_000_000 } });
    expect(run.paperDecisions[0]).toMatchObject({ mlDecision: 'ML_BUY', outcome: 'EXPIRED' });
    expect(run.paperDecisions[0].safetyBlockers).toContain('LIQUIDITY_BELOW_MINIMUM');
    expect(run.record.signals).toHaveLength(0);
  }, 30_000);

  it('6. revoked model -> ML_ERROR, no entry and no DEFAULT fallback even when DEFAULT would buy', async () => {
    const run = await runScenario({ mode: 'ML', approved: false });
    expect(decisionsOf(run)).toContain('BUY');
    expect(run.paperDecisions[0]).toMatchObject({ mlDecision: 'ML_ERROR', outcome: 'ERROR' });
    expect(run.record.signals).toHaveLength(0);
  }, 30_000);
});
