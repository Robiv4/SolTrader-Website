/**
 * Community Intelligence + Community ML PAPER read endpoints (signed-in users, own data only; nothing here trades or
 * changes settings):
 *   GET /community/health           provider status published by the worker (Redis community:health; never contains keys)
 *   GET /community/ml-dashboard     per-token decisions with the community snapshot known at decision time, hourly funnel,
 *                                   Community model vs ML-FEATURES-v1 (v3) model comparison
 *   GET /positions/stuck-diagnostics  open PAPER positions: hold time, max-hold state, stale quotes, position-limit impact
 */
import type { PrismaClient } from '@prisma/client';
import { ML_COMMUNITY_FEATURE_VERSION, ML_FEATURE_VERSION } from '@soltrader/strategy-engine';
import { type Request, type Response, Router } from 'express';

import { paperStats } from './ml-paper.js';

type Deps = {
  prisma: PrismaClient;
  readJson: (key: string) => Promise<Record<string, unknown> | null>;
  logger: { error: (object: unknown, message?: string) => void };
};

const num = (value: unknown) => (value === null || value === undefined ? null : Number(value));
const record = (value: unknown) => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {});
const fail = (res: Response, status: number, message: string) => res.status(status).json({ ok: false, error: message });
const HOUR = 3_600_000;
/** A position open longer than this without max hold is reported as "stuck" (diagnostic only; nothing is closed). */
export const STUCK_POSITION_AFTER_MS = 2 * HOUR;

export function stopLossRate(rows: Array<{ exitReason: string | null }>) {
  if (!rows.length) return null;
  return rows.filter((row) => (row.exitReason ?? '').toUpperCase().startsWith('STOP_LOSS')).length / rows.length;
}

export function createCommunityMlRouter(deps: Deps) {
  const { prisma } = deps;
  const router = Router();

  router.get('/community/health', async (_req: Request, res: Response) => {
    const health = await deps.readJson('community:health').catch(() => null);
    return res.json({ ok: true, data: { available: Boolean(health), health } });
  });

  router.get('/community/ml-dashboard', async (req: Request, res: Response) => {
    try {
      const userId = req.user!.id;
      const hours = Math.min(168, Math.max(1, Number(req.query.hours ?? 24) || 24));
      const since = new Date(Date.now() - hours * HOUR);
      const models = await prisma.mlModelVersion.findMany({
        select: { version: true, featureVersion: true, status: true, readiness: true, paperApproved: true, datasetVersion: true, trainedAt: true, metrics: true },
        orderBy: { trainedAt: 'desc' },
      });
      const featureOf = new Map(models.map((model) => [model.version, model.featureVersion]));
      const datasets = await prisma.mlDatasetVersion.findMany({ where: { version: { in: [...new Set(models.map((model) => model.datasetVersion))] } }, select: { version: true, rowCount: true, manifest: true } });
      const datasetOf = new Map(datasets.map((dataset) => [dataset.version, dataset]));

      const decisions = await prisma.mlPaperDecision.findMany({
        where: { userId, decidedAt: { gte: since } }, orderBy: { decidedAt: 'desc' }, take: 500,
        select: { id: true, mint: true, modelVersion: true, featureVersion: true, decidedAt: true, probability: true, threshold: true, mlDecision: true, safetyBlockers: true, outcome: true, executionReason: true, positionId: true },
      });
      const mints = [...new Set(decisions.map((row) => row.mint))];
      const [tokens, snapshots, trades, positions] = await Promise.all([
        prisma.token.findMany({ where: { address: { in: mints } }, select: { address: true, symbol: true, name: true } }),
        prisma.communitySnapshot.findMany({
          where: { mint: { in: mints }, at: { gte: new Date(since.getTime() - HOUR) } }, orderBy: { at: 'desc' },
          select: { mint: true, at: true, quality: true, communityScore: true, socialMomentum: true, spamScore: true, onchainBuyers5m: true, buyerConcentration: true, coverage: true, paidPromotion: true },
        }),
        prisma.trade.findMany({ where: { userId, mlPaperDecisionId: { in: decisions.map((row) => row.id) } }, select: { mlPaperDecisionId: true, status: true, netPnl: true, exitReason: true, side: true } }),
        prisma.position.findMany({ where: { userId, id: { in: decisions.map((row) => row.positionId).filter((id): id is string => Boolean(id)) } }, select: { id: true, status: true } }),
      ]);
      const tokenOf = new Map(tokens.map((token) => [token.address, token]));
      const positionOf = new Map(positions.map((position) => [position.id, position.status]));
      // Community data known at decision time: newest stored snapshot with at <= decidedAt (never a later one).
      const snapshotAt = (mint: string, decidedAt: Date) => snapshots.find((row) => row.mint === mint && row.at.getTime() <= decidedAt.getTime()) ?? null;
      const rows = decisions.map((row) => {
        const ownTrades = trades.filter((trade) => trade.mlPaperDecisionId === row.id);
        const closing = ownTrades.find((trade) => trade.status === 'CLOSED' && trade.netPnl !== null) ?? null;
        const community = snapshotAt(row.mint, row.decidedAt);
        return {
          id: row.id, mint: row.mint, symbol: tokenOf.get(row.mint)?.symbol ?? null, name: tokenOf.get(row.mint)?.name ?? null,
          modelVersion: row.modelVersion, featureVersion: row.featureVersion, decidedAt: row.decidedAt,
          probability: num(row.probability), threshold: num(row.threshold), mlDecision: row.mlDecision,
          safetyBlockers: Array.isArray(row.safetyBlockers) ? row.safetyBlockers.map(String) : [], outcome: row.outcome, executionReason: row.executionReason,
          positionStatus: row.positionId ? positionOf.get(row.positionId) ?? null : null,
          netPnl: closing ? Number(closing.netPnl) : null, exitReason: closing?.exitReason ?? null,
          community: community ? {
            at: community.at, quality: community.quality, communityScore: num(community.communityScore), socialMomentum: num(community.socialMomentum), spamScore: num(community.spamScore),
            onchainBuyers5m: community.onchainBuyers5m, buyerConcentration: num(community.buyerConcentration), coverage: num(community.coverage), paidPromotion: community.paidPromotion,
          } : null,
        };
      });

      const closedTrades = await prisma.trade.findMany({
        where: { userId, decisionSource: 'NEW_LAUNCH', mode: 'PAPER', status: 'CLOSED', entryStrategy: 'ML', exitAt: { gte: since } },
        select: { netPnl: true, fees: true, slippage: true, exitAt: true, exitReason: true, mlModelVersion: true },
      });
      const hourly = Array.from({ length: hours }, (_, index) => {
        const start = Math.floor(Date.now() / HOUR) * HOUR - (hours - 1 - index) * HOUR;
        const inHour = (date: Date | null) => Boolean(date) && date!.getTime() >= start && date!.getTime() < start + HOUR;
        const ds = decisions.filter((row) => inHour(row.decidedAt));
        const ts = closedTrades.filter((trade) => inHour(trade.exitAt));
        const nets = ts.map((trade) => Number(trade.netPnl ?? 0));
        return {
          hourStart: new Date(start).toISOString(),
          processed: ds.length,
          mlBuy: ds.filter((row) => row.mlDecision === 'ML_BUY').length,
          safetyBlocked: ds.filter((row) => row.outcome === 'SAFETY_BLOCKED').length,
          executionRejected: ds.filter((row) => row.outcome === 'EXECUTION_REJECTED').length,
          executed: ds.filter((row) => row.outcome === 'EXECUTED').length,
          wins: nets.filter((value) => value > 0).length,
          losses: nets.filter((value) => value <= 0).length,
          netPnl: nets.reduce((sum, value) => sum + value, 0),
        };
      });

      const statsFor = (featureVersion: string) => {
        const versions = new Set(models.filter((model) => model.featureVersion === featureVersion).map((model) => model.version));
        const own = closedTrades.filter((trade) => trade.mlModelVersion && versions.has(trade.mlModelVersion));
        const ownDecisions = decisions.filter((row) => featureOf.get(row.modelVersion) === featureVersion);
        return {
          featureVersion,
          models: [...versions],
          decisions: ownDecisions.length,
          mlBuy: ownDecisions.filter((row) => row.mlDecision === 'ML_BUY').length,
          ...paperStats(own.map((trade) => ({ netPnl: Number(trade.netPnl ?? 0), fees: Number(trade.fees ?? 0), slippage: Number(trade.slippage ?? 0), exitAt: trade.exitAt, entryStrategy: 'ML', mlModelVersion: trade.mlModelVersion }))),
          stopLossRate: stopLossRate(own),
        };
      };

      const communityModels = models.filter((model) => model.featureVersion === ML_COMMUNITY_FEATURE_VERSION).map(async (model) => {
        const dataset = datasetOf.get(model.datasetVersion);
        const manifest = record(dataset?.manifest);
        return {
          version: model.version, status: model.status, readiness: model.readiness, paperApproved: model.paperApproved, featureVersion: model.featureVersion,
          datasetVersion: model.datasetVersion, datasetRows: dataset?.rowCount ?? null, trainedAt: model.trainedAt,
          communityCoverage: manifest.communityCoverage ?? null, simulatedExit: manifest.simulatedExit ?? null,
          shadowPredictions: await prisma.mlPrediction.count({ where: { modelVersion: model.version } }),
        };
      });

      const resolvedModels = await Promise.all(communityModels);
      return res.json({
        ok: true,
        data: {
          hours,
          featureVersions: { community: ML_COMMUNITY_FEATURE_VERSION, baseline: ML_FEATURE_VERSION },
          communityModels: resolvedModels,
          comparison: { community: statsFor(ML_COMMUNITY_FEATURE_VERSION), baseline: statsFor(ML_FEATURE_VERSION) },
          hourly,
          tokens: rows.slice(0, 200),
          communityCoverageOfDecisions: rows.length ? rows.filter((row) => row.community && row.community.quality !== 'NO_DATA').length / rows.length : null,
        },
      });
    } catch (error) {
      deps.logger.error({ err: error }, 'Community ML dashboard failed');
      return fail(res, 500, 'Community ML dashboard failed');
    }
  });

  router.get('/positions/stuck-diagnostics', async (req: Request, res: Response) => {
    try {
      const userId = req.user!.id;
      const now = Date.now();
      const [config, open, exitMonitor] = await Promise.all([
        prisma.newLaunchConfig.findUnique({ where: { userId }, select: { maxHoldEnabled: true, maxHoldMinutes: true, maxConcurrentPositions: true } }),
        prisma.position.findMany({
          where: { userId, status: 'OPEN', mode: 'PAPER' }, orderBy: { openedAt: 'asc' },
          select: { id: true, openedAt: true, updatedAt: true, maxHoldUntil: true, exitPolicy: true, entryStrategy: true, currentPrice: true, avgEntryPrice: true, token: { select: { address: true, symbol: true } } },
        }),
        deps.readJson('newlaunch:exitmonitor').catch(() => null),
      ]);
      const lastEvents = open.length ? await prisma.positionEvent.findMany({ where: { positionId: { in: open.map((row) => row.id) } }, orderBy: { at: 'desc' }, take: 500, select: { positionId: true, type: true, at: true, details: true } }) : [];
      const maxPositions = config?.maxConcurrentPositions ?? null;
      const newLaunchOpen = open.filter((row) => row.exitPolicy === 'NEW_LAUNCH').length;
      const positions = open.map((row) => {
        const events = lastEvents.filter((event) => event.positionId === row.id);
        const stale = events.find((event) => event.type === 'MARKET_DATA_STALE') ?? null;
        const ageMs = now - row.openedAt.getTime();
        const reasons: string[] = [];
        if (!row.maxHoldUntil) reasons.push('NO_MAX_HOLD');
        else if (row.maxHoldUntil.getTime() < now) reasons.push('MAX_HOLD_OVERDUE_WAITING_FOR_REAL_QUOTE');
        if (stale && now - stale.at.getTime() < 10 * 60_000) reasons.push('MARKET_DATA_STALE_RECENTLY');
        if (now - row.updatedAt.getTime() > 10 * 60_000) reasons.push('NO_PRICE_UPDATE_10M');
        return {
          id: row.id, mint: row.token.address, symbol: row.token.symbol, exitPolicy: row.exitPolicy, entryStrategy: row.entryStrategy,
          openedAt: row.openedAt, ageMinutes: Math.round(ageMs / 60_000), maxHoldUntil: row.maxHoldUntil, lastUpdateAt: row.updatedAt,
          lastUpdateAgeSeconds: Math.round((now - row.updatedAt.getTime()) / 1000),
          currentPrice: num(row.currentPrice), entryPrice: num(row.avgEntryPrice),
          lastEvent: events[0] ? { type: events[0].type, at: events[0].at } : null,
          lastStaleQuoteAt: stale?.at ?? null,
          stuck: ageMs > STUCK_POSITION_AFTER_MS && reasons.length > 0,
          reasons,
        };
      });
      const monitor = record(exitMonitor);
      return res.json({
        ok: true,
        data: {
          settings: { maxHoldEnabled: config?.maxHoldEnabled ?? false, maxHoldMinutes: config?.maxHoldMinutes ?? null, maxConcurrentPositions: maxPositions },
          openNewLaunchPositions: newLaunchOpen,
          positionLimitReached: maxPositions !== null && newLaunchOpen >= maxPositions,
          stuckPositions: positions.filter((row) => row.stuck).length,
          positions,
          exitMonitor: exitMonitor ? {
            maxHoldOnSilentCurve: num(record(monitor.metrics).maxHoldOnSilentCurve ?? monitor.maxHoldOnSilentCurve),
            maxHoldWaitingForQuote: num(record(monitor.metrics).maxHoldWaitingForQuote ?? monitor.maxHoldWaitingForQuote),
          } : null,
          note: 'Diagnostic only: no position is closed or modified here. Max hold applies to positions opened while it is enabled.',
        },
      });
    } catch (error) {
      deps.logger.error({ err: error }, 'Stuck position diagnostics failed');
      return fail(res, 500, 'Stuck position diagnostics failed');
    }
  });

  return router;
}
