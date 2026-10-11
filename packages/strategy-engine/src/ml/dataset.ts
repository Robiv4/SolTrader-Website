/**
 * Deterministic dataset assembly (pure). The CLI (`pnpm ml:dataset`) loads snapshots + outcomes from the database,
 * calls buildMlDataset, hashes the CSV and records an immutable MLDatasetVersion.
 *
 * Determinism: rows are ordered by (snapshotAt, snapshotId); columns follow ML_FEATURE_SCHEMA; values are written
 * raw (encoding / transforms happen from the same schema in Python and in TS inference). Same input -> same CSV.
 */
import { ML_FEATURE_SCHEMA, ML_FEATURE_VERSION, type MlFeatures } from './features.js';
import { ML_LABEL_VERSION, type CandidateOutcomeResult } from './outcomes.js';

export interface MlTargetDefinition {
  id: string;
  /**
   * classification: market-opportunity label from the SHADOW price path of EVERY eligible candidate.
   * paper_trade: research target from REAL closed PAPER trades only (selection-biased: only bought candidates; never
   * fabricated for skipped candidates). The trade result is the label, never a feature.
   */
  kind: 'classification' | 'paper_trade';
  /** Path label (first-hit ordering) evaluated within its horizon (classification targets). */
  pathLabel: string;
  horizonS: number;
  description: string;
}

export const ML_TARGETS: Record<string, MlTargetDefinition> = {
  plus20BeforeMinus10_30m: { id: 'plus20BeforeMinus10_30m', kind: 'classification', pathLabel: 'plus20BeforeMinus10', horizonS: 1800, description: '+20 % reached before -10 % within 30 minutes' },
  plus10BeforeMinus10_30m: { id: 'plus10BeforeMinus10_30m', kind: 'classification', pathLabel: 'plus10BeforeMinus10', horizonS: 1800, description: '+10 % reached before -10 % within 30 minutes' },
  plus25BeforeMinus20_30m: { id: 'plus25BeforeMinus20_30m', kind: 'classification', pathLabel: 'plus25BeforeMinus20', horizonS: 1800, description: '+25 % reached before -20 % within 30 minutes' },
  paperNetPositive: { id: 'paperNetPositive', kind: 'paper_trade', pathLabel: '', horizonS: 0, description: 'RESEARCH: the actual PAPER trade closed with a positive net P&L (fees + slippage); bought candidates only (selection-biased)' },
};

export interface MlDatasetSourceRow {
  snapshotId: string;
  candidateId: string;
  mint: string;
  source: string;
  kind: string;
  snapshotAt: number;
  featureVersion: string;
  features: MlFeatures;
  validForTraining: boolean;
  invalidReasons: string[];
  dataQuality: number;
  decision: string;
  outcome: CandidateOutcomeResult | null;
  /** Realised net P&L of the actual PAPER trade (fees + slippage included) when the candidate was bought; not a feature. */
  paperNetPnl?: number | null;
  /** When that PAPER trade closed (the paper_trade label is only known from then on). */
  paperExitAt?: number | null;
  /** Which strategy opened that PAPER trade (DEFAULT | ML); provenance only, never a feature. */
  paperEntryStrategy?: string | null;
}

export interface MlDatasetConfig {
  version: string;
  featureVersion: string;
  labelVersion: string;
  target: string;
  /** Snapshot kind used for training rows (one row per candidate). */
  snapshotKind: string;
  from?: number | null;
  to?: number | null;
  sources?: string[] | null;
  minDataQuality: number;
}

export const ML_META_COLUMNS = ['snapshot_id', 'candidate_id', 'mint', 'source', 'snapshot_kind', 'snapshot_at_ms', 'label_end_ms', 'decision', 'label', 'paper_net_pnl'];

/** Readiness guidance (UI), not a guarantee: depends also on positives, regimes and source diversity. */
export function datasetReadiness(usableRows: number, positives: number) {
  if (usableRows < 1000 || positives < 50) return 'INSUFFICIENT_DATA' as const;
  if (usableRows < 5000 || positives < 200) return 'RESEARCH_ONLY' as const;
  return 'EVALUATE_VALIDATION' as const;
}

const csvCell = (value: unknown) => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

export function buildMlDataset(input: MlDatasetSourceRow[], config: MlDatasetConfig) {
  const target = ML_TARGETS[config.target];
  if (!target) throw new Error(`Unknown target ${config.target}`);
  if (config.featureVersion !== ML_FEATURE_VERSION) throw new Error(`Feature version ${config.featureVersion} is not the current schema ${ML_FEATURE_VERSION}`);
  if (config.labelVersion !== ML_LABEL_VERSION) throw new Error(`Label version ${config.labelVersion} is not ${ML_LABEL_VERSION}`);
  const excluded: Record<string, number> = {};
  const exclude = (reason: string) => {
    excluded[reason] = (excluded[reason] ?? 0) + 1;
  };
  const ordered = [...input].sort((a, b) => a.snapshotAt - b.snapshotAt || a.snapshotId.localeCompare(b.snapshotId));
  const seenCandidates = new Set<string>();
  let leakageViolations = 0;
  let invalidTimestamps = 0;
  let duplicateCandidates = 0;
  const kept: Array<{ row: MlDatasetSourceRow; label: boolean }> = [];
  for (const row of ordered) {
    if (row.kind !== config.snapshotKind) {
      exclude('OTHER_SNAPSHOT_KIND');
      continue;
    }
    if (row.featureVersion !== config.featureVersion) {
      exclude('FEATURE_VERSION_MISMATCH');
      continue;
    }
    if (config.from && row.snapshotAt < config.from) {
      exclude('BEFORE_RANGE');
      continue;
    }
    if (config.to && row.snapshotAt >= config.to) {
      exclude('AFTER_RANGE');
      continue;
    }
    if (config.sources?.length && !config.sources.includes(row.source)) {
      exclude('SOURCE_FILTERED');
      continue;
    }
    if (!Number.isFinite(row.snapshotAt) || row.snapshotAt <= 0) {
      invalidTimestamps += 1;
      exclude('INVALID_TIMESTAMP');
      continue;
    }
    if (!row.validForTraining) {
      if (row.invalidReasons.some((reason) => reason.startsWith('FUTURE_DATA'))) leakageViolations += 1;
      exclude('INVALID_FOR_TRAINING');
      continue;
    }
    // One row per candidate (the earliest snapshot of the configured kind): no near-duplicate rows across splits.
    if (seenCandidates.has(row.candidateId)) {
      duplicateCandidates += 1;
      exclude('DUPLICATE_CANDIDATE');
      continue;
    }
    if (row.dataQuality < config.minDataQuality) {
      exclude('LOW_DATA_QUALITY');
      continue;
    }
    if (target.kind === 'paper_trade') {
      // Real trade results only: a skipped candidate has no PAPER P&L and gets none invented.
      if (row.paperNetPnl === null || row.paperNetPnl === undefined || !row.paperExitAt) {
        exclude('NO_CLOSED_PAPER_TRADE');
        continue;
      }
      seenCandidates.add(row.candidateId);
      kept.push({ row, label: row.paperNetPnl > 0 });
      continue;
    }
    if (!row.outcome || row.outcome.labelVersion !== config.labelVersion) {
      exclude('NO_OUTCOME');
      continue;
    }
    const label = row.outcome.pathLabels[target.pathLabel];
    if (label === null || label === undefined) {
      exclude(row.outcome.quality === 'COMPLETE' ? 'LABEL_AMBIGUOUS' : 'OUTCOME_INCOMPLETE');
      continue;
    }
    seenCandidates.add(row.candidateId);
    kept.push({ row, label });
  }

  // 'source' is both a meta column and a feature: written once (meta), read as the feature by name.
  const featureNames = ML_FEATURE_SCHEMA.map((spec) => spec.name).filter((name) => !ML_META_COLUMNS.includes(name));
  const header = [...ML_META_COLUMNS, ...featureNames];
  const lines = [header.join(',')];
  for (const { row, label } of kept) {
    lines.push([
      // label_end_ms: when the label became known (purged split); for paper_trade targets the trade exit time.
      row.snapshotId, row.candidateId, row.mint, row.source, row.kind, row.snapshotAt, target.kind === 'paper_trade' ? row.paperExitAt : row.snapshotAt + target.horizonS * 1000, row.decision, label ? 1 : 0, row.paperNetPnl ?? null,
      ...featureNames.map((name) => row.features[name] ?? null),
    ].map(csvCell).join(','));
  }
  const count = <K extends string>(values: K[]) => values.reduce<Record<string, number>>((acc, value) => {
    acc[value] = (acc[value] ?? 0) + 1;
    return acc;
  }, {});
  const positives = kept.filter((item) => item.label).length;
  const missingRates = Object.fromEntries(ML_FEATURE_SCHEMA.map((spec) => spec.name).map((name) => [name, kept.length ? kept.filter((item) => item.row.features[name] === null || item.row.features[name] === undefined).length / kept.length : null]));
  const manifest = {
    version: config.version,
    featureVersion: config.featureVersion,
    labelVersion: config.labelVersion,
    target: target.id,
    targetDescription: target.description,
    snapshotKind: config.snapshotKind,
    minDataQuality: config.minDataQuality,
    startTime: kept.length ? new Date(kept[0].row.snapshotAt).toISOString() : null,
    endTime: kept.length ? new Date(kept[kept.length - 1].row.snapshotAt).toISOString() : null,
    inputRows: input.length,
    rows: kept.length,
    decisions: count(kept.map((item) => item.row.decision)),
    paperTrades: kept.filter((item) => item.row.paperNetPnl !== null && item.row.paperNetPnl !== undefined).length,
    paperTradesByStrategy: count(kept.filter((item) => item.row.paperNetPnl !== null && item.row.paperNetPnl !== undefined).map((item) => item.row.paperEntryStrategy ?? 'DEFAULT')),
    targetKind: target.kind,
    /** paper_trade targets only cover candidates a strategy bought: not an unbiased market sample. */
    selectionBiased: target.kind === 'paper_trade',
    sources: count(kept.map((item) => item.row.source)),
    outcomeQuality: count(kept.map((item) => item.row.outcome!.quality)),
    positives,
    negatives: kept.length - positives,
    positiveRate: kept.length ? positives / kept.length : null,
    missingRates,
    excluded,
    leakageViolations,
    invalidTimestamps,
    duplicateCandidates,
    readiness: datasetReadiness(kept.length, positives),
    columns: header,
  };
  return { csv: `${lines.join('\n')}\n`, manifest, rows: kept.length };
}
