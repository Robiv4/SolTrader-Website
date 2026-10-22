/**
 * Autonomous ML API (PAPER only, nothing here trades):
 *   GET    /ml/autonomous/overview                          bundles, own virtual account, decisions, coverage, health
 *   GET    /ml/autonomous/comparison?days=90                DEFAULT / v3 ML / Community ML / Autonomous, each from its own ledger
 *   POST   /ml/autonomous/bundles/:version/status           explicit promotion TRAINED -> VALIDATED -> SHADOW, or RETIRED (admin + e-mail)
 *   GET    /ml/autonomous/bundles/:version/paper-approval   approval blockers
 *   POST   /ml/autonomous/bundles/:version/paper-approval   PAPER approval (admin + e-mail, all gates green)
 *   DELETE /ml/autonomous/bundles/:version/paper-approval   revoke (open positions fall back to fail-safe protection)
 * A trained bundle is never approved, selected or activated automatically, and approval alone selects nothing.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Prisma, type PrismaClient } from '@prisma/client';
import { ML_AUTONOMOUS_FEATURE_VERSION, ML_COMMUNITY_FEATURE_VERSION, ML_FEATURE_VERSION } from '@soltrader/strategy-engine';
import { type Request, type Response, Router } from 'express';
import { z } from 'zod';

import type { StepUpGate } from './email-verification.js';
import { paperStats } from './ml-paper.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
/** Minimum stored SHADOW decisions before a bundle may be PAPER-approved. */
export const MIN_SHADOW_DECISIONS_FOR_APPROVAL = 500;
const STATUS_ORDER = ['TRAINED', 'VALIDATED', 'SHADOW'];

const fail = (res: Response, status: number, message: string, data?: unknown) => res.status(status).json({ ok: false, error: message, ...(data ? { data } : {}) });
const num = (value: unknown) => (value === null || value === undefined ? null : Number(value));
const record = (value: unknown) => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {});

export interface MlAutonomousDeps {
  prisma: PrismaClient;
  stepUp: StepUpGate;
  logAuditEvent: (action: string, userId: string | null, details?: Record<string, unknown>) => Promise<unknown>;
  readJson: (key: string) => Promise<Record<string, unknown> | null>;
  logger: { error(payload: unknown, message?: string): void };
  readArtifact?: (artifactPath: string) => Promise<Buffer>;
}

type BundleRow = Awaited<ReturnType<PrismaClient['mlAutonomousModelBundle']['findUnique']>> & object;

export async function bundleApprovalBlockers(prisma: PrismaClient, bundle: BundleRow, readArtifact: (artifactPath: string) => Promise<Buffer>) {
  const blockers: string[] = [];
  if (bundle.status !== 'SHADOW') blockers.push(`STATUS_${bundle.status}`);
  if (bundle.readiness !== 'SHADOW_READY') blockers.push(`READINESS_${bundle.readiness}`);
  if (bundle.featureVersion !== ML_AUTONOMOUS_FEATURE_VERSION) blockers.push('FEATURE_VERSION_MISMATCH');
  const shadow = await prisma.mlAutonomousDecision.count({ where: { bundleVersion: bundle.version, mode: 'SHADOW' } });
  if (shadow < MIN_SHADOW_DECISIONS_FOR_APPROVAL) blockers.push(`SHADOW_DECISIONS_${shadow}_BELOW_${MIN_SHADOW_DECISIONS_FOR_APPROVAL}`);
  try {
    const content = await readArtifact(bundle.artifactPath);
    if (createHash('sha256').update(content).digest('hex') !== bundle.artifactHash) blockers.push('ARTIFACT_HASH_MISMATCH');
  } catch {
    blockers.push('ARTIFACT_MISSING');
  }
  return blockers;
}

function bundleSummary(bundle: BundleRow) {
  const metrics = record(bundle.metrics);
  const entry = record(metrics.entry);
  const exit = record(metrics.exit);
  const backtest = record(entry.backtest);
  return {
    version: bundle.version, status: bundle.status, readiness: bundle.readiness, featureVersion: bundle.featureVersion, labelVersion: bundle.labelVersion, datasetVersion: bundle.datasetVersion,
    trainedAt: bundle.trainedAt, paperApproved: bundle.paperApproved, paperApprovedAt: bundle.paperApprovedAt, paperApprovedBy: bundle.paperApprovedBy, policy: bundle.policy,
    test: { policy: backtest.policy ?? null, buyAll: backtest.buyAll ?? null, randomSameCount: backtest.randomSameCount ?? null, liquidityStress: entry.liquidityStress ?? null, regimes: entry.regimes ?? null, periods: entry.periods ?? null, walkForward: entry.walkForward ?? null, overfitting: entry.overfitting ?? null, missedOpportunities: entry.missedOpportunities ?? null, exit: exit.test ?? null },
    coverage: metrics.coverage ?? null,
  };
}

export function createMlAutonomousRouter(deps: MlAutonomousDeps) {
  const { prisma } = deps;
  const router = Router();
  const readArtifact = deps.readArtifact ?? (async (artifactPath: string) => {
    const root = path.resolve(REPO_ROOT, 'ml', 'autonomous-models');
    const file = path.resolve(REPO_ROOT, artifactPath);
    if (!file.startsWith(root + path.sep)) throw new Error('Artifact path outside ml/autonomous-models');
    return readFile(file);
  });

  router.get('/ml/autonomous/overview', async (req: Request, res: Response) => {
    try {
      const userId = req.user!.id;
      const [bundles, account, health, snapshotKinds, outcomes, lastDataset] = await Promise.all([
        prisma.mlAutonomousModelBundle.findMany({ orderBy: { trainedAt: 'desc' }, take: 20 }),
        prisma.mlAutonomousAccount.findUnique({ where: { userId } }),
        deps.readJson('ml:autonomous:health').catch(() => null),
        prisma.mlAutonomousDecisionSnapshot.groupBy({ by: ['kind', 'trigger'], _count: { _all: true } }),
        prisma.mlAutonomousOutcome.groupBy({ by: ['status', 'exclusionReason'], _count: { _all: true } }),
        prisma.mlDatasetVersion.findFirst({ where: { featureVersion: ML_AUTONOMOUS_FEATURE_VERSION }, orderBy: { createdAt: 'desc' }, select: { version: true, rowCount: true, manifest: true, createdAt: true } }),
      ]);
      const shadowCounts = await prisma.mlAutonomousDecision.groupBy({ by: ['bundleVersion', 'action'], where: { mode: 'SHADOW' }, _count: { _all: true } });
      const positions = account ? await prisma.mlAutonomousPosition.findMany({ where: { accountId: account.id }, orderBy: { openedAt: 'desc' }, take: 50 }) : [];
      const decisions = account ? await prisma.mlAutonomousDecision.findMany({ where: { accountId: account.id }, orderBy: { decidedAt: 'desc' }, take: 50, select: { id: true, mint: true, kind: true, action: true, bundleVersion: true, outputs: true, suggestedSizeUsd: true, executedSizeUsd: true, executionStatus: true, executionReason: true, safetyBlockers: true, decidedAt: true, featureHash: true, positionId: true } }) : [];
      const open = positions.filter((position) => position.status === 'OPEN');
      const openCost = open.reduce((sum, position) => sum + Number(position.quantity) * Number(position.entryFillPrice), 0);
      return res.json({
        ok: true,
        data: {
          mode: 'PAPER', liveTrading: 'DISABLED',
          bundles: bundles.map((bundle) => ({ ...bundleSummary(bundle), shadowDecisions: shadowCounts.filter((row) => row.bundleVersion === bundle.version).reduce((sum, row) => sum + row._count._all, 0) })),
          account: account ? {
            accountKey: account.accountKey, initialBalance: num(account.initialBalance), cashBalance: num(account.cashBalance), realizedPnl: num(account.realizedPnl), feesPaid: num(account.feesPaid), impactCost: num(account.impactCost),
            openPositions: open.length, openCostBasisUsd: openCost, closedPositions: positions.filter((position) => position.status === 'CLOSED').length,
          } : null,
          positions: positions.map((position) => ({ id: position.id, mint: position.mint, symbol: position.symbol, bundleVersion: position.bundleVersion, status: position.status, entryNotionalUsd: num(position.entryNotionalUsd), entryFillPrice: num(position.entryFillPrice), quantity: num(position.quantity), partiallySold: position.partiallySold, realizedPnlUsd: num(position.realizedPnlUsd), feesUsd: num(position.feesUsd), exitReason: position.exitReason, openedAt: position.openedAt, closedAt: position.closedAt })),
          decisions: decisions.map((row) => ({ ...row, suggestedSizeUsd: num(row.suggestedSizeUsd), executedSizeUsd: num(row.executedSizeUsd) })),
          coverage: {
            snapshots: snapshotKinds.map((row) => ({ kind: row.kind, trigger: row.trigger, count: row._count._all })),
            outcomes: outcomes.map((row) => ({ status: row.status, exclusionReason: row.exclusionReason, count: row._count._all })),
            lastDataset: lastDataset ? { version: lastDataset.version, rows: lastDataset.rowCount, createdAt: lastDataset.createdAt, coverage: record(lastDataset.manifest).coverage ?? null } : null,
          },
          health,
        },
      });
    } catch (error) {
      deps.logger.error({ err: error }, 'Autonomous overview failed');
      return fail(res, 500, 'Autonomous overview failed');
    }
  });

  /** Each strategy from its OWN ledger: never mixed accounts or P&L. */
  router.get('/ml/autonomous/comparison', async (req: Request, res: Response) => {
    try {
      const userId = req.user!.id;
      const days = Math.min(365, Math.max(1, Number(req.query.days ?? 90) || 90));
      const since = new Date(Date.now() - days * 86_400_000);
      const models = await prisma.mlModelVersion.findMany({ select: { version: true, featureVersion: true } });
      const featureOf = new Map(models.map((model) => [model.version, model.featureVersion]));
      const trades = await prisma.trade.findMany({ where: { userId, decisionSource: 'NEW_LAUNCH', mode: 'PAPER', status: 'CLOSED', exitAt: { gte: since } }, select: { netPnl: true, fees: true, slippage: true, exitAt: true, entryStrategy: true, mlModelVersion: true, exitReason: true } });
      const closed = (filter: (trade: typeof trades[number]) => boolean) => trades.filter(filter).map((trade) => ({ netPnl: Number(trade.netPnl ?? 0), fees: Number(trade.fees ?? 0), slippage: Number(trade.slippage ?? 0), exitAt: trade.exitAt, entryStrategy: trade.entryStrategy ?? 'DEFAULT', mlModelVersion: trade.mlModelVersion }));
      const account = await prisma.mlAutonomousAccount.findUnique({ where: { userId } });
      const autonomous = account ? await prisma.mlAutonomousPosition.findMany({ where: { accountId: account.id, status: 'CLOSED', closedAt: { gte: since } }, select: { realizedPnlUsd: true, feesUsd: true, closedAt: true, bundleVersion: true, entryNotionalUsd: true } }) : [];
      const impact = account ? await prisma.mlAutonomousFill.aggregate({ where: { accountId: account.id, at: { gte: since } }, _sum: { feeUsd: true } }) : null;
      const withExpectancy = (stats: ReturnType<typeof paperStats>) => ({ ...stats, expectancy: stats.trades ? stats.netPnl / stats.trades : null });
      return res.json({
        ok: true,
        data: {
          days,
          strategies: {
            DEFAULT: { ledger: 'PAPER account (rule-based entries)', ...withExpectancy(paperStats(closed((trade) => (trade.entryStrategy ?? 'DEFAULT') === 'DEFAULT'))) },
            ML_V3: { ledger: 'PAPER account (ML PAPER entries, ML-FEATURES-v1 models)', ...withExpectancy(paperStats(closed((trade) => trade.entryStrategy === 'ML' && featureOf.get(trade.mlModelVersion ?? '') === ML_FEATURE_VERSION))) },
            ML_COMMUNITY: { ledger: 'PAPER account (ML PAPER entries, ML-FEATURES-COMMUNITY-v1 models)', ...withExpectancy(paperStats(closed((trade) => trade.entryStrategy === 'ML' && featureOf.get(trade.mlModelVersion ?? '') === ML_COMMUNITY_FEATURE_VERSION))) },
            ML_AUTONOMOUS: {
              ledger: account ? `${account.accountKey} (separate virtual PAPER account)` : 'no account yet',
              ...withExpectancy(paperStats(autonomous.map((position) => ({ netPnl: Number(position.realizedPnlUsd), fees: Number(position.feesUsd), slippage: 0, exitAt: position.closedAt, entryStrategy: 'ML_AUTONOMOUS', mlModelVersion: position.bundleVersion })))),
              impactCostUsd: num(account?.impactCost), feesUsd: num(impact?._sum.feeUsd),
            },
          },
          note: 'Live PAPER results only (closed positions). Offline backtests, liquidity stress tests and regime / period results of a bundle are in its training metrics.',
        },
      });
    } catch (error) {
      deps.logger.error({ err: error }, 'Autonomous comparison failed');
      return fail(res, 500, 'Autonomous comparison failed');
    }
  });

  const statusSchema = z.object({ status: z.enum(['VALIDATED', 'SHADOW', 'RETIRED']) }).strict();
  router.post('/ml/autonomous/bundles/:version/status', async (req: Request, res: Response) => {
    if (req.user?.role !== 'ADMIN') return fail(res, 403, 'Administrator authorization required');
    const body = { ...(req.body ?? {}) } as Record<string, unknown>;
    delete body.verification;
    const parsed = statusSchema.safeParse(body);
    if (!parsed.success) return fail(res, 400, 'Invalid status', parsed.error.issues);
    try {
      const bundle = await prisma.mlAutonomousModelBundle.findUnique({ where: { version: String(req.params.version) } });
      if (!bundle) return fail(res, 404, 'Bundle not found');
      const target = parsed.data.status;
      // Promotion one step at a time (TRAINED -> VALIDATED -> SHADOW); RETIRED is always allowed and final.
      if (bundle.status === 'RETIRED') return fail(res, 409, 'A retired bundle cannot be changed');
      if (target !== 'RETIRED' && STATUS_ORDER.indexOf(target) !== STATUS_ORDER.indexOf(bundle.status) + 1) return fail(res, 409, `Only ${bundle.status} -> ${STATUS_ORDER[STATUS_ORDER.indexOf(bundle.status) + 1] ?? '-'} is allowed`);
      if (target === 'SHADOW' && bundle.readiness === 'INSUFFICIENT_DATA') return fail(res, 409, 'INSUFFICIENT_DATA bundles cannot run in SHADOW');
      if (!await deps.stepUp(req, res, 'ml_autonomous_status', { bundleVersion: bundle.version, status: target })) return;
      const history = [...(Array.isArray(bundle.statusHistory) ? bundle.statusHistory : []), { status: target, at: new Date().toISOString(), by: req.user!.email }];
      await prisma.mlAutonomousModelBundle.update({ where: { version: bundle.version }, data: { status: target, statusHistory: history as Prisma.InputJsonValue, ...(target === 'RETIRED' ? { paperApproved: false, paperRevokedAt: new Date(), paperRevokedBy: req.user!.email } : {}) } });
      await deps.logAuditEvent('ml_autonomous_bundle_status', req.user!.id, { bundleVersion: bundle.version, from: bundle.status, to: target });
      return res.json({ ok: true, data: { version: bundle.version, status: target } });
    } catch (error) {
      deps.logger.error({ err: error }, 'Autonomous status change failed');
      return fail(res, 500, 'Autonomous status change failed');
    }
  });

  router.get('/ml/autonomous/bundles/:version/paper-approval', async (req: Request, res: Response) => {
    const bundle = await prisma.mlAutonomousModelBundle.findUnique({ where: { version: String(req.params.version) } });
    if (!bundle) return fail(res, 404, 'Bundle not found');
    return res.json({ ok: true, data: { ...bundleSummary(bundle), blockers: await bundleApprovalBlockers(prisma, bundle, readArtifact) } });
  });

  router.post('/ml/autonomous/bundles/:version/paper-approval', async (req: Request, res: Response) => {
    if (req.user?.role !== 'ADMIN') return fail(res, 403, 'Administrator authorization required');
    try {
      const bundle = await prisma.mlAutonomousModelBundle.findUnique({ where: { version: String(req.params.version) } });
      if (!bundle) return fail(res, 404, 'Bundle not found');
      const blockers = await bundleApprovalBlockers(prisma, bundle, readArtifact);
      if (blockers.length) return fail(res, 409, 'The bundle cannot be PAPER-approved yet', { blockers });
      if (!await deps.stepUp(req, res, 'ml_autonomous_approval', { bundleVersion: bundle.version })) return;
      const history = [...(Array.isArray(bundle.statusHistory) ? bundle.statusHistory : []), { event: 'PAPER_APPROVED', at: new Date().toISOString(), by: req.user!.email }];
      await prisma.mlAutonomousModelBundle.update({ where: { version: bundle.version }, data: { paperApproved: true, paperApprovedAt: new Date(), paperApprovedBy: req.user!.email, paperRevokedAt: null, paperRevokedBy: null, statusHistory: history as Prisma.InputJsonValue } });
      await deps.logAuditEvent('ml_autonomous_bundle_approved', req.user!.id, { bundleVersion: bundle.version });
      return res.json({ ok: true, data: { version: bundle.version, paperApproved: true } });
    } catch (error) {
      deps.logger.error({ err: error }, 'Autonomous approval failed');
      return fail(res, 500, 'Autonomous approval failed');
    }
  });

  router.delete('/ml/autonomous/bundles/:version/paper-approval', async (req: Request, res: Response) => {
    if (req.user?.role !== 'ADMIN') return fail(res, 403, 'Administrator authorization required');
    const bundle = await prisma.mlAutonomousModelBundle.findUnique({ where: { version: String(req.params.version) } });
    if (!bundle) return fail(res, 404, 'Bundle not found');
    // Revoking only reduces automation: no e-mail step needed. Users stay on the bundle without entries (no fallback).
    const history = [...(Array.isArray(bundle.statusHistory) ? bundle.statusHistory : []), { event: 'PAPER_REVOKED', at: new Date().toISOString(), by: req.user!.email }];
    await prisma.mlAutonomousModelBundle.update({ where: { version: bundle.version }, data: { paperApproved: false, paperRevokedAt: new Date(), paperRevokedBy: req.user!.email, statusHistory: history as Prisma.InputJsonValue } });
    const affected = await prisma.mlPaperSettings.count({ where: { strategyMode: 'ML_AUTONOMOUS', autonomousBundleVersion: bundle.version } });
    await deps.logAuditEvent('ml_autonomous_bundle_revoked', req.user!.id, { bundleVersion: bundle.version, usersOnBundle: affected });
    return res.json({ ok: true, data: { version: bundle.version, paperApproved: false, usersOnBundle: affected } });
  });

  return router;
}
