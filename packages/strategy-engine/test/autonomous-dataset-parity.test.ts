/**
 * The refactored dataset builder (shared row / CSV / statistics functions used by the streaming builder) produces
 * exactly what the pre-streaming builder produced: same rows, byte-identical CSV, equal manifest (incl. key order).
 */
import { describe, expect, it } from 'vitest';

import { AutonomousDatasetStats, autonomousCsvHeader, autonomousCsvLine, autonomousRegimeKey, buildAutonomousDataset, compareAutonomousRows, liveSourceRow, replaySourceRows, type OutcomePathState } from '../src/index.js';

import { legacyBuildAutonomousDataset } from './fixtures/legacy-autonomous-dataset.js';
import { syntheticLiveSource, syntheticReplaySource } from './helpers/autonomous-sources.js';

function sources(replayCount: number, liveCount: number) {
  const replay = Array.from({ length: replayCount }, (_, i) => syntheticReplaySource(i, { stepSeconds: 5 }));
  const byMint = new Map<string, OutcomePathState[]>();
  for (const source of replay) if (source.path && Array.isArray(source.path.buckets)) byMint.set(source.mint, [...(byMint.get(source.mint) ?? []), source.path]);
  const pathFor = (mint: string, at: number) => (byMint.get(mint) ?? []).filter((path) => path.startAt <= at).sort((a, b) => b.startAt - a.startAt)[0] ?? null;
  const live = Array.from({ length: liveCount }, (_, i) => syntheticLiveSource(i, pathFor));
  return { replay, live };
}

describe('Autonomous dataset builder parity (refactor vs frozen pre-streaming builder)', () => {
  it('byte-identical CSV, identical rows and manifest (key order included) on a mixed synthetic input', () => {
    const input = sources(160, 220);
    const legacy = legacyBuildAutonomousDataset({ version: 'PARITY', ...input });
    const current = buildAutonomousDataset({ version: 'PARITY', ...input });
    expect(current.rows.length).toBeGreaterThan(500);
    expect(current.csv).toBe(legacy.csv);
    expect(current.rows).toEqual(legacy.rows);
    expect(JSON.stringify(current.manifest)).toBe(JSON.stringify(legacy.manifest));
    const excluded = (current.manifest.coverage as { excluded: Record<string, number> }).excluded;
    // Every exclusion path is exercised (the comparison is not vacuous).
    for (const reason of ['REPLAY_SNAPSHOT_INVALID', 'REPLAY_PATH_START_MISMATCH', 'REPLAY_PATH_INVALID', 'LIVE_SNAPSHOT_INVALID', 'LIVE_POSITION_STATE_MISSING']) expect(excluded[reason], reason).toBeGreaterThan(0);
    expect(Object.keys((current.manifest.coverage as { regimes: Record<string, number> }).regimes).length).toBeGreaterThanOrEqual(3);
  });

  it('statistics are order independent except period / regime order, which follow the sorted rows', () => {
    const input = sources(40, 60);
    const reference = buildAutonomousDataset({ version: 'ORDER', ...input });
    const stats = new AutonomousDatasetStats();
    const rows = [...input.replay].reverse().flatMap((source) => replaySourceRows(source, stats.exclude));
    for (const source of [...input.live].reverse()) {
      const row = liveSourceRow(source, stats.exclude);
      if (row) rows.push(row);
    }
    for (const row of rows) stats.count(row);
    rows.sort(compareAutonomousRows);
    for (const row of rows) stats.ordered(row.at, autonomousRegimeKey(row));
    const manifest = stats.manifest('ORDER');
    // Same values; only the exclusion key order may differ when the sources arrive in another order.
    expect(manifest).toEqual(reference.manifest);
    expect(`${[autonomousCsvHeader(), ...rows.map(autonomousCsvLine)].join('\n')}\n`).toBe(reference.csv);
  });
});
