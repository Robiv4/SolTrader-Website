/**
 * ML PAPER strategy: model PAPER approval (admin + e-mail, revocable), per-user strategy selection (DEFAULT | ML) and the
 * comparison / training-data analytics. PAPER only: nothing here can enable or reach LIVE trading.
 *
 * Rules:
 *  - SHADOW_READY readiness alone grants nothing: a model needs an explicit, separate PAPER approval by an administrator,
 *    confirmed by e-mail, after it has been tested in SHADOW (stored shadow predictions) with a verified artifact.
 *  - Switching a user to ML (or changing the model) requires an administrator + e-mail confirmation and an approved model.
 *    Switching back to DEFAULT is always allowed for the owner (it can only reduce automation).
 *  - A revoked / retired model stops ML entries immediately; users stay on ML without entries (no silent fallback buying).
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Prisma, type PrismaClient } from '@prisma/client';
import {
  effectiveMlMinLiquidityUsd, isSupportedFeatureVersion, ML_HONEYPOT_CODES, ML_MIN_LIQUIDITY_FLOOR_USD, ML_MIN_LIQUIDITY_MAX_USD, ML_MIN_LIQUIDITY_SUGGESTED_USD, ML_PAPER_SNAPSHOT_POINTS,
  ML_PAPER_THRESHOLD_MAX, ML_PAPER_THRESHOLD_MIN, ML_PAPER_WINDOW_MAX_SECONDS, mlBlockerCategory, mlBlockerGroup, resolveNewLaunchSettings,
} from '@soltrader/strategy-engine';
import { type Request, type Response, Router } from 'express';
import { z } from 'zod';

import type { StepUpGate } from './email-verification.js';
import { loadLiquidityAnalysisRows, summarizeLiquidityLevels } from './ml-liquidity-analysis.js';

/** Minimum number of stored SHADOW predictions before a model may be PAPER-approved. */
export const MIN_SHADOW_PREDICTIONS_FOR_PAPER = 100;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const fail = (res: Response, status: number, message: string, data?: unknown) => res.status(status).json({ ok: false, error: message, ...(data ? { data } : {}) });
const num = (value: unknown) => (value === null || value === undefined ? null : Number(value));
const record = (value: unknown) => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {});

export interface MlPaperDeps {
  prisma: PrismaClient;
  stepUp: StepUpGate;
  logAuditEvent: (action: string, userId: string | null, details?: Record<string, unknown>) => Promise<unknown>;
  readJson: (key: string) => Promise<Record<string, unknown> | null>;
  logger: { error(payload: unknown, message?: string): void };
  /** Server trading mode (env TRADING_MODE); ML PAPER is refused unless it is PAPER. */
  serverTradingMode: () => string;
  /** Test hook: artifact reader (default: repository file, sha256 verified by the caller). */
  readArtifact?: (artifactPath: string) => Promise<Buffer>;
}

type ModelRow = Awaited<ReturnType<PrismaClient['mlModelVersion']['findUnique']>> & object;

/** Validation summary shown next to a model (no artifact contents). */
export function modelSummary(model: ModelRow, snapshotKind: string | null) {
  const metrics = record(model.metrics);
  const split = record(metrics.metrics);
  const test = record(split.test);
  const validation = record(split.validation);
  return {
    version: model.version, algorithm: model.algorithm, status: model.status, readiness: model.readiness, target: model.target,
    datasetVersion: model.datasetVersion, featureVersion: model.featureVersion, snapshotKind, trainedAt: model.trainedAt,
    paperApproved: model.paperApproved, paperApprovedAt: model.paperApprovedAt, paperApprovedBy: model.paperApprovedBy, paperRevokedAt: model.paperRevokedAt,
    metrics: {
      testRocAuc: num(test.rocAuc), testPrAuc: num(test.prAuc), testPrecision: num(test.precision), testRecall: num(test.recall), testBrier: num(test.brier),
      testRows: num(test.n), validationRocAuc: num(validation.rocAuc), walkForwardAucStd: num(metrics.walkForwardAucStd), overfittingRisk: metrics.overfittingRisk ?? null,
    },
  };
}

/** Reasons a model cannot be PAPER-approved (empty = eligible for an explicit approval). */
export async function paperApprovalBlockers(prisma: PrismaClient, model: ModelRow, readArtifact: (artifactPath: string) => Promise<Buffer>) {
  const blockers: string[] = [];
  if (!['VALIDATED', 'SHADOW'].includes(model.status)) blockers.push(`STATUS_${model.status}`);
  if (model.readiness !== 'SHADOW_READY') blockers.push(`READINESS_${model.readiness}`);
  // Any feature schema the worker can build at decision time (v1 or ML-FEATURES-COMMUNITY-v1); the dataset must match it.
  if (!isSupportedFeatureVersion(model.featureVersion)) blockers.push('FEATURE_VERSION_MISMATCH');
  const history = Array.isArray(model.statusHistory) ? model.statusHistory as Array<{ status?: string }> : [];
  if (!history.some((entry) => entry.status === 'SHADOW')) blockers.push('NEVER_RUN_IN_SHADOW');
  const predictions = await prisma.mlPrediction.count({ where: { modelVersion: model.version } });
  if (predictions < MIN_SHADOW_PREDICTIONS_FOR_PAPER) blockers.push(`SHADOW_PREDICTIONS_${predictions}_BELOW_${MIN_SHADOW_PREDICTIONS_FOR_PAPER}`);
  const dataset = await prisma.mlDatasetVersion.findUnique({ where: { version: model.datasetVersion } });
  const kind = record(dataset?.config).snapshotKind;
  if (typeof kind !== 'string' || ML_PAPER_SNAPSHOT_POINTS[kind] === undefined) blockers.push('UNSUPPORTED_SNAPSHOT_KIND');
  if (!dataset || dataset.featureVersion !== model.featureVersion) blockers.push('DATASET_FEATURE_VERSION_MISMATCH');
  try {
    const content = await readArtifact(model.artifactPath);
    if (createHash('sha256').update(content).digest('hex') !== model.artifactHash) blockers.push('ARTIFACT_HASH_MISMATCH');
  } catch {
    blockers.push('ARTIFACT_MISSING');
  }
  return blockers;
}

async function snapshotKindOf(prisma: PrismaClient, datasetVersion: string) {
  const dataset = await prisma.mlDatasetVersion.findUnique({ where: { version: datasetVersion }, select: { config: true } }).catch(() => null);
  const kind = record(dataset?.config).snapshotKind;
  return typeof kind === 'string' ? kind : null;
}

interface ClosedTrade { netPnl: number; fees: number; slippage: number; exitAt: Date | null; entryStrategy: string; mlModelVersion: string | null }

/** PAPER trade statistics of one group (real closed trades only; never SHADOW labels). */
export function paperStats(rows: ClosedTrade[]) {
  const ordered = [...rows].sort((a, b) => (a.exitAt?.getTime() ?? 0) - (b.exitAt?.getTime() ?? 0));
  const nets = ordered.map((row) => row.netPnl);
  const wins = nets.filter((value) => value > 0);
  const grossProfit = wins.reduce((sum, value) => sum + value, 0);
  const grossLoss = -nets.filter((value) => value < 0).reduce((sum, value) => sum + value, 0);
  let peak = 0;
  let equity = 0;
  let maxDrawdown = 0;
  for (const value of nets) {
    equity += value;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
  }
  return {
    trades: rows.length,
    wins: wins.length,
    winRate: rows.length ? wins.length / rows.length : null,
    netPnl: nets.reduce((sum, value) => sum + value, 0),
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
    maxDrawdownUsd: maxDrawdown,
    fees: rows.reduce((sum, row) => sum + row.fees, 0),
    slippage: rows.reduce((sum, row) => sum + row.slippage, 0),
    sufficientSample: rows.length >= 30,
  };
}

export function createMlPaperRouter(deps: MlPaperDeps) {
  const { prisma } = deps;
  const router = Router();
  const readArtifact = deps.readArtifact ?? (async (artifactPath: string) => {
    const root = path.resolve(REPO_ROOT, 'ml', 'models');
    const file = path.resolve(REPO_ROOT, artifactPath);
    if (!file.startsWith(root)) throw new Error('Artifact path outside ml/models');
    return readFile(file);
  });

  // ---------------------------------------------------------------- model PAPER approval (admin + e-mail)
  router.get('/ml/models/:version/paper-approval', async (req: Request, res: Response) => {
    const model = await prisma.mlModelVersion.findUnique({ where: { version: String(req.params.version) } });
    if (!model) return fail(res, 404, 'Model not found');
    return res.json({ ok: true, data: { ...modelSummary(model, await snapshotKindOf(prisma, model.datasetVersion)), blockers: await paperApprovalBlockers(prisma, model, readArtifact) } });
  });

  router.post('/ml/models/:version/paper-approval', async (req: Request, res: Response) => {
    if (req.user?.role !== 'ADMIN') return fail(res, 403, 'Administrator authorization required');
    try {
      const model = await prisma.mlModelVersion.findUnique({ where: { version: String(req.params.version) } });
      if (!model) return fail(res, 404, 'Model not found');
      if (model.paperApproved) return fail(res, 409, 'A modell már PAPER-jóváhagyott.');
      const blockers = await paperApprovalBlockers(prisma, model, readArtifact);
      if (blockers.length) return fail(res, 409, 'A modell nem hagyható jóvá PAPER kereskedésre.', { blockers });
      if (!await deps.stepUp(req, res, 'ml_paper_approve', { version: model.version })) return;
      const history = [...(Array.isArray(model.statusHistory) ? model.statusHistory : []), { event: 'PAPER_APPROVED', at: new Date().toISOString(), by: req.user!.email }];
      await prisma.mlModelVersion.update({ where: { version: model.version }, data: { paperApproved: true, paperApprovedAt: new Date(), paperApprovedBy: req.user!.email, paperRevokedAt: null, paperRevokedBy: null, statusHistory: history as Prisma.InputJsonValue } });
      await deps.logAuditEvent('ml_model_paper_approved', req.user!.id, { modelVersion: model.version, readiness: model.readiness, status: model.status });
      return res.json({ ok: true, data: { version: model.version, paperApproved: true } });
    } catch (error) {
      deps.logger.error({ err: error }, 'ML PAPER approval failed');
      return fail(res, 500, 'PAPER approval failed');
    }
  });

  /** Revocation is always possible for an administrator (it only removes ML entries). */
  router.delete('/ml/models/:version/paper-approval', async (req: Request, res: Response) => {
    if (req.user?.role !== 'ADMIN') return fail(res, 403, 'Administrator authorization required');
    try {
      const model = await prisma.mlModelVersion.findUnique({ where: { version: String(req.params.version) } });
      if (!model) return fail(res, 404, 'Model not found');
      const history = [...(Array.isArray(model.statusHistory) ? model.statusHistory : []), { event: 'PAPER_REVOKED', at: new Date().toISOString(), by: req.user!.email }];
      await prisma.mlModelVersion.update({ where: { version: model.version }, data: { paperApproved: false, paperRevokedAt: new Date(), paperRevokedBy: req.user!.email, statusHistory: history as Prisma.InputJsonValue } });
      const affected = await prisma.mlPaperSettings.count({ where: { strategyMode: 'ML', modelVersion: model.version } });
      await deps.logAuditEvent('ml_model_paper_revoked', req.user!.id, { modelVersion: model.version, usersOnModel: affected });
      return res.json({ ok: true, data: { version: model.version, paperApproved: false, usersOnModel: affected } });
    } catch (error) {
      deps.logger.error({ err: error }, 'ML PAPER revocation failed');
      return fail(res, 500, 'PAPER revocation failed');
    }
  });

  // ---------------------------------------------------------------- per-user strategy selection
  async function settingsView(userId: string, isAdmin: boolean) {
    const [row, bot, approved, decisions, lastPrediction, health, newLaunch] = await Promise.all([
      prisma.mlPaperSettings.findUnique({ where: { userId } }),
      prisma.botConfig.findUnique({ where: { userId }, select: { tradingMode: true, isLiveEnabled: true } }),
      prisma.mlModelVersion.findMany({ where: { paperApproved: true, status: { not: 'RETIRED' } }, orderBy: { trainedAt: 'desc' } }),
      prisma.mlPaperDecision.groupBy({ by: ['mlDecision'], where: { userId, decidedAt: { gte: new Date(Date.now() - 86_400_000) } }, _count: { _all: true } }),
      prisma.mlPaperDecision.findFirst({ where: { userId, probability: { not: null } }, orderBy: { decidedAt: 'desc' }, select: { decidedAt: true, modelVersion: true, probability: true, mlDecision: true, mint: true, outcome: true } }),
      deps.readJson('ml:paper:health').catch(() => null),
      prisma.newLaunchConfig.findUnique({ where: { userId } }).catch(() => null),
    ]);
    const defaultMinLiquidityUsd = resolveNewLaunchSettings(newLaunch as unknown as Record<string, unknown> | null).minLiquidityUsd;
    const savedMinLiquidity = row?.minLiquidityUsd === null || row?.minLiquidityUsd === undefined ? null : Number(row.minLiquidityUsd);
    const selected = row?.modelVersion ? await prisma.mlModelVersion.findUnique({ where: { version: row.modelVersion } }) : null;
    const models = await Promise.all(approved.map(async (model) => modelSummary(model, await snapshotKindOf(prisma, model.datasetVersion))));
    const mode = row?.strategyMode === 'ML' ? 'ML' : 'DEFAULT';
    const selectedHealth = row?.modelVersion ? record(record(health?.models)[row.modelVersion]) : {};
    const enableBlockers: string[] = [];
    if (!isAdmin) enableBlockers.push('ADMIN_REQUIRED');
    if (models.length === 0) enableBlockers.push('NO_PAPER_APPROVED_MODEL');
    if (bot?.tradingMode !== 'PAPER' || bot?.isLiveEnabled) enableBlockers.push('PAPER_MODE_REQUIRED');
    if (deps.serverTradingMode() !== 'PAPER') enableBlockers.push('SERVER_NOT_PAPER');
    return {
      strategyMode: mode,
      modelVersion: row?.modelVersion ?? null,
      buyThreshold: row ? Number(row.buyThreshold) : 0.7,
      decisionWindowSeconds: row?.decisionWindowSeconds ?? 10,
      /** ML PAPER minimum liquidity: saved value (null = not set) and the minimum actually applied to ML entries. */
      minLiquidity: {
        savedUsd: savedMinLiquidity,
        effectiveUsd: effectiveMlMinLiquidityUsd(savedMinLiquidity, defaultMinLiquidityUsd),
        defaultStrategyUsd: defaultMinLiquidityUsd,
        suggestedUsd: ML_MIN_LIQUIDITY_SUGGESTED_USD,
        floorUsd: ML_MIN_LIQUIDITY_FLOOR_USD,
        maxUsd: ML_MIN_LIQUIDITY_MAX_USD,
      },
      enabledAt: row?.enabledAt ?? null,
      enabledBy: row?.enabledBy ?? null,
      limits: { thresholdMin: ML_PAPER_THRESHOLD_MIN, thresholdMax: ML_PAPER_THRESHOLD_MAX, windowMaxSeconds: ML_PAPER_WINDOW_MAX_SECONDS },
      selectedModel: selected ? { ...modelSummary(selected, await snapshotKindOf(prisma, selected.datasetVersion)), usable: selected.paperApproved && selected.status !== 'RETIRED' } : null,
      approvedModels: models,
      health: health ? { at: health.at ?? null, model: Object.keys(selectedHealth).length ? selectedHealth : null, engine: health.engine ?? null } : null,
      lastPrediction: lastPrediction ? { ...lastPrediction, probability: num(lastPrediction.probability) } : null,
      decisions24h: Object.fromEntries(decisions.map((item) => [item.mlDecision, item._count._all])),
      canEnable: enableBlockers.length === 0,
      enableBlockers,
      liveTrading: 'DISABLED',
    };
  }

  router.get('/settings/ml-paper', async (req: Request, res: Response) => {
    try {
      return res.json({ ok: true, data: await settingsView(req.user!.id, req.user!.role === 'ADMIN') });
    } catch (error) {
      deps.logger.error({ err: error }, 'ML PAPER settings failed');
      return fail(res, 500, 'ML PAPER settings unavailable');
    }
  });

  const updateSchema = z.object({
    strategyMode: z.enum(['DEFAULT', 'ML']),
    modelVersion: z.string().min(1).max(120).nullable().optional(),
    buyThreshold: z.number().min(ML_PAPER_THRESHOLD_MIN).max(ML_PAPER_THRESHOLD_MAX).optional(),
    decisionWindowSeconds: z.number().int().min(2).max(ML_PAPER_WINDOW_MAX_SECONDS).optional(),
    /** ML PAPER minimum liquidity (USD); null = back to the DEFAULT minimum. Never below the execution floor. */
    minLiquidityUsd: z.number().min(ML_MIN_LIQUIDITY_FLOOR_USD).max(ML_MIN_LIQUIDITY_MAX_USD).nullable().optional(),
  }).strict();

  router.put('/settings/ml-paper', async (req: Request, res: Response) => {
    const body = { ...(req.body ?? {}) } as Record<string, unknown>;
    delete body.verification;
    const parsed = updateSchema.safeParse(body);
    if (!parsed.success) return fail(res, 400, 'Érvénytelen ML PAPER beállítás', parsed.error.issues);
    const userId = req.user!.id;
    try {
      const current = await prisma.mlPaperSettings.findUnique({ where: { userId } });
      const data = parsed.data;
      if (data.strategyMode === 'DEFAULT') {
        // Back to the rule-based strategy: always allowed for the owner (no ML entries afterwards). Model / threshold kept.
        const row = await prisma.mlPaperSettings.upsert({ where: { userId }, update: { strategyMode: 'DEFAULT' }, create: { userId, strategyMode: 'DEFAULT' } });
        if (current?.strategyMode === 'ML') await deps.logAuditEvent('ml_paper_strategy_disabled', userId, { modelVersion: current.modelVersion });
        return res.json({ ok: true, data: { ...(await settingsView(userId, req.user!.role === 'ADMIN')), updatedAt: row.updatedAt } });
      }
      if (req.user!.role !== 'ADMIN') return fail(res, 403, 'Az ML PAPER mód bekapcsolása adminisztrátori jogosultságot igényel.');
      const modelVersion = data.modelVersion ?? current?.modelVersion ?? null;
      if (!modelVersion) return fail(res, 400, 'Válassz modellverziót.');
      const model = await prisma.mlModelVersion.findUnique({ where: { version: modelVersion } });
      if (!model || !model.paperApproved || model.status === 'RETIRED') return fail(res, 409, 'Csak PAPER-jóváhagyott, nem visszavont modell választható.');
      const bot = await prisma.botConfig.findUnique({ where: { userId }, select: { tradingMode: true, isLiveEnabled: true } });
      if (bot?.tradingMode !== 'PAPER' || bot?.isLiveEnabled || deps.serverTradingMode() !== 'PAPER') return fail(res, 409, 'ML PAPER csak PAPER kereskedési módban (LIVE kikapcsolva) használható.');
      const threshold = data.buyThreshold ?? (current ? Number(current.buyThreshold) : 0.7);
      const window = data.decisionWindowSeconds ?? current?.decisionWindowSeconds ?? 10;
      const previousMinLiquidity = current?.minLiquidityUsd === null || current?.minLiquidityUsd === undefined ? null : Number(current.minLiquidityUsd);
      const minLiquidity = data.minLiquidityUsd === undefined ? previousMinLiquidity : data.minLiquidityUsd === null ? null : Math.round(data.minLiquidityUsd * 100) / 100;
      const switching = current?.strategyMode !== 'ML' || current?.modelVersion !== modelVersion;
      // Turning ML on or changing the model needs an e-mail confirmed administrator action; threshold tuning while ML runs does not.
      if (switching && !await deps.stepUp(req, res, 'ml_paper_enable', { modelVersion, buyThreshold: threshold, decisionWindowSeconds: window })) return;
      await prisma.mlPaperSettings.upsert({
        where: { userId },
        update: { strategyMode: 'ML', modelVersion, buyThreshold: new Prisma.Decimal(threshold.toFixed(3)), decisionWindowSeconds: window, minLiquidityUsd: minLiquidity === null ? null : new Prisma.Decimal(minLiquidity.toFixed(2)), ...(switching ? { enabledAt: new Date(), enabledBy: req.user!.email } : {}) },
        create: { userId, strategyMode: 'ML', modelVersion, buyThreshold: new Prisma.Decimal(threshold.toFixed(3)), decisionWindowSeconds: window, minLiquidityUsd: minLiquidity === null ? null : new Prisma.Decimal(minLiquidity.toFixed(2)), enabledAt: new Date(), enabledBy: req.user!.email },
      });
      if (minLiquidity !== previousMinLiquidity) await deps.logAuditEvent('ml_paper_min_liquidity_update', userId, { previousUsd: previousMinLiquidity, newUsd: minLiquidity, modelVersion });
      await deps.logAuditEvent(switching ? 'ml_paper_strategy_enabled' : 'ml_paper_settings_update', userId, { modelVersion, buyThreshold: threshold, decisionWindowSeconds: window, previous: current ? { mode: current.strategyMode, modelVersion: current.modelVersion } : null });
      return res.json({ ok: true, data: await settingsView(userId, true) });
    } catch (error) {
      deps.logger.error({ err: error }, 'ML PAPER settings update failed');
      return fail(res, 500, 'ML PAPER settings update failed');
    }
  });

  // ---------------------------------------------------------------- comparison + training data analytics
  router.get('/ml/paper', async (req: Request, res: Response) => {
    try {
      const userId = req.user!.id;
      const sinceDays = Math.min(365, Math.max(1, Number(req.query.days ?? 90) || 90));
      const since = new Date(Date.now() - sinceDays * 86_400_000);
      const trades = await prisma.trade.findMany({
        where: { userId, decisionSource: 'NEW_LAUNCH', status: 'CLOSED', mode: 'PAPER', exitAt: { gte: since } },
        select: { netPnl: true, fees: true, slippage: true, exitAt: true, entryStrategy: true, mlModelVersion: true },
      });
      const closed: ClosedTrade[] = trades.map((trade) => ({ netPnl: Number(trade.netPnl ?? 0), fees: Number(trade.fees ?? 0), slippage: Number(trade.slippage ?? 0), exitAt: trade.exitAt, entryStrategy: trade.entryStrategy ?? 'DEFAULT', mlModelVersion: trade.mlModelVersion }));
      const mlTrades = closed.filter((trade) => trade.entryStrategy === 'ML');
      const byModel = [...new Set(mlTrades.map((trade) => trade.mlModelVersion ?? 'ismeretlen'))].map((version) => ({ modelVersion: version, ...paperStats(mlTrades.filter((trade) => (trade.mlModelVersion ?? 'ismeretlen') === version)) }));
      // SHADOW predictions (every candidate, no trading) - kept apart from ML PAPER decisions and closed PAPER trades.
      const shadowGroups = await prisma.mlPrediction.groupBy({ by: ['modelVersion', 'predictedClass'], where: { predictedAt: { gte: since } }, _count: { _all: true } }).catch(() => []);
      const [decisionGroups, outcomeGroups, openMl] = await Promise.all([
        prisma.mlPaperDecision.groupBy({ by: ['modelVersion', 'mlDecision'], where: { userId, decidedAt: { gte: since } }, _count: { _all: true } }),
        prisma.mlPaperDecision.groupBy({ by: ['outcome'], where: { userId, decidedAt: { gte: since }, mlDecision: 'ML_BUY' }, _count: { _all: true } }),
        prisma.trade.count({ where: { userId, decisionSource: 'NEW_LAUNCH', status: 'OPEN', entryStrategy: 'ML' } }),
      ]);
      const recentDecisions = await prisma.mlPaperDecision.findMany({
        where: { userId, decidedAt: { gte: since } }, orderBy: { decidedAt: 'desc' }, take: 50,
        select: { id: true, mint: true, modelVersion: true, decidedAt: true, snapshotKind: true, probability: true, threshold: true, mlDecision: true, errorReason: true, baseDecision: true, baseReasons: true, outcome: true, executionReason: true, safetyBlockers: true, positionId: true, minLiquidityUsd: true, liquidityUsd: true, sellability: true },
      });

      // ML BUY funnel: signals -> blocked by fraud / honeypot protection -> blocked by market / risk / execution -> opened.
      const mlBuys = await prisma.mlPaperDecision.findMany({ where: { userId, decidedAt: { gte: since }, mlDecision: 'ML_BUY' }, select: { outcome: true, safetyBlockers: true, executionReason: true } });
      const blockersOf = (row: { safetyBlockers: unknown }) => (Array.isArray(row.safetyBlockers) ? row.safetyBlockers.map(String) : []);
      const unresolvedByToken = (row: { outcome: string; safetyBlockers: unknown }) => (row.outcome === 'SAFETY_BLOCKED' || row.outcome === 'EXPIRED') && blockersOf(row).some((code) => mlBlockerCategory(code) === 'TOKEN_SECURITY');
      // Blocker groups are NOT exclusive (one ML BUY can have several reasons): the groups can add up to more than the
      // number of blocked decisions. "only*" counts the decisions blocked by that group alone.
      const unresolved = mlBuys.filter((row) => row.outcome === 'SAFETY_BLOCKED' || row.outcome === 'EXPIRED');
      const groupsOf = (row: { safetyBlockers: unknown }) => new Set(blockersOf(row).map((code) => mlBlockerGroup(code)));
      const inGroup = (group: ReturnType<typeof mlBlockerGroup>) => unresolved.filter((row) => groupsOf(row).has(group)).length;
      const onlyGroup = (group: ReturnType<typeof mlBlockerGroup>) => unresolved.filter((row) => { const groups = groupsOf(row); return groups.size === 1 && groups.has(group); }).length;
      const funnel = {
        mlBuy: mlBuys.length,
        signaled: mlBuys.filter((row) => ['SIGNALED', 'EXECUTED', 'EXECUTION_REJECTED'].includes(row.outcome)).length,
        blocked: unresolved.length,
        blockedByLiquidityMinimum: inGroup('LIQUIDITY_MINIMUM'),
        onlyLiquidityMinimum: onlyGroup('LIQUIDITY_MINIMUM'),
        blockedByTokenSecurity: mlBuys.filter(unresolvedByToken).length,
        honeypotBlocked: mlBuys.filter((row) => blockersOf(row).some((code) => ML_HONEYPOT_CODES.has(code))).length,
        blockedByCriticalLiquidity: inGroup('CRITICAL_LIQUIDITY'),
        blockedByPriceImpact: inGroup('PRICE_IMPACT'),
        blockedByOtherRiskOrExpiry: unresolved.filter((row) => { const groups = groupsOf(row); return groups.size === 0 || groups.has('OTHER'); }).length,
        // Kept for older clients: blocked without any fraud / honeypot reason.
        blockedByMarketOrRisk: unresolved.filter((row) => !unresolvedByToken(row)).length,
        executionRejected: mlBuys.filter((row) => row.outcome === 'EXECUTION_REJECTED').length,
        positionsOpened: mlBuys.filter((row) => row.outcome === 'EXECUTED').length,
        pending: mlBuys.filter((row) => row.outcome === 'PENDING').length,
        overlappingReasons: true,
      };
      // Analysis only: how other minimum-liquidity levels would have filtered the same ML BUYs (no trade results).
      const liquidityComparison = summarizeLiquidityLevels(await loadLiquidityAnalysisRows(prisma, userId, since).catch(() => []));
      // Applied ML minimum of closed ML trades (statistics per minimum; older ML trades = not recorded).
      const appliedMinimum = await prisma.trade.groupBy({ by: ['mlMinLiquidityUsd'], where: { userId, entryStrategy: 'ML', mode: 'PAPER', exitAt: { gte: since } }, _count: { _all: true }, _sum: { netPnl: true } }).catch(() => []);
      // Position / P&L of executed ML decisions (model version recorded on the trade).
      const decisionTrades = await prisma.trade.findMany({ where: { userId, mlPaperDecisionId: { in: recentDecisions.map((item) => item.id) } }, select: { id: true, mlPaperDecisionId: true, mlModelVersion: true, positionId: true, status: true, netPnl: true, exitReason: true } });
      const tradeByDecision = new Map(decisionTrades.map((trade) => [trade.mlPaperDecisionId, { id: trade.id, positionId: trade.positionId, modelVersion: trade.mlModelVersion, status: trade.status, netPnl: num(trade.netPnl), exitReason: trade.exitReason }]));
      const tokenSecurityOf = (item: { mlDecision: string; outcome: string; safetyBlockers: unknown }) => {
        if (item.mlDecision !== 'ML_BUY') return { status: 'NOT_CHECKED', blockers: [] as string[], honeypot: false };
        const tokenBlockers = blockersOf(item).filter((code) => mlBlockerCategory(code) === 'TOKEN_SECURITY');
        if (tokenBlockers.length) return { status: 'BLOCKED', blockers: tokenBlockers, honeypot: tokenBlockers.some((code) => ML_HONEYPOT_CODES.has(code)) };
        return { status: ['SIGNALED', 'EXECUTED', 'EXECUTION_REJECTED'].includes(item.outcome) ? 'PASSED' : 'PENDING', blockers: [] as string[], honeypot: false };
      };

      // Training data (SHADOW collection; all candidates, independent of the active strategy).
      const [snapshotKinds, outcomes, validity, lastDataset, mlTradesClosed] = await Promise.all([
        prisma.mlFeatureSnapshot.groupBy({ by: ['kind'], _count: { _all: true } }),
        prisma.mlCandidateOutcome.groupBy({ by: ['status'], _count: { _all: true } }),
        prisma.mlFeatureSnapshot.groupBy({ by: ['validForTraining'], where: { kind: 'AGE_30S' }, _count: { _all: true } }),
        prisma.mlDatasetVersion.findFirst({ orderBy: { createdAt: 'desc' }, select: { version: true, createdAt: true, rowCount: true, manifest: true } }),
        prisma.trade.count({ where: { decisionSource: 'NEW_LAUNCH', status: 'CLOSED', entryStrategy: 'ML' } }),
      ]);
      const sinceLastDataset = lastDataset ? await prisma.mlFeatureSnapshot.count({ where: { kind: 'AGE_30S', validForTraining: true, createdAt: { gt: lastDataset.createdAt } } }) : null;
      const range = await prisma.mlFeatureSnapshot.aggregate({ where: { kind: 'AGE_30S', validForTraining: true }, _min: { snapshotAt: true }, _max: { snapshotAt: true }, _count: { _all: true } });
      const labelled = await prisma.mlCandidateOutcome.count({ where: { status: { in: ['COMPLETE', 'PARTIAL'] }, snapshot: { kind: 'AGE_30S', validForTraining: true } } });
      const invalidReasons = await prisma.$queryRaw<Array<{ reason: string; n: number }>>`
        SELECT reason, count(*)::int AS n FROM "MlFeatureSnapshot", jsonb_array_elements_text("invalidReasons") AS reason
        WHERE kind = 'AGE_30S' AND "validForTraining" = false GROUP BY reason ORDER BY n DESC LIMIT 8`;
      const outcomeCounts = Object.fromEntries(outcomes.map((item) => [item.status, item._count._all]));
      const issues: string[] = [];
      if ((outcomeCounts.INSUFFICIENT ?? 0) > (outcomeCounts.COMPLETE ?? 0)) issues.push('Több az elégtelen (INSUFFICIENT) kimenet, mint a teljes: stream-kiesések vagy lejárt követés.');
      if (labelled < 1000) issues.push(`Kevés címkézett AGE_30S jelölt (${labelled}); megbízható tanításhoz legalább 1000 kell (és ≥ 50 pozitív).`);
      for (const item of invalidReasons.slice(0, 3)) issues.push(`Tanításra alkalmatlan snapshotok fő oka: ${item.reason} (${item.n} db).`);

      return res.json({ ok: true, data: {
        label: 'PAPER RESULTS (real closed PAPER trades) - separate from SHADOW labels',
        periodDays: sinceDays,
        strategies: { DEFAULT: paperStats(closed.filter((trade) => trade.entryStrategy !== 'ML')), ML: paperStats(mlTrades) },
        byModel,
        openMlPositions: openMl,
        /** The ML strategy decides entries only; exits are made by the common rule-based Exit Engine (no ML SELL model). */
        exitMode: 'RULE_BASED',
        shadowPredictions: shadowGroups.map((item) => ({ modelVersion: item.modelVersion, predictedClass: item.predictedClass, count: item._count._all })),
        decisions: decisionGroups.map((item) => ({ modelVersion: item.modelVersion, mlDecision: item.mlDecision, count: item._count._all })),
        mlBuyOutcomes: Object.fromEntries(outcomeGroups.map((item) => [item.outcome, item._count._all])),
        liquidityComparison,
        mlTradesByMinLiquidity: appliedMinimum.map((item) => ({ minLiquidityUsd: num(item.mlMinLiquidityUsd), trades: item._count._all, netPnl: num(item._sum.netPnl) })),
        recentDecisions: recentDecisions.map((item) => ({ ...item, probability: num(item.probability), threshold: num(item.threshold), minLiquidityUsd: num(item.minLiquidityUsd), liquidityUsd: num(item.liquidityUsd), tokenSecurity: tokenSecurityOf(item), trade: tradeByDecision.get(item.id) ?? null })),
        mlFunnel: funnel,
        training: {
          label: 'SHADOW TRAINING DATA (all New Launch candidates, independent of the active strategy)',
          snapshots: Object.fromEntries(snapshotKinds.map((item) => [item.kind, item._count._all])),
          outcomes: outcomeCounts,
          validForTraining: Object.fromEntries(validity.map((item) => [String(item.validForTraining), item._count._all])),
          labelledCandidates: labelled,
          coverage: { from: range._min.snapshotAt, to: range._max.snapshotAt, candidates: range._count._all },
          mlPaperTradesClosed: mlTradesClosed,
          lastDataset: lastDataset ? { version: lastDataset.version, createdAt: lastDataset.createdAt, rows: lastDataset.rowCount, readiness: record(lastDataset.manifest).readiness ?? null } : null,
          newValidCandidatesSinceLastDataset: sinceLastDataset,
          qualityIssues: issues,
          invalidReasons,
        },
      } });
    } catch (error) {
      deps.logger.error({ err: error }, 'ML PAPER analytics failed');
      return fail(res, 500, 'ML PAPER analytics unavailable');
    }
  });

  return router;
}
