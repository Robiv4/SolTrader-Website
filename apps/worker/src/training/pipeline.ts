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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { Prisma, type PrismaClient } from '@prisma/client';
import { AUTONOMOUS_LABEL_VERSION, buildAutonomousDataset, labelEntry, labelPosition, ML_AUTONOMOUS_FEATURE_VERSION } from '@soltrader/strategy-engine';

import { loadLiveSources, loadReplaySources } from '../autonomous/dataset-source.js';
import { registerAutonomousBundle } from '../ml/model-registration.js';

export const sha256 = (content: string | Buffer) => createHash('sha256').update(content).digest('hex');

export interface DatasetBuildResult { version: string; rows: number; directory: string; fileHash: string; manifest: Record<string, unknown> }

export async function buildAutonomousDatasetVersion(prisma: PrismaClient, options: { rootDir: string; actor: string; version?: string; now?: number }): Promise<DatasetBuildResult> {
  const now = options.now ?? Date.now();
  const { sources, paths } = await loadReplaySources(prisma);
  const live = await loadLiveSources(prisma, paths, now);
  const existing = await prisma.mlDatasetVersion.count({ where: { featureVersion: ML_AUTONOMOUS_FEATURE_VERSION } });
  let version = options.version ?? `AUTO-DATASET-v${existing + 1}`;
  // Immutable: never reuse a version (a previous, unregistered directory is skipped, not overwritten).
  for (let next = existing + 2; !options.version && (existsSync(path.join(options.rootDir, 'ml', 'autonomous-datasets', version)) || await prisma.mlDatasetVersion.findUnique({ where: { version } })); next += 1) version = `AUTO-DATASET-v${next}`;
  const directory = path.join(options.rootDir, 'ml', 'autonomous-datasets', version);
  if (existsSync(directory)) throw new Error(`Dataset ${version} already exists (immutable)`);
  const built = buildAutonomousDataset({ version, replay: sources, live });
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, 'dataset.csv'), built.csv);
  const fileHash = sha256(built.csv);
  const manifest = { ...built.manifest, createdAt: new Date(now).toISOString(), fileHash, sources: { replay: sources.length, live: live.length } };
  writeFileSync(path.join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const outcomes = live.map((row) => {
    const label = row.kind === 'ENTRY' ? labelEntry(row.path, row.at) : row.position ? labelPosition(row.path, row.at, row.position) : null;
    return { snapshotId: row.id, labelVersion: AUTONOMOUS_LABEL_VERSION, status: label?.status ?? 'EXCLUDED', labels: (label ?? {}) as Prisma.InputJsonValue, uncertainty: { horizonResolutionMs: label?.horizonResolutionMs ?? null, liquidityAssumed: label?.liquidityAssumed ?? null } as Prisma.InputJsonValue, exclusionReason: label ? label.exclusion : 'POSITION_STATE_MISSING', labelEndAt: new Date(label?.labelEndAt ?? row.at) };
  });
  for (let index = 0; index < outcomes.length; index += 1_000) await prisma.mlAutonomousOutcome.createMany({ data: outcomes.slice(index, index + 1_000), skipDuplicates: true });
  await prisma.mlDatasetVersion.create({ data: {
    version, featureVersion: ML_AUTONOMOUS_FEATURE_VERSION, labelVersion: AUTONOMOUS_LABEL_VERSION, target: 'AUTONOMOUS_NET_PNL', config: { version, kinds: ['ENTRY', 'POSITION'] } as Prisma.InputJsonValue,
    manifest: manifest as unknown as Prisma.InputJsonValue, rowCount: built.rows.length, filePath: path.relative(options.rootDir, path.join(directory, 'dataset.csv')).replace(/\\/g, '/'), fileHash, createdBy: options.actor,
  } });
  return { version, rows: built.rows.length, directory, fileHash, manifest };
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
}

/** Runs the Python trainer; never throws for trainer failures (the result carries them). */
export function runAutonomousTrainer(options: TrainerOptions): Promise<TrainerResult> {
  const args = ['-m', 'soltrader_ml.autonomous', '--dataset', options.datasetDir, '--out', path.join(options.rootDir, 'ml', 'autonomous-models'), '--seed', String(options.seed ?? 42), ...(options.allowSmall ? ['--allow-small'] : [])];
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
