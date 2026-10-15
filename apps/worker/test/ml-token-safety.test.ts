/* eslint-disable @typescript-eslint/no-explicit-any -- in-memory prisma fakes */
/**
 * Optional token-security checks of the ML PAPER strategy (per user, default ON). OFF = experimental PAPER-only mode: token
 * security blockers become warnings; market data, liquidity, price impact, risk, model approval and every execution /
 * account limit stay mandatory. The DEFAULT strategy is unaffected by the setting.
 */
import { describe, expect, it } from 'vitest';

import { toMlPaperConfig } from '../src/ml/ml-paper-engine.js';

import { runScenario } from './helpers/ml-scenario.js';

const FREEZE_ACTIVE = { mintAuthority: null, freezeAuthority: 'Freeze111', tokenProgram: 'spl-token', extensions: [] };
const MINT_ACTIVE = { mintAuthority: 'Mint1111', freezeAuthority: null, tokenProgram: 'spl-token', extensions: [] };

describe('ML PAPER token-security checks ON (default, unchanged)', () => {
  it('1. ML BUY + failed token security -> no entry', async () => {
    const run = await runScenario({ mode: 'ML', probability: 0.95, mint: FREEZE_ACTIVE });
    expect(run.paperDecisions[0]).toMatchObject({ mlDecision: 'ML_BUY', outcome: 'SAFETY_BLOCKED', tokenSafetyChecksEnabled: true });
    expect(run.record.signals).toHaveLength(0);
  }, 30_000);

  it('11. a missing / unknown stored value means checks ON (old users keep the safe default)', () => {
    expect(toMlPaperConfig({ strategyMode: 'ML', modelVersion: 'M1', buyThreshold: 0.7, decisionWindowSeconds: 10 }).tokenSafetyChecksEnabled).toBe(true);
    expect(toMlPaperConfig({ strategyMode: 'ML', modelVersion: 'M1', buyThreshold: 0.7, decisionWindowSeconds: 10, tokenSafetyChecksEnabled: null }).tokenSafetyChecksEnabled).toBe(true);
    expect(toMlPaperConfig({ strategyMode: 'ML', modelVersion: 'M1', buyThreshold: 0.7, decisionWindowSeconds: 10, tokenSafetyChecksEnabled: false }).tokenSafetyChecksEnabled).toBe(false);
  });
});

describe('ML PAPER token-security checks OFF (experimental)', () => {
  it('2 / 12. ML BUY + failed token security -> entry signal; the ignored checks are recorded on the decision and the signal', async () => {
    for (const mint of [FREEZE_ACTIVE, MINT_ACTIVE]) {
      const run = await runScenario({ mode: 'ML', probability: 0.95, tokenSafety: false, mint });
      const decision = run.paperDecisions[0];
      expect(decision).toMatchObject({ mlDecision: 'ML_BUY', outcome: 'SIGNALED', tokenSafetyChecksEnabled: false });
      expect(decision.ignoredSafetyBlockers).toContain(mint === FREEZE_ACTIVE ? 'FREEZE_AUTHORITY_ACTIVE' : 'MINT_AUTHORITY_ACTIVE');
      expect(run.record.signals).toHaveLength(1);
      const meta = run.record.signalMetadata[0];
      expect(meta.ml).toMatchObject({ tokenSafetyChecksEnabled: false, experimental: true });
      // Execution limits work on the market-only risk; the real (security-inclusive) assessment stays as warnings.
      expect(meta.riskClassification).not.toBe('BLOCKED');
      expect(meta.riskWarnings.some((warning: string) => warning.startsWith('IGNORED_TOKEN_SAFETY:'))).toBe(true);
    }
  }, 60_000);

  it('3. ML SKIP -> no entry', async () => {
    const run = await runScenario({ mode: 'ML', probability: 0.2, tokenSafety: false, mint: FREEZE_ACTIVE });
    expect(run.paperDecisions[0]).toMatchObject({ mlDecision: 'ML_SKIP' });
    expect(run.record.signals).toHaveLength(0);
  }, 30_000);

  it('4. market / liquidity checks stay mandatory: liquidity below the minimum -> no entry', async () => {
    const run = await runScenario({ mode: 'ML', probability: 0.95, tokenSafety: false, mint: FREEZE_ACTIVE, config: { minLiquidityUsd: 50_000_000 } });
    expect(run.paperDecisions[0]).toMatchObject({ mlDecision: 'ML_BUY', outcome: 'EXPIRED' });
    expect(run.paperDecisions[0].safetyBlockers).toContain('LIQUIDITY_BELOW_MINIMUM');
    expect(run.paperDecisions[0].safetyBlockers).not.toContain('FREEZE_AUTHORITY_ACTIVE');
    expect(run.record.signals).toHaveLength(0);
  }, 30_000);

  it('7. revoked model -> ML_ERROR, no entry', async () => {
    const run = await runScenario({ mode: 'ML', approved: false, tokenSafety: false, mint: FREEZE_ACTIVE });
    expect(run.paperDecisions[0]).toMatchObject({ mlDecision: 'ML_ERROR' });
    expect(run.record.signals).toHaveLength(0);
  }, 30_000);
});

describe('8. DEFAULT strategy ignores the setting', () => {
  it('identical decisions and signals whatever the stored ML token-security value; unsafe tokens still never bought', async () => {
    const on = await runScenario({ mode: 'DEFAULT', engine: 'none' });
    const off = await runScenario({ mode: 'DEFAULT', engine: 'none', tokenSafety: false });
    expect(off.record.decisions).toEqual(on.record.decisions);
    expect(off.record.signals).toEqual(on.record.signals);
    const unsafe = await runScenario({ mode: 'DEFAULT', engine: 'none', tokenSafety: false, mint: FREEZE_ACTIVE });
    expect(unsafe.record.signals).toHaveLength(0);
  }, 60_000);
});
