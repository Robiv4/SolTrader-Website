/**
 * Autonomous ML model bundle (soltrader-autonomous-bundle-v1): ONE versioned, immutable package the user selects.
 *
 * Components (learned, LightGBM / logistic, exported trees, no Python at runtime):
 *   entryReturn   (regression) - expected net return of an entry now over the entry horizon (fees + impact included);
 *   entryDownside (regression) - expected worst net result inside the horizon (downside risk);
 *   entryProfit   (binary)     - calibrated probability that the entry is net positive;
 *   exitAdvantage (regression) - expected net advantage of holding (H_hold) over selling now;
 *   exitHold      (binary)     - calibrated probability that holding beats selling now.
 * Policy (selected on validation data by the trainer, stored in the bundle - not DEFAULT thresholds) turns the outputs
 * into BUY / WAIT / SKIP and HOLD / PARTIAL_SELL / SELL. Sizing (v1: a deterministic policy over the model outputs and
 * the execution impact, not a separately learned model) proposes the order size; the safety layer may only reduce it.
 *
 * Any missing component, unknown feature, non-finite output or validation failure is an ERROR: no BUY; exits of open
 * positions then fall back to the mandatory protection layer only (never to DEFAULT exit rules).
 */
import { impactPercent } from '../ml/exit-simulation.js';
import type { MlFeatures } from '../ml/features.js';
import { type MlModelArtifact, probabilityOf, rawScoreOf, validateArtifact } from '../ml/model.js';

import { ML_AUTONOMOUS_FEATURE_SCHEMA, ML_AUTONOMOUS_FEATURE_VERSION } from './features.js';

export const AUTONOMOUS_BUNDLE_FORMAT = 'soltrader-autonomous-bundle-v1';
export const AUTONOMOUS_COMPONENTS = ['entryReturn', 'entryDownside', 'entryProfit', 'exitAdvantage', 'exitHold'] as const;
export type AutonomousComponentName = (typeof AUTONOMOUS_COMPONENTS)[number];
const OBJECTIVES: Record<AutonomousComponentName, 'binary' | 'regression'> = { entryReturn: 'regression', entryDownside: 'regression', entryProfit: 'binary', exitAdvantage: 'regression', exitHold: 'binary' };

export interface AutonomousPolicy {
  entry: { minProbability: number; minExpectedNetPct: number; minDownsideNetPct: number; waitMinProbability: number };
  exit: { sellBelowAdvantagePct: number; partialBelowAdvantagePct: number; minHoldProbability: number; partialSellFraction: number };
}

export interface AutonomousSizing {
  method: 'EDGE_OVER_DOWNSIDE';
  /** % of account equity at full conviction / the cap. */
  baseFractionPct: number;
  maxFractionPct: number;
  minOrderUsd: number;
  /** The proposed size never needs more than this impact (%). */
  maxImpactPct: number;
}

export interface AutonomousBundle {
  format: string;
  bundleVersion: string;
  featureVersion: string;
  labelVersion: string;
  datasetVersion: string;
  createdAt: string;
  components: Record<AutonomousComponentName, MlModelArtifact>;
  policy: AutonomousPolicy;
  sizing: AutonomousSizing;
}

export function validateBundle(value: unknown): AutonomousBundle {
  const bundle = value as AutonomousBundle;
  if (!bundle || bundle.format !== AUTONOMOUS_BUNDLE_FORMAT) throw new Error('Unknown autonomous bundle format');
  if (bundle.featureVersion !== ML_AUTONOMOUS_FEATURE_VERSION) throw new Error(`Unsupported feature version ${bundle.featureVersion}`);
  for (const name of AUTONOMOUS_COMPONENTS) {
    const component = bundle.components?.[name];
    if (!component) throw new Error(`Bundle component ${name} missing`);
    validateArtifact(component, ML_AUTONOMOUS_FEATURE_SCHEMA);
    if (component.featureVersion !== ML_AUTONOMOUS_FEATURE_VERSION) throw new Error(`Component ${name} has feature version ${component.featureVersion}`);
    if ((component.objective ?? 'binary') !== OBJECTIVES[name]) throw new Error(`Component ${name} must be ${OBJECTIVES[name]}`);
  }
  const numbers = [...Object.values(bundle.policy?.entry ?? {}), ...Object.values(bundle.policy?.exit ?? {}), bundle.sizing?.baseFractionPct, bundle.sizing?.maxFractionPct, bundle.sizing?.minOrderUsd, bundle.sizing?.maxImpactPct];
  if (numbers.length < 12 || numbers.some((item) => typeof item !== 'number' || !Number.isFinite(item))) throw new Error('Bundle policy / sizing invalid');
  if (bundle.sizing.maxFractionPct > 25 || bundle.sizing.maxImpactPct > 20) throw new Error('Bundle sizing outside the allowed range');
  return bundle;
}

const finite = (value: number) => (Number.isFinite(value) ? value : null);

export interface EntryOutputs { expectedNetPct: number; downsideNetPct: number; probability: number }
export interface ExitOutputs { holdAdvantagePct: number; holdProbability: number }

export type EntryAction = 'BUY' | 'WAIT' | 'SKIP';
export type ExitAction = 'HOLD' | 'PARTIAL_SELL' | 'SELL';

export interface EntryDecision {
  action: EntryAction | 'ERROR';
  outputs: EntryOutputs | null;
  suggestedSizeUsd: number | null;
  reasons: string[];
}

export interface ExitDecision {
  action: ExitAction | 'ERROR';
  outputs: ExitOutputs | null;
  sellFraction: number;
  reasons: string[];
}

export function entryOutputs(bundle: AutonomousBundle, features: MlFeatures): EntryOutputs | null {
  const expected = finite(rawScoreOf(bundle.components.entryReturn, features));
  const downside = finite(rawScoreOf(bundle.components.entryDownside, features));
  const probability = finite(probabilityOf(bundle.components.entryProfit, rawScoreOf(bundle.components.entryProfit, features)));
  return expected === null || downside === null || probability === null ? null : { expectedNetPct: expected, downsideNetPct: Math.min(downside, expected), probability };
}

export function exitOutputs(bundle: AutonomousBundle, features: MlFeatures): ExitOutputs | null {
  const advantage = finite(rawScoreOf(bundle.components.exitAdvantage, features));
  const probability = finite(probabilityOf(bundle.components.exitHold, rawScoreOf(bundle.components.exitHold, features)));
  return advantage === null || probability === null ? null : { holdAdvantagePct: advantage, holdProbability: probability };
}

/** Largest order (USD) whose impact at `liquidityUsd` stays at or below `maxImpactPct` (PAPER impact model). */
export function maxNotionalForImpact(liquidityUsd: number | null, maxImpactPct: number) {
  if (!(liquidityUsd !== null && liquidityUsd > 0) || maxImpactPct <= impactPercent(0.000001, liquidityUsd)) return 0;
  const share = (maxImpactPct - 0.1) / 100;
  return share >= 1 ? Number.POSITIVE_INFINITY : (share * liquidityUsd / 2) / (1 - share);
}

/** Proposed order size from the outputs (never above the impact limit or the bundle cap; the safety layer may cut more). */
export function proposeSize(sizing: AutonomousSizing, outputs: EntryOutputs, minProbability: number, equityUsd: number, liquidityUsd: number | null) {
  const edge = Math.max(0, Math.min(1, outputs.expectedNetPct / Math.max(1, Math.abs(outputs.downsideNetPct))));
  const confidence = Math.max(0.5, Math.min(1, 0.5 + (outputs.probability - minProbability) / Math.max(0.01, 1 - minProbability)));
  const fraction = Math.min(sizing.maxFractionPct, sizing.baseFractionPct * edge * confidence * 2);
  const size = Math.min(equityUsd * fraction / 100, maxNotionalForImpact(liquidityUsd, sizing.maxImpactPct));
  return size >= sizing.minOrderUsd ? Math.floor(size * 100) / 100 : 0;
}

export function decideEntry(bundle: AutonomousBundle, features: MlFeatures, context: { equityUsd: number; liquidityUsd: number | null }): EntryDecision {
  let outputs: EntryOutputs | null;
  try {
    outputs = entryOutputs(bundle, features);
  } catch (error) {
    return { action: 'ERROR', outputs: null, suggestedSizeUsd: null, reasons: [`INFERENCE_FAILED:${error instanceof Error ? error.message.slice(0, 80) : 'unknown'}`] };
  }
  if (!outputs) return { action: 'ERROR', outputs: null, suggestedSizeUsd: null, reasons: ['NON_FINITE_OUTPUT'] };
  const policy = bundle.policy.entry;
  const reasons: string[] = [];
  if (outputs.probability < policy.minProbability) reasons.push('PROBABILITY_BELOW_POLICY');
  if (outputs.expectedNetPct < policy.minExpectedNetPct) reasons.push('EXPECTED_NET_BELOW_POLICY');
  if (outputs.downsideNetPct < policy.minDownsideNetPct) reasons.push('DOWNSIDE_TOO_LARGE');
  if (!reasons.length) {
    const size = proposeSize(bundle.sizing, outputs, policy.minProbability, context.equityUsd, context.liquidityUsd);
    if (size > 0) return { action: 'BUY', outputs, suggestedSizeUsd: size, reasons: [] };
    reasons.push('SIZE_BELOW_MINIMUM');
  }
  const wait = outputs.probability >= policy.waitMinProbability && outputs.expectedNetPct > 0;
  return { action: wait ? 'WAIT' : 'SKIP', outputs, suggestedSizeUsd: null, reasons };
}

export function decideExit(bundle: AutonomousBundle, features: MlFeatures, state: { partiallySold: boolean }): ExitDecision {
  let outputs: ExitOutputs | null;
  try {
    outputs = exitOutputs(bundle, features);
  } catch (error) {
    return { action: 'ERROR', outputs: null, sellFraction: 0, reasons: [`INFERENCE_FAILED:${error instanceof Error ? error.message.slice(0, 80) : 'unknown'}`] };
  }
  if (!outputs) return { action: 'ERROR', outputs: null, sellFraction: 0, reasons: ['NON_FINITE_OUTPUT'] };
  const policy = bundle.policy.exit;
  if (outputs.holdAdvantagePct <= policy.sellBelowAdvantagePct || outputs.holdProbability < policy.minHoldProbability) return { action: 'SELL', outputs, sellFraction: 1, reasons: ['HOLD_VALUE_BELOW_POLICY'] };
  if (outputs.holdAdvantagePct <= policy.partialBelowAdvantagePct && !state.partiallySold) return { action: 'PARTIAL_SELL', outputs, sellFraction: policy.partialSellFraction, reasons: ['HOLD_VALUE_UNCERTAIN'] };
  return { action: 'HOLD', outputs, sellFraction: 0, reasons: [] };
}
