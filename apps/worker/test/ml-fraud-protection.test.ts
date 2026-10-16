/* eslint-disable @typescript-eslint/no-explicit-any -- in-memory prisma fakes */
/**
 * ML-only PAPER entries with mandatory fraud / honeypot protection: the DEFAULT strategy never vetoes an ML BUY, while the
 * token-security decision (sellability, honeypot evidence, authorities, Token-2022 restrictions, rug-pull signals) always
 * does. There is no setting that switches the fraud protection off.
 */
import { describe, expect, it } from 'vitest';

import { runScenario } from './helpers/ml-scenario.js';

const SAFE_MINT = { mintAuthority: null, freezeAuthority: null, tokenProgram: 'spl-token', extensions: [] };

describe('The DEFAULT strategy is not a second decision maker', () => {
  it('ML BUY + DEFAULT REJECT (launch window over) + safe token -> PAPER BUY signal', async () => {
    const run = await runScenario({ mode: 'ML', probability: 0.95, config: { maxAgeSeconds: 10 }, mint: SAFE_MINT });
    expect(run.paperDecisions[0]).toMatchObject({ mlDecision: 'ML_BUY', baseDecision: 'REJECT', outcome: 'SIGNALED' });
    expect(run.record.signals).toEqual([expect.objectContaining({ entryStrategy: 'ML' })]);
  }, 30_000);

  it('ML BUY + DEFAULT WATCH (Launch Score below the DEFAULT minimum) + safe token -> PAPER BUY signal', async () => {
    const run = await runScenario({ mode: 'ML', probability: 0.95, config: { minScore: 100 }, mint: SAFE_MINT });
    expect(run.paperDecisions[0]).toMatchObject({ mlDecision: 'ML_BUY', baseDecision: 'WATCH', outcome: 'SIGNALED' });
    expect(run.paperDecisions[0].baseReasons).toContain('LAUNCH_SCORE_BELOW_MINIMUM');
    expect(run.record.signals).toHaveLength(1);
  }, 30_000);

  it('ML SKIP + DEFAULT BUY -> no PAPER BUY', async () => {
    const run = await runScenario({ mode: 'ML', probability: 0.2 });
    expect(run.record.decisions.some((row: any) => row.decision === 'BUY')).toBe(true);
    expect(run.paperDecisions[0]).toMatchObject({ mlDecision: 'ML_SKIP' });
    expect(run.record.signals).toHaveLength(0);
  }, 30_000);
});

describe('Fraud / honeypot protection is mandatory for an ML BUY', () => {
  const blocked = async (mint: typeof SAFE_MINT, code: string) => {
    const run = await runScenario({ mode: 'ML', probability: 0.95, mint });
    expect(run.paperDecisions[0]).toMatchObject({ mlDecision: 'ML_BUY', outcome: 'SAFETY_BLOCKED' });
    expect(run.paperDecisions[0].safetyBlockers).toContain(code);
    expect(run.record.signals).toHaveLength(0);
  };

  it('critical Token-2022 extension (transfer hook) -> no PAPER BUY', async () => {
    await blocked({ ...SAFE_MINT, tokenProgram: 'spl-token-2022', extensions: ['transferHook'] }, 'CRITICAL_TOKEN_EXTENSION');
  }, 30_000);

  it('transfer fee (Token-2022 transfer restriction) -> no PAPER BUY', async () => {
    await blocked({ ...SAFE_MINT, tokenProgram: 'spl-token-2022', extensions: ['transferFeeConfig'] }, 'UNSUPPORTED_TRANSFER_RESTRICTION');
  }, 30_000);

  it('freeze authority active (holder accounts can be frozen) -> no PAPER BUY', async () => {
    await blocked({ ...SAFE_MINT, freezeAuthority: 'Freeze111' }, 'FREEZE_AUTHORITY_ACTIVE');
  }, 30_000);

  it('mint authority active -> the ML BUY waits and expires unexecuted (never bought)', async () => {
    const run = await runScenario({ mode: 'ML', probability: 0.95, mint: { ...SAFE_MINT, mintAuthority: 'Mint1111' } });
    expect(run.paperDecisions[0]).toMatchObject({ mlDecision: 'ML_BUY', outcome: 'EXPIRED' });
    expect(run.paperDecisions[0].safetyBlockers).toContain('MINT_AUTHORITY_ACTIVE');
    expect(run.record.signals).toHaveLength(0);
  }, 30_000);
});
