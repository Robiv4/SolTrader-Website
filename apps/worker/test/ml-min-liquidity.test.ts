/* eslint-disable @typescript-eslint/no-explicit-any -- in-memory prisma fakes */
/**
 * ML PAPER minimum liquidity: a separate, per-user value that replaces the DEFAULT New Launch minimum for ML entries
 * (also as the risk engine's liquidity reference). Not set = the DEFAULT minimum stays in force. Fraud / honeypot
 * protection, price impact and every execution limit are unchanged. The scenario token has ~6 000 USD liquidity.
 */
import { describe, expect, it } from 'vitest';

import { toMlPaperConfig } from '../src/ml/ml-paper-engine.js';

import { runScenario } from './helpers/ml-scenario.js';

const HIGH_DEFAULT = { minLiquidityUsd: 50_000_000 };

describe('ML PAPER minimum liquidity replaces the DEFAULT minimum for ML entries', () => {
  it('1. DEFAULT minimum far above the token, ML minimum 3 000 -> ML PAPER entry; minimum, liquidity and sellability recorded', async () => {
    const run = await runScenario({ mode: 'ML', probability: 0.95, config: HIGH_DEFAULT, mlMinLiquidity: 3_000 });
    const decision = run.paperDecisions[0];
    expect(decision).toMatchObject({ mlDecision: 'ML_BUY', outcome: 'SIGNALED', sellability: 'VERIFIED' });
    expect(Number(decision.minLiquidityUsd)).toBe(3_000);
    expect(Number(decision.liquidityUsd)).toBeGreaterThan(3_000);
    expect(Number(decision.liquidityUsd)).toBeLessThan(50_000_000);
    expect(run.record.signals).toHaveLength(1);
    expect(run.record.signalMetadata[0].ml).toMatchObject({ minLiquidityUsd: 3_000 });
  }, 30_000);

  it('2. the same token with the DEFAULT strategy -> the DEFAULT minimum applies (no entry)', async () => {
    const run = await runScenario({ mode: 'DEFAULT', engine: 'none', config: HIGH_DEFAULT, mlMinLiquidity: 3_000 });
    expect(run.record.signals).toHaveLength(0);
    expect(run.record.decisions.some((row: any) => (row.reasons ?? []).includes('LIQUIDITY_BELOW_MINIMUM'))).toBe(true);
  }, 30_000);

  it('3. ML minimum above the token liquidity -> no entry (the ML minimum applies, even with a low DEFAULT minimum)', async () => {
    const run = await runScenario({ mode: 'ML', probability: 0.95, config: { minLiquidityUsd: 1_000 }, mlMinLiquidity: 900_000 });
    expect(run.paperDecisions[0]).toMatchObject({ mlDecision: 'ML_BUY', outcome: 'EXPIRED' });
    expect(run.paperDecisions[0].safetyBlockers).toContain('LIQUIDITY_BELOW_MINIMUM');
    expect(Number(run.paperDecisions[0].minLiquidityUsd)).toBe(900_000);
    expect(run.record.signals).toHaveLength(0);
  }, 30_000);

  it('no ML value saved -> the DEFAULT minimum stays in force for ML entries (no looser limit without a save)', async () => {
    const run = await runScenario({ mode: 'ML', probability: 0.95, config: HIGH_DEFAULT });
    expect(run.paperDecisions[0].safetyBlockers).toContain('LIQUIDITY_BELOW_MINIMUM');
    // The DEFAULT minimum applies exactly as configured (never capped: not looser than before).
    expect(Number(run.paperDecisions[0].minLiquidityUsd)).toBe(50_000_000);
    expect(run.record.signals).toHaveLength(0);
  }, 30_000);

  it('the risk engine uses the ML minimum as liquidity reference (the bot-level minimum cannot veto through the risk score)', async () => {
    const run = await runScenario({ mode: 'ML', probability: 0.95, botMinLiquidity: 50_000_000, mlMinLiquidity: 3_000 });
    expect(run.record.signals).toHaveLength(1);
    expect(run.record.signalMetadata[0].riskWarnings).not.toContain('LOW_LIQUIDITY');
  }, 30_000);
});

describe('A lower minimum relaxes nothing else', () => {
  it('6. price impact above the maximum -> no entry', async () => {
    const run = await runScenario({ mode: 'ML', probability: 0.95, config: { ...HIGH_DEFAULT, maxPriceImpactPercent: 0.01 }, mlMinLiquidity: 3_000 });
    expect(run.paperDecisions[0].safetyBlockers).toContain('PRICE_IMPACT_TOO_HIGH');
    expect(run.record.signals).toHaveLength(0);
  }, 30_000);

  it('4. honeypot mechanism (freeze authority active) -> no entry', async () => {
    const run = await runScenario({ mode: 'ML', probability: 0.95, config: HIGH_DEFAULT, mlMinLiquidity: 3_000, mint: { mintAuthority: null, freezeAuthority: 'Freeze111', tokenProgram: 'spl-token', extensions: [] } });
    expect(run.paperDecisions[0]).toMatchObject({ outcome: 'SAFETY_BLOCKED' });
    expect(run.record.signals).toHaveLength(0);
  }, 30_000);

  it('7. ML SKIP with enough liquidity -> no entry', async () => {
    const run = await runScenario({ mode: 'ML', probability: 0.2, mlMinLiquidity: 3_000 });
    expect(run.paperDecisions[0]).toMatchObject({ mlDecision: 'ML_SKIP' });
    expect(run.record.signals).toHaveLength(0);
  }, 30_000);

  it('8. revoked model -> no entry', async () => {
    const run = await runScenario({ mode: 'ML', approved: false, mlMinLiquidity: 3_000 });
    expect(run.paperDecisions[0]).toMatchObject({ mlDecision: 'ML_ERROR' });
    expect(run.record.signals).toHaveLength(0);
  }, 30_000);

  it('12. the saved value is read from the settings row (survives restarts); missing = not set', () => {
    expect(toMlPaperConfig({ strategyMode: 'ML', modelVersion: 'M1', buyThreshold: 0.7, decisionWindowSeconds: 10, minLiquidityUsd: '3000.00' }).minLiquidityUsd).toBe(3_000);
    expect(toMlPaperConfig({ strategyMode: 'ML', modelVersion: 'M1', buyThreshold: 0.7, decisionWindowSeconds: 10, minLiquidityUsd: null }).minLiquidityUsd).toBeNull();
    expect(toMlPaperConfig({ strategyMode: 'ML', modelVersion: 'M1', buyThreshold: 0.7, decisionWindowSeconds: 10 }).minLiquidityUsd).toBeNull();
  });
});
