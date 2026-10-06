/**
 * NewLaunchQualityGate: an optional, configurable entry filter that runs AFTER hard security/risk
 * eligibility and the NewLaunch BUY decision, and BEFORE position limits / paper execution.
 *
 *  - OFF:            not evaluated.
 *  - MONITOR_ONLY:   evaluated and recorded (wouldPass + reasons) but never blocks a PAPER entry.
 *  - ENFORCE_PAPER:  a failing candidate gets NO PAPER BUY.
 *
 * The gate can only remove entries; it can never turn a hard security rejection into a BUY
 * (it is only evaluated for candidates the NewLaunch strategy already decided to BUY).
 * A threshold whose input is unknown fails (unknown is never treated as passing).
 */
export type QualityGateMode = 'OFF' | 'MONITOR_ONLY' | 'ENFORCE_PAPER';

export interface QualityGateSettings {
  mode: QualityGateMode;
  /** Bumped whenever the thresholds change, so evaluations stay attributable. */
  version: number;
  minLaunchScore: number | null;
  minUniqueBuyers: number | null;
  minLiquidityUsd: number | null;
  minBuySellRatio: number | null;
  maxExhaustionScore: number | null;
  maxPriceImpactPercent: number | null;
  maxHolderConcentrationPercent: number | null;
  maxDevAllocationPercent: number | null;
  minDataQuality: number | null;
}

/** Experimental PAPER defaults (not claimed optimal); migration default mode is MONITOR_ONLY. */
export const DEFAULT_QUALITY_GATE: QualityGateSettings = {
  mode: 'MONITOR_ONLY',
  version: 1,
  minLaunchScore: 80,
  minUniqueBuyers: 20,
  minLiquidityUsd: 20_000,
  minBuySellRatio: 1.5,
  maxExhaustionScore: 40,
  maxPriceImpactPercent: 1.5,
  maxHolderConcentrationPercent: 20,
  maxDevAllocationPercent: 10,
  minDataQuality: 70,
};

export interface QualityGateInput {
  launchScore: number | null;
  uniqueBuyers: number | null;
  liquidityUsd: number | null;
  buySellRatio: number | null;
  exhaustionScore: number | null;
  priceImpactPercent: number | null;
  holderConcentrationPercent: number | null;
  devAllocationPercent: number | null;
  dataQuality: number | null;
}

export interface QualityGateResult {
  mode: QualityGateMode;
  version: number;
  evaluated: boolean;
  wouldPass: boolean | null;
  /** Failed conditions (e.g. LAUNCH_SCORE_BELOW_GATE, UNIQUE_BUYERS_UNKNOWN). */
  reasons: string[];
  /** True only in ENFORCE_PAPER mode when the gate fails: no PAPER BUY. */
  blocksEntry: boolean;
}

const MODES: QualityGateMode[] = ['OFF', 'MONITOR_ONLY', 'ENFORCE_PAPER'];

function finite(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Stored JSON (or null) merged over the defaults; unknown keys are ignored. */
export function normalizeQualityGate(raw: unknown): QualityGateSettings {
  const source = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const gate = { ...DEFAULT_QUALITY_GATE };
  if (MODES.includes(source.mode as QualityGateMode)) gate.mode = source.mode as QualityGateMode;
  const version = finite(source.version);
  if (version !== null && version >= 1) gate.version = Math.floor(version);
  for (const key of Object.keys(DEFAULT_QUALITY_GATE) as Array<keyof QualityGateSettings>) {
    if (key === 'mode' || key === 'version' || !(key in source)) continue;
    (gate as unknown as Record<string, number | null>)[key] = source[key] === null ? null : finite(source[key]);
  }
  return gate;
}

type Rule = { key: keyof QualityGateInput; limit: keyof QualityGateSettings; kind: 'min' | 'max'; code: string };
const RULES: Rule[] = [
  { key: 'launchScore', limit: 'minLaunchScore', kind: 'min', code: 'LAUNCH_SCORE' },
  { key: 'uniqueBuyers', limit: 'minUniqueBuyers', kind: 'min', code: 'UNIQUE_BUYERS' },
  { key: 'liquidityUsd', limit: 'minLiquidityUsd', kind: 'min', code: 'LIQUIDITY' },
  { key: 'buySellRatio', limit: 'minBuySellRatio', kind: 'min', code: 'BUY_SELL_RATIO' },
  { key: 'exhaustionScore', limit: 'maxExhaustionScore', kind: 'max', code: 'EXHAUSTION' },
  { key: 'priceImpactPercent', limit: 'maxPriceImpactPercent', kind: 'max', code: 'PRICE_IMPACT' },
  { key: 'holderConcentrationPercent', limit: 'maxHolderConcentrationPercent', kind: 'max', code: 'HOLDER_CONCENTRATION' },
  { key: 'devAllocationPercent', limit: 'maxDevAllocationPercent', kind: 'max', code: 'DEV_ALLOCATION' },
  { key: 'dataQuality', limit: 'minDataQuality', kind: 'min', code: 'DATA_QUALITY' },
];

export function evaluateQualityGate(input: QualityGateInput, gate: QualityGateSettings): QualityGateResult {
  if (gate.mode === 'OFF') return { mode: gate.mode, version: gate.version, evaluated: false, wouldPass: null, reasons: [], blocksEntry: false };
  const reasons: string[] = [];
  for (const rule of RULES) {
    const limit = gate[rule.limit] as number | null;
    if (limit === null) continue;
    const value = input[rule.key];
    if (value === null || !Number.isFinite(value)) {
      reasons.push(`${rule.code}_UNKNOWN`);
      continue;
    }
    if (rule.kind === 'min' && value < limit) reasons.push(`${rule.code}_BELOW_GATE`);
    if (rule.kind === 'max' && value > limit) reasons.push(`${rule.code}_ABOVE_GATE`);
  }
  const wouldPass = reasons.length === 0;
  return { mode: gate.mode, version: gate.version, evaluated: true, wouldPass, reasons, blocksEntry: gate.mode === 'ENFORCE_PAPER' && !wouldPass };
}
