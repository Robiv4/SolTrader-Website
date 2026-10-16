import { describe, expect, it } from 'vitest';

import { type LiquidityAnalysisRow, summarizeLiquidityLevels } from '../src/ml-liquidity-analysis.js';

const row = (liquidityUsd: number | null, blockers: string[] = [], outcome = 'EXPIRED', label: boolean | null = null, return30mPct: number | null = null): LiquidityAnalysisRow => ({
  liquidityUsd, liquiditySource: liquidityUsd === null ? null : 'DECISION', blockers, outcome, label, return30mPct,
});

describe('ML PAPER minimum-liquidity comparison (analysis only)', () => {
  const rows = [
    row(12_000, [], 'EXECUTED', true, 25),
    row(6_000, ['LIQUIDITY_BELOW_MINIMUM'], 'EXPIRED', false, -12),
    row(4_000, ['LIQUIDITY_BELOW_MINIMUM', 'CREATOR_SELLING'], 'SAFETY_BLOCKED', true, 30),
    row(3_500, ['LIQUIDITY_BELOW_MINIMUM', 'PRICE_IMPACT_TOO_HIGH'], 'EXPIRED'),
    row(1_100, ['LIQUIDITY_BELOW_MINIMUM'], 'EXPIRED'),
    row(null, ['LIQUIDITY_BELOW_MINIMUM'], 'EXPIRED'),
  ];
  const result = summarizeLiquidityLevels(rows);
  const level = (minimum: number) => result.levels.find((item) => item.minimumUsd === minimum)!;

  it('counts who meets each minimum, who other recorded checks would still block, and who could have been executable', () => {
    expect(level(10_000)).toMatchObject({ meetsMinimum: 1, blockedByOtherChecks: 0, potentiallyExecutable: 1 });
    expect(level(5_000)).toMatchObject({ meetsMinimum: 2, blockedByOtherChecks: 0, potentiallyExecutable: 2 });
    expect(level(3_000)).toMatchObject({ meetsMinimum: 4, blockedByOtherChecks: 2, potentiallyExecutable: 2 });
    // 1 100 USD meets a 1 000 minimum but is below the 1 250 USD execution floor: not executable.
    expect(level(1_000)).toMatchObject({ meetsMinimum: 5, potentiallyExecutable: 2, belowExecutionFloor: 1 });
  });

  it('is labelled as analysis (not trades), keeps unknown liquidity apart and lists the missing data', () => {
    expect(result.label).toMatch(/ANALYSIS ONLY/);
    expect(result).toMatchObject({ mlBuyDecisions: 6, unknownLiquidity: 1, actuallyExecuted: 1 });
    expect(result.missingData.length).toBeGreaterThan(2);
  });

  it('later price movement only for the eligible ML BUYs (SHADOW outcome, never used for eligibility)', () => {
    expect(level(5_000).laterPriceMovement).toMatchObject({ labelled: 2, hitPlus20BeforeMinus10: 1, hitRate: 0.5, median30mReturnPct: 6.5 });
    expect(level(10_000).laterPriceMovement).toMatchObject({ labelled: 1, hitRate: 1 });
  });
});
