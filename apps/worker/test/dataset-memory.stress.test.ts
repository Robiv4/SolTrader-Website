/**
 * Memory stress (pnpm test:e2e; separate processes with a hard V8 heap limit, SYNTHETIC data only):
 *  - streaming: 60 000 replay sources with full 60-minute 1 s paths (~600 000 rows) must finish under a 256 MB heap
 *    limit, with the measured peak reported and bounded;
 *  - legacy (previous in-memory approach): the same 60 000 sources must exhaust a 3x larger 768 MB heap limit.
 * Measured on the development machine (heap limit via NODE_OPTIONS): streaming 600 015 rows (347 MB CSV) under 256 MB,
 * peak heap 145 MB, CSV SHA-256 identical to the legacy builder's; streaming 1 000 012 rows (625 MB CSV) peak heap
 * 173 MB; legacy 600 015 rows under 768 MB: "Ineffective mark-compacts near heap limit" (as on the VPS); legacy without
 * a limit: peak heap 3 863 MB.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const worker = path.resolve(here, '..');
const tsx = path.join(path.dirname(createRequire(path.join(worker, 'package.json')).resolve('tsx/package.json')), 'dist', 'cli.mjs');

function runChild(mode: 'streaming' | 'legacy', sources: number, heapMb: number) {
  const dir = mkdtempSync(path.join(tmpdir(), `soltrader-mem-${mode}-`));
  try {
    // NODE_OPTIONS (not a CLI flag): tsx runs the script in its own child process, which must get the limit too.
    const result = spawnSync(process.execPath, [tsx, path.join('test', 'fixtures', 'dataset-memory-run.ts'), mode, String(sources), dir], { cwd: worker, env: { ...process.env, NODE_OPTIONS: `--max-old-space-size=${heapMb}` }, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 900_000 });
    const line = (result.stdout ?? '').trim().split('\n').filter((text) => text.startsWith('{')).at(-1);
    let size = 0;
    try {
      size = statSync(path.join(dir, 'dataset.csv')).size;
    } catch {
      size = 0;
    }
    return { status: result.status, signal: result.signal, stderr: (result.stderr ?? '').slice(-2_000), out: line ? JSON.parse(line) as { rows: number; peakHeapMb: number; peakRssMb: number; seconds: number } : null, size };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('dataset preparation memory', () => {
  it('streaming: ~600 000 rows under a 256 MB heap limit (peak measured)', () => {
    const run = runChild('streaming', 60_000, 256);
    expect(run.status, run.stderr).toBe(0);
    expect(run.out!.rows).toBeGreaterThan(590_000);
    expect(run.size).toBeGreaterThan(300_000_000);
    console.log(`streaming: rows=${run.out!.rows} csv=${Math.round(run.size / 1_048_576)} MB peakHeap=${run.out!.peakHeapMb} MB peakRss=${run.out!.peakRssMb} MB ${run.out!.seconds}s`);
    expect(run.out!.peakHeapMb).toBeLessThan(230);
  }, 900_000);

  it('legacy in-memory approach: the same data exhausts a 3x larger (768 MB) heap (the production failure mode)', () => {
    const run = runChild('legacy', 60_000, 768);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toMatch(/heap out of memory|Allocation failed/i);
  }, 900_000);
});
