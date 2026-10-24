/**
 * Web training jobs (MlTrainingJob) executed by the separate ml-trainer process - never by the trading worker, never
 * inside an HTTP request, and never with any trading side effect (no account / position / selection / approval).
 *
 * States: QUEUED -> PREPARING_DATASET -> TRAINING -> VALIDATING -> SAVING -> COMPLETED, or FAILED / CANCELLED.
 *  - one active job at a time (MlTrainingJob.activeKey is unique while the job is not finished);
 *  - a job is claimed with a conditional update (QUEUED -> PREPARING_DATASET); a heartbeat keeps the lease;
 *  - after a restart every job that was running is marked FAILED (INTERRUPTED) - never COMPLETED;
 *  - cancel: the flag is read on every heartbeat; the Python child process is killed;
 *  - the stage shown is the real pipeline stage (no invented percentage or remaining time); while the dataset is being
 *    prepared the measured counts (snapshots read, rows, CSV bytes, heap) are stored in result.progress;
 *  - the dataset build is streamed (bounded memory) and yields to the event loop on every page, so the heartbeat
 *    keeps the lease during long builds; a cancel aborts the build (nothing is registered, own temp dirs removed).
 */
import type { Prisma, PrismaClient } from '@prisma/client';

import { buildAutonomousDatasetVersion, registerTrainerOutput, removeStaleBuildDirs, runAutonomousTrainer, sha256File, type DatasetBuildOptions, type DatasetBuildResult, type DatasetProgress, type TrainerResult } from './pipeline.js';

export const TRAINING_RUNNING_STATUSES = ['PREPARING_DATASET', 'TRAINING', 'VALIDATING', 'SAVING'] as const;
export const TRAINING_ACTIVE_STATUSES = ['QUEUED', ...TRAINING_RUNNING_STATUSES] as const;
export const TRAINING_TERMINAL_STATUSES = ['COMPLETED', 'FAILED', 'CANCELLED'] as const;
/** Same gate as the Python trainer (MIN_ROWS_PER_KIND): fewer rows -> the job fails before training. */
export const MIN_TRAINING_ROWS_PER_KIND = 300;
const MAX_LOG_ENTRIES = 200;
/** Progress rows are written at most this often (plus on every phase change). */
const PROGRESS_WRITE_MS = 5_000;
const PHASE_TEXT: Record<DatasetProgress['phase'], string> = {
  COUNTING: 'Források számlálása', REPLAY: 'REPLAY sorok előállítása (outcome-pályák)', LIVE: 'LIVE sorok előállítása (döntési snapshotok)', WRITING_CSV: 'CSV írása (rendezett összefésülés)',
  MANIFEST: 'Manifest és checksum készítése', REGISTERING: 'Dataset regisztrálása', DONE: 'Dataset kész',
};

type Job = Awaited<ReturnType<PrismaClient['mlTrainingJob']['findUniqueOrThrow']>>;

export interface JobRunnerDeps {
  prisma: PrismaClient;
  logger: { info(payload: unknown, message?: string): void; warn(payload: unknown, message?: string): void };
  rootDir: string;
  python: string;
  owner: string;
  timeoutMs: number;
  leaseMs?: number;
  heartbeatMs?: number;
  niceLevel?: number;
  threads?: number;
  allowSmall?: boolean;
  /** Job kind this runner executes (default AUTONOMOUS; tests use their own kind for isolation). */
  kind?: string;
  now?: () => number;
  /** Test hooks (default: the real pipeline). */
  buildDataset?: (prisma: PrismaClient, options: DatasetBuildOptions) => Promise<DatasetBuildResult>;
  runTrainer?: (options: Parameters<typeof runAutonomousTrainer>[0]) => Promise<TrainerResult>;
  register?: (prisma: PrismaClient, options: { rootDir: string; dir: string; datasetVersion: string; actor: string }) => Promise<{ bundleVersion: string; readiness: string; artifactHash: string }>;
}

const STAGE_TEXT: Record<string, string> = {
  PREPARING_DATASET: 'Dataset előkészítése', ENTRY_MODELS: 'Belépési (entry) modellek tanítása', EXIT_MODELS: 'Kilépési (exit) modellek tanítása',
  POSITION_SIZING: 'Pozícióméretezés beállítása (szabály a modellkimenetekből, nem külön tanult modell)', VALIDATION: 'Validáció (export-paritás, backtest, stressztesztek, alkalmasság)',
  SAVING: 'Modellcsomag mentése', REGISTERING: 'Checksum ellenőrzése és regisztrálás', LOADING_DATASET: 'Tanítóadat betöltése (darabokban, lemezre leképezett mátrixokkal)',
};

export class TrainingJobRunner {
  private busy = false;
  private timer: ReturnType<typeof globalThis.setInterval> | null = null;
  private current: { id: string; abort: globalThis.AbortController } | null = null;
  /** Log / stage writes are serialized (read-modify-write of the JSON log must never lose an entry). */
  private writes: Promise<unknown> = Promise.resolve();
  private lastProgress: DatasetProgress | null = null;
  readonly metrics = { claimed: 0, completed: 0, failed: 0, cancelled: 0, interrupted: 0, lastPollAt: null as number | null };

  constructor(private readonly deps: JobRunnerDeps) {}

  private now() {
    return this.deps.now?.() ?? Date.now();
  }

  start(intervalMs = 5_000) {
    void this.recover(true).then(() => this.cleanup()).then(() => this.poll());
    this.timer = globalThis.setInterval(() => void this.poll(), intervalMs);
  }

  /** Graceful stop: a running job is interrupted (FAILED), never left looking COMPLETED. */
  async stop() {
    if (this.timer) globalThis.clearInterval(this.timer);
    if (this.current) {
      this.current.abort.abort();
      await this.finish(this.current.id, 'FAILED', { error: 'INTERRUPTED: a tanító szolgáltatás leállt a tanítás közben' }).catch(() => undefined);
    }
  }

  private appendLog(id: string, stage: string, message: string, data: Partial<Prisma.MlTrainingJobUpdateInput> = {}) {
    const next = this.writes.then(() => this.writeLog(id, stage, message, data));
    this.writes = next.catch(() => undefined);
    return next;
  }

  private async writeLog(id: string, stage: string, message: string, data: Partial<Prisma.MlTrainingJobUpdateInput>) {
    const job = await this.deps.prisma.mlTrainingJob.findUnique({ where: { id }, select: { log: true } });
    const log = [...(Array.isArray(job?.log) ? job!.log as unknown[] : []), { at: new Date(this.now()).toISOString(), stage, message: message.slice(0, 500) }].slice(-MAX_LOG_ENTRIES);
    await this.deps.prisma.mlTrainingJob.updateMany({ where: { id, leaseOwner: this.deps.owner }, data: { ...data, log: log as Prisma.InputJsonValue, heartbeatAt: new Date(this.now()) } as Prisma.MlTrainingJobUpdateManyMutationInput });
  }

  private async finish(id: string, status: 'COMPLETED' | 'FAILED' | 'CANCELLED', data: { error?: string; bundleVersion?: string; readiness?: string; result?: unknown } = {}) {
    await this.writes;
    await this.appendLog(id, status, status === 'COMPLETED' ? `Kész: ${data.bundleVersion} (${data.readiness})` : data.error ?? status);
    await this.deps.prisma.mlTrainingJob.updateMany({
      where: { id, leaseOwner: this.deps.owner, status: { in: [...TRAINING_ACTIVE_STATUSES] } },
      data: { status, activeKey: null, finishedAt: new Date(this.now()), error: data.error ?? null, bundleVersion: data.bundleVersion ?? undefined, readiness: data.readiness ?? undefined, result: data.result === undefined ? undefined : data.result as Prisma.InputJsonValue },
    });
    if (status === 'COMPLETED') this.metrics.completed += 1;
    else if (status === 'CANCELLED') this.metrics.cancelled += 1;
    else this.metrics.failed += 1;
  }

  /** Temporary work directories of jobs that can no longer finish (only directories carrying such a job's marker). */
  async cleanup() {
    const removed = await removeStaleBuildDirs(this.deps.prisma, this.deps.rootDir).catch(() => []);
    if (removed.length) this.deps.logger.info({ removed }, 'Removed temporary training work directories of finished jobs');
    return removed;
  }

  /**
   * Jobs that were running when a trainer stopped: at startup every running job (single trainer); later any job whose
   * heartbeat is older than the lease. They become FAILED (INTERRUPTED) - the partial output is never registered.
   */
  async recover(startup = false) {
    const lease = this.deps.leaseMs ?? 120_000;
    const stale = await this.deps.prisma.mlTrainingJob.findMany({
      where: { kind: this.deps.kind ?? 'AUTONOMOUS', status: { in: [...TRAINING_RUNNING_STATUSES] }, ...(startup ? {} : { OR: [{ heartbeatAt: null }, { heartbeatAt: { lt: new Date(this.now() - lease) } }] }) },
    });
    for (const job of stale) {
      if (this.current?.id === job.id) continue;
      const log = [...(Array.isArray(job.log) ? job.log as unknown[] : []), { at: new Date(this.now()).toISOString(), stage: 'FAILED', message: 'Megszakadt tanítás (a tanító szolgáltatás újraindult vagy nem válaszolt); a részleges eredmény nincs regisztrálva.' }].slice(-MAX_LOG_ENTRIES);
      const updated = await this.deps.prisma.mlTrainingJob.updateMany({ where: { id: job.id, status: job.status }, data: { status: 'FAILED', activeKey: null, finishedAt: new Date(this.now()), error: 'INTERRUPTED', log: log as Prisma.InputJsonValue } });
      if (updated.count) this.metrics.interrupted += 1;
    }
  }

  async poll() {
    if (this.busy) return;
    this.busy = true;
    this.metrics.lastPollAt = this.now();
    try {
      await this.recover(false);
      const next = await this.deps.prisma.mlTrainingJob.findFirst({ where: { status: 'QUEUED', kind: this.deps.kind ?? 'AUTONOMOUS' }, orderBy: { requestedAt: 'asc' } });
      if (!next) return;
      if (next.cancelRequested) {
        await this.deps.prisma.mlTrainingJob.updateMany({ where: { id: next.id, status: 'QUEUED' }, data: { status: 'CANCELLED', activeKey: null, finishedAt: new Date(this.now()) } });
        return;
      }
      const claimed = await this.deps.prisma.mlTrainingJob.updateMany({ where: { id: next.id, status: 'QUEUED' }, data: { status: 'PREPARING_DATASET', stage: 'PREPARING_DATASET', startedAt: new Date(this.now()), heartbeatAt: new Date(this.now()), leaseOwner: this.deps.owner } });
      if (claimed.count !== 1) return;
      this.metrics.claimed += 1;
      await this.run(await this.deps.prisma.mlTrainingJob.findUniqueOrThrow({ where: { id: next.id } }));
    } catch (error) {
      this.deps.logger.warn({ err: error instanceof Error ? error.message.slice(0, 200) : String(error) }, 'Training job poll failed');
    } finally {
      this.busy = false;
    }
  }

  private async run(job: Job) {
    const abort = new globalThis.AbortController();
    this.current = { id: job.id, abort };
    const heartbeat = globalThis.setInterval(() => {
      void this.deps.prisma.mlTrainingJob.findUnique({ where: { id: job.id }, select: { cancelRequested: true } }).then(async (row) => {
        if (row?.cancelRequested) abort.abort();
        await this.deps.prisma.mlTrainingJob.updateMany({ where: { id: job.id, leaseOwner: this.deps.owner }, data: { heartbeatAt: new Date(this.now()) } });
      }).catch(() => undefined);
    }, this.deps.heartbeatMs ?? 15_000);
    const actor = `web:${job.requestedBy}`;
    try {
      await this.appendLog(job.id, 'PREPARING_DATASET', STAGE_TEXT.PREPARING_DATASET);
      const dataset = await this.prepareDataset(job, actor, abort.signal);
      const coverage = (dataset.manifest.coverage ?? {}) as { entry?: { total?: number }; position?: { total?: number }; excluded?: Record<string, number> };
      const entryRows = coverage.entry?.total ?? 0;
      const positionRows = coverage.position?.total ?? 0;
      await this.appendLog(job.id, 'PREPARING_DATASET', `Dataset ${dataset.version}: ${dataset.rows} sor (belépés ${entryRows}, pozíció ${positionRows})`, { datasetVersion: dataset.version, result: { dataset: dataset.version, rows: dataset.rows, entryRows, positionRows, excluded: coverage.excluded ?? {}, progress: this.lastProgress } as unknown as Prisma.InputJsonValue });
      if (await this.cancelled(job.id, abort)) return this.finish(job.id, 'CANCELLED', { error: 'Megszakítva a felhasználó kérésére' });
      if (!this.deps.allowSmall && (entryRows < MIN_TRAINING_ROWS_PER_KIND || positionRows < MIN_TRAINING_ROWS_PER_KIND)) {
        return this.finish(job.id, 'FAILED', { error: `NINCS ELÉG TANÍTÓADAT: belépési minta ${entryRows}/${MIN_TRAINING_ROWS_PER_KIND}, pozíció minta ${positionRows}/${MIN_TRAINING_ROWS_PER_KIND}`, result: { dataset: dataset.version, entryRows, positionRows, excluded: coverage.excluded ?? {} } });
      }
      await this.deps.prisma.mlTrainingJob.updateMany({ where: { id: job.id, leaseOwner: this.deps.owner }, data: { status: 'TRAINING', stage: 'TRAINING' } });
      const trainer = await (this.deps.runTrainer ?? runAutonomousTrainer)({
        python: this.deps.python, rootDir: this.deps.rootDir, datasetDir: dataset.directory, timeoutMs: this.deps.timeoutMs, signal: abort.signal, jobId: job.id, niceLevel: this.deps.niceLevel, threads: this.deps.threads, allowSmall: this.deps.allowSmall,
        onStage: (stage) => {
          const status = stage === 'VALIDATION' ? 'VALIDATING' : stage === 'SAVING' ? 'SAVING' : 'TRAINING';
          void this.appendLog(job.id, stage, STAGE_TEXT[stage] ?? stage, { status, stage }).catch(() => undefined);
        },
      });
      if (trainer.cancelled) return this.finish(job.id, 'CANCELLED', { error: 'Megszakítva a felhasználó kérésére (a tanító folyamat leállítva)' });
      if (trainer.timedOut) return this.finish(job.id, 'FAILED', { error: `IDŐTÚLLÉPÉS: a tanítás ${Math.round(this.deps.timeoutMs / 60_000)} perc alatt nem fejeződött be` });
      if (trainer.status !== 'TRAINED' || !trainer.dir) {
        const reason = trainer.status === 'DATA_QUALITY_GATE_FAILED' ? `NINCS ELÉG TANÍTÓADAT: ${trainer.failures.join('; ')}` : trainer.status === 'MODEL_VERSION_EXISTS' ? `A MODELLVERZIÓ MÁR LÉTEZIK: ${trainer.failures.join('; ')}` : `TANÍTÁSI HIBA (${trainer.status}, kilépési kód ${trainer.exitCode ?? '—'}): ${trainer.failures.join('; ') || trainer.stderrTail.split('\n').filter(Boolean).slice(-3).join(' | ')}`;
        return this.finish(job.id, 'FAILED', { error: reason.slice(0, 1_000) });
      }
      await this.writes;
      await this.appendLog(job.id, 'REGISTERING', STAGE_TEXT.REGISTERING, { status: 'SAVING', stage: 'REGISTERING' });
      const registered = await (this.deps.register ?? registerTrainerOutput)(this.deps.prisma, { rootDir: this.deps.rootDir, dir: trainer.dir, datasetVersion: dataset.version, actor });
      return this.finish(job.id, 'COMPLETED', { bundleVersion: registered.bundleVersion, readiness: registered.readiness, result: { dataset: dataset.version, entryRows, positionRows, bundleVersion: registered.bundleVersion, readiness: registered.readiness, artifactHash: registered.artifactHash } });
    } catch (error) {
      if (abort.signal.aborted && await this.cancelled(job.id, abort)) return this.finish(job.id, 'CANCELLED', { error: 'Megszakítva a felhasználó kérésére (dataset-előkészítés leállítva, semmi nincs regisztrálva)' });
      return this.finish(job.id, 'FAILED', { error: `HIBA: ${error instanceof Error ? error.message.slice(0, 400) : String(error)}` });
    } finally {
      globalThis.clearInterval(heartbeat);
      this.current = null;
    }
  }

  private async cancelled(id: string, abort: globalThis.AbortController) {
    const row = await this.deps.prisma.mlTrainingJob.findUnique({ where: { id }, select: { cancelRequested: true } });
    if (row?.cancelRequested) abort.abort();
    return abort.signal.aborted;
  }

  /** Requested dataset (hash verified) or a new immutable dataset from the current data. */
  private async prepareDataset(job: Job, actor: string, signal: globalThis.AbortSignal): Promise<DatasetBuildResult> {
    if (job.datasetVersion) {
      const row = await this.deps.prisma.mlDatasetVersion.findUnique({ where: { version: job.datasetVersion } });
      if (!row || row.featureVersion !== 'ML-FEATURES-AUTONOMOUS-v1') throw new Error(`Autonomous dataset ${job.datasetVersion} not found`);
      const path = await import('node:path');
      const file = path.join(this.deps.rootDir, row.filePath);
      if (await sha256File(file) !== row.fileHash) throw new Error('Dataset file hash mismatch (modified after creation)');
      return { version: row.version, rows: row.rowCount, directory: path.dirname(file), fileHash: row.fileHash, manifest: row.manifest as Record<string, unknown> };
    }
    let lastWrite = 0;
    this.lastProgress = null;
    let lastPhase: string | null = null;
    const onProgress = (progress: DatasetProgress) => {
      const phaseChanged = progress.phase !== lastPhase;
      if (!phaseChanged && this.now() - lastWrite < PROGRESS_WRITE_MS) return;
      lastWrite = this.now();
      lastPhase = progress.phase;
      const data = { result: { progress } as unknown as Prisma.InputJsonValue };
      this.lastProgress = progress;
      // Serialized with the log writes (one read-modify-write at a time); a failed progress write never fails the build.
      if (phaseChanged) void this.appendLog(job.id, 'PREPARING_DATASET', `${PHASE_TEXT[progress.phase]} – REPLAY ${progress.replay.processed}/${progress.replay.total}, LIVE ${progress.live.processed}/${progress.live.total}, sorok: belépés ${progress.rows.entry}, pozíció ${progress.rows.position}`, data).catch(() => undefined);
      else {
        const next = this.writes.then(() => this.deps.prisma.mlTrainingJob.updateMany({ where: { id: job.id, leaseOwner: this.deps.owner }, data: { ...data, heartbeatAt: new Date(this.now()) } }));
        this.writes = next.catch(() => undefined);
      }
    };
    const dataset = await (this.deps.buildDataset ?? buildAutonomousDatasetVersion)(this.deps.prisma, { rootDir: this.deps.rootDir, actor, jobId: job.id, onProgress, signal });
    await this.writes;
    return dataset;
  }

  health() {
    return { at: new Date(this.now()).toISOString(), owner: this.deps.owner, runningJob: this.current?.id ?? null, metrics: this.metrics };
  }
}
