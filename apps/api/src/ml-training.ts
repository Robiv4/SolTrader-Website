/**
 * Simplified Machine Learning API (web training + models + results). PAPER only; nothing here trades, activates or
 * selects a model. Training runs in the separate ml-trainer process; this API only creates / cancels durable jobs.
 *
 *   GET  /ml/autonomous/dataset-readiness            what the next training would use, what is missing (real counts)
 *   POST /ml/autonomous/training-jobs                admin: start (one active job at a time; a double click returns it)
 *   GET  /ml/autonomous/training-jobs                recent jobs + trainer health
 *   GET  /ml/autonomous/training-jobs/:id            one job with its progress log
 *   POST /ml/autonomous/training-jobs/:id/cancel     admin: cancel (queued -> cancelled, running -> stop requested)
 *   GET  /ml/autonomous/models                       every bundle: test results, readiness, check, approval, PAPER result
 *   GET  /ml/autonomous/models/:version              detailed report
 *   POST /ml/autonomous/models/:version/check        admin + e-mail: "Modell ellenőrzése" (forward PAPER observation)
 *   GET  /ml/autonomous/results                      active model PAPER results, P&L series, positions, decisions
 */
import { Prisma, type PrismaClient } from '@prisma/client';
import { ML_AUTONOMOUS_FEATURE_VERSION, ML_AUTONOMOUS_STRATEGY, ML_COMMUNITY_FEATURE_VERSION } from '@soltrader/strategy-engine';
import { type Request, type Response, Router } from 'express';
import { z } from 'zod';

import type { StepUpGate } from './email-verification.js';
import { MIN_SHADOW_DECISIONS_FOR_APPROVAL } from './ml-autonomous.js';
import { paperStats } from './ml-paper.js';

export const MIN_TRAINING_ROWS_PER_KIND = 300;
export const READY_TRAINING_ROWS_PER_KIND = 2_000;
/** Replayed POSITION decision points per completed path (REPLAY_POSITION_OFFSETS_MS). Upper bound for the estimate. */
const POSITION_POINTS_PER_PATH = 12;
const ACTIVE = ['QUEUED', 'PREPARING_DATASET', 'TRAINING', 'VALIDATING', 'SAVING'];

const fail = (res: Response, status: number, message: string, data?: unknown) => res.status(status).json({ ok: false, error: message, ...(data ? { data } : {}) });
const num = (value: unknown) => (value === null || value === undefined ? null : Number(value));
const record = (value: unknown) => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {});

export interface MlTrainingDeps {
  prisma: PrismaClient;
  stepUp: StepUpGate;
  logAuditEvent: (action: string, userId: string | null, details?: Record<string, unknown>) => Promise<unknown>;
  readJson: (key: string) => Promise<Record<string, unknown> | null>;
  logger: { error(payload: unknown, message?: string): void };
}

/** Bundle "kereskedési alkalmasság" for the UI (training success and trading suitability are separate). */
export function bundleSuitability(bundle: { readiness: string; status: string; paperApproved: boolean }, shadowDecisions: number) {
  if (bundle.status === 'RETIRED') return { code: 'RETIRED', tradeable: false };
  if (bundle.readiness !== 'SHADOW_READY') return { code: bundle.readiness === 'INSUFFICIENT_DATA' ? 'INSUFFICIENT_DATA' : 'RESEARCH_ONLY', tradeable: false };
  if (bundle.paperApproved) return { code: 'APPROVED', tradeable: true };
  if (bundle.status === 'SHADOW') return { code: shadowDecisions >= MIN_SHADOW_DECISIONS_FOR_APPROVAL ? 'CHECK_COMPLETE' : 'CHECK_RUNNING', tradeable: false };
  return { code: 'NOT_CHECKED', tradeable: false };
}

export function createMlTrainingRouter(deps: MlTrainingDeps) {
  const { prisma } = deps;
  const router = Router();

  async function readiness() {
    const [paths] = await prisma.$queryRaw<Array<{ paths: bigint; from: Date | null; to: Date | null }>>`
      SELECT COUNT(*) AS paths, MIN(s."snapshotAt") AS "from", MAX(s."snapshotAt") AS "to"
      FROM "MlCandidateOutcome" o JOIN "MlFeatureSnapshot" s ON s.id = o."snapshotId"
      WHERE o.status = 'COMPLETE' AND s."featureVersion" = 'ML-FEATURES-v1' AND s.kind IN ('AGE_30S', 'BUY_DECISION')
        AND jsonb_typeof(o.path -> 'buckets') = 'array' AND (o.path ->> 'startAt') IS NOT NULL`;
    const since = new Date(Date.now() - 10 * 60_000);
    const live = await prisma.mlAutonomousDecisionSnapshot.groupBy({ by: ['kind'], where: { at: { lte: since } }, _count: { _all: true } });
    const weekAgo = new Date(Date.now() - 7 * 86_400_000);
    const [community] = await prisma.$queryRaw<Array<{ total: bigint; with_social: bigint }>>`
      SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE "features"->>'mentions5m' IS NOT NULL) AS with_social
      FROM "MlFeatureSnapshot" WHERE "featureVersion" = ${ML_COMMUNITY_FEATURE_VERSION} AND "snapshotAt" >= ${weekAgo.toISOString()}::timestamp`;
    const lastDataset = await prisma.mlDatasetVersion.findFirst({ where: { featureVersion: ML_AUTONOMOUS_FEATURE_VERSION }, orderBy: { createdAt: 'desc' } });
    const datasets = await prisma.mlDatasetVersion.findMany({ where: { featureVersion: ML_AUTONOMOUS_FEATURE_VERSION }, orderBy: { createdAt: 'desc' }, take: 20, select: { version: true, rowCount: true, createdAt: true } });
    const lastCompleted = await prisma.mlTrainingJob.findFirst({ where: { status: 'COMPLETED', startedAt: { not: null }, finishedAt: { not: null } }, orderBy: { finishedAt: 'desc' } });
    const completedPaths = Number(paths?.paths ?? 0);
    const liveEntry = live.find((row) => row.kind === 'ENTRY')?._count._all ?? 0;
    const livePosition = live.find((row) => row.kind === 'POSITION')?._count._all ?? 0;
    // Upper bounds: every completed path gives at most 1 ENTRY + 10 POSITION rows; exclusions (gaps, early ends) reduce it.
    const entryUpper = completedPaths + liveEntry;
    const positionUpper = completedPaths * POSITION_POINTS_PER_PATH + livePosition;
    const manifest = record(lastDataset?.manifest);
    const coverage = record(manifest.coverage);
    const entryCoverage = record(coverage.entry);
    const missing: string[] = [];
    if (entryUpper < MIN_TRAINING_ROWS_PER_KIND) missing.push(`Belépési minta: legfeljebb ${entryUpper} várható, legalább ${MIN_TRAINING_ROWS_PER_KIND} kell (befejezett 60 perces árfolyampálya: ${completedPaths}).`);
    if (positionUpper < MIN_TRAINING_ROWS_PER_KIND) missing.push(`Pozíció minta: legfeljebb ${positionUpper} várható, legalább ${MIN_TRAINING_ROWS_PER_KIND} kell.`);
    const warnings: string[] = [];
    if (entryUpper < READY_TRAINING_ROWS_PER_KIND) warnings.push(`Kereskedési alkalmassághoz fajtánként legalább ${READY_TRAINING_ROWS_PER_KIND} minta kell; ennél kevesebb adattal a modell csak kutatási modell lehet.`);
    const socialShare = Number(community?.total ?? 0) ? Number(community?.with_social ?? 0) / Number(community!.total) : null;
    if (socialShare !== null && socialShare < 0.1) warnings.push(`Alacsony Telegram/Community lefedettség: a Community snapshotok ${(socialShare * 100).toFixed(1)}%-ában van social adat (7 nap).`);
    if (!liveEntry) warnings.push('Még nincs élő Autonomous döntési snapshot: a belépési sorok csak visszajátszásból származnak (dinamika nélkül).');
    const excluded = record(coverage.excluded);
    const topExclusions = Object.entries(excluded).sort((a, b) => Number(b[1]) - Number(a[1])).slice(0, 3);
    if (topExclusions.length) warnings.push(`Az utolsó datasetben kizárt címkék: ${topExclusions.map(([reason, count]) => `${reason} ${count}`).join(', ')}.`);
    return {
      completedPaths, period: { from: paths?.from ?? null, to: paths?.to ?? null },
      liveSnapshots: { entry: liveEntry, position: livePosition },
      estimate: { entryRowsUpperBound: entryUpper, positionRowsUpperBound: positionUpper, note: 'Felső becslés; a pontos szám (és a kizárások) a dataset elkészítésekor derül ki.' },
      lastDataset: lastDataset ? {
        version: lastDataset.version, rows: lastDataset.rowCount, createdAt: lastDataset.createdAt,
        entryRows: num(entryCoverage.total), positive: num(entryCoverage.netPositive), negative: entryCoverage.total !== undefined ? Number(entryCoverage.total) - Number(entryCoverage.netPositive ?? 0) : null,
        positionRows: num(record(coverage.position).total), excluded,
      } : null,
      datasets,
      communityCoverage: { snapshots7d: Number(community?.total ?? 0), withSocialData: Number(community?.with_social ?? 0), share: socialShare },
      resources: { threads: 1, note: 'A tanítás külön ml-trainer folyamatban fut (alacsony CPU-prioritás, 1 szál); a kereskedési workert nem terheli.', lastTrainingMinutes: lastCompleted?.startedAt && lastCompleted.finishedAt ? Math.round((lastCompleted.finishedAt.getTime() - lastCompleted.startedAt.getTime()) / 60_000) : null },
      canTrain: missing.length === 0, missing, warnings,
    };
  }

  router.get('/ml/autonomous/dataset-readiness', async (_req: Request, res: Response) => {
    try {
      return res.json({ ok: true, data: await readiness() });
    } catch (error) {
      deps.logger.error({ err: error }, 'Dataset readiness failed');
      return fail(res, 500, 'Dataset readiness failed');
    }
  });

  const createSchema = z.object({
    name: z.string().trim().min(1).max(60).regex(/^[\p{L}\p{N} ._-]+$/u, 'Csak betű, szám, szóköz, pont, kötőjel és aláhúzás').optional(),
    /** An existing autonomous dataset version (never a path); omitted = a new dataset from the current data. */
    datasetVersion: z.string().regex(/^AUTO-DATASET-[A-Za-z0-9-]{1,40}$/).optional(),
  }).strict();

  router.post('/ml/autonomous/training-jobs', async (req: Request, res: Response) => {
    if (req.user?.role !== 'ADMIN') return fail(res, 403, 'Csak adminisztrátor indíthat tanítást.');
    const parsed = createSchema.safeParse(req.body ?? {});
    if (!parsed.success) return fail(res, 400, 'Érvénytelen tanítási kérés', parsed.error.issues);
    try {
      if (parsed.data.datasetVersion) {
        const dataset = await prisma.mlDatasetVersion.findUnique({ where: { version: parsed.data.datasetVersion } });
        if (!dataset || dataset.featureVersion !== ML_AUTONOMOUS_FEATURE_VERSION) return fail(res, 404, 'A kiválasztott Autonomous dataset nem létezik.');
      }
      try {
        const job = await prisma.mlTrainingJob.create({ data: { kind: 'AUTONOMOUS', name: parsed.data.name ?? null, datasetVersion: parsed.data.datasetVersion ?? null, requestedBy: req.user.email, activeKey: 'ACTIVE', log: [{ at: new Date().toISOString(), stage: 'QUEUED', message: 'Sorba állítva; az ml-trainer szolgáltatás indítja.' }] as Prisma.InputJsonValue } });
        await deps.logAuditEvent('ml_training_job_started', req.user.id, { jobId: job.id, datasetVersion: job.datasetVersion, name: job.name });
        return res.status(201).json({ ok: true, data: job });
      } catch (error) {
        if ((error as { code?: string }).code !== 'P2002') throw error;
        // One active training at a time: a double click / second admin gets the running job, nothing new is created.
        const active = await prisma.mlTrainingJob.findUnique({ where: { activeKey: 'ACTIVE' } });
        return fail(res, 409, 'Már fut egy tanítás.', { activeJob: active });
      }
    } catch (error) {
      deps.logger.error({ err: error }, 'Training job create failed');
      return fail(res, 500, 'Training job create failed');
    }
  });

  router.get('/ml/autonomous/training-jobs', async (_req: Request, res: Response) => {
    const [jobs, trainer] = await Promise.all([
      prisma.mlTrainingJob.findMany({ orderBy: { requestedAt: 'desc' }, take: 20, select: { id: true, name: true, status: true, stage: true, datasetVersion: true, bundleVersion: true, readiness: true, requestedBy: true, requestedAt: true, startedAt: true, finishedAt: true, heartbeatAt: true, error: true, cancelRequested: true, updatedAt: true } }),
      deps.readJson('ml:trainer:health').catch(() => null),
    ]);
    return res.json({ ok: true, data: { jobs, trainer: trainer ? { available: true, at: trainer.at ?? null, runningJob: trainer.runningJob ?? null } : { available: false } } });
  });

  router.get('/ml/autonomous/training-jobs/:id', async (req: Request, res: Response) => {
    const job = await prisma.mlTrainingJob.findUnique({ where: { id: String(req.params.id) } });
    if (!job) return fail(res, 404, 'A tanítás nem található');
    return res.json({ ok: true, data: job });
  });

  router.post('/ml/autonomous/training-jobs/:id/cancel', async (req: Request, res: Response) => {
    if (req.user?.role !== 'ADMIN') return fail(res, 403, 'Csak adminisztrátor szakíthat meg tanítást.');
    const job = await prisma.mlTrainingJob.findUnique({ where: { id: String(req.params.id) } });
    if (!job) return fail(res, 404, 'A tanítás nem található');
    if (!ACTIVE.includes(job.status)) return fail(res, 409, 'A tanítás már befejeződött.');
    const queued = await prisma.mlTrainingJob.updateMany({ where: { id: job.id, status: 'QUEUED' }, data: { status: 'CANCELLED', activeKey: null, finishedAt: new Date(), cancelRequested: true, error: 'Megszakítva a felhasználó kérésére' } });
    if (!queued.count) await prisma.mlTrainingJob.update({ where: { id: job.id }, data: { cancelRequested: true } });
    await deps.logAuditEvent('ml_training_job_cancelled', req.user.id, { jobId: job.id, status: job.status });
    return res.json({ ok: true, data: await prisma.mlTrainingJob.findUnique({ where: { id: job.id } }) });
  });

  async function modelRows(userId: string) {
    const [bundles, shadow, settings, positions, usage] = await Promise.all([
      prisma.mlAutonomousModelBundle.findMany({ orderBy: { trainedAt: 'desc' } }),
      prisma.mlAutonomousDecision.groupBy({ by: ['bundleVersion'], where: { mode: 'SHADOW' }, _count: { _all: true } }),
      prisma.mlPaperSettings.findUnique({ where: { userId } }),
      prisma.mlAutonomousPosition.findMany({ where: { status: 'CLOSED' }, select: { bundleVersion: true, realizedPnlUsd: true, feesUsd: true, closedAt: true, userId: true } }),
      prisma.mlPaperSettings.groupBy({ by: ['autonomousBundleVersion'], where: { strategyMode: ML_AUTONOMOUS_STRATEGY }, _count: { _all: true } }),
    ]);
    const jobs = await prisma.mlTrainingJob.findMany({ where: { bundleVersion: { in: bundles.map((bundle) => bundle.version) } }, select: { id: true, name: true, bundleVersion: true } });
    return bundles.map((bundle) => {
      const metrics = record(bundle.metrics);
      const entry = record(metrics.entry);
      const backtest = record(record(entry.backtest).policy);
      const rows = record(entry.rows);
      const shadowDecisions = shadow.find((row) => row.bundleVersion === bundle.version)?._count._all ?? 0;
      const mine = positions.filter((position) => position.bundleVersion === bundle.version && position.userId === userId);
      const coverage = record(metrics.coverage);
      const job = jobs.find((item) => item.bundleVersion === bundle.version);
      return {
        version: bundle.version, name: job?.name ?? null, trainingJobId: job?.id ?? null, createdAt: bundle.trainedAt, datasetVersion: bundle.datasetVersion, algorithm: 'LightGBM Autonomous csomag (5 komponens)',
        status: bundle.status, readiness: bundle.readiness, paperApproved: bundle.paperApproved,
        train: { rows: num(rows.train), spearman: num(record(record(entry.entryReturn).train).spearman) },
        test: { rows: num(rows.test), spearman: num(record(record(entry.entryReturn).test).spearman), trades: num(backtest.trades), netPnl: num(backtest.netPnl), profitFactor: num(backtest.profitFactor), maxDrawdown: num(backtest.maxDrawdown), winRate: num(backtest.winRate) },
        dataQuality: { rows: num(record(coverage.entry).total) !== null ? Number(record(coverage.entry).total) + Number(record(coverage.position).total ?? 0) : null, excluded: coverage.excluded ?? null },
        check: { shadowDecisions, required: MIN_SHADOW_DECISIONS_FOR_APPROVAL },
        suitability: bundleSuitability(bundle, shadowDecisions),
        active: settings?.strategyMode === ML_AUTONOMOUS_STRATEGY && settings.autonomousBundleVersion === bundle.version,
        usersOnModel: usage.find((row) => row.autonomousBundleVersion === bundle.version)?._count._all ?? 0,
        paper: paperStats(mine.map((position) => ({ netPnl: Number(position.realizedPnlUsd), fees: Number(position.feesUsd), slippage: 0, exitAt: position.closedAt, entryStrategy: ML_AUTONOMOUS_STRATEGY, mlModelVersion: bundle.version }))),
      };
    });
  }

  router.get('/ml/autonomous/models', async (req: Request, res: Response) => {
    try {
      return res.json({ ok: true, data: { models: await modelRows(req.user!.id) } });
    } catch (error) {
      deps.logger.error({ err: error }, 'Models failed');
      return fail(res, 500, 'Models failed');
    }
  });

  router.get('/ml/autonomous/models/:version', async (req: Request, res: Response) => {
    const bundle = await prisma.mlAutonomousModelBundle.findUnique({ where: { version: String(req.params.version) } });
    if (!bundle) return fail(res, 404, 'A modell nem található');
    const [dataset, job, row] = await Promise.all([
      prisma.mlDatasetVersion.findUnique({ where: { version: bundle.datasetVersion }, select: { version: true, rowCount: true, createdAt: true, manifest: true, fileHash: true } }),
      prisma.mlTrainingJob.findFirst({ where: { bundleVersion: bundle.version } }),
      (await modelRows(req.user!.id)).find((item) => item.version === bundle.version),
    ]);
    return res.json({ ok: true, data: { ...row, policy: bundle.policy, metrics: bundle.metrics, artifactHash: bundle.artifactHash, statusHistory: bundle.statusHistory, dataset, trainingJob: job ? { id: job.id, status: job.status, startedAt: job.startedAt, finishedAt: job.finishedAt, log: job.log } : null } });
  });

  /** "Modell ellenőrzése": forward PAPER observation (decisions without execution) of a SHADOW_READY model. */
  router.post('/ml/autonomous/models/:version/check', async (req: Request, res: Response) => {
    if (req.user?.role !== 'ADMIN') return fail(res, 403, 'Csak adminisztrátor indíthat modell-ellenőrzést.');
    const bundle = await prisma.mlAutonomousModelBundle.findUnique({ where: { version: String(req.params.version) } });
    if (!bundle) return fail(res, 404, 'A modell nem található');
    if (bundle.readiness !== 'SHADOW_READY') return fail(res, 409, 'Kutatási modell: a tesztek alapján nem alkalmas kereskedésre, ezért nem ellenőrizhető kereskedéshez.', { readiness: bundle.readiness });
    if (bundle.status === 'SHADOW' || bundle.status === 'RETIRED') return fail(res, 409, bundle.status === 'SHADOW' ? 'Az ellenőrzés már fut.' : 'Kivezetett modell.');
    if (!await deps.stepUp(req, res, 'ml_autonomous_check', { bundleVersion: bundle.version })) return;
    const at = new Date().toISOString();
    const history = [...(Array.isArray(bundle.statusHistory) ? bundle.statusHistory : []), ...(bundle.status === 'TRAINED' ? [{ status: 'VALIDATED', at, by: req.user.email }] : []), { status: 'SHADOW', at, by: req.user.email, note: 'Modell ellenőrzése (döntések végrehajtás nélkül)' }];
    await prisma.mlAutonomousModelBundle.update({ where: { version: bundle.version }, data: { status: 'SHADOW', statusHistory: history as Prisma.InputJsonValue } });
    await deps.logAuditEvent('ml_autonomous_check_started', req.user.id, { bundleVersion: bundle.version });
    return res.json({ ok: true, data: { version: bundle.version, status: 'SHADOW' } });
  });

  router.get('/ml/autonomous/results', async (req: Request, res: Response) => {
    try {
      const userId = req.user!.id;
      const settings = await prisma.mlPaperSettings.findUnique({ where: { userId } });
      const account = await prisma.mlAutonomousAccount.findUnique({ where: { userId } });
      const activeVersion = settings?.strategyMode === ML_AUTONOMOUS_STRATEGY ? settings.autonomousBundleVersion : null;
      if (!account) return res.json({ ok: true, data: { activeVersion, account: null, stats: null, daily: [], weekly: [], positions: [], decisions: {}, models: await modelRows(userId) } });
      const [closed, open, fills, decisions] = await Promise.all([
        prisma.mlAutonomousPosition.findMany({ where: { accountId: account.id, status: 'CLOSED' }, orderBy: { closedAt: 'desc' } }),
        prisma.mlAutonomousPosition.findMany({ where: { accountId: account.id, status: 'OPEN' }, orderBy: { openedAt: 'desc' } }),
        prisma.mlAutonomousFill.findMany({ where: { accountId: account.id, side: 'SELL' }, select: { at: true, realizedPnlUsd: true } }),
        prisma.mlAutonomousDecision.groupBy({ by: ['action'], where: { accountId: account.id, decidedAt: { gte: new Date(Date.now() - 7 * 86_400_000) } }, _count: { _all: true } }),
      ]);
      const forActive = activeVersion ? closed.filter((position) => position.bundleVersion === activeVersion) : closed;
      const stats = paperStats(forActive.map((position) => ({ netPnl: Number(position.realizedPnlUsd), fees: Number(position.feesUsd), slippage: 0, exitAt: position.closedAt, entryStrategy: ML_AUTONOMOUS_STRATEGY, mlModelVersion: position.bundleVersion })));
      const series = (bucket: (date: Date) => string) => Object.entries(fills.reduce<Record<string, number>>((sums, fill) => ({ ...sums, [bucket(fill.at)]: (sums[bucket(fill.at)] ?? 0) + Number(fill.realizedPnlUsd ?? 0) }), {})).sort(([a], [b]) => a.localeCompare(b)).map(([period, pnl]) => ({ period, pnl }));
      const weekOf = (date: Date) => {
        const monday = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - ((date.getUTCDay() + 6) % 7)));
        return monday.toISOString().slice(0, 10);
      };
      const position = (row: typeof closed[number]) => ({ id: row.id, mint: row.mint, symbol: row.symbol, bundleVersion: row.bundleVersion, status: row.status, entryNotionalUsd: num(row.entryNotionalUsd), quantity: num(row.quantity), realizedPnlUsd: num(row.realizedPnlUsd), exitReason: row.exitReason, openedAt: row.openedAt, closedAt: row.closedAt, partiallySold: row.partiallySold });
      return res.json({
        ok: true,
        data: {
          activeVersion, account: { accountKey: account.accountKey, initialBalance: num(account.initialBalance), cashBalance: num(account.cashBalance), realizedPnl: num(account.realizedPnl), feesPaid: num(account.feesPaid), impactCost: num(account.impactCost) },
          stats: { ...stats, expectancy: stats.trades ? stats.netPnl / stats.trades : null },
          daily: series((date) => date.toISOString().slice(0, 10)), weekly: series(weekOf),
          positions: [...open.map(position), ...closed.slice(0, 50).map(position)],
          decisions: Object.fromEntries(decisions.map((row) => [row.action, row._count._all])),
          models: await modelRows(userId),
        },
      });
    } catch (error) {
      deps.logger.error({ err: error }, 'Results failed');
      return fail(res, 500, 'Results failed');
    }
  });

  return router;
}
