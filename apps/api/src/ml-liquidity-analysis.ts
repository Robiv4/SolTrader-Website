/**
 * Historical, analysis-only comparison of ML PAPER minimum-liquidity levels (10k / 5k / 3k / 1k USD) over past ML BUY
 * decisions. Nothing here is a trade result: the counts say how many ML BUYs WOULD have met a minimum, how many other
 * recorded mandatory checks would still have blocked, and how many could have been eligible for execution.
 *
 * Time-correct (no look-ahead):
 *  - liquidity = the value recorded with the decision, else the newest launch snapshot taken at or before the decision;
 *  - other blockers = the mandatory blockers recorded for that decision (fraud / honeypot, market, risk);
 *  - later price movement = the SHADOW outcome measured forward from the model's snapshot point (label
 *    "+20% before -10% within 30 min" and the 30-minute return); it is only shown for the analysis, never used to
 *    decide eligibility, and it is not a PAPER trade result (no fees, slippage, sizing or Exit Engine).
 */
import { ML_MIN_LIQUIDITY_FLOOR_USD } from '@soltrader/strategy-engine';

export const LIQUIDITY_COMPARISON_LEVELS = [10_000, 5_000, 3_000, 1_000] as const;

export interface LiquidityAnalysisRow {
  liquidityUsd: number | null;
  /** Where the liquidity came from: recorded with the decision, or the last launch snapshot before it. */
  liquiditySource: 'DECISION' | 'SNAPSHOT' | null;
  blockers: string[];
  outcome: string;
  /** SHADOW label plus20BeforeMinus10 (null = not labelled / incomplete). */
  label: boolean | null;
  /** SHADOW 30-minute return (%) from the snapshot point. */
  return30mPct: number | null;
}

const median = (values: number[]) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

export function summarizeLiquidityLevels(rows: LiquidityAnalysisRow[], levels: readonly number[] = LIQUIDITY_COMPARISON_LEVELS) {
  const known = rows.filter((row) => row.liquidityUsd !== null);
  const result = levels.map((minimumUsd) => {
    const meets = known.filter((row) => row.liquidityUsd! >= minimumUsd);
    // The liquidity-minimum blocker of the time is replaced by this level; every other recorded blocker still counts.
    const otherBlocked = meets.filter((row) => row.blockers.some((code) => code !== 'LIQUIDITY_BELOW_MINIMUM'));
    const eligible = meets.filter((row) => !row.blockers.some((code) => code !== 'LIQUIDITY_BELOW_MINIMUM') && row.outcome !== 'ERROR' && row.liquidityUsd! >= ML_MIN_LIQUIDITY_FLOOR_USD);
    const labelled = eligible.filter((row) => row.label !== null);
    const returns = eligible.map((row) => row.return30mPct).filter((value): value is number => value !== null && Number.isFinite(value));
    return {
      minimumUsd,
      meetsMinimum: meets.length,
      blockedByOtherChecks: otherBlocked.length,
      potentiallyExecutable: eligible.length,
      belowExecutionFloor: meets.filter((row) => row.liquidityUsd! < ML_MIN_LIQUIDITY_FLOOR_USD).length,
      laterPriceMovement: {
        labelled: labelled.length,
        hitPlus20BeforeMinus10: labelled.filter((row) => row.label).length,
        hitRate: labelled.length ? labelled.filter((row) => row.label).length / labelled.length : null,
        median30mReturnPct: median(returns),
      },
    };
  });
  return {
    label: 'ANALYSIS ONLY - eligibility counts, not executed trades',
    mlBuyDecisions: rows.length,
    unknownLiquidity: rows.length - known.length,
    liquidityFromSnapshot: rows.filter((row) => row.liquiditySource === 'SNAPSHOT').length,
    actuallyExecuted: rows.filter((row) => row.outcome === 'EXECUTED').length,
    levels: result,
    missingData: [
      ...(rows.length - known.length ? [`${rows.length - known.length} ML BUY döntésnél nincs likviditási adat a döntés idejéből.`] : []),
      'A korábbi (lejárt) döntéseknél csak az utolsó ellenőrzés tiltási okai ismertek.',
      'Az árhatás a döntéskori tervezett pozícióméretre készült; más méretre vagy alacsonyabb likviditásra nincs eltárolt bonding-curve / pool állapot.',
      'El nem indított jelzéseknél nincs eltárolt végrehajtási ár és exit-capacity eredmény, a számlalimitek (napi veszteség, kitettség) akkori állapota sem.',
      'A későbbi ármozgás SHADOW-kimenet a snapshot-ponttól: díjak, slippage, pozícióméret és az Exit Engine nélkül – nem PAPER-eredmény.',
    ],
  };
}

type RawRow = { liquidity: unknown; snapshotLiquidity: unknown; safetyBlockers: unknown; outcome: string; label: string | null; ret30: number | null };

/**
 * Loads the ML BUY decisions of a user since `since` with the time-correct liquidity and the SHADOW outcome. Timestamps are
 * stored as UTC without time zone: the bound is passed as a UTC timestamp (never shifted by the session time zone).
 */
export async function loadLiquidityAnalysisRows(prisma: { $queryRaw: <T>(query: TemplateStringsArray, ...values: unknown[]) => Promise<T> }, userId: string, since: Date): Promise<LiquidityAnalysisRow[]> {
  const raw = await prisma.$queryRaw<RawRow[]>`
    SELECT d."liquidityUsd" AS liquidity,
      (SELECT s."liquidityUsd" FROM "LaunchSnapshot" s WHERE s."candidateId" = d."candidateId" AND s."takenAt" <= d."decidedAt" ORDER BY s."takenAt" DESC LIMIT 1) AS "snapshotLiquidity",
      d."safetyBlockers", d.outcome,
      o.result->'pathLabels'->>'plus20BeforeMinus10' AS label,
      (o.result->'horizons'->'1800'->>'returnPct')::float AS ret30
    FROM "MlPaperDecision" d
    LEFT JOIN "MlFeatureSnapshot" f ON f."candidateId" = d."candidateId" AND f.kind = d."snapshotKind" AND f."featureVersion" = d."featureVersion"
    LEFT JOIN "MlCandidateOutcome" o ON o."snapshotId" = f.id
    WHERE d."userId" = ${userId} AND d."mlDecision" = 'ML_BUY' AND d."decidedAt" >= ${since.toISOString()}::timestamp`;
  return raw.map((row) => {
    const recorded = row.liquidity === null || row.liquidity === undefined ? null : Number(row.liquidity);
    const snapshot = row.snapshotLiquidity === null || row.snapshotLiquidity === undefined ? null : Number(row.snapshotLiquidity);
    const liquidityUsd = recorded !== null && Number.isFinite(recorded) ? recorded : snapshot !== null && Number.isFinite(snapshot) ? snapshot : null;
    return {
      liquidityUsd,
      liquiditySource: recorded !== null && Number.isFinite(recorded) ? 'DECISION' : liquidityUsd !== null ? 'SNAPSHOT' : null,
      blockers: Array.isArray(row.safetyBlockers) ? row.safetyBlockers.map(String) : [],
      outcome: row.outcome,
      label: row.label === 'true' ? true : row.label === 'false' ? false : null,
      return30mPct: row.ret30 === null || row.ret30 === undefined ? null : Number(row.ret30),
    };
  });
}
