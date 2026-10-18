/**
 * Deterministic dataset assembly (pure). The CLI (`pnpm ml:dataset`) loads snapshots + outcomes from the database,
 * calls buildMlDataset, hashes the CSV and records an immutable MLDatasetVersion.
 *
 * Determinism: rows are ordered by (snapshotAt, snapshotId); columns follow ML_FEATURE_SCHEMA; values are written
 * raw (encoding / transforms happen from the same schema in Python and in TS inference). Same input -> same CSV.
 */
import { DEFAULT_NEW_LAUNCH_SETTINGS } from '../launch/index.js';

import { featureSchemaFor, isSupportedFeatureVersion } from './community-features.js';
import { simulateNewLaunchExit, type SimExitResult, type SimExitRules } from './exit-simulation.js';
import type { MlFeatures } from './features.js';
import { ML_LABEL_VERSION, type CandidateOutcomeResult, type OutcomePathState } from './outcomes.js';

export interface MlTargetDefinition {
  id: string;
  /**
   * classification: market-opportunity label from the SHADOW price path of EVERY eligible candidate.
   * paper_trade: research target from REAL closed PAPER trades only (selection-biased: only bought candidates; never
   * fabricated for skipped candidates). The trade result is the label, never a feature.
   * simulated_exit: net result of a hypothetical PAPER entry at the snapshot, simulated with the New Launch exit rules
   * and PAPER costs on the recorded SHADOW price path (every eligible candidate; see exit-simulation.ts).
   */
  kind: 'classification' | 'paper_trade' | 'simulated_exit';
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
  simExitNetPositive: { id: 'simExitNetPositive', kind: 'simulated_exit', pathLabel: '', horizonS: 3600, description: 'Net PAPER result > 0 of an entry at the snapshot under the New Launch exit rules (SL / TP / break-even / trailing / liquidity / max hold), fees and simulated slippage, on the recorded price path' },
};

/** Exit rules of the simulated_exit target: the documented New Launch PAPER defaults unless the dataset config overrides them. */
export const DEFAULT_SIM_EXIT_RULES: SimExitRules = {
  stopLossPercent: DEFAULT_NEW_LAUNCH_SETTINGS.stopLossPercent, takeProfitPercent: DEFAULT_NEW_LAUNCH_SETTINGS.takeProfitPercent,
  breakEvenEnabled: DEFAULT_NEW_LAUNCH_SETTINGS.breakEvenEnabled, breakEvenActivationPercent: DEFAULT_NEW_LAUNCH_SETTINGS.breakEvenActivationPercent,
  breakEvenCostBufferPercent: DEFAULT_NEW_LAUNCH_SETTINGS.breakEvenCostBufferPercent, trailingEnabled: DEFAULT_NEW_LAUNCH_SETTINGS.trailingEnabled,
  trailingActivationPercent: DEFAULT_NEW_LAUNCH_SETTINGS.trailingActivationPercent, trailingDistancePercent: DEFAULT_NEW_LAUNCH_SETTINGS.trailingDistancePercent,
  maxHoldEnabled: DEFAULT_NEW_LAUNCH_SETTINGS.maxHoldEnabled, maxHoldMinutes: DEFAULT_NEW_LAUNCH_SETTINGS.maxHoldMinutes,
  liquiditySafetyExitEnabled: DEFAULT_NEW_LAUNCH_SETTINGS.liquiditySafetyExitEnabled, liquidityDropExitPercent: DEFAULT_NEW_LAUNCH_SETTINGS.liquidityDropExitPercent,
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
  /** Recorded SHADOW price path after the snapshot (simulated_exit target only; label data, never a feature). */
  outcomePath?: OutcomePathState | null;
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
  /** simulated_exit target: exit rule overrides (default: documented New Launch PAPER defaults) and position size. */
  simExitRules?: Partial<SimExitRules>;
  simPositionUsd?: number;
}

/** Simulated exit summary for the manifest (labels only; never features). */
function summarizeSimExits(results: SimExitResult[], rules: SimExitRules, positionUsd: number) {
  const returns = results.map((item) => item.netReturnPct!).sort((a, b) => a - b);
  const reasons: Record<string, number> = {};
  for (const item of results) reasons[item.reason!] = (reasons[item.reason!] ?? 0) + 1;
  const wins = returns.filter((value) => value > 0);
  const losses = returns.filter((value) => value <= 0);
  const grossWin = wins.reduce((sum, value) => sum + value, 0);
  const grossLoss = -losses.reduce((sum, value) => sum + value, 0);
  return {
    labelVersion: 'SIM-EXIT-v1', rules, positionUsd, rows: results.length, exitReasons: reasons,
    meanNetReturnPct: returns.length ? returns.reduce((sum, value) => sum + value, 0) / returns.length : null,
    medianNetReturnPct: returns.length ? returns[Math.floor(returns.length / 2)] : null,
    winRate: returns.length ? wins.length / returns.length : null,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
    stopLossRate: results.length ? (reasons.STOP_LOSS ?? 0) / results.length : null,
  };
}

/** Share of rows with community data (communityCoverage > 0) and with a Community Score. */
function communityCoverage(rows: MlFeatures[]) {
  const withData = rows.filter((features) => typeof features.communityCoverage === 'number' && features.communityCoverage > 0).length;
  const withScore = rows.filter((features) => typeof features.communityScore === 'number').length;
  return { rows: rows.length, withCommunityData: withData, withCommunityScore: withScore, share: rows.length ? withData / rows.length : null };
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
  if (!isSupportedFeatureVersion(config.featureVersion)) throw new Error(`Feature version ${config.featureVersion} is not a supported schema`);
  const schema = featureSchemaFor(config.featureVersion);
  const simRules = { ...DEFAULT_SIM_EXIT_RULES, ...(config.simExitRules ?? {}) };
  const simResults = new Map<string, SimExitResult>();
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
    if (target.kind === 'simulated_exit') {
      // Only completely observed paths; an exit that cannot be decided from the stored path is excluded, never guessed.
      if (row.outcome.quality !== 'COMPLETE' || !row.outcomePath) {
        exclude(row.outcomePath ? 'OUTCOME_INCOMPLETE' : 'NO_OUTCOME_PATH');
        continue;
      }
      const sim = simulateNewLaunchExit(row.outcomePath, simRules, config.simPositionUsd ?? 20);
      if (sim.status !== 'RESOLVED' || sim.netReturnPct === null) {
        exclude(`SIM_EXIT_${sim.unknownReason ?? 'UNKNOWN'}`);
        continue;
      }
      simResults.set(row.snapshotId, sim);
      seenCandidates.add(row.candidateId);
      kept.push({ row, label: sim.netReturnPct > 0 });
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
  const featureNames = schema.map((spec) => spec.name).filter((name) => !ML_META_COLUMNS.includes(name));
  const header = [...ML_META_COLUMNS, ...featureNames];
  const lines = [header.join(',')];
  for (const { row, label } of kept) {
    lines.push([
      // label_end_ms: when the label became known (purged split); for paper_trade targets the trade exit time.
      row.snapshotId, row.candidateId, row.mint, row.source, row.kind, row.snapshotAt,
      target.kind === 'paper_trade' ? row.paperExitAt : target.kind === 'simulated_exit' ? row.snapshotAt + (simResults.get(row.snapshotId)?.exitOffsetMs ?? target.horizonS * 1000) : row.snapshotAt + target.horizonS * 1000,
      row.decision, label ? 1 : 0, row.paperNetPnl ?? null,
      ...featureNames.map((name) => row.features[name] ?? null),
    ].map(csvCell).join(','));
  }
  const count = <K extends string>(values: K[]) => values.reduce<Record<string, number>>((acc, value) => {
    acc[value] = (acc[value] ?? 0) + 1;
    return acc;
  }, {});
  const positives = kept.filter((item) => item.label).length;
  const missingRates = Object.fromEntries(schema.map((spec) => spec.name).map((name) => [name, kept.length ? kept.filter((item) => item.row.features[name] === null || item.row.features[name] === undefined).length / kept.length : null]));
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
    ...(target.kind === 'simulated_exit' ? { simulatedExit: summarizeSimExits([...simResults.values()], simRules, config.simPositionUsd ?? 20) } : {}),
    ...(config.featureVersion !== 'ML-FEATURES-v1' ? { communityCoverage: communityCoverage(kept.map((item) => item.row.features)) } : {}),
    columns: header,
  };
  return { csv: `${lines.join('\n')}\n`, manifest, rows: kept.length };
}
