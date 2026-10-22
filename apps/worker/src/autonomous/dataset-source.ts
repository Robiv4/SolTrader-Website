/**
 * Source loading for `pnpm ml:autonomous:dataset` (read-only except the optional label audit rows):
 *  - REPLAY: completed outcome paths of ML snapshots (AGE_30S / BUY_DECISION) with the entry context snapshot of the
 *    same candidate (ML-FEATURES-COMMUNITY-v1 preferred, else ML-FEATURES-v1);
 *  - LIVE: MlAutonomousDecisionSnapshot rows whose label horizon has passed, with the candidate path covering them.
 * Paged (keyset) and batched: no query exceeds the bind-parameter limit.
 */
import type { PrismaClient } from '@prisma/client';
import {
  ENTRY_HORIZON_MS, ML_COMMUNITY_FEATURE_VERSION, ML_FEATURE_VERSION,
  type LiveSource, type MlFeatureSnapshotResult, type OutcomePathState, type ReplaySource,
} from '@soltrader/strategy-engine';

import { chunk, loadAllPages } from '../ml/dataset-source.js';

type SnapshotRow = { id: string; candidateId: string; mint: string; kind: string; snapshotAt: Date; featureVersion: string; features: unknown; observedAt: unknown; dataQuality: number; lateDataExcluded: unknown; validForTraining: boolean; invalidReasons: unknown; referencePriceUsd: unknown };

export function toSnapshotResult(row: SnapshotRow): MlFeatureSnapshotResult & { id: string } {
  return {
    id: row.id, featureVersion: row.featureVersion, snapshotAt: row.snapshotAt.getTime(), features: row.features as MlFeatureSnapshotResult['features'], observedAt: (row.observedAt ?? {}) as MlFeatureSnapshotResult['observedAt'],
    dataQuality: row.dataQuality, lateDataExcluded: (row.lateDataExcluded ?? []) as MlFeatureSnapshotResult['lateDataExcluded'], validForTraining: row.validForTraining,
    invalidReasons: (row.invalidReasons ?? []) as string[], referencePriceUsd: row.referencePriceUsd === null ? null : Number(row.referencePriceUsd), referenceLiquidityUsd: null,
  };
}

const snapshotSelect = { id: true, candidateId: true, mint: true, kind: true, snapshotAt: true, featureVersion: true, features: true, observedAt: true, dataQuality: true, lateDataExcluded: true, validForTraining: true, invalidReasons: true, referencePriceUsd: true } as const;

export async function loadReplaySources(prisma: Pick<PrismaClient, 'mlFeatureSnapshot'>): Promise<{ sources: ReplaySource[]; paths: Map<string, OutcomePathState[]> }> {
  const tracked = await loadAllPages((cursor, take) => prisma.mlFeatureSnapshot.findMany({
    where: { featureVersion: ML_FEATURE_VERSION, kind: { in: ['AGE_30S', 'BUY_DECISION'] }, outcome: { status: 'COMPLETE' } },
    select: { ...snapshotSelect, outcome: { select: { path: true } } },
    orderBy: [{ snapshotAt: 'asc' }, { id: 'asc' }], take, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  }));
  // Community entry context of the same candidate + kind (same moment) when it exists.
  const community = new Map<string, SnapshotRow>();
  for (const batch of chunk([...new Set(tracked.map((row) => row.candidateId))], 1_000)) {
    const rows = await prisma.mlFeatureSnapshot.findMany({ where: { featureVersion: ML_COMMUNITY_FEATURE_VERSION, candidateId: { in: batch } }, select: snapshotSelect });
    for (const row of rows) community.set(`${row.candidateId}|${row.kind}`, row);
  }
  const sources: ReplaySource[] = [];
  const paths = new Map<string, OutcomePathState[]>();
  for (const row of tracked) {
    const path = row.outcome?.path as unknown as OutcomePathState | null;
    if (!path) continue;
    const context = community.get(`${row.candidateId}|${row.kind}`) ?? row;
    sources.push({ snapshot: toSnapshotResult(context), mint: row.mint, path });
    paths.set(row.mint, [...(paths.get(row.mint) ?? []), path]);
  }
  return { sources, paths };
}

/** Path of the mint that covers `at` and its label horizon best (latest start not after `at`). */
export function pathFor(paths: Map<string, OutcomePathState[]>, mint: string, at: number) {
  return (paths.get(mint) ?? []).filter((path) => path.startAt <= at).sort((a, b) => b.startAt - a.startAt)[0] ?? null;
}

export async function loadLiveSources(prisma: Pick<PrismaClient, 'mlAutonomousDecisionSnapshot' | 'mlAutonomousPosition'>, paths: Map<string, OutcomePathState[]>, now: number): Promise<LiveSource[]> {
  const rows = await loadAllPages((cursor, take) => prisma.mlAutonomousDecisionSnapshot.findMany({
    where: { at: { lte: new Date(now - ENTRY_HORIZON_MS) } },
    select: { id: true, kind: true, mint: true, at: true, features: true, validForTraining: true, positionId: true },
    orderBy: [{ at: 'asc' }, { id: 'asc' }], take, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  }));
  const positionIds = [...new Set(rows.map((row) => row.positionId).filter((id): id is string => Boolean(id)))];
  const positions = new Map<string, { quantity: number; entryFillPrice: number }>();
  for (const batch of chunk(positionIds, 1_000)) {
    for (const row of await prisma.mlAutonomousPosition.findMany({ where: { id: { in: batch } }, select: { id: true, initialQuantity: true, entryFillPrice: true } })) {
      positions.set(row.id, { quantity: Number(row.initialQuantity), entryFillPrice: Number(row.entryFillPrice) });
    }
  }
  return rows.map((row) => ({
    id: row.id, kind: row.kind === 'POSITION' ? 'POSITION' : 'ENTRY', mint: row.mint, at: row.at.getTime(), features: row.features as Record<string, unknown>, validForTraining: row.validForTraining,
    path: pathFor(paths, row.mint, row.at.getTime()), position: row.positionId ? positions.get(row.positionId) ?? null : null,
  }));
}
