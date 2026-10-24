/**
 * Streaming dataset writer (external merge sort) == in-memory builder: byte-identical CSV, equal manifest, streaming
 * SHA-256 equal to the hash of the whole file, across many chunk files and multi-level merges.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { buildAutonomousDataset, liveSourceRow, replaySourceRows, type OutcomePathState } from '@soltrader/strategy-engine';
import { afterEach, describe, expect, it } from 'vitest';

import { syntheticLiveSource, syntheticReplaySource } from '../../../packages/strategy-engine/test/helpers/autonomous-sources.js';
import { MAX_MERGE_FAN_IN, sha256File, StreamingDatasetWriter } from '../src/training/dataset-writer.js';

const dirs: string[] = [];
const workDir = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'soltrader-writer-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function input(replayCount: number, liveCount: number) {
  const replay = Array.from({ length: replayCount }, (_, i) => syntheticReplaySource(i, { stepSeconds: 5 }));
  const byMint = new Map<string, OutcomePathState[]>();
  for (const source of replay) if (Array.isArray(source.path?.buckets)) byMint.set(source.mint, [...(byMint.get(source.mint) ?? []), source.path]);
  const pathFor = (mint: string, at: number) => (byMint.get(mint) ?? []).filter((path) => path.startAt <= at).sort((a, b) => b.startAt - a.startAt)[0] ?? null;
  return { replay, live: Array.from({ length: liveCount }, (_, i) => syntheticLiveSource(i, pathFor)) };
}

async function stream(data: ReturnType<typeof input>, chunkRows: number) {
  const dir = workDir();
  const writer = new StreamingDatasetWriter({ workDir: dir, chunkRows });
  for (const source of data.replay) for (const row of replaySourceRows(source, writer.stats.exclude)) await writer.add(row);
  for (const source of data.live) {
    const row = liveSourceRow(source, writer.stats.exclude);
    if (row) await writer.add(row);
  }
  const progress: number[] = [];
  const result = await writer.finish((value) => progress.push(value.rowsWritten));
  return { dir, writer, result, progress };
}

describe('StreamingDatasetWriter', () => {
  it('equals the in-memory builder byte for byte across many chunks and multi-level merges', async () => {
    const data = input(160, 240);
    const reference = buildAutonomousDataset({ version: 'W', ...data });
    const chunkRows = 7;
    const { dir, writer, result, progress } = await stream(data, chunkRows);
    expect(Math.ceil(reference.rows.length / chunkRows)).toBeGreaterThan(MAX_MERGE_FAN_IN); // fan-in levels exercised
    const csv = readFileSync(result.csvPath, 'utf8');
    expect(csv).toBe(reference.csv);
    expect(result.rows).toBe(reference.rows.length);
    expect(result.bytes).toBe(Buffer.byteLength(reference.csv));
    expect(JSON.stringify(writer.stats.manifest('W'))).toBe(JSON.stringify(reference.manifest));
    // Streaming SHA-256 == hash of the whole content == file hash read back.
    const whole = createHash('sha256').update(reference.csv).digest('hex');
    expect(result.fileHash).toBe(whole);
    expect(await sha256File(result.csvPath)).toBe(whole);
    expect(progress.at(-1)).toBe(reference.rows.length);
    // Chunk files are removed; only the CSV remains in the work directory.
    expect(readdirSync(dir)).toEqual(['dataset.csv']);
  });

  it('is deterministic: the same input gives the same bytes with any chunk size', async () => {
    const data = input(60, 90);
    const a = await stream(data, 5);
    const b = await stream(data, 100_000);
    expect(a.result.fileHash).toBe(b.result.fileHash);
    expect(readFileSync(a.result.csvPath, 'utf8')).toBe(readFileSync(b.result.csvPath, 'utf8'));
  });

  it('every row of a token keeps the same group_id (across sources and chunk boundaries)', async () => {
    const data = input(80, 0);
    const { result } = await stream(data, 9);
    const lines = readFileSync(result.csvPath, 'utf8').trim().split('\n').slice(1);
    const groupsBySnapshot = new Map<string, Set<string>>();
    for (const line of lines) {
      const [rowId, groupId] = line.split(',');
      const snapshot = rowId.split(':')[1];
      groupsBySnapshot.set(snapshot, (groupsBySnapshot.get(snapshot) ?? new Set()).add(groupId));
    }
    for (const groups of groupsBySnapshot.values()) expect(groups.size).toBe(1);
    // Two sources share each mint: their rows are one group.
    expect(new Set(lines.map((line) => line.split(',')[1])).size).toBeLessThan(groupsBySnapshot.size);
  });
});
