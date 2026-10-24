/**
 * Source loading for `pnpm ml:autonomous:dataset` (read-only except the optional label audit rows):
 *  - REPLAY: completed outcome paths of ML snapshots (AGE_30S / BUY_DECISION) with the entry context snapshot of the
 *    same candidate (ML-FEATURES-COMMUNITY-v1 preferred, else ML-FEATURES-v1);
 *  - LIVE: MlAutonomousDecisionSnapshot rows whose label horizon has passed, with the candidate path covering them.
 * Paged (keyset) and batched: no query exceeds the bind-parameter limit.
 *
 * The training pipeline uses the STREAMING page generators (replaySourcePages / liveSourcePages): every page is joined
 * (community context, positions, outcome paths of the page's own mints), handed to the caller and dropped, so memory
 * is bounded by the page size - never by the database size. loadReplaySources / loadLiveSources load everything at
 * once; they remain only as the reference implementation of the parity tests.
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

export const DEFAULT_REPLAY_PAGE_SIZE = 200;
export const DEFAULT_LIVE_PAGE_SIZE = 500;
const MINT_BATCH = 500;

/** Tracked ML snapshots (replay sources): completed outcome path of an AGE_30S / BUY_DECISION v1 snapshot. */
const trackedWhere = { featureVersion: ML_FEATURE_VERSION, kind: { in: ['AGE_30S', 'BUY_DECISION'] }, outcome: { status: 'COMPLETE' } };

const snapshotSelect = { id: true, candidateId: true, mint: true, kind: true, snapshotAt: true, featureVersion: true, features: true, observedAt: true, dataQuality: true, lateDataExcluded: true, validForTraining: true, invalidReasons: true, referencePriceUsd: true } as const;

export async function loadReplaySources(prisma: Pick<PrismaClient, 'mlFeatureSnapshot'>): Promise<{ sources: ReplaySource[]; paths: Map<string, OutcomePathState[]> }> {
  const tracked = await loadAllPages((cursor, take) => prisma.mlFeatureSnapshot.findMany({
    where: trackedWhere,
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

type ReplayPrisma = Pick<PrismaClient, 'mlFeatureSnapshot'>;
type LivePrisma = Pick<PrismaClient, 'mlAutonomousDecisionSnapshot' | 'mlAutonomousPosition' | 'mlFeatureSnapshot'>;

export const countReplaySnapshots = (prisma: ReplayPrisma) => prisma.mlFeatureSnapshot.count({ where: trackedWhere });
export const countLiveSnapshots = (prisma: Pick<PrismaClient, 'mlAutonomousDecisionSnapshot'>, now: number) => prisma.mlAutonomousDecisionSnapshot.count({ where: { at: { lte: new Date(now - ENTRY_HORIZON_MS) } } });

/**
 * Replay sources page by page, in the same order as loadReplaySources (snapshotAt, id). Each page is joined with the
 * community context of its own candidates only. `scanned` = tracked snapshots read (rows without a path are skipped).
 */
export async function* replaySourcePages(prisma: ReplayPrisma, options: { pageSize?: number } = {}): AsyncGenerator<{ sources: ReplaySource[]; scanned: number }> {
  const take = options.pageSize ?? DEFAULT_REPLAY_PAGE_SIZE;
  let cursor: string | null = null;
  for (;;) {
    const page: Array<SnapshotRow & { outcome: { path: unknown } | null }> = await prisma.mlFeatureSnapshot.findMany({
      where: trackedWhere, select: { ...snapshotSelect, outcome: { select: { path: true } } },
      orderBy: [{ snapshotAt: 'asc' }, { id: 'asc' }], take, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (!page.length) return;
    const community = new Map<string, SnapshotRow>();
    for (const batch of chunk([...new Set(page.map((row) => row.candidateId))], MINT_BATCH)) {
      for (const row of await prisma.mlFeatureSnapshot.findMany({ where: { featureVersion: ML_COMMUNITY_FEATURE_VERSION, candidateId: { in: batch } }, select: snapshotSelect })) community.set(`${row.candidateId}|${row.kind}`, row);
    }
    const sources: ReplaySource[] = [];
    for (const row of page) {
      const path = row.outcome?.path as unknown as OutcomePathState | null;
      if (!path) continue;
      sources.push({ snapshot: toSnapshotResult(community.get(`${row.candidateId}|${row.kind}`) ?? row), mint: row.mint, path });
    }
    yield { sources, scanned: page.length };
    if (page.length < take) return;
    cursor = page[page.length - 1].id;
  }
}

type LiveRow = { id: string; kind: string; mint: string; at: Date; features: unknown; validForTraining: boolean; positionId: string | null };

/** One kind's labelled-horizon live snapshots in (at, id) order, fetched lazily page by page (index kind, at). */
async function* liveRowsOfKind(prisma: Pick<PrismaClient, 'mlAutonomousDecisionSnapshot'>, kind: string, cutoff: Date, take: number): AsyncGenerator<LiveRow> {
  let cursor: string | null = null;
  for (;;) {
    const page: LiveRow[] = await prisma.mlAutonomousDecisionSnapshot.findMany({
      where: { kind, at: { lte: cutoff } }, select: { id: true, kind: true, mint: true, at: true, features: true, validForTraining: true, positionId: true },
      orderBy: [{ at: 'asc' }, { id: 'asc' }], take, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    yield* page;
    if (page.length < take) return;
    cursor = page[page.length - 1].id;
  }
}

/**
 * Live sources page by page in (at, id) order: one stream per kind (every query uses the (kind, at) index), merged.
 * Each page is joined with its own positions and the outcome paths of its own mints (same pathFor rule as before).
 */
export async function* liveSourcePages(prisma: LivePrisma, now: number, options: { pageSize?: number } = {}): AsyncGenerator<LiveSource[]> {
  const take = options.pageSize ?? DEFAULT_LIVE_PAGE_SIZE;
  const cutoff = new Date(now - ENTRY_HORIZON_MS);
  const kinds = (await prisma.mlAutonomousDecisionSnapshot.groupBy({ by: ['kind'], where: { at: { lte: cutoff } } })).map((row) => row.kind).sort();
  const streams = kinds.map((kind) => liveRowsOfKind(prisma, kind, cutoff, take));
  const heads: Array<IteratorResult<LiveRow>> = [];
  for (const stream of streams) heads.push(await stream.next());
  const before = (a: LiveRow, b: LiveRow) => a.at.getTime() < b.at.getTime() || (a.at.getTime() === b.at.getTime() && a.id < b.id);
  for (;;) {
    const rows: LiveRow[] = [];
    while (rows.length < take) {
      let best = -1;
      for (let index = 0; index < heads.length; index += 1) {
        const head = heads[index];
        if (!head.done && (best < 0 || before(head.value, heads[best].value as LiveRow))) best = index;
      }
      if (best < 0) break;
      rows.push(heads[best].value as LiveRow);
      heads[best] = await streams[best].next();
    }
    if (!rows.length) return;
    yield await joinLivePage(prisma, rows);
  }
}

async function joinLivePage(prisma: LivePrisma, rows: LiveRow[]): Promise<LiveSource[]> {
  const positions = new Map<string, { quantity: number; entryFillPrice: number }>();
  for (const batch of chunk([...new Set(rows.map((row) => row.positionId).filter((id): id is string => Boolean(id)))], MINT_BATCH)) {
    for (const row of await prisma.mlAutonomousPosition.findMany({ where: { id: { in: batch } }, select: { id: true, initialQuantity: true, entryFillPrice: true } })) {
      positions.set(row.id, { quantity: Number(row.initialQuantity), entryFillPrice: Number(row.entryFillPrice) });
    }
  }
  // Outcome paths of this page's mints only, in the global (snapshotAt, id) order of loadReplaySources (same tie rule).
  const paths = new Map<string, OutcomePathState[]>();
  for (const batch of chunk([...new Set(rows.map((row) => row.mint))], MINT_BATCH)) {
    for (const row of await prisma.mlFeatureSnapshot.findMany({ where: { ...trackedWhere, mint: { in: batch } }, select: { mint: true, outcome: { select: { path: true } } }, orderBy: [{ snapshotAt: 'asc' }, { id: 'asc' }] })) {
      const path = row.outcome?.path as unknown as OutcomePathState | null;
      if (path) paths.set(row.mint, [...(paths.get(row.mint) ?? []), path]);
    }
  }
  return rows.map((row) => ({
    id: row.id, kind: row.kind === 'POSITION' ? 'POSITION' : 'ENTRY', mint: row.mint, at: row.at.getTime(), features: row.features as Record<string, unknown>, validForTraining: row.validForTraining,
    path: pathFor(paths, row.mint, row.at.getTime()), position: row.positionId ? positions.get(row.positionId) ?? null : null,
  }));
}
