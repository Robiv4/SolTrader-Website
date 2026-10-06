/**
 * Local model inference for exported, versioned JSON artifacts (no Python at runtime, no pickle, no external API).
 * Supported: logistic regression (with imputation + standardisation) and LightGBM binary trees (dump_model JSON),
 * optionally Platt-calibrated on validation data. The column specs come from the trainer, which builds them from
 * the same ML_FEATURE_SCHEMA: identical preprocessing in training and serving (verified by a parity test).
 */
import { ML_FEATURE_SCHEMA, type MlFeatures } from './features.js';

export const ML_ARTIFACT_FORMAT = 'soltrader-ml-model-v1';

export interface MlColumnSpec {
  name: string;
  feature: string;
  kind: 'value' | 'missing' | 'onehot';
  transform?: 'log1p' | 'signed_log1p' | null;
  category?: string;
  /** Logistic regression only: imputation value and standardisation (applied after the transform). */
  impute?: number;
  mean?: number;
  std?: number;
}

interface LgbNode {
  split_feature?: number;
  threshold?: number;
  decision_type?: string;
  default_left?: boolean;
  missing_type?: 'None' | 'Zero' | 'NaN';
  left_child?: LgbNode;
  right_child?: LgbNode;
  leaf_value?: number;
}

export interface MlModelArtifact {
  format: string;
  modelVersion: string;
  algorithm: 'logistic_regression' | 'lightgbm';
  featureVersion: string;
  labelVersion: string;
  target: string;
  columns: MlColumnSpec[];
  logistic?: { coef: number[]; intercept: number };
  lightgbm?: { trees: Array<{ tree_structure: LgbNode }> };
  /** Platt scaling fitted on validation data: p = sigmoid(a * rawScore + b). */
  calibration?: { method: 'platt'; a: number; b: number } | null;
  decisionThreshold: number;
}

export interface MlPrediction {
  modelVersion: string;
  rawScore: number;
  probability: number;
  calibrated: boolean;
  mlEntryScore: number;
  predictedClass: 'ML_BUY' | 'ML_SKIP';
  /** Logistic regression only: top feature contributions (coef x standardised value). */
  contributions: Array<{ feature: string; value: number }> | null;
}

const sigmoid = (value: number) => 1 / (1 + Math.exp(-value));

export function applyTransform(value: number, transform: MlColumnSpec['transform']) {
  if (transform === 'log1p') return Math.log1p(Math.max(0, value));
  if (transform === 'signed_log1p') return Math.sign(value) * Math.log1p(Math.abs(value));
  return value;
}

function rawNumber(value: unknown) {
  if (value === null || value === undefined || value === '') return Number.NaN;
  if (typeof value === 'boolean') return value ? 1 : 0;
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : Number.NaN;
}

/** Feature vector in artifact column order (NaN = missing for tree models). */
export function vectorize(features: MlFeatures, artifact: MlModelArtifact): number[] {
  const linear = artifact.algorithm === 'logistic_regression';
  return artifact.columns.map((column) => {
    const raw = features[column.feature];
    if (column.kind === 'missing') return raw === null || raw === undefined ? 1 : 0;
    if (column.kind === 'onehot') return raw === column.category ? 1 : 0;
    let value = rawNumber(raw);
    if (!Number.isNaN(value)) value = applyTransform(value, column.transform ?? null);
    if (linear) {
      if (Number.isNaN(value)) value = column.impute ?? 0;
      return (value - (column.mean ?? 0)) / (column.std && column.std > 0 ? column.std : 1);
    }
    return value;
  });
}

function evalTree(node: LgbNode, x: number[]): number {
  let current = node;
  while (current.leaf_value === undefined) {
    let value = x[current.split_feature!];
    const missingType = current.missing_type ?? 'None';
    let goLeft: boolean;
    if (missingType === 'NaN' && Number.isNaN(value)) goLeft = Boolean(current.default_left);
    else if (missingType === 'Zero' && (Number.isNaN(value) || Math.abs(value) <= 1e-35)) goLeft = Boolean(current.default_left);
    else {
      if (Number.isNaN(value)) value = 0;
      goLeft = value <= current.threshold!;
    }
    current = goLeft ? current.left_child! : current.right_child!;
  }
  return current.leaf_value;
}

/** Validates an artifact against the current schema before use (corrupt / foreign artifacts are rejected). */
export function validateArtifact(artifact: unknown): MlModelArtifact {
  const value = artifact as MlModelArtifact;
  if (!value || value.format !== ML_ARTIFACT_FORMAT) throw new Error('Unknown model artifact format');
  if (!Array.isArray(value.columns) || !value.columns.length) throw new Error('Model artifact has no columns');
  const known = new Set(ML_FEATURE_SCHEMA.map((spec) => spec.name));
  for (const column of value.columns) if (!known.has(column.feature)) throw new Error(`Model uses unknown feature ${column.feature}`);
  if (value.algorithm === 'logistic_regression' && value.logistic?.coef.length !== value.columns.length) throw new Error('Coefficient count mismatch');
  if (value.algorithm === 'lightgbm' && !value.lightgbm?.trees?.length) throw new Error('LightGBM artifact has no trees');
  if (value.algorithm !== 'logistic_regression' && value.algorithm !== 'lightgbm') throw new Error('Unsupported algorithm');
  return value;
}

export function predictMl(artifact: MlModelArtifact, features: MlFeatures): MlPrediction {
  const x = vectorize(features, artifact);
  let raw: number;
  let contributions: MlPrediction['contributions'] = null;
  if (artifact.algorithm === 'logistic_regression') {
    const coef = artifact.logistic!.coef;
    raw = artifact.logistic!.intercept + coef.reduce((sum, weight, index) => sum + weight * x[index], 0);
    const byFeature = new Map<string, number>();
    artifact.columns.forEach((column, index) => byFeature.set(column.feature, (byFeature.get(column.feature) ?? 0) + coef[index] * x[index]));
    contributions = [...byFeature.entries()].map(([feature, value]) => ({ feature, value })).sort((a, b) => Math.abs(b.value) - Math.abs(a.value)).slice(0, 6);
  } else {
    raw = artifact.lightgbm!.trees.reduce((sum, tree) => sum + evalTree(tree.tree_structure, x), 0);
  }
  const calibrated = Boolean(artifact.calibration);
  const probability = artifact.calibration ? sigmoid(artifact.calibration.a * raw + artifact.calibration.b) : sigmoid(raw);
  return {
    modelVersion: artifact.modelVersion,
    rawScore: raw,
    probability,
    calibrated,
    mlEntryScore: Math.round(probability * 100),
    predictedClass: probability >= artifact.decisionThreshold ? 'ML_BUY' : 'ML_SKIP',
    contributions,
  };
}
