/* eslint-disable @typescript-eslint/no-explicit-any -- injected pipeline fakes / prisma proxy */
/**
 * Streaming dataset preparation against the LOCAL development database (pnpm test:e2e, sequential; refuses any
 * non-local DATABASE_URL; own throw-away rows / jobs / directories, removed afterwards; never production):
 *  - paged sources == the previous load-everything loaders, across page boundaries (tiny pages);
 *  - the registered dataset == the in-memory builder on the old sources (CSV bytes, manifest, streaming SHA-256);
 *  - version collision (an unregistered directory is skipped, never overwritten); registration failure and cancel
 *    leave nothing registered and no directory behind; existing datasets / models are byte-identical afterwards;
 *  - web job lifecycle: real measured progress, phase log, cancel during the build; recovery removes only the work
 *    directories of finished jobs.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Prisma, PrismaClient } from '@prisma/client';
import { buildAutonomousDataset, buildCommunityFeatureSnapshot, buildMlFeatureSnapshot, ENTRY_HORIZON_MS, ML_AUTONOMOUS_FEATURE_VERSION, ML_COMMUNITY_FEATURE_VERSION, ML_FEATURE_VERSION, type LaunchSecurity, type LiveSource } from '@soltrader/strategy-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { syntheticPath } from '../../../packages/strategy-engine/test/helpers/autonomous-sources.js';
import { liveSourcePages, loadLiveSources, loadReplaySources, replaySourcePages } from '../src/autonomous/dataset-source.js';
import { TrainingJobRunner } from '../src/training/job-runner.js';
import { AUTONOMOUS_DATASETS_DIR, AUTONOMOUS_MODELS_DIR, BUILD_DIR_PREFIX, buildAutonomousDatasetVersion, WORK_DIR_PREFIX, type DatasetProgress } from '../src/training/pipeline.js';

const prisma = new PrismaClient();
const run = randomUUID().slice(0, 6);
const P = `DS${run}`;
const KIND = `TEST-DS-${run}`;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const datasetsRoot = path.join(repoRoot, AUTONOMOUS_DATASETS_DIR);
const modelsRoot = path.join(repoRoot, AUTONOMOUS_MODELS_DIR);
const logger = { info: () => undefined, warn: () => undefined };
const security: LaunchSecurity = { sellability: 'VERIFIED', mintAuthorityRevoked: true, freezeAuthorityRevoked: true, tokenProgram: 'spl-token', extensions: [], hardBlockReasons: [], warnings: [] };
const T0 = Date.parse('2026-08-01T00:00:00Z');
const NOW = Date.parse('2026-10-24T00:00:00Z');
const created = { datasets: [] as string[], dirs: [] as string[], users: [] as string[] };
let fingerprint = new Map<string, string>();

function assertLocalDatabase() {
  const url = new URL(process.env.DATABASE_URL ?? '');
  if (!['localhost', '127.0.0.1', '::1'].includes(url.hostname)) throw new Error(`Refused: DATABASE_URL host ${url.hostname} is not local`);
}

/** sha256 of every file under the existing dataset / model directories (immutability check). */
function fingerprintFiles() {
  const out = new Map<string, string>();
  for (const root of [datasetsRoot, modelsRoot, path.join(repoRoot, 'ml', 'models'), path.join(repoRoot, 'ml', 'datasets')]) {
    if (!existsSync(root)) continue;
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (name.startsWith(BUILD_DIR_PREFIX) || name.startsWith(WORK_DIR_PREFIX) || name.includes(P)) continue;
        if (statSync(full).isDirectory()) walk(full);
        else out.set(full, createHash('sha256').update(readFileSync(full)).digest('hex'));
      }
    };
    walk(root);
  }
  return out;
}

const state = (mint: string, at: number, good: boolean) => ({
  mint, detectedAt: at - 30_000, createdAt: at - 31_000, largestBuyerShare: good ? 0.08 : 0.4, buysPerBuyer: 1.3, creatorSoldRatio: 0, largestHolderSupplyShare: 0.04, priceImpactPercent: 1, observedSellers: 3,
  observations: Array.from({ length: 10 }, (_, i) => ({ takenAt: at - 27_000 + i * 3_000, priceUsd: 0.00001, liquidityUsd: 30_000, buyCount: good ? 20 + 5 * i : 3 + i, sellCount: 2, volumeUsd: 100 + 20 * i, buyVolumeUsd: 80, sellVolumeUsd: 20, uniqueBuyers: good ? 10 + 2 * i : 2, uniqueSellers: 1 })),
});

async function seed() {
  const user = await prisma.user.create({ data: { email: `ds-${run}@soltrader.local` } });
  created.users.push(user.id);
  const account = await prisma.mlAutonomousAccount.create({ data: { userId: user.id, accountKey: `ML_AUTONOMOUS_PAPER:${P}`, initialBalance: 1_000, cashBalance: 1_000 } });
  const position = await prisma.mlAutonomousPosition.create({ data: {
    accountId: account.id, userId: user.id, mint: `${P}M1`, bundleVersion: 'TEST', status: 'CLOSED', initialQuantity: 2_000_000, quantity: 0, entryFillPrice: 0.00001, entryMarketPrice: 0.00001,
    entryNotionalUsd: 20, entryFeeUsd: 0.06, entryImpactPct: 0.2, entryContext: {}, highestPrice: 0.00001, lowestPrice: 0.00001, openedAt: new Date(T0),
  } });
  for (let i = 0; i < 26; i += 1) {
    // Two candidates per mint (several paths per mint); candidates 4 and 5 share the same snapshot time (id tie-break).
    const at = T0 + (i === 5 ? 4 : i) * 600_000;
    const mint = `${P}M${Math.floor(i / 2)}`;
    const candidateId = `${P}C${String(i).padStart(3, '0')}`;
    const kinds = i % 3 === 0 ? ['AGE_30S', 'BUY_DECISION'] : ['AGE_30S'];
    for (const [k, kind] of kinds.entries()) {
      const snapAt = at + k * 2_000;
      const v1 = buildMlFeatureSnapshot({ snapshotAt: snapAt, source: 'PUMP_FUN', detectedAt: at - 30_000, createdAt: at - 31_000, firstTradeAt: at - 29_000, state: state(mint, snapAt, i % 2 === 0), security, securityObservedAt: snapAt - 5_000, riskScore: 40, riskObservedAt: snapAt, social: null, referenceImpactPct: 1 });
      const id = `${P}S${String(i).padStart(3, '0')}${kind[0]}`;
      await prisma.mlFeatureSnapshot.create({ data: {
        id, candidateId, mint, source: 'PUMP_FUN', kind, snapshotAt: new Date(snapAt), detectedAt: new Date(at - 30_000), featureVersion: ML_FEATURE_VERSION, features: v1.features as Prisma.InputJsonValue,
        observedAt: v1.observedAt as Prisma.InputJsonValue, dataQuality: v1.dataQuality, validForTraining: i !== 7, invalidReasons: v1.invalidReasons, lateDataExcluded: [], decision: 'WATCH', decisionContext: {}, referencePriceUsd: new Prisma.Decimal(0.00001),
      } });
      const pathState = i === 9 ? {} : syntheticPath(i === 11 ? snapAt + 1_000 : snapAt, i * 7 + k, { stepSeconds: 5, seconds: i === 13 ? 400 : 3_600 });
      await prisma.mlCandidateOutcome.create({ data: { snapshotId: id, mint, labelVersion: 'ML-LABELS-v1', status: i === 15 ? 'TRACKING' : 'COMPLETE', entryPriceUsd: new Prisma.Decimal(0.00001), path: pathState as unknown as Prisma.InputJsonValue, validHorizons: [] } });
      if (i % 2 === 0) {
        const community = buildCommunityFeatureSnapshot({ snapshotAt: snapAt, source: 'PUMP_FUN', detectedAt: at - 30_000, createdAt: at - 31_000, firstTradeAt: at - 29_000, state: state(mint, snapAt, true), security, securityObservedAt: snapAt - 5_000, riskScore: 35, riskObservedAt: snapAt, social: null, referenceImpactPct: 1, community: null });
        await prisma.mlFeatureSnapshot.create({ data: {
          id: `${id}X`, candidateId, mint, source: 'PUMP_FUN', kind, snapshotAt: new Date(snapAt), detectedAt: new Date(at - 30_000), featureVersion: ML_COMMUNITY_FEATURE_VERSION, features: community.features as Prisma.InputJsonValue,
          observedAt: community.observedAt as Prisma.InputJsonValue, dataQuality: community.dataQuality, validForTraining: true, invalidReasons: [], lateDataExcluded: [], decision: 'WATCH', decisionContext: {}, referencePriceUsd: new Prisma.Decimal(0.00001),
        } });
      }
    }
  }
  // Live decision snapshots: ENTRY / POSITION, equal timestamps across kinds, real / missing positions, no path.
  for (let i = 0; i < 37; i += 1) {
    const kind = i % 3 === 0 ? 'POSITION' : 'ENTRY';
    const at = T0 + Math.floor(i / 2) * 300_000 + 40_000;
    await prisma.mlAutonomousDecisionSnapshot.create({ data: {
      id: `${P}L${String(i).padStart(3, '0')}`, kind, mint: i === 30 ? `${P}NOPATH` : `${P}M${i % 13}`, positionId: kind === 'POSITION' ? (i % 2 === 0 ? position.id : `${P}missing`) : null, trigger: 'TEST', at: new Date(at),
      featureVersion: ML_AUTONOMOUS_FEATURE_VERSION, features: { decisionKind: kind, marketRegime: ['HOT', 'NORMAL', 'COLD', null][i % 4], ret1mPct: i % 5 } as Prisma.InputJsonValue, observedAt: {}, featureHash: 'x', dataQuality: 90, lateDataExcluded: [], validForTraining: i !== 8, invalidReasons: [],
    } });
  }
}

beforeAll(async () => {
  assertLocalDatabase();
  if (await prisma.mlTrainingJob.findUnique({ where: { activeKey: 'ACTIVE' } })) throw new Error('An active training job exists in the development database.');
  fingerprint = fingerprintFiles();
  await seed();
}, 300_000);

afterAll(async () => {
  await prisma.mlTrainingJob.deleteMany({ where: { kind: KIND } });
  await prisma.mlAutonomousOutcome.deleteMany({ where: { snapshot: { id: { startsWith: P } } } });
  await prisma.mlAutonomousDecisionSnapshot.deleteMany({ where: { id: { startsWith: P } } });
  await prisma.mlFeatureSnapshot.deleteMany({ where: { id: { startsWith: P } } });
  await prisma.mlAutonomousPosition.deleteMany({ where: { userId: { in: created.users } } });
  await prisma.mlAutonomousAccount.deleteMany({ where: { userId: { in: created.users } } });
  await prisma.user.deleteMany({ where: { id: { in: created.users } } });
  await prisma.mlDatasetVersion.deleteMany({ where: { version: { in: created.datasets } } });
  for (const version of created.datasets) rmSync(path.join(datasetsRoot, version), { recursive: true, force: true });
  for (const dir of created.dirs) rmSync(dir, { recursive: true, force: true });
  await prisma.$disconnect();
}, 120_000);

const byTimeAndId = (a: LiveSource, b: LiveSource) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

describe('streaming dataset preparation (local development database)', () => {
  it('paged sources equal the previous loaders across page boundaries', async () => {
    const old = await loadReplaySources(prisma);
    const pagedReplay = [];
    let scanned = 0;
    for await (const page of replaySourcePages(prisma, { pageSize: 3 })) {
      pagedReplay.push(...page.sources);
      scanned += page.scanned;
    }
    expect(pagedReplay).toEqual(old.sources);
    expect(scanned).toBeGreaterThanOrEqual(old.sources.length);
    expect(old.sources.filter((source) => source.mint.startsWith(P)).length).toBeGreaterThan(25);
    const oldLive = await loadLiveSources(prisma, old.paths, NOW);
    const pagedLive: LiveSource[] = [];
    for await (const page of liveSourcePages(prisma, NOW, { pageSize: 4 })) pagedLive.push(...page);
    // Same rows, same joins (paths of the page's mints, positions); equal timestamps may be ordered differently
    // across kinds (only the exclusion key order depends on it - the CSV is sorted independently).
    expect([...pagedLive].sort(byTimeAndId)).toEqual([...oldLive].sort(byTimeAndId));
    const ours = pagedLive.filter((source) => source.id.startsWith(P));
    expect(ours.some((source) => source.position)).toBe(true);
    expect(ours.some((source) => source.kind === 'POSITION' && !source.position)).toBe(true);
    expect(ours.some((source) => !source.path)).toBe(true);
  }, 300_000);

  it('the registered dataset equals the in-memory builder on the old sources (bytes, manifest, hash)', async () => {
    const old = await loadReplaySources(prisma);
    const oldLive = await loadLiveSources(prisma, old.paths, NOW);
    const progress: DatasetProgress[] = [];
    const built = await buildAutonomousDatasetVersion(prisma, { rootDir: repoRoot, actor: 'test', now: NOW, replayPageSize: 3, livePageSize: 4, sortChunkRows: 5, onProgress: (value) => progress.push(value) });
    created.datasets.push(built.version);
    const reference = buildAutonomousDataset({ version: built.version, replay: old.sources, live: oldLive });
    const csv = readFileSync(path.join(built.directory, 'dataset.csv'), 'utf8');
    expect(csv).toBe(reference.csv);
    expect(built.fileHash).toBe(createHash('sha256').update(reference.csv).digest('hex'));
    const { createdAt, fileHash, sources, ...manifest } = built.manifest as Record<string, unknown>;
    expect(createdAt).toBe(new Date(NOW).toISOString());
    expect(fileHash).toBe(built.fileHash);
    expect(sources).toEqual({ replay: old.sources.length, live: oldLive.length });
    expect(manifest).toEqual(reference.manifest);
    expect(JSON.parse(readFileSync(path.join(built.directory, 'manifest.json'), 'utf8'))).toEqual(built.manifest);
    const row = await prisma.mlDatasetVersion.findUniqueOrThrow({ where: { version: built.version } });
    expect(row).toMatchObject({ rowCount: reference.rows.length, fileHash: built.fileHash, featureVersion: ML_AUTONOMOUS_FEATURE_VERSION });
    // Real measured progress: every phase, final counts = dataset counts.
    expect(progress.map((value) => value.phase)).toEqual(expect.arrayContaining(['COUNTING', 'REPLAY', 'LIVE', 'WRITING_CSV', 'MANIFEST', 'REGISTERING', 'DONE']));
    const last = progress.at(-1)!;
    expect(last.csv.rowsWritten).toBe(reference.rows.length);
    expect(last.rows.entry + last.rows.position).toBe(reference.rows.length);
    expect(last.replay.processed).toBe(last.replay.total);
    expect(last.live.processed).toBe(last.live.total);
    expect(last.csv.chunks).toBeGreaterThan(1);
    // Label audit rows of the live snapshots exist; the work directory is gone.
    expect(await prisma.mlAutonomousOutcome.count({ where: { snapshotId: { startsWith: P } } })).toBe(37);
    expect(readdirSync(datasetsRoot).filter((name) => name.startsWith(BUILD_DIR_PREFIX))).toEqual([]);
  }, 300_000);

  it('version collision: an existing unregistered directory is skipped and left untouched', async () => {
    const existing = await prisma.mlDatasetVersion.count({ where: { featureVersion: ML_AUTONOMOUS_FEATURE_VERSION } });
    const blocked = path.join(datasetsRoot, `AUTO-DATASET-v${existing + 1}`);
    const preexisting = existsSync(blocked);
    if (!preexisting) {
      mkdirSync(blocked);
      writeFileSync(path.join(blocked, 'marker.txt'), 'foreign');
      created.dirs.push(blocked);
    }
    const before = existsSync(path.join(blocked, 'marker.txt')) ? readFileSync(path.join(blocked, 'marker.txt'), 'utf8') : null;
    const built = await buildAutonomousDatasetVersion(prisma, { rootDir: repoRoot, actor: 'test', now: NOW });
    created.datasets.push(built.version);
    expect(built.version).not.toBe(`AUTO-DATASET-v${existing + 1}`);
    if (before !== null) expect(readFileSync(path.join(blocked, 'marker.txt'), 'utf8')).toBe(before);
    // An explicit version that exists is refused (immutable), nothing is written.
    await expect(buildAutonomousDatasetVersion(prisma, { rootDir: repoRoot, actor: 'test', now: NOW, version: built.version })).rejects.toThrow(/immutable/);
    expect(readFileSync(path.join(built.directory, 'dataset.csv')).length).toBeGreaterThan(0);
  }, 300_000);

  it('registration failure / cancel: nothing registered, no directory left, existing files untouched', async () => {
    const versionsBefore = await prisma.mlDatasetVersion.count();
    const dirsBefore = readdirSync(datasetsRoot).sort();
    const failing = new Proxy(prisma, { get: (target, key) => key === 'mlDatasetVersion' ? new Proxy(target.mlDatasetVersion, { get: (inner, name) => name === 'create' ? async () => { throw new Error('simulated DB failure'); } : (inner as any)[name] }) : (target as any)[key] }) as PrismaClient;
    await expect(buildAutonomousDatasetVersion(failing, { rootDir: repoRoot, actor: 'test', now: NOW })).rejects.toThrow(/simulated DB failure/);
    const abort = new globalThis.AbortController();
    await expect(buildAutonomousDatasetVersion(prisma, { rootDir: repoRoot, actor: 'test', now: NOW, replayPageSize: 2, signal: abort.signal, onProgress: (value) => value.phase === 'REPLAY' && value.replay.processed > 0 && abort.abort() })).rejects.toThrow(/CANCELLED/);
    expect(await prisma.mlDatasetVersion.count()).toBe(versionsBefore);
    expect(readdirSync(datasetsRoot).sort()).toEqual(dirsBefore);
    const after = fingerprintFiles();
    for (const [file, hash] of fingerprint) expect(after.get(file), file).toBe(hash);
  }, 300_000);

  it('web job: measured progress and phase log while preparing; cancel during the build ends CANCELLED', async () => {
    const versionsBefore = await prisma.mlDatasetVersion.count();
    let seenProgress: any = null;
    const ok = await prisma.mlTrainingJob.create({ data: { kind: KIND, requestedBy: 'test@soltrader.local' } });
    await new TrainingJobRunner({
      prisma, logger, rootDir: repoRoot, python: 'python', owner: `ds-${run}`, timeoutMs: 60_000, heartbeatMs: 50, kind: KIND, allowSmall: true,
      buildDataset: (client, options) => buildAutonomousDatasetVersion(client, { ...options, now: NOW, replayPageSize: 3 }),
      runTrainer: async () => {
        seenProgress = ((await prisma.mlTrainingJob.findUniqueOrThrow({ where: { id: ok.id } })).result as any)?.progress;
        return { exitCode: 0, status: 'TRAINED', failures: [], dir: '/none', bundleVersion: 'X', readiness: 'INSUFFICIENT_DATA', cancelled: false, timedOut: false, stderrTail: '' };
      },
      register: async () => ({ bundleVersion: `ML-AUTO-${P}`, readiness: 'INSUFFICIENT_DATA', artifactHash: 'x' }),
    }).poll();
    const done = await prisma.mlTrainingJob.findUniqueOrThrow({ where: { id: ok.id } });
    created.datasets.push(done.datasetVersion!);
    expect(done.status).toBe('COMPLETED');
    expect(seenProgress).toMatchObject({ phase: 'DONE' });
    expect(seenProgress.csv.rowsWritten).toBeGreaterThan(0);
    const messages = (done.log as Array<{ message: string }>).map((entry) => entry.message).join('\n');
    for (const text of ['REPLAY sorok előállítása', 'LIVE sorok előállítása', 'CSV írása', 'Manifest és checksum', 'Dataset regisztrálása']) expect(messages).toContain(text);

    const cancelled = await prisma.mlTrainingJob.create({ data: { kind: KIND, requestedBy: 'test@soltrader.local' } });
    await new TrainingJobRunner({
      prisma, logger, rootDir: repoRoot, python: 'python', owner: `ds-${run}`, timeoutMs: 60_000, heartbeatMs: 50, kind: KIND,
      buildDataset: async (client, options) => {
        await prisma.mlTrainingJob.update({ where: { id: cancelled.id }, data: { cancelRequested: true } });
        await new Promise((resolve) => globalThis.setTimeout(resolve, 400)); // the heartbeat reads the flag and aborts
        return buildAutonomousDatasetVersion(client, { ...options, now: NOW });
      },
      runTrainer: async () => { throw new Error('must not train'); },
    }).poll();
    const end = await prisma.mlTrainingJob.findUniqueOrThrow({ where: { id: cancelled.id } });
    expect(end.status).toBe('CANCELLED');
    expect(end.datasetVersion).toBeNull();
    expect(await prisma.mlDatasetVersion.count()).toBe(versionsBefore + 1);
    expect(readdirSync(datasetsRoot).filter((name) => name.startsWith(BUILD_DIR_PREFIX))).toEqual([]);
  }, 300_000);

  it('recovery removes only the work directories of finished jobs', async () => {
    const failed = await prisma.mlTrainingJob.create({ data: { kind: KIND, requestedBy: 'test', status: 'FAILED', error: 'INTERRUPTED' } });
    const running = await prisma.mlTrainingJob.create({ data: { kind: KIND, requestedBy: 'test', status: 'TRAINING' } });
    const make = (root: string, name: string, owner: unknown) => {
      const dir = path.join(root, name);
      mkdirSync(dir, { recursive: true });
      if (owner !== undefined) writeFileSync(path.join(dir, 'owner.json'), JSON.stringify(owner));
      created.dirs.push(dir);
      return dir;
    };
    const stale = make(datasetsRoot, `${BUILD_DIR_PREFIX}${P}a`, { jobId: failed.id });
    const staleWork = make(modelsRoot, `${WORK_DIR_PREFIX}${P}b`, { jobId: failed.id });
    const active = make(datasetsRoot, `${BUILD_DIR_PREFIX}${P}c`, { jobId: running.id });
    const cli = make(datasetsRoot, `${BUILD_DIR_PREFIX}${P}d`, { jobId: null });
    const unknown = make(datasetsRoot, `${BUILD_DIR_PREFIX}${P}e`, undefined);
    const removed = await new TrainingJobRunner({ prisma, logger, rootDir: repoRoot, python: 'python', owner: `ds-${run}`, timeoutMs: 1_000, kind: KIND }).cleanup();
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(staleWork)).toBe(false);
    for (const dir of [active, cli, unknown]) expect(existsSync(dir), dir).toBe(true);
    expect(removed.sort()).toEqual([path.join(AUTONOMOUS_DATASETS_DIR, `${BUILD_DIR_PREFIX}${P}a`), path.join(AUTONOMOUS_MODELS_DIR, `${WORK_DIR_PREFIX}${P}b`)].map((name) => name.replace(/\\/g, '/')).sort());
    // The FAILED (INTERRUPTED) history is kept.
    expect(await prisma.mlTrainingJob.findUniqueOrThrow({ where: { id: failed.id } })).toMatchObject({ status: 'FAILED', error: 'INTERRUPTED' });
    expect(ENTRY_HORIZON_MS).toBeGreaterThan(0);
  }, 120_000);
});
