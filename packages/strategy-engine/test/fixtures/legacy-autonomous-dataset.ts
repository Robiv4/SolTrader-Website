/* eslint-disable */
/**
 * FROZEN copy of the pre-streaming buildAutonomousDataset (git 2c6bfcc, packages/strategy-engine/src/autonomous/dataset.ts).
 * Parity reference only: the current in-memory and streaming builders must produce byte-identical CSVs and equal manifests.
 */
/**
 * Autonomous ML dataset (CSV + manifest) for the Python trainer.
 *
 * Row sources (all time-correct; features only from data known at the row's moment):
 *   LIVE   - MlAutonomousDecisionSnapshot rows (ENTRY candidates at decision points, POSITION rows of real autonomous
 *            positions) labelled from the candidate's recorded outcome path;
 *   REPLAY - from existing ML snapshots + outcome paths: one ENTRY row at the snapshot moment and replayed POSITION rows
 *            (virtual reference position opened at the snapshot) at fixed offsets, with dynamics / position state from
 *            the path prefix only.
 * group_id = mint: every row of a token stays in one split (no leakage across train / validation / test).
 * Excluded labels are counted per reason (coverage report), never guessed.
 */
import type { MlFeatureSnapshotResult } from '../../src/ml/features.js';
import type { OutcomePathState } from '../../src/ml/outcomes.js';

import { buildAutonomousSnapshot, ML_AUTONOMOUS_FEATURE_SCHEMA, ML_AUTONOMOUS_FEATURE_VERSION } from '../../src/autonomous/features.js';
import { AUTONOMOUS_LABEL_VERSION, labelEntry, labelPosition, pathPriceAt, pathSamples, REPLAY_POSITION_OFFSETS_MS, replayPosition } from '../../src/autonomous/labels.js';

export const AUTONOMOUS_META_COLUMNS = ['row_id', 'group_id', 'kind', 'origin', 'snapshot_at_ms', 'label_end_ms', 'market_regime'];
export const AUTONOMOUS_LABEL_COLUMNS = ['entry_net_pct', 'entry_downside_pct', 'entry_gross_pct', 'entry_cost_pct', 'entry_entry_impact_pct', 'entry_exit_impact_pct', 'hold_advantage_pct', 'sell_now_net_pct', 'label_resolution_ms', 'liquidity_assumed'];

export interface ReplaySource {
  /** Entry context snapshot (ML-FEATURES-COMMUNITY-v1 preferred, else v1) and its candidate path. */
  snapshot: MlFeatureSnapshotResult & { id: string };
  mint: string;
  path: OutcomePathState;
}

export interface LiveSource {
  id: string;
  kind: 'ENTRY' | 'POSITION';
  mint: string;
  at: number;
  features: Record<string, unknown>;
  validForTraining: boolean;
  /** Path covering `at` (the candidate's outcome path), null = none. */
  path: OutcomePathState | null;
  /** POSITION rows: quantity / entry fill of the real position (label scale). */
  position?: { quantity: number; entryFillPrice: number } | null;
}

export interface AutonomousDatasetRow {
  rowId: string;
  groupId: string;
  kind: 'ENTRY' | 'POSITION';
  origin: 'LIVE' | 'REPLAY';
  at: number;
  labelEnd: number;
  features: Record<string, unknown>;
  labels: Record<string, number | null>;
}

export interface AutonomousDatasetResult {
  rows: AutonomousDatasetRow[];
  csv: string;
  manifest: Record<string, unknown>;
}

function entryLabels(label: ReturnType<typeof labelEntry>) {
  return {
    entry_net_pct: label.netReturnPct, entry_downside_pct: label.downsideNetPct, entry_gross_pct: label.grossReturnPct, entry_cost_pct: label.costPct, entry_entry_impact_pct: label.entryImpactPct,
    entry_exit_impact_pct: label.exitImpactPct, hold_advantage_pct: null, sell_now_net_pct: null, label_resolution_ms: label.horizonResolutionMs, liquidity_assumed: label.liquidityAssumed ? 1 : 0,
  };
}

function positionLabels(label: ReturnType<typeof labelPosition>) {
  return {
    entry_net_pct: null, entry_downside_pct: null, entry_gross_pct: null, entry_cost_pct: null, entry_entry_impact_pct: null, entry_exit_impact_pct: null,
    hold_advantage_pct: label.holdAdvantagePct, sell_now_net_pct: label.sellNowNetPct, label_resolution_ms: label.horizonResolutionMs, liquidity_assumed: label.liquidityAssumed ? 1 : 0,
  };
}

const csvValue = (value: unknown) => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

export function legacyBuildAutonomousDataset(input: { version: string; replay: ReplaySource[]; live: LiveSource[] }): AutonomousDatasetResult {
  const rows: AutonomousDatasetRow[] = [];
  const excluded: Record<string, number> = {};
  const exclude = (reason: string) => {
    excluded[reason] = (excluded[reason] ?? 0) + 1;
  };

  for (const source of input.replay) {
    if (!source.snapshot.validForTraining) {
      exclude('REPLAY_SNAPSHOT_INVALID');
      continue;
    }
    if (!source.path || typeof source.path.startAt !== 'number' || !Array.isArray(source.path.buckets) || !(source.path.entryPrice > 0)) {
      exclude('REPLAY_PATH_INVALID');
      continue;
    }
    const t0 = source.snapshot.snapshotAt;
    if (t0 !== source.path.startAt) {
      exclude('REPLAY_PATH_START_MISMATCH');
      continue;
    }
    const at0 = pathPriceAt(source.path, t0, 'known');
    const entrySnapshot = buildAutonomousSnapshot({ kind: 'ENTRY', at: t0, base: source.snapshot, samples: pathSamples(source.path, t0), quote: at0 ? { price: at0.price, liquidityUsd: at0.liquidityUsd, at: t0 } : null });
    const entry = labelEntry(source.path, t0);
    if (entry.status === 'LABELLED' && entrySnapshot.validForTraining) rows.push({ rowId: `R:${source.snapshot.id}:E`, groupId: source.mint, kind: 'ENTRY', origin: 'REPLAY', at: t0, labelEnd: entry.labelEndAt, features: entrySnapshot.features, labels: entryLabels(entry) });
    else exclude(`ENTRY_${entry.exclusion ?? 'FEATURES_INVALID'}`);
    for (const offset of REPLAY_POSITION_OFFSETS_MS) {
      const t = t0 + offset;
      const position = replayPosition(source.path, t);
      const known = pathPriceAt(source.path, t, 'known');
      if (!position || !known) {
        exclude('POSITION_NO_PRICE_AT_T');
        continue;
      }
      const label = labelPosition(source.path, t, position);
      if (label.status !== 'LABELLED') {
        exclude(`POSITION_${label.exclusion}`);
        continue;
      }
      const snapshot = buildAutonomousSnapshot({ kind: 'POSITION', at: t, base: source.snapshot, samples: pathSamples(source.path, t), quote: { price: known.price, liquidityUsd: known.liquidityUsd, at: t }, position });
      if (!snapshot.validForTraining) {
        exclude('POSITION_FEATURES_INVALID');
        continue;
      }
      rows.push({ rowId: `R:${source.snapshot.id}:P${offset / 1000}`, groupId: source.mint, kind: 'POSITION', origin: 'REPLAY', at: t, labelEnd: label.labelEndAt, features: snapshot.features, labels: positionLabels(label) });
    }
  }

  for (const source of input.live) {
    if (!source.validForTraining) {
      exclude('LIVE_SNAPSHOT_INVALID');
      continue;
    }
    if (source.kind === 'ENTRY') {
      const label = labelEntry(source.path, source.at);
      if (label.status !== 'LABELLED') {
        exclude(`LIVE_ENTRY_${label.exclusion}`);
        continue;
      }
      rows.push({ rowId: `L:${source.id}`, groupId: source.mint, kind: 'ENTRY', origin: 'LIVE', at: source.at, labelEnd: label.labelEndAt, features: source.features, labels: entryLabels(label) });
    } else {
      if (!source.position) {
        exclude('LIVE_POSITION_STATE_MISSING');
        continue;
      }
      const label = labelPosition(source.path, source.at, source.position);
      if (label.status !== 'LABELLED') {
        exclude(`LIVE_POSITION_${label.exclusion}`);
        continue;
      }
      rows.push({ rowId: `L:${source.id}`, groupId: source.mint, kind: 'POSITION', origin: 'LIVE', at: source.at, labelEnd: label.labelEndAt, features: source.features, labels: positionLabels(label) });
    }
  }

  rows.sort((a, b) => a.at - b.at || a.rowId.localeCompare(b.rowId));
  const featureNames = ML_AUTONOMOUS_FEATURE_SCHEMA.map((spec) => spec.name);
  const lines = [[...AUTONOMOUS_META_COLUMNS, ...AUTONOMOUS_LABEL_COLUMNS, ...featureNames].join(',')];
  for (const row of rows) {
    lines.push([
      row.rowId, row.groupId, row.kind, row.origin, row.at, row.labelEnd, row.features.marketRegime ?? '',
      ...AUTONOMOUS_LABEL_COLUMNS.map((name) => row.labels[name]),
      ...featureNames.map((name) => row.features[name]),
    ].map(csvValue).join(','));
  }
  const count = (kind: string, origin?: string) => rows.filter((row) => row.kind === kind && (!origin || row.origin === origin)).length;
  const nullShare = Object.fromEntries(featureNames.map((name) => [name, rows.length ? Math.round(1000 * rows.filter((row) => row.features[name] === null || row.features[name] === undefined).length / rows.length) / 1000 : null]));
  const entryRows = rows.filter((row) => row.kind === 'ENTRY');
  const positives = entryRows.filter((row) => (row.labels.entry_net_pct ?? 0) > 0).length;
  const manifest = {
    version: input.version, featureVersion: ML_AUTONOMOUS_FEATURE_VERSION, labelVersion: AUTONOMOUS_LABEL_VERSION, target: 'AUTONOMOUS_NET_PNL',
    rows: rows.length, groups: new Set(rows.map((row) => row.groupId)).size,
    coverage: {
      entry: { total: entryRows.length, replay: count('ENTRY', 'REPLAY'), live: count('ENTRY', 'LIVE'), netPositive: positives, netPositiveShare: entryRows.length ? positives / entryRows.length : null },
      position: { total: count('POSITION'), replay: count('POSITION', 'REPLAY'), live: count('POSITION', 'LIVE'), holdBetter: rows.filter((row) => row.kind === 'POSITION' && (row.labels.hold_advantage_pct ?? 0) > 0).length },
      excluded, featureNullShare: nullShare,
      labelUncertainty: { liquidityAssumed: rows.filter((row) => row.labels.liquidity_assumed === 1).length, coarseHorizonResolution: rows.filter((row) => (row.labels.label_resolution_ms ?? 0) >= 15_000).length },
      period: rows.length ? { from: new Date(rows[0].at).toISOString(), to: new Date(rows[rows.length - 1].at).toISOString() } : null,
      regimes: rows.reduce<Record<string, number>>((counts, row) => ({ ...counts, [String(row.features.marketRegime ?? 'UNKNOWN')]: (counts[String(row.features.marketRegime ?? 'UNKNOWN')] ?? 0) + 1 }), {}),
    },
  };
  return { rows, csv: `${lines.join('\n')}\n`, manifest };
}
