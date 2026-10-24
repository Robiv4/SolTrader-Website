/* eslint-disable @typescript-eslint/no-explicit-any -- injected pipeline fakes */
/**
 * Web training jobs (ml-trainer) against the LOCAL development database (own job kind + throw-away rows, removed
 * afterwards; never production):
 *  - success -> COMPLETED with a registered TRAINED bundle; the active model of a user is unchanged;
 *  - not enough data -> FAILED before training (clear message), trainer never started;
 *  - trainer failure -> FAILED, nothing registered; cancel -> CANCELLED, the child process is stopped;
 *  - restart during training -> FAILED (INTERRUPTED), never COMPLETED;
 *  - END TO END with the real Python trainer on a SYNTHETIC dataset: real bundle, checksum, registry row.
 */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PrismaClient } from '@prisma/client';
import { validateBundle } from '@soltrader/strategy-engine';
import { afterAll, describe, expect, it } from 'vitest';

import { TrainingJobRunner } from '../src/training/job-runner.js';
import { defaultPython } from '../src/training/pipeline.js';

const prisma = new PrismaClient();
const run = randomUUID().slice(0, 8);
const KIND = `TEST-${run}`;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const logger = { info: () => undefined, warn: () => undefined };
const createdBundles: string[] = [];
const createdDatasets: string[] = [];
const cleanupDirs: string[] = [];
const createdUsers: string[] = [];

const dataset = (rows: { entry: number; position: number }, version = `AUTO-DATASET-T${run}`) => async () => ({
  version, rows: rows.entry + rows.position, directory: path.join(repoRoot, 'ml', 'autonomous-datasets', '__none'), fileHash: 'x',
  manifest: { coverage: { entry: { total: rows.entry }, position: { total: rows.position }, excluded: { DATA_GAP: 3 } } },
});

const runner = (extra: Partial<ConstructorParameters<typeof TrainingJobRunner>[0]> = {}) => new TrainingJobRunner({ prisma, logger, rootDir: repoRoot, python: 'python', owner: `test-${run}`, timeoutMs: 60_000, heartbeatMs: 50, kind: KIND, ...extra });
const job = (data: Record<string, unknown> = {}) => prisma.mlTrainingJob.create({ data: { kind: KIND, requestedBy: 'test@soltrader.local', ...data } });

afterAll(async () => {
  await prisma.mlTrainingJob.deleteMany({ where: { kind: KIND } });
  await prisma.mlAutonomousModelBundle.deleteMany({ where: { version: { in: createdBundles } } });
  await prisma.mlDatasetVersion.deleteMany({ where: { version: { in: createdDatasets } } });
  for (const userId of createdUsers) {
    await prisma.mlPaperSettings.deleteMany({ where: { userId } });
    await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
  }
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
  await prisma.$disconnect();
});

describe('training job runner', () => {
  it('success: COMPLETED with the registered bundle; every real stage is logged; the active model of a user is unchanged', async () => {
    const user = await prisma.user.create({ data: { email: `train-${run}@soltrader.test` } });
    createdUsers.push(user.id);
    await prisma.mlPaperSettings.create({ data: { userId: user.id, strategyMode: 'ML_AUTONOMOUS', autonomousBundleVersion: 'ML-AUTO-ACTIVE-s42' } });
    const created = await job();
    const stagesSeen: string[] = [];
    const result = await runner({
      buildDataset: dataset({ entry: 900, position: 3_000 }),
      runTrainer: async (options) => {
        for (const stage of ['ENTRY_MODELS', 'EXIT_MODELS', 'POSITION_SIZING', 'VALIDATION', 'SAVING']) {
          options.onStage?.(stage, {});
          stagesSeen.push(stage);
          await new Promise((resolve) => globalThis.setTimeout(resolve, 20));
        }
        return { exitCode: 0, status: 'TRAINED', failures: [], dir: '/tmp/x', bundleVersion: `ML-AUTO-T${run}-s42`, readiness: 'RESEARCH_ONLY', cancelled: false, timedOut: false, stderrTail: '' };
      },
      register: async () => ({ bundleVersion: `ML-AUTO-T${run}-s42`, readiness: 'RESEARCH_ONLY', artifactHash: 'h' }),
    }).poll();
    void result;
    const done = await prisma.mlTrainingJob.findUniqueOrThrow({ where: { id: created.id } });
    expect(done).toMatchObject({ status: 'COMPLETED', bundleVersion: `ML-AUTO-T${run}-s42`, readiness: 'RESEARCH_ONLY', activeKey: null, error: null });
    expect(done.finishedAt).not.toBeNull();
    const logged = (done.log as any[]).map((entry) => entry.stage);
    for (const stage of ['PREPARING_DATASET', ...stagesSeen, 'REGISTERING', 'COMPLETED']) expect(logged).toContain(stage);
    expect(await prisma.mlPaperSettings.findUniqueOrThrow({ where: { userId: user.id } })).toMatchObject({ strategyMode: 'ML_AUTONOMOUS', autonomousBundleVersion: 'ML-AUTO-ACTIVE-s42' });
  });

  it('not enough training data: FAILED with a clear message before training; the trainer is never started', async () => {
    const created = await job();
    let trainerCalls = 0;
    await runner({ buildDataset: dataset({ entry: 12, position: 40 }), runTrainer: async () => { trainerCalls += 1; throw new Error('must not run'); } }).poll();
    const done = await prisma.mlTrainingJob.findUniqueOrThrow({ where: { id: created.id } });
    expect(done.status).toBe('FAILED');
    expect(done.error).toContain('NINCS ELÉG TANÍTÓADAT');
    expect(done.error).toContain('12/300');
    expect(trainerCalls).toBe(0);
  });

  it('trainer failure: FAILED with the reason, nothing registered', async () => {
    const created = await job();
    let registered = 0;
    await runner({
      buildDataset: dataset({ entry: 900, position: 900 }),
      runTrainer: async () => ({ exitCode: 5, status: 'EXPORT_PARITY_FAILED', failures: ['max diff 0.1'], dir: null, bundleVersion: null, readiness: null, cancelled: false, timedOut: false, stderrTail: '' }),
      register: async () => { registered += 1; return { bundleVersion: 'x', readiness: 'x', artifactHash: 'x' }; },
    }).poll();
    const done = await prisma.mlTrainingJob.findUniqueOrThrow({ where: { id: created.id } });
    expect(done).toMatchObject({ status: 'FAILED', bundleVersion: null });
    expect(done.error).toContain('EXPORT_PARITY_FAILED');
    expect(registered).toBe(0);
  });

  it('cancel during training: the trainer receives the abort, the job ends CANCELLED', async () => {
    const created = await job();
    let aborted = false;
    await runner({
      buildDataset: dataset({ entry: 900, position: 900 }),
      runTrainer: async (options) => {
        await prisma.mlTrainingJob.update({ where: { id: created.id }, data: { cancelRequested: true } });
        await new Promise<void>((resolve) => {
          if (options.signal?.aborted) resolve();
          options.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        aborted = true;
        return { exitCode: null, status: 'CANCELLED', failures: [], dir: null, bundleVersion: null, readiness: null, cancelled: true, timedOut: false, stderrTail: '' };
      },
    }).poll();
    expect(aborted).toBe(true);
    expect((await prisma.mlTrainingJob.findUniqueOrThrow({ where: { id: created.id } })).status).toBe('CANCELLED');
  });

  it('worker restart during training: the interrupted job becomes FAILED (INTERRUPTED), never COMPLETED', async () => {
    const created = await job({ status: 'TRAINING', stage: 'ENTRY_MODELS', leaseOwner: 'old-trainer', startedAt: new Date(), heartbeatAt: new Date(), log: [{ at: new Date().toISOString(), stage: 'ENTRY_MODELS', message: 'x' }] });
    await runner().recover(true);
    const done = await prisma.mlTrainingJob.findUniqueOrThrow({ where: { id: created.id } });
    expect(done).toMatchObject({ status: 'FAILED', error: 'INTERRUPTED', activeKey: null, bundleVersion: null });
    // A later stale heartbeat (another trainer died) is also recovered by the periodic check.
    const stale = await job({ status: 'VALIDATING', leaseOwner: 'old', startedAt: new Date(), heartbeatAt: new Date(Date.now() - 10 * 60_000) });
    await runner().recover(false);
    expect((await prisma.mlTrainingJob.findUniqueOrThrow({ where: { id: stale.id } })).status).toBe('FAILED');
  });

  it('long dataset preparation keeps the lease: another trainer\'s recovery never marks it INTERRUPTED', async () => {
    const created = await job();
    const leaseMs = 1_500;
    let recoveredDuringBuild = 0;
    await runner({
      leaseMs, heartbeatMs: 50,
      buildDataset: async (_client, options) => {
        // 4.8 s of work in small steps (3x the lease), like a long paged build; progress is reported meanwhile.
        for (let step = 0; step < 12; step += 1) {
          await new Promise((resolve) => globalThis.setTimeout(resolve, 400));
          options.onProgress?.({ phase: 'REPLAY', replay: { processed: step, total: 12 }, live: { processed: 0, total: 0 }, rows: { entry: step, position: step * 12, replay: step * 13, live: 0 }, excluded: 0, csv: { rowsWritten: 0, bytes: 0, chunks: 0 }, heapUsedMb: 50 });
          await runner({ owner: 'other-trainer', leaseMs }).recover(false);
          if ((await prisma.mlTrainingJob.findUniqueOrThrow({ where: { id: created.id } })).status !== 'PREPARING_DATASET') recoveredDuringBuild += 1;
        }
        return dataset({ entry: 900, position: 900 })();
      },
      runTrainer: async () => ({ exitCode: 0, status: 'TRAINED', failures: [], dir: '/x', bundleVersion: 'B', readiness: 'INSUFFICIENT_DATA', cancelled: false, timedOut: false, stderrTail: '' }),
      register: async () => ({ bundleVersion: `ML-AUTO-LEASE-${run}`, readiness: 'INSUFFICIENT_DATA', artifactHash: 'x' }),
    }).poll();
    expect(recoveredDuringBuild).toBe(0);
    expect((await prisma.mlTrainingJob.findUniqueOrThrow({ where: { id: created.id } })).status).toBe('COMPLETED');
  });

  const python = defaultPython(repoRoot);
  it.skipIf(!existsSync(python))('END TO END: real Python trainer on a SYNTHETIC dataset -> real bundle, verified checksum, TRAINED registry row', async () => {
    const version = `AUTO-E2E-${run}`;
    const datasetDir = path.join(repoRoot, 'ml', 'autonomous-datasets', `__e2e-${run}`);
    cleanupDirs.push(datasetDir, path.join(repoRoot, 'ml', 'autonomous-models', `ML-AUTO-${version}-s42`));
    const generated = spawnSync(python, ['-c', `from pathlib import Path; from soltrader_ml.synthetic import make_autonomous_dataset; make_autonomous_dataset(Path(r'${datasetDir}'), rows=2400, seed=11, version='${version}')`], { cwd: path.join(repoRoot, 'ml'), encoding: 'utf8' });
    expect(generated.status, generated.stderr).toBe(0);
    const manifest = JSON.parse(readFileSync(path.join(datasetDir, 'manifest.json'), 'utf8'));
    const created = await job();
    await runner({
      python, timeoutMs: 10 * 60_000, heartbeatMs: 1_000,
      buildDataset: async () => ({ version, rows: 2400, directory: datasetDir, fileHash: 'synthetic', manifest: { ...manifest, coverage: { entry: { total: 1200 }, position: { total: 1200 } } } }),
    }).poll();
    const done = await prisma.mlTrainingJob.findUniqueOrThrow({ where: { id: created.id } });
    expect(done.error).toBeNull();
    expect(done.status).toBe('COMPLETED');
    createdBundles.push(done.bundleVersion!);
    const bundle = await prisma.mlAutonomousModelBundle.findUniqueOrThrow({ where: { version: done.bundleVersion! } });
    expect(bundle).toMatchObject({ status: 'TRAINED', paperApproved: false, featureVersion: 'ML-FEATURES-AUTONOMOUS-v1' });
    const content = readFileSync(path.join(repoRoot, bundle.artifactPath));
    expect((await import('node:crypto')).createHash('sha256').update(content).digest('hex')).toBe(bundle.artifactHash);
    expect(() => validateBundle(JSON.parse(content.toString('utf8')))).not.toThrow();
    const stages = (done.log as any[]).map((entry) => entry.stage);
    for (const stage of ['ENTRY_MODELS', 'EXIT_MODELS', 'POSITION_SIZING', 'VALIDATION', 'SAVING', 'REGISTERING', 'COMPLETED']) expect(stages).toContain(stage);
  }, 600_000);
});
