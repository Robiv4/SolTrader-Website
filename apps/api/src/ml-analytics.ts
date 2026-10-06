/**
 * Machine Learning (shadow) read API + model status workflow. HISTORICAL / SHADOW / PAPER RESEARCH only:
 * nothing here influences trading. Large feature JSON is never loaded in bulk: SQL extracts the few fields needed.
 */
import { Prisma, type PrismaClient } from '@prisma/client';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import type { StepUpGate } from './email-verification.js';

type Row = {
  id: string; mint: string; source: string; kind: string; snapshotAt: Date; decision: string; dataQuality: number; validForTraining: boolean;
  launchScore: number | null; ageSeconds: number | null; riskScore: number | null; telegramMomentum: number | null;
  outcomeStatus: string | null; label: string | null; mfe30: number | null; mae30: number | null; ret30: number | null;
  mlEntryScore: number | null; predictedClass: string | null; probability: Prisma.Decimal | null; reasons: unknown;
};

const ALLOWED_TRANSITIONS: Record<string, string[]> = { TRAINED: ['VALIDATED', 'RETIRED'], VALIDATED: ['SHADOW', 'RETIRED'], SHADOW: ['VALIDATED', 'RETIRED'], RETIRED: [] };
const num = (value: unknown) => (value === null || value === undefined ? null : Number(value));
const fail = (res: Response, status: number, message: string) => res.status(status).json({ ok: false, error: message });

/** Rank-based ROC AUC (Mann-Whitney); null when a class is missing. */
export function rocAuc(scores: number[], labels: boolean[]) {
  const pairs = scores.map((score, index) => ({ score, label: labels[index] })).sort((a, b) => a.score - b.score);
  const positives = pairs.filter((pair) => pair.label).length;
  const negatives = pairs.length - positives;
  if (!positives || !negatives) return null;
  let rankSum = 0;
  for (let i = 0; i < pairs.length;) {
    let j = i;
    while (j < pairs.length && pairs[j].score === pairs[i].score) j += 1;
    const averageRank = (i + j + 1) / 2;
    for (let k = i; k < j; k += 1) if (pairs[k].label) rankSum += averageRank;
    i = j;
  }
  return (rankSum - positives * (positives + 1) / 2) / (positives * negatives);
}

function outcomeStats(rows: Row[]) {
  const labelled = rows.filter((row) => row.label === 'true' || row.label === 'false');
  const avg = (values: Array<number | null>) => {
    const known = values.filter((value): value is number => value !== null && Number.isFinite(value));
    return known.length ? known.reduce((sum, value) => sum + value, 0) / known.length : null;
  };
  return {
    candidates: rows.length,
    withOutcome: labelled.length,
    targetRate: labelled.length ? labelled.filter((row) => row.label === 'true').length / labelled.length : null,
    avgMfe30: avg(rows.map((row) => row.mfe30)),
    avgMae30: avg(rows.map((row) => row.mae30)),
    avgReturn30: avg(rows.map((row) => row.ret30)),
    smallSample: labelled.length < 30,
  };
}

function bucket<T extends string>(rows: Row[], keyOf: (row: Row) => T | null, order: T[]) {
  return order.map((key) => ({ key, ...outcomeStats(rows.filter((row) => keyOf(row) === key)) }));
}

export function createMlRouter(deps: { prisma: PrismaClient; readJson: (key: string) => Promise<Record<string, unknown> | null>; logAuditEvent: (action: string, userId: string | null, details?: Record<string, unknown>) => Promise<unknown>; stepUp: StepUpGate; logger: { error(payload: unknown, message?: string): void } }) {
  const { prisma } = deps;
  const router = Router();

  async function loadRows(sinceDays: number, kind: string, modelVersion: string | null, limit = 50_000): Promise<Row[]> {
    const since = new Date(Date.now() - sinceDays * 86_400_000);
    return prisma.$queryRaw<Row[]>`
      SELECT s.id, s.mint, s.source, s.kind, s."snapshotAt", s.decision, s."dataQuality", s."validForTraining",
        (s.features->>'launchScore')::float AS "launchScore", (s.features->>'observationAgeSeconds')::float AS "ageSeconds",
        (s.features->>'riskScore')::float AS "riskScore", (s.features->>'telegramMomentum')::float AS "telegramMomentum",
        o.status AS "outcomeStatus", o.result->'pathLabels'->>'plus20BeforeMinus10' AS label,
        (o.result->'horizons'->'1800'->>'mfePct')::float AS mfe30, (o.result->'horizons'->'1800'->>'maePct')::float AS mae30,
        (o.result->'horizons'->'1800'->>'returnPct')::float AS ret30,
        p."mlEntryScore", p."predictedClass", p.probability, s."decisionContext"->'users'->0->'reasons' AS reasons
      FROM "MlFeatureSnapshot" s
      LEFT JOIN "MlCandidateOutcome" o ON o."snapshotId" = s.id
      LEFT JOIN "MlPrediction" p ON p."snapshotId" = s.id AND p."modelVersion" = ${modelVersion ?? ''}
      WHERE s.kind = ${kind} AND s."snapshotAt" >= ${since}
      ORDER BY s."snapshotAt" DESC
      LIMIT ${limit}`;
  }

  router.get('/overview', async (_req: Request, res: Response) => {
    try {
      const [health, rpc, kinds, decisions, sources, outcomes, quality, datasets, models, predictions, last24h] = await Promise.all([
        deps.readJson('ml:health'),
        deps.readJson('rpc:health'),
        prisma.mlFeatureSnapshot.groupBy({ by: ['kind'], _count: { _all: true } }),
        prisma.mlFeatureSnapshot.groupBy({ by: ['decision'], where: { kind: 'AGE_30S' }, _count: { _all: true } }),
        prisma.mlFeatureSnapshot.groupBy({ by: ['source'], where: { kind: 'AGE_30S' }, _count: { _all: true } }),
        prisma.mlCandidateOutcome.groupBy({ by: ['status'], _count: { _all: true } }),
        prisma.mlFeatureSnapshot.groupBy({ by: ['validForTraining'], where: { kind: 'AGE_30S' }, _count: { _all: true }, _avg: { dataQuality: true } }),
        prisma.mlDatasetVersion.findMany({ orderBy: { createdAt: 'desc' }, take: 10, select: { version: true, target: true, rowCount: true, createdAt: true, manifest: true, createdBy: true } }),
        prisma.mlModelVersion.findMany({ orderBy: { createdAt: 'desc' }, take: 20, select: { version: true, algorithm: true, status: true, readiness: true, target: true, datasetVersion: true, trainedAt: true, metrics: true, statusHistory: true } }),
        prisma.mlPrediction.count(),
        prisma.mlFeatureSnapshot.count({ where: { kind: 'AGE_30S', snapshotAt: { gte: new Date(Date.now() - 86_400_000) } } }),
      ]);
      const callers = Array.isArray(rpc?.callers) ? rpc!.callers as Array<{ caller: string; network: number }> : [];
      const valid = quality.find((item) => item.validForTraining)?._count._all ?? 0;
      const invalid = quality.find((item) => !item.validForTraining)?._count._all ?? 0;
      return res.json({ ok: true, data: {
        mode: health?.mode ?? 'SHADOW',
        worker: health,
        snapshotsByKind: Object.fromEntries(kinds.map((item) => [item.kind, item._count._all])),
        decisions: Object.fromEntries(decisions.map((item) => [item.decision, item._count._all])),
        sources: Object.fromEntries(sources.map((item) => [item.source, item._count._all])),
        outcomes: Object.fromEntries(outcomes.map((item) => [item.status, item._count._all])),
        validForTrainingRate: valid + invalid ? valid / (valid + invalid) : null,
        averageDataQuality: quality.reduce((sum, item) => sum + (item._avg.dataQuality ?? 0) * item._count._all, 0) / Math.max(1, valid + invalid),
        candidatesLast24h: last24h,
        predictions,
        additionalRpcRequests: callers.filter((item) => /^ml/i.test(item.caller)).reduce((sum, item) => sum + item.network, 0),
        datasets: datasets.map((item) => ({ ...item, manifest: undefined, readiness: (item.manifest as Record<string, unknown>)?.readiness ?? null, positives: (item.manifest as Record<string, unknown>)?.positives ?? null, decisions: (item.manifest as Record<string, unknown>)?.decisions ?? null, sourcesDist: (item.manifest as Record<string, unknown>)?.sources ?? null, missingRates: (item.manifest as Record<string, unknown>)?.missingRates ?? null, excluded: (item.manifest as Record<string, unknown>)?.excluded ?? null, startTime: (item.manifest as Record<string, unknown>)?.startTime ?? null, endTime: (item.manifest as Record<string, unknown>)?.endTime ?? null, outcomeQuality: (item.manifest as Record<string, unknown>)?.outcomeQuality ?? null })),
        models,
        commands: ['pnpm ml:status', 'pnpm ml:dataset --target plus20BeforeMinus10_30m --kind AGE_30S', 'pnpm ml:train', 'pnpm ml:test'],
      } });
    } catch (error) {
      deps.logger.error({ err: error }, 'ML overview failed');
      return fail(res, 500, 'ML overview unavailable');
    }
  });

  router.get('/predictions', async (req: Request, res: Response) => {
    try {
      const limit = Math.min(200, Number(req.query.limit ?? 60) || 60);
      const shadow = await prisma.mlModelVersion.findFirst({ where: { status: 'SHADOW' }, select: { version: true } });
      const rows = await loadRows(3, 'AGE_30S', shadow?.version ?? null, limit);
      const candidates = await prisma.launchCandidate.findMany({ where: { mint: { in: rows.map((row) => row.mint) } }, select: { mint: true, symbol: true } });
      const symbols = new Map(candidates.map((item) => [item.mint, item.symbol]));
      return res.json({ ok: true, data: { modelVersion: shadow?.version ?? null, rows: rows.map((row) => ({ ...row, probability: num(row.probability), symbol: symbols.get(row.mint) ?? null })) } });
    } catch (error) {
      deps.logger.error({ err: error }, 'ML predictions failed');
      return fail(res, 500, 'ML predictions unavailable');
    }
  });

  router.get('/analytics', async (_req: Request, res: Response) => {
    try {
      const shadow = await prisma.mlModelVersion.findFirst({ where: { status: 'SHADOW' }, select: { version: true, metrics: true, trainedAt: true, config: true } });
      const rows = await loadRows(14, 'AGE_30S', shadow?.version ?? null);
      const predicted = rows.filter((row) => row.mlEntryScore !== null);
      const mlBuy = (row: Row) => row.predictedClass === 'ML_BUY';
      const strategyBuy = (row: Row) => row.decision === 'BUY';
      const level = (score: number | null) => (score === null ? null : score >= 66 ? 'ML HIGH' : score >= 33 ? 'ML MID' : 'ML LOW');
      const launchBucket = (row: Row) => (row.launchScore === null ? null : row.launchScore >= 90 ? '90–100' : row.launchScore >= 80 ? '80–89' : row.launchScore >= 70 ? '70–79' : '<70');
      const ageBucket = (row: Row) => (row.ageSeconds === null ? null : row.ageSeconds <= 10 ? '0–10 mp' : row.ageSeconds <= 30 ? '11–30 mp' : row.ageSeconds <= 60 ? '31–60 mp' : '61–90 mp');
      const cross = (keyOf: (row: Row) => string | null, firstOrder: string[]) => firstOrder.flatMap((first) => ['ML LOW', 'ML MID', 'ML HIGH'].map((second) => ({ key: `${first} × ${second}`, ...outcomeStats(predicted.filter((row) => keyOf(row) === first && level(row.mlEntryScore) === second)) })));
      const labelled = predicted.filter((row) => row.label === 'true' || row.label === 'false');
      const recentAuc = rocAuc(labelled.map((row) => Number(row.probability)), labelled.map((row) => row.label === 'true'));
      const validationAuc = ((shadow?.metrics as Record<string, Record<string, Record<string, number | null>>> | undefined)?.metrics?.validation?.rocAuc) ?? null;
      const alerts: string[] = [];
      if (recentAuc !== null && validationAuc !== null && labelled.length >= 200 && recentAuc < validationAuc - 0.08) alerts.push('MODEL_PERFORMANCE_DRIFT');
      // Data drift: recent 24 h vs. the model's training period (median + missing rate of key features).
      let drift: Array<Record<string, unknown>> = [];
      const trainPeriod = (shadow?.metrics as { periods?: { train?: [number, number] } } | undefined)?.periods?.train;
      if (trainPeriod) {
        const features = ['liquidityUsd', 'volumeUsd', 'uniqueBuyers', 'launchScore', 'riskScore', 'largestHolderSupplyShare', 'telegramMomentum'];
        const stats = async (from: Date, to: Date) => Object.fromEntries(await Promise.all(features.map(async (feature) => {
          const [result] = await prisma.$queryRaw<Array<{ median: number | null; missing: number | null; n: number }>>`
            SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY (features->>${feature})::float) AS median,
                   avg(CASE WHEN features->>${feature} IS NULL THEN 1 ELSE 0 END)::float AS missing, count(*)::int AS n
            FROM "MlFeatureSnapshot" WHERE kind = 'AGE_30S' AND "snapshotAt" >= ${from} AND "snapshotAt" < ${to}`;
          return [feature, result];
        })));
        const training = await stats(new Date(trainPeriod[0]), new Date(trainPeriod[1]));
        const recent = await stats(new Date(Date.now() - 86_400_000), new Date());
        drift = features.map((feature) => {
          const a = training[feature];
          const b = recent[feature];
          const relative = a?.median && b?.median !== null && b?.median !== undefined ? (b.median - a.median) / Math.abs(a.median) : null;
          const missingShift = a?.missing !== null && b?.missing !== null && a && b ? (b.missing ?? 0) - (a.missing ?? 0) : null;
          const flagged = (relative !== null && Math.abs(relative) > 0.5) || (missingShift !== null && Math.abs(missingShift) > 0.2);
          return { feature, trainingMedian: a?.median ?? null, recentMedian: b?.median ?? null, relativeChange: relative, missingShift, flagged };
        });
        if (drift.some((item) => item.flagged)) alerts.push('MODEL_DATA_DRIFT');
      }
      return res.json({ ok: true, data: {
        label: 'HISTORICAL / SHADOW / PAPER RESEARCH',
        modelVersion: shadow?.version ?? null,
        sample: { candidates: rows.length, predicted: predicted.length, labelled: labelled.length },
        byDecision: bucket(rows, (row) => row.decision as 'BUY' | 'WATCH' | 'REJECT' | 'NOT_EVALUATED', ['BUY', 'WATCH', 'REJECT', 'NOT_EVALUATED']),
        matrix: [
          { key: 'SolTrader BUY / ML BUY', ...outcomeStats(predicted.filter((row) => strategyBuy(row) && mlBuy(row))) },
          { key: 'SolTrader BUY / ML SKIP', ...outcomeStats(predicted.filter((row) => strategyBuy(row) && !mlBuy(row))) },
          { key: 'SolTrader SKIP / ML BUY', ...outcomeStats(predicted.filter((row) => !strategyBuy(row) && mlBuy(row))) },
          { key: 'SolTrader SKIP / ML SKIP', ...outcomeStats(predicted.filter((row) => !strategyBuy(row) && !mlBuy(row))) },
        ],
        missedOpportunities: predicted.filter((row) => !strategyBuy(row) && (row.mlEntryScore ?? 0) >= 70 && (row.mfe30 ?? 0) >= 50).slice(0, 25),
        badEntries: predicted.filter((row) => strategyBuy(row) && (row.mlEntryScore ?? 100) < 30 && (row.mae30 ?? 0) <= -30).slice(0, 25),
        launchScoreByMl: cross(launchBucket, ['<70', '70–79', '80–89', '90–100']),
        entryAgeByMl: cross(ageBucket, ['0–10 mp', '11–30 mp', '31–60 mp', '61–90 mp']),
        socialByMl: cross((row) => (row.telegramMomentum === null ? 'TG nincs adat' : row.telegramMomentum >= 60 ? 'TG erős' : 'TG gyenge'), ['TG erős', 'TG gyenge', 'TG nincs adat']),
        bySource: bucket(predicted, (row) => row.source as 'PUMP_FUN' | 'RAYDIUM' | 'METEORA', ['PUMP_FUN', 'RAYDIUM', 'METEORA']),
        performance: { recentAuc, validationAuc, labelled: labelled.length },
        drift,
        alerts,
      } });
    } catch (error) {
      deps.logger.error({ err: error }, 'ML analytics failed');
      return fail(res, 500, 'ML analytics unavailable');
    }
  });

  router.get('/models/:version', async (req: Request, res: Response) => {
    const model = await prisma.mlModelVersion.findUnique({ where: { version: String(req.params.version) } });
    return model ? res.json({ ok: true, data: model }) : fail(res, 404, 'Model not found');
  });

  /** Explicit, admin-only, e-mail confirmed status change. This release: at most SHADOW (no PAPER_* / LIVE). */
  router.post('/models/:version/status', async (req: Request, res: Response) => {
    if (req.user?.role !== 'ADMIN') return fail(res, 403, 'Administrator authorization required');
    const parsed = z.object({ status: z.enum(['VALIDATED', 'SHADOW', 'RETIRED', 'PAPER_APPROVED', 'PAPER_ACTIVE']) }).safeParse(req.body ?? {});
    if (!parsed.success) return fail(res, 400, 'Invalid status');
    if (parsed.data.status.startsWith('PAPER')) return fail(res, 400, 'PAPER_APPROVED / PAPER_ACTIVE nem érhető el ebben a kiadásban (csak SHADOW).');
    try {
      const model = await prisma.mlModelVersion.findUnique({ where: { version: String(req.params.version) } });
      if (!model) return fail(res, 404, 'Model not found');
      if (!ALLOWED_TRANSITIONS[model.status]?.includes(parsed.data.status)) return fail(res, 400, `Nem engedélyezett átmenet: ${model.status} -> ${parsed.data.status}`);
      if (!await deps.stepUp(req, res, 'ml_model_status', { version: model.version, status: parsed.data.status })) return;
      const history = [...(model.statusHistory as unknown[] ?? []), { status: parsed.data.status, at: new Date().toISOString(), by: req.user!.email }];
      await prisma.$transaction(async (tx) => {
        // Only one SHADOW model at a time: the previous one goes back to VALIDATED.
        if (parsed.data.status === 'SHADOW') await tx.mlModelVersion.updateMany({ where: { status: 'SHADOW', NOT: { version: model.version } }, data: { status: 'VALIDATED' } });
        await tx.mlModelVersion.update({ where: { version: model.version }, data: { status: parsed.data.status, statusHistory: history as Prisma.InputJsonValue } });
      });
      await deps.logAuditEvent('ml_model_status_changed', req.user!.id, { modelVersion: model.version, from: model.status, to: parsed.data.status });
      return res.json({ ok: true, data: { version: model.version, status: parsed.data.status } });
    } catch (error) {
      deps.logger.error({ err: error }, 'ML model status change failed');
      return fail(res, 500, 'Status change failed');
    }
  });

  return router;
}
