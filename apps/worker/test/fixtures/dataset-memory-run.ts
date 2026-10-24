/**
 * Memory stress run (child process of dataset-memory.stress.test.ts):
 *   tsx dataset-memory-run.ts <streaming|legacy> <sources> <workDir>
 * SYNTHETIC replay sources with full 60-minute, 1-second outcome paths (the real bucket layout) are generated one by
 * one. streaming = the pipeline path (rows -> StreamingDatasetWriter, sources dropped after use); legacy = the previous
 * approach (every source + path held, then the in-memory builder and one CSV string). Prints one JSON line:
 * { rows, fileHash, peakHeapMb, peakRssMb, seconds }. Peak = max over frequent samples (after every source / page and
 * on every writer progress callback; the legacy builder is synchronous, so its last sample is taken right after it).
 */
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

import { buildAutonomousDataset, replaySourceRows, type ReplaySource } from '@soltrader/strategy-engine';

import { syntheticReplaySource } from '../../../../packages/strategy-engine/test/helpers/autonomous-sources.js';
import { StreamingDatasetWriter } from '../../src/training/dataset-writer.js';

const [mode, countText, workDir] = process.argv.slice(2);
const count = Number(countText);
let peakHeap = 0;
let peakRss = 0;
const sample = () => {
  const usage = process.memoryUsage();
  peakHeap = Math.max(peakHeap, usage.heapUsed);
  peakRss = Math.max(peakRss, usage.rss);
};
const started = Date.now();

if (mode === 'streaming') {
  const writer = new StreamingDatasetWriter({ workDir });
  for (let i = 0; i < count; i += 1) {
    for (const row of replaySourceRows(syntheticReplaySource(i), writer.stats.exclude)) await writer.add(row);
    sample();
  }
  const result = await writer.finish(() => sample());
  sample();
  console.log(JSON.stringify({ rows: result.rows, fileHash: result.fileHash, peakHeapMb: Math.round(peakHeap / 1_048_576), peakRssMb: Math.round(peakRss / 1_048_576), seconds: Math.round((Date.now() - started) / 1000) }));
} else {
  const sources: ReplaySource[] = [];
  for (let i = 0; i < count; i += 1) {
    sources.push(syntheticReplaySource(i));
    sample();
  }
  const built = buildAutonomousDataset({ version: 'LEGACY', replay: sources, live: [] });
  sample();
  writeFileSync(path.join(workDir, 'dataset.csv'), built.csv);
  console.log(JSON.stringify({ rows: built.rows.length, fileHash: createHash('sha256').update(built.csv).digest('hex'), peakHeapMb: Math.round(peakHeap / 1_048_576), peakRssMb: Math.round(peakRss / 1_048_576), seconds: Math.round((Date.now() - started) / 1000) }));
}
