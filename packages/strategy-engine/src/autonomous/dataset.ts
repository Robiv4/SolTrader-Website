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
import type { MlFeatureSnapshotResult } from '../ml/features.js';
import type { OutcomePathState } from '../ml/outcomes.js';

import { buildAutonomousSnapshot, ML_AUTONOMOUS_FEATURE_SCHEMA, ML_AUTONOMOUS_FEATURE_VERSION } from './features.js';
import { AUTONOMOUS_LABEL_VERSION, labelEntry, labelPosition, pathPriceAt, pathSamples, REPLAY_POSITION_OFFSETS_MS, replayPosition } from './labels.js';

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

export type DatasetExcludeFn = (reason: string) => void;

/** ENTRY + replayed POSITION rows of one replay source (exclusions are reported, never guessed). */
export function replaySourceRows(source: ReplaySource, exclude: DatasetExcludeFn): AutonomousDatasetRow[] {
  const rows: AutonomousDatasetRow[] = [];
  if (!source.snapshot.validForTraining) {
    exclude('REPLAY_SNAPSHOT_INVALID');
    return rows;
  }
  if (!source.path || typeof source.path.startAt !== 'number' || !Array.isArray(source.path.buckets) || !(source.path.entryPrice > 0)) {
    exclude('REPLAY_PATH_INVALID');
    return rows;
  }
  const t0 = source.snapshot.snapshotAt;
  if (t0 !== source.path.startAt) {
    exclude('REPLAY_PATH_START_MISMATCH');
    return rows;
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
  return rows;
}

/** The labelled row of one live decision snapshot, or null (exclusion reported). */
export function liveSourceRow(source: LiveSource, exclude: DatasetExcludeFn): AutonomousDatasetRow | null {
  if (!source.validForTraining) {
    exclude('LIVE_SNAPSHOT_INVALID');
    return null;
  }
  if (source.kind === 'ENTRY') {
    const label = labelEntry(source.path, source.at);
    if (label.status !== 'LABELLED') {
      exclude(`LIVE_ENTRY_${label.exclusion}`);
      return null;
    }
    return { rowId: `L:${source.id}`, groupId: source.mint, kind: 'ENTRY', origin: 'LIVE', at: source.at, labelEnd: label.labelEndAt, features: source.features, labels: entryLabels(label) };
  }
  if (!source.position) {
    exclude('LIVE_POSITION_STATE_MISSING');
    return null;
  }
  const label = labelPosition(source.path, source.at, source.position);
  if (label.status !== 'LABELLED') {
    exclude(`LIVE_POSITION_${label.exclusion}`);
    return null;
  }
  return { rowId: `L:${source.id}`, groupId: source.mint, kind: 'POSITION', origin: 'LIVE', at: source.at, labelEnd: label.labelEndAt, features: source.features, labels: positionLabels(label) };
}

/** Dataset row order: time, then row id (deterministic; the streaming builder merges sorted chunks with it). */
export const compareAutonomousRows = (a: { at: number; rowId: string }, b: { at: number; rowId: string }) => a.at - b.at || a.rowId.localeCompare(b.rowId);

const FEATURE_NAMES = ML_AUTONOMOUS_FEATURE_SCHEMA.map((spec) => spec.name);

export const autonomousCsvHeader = () => [...AUTONOMOUS_META_COLUMNS, ...AUTONOMOUS_LABEL_COLUMNS, ...FEATURE_NAMES].join(',');

export function autonomousCsvLine(row: AutonomousDatasetRow) {
  return [
    row.rowId, row.groupId, row.kind, row.origin, row.at, row.labelEnd, row.features.marketRegime ?? '',
    ...AUTONOMOUS_LABEL_COLUMNS.map((name) => row.labels[name]),
    ...FEATURE_NAMES.map((name) => row.features[name]),
  ].map(csvValue).join(',');
}

export const autonomousRegimeKey = (row: AutonomousDatasetRow) => String(row.features.marketRegime ?? 'UNKNOWN');

/**
 * Incremental manifest statistics (bounded memory: counters per feature / reason / regime and the set of token ids).
 * `count()` is order independent; `ordered()` must be called once per row in the final (sorted) row order - it fixes the
 * period and the regime key order exactly like the in-memory builder did.
 */
export class AutonomousDatasetStats {
  rows = 0;
  private readonly groups = new Set<string>();
  private readonly excluded: Record<string, number> = {};
  private readonly nulls = new Array<number>(FEATURE_NAMES.length).fill(0);
  private readonly regimeCounts = new Map<string, number>();
  private readonly regimeOrder: string[] = [];
  private first: number | null = null;
  private last: number | null = null;
  private readonly counts = { entry: 0, entryReplay: 0, entryLive: 0, positives: 0, position: 0, positionReplay: 0, positionLive: 0, holdBetter: 0, liquidityAssumed: 0, coarse: 0 };

  readonly exclude: DatasetExcludeFn = (reason) => {
    this.excluded[reason] = (this.excluded[reason] ?? 0) + 1;
  };

  get excludedTotal() {
    return Object.values(this.excluded).reduce((sum, value) => sum + value, 0);
  }

  get entryRows() {
    return this.counts.entry;
  }

  get positionRows() {
    return this.counts.position;
  }

  get replayRows() {
    return this.counts.entryReplay + this.counts.positionReplay;
  }

  get liveRows() {
    return this.counts.entryLive + this.counts.positionLive;
  }

  count(row: AutonomousDatasetRow) {
    this.rows += 1;
    this.groups.add(row.groupId);
    for (let index = 0; index < FEATURE_NAMES.length; index += 1) {
      const value = row.features[FEATURE_NAMES[index]];
      if (value === null || value === undefined) this.nulls[index] += 1;
    }
    const regime = autonomousRegimeKey(row);
    this.regimeCounts.set(regime, (this.regimeCounts.get(regime) ?? 0) + 1);
    const counts = this.counts;
    if (row.kind === 'ENTRY') {
      counts.entry += 1;
      if (row.origin === 'REPLAY') counts.entryReplay += 1;
      else counts.entryLive += 1;
      if ((row.labels.entry_net_pct ?? 0) > 0) counts.positives += 1;
    } else {
      counts.position += 1;
      if (row.origin === 'REPLAY') counts.positionReplay += 1;
      else counts.positionLive += 1;
      if ((row.labels.hold_advantage_pct ?? 0) > 0) counts.holdBetter += 1;
    }
    if (row.labels.liquidity_assumed === 1) counts.liquidityAssumed += 1;
    if ((row.labels.label_resolution_ms ?? 0) >= 15_000) counts.coarse += 1;
  }

  ordered(at: number, regimeKey: string) {
    if (this.first === null) this.first = at;
    this.last = at;
    if (!this.regimeOrder.includes(regimeKey)) this.regimeOrder.push(regimeKey);
  }

  manifest(version: string): Record<string, unknown> {
    const rows = this.rows;
    const counts = this.counts;
    return {
      version, featureVersion: ML_AUTONOMOUS_FEATURE_VERSION, labelVersion: AUTONOMOUS_LABEL_VERSION, target: 'AUTONOMOUS_NET_PNL',
      rows, groups: this.groups.size,
      coverage: {
        entry: { total: counts.entry, replay: counts.entryReplay, live: counts.entryLive, netPositive: counts.positives, netPositiveShare: counts.entry ? counts.positives / counts.entry : null },
        position: { total: counts.position, replay: counts.positionReplay, live: counts.positionLive, holdBetter: counts.holdBetter },
        excluded: { ...this.excluded }, featureNullShare: Object.fromEntries(FEATURE_NAMES.map((name, index) => [name, rows ? Math.round(1000 * this.nulls[index] / rows) / 1000 : null])),
        labelUncertainty: { liquidityAssumed: counts.liquidityAssumed, coarseHorizonResolution: counts.coarse },
        period: rows && this.first !== null && this.last !== null ? { from: new Date(this.first).toISOString(), to: new Date(this.last).toISOString() } : null,
        regimes: Object.fromEntries(this.regimeOrder.map((key) => [key, this.regimeCounts.get(key) ?? 0])),
      },
    };
  }
}

/**
 * In-memory builder (small datasets and tests). The streaming builder in apps/worker (training/dataset-writer.ts)
 * produces the same rows, CSV bytes and manifest from paged sources in bounded memory; both share the functions above.
 */
export function buildAutonomousDataset(input: { version: string; replay: ReplaySource[]; live: LiveSource[] }): AutonomousDatasetResult {
  const rows: AutonomousDatasetRow[] = [];
  const stats = new AutonomousDatasetStats();
  for (const source of input.replay) rows.push(...replaySourceRows(source, stats.exclude));
  for (const source of input.live) {
    const row = liveSourceRow(source, stats.exclude);
    if (row) rows.push(row);
  }
  rows.sort(compareAutonomousRows);
  const lines = [autonomousCsvHeader()];
  for (const row of rows) {
    stats.count(row);
    stats.ordered(row.at, autonomousRegimeKey(row));
    lines.push(autonomousCsvLine(row));
  }
  return { rows, csv: `${lines.join('\n')}\n`, manifest: stats.manifest(input.version) };
}
