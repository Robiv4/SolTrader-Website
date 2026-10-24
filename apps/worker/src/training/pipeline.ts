/**
 * Autonomous ML training pipeline shared by the CLI (`pnpm ml:autonomous:*`) and the web training jobs (ml-trainer):
 *   1. dataset  - immutable AUTO-DATASET-v<n> (CSV + manifest + MlDatasetVersion row, label audit rows);
 *   2. trainer  - `python -m soltrader_ml.autonomous` as a child process (streamed stage events, timeout, cancel,
 *                 low CPU priority, single-threaded numeric libraries);
 *   3. register - sha256 of the written bundle verified, then a NEW immutable TRAINED registry row.
 * Never touches trading: no account, position, selection or approval is read or written here.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, createReadStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';

import { Prisma, type PrismaClient } from '@prisma/client';
import { AUTONOMOUS_LABEL_VERSION, labelEntry, labelPosition, liveSourceRow, ML_AUTONOMOUS_FEATURE_VERSION, replaySourceRows, type LiveSource } from '@soltrader/strategy-engine';

import { countLiveSnapshots, countReplaySnapshots, DEFAULT_LIVE_PAGE_SIZE, DEFAULT_REPLAY_PAGE_SIZE, liveSourcePages, replaySourcePages } from '../autonomous/dataset-source.js';
import { registerAutonomousBundle } from '../ml/model-registration.js';

import { DEFAULT_SORT_CHUNK_ROWS, sha256File, StreamingDatasetWriter, writeJson } from './dataset-writer.js';

export { sha256File } from './dataset-writer.js';

export const sha256 = (content: string | Buffer) => createHash('sha256').update(content).digest('hex');
export const AUTONOMOUS_MODELS_DIR = path.join('ml', 'autonomous-models');
/** Temporary trainer work directories (memory-mapped matrices), created and removed by runAutonomousTrainer. */
export const WORK_DIR_PREFIX = '.work-';

export interface DatasetBuildResult { version: string; rows: number; directory: string; fileHash: string; manifest: Record<string, unknown> }

/** Real, measured progress of the dataset preparation (no invented percentages). */
export interface DatasetProgress {
  phase: 'COUNTING' | 'REPLAY' | 'LIVE' | 'WRITING_CSV' | 'MANIFEST' | 'REGISTERING' | 'DONE';
  replay: { processed: number; total: number };
  live: { processed: number; total: number };
  rows: { entry: number; position: number; replay: number; live: number };
  excluded: number;
  csv: { rowsWritten: number; bytes: number; chunks: number };
  heapUsedMb: number;
}

export interface DatasetBuildOptions {
  rootDir: string;
  actor: string;
  version?: string;
  now?: number;
  /** Training job id (owner marker of the temporary work directory; recovery removes it only for finished jobs). */
  jobId?: string;
  onProgress?: (progress: DatasetProgress) => void;
  signal?: globalThis.AbortSignal;
  replayPageSize?: number;
  livePageSize?: number;
  sortChunkRows?: number;
}

export const AUTONOMOUS_DATASETS_DIR = path.join('ml', 'autonomous-datasets');
/** Temporary work directories (never a dataset version: versions never start with a dot). */
export const BUILD_DIR_PREFIX = '.build-';

const envSize = (name: string, fallback: number) => (Number.isInteger(Number(process.env[name])) && Number(process.env[name]) > 0 ? Number(process.env[name]) : fallback);

function auditRow(row: LiveSource) {
  const label = row.kind === 'ENTRY' ? labelEntry(row.path, row.at) : row.position ? labelPosition(row.path, row.at, row.position) : null;
  return { snapshotId: row.id, labelVersion: AUTONOMOUS_LABEL_VERSION, status: label?.status ?? 'EXCLUDED', labels: (label ?? {}) as Prisma.InputJsonValue, uncertainty: { horizonResolutionMs: label?.horizonResolutionMs ?? null, liquidityAssumed: label?.liquidityAssumed ?? null } as Prisma.InputJsonValue, exclusionReason: label ? label.exclusion : 'POSITION_STATE_MISSING', labelEndAt: new Date(label?.labelEndAt ?? row.at).toISOString() };
}

/** Reserves a NEW immutable version directory (exclusive mkdir: two builders can never get the same version). */
async function reserveVersion(prisma: PrismaClient, datasetsRoot: string, explicit?: string) {
  const reserve = async (version: string) => {
    if (await prisma.mlDatasetVersion.findUnique({ where: { version } })) return false;
    try {
      mkdirSync(path.join(datasetsRoot, version));
      return true;
    } catch (error) {
      if ((error as { code?: string }).code === 'EEXIST') return false;
      throw error;
    }
  };
  if (explicit) {
    if (explicit.startsWith('.') || explicit.includes('/') || explicit.includes('\\') || !await reserve(explicit)) throw new Error(`Dataset ${explicit} already exists (immutable)`);
    return explicit;
  }
  const existing = await prisma.mlDatasetVersion.count({ where: { featureVersion: ML_AUTONOMOUS_FEATURE_VERSION } });
  for (let next = existing + 1; ; next += 1) if (await reserve(`AUTO-DATASET-v${next}`)) return `AUTO-DATASET-v${next}`;
}

/**
 * Builds a new immutable AUTO-DATASET-v<n> in bounded memory:
 *  1. paged sources -> rows -> sorted chunk files inside a NEW own work directory (ml/autonomous-datasets/.build-*);
 *  2. k-way merge -> dataset.csv (streaming SHA-256, incremental manifest statistics);
 *  3. a new version directory is reserved exclusively, the CSV moved in, the manifest written, the hash re-verified;
 *  4. label audit rows, then the MlDatasetVersion row (last: a registered dataset is always complete and verified).
 * Any failure / cancel: the reserved version directory (own) and the work directory (own) are removed, nothing is
 * registered; existing datasets / models are never touched.
 */
export async function buildAutonomousDatasetVersion(prisma: PrismaClient, options: DatasetBuildOptions): Promise<DatasetBuildResult> {
  const now = options.now ?? Date.now();
  const datasetsRoot = path.join(options.rootDir, AUTONOMOUS_DATASETS_DIR);
  mkdirSync(datasetsRoot, { recursive: true });
  // Fail fast for an explicit version that exists (re-checked atomically when it is reserved at the end).
  if (options.version && (existsSync(path.join(datasetsRoot, options.version)) || await prisma.mlDatasetVersion.findUnique({ where: { version: options.version } }))) throw new Error(`Dataset ${options.version} already exists (immutable)`);
  const workDir = mkdtempSync(path.join(datasetsRoot, BUILD_DIR_PREFIX));
  await writeJson(path.join(workDir, 'owner.json'), { jobId: options.jobId ?? null, actor: options.actor, pid: process.pid, host: hostname(), startedAt: new Date().toISOString() });
  const writer = new StreamingDatasetWriter({ workDir, chunkRows: options.sortChunkRows ?? envSize('ML_DATASET_SORT_CHUNK_ROWS', DEFAULT_SORT_CHUNK_ROWS) });
  const stats = writer.stats;
  const progress: DatasetProgress = { phase: 'COUNTING', replay: { processed: 0, total: 0 }, live: { processed: 0, total: 0 }, rows: { entry: 0, position: 0, replay: 0, live: 0 }, excluded: 0, csv: { rowsWritten: 0, bytes: 0, chunks: 0 }, heapUsedMb: 0 };
  const report = (phase: DatasetProgress['phase'] = progress.phase) => {
    Object.assign(progress, { phase, rows: { entry: stats.entryRows, position: stats.positionRows, replay: stats.replayRows, live: stats.liveRows }, excluded: stats.excludedTotal, heapUsedMb: Math.round(process.memoryUsage().heapUsed / 1_048_576) });
    progress.csv.chunks = Math.max(progress.csv.chunks, writer.chunkCount);
    options.onProgress?.(globalThis.structuredClone(progress));
  };
  const checkAbort = () => {
    if (options.signal?.aborted) throw new Error('DATASET_BUILD_CANCELLED');
  };
  let reserved: string | null = null;
  try {
    report();
    [progress.replay.total, progress.live.total] = [await countReplaySnapshots(prisma), await countLiveSnapshots(prisma, now)];
    report('REPLAY');
    let replaySources = 0;
    for await (const page of replaySourcePages(prisma, { pageSize: options.replayPageSize ?? envSize('ML_DATASET_REPLAY_PAGE_SIZE', DEFAULT_REPLAY_PAGE_SIZE) })) {
      checkAbort();
      for (const source of page.sources) for (const row of replaySourceRows(source, stats.exclude)) await writer.add(row);
      replaySources += page.sources.length;
      progress.replay.processed += page.scanned;
      report();
    }
    report('LIVE');
    const auditFile = path.join(workDir, 'label-audit.ndjson');
    let liveSources = 0;
    for await (const page of liveSourcePages(prisma, now, { pageSize: options.livePageSize ?? envSize('ML_DATASET_LIVE_PAGE_SIZE', DEFAULT_LIVE_PAGE_SIZE) })) {
      checkAbort();
      for (const source of page) {
        const row = liveSourceRow(source, stats.exclude);
        if (row) await writer.add(row);
      }
      appendFileSync(auditFile, page.map((source) => `${JSON.stringify(auditRow(source))}\n`).join(''));
      liveSources += page.length;
      progress.live.processed += page.length;
      report();
    }
    checkAbort();
    report('WRITING_CSV');
    const written = await writer.finish((csv) => {
      progress.csv = csv;
      report();
    });
    checkAbort();
    report('MANIFEST');
    const version = reserved = await reserveVersion(prisma, datasetsRoot, options.version);
    const directory = path.join(datasetsRoot, version);
    const manifest = { ...stats.manifest(version), createdAt: new Date(now).toISOString(), fileHash: written.fileHash, sources: { replay: replaySources, live: liveSources } };
    renameSync(written.csvPath, path.join(directory, 'dataset.csv'));
    await writeJson(path.join(directory, 'manifest.json'), manifest);
    // Only a complete, verified file is registered (the hash is re-read from disk, not trusted from memory).
    if (await sha256File(path.join(directory, 'dataset.csv')) !== written.fileHash) throw new Error('Dataset verification failed (hash mismatch after write)');
    report('REGISTERING');
    if (existsSync(auditFile)) {
      let batch: Prisma.MlAutonomousOutcomeCreateManyInput[] = [];
      for await (const line of createInterface({ input: createReadStream(auditFile, { encoding: 'utf8' }), crlfDelay: Infinity })) {
        if (!line) continue;
        batch.push(JSON.parse(line) as Prisma.MlAutonomousOutcomeCreateManyInput);
        if (batch.length >= 1_000) {
          await prisma.mlAutonomousOutcome.createMany({ data: batch, skipDuplicates: true });
          batch = [];
        }
      }
      if (batch.length) await prisma.mlAutonomousOutcome.createMany({ data: batch, skipDuplicates: true });
    }
    await prisma.mlDatasetVersion.create({ data: {
      version, featureVersion: ML_AUTONOMOUS_FEATURE_VERSION, labelVersion: AUTONOMOUS_LABEL_VERSION, target: 'AUTONOMOUS_NET_PNL', config: { version, kinds: ['ENTRY', 'POSITION'] } as Prisma.InputJsonValue,
      manifest: manifest as unknown as Prisma.InputJsonValue, rowCount: written.rows, filePath: path.relative(options.rootDir, path.join(directory, 'dataset.csv')).replace(/\\/g, '/'), fileHash: written.fileHash, createdBy: options.actor,
    } });
    reserved = null;
    report('DONE');
    return { version, rows: written.rows, directory, fileHash: written.fileHash, manifest };
  } finally {
    // Own directories only: the version directory reserved by this call (never registered) and this call's work dir.
    if (reserved) rmSync(path.join(datasetsRoot, reserved), { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  }
}

/**
 * Work directories of builds that can no longer finish (their job is not running any more): removed. Directories
 * without a job marker (CLI builds) are left alone - their owner cannot be proven here.
 */
export async function removeStaleBuildDirs(prisma: PrismaClient, rootDir: string, roots = [AUTONOMOUS_DATASETS_DIR, AUTONOMOUS_MODELS_DIR]) {
  const removed: string[] = [];
  for (const root of roots) {
    const base = path.join(rootDir, root);
    if (!existsSync(base)) continue;
    for (const name of readdirSync(base)) {
      if (!name.startsWith(BUILD_DIR_PREFIX) && !name.startsWith(WORK_DIR_PREFIX)) continue;
      const dir = path.join(base, name);
      let owner: { jobId?: string | null } = {};
      try {
        owner = JSON.parse(readFileSync(path.join(dir, 'owner.json'), 'utf8')) as { jobId?: string | null };
      } catch {
        continue;
      }
      if (!owner.jobId) continue;
      const job = await prisma.mlTrainingJob.findUnique({ where: { id: owner.jobId }, select: { status: true } });
      if (job && !['COMPLETED', 'FAILED', 'CANCELLED'].includes(job.status)) continue;
      rmSync(dir, { recursive: true, force: true });
      removed.push(path.join(root, name).replace(/\\/g, '/'));
    }
  }
  return removed;
}

export interface TrainerResult { exitCode: number | null; status: string; failures: string[]; dir: string | null; bundleVersion: string | null; readiness: string | null; cancelled: boolean; timedOut: boolean; stderrTail: string }

export interface TrainerOptions {
  python: string;
  rootDir: string;
  datasetDir: string;
  seed?: number;
  timeoutMs: number;
  /** Real stage events from the trainer (ENTRY_MODELS, EXIT_MODELS, POSITION_SIZING, VALIDATION, SAVING). */
  onStage?: (stage: string, details: Record<string, unknown>) => void;
  signal?: globalThis.AbortSignal;
  /** Linux: run with `nice -n <level>` (lower CPU priority than the trading worker). */
  niceLevel?: number;
  threads?: number;
  allowSmall?: boolean;
  spawnFn?: typeof spawn;
  /** Owner marker of the temporary work directory (training job id). */
  jobId?: string;
}

/** Runs the Python trainer; never throws for trainer failures (the result carries them). */
export function runAutonomousTrainer(options: TrainerOptions): Promise<TrainerResult> {
  const modelsRoot = path.join(options.rootDir, AUTONOMOUS_MODELS_DIR);
  mkdirSync(modelsRoot, { recursive: true });
  // Own work directory for the trainer's memory-mapped matrices (disk instead of RAM); removed after the child exits.
  const workDir = mkdtempSync(path.join(modelsRoot, WORK_DIR_PREFIX));
  writeFileSync(path.join(workDir, 'owner.json'), `${JSON.stringify({ jobId: options.jobId ?? null, pid: process.pid, host: hostname(), startedAt: new Date().toISOString() })}\n`);
  const args = ['-m', 'soltrader_ml.autonomous', '--dataset', options.datasetDir, '--out', modelsRoot, '--work-dir', workDir, '--seed', String(options.seed ?? 42), ...(options.allowSmall ? ['--allow-small'] : [])];
  const useNice = process.platform !== 'win32' && options.niceLevel !== undefined && existsSync('/usr/bin/nice');
  const command = useNice ? '/usr/bin/nice' : options.python;
  const commandArgs = useNice ? ['-n', String(options.niceLevel), options.python, ...args] : args;
  const threads = String(options.threads ?? 1);
  return new Promise((resolve) => {
    const child = (options.spawnFn ?? spawn)(command, commandArgs, {
      cwd: path.join(options.rootDir, 'ml'),
      // Only what the trainer needs: no database URL, keys or other secrets are passed to the child.
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', SYSTEMROOT: process.env.SYSTEMROOT ?? '', OMP_NUM_THREADS: threads, OPENBLAS_NUM_THREADS: threads, MKL_NUM_THREADS: threads, PYTHONUNBUFFERED: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let buffer = '';
    let last: Record<string, unknown> = {};
    let stderr = '';
    let cancelled = false;
    let timedOut = false;
    const stop = () => child.kill('SIGKILL');
    const timer = globalThis.setTimeout(() => {
      timedOut = true;
      stop();
    }, options.timeoutMs);
    const onAbort = () => {
      cancelled = true;
      stop();
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('{')) continue;
        try {
          const parsed = JSON.parse(trimmed) as Record<string, unknown>;
          if (parsed.event === 'STAGE' && typeof parsed.stage === 'string') options.onStage?.(parsed.stage, parsed);
          else last = parsed;
        } catch {
          // not a JSON line
        }
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-4_000);
    });
    const finish = (exitCode: number | null) => {
      globalThis.clearTimeout(timer);
      rmSync(workDir, { recursive: true, force: true });
      options.signal?.removeEventListener('abort', onAbort);
      if (buffer.trim().startsWith('{')) {
        try {
          const parsed = JSON.parse(buffer.trim()) as Record<string, unknown>;
          if (parsed.event !== 'STAGE') last = parsed;
        } catch {
          // ignore
        }
      }
      resolve({
        exitCode, status: cancelled ? 'CANCELLED' : timedOut ? 'TIMEOUT' : typeof last.status === 'string' ? last.status : exitCode === 0 ? 'UNKNOWN' : 'FAILED',
        failures: Array.isArray(last.failures) ? last.failures.map(String) : [], dir: typeof last.dir === 'string' ? last.dir : null,
        bundleVersion: typeof last.bundleVersion === 'string' ? last.bundleVersion : null, readiness: typeof last.readiness === 'string' ? last.readiness : null,
        cancelled, timedOut, stderrTail: stderr.replace(/[A-Za-z0-9+/=_-]{32,}/g, '[redacted]').slice(-1_500),
      });
    };
    child.on('error', (error) => {
      stderr += `\n${error.message}`;
      finish(null);
    });
    child.on('close', (code) => finish(code));
  });
}

/** Verifies the written bundle (sha256 == metadata) and registers it as a new TRAINED, unapproved, unselected row. */
export async function registerTrainerOutput(prisma: PrismaClient, options: { rootDir: string; dir: string; datasetVersion: string; actor: string }) {
  const metadata = JSON.parse(readFileSync(path.join(options.dir, 'metadata.json'), 'utf8')) as { bundleVersion: string; readiness: string; featureVersion: string; labelVersion: string; policy: unknown; metrics: unknown; trainedAt: string; artifactHash: string };
  const artifactHash = sha256(readFileSync(path.join(options.dir, 'bundle.json')));
  if (artifactHash !== metadata.artifactHash) throw new Error(`Bundle hash mismatch for ${metadata.bundleVersion}`);
  const artifactPath = path.relative(options.rootDir, path.join(options.dir, 'bundle.json')).replace(/\\/g, '/');
  await registerAutonomousBundle(prisma, { version: metadata.bundleVersion, readiness: metadata.readiness, featureVersion: metadata.featureVersion, labelVersion: metadata.labelVersion, datasetVersion: options.datasetVersion, artifactPath, artifactHash, policy: metadata.policy, metrics: metadata.metrics, trainedAt: metadata.trainedAt, actor: options.actor });
  return { bundleVersion: metadata.bundleVersion, readiness: metadata.readiness, artifactHash };
}

export function defaultPython(rootDir: string) {
  return process.env.ML_PYTHON?.trim() || (process.platform === 'win32' ? path.join(rootDir, 'ml', '.venv', 'Scripts', 'python.exe') : path.join(rootDir, 'ml', '.venv', 'bin', 'python'));
}
