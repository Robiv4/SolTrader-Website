/**
 * SolTrader ML command line (explicit actions only; nothing here runs automatically).
 *
 *   pnpm ml:setup                       create ml/.venv (Python 3.12 x64) and install pinned requirements
 *   pnpm ml:schema                      export the feature schemas -> ml/schema/features-v1.json, features-community-v1.json
 *   pnpm ml:dataset [--target T] [--kind AGE_30S] [--min-quality 50] [--feature-version ML-FEATURES-v1]
 *                                       build an immutable dataset version from DB snapshots + outcomes
 *                                       (--feature-version ML-FEATURES-COMMUNITY-v1: community snapshots, outcome of the
 *                                       same candidate's v1 snapshot; default version name COMMUNITY-v<n>)
 *   pnpm ml:train [--dataset VERSION] [--seed 42]
 *                                       train baseline + LightGBM offline, register models as TRAINED
 *   pnpm ml:status                      shadow collection / model status
 *   pnpm ml:test                        Python tests (split / purge / reproducibility / export parity)
 *   pnpm ml:autonomous:dataset          Autonomous ML dataset (ML-FEATURES-AUTONOMOUS-v1, AUTO-LABELS-v1): replayed entries /
 *                                       positions from outcome paths + labelled live decision snapshots (streamed,
 *                                       bounded memory; the same builder as the web training; refused while a web
 *                                       training job runs unless --force)
 *   pnpm ml:autonomous:train [--dataset AUTO-DATASET-vN] [--seed 42]
 *                                       train the Autonomous bundle (entry value / downside / profit, exit value / hold),
 *                                       register it as TRAINED (never approved, selected or activated automatically)
 *   pnpm ml:autonomous:status           bundles, snapshots, decisions, accounts
 *
 * Model promotion (TRAINED -> VALIDATED -> SHADOW) is an explicit admin action in the UI (e-mail confirmed).
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Prisma, PrismaClient } from '@prisma/client';
import {
  buildMlDataset, isSupportedFeatureVersion, ML_AUTONOMOUS_FEATURE_VERSION, mlAutonomousFeatureSchemaJson, ML_COMMUNITY_FEATURE_VERSION, ML_FEATURE_VERSION, ML_LABEL_VERSION, ML_TARGETS, mlCommunityFeatureSchemaJson, mlFeatureSchemaJson,
  type CandidateOutcomeResult, type MlDatasetSourceRow, type MlFeatures, type OutcomePathState,
} from '@soltrader/strategy-engine';
import { createClient } from 'redis';

import { chunk, indexPaperTrades, loadAllPages, loadPaperTradesInBatches, matchPaperTrade, paperProvenance } from '../src/ml/dataset-source.js';
import { ML_TRAINING_KEY, registerTrainedModel } from '../src/ml/model-registration.js';
import { buildAutonomousDatasetVersion, defaultPython, registerTrainerOutput, runAutonomousTrainer, sha256File } from '../src/training/pipeline.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
// Server-side configuration (DATABASE_URL, REDIS_URL) from the repository .env; values are never printed.
if (existsSync(path.join(ROOT, '.env'))) process.loadEnvFile(path.join(ROOT, '.env'));
const ML_DIR = path.join(ROOT, 'ml');
const PYTHON = process.platform === 'win32' ? path.join(ML_DIR, '.venv', 'Scripts', 'python.exe') : path.join(ML_DIR, '.venv', 'bin', 'python');
const args = process.argv.slice(3);
const option = (name: string, fallback: string) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const actor = `cli:${userInfo().username}`;
const sha256 = (content: string | Buffer) => createHash('sha256').update(content).digest('hex');

async function audit(prisma: PrismaClient, action: string, details: Record<string, unknown>) {
  await prisma.auditLog.create({ data: { userId: null, action, details: { ...details, actor } as Prisma.InputJsonValue } }).catch(() => undefined);
}

function writeSchema() {
  for (const [file, schema, version] of [['features-v1.json', mlFeatureSchemaJson(), ML_FEATURE_VERSION], ['features-community-v1.json', mlCommunityFeatureSchemaJson(), ML_COMMUNITY_FEATURE_VERSION], ['features-autonomous-v1.json', mlAutonomousFeatureSchemaJson(), ML_AUTONOMOUS_FEATURE_VERSION]] as const) {
    const target = path.join(ML_DIR, 'schema', file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, `${JSON.stringify(schema, null, 2)}\n`);
    console.log(`schema written: ${path.relative(ROOT, target)} (${version})`);
  }
}

function setup() {
  const candidates = process.platform === 'win32'
    ? [path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Python', 'Python312', 'python.exe'), 'python']
    : ['python3.12', 'python3'];
  const base = candidates.find((candidate) => candidate === 'python' || candidate.startsWith('python3') || existsSync(candidate))!;
  if (!existsSync(PYTHON)) {
    const venv = spawnSync(base, ['-m', 'venv', path.join(ML_DIR, '.venv')], { stdio: 'inherit' });
    if (venv.status !== 0) throw new Error('venv creation failed (Python 3.12 x64 required, see docs/ML_SYSTEM.md)');
  }
  const install = spawnSync(PYTHON, ['-m', 'pip', 'install', '--disable-pip-version-check', '-r', path.join(ML_DIR, 'requirements.txt')], { stdio: 'inherit' });
  if (install.status !== 0) throw new Error('pip install failed');
  writeSchema();
}

async function dataset() {
  const prisma = new PrismaClient();
  try {
    const target = option('target', 'plus20BeforeMinus10_30m');
    if (!ML_TARGETS[target]) throw new Error(`Unknown target ${target}. Known: ${Object.keys(ML_TARGETS).join(', ')}`);
    const kind = option('kind', 'AGE_30S');
    const minQuality = Number(option('min-quality', '50'));
    const featureVersion = option('feature-version', ML_FEATURE_VERSION);
    if (!isSupportedFeatureVersion(featureVersion)) throw new Error(`Unsupported feature version ${featureVersion}`);
    // The simulated-exit target needs the recorded price path; other targets do not load it (large JSON).
    const withPath = ML_TARGETS[target].kind === 'simulated_exit';
    // Paged (keyset on id after the same ordering): the outcome include never exceeds the bind-parameter limit.
    const snapshots = await loadAllPages((cursor, take) => prisma.mlFeatureSnapshot.findMany({
      where: { featureVersion, kind },
      include: { outcome: { select: { status: true, result: true, path: withPath } } },
      orderBy: [{ snapshotAt: 'asc' }, { id: 'asc' }],
      take,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    }));
    // Realised PAPER P&L of candidates that were actually bought by EITHER strategy (DEFAULT or ML; joined by mint,
    // trade opened after the snapshot). Provenance only: never a feature; skipped candidates get no P&L. Needed for
    // every target: paper_trade targets label with it, classification targets carry it in the CSV (paper_net_pnl),
    // the manifest and the training threshold curve. Queried in batches of <= 1000 mints (bind-parameter limit).
    const trades = await loadPaperTradesInBatches(snapshots.map((row) => row.mint), (batch) => prisma.trade.findMany({
      where: { tokenAddress: { in: batch }, decisionSource: 'NEW_LAUNCH', status: 'CLOSED' },
      select: { tokenAddress: true, netPnl: true, entryAt: true, exitAt: true, entryStrategy: true },
    }));
    const tradeIndex = indexPaperTrades(trades);
    // Community snapshots carry no outcome of their own: the label is the outcome of the SAME candidate's v1 snapshot of
    // the same kind (same moment, same reference price). Loaded in batches (bind-parameter limit).
    type OutcomeRow = { status: string; result: unknown; path?: unknown } | null;
    const sharedOutcome = new Map<string, OutcomeRow>();
    if (featureVersion !== ML_FEATURE_VERSION) {
      for (const batch of chunk([...new Set(snapshots.map((row) => row.candidateId))], 1_000)) {
        const v1 = await prisma.mlFeatureSnapshot.findMany({ where: { featureVersion: ML_FEATURE_VERSION, kind, candidateId: { in: batch } }, select: { candidateId: true, outcome: { select: { status: true, result: true, path: withPath } } } });
        for (const row of v1) sharedOutcome.set(row.candidateId, row.outcome);
      }
    }
    const rows: MlDatasetSourceRow[] = snapshots.map((row) => {
      const trade = matchPaperTrade(tradeIndex, row.mint, row.snapshotAt.getTime());
      const source: OutcomeRow = featureVersion === ML_FEATURE_VERSION ? row.outcome : sharedOutcome.get(row.candidateId) ?? null;
      const outcome = source && source.status !== 'TRACKING' ? source.result as unknown as CandidateOutcomeResult : null;
      return {
        snapshotId: row.id, candidateId: row.candidateId, mint: row.mint, source: row.source, kind: row.kind, snapshotAt: row.snapshotAt.getTime(), featureVersion: row.featureVersion,
        features: row.features as MlFeatures, validForTraining: row.validForTraining, invalidReasons: row.invalidReasons as string[], dataQuality: row.dataQuality,
        decision: row.decision, outcome, outcomePath: withPath && source?.path ? source.path as unknown as OutcomePathState : null, ...paperProvenance(trade),
      };
    });
    const community = featureVersion === ML_COMMUNITY_FEATURE_VERSION;
    const existing = await prisma.mlDatasetVersion.count({ where: community ? { featureVersion } : { featureVersion: { not: ML_COMMUNITY_FEATURE_VERSION } } });
    const version = option('version', community ? `COMMUNITY-v${existing + 1}` : `NL-DATASET-v${existing + 1}`);
    const config = { version, featureVersion, labelVersion: ML_LABEL_VERSION, target, snapshotKind: kind, minDataQuality: minQuality };
    const built = buildMlDataset(rows, config);
    const directory = path.join(ML_DIR, 'datasets', version);
    if (existsSync(directory)) throw new Error(`Dataset ${version} already exists (immutable)`);
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, 'dataset.csv'), built.csv);
    const fileHash = sha256(built.csv);
    const manifest = { ...built.manifest, createdAt: new Date().toISOString(), fileHash, snapshotIds: rows.length };
    writeFileSync(path.join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    await prisma.mlDatasetVersion.create({ data: { version, featureVersion, labelVersion: ML_LABEL_VERSION, target, config: config as Prisma.InputJsonValue, manifest: manifest as unknown as Prisma.InputJsonValue, rowCount: built.rows, filePath: path.relative(ROOT, path.join(directory, 'dataset.csv')).replace(/\\/g, '/'), fileHash, createdBy: actor } });
    await audit(prisma, 'ml_dataset_created', { version, rows: built.rows, target, fileHash });
    console.log(JSON.stringify({ version, rows: built.rows, positives: built.manifest.positives, readiness: built.manifest.readiness, excluded: built.manifest.excluded, directory: path.relative(ROOT, directory) }, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

async function train() {
  const prisma = new PrismaClient();
  try {
    const latest = await prisma.mlDatasetVersion.findFirst({ orderBy: { createdAt: 'desc' } });
    const version = option('dataset', latest?.version ?? '');
    if (!version) throw new Error('No dataset. Run pnpm ml:dataset first.');
    const datasetRow = await prisma.mlDatasetVersion.findUnique({ where: { version } });
    const directory = path.join(ML_DIR, 'datasets', version);
    if (!datasetRow || !existsSync(path.join(directory, 'dataset.csv'))) throw new Error(`Dataset ${version} not found`);
    if (sha256(readFileSync(path.join(directory, 'dataset.csv'))) !== datasetRow.fileHash) throw new Error('Dataset file hash mismatch (modified after creation)');
    if (!existsSync(PYTHON)) throw new Error('Python environment missing: run pnpm ml:setup');
    // Operating state MODEL_TRAINING (informational; data collection and trading continue untouched).
    const marker = await trainingMarker({ dataset: version, startedAt: new Date().toISOString(), by: actor });
    const run = spawnSync(PYTHON, ['-m', 'soltrader_ml.train', '--dataset', directory, '--out', path.join(ML_DIR, 'models'), '--seed', option('seed', '42')], { cwd: ML_DIR, encoding: 'utf8' });
    process.stderr.write(run.stderr ?? '');
    await marker.clear();
    const lastLine = (run.stdout ?? '').trim().split('\n').at(-1) ?? '{}';
    const result = JSON.parse(lastLine) as { status: string; failures?: string[]; models?: Array<{ dir: string }> };
    await audit(prisma, 'ml_training_run', { dataset: version, status: result.status, failures: result.failures ?? null, exitCode: run.status });
    if (run.status !== 0 || result.status !== 'TRAINED') {
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = run.status || 1;
      return;
    }
    for (const model of result.models ?? []) {
      const metadata = JSON.parse(readFileSync(path.join(model.dir, 'metadata.json'), 'utf8'));
      const artifactPath = path.relative(ROOT, path.join(model.dir, 'model.json')).replace(/\\/g, '/');
      const artifactHash = sha256(readFileSync(path.join(model.dir, 'model.json')));
      if (artifactHash !== metadata.artifactHash) throw new Error(`Artifact hash mismatch for ${metadata.modelVersion}`);
      // New immutable TRAINED row only: no approval, no selection change for any user (see model-registration.ts).
      await registerTrainedModel(prisma, {
        metadata, datasetVersion: version, artifactPath, artifactHash, actor,
        extraMetrics: { metrics: metadata.metrics, walkForward: metadata.walkForward, walkForwardAucStd: metadata.walkForwardAucStd, overfittingRisk: metadata.overfittingRisk, featureImportance: metadata.featureImportance, socialAblation: metadata.socialAblation, bySource: metadata.bySource, calibration: metadata.calibration, quality: metadata.quality, split: metadata.split, periods: metadata.periods, packages: metadata.packages },
      });
      await audit(prisma, 'ml_model_registered', { modelVersion: metadata.modelVersion, readiness: metadata.readiness, artifactHash });
      console.log(`registered ${metadata.modelVersion} (${metadata.algorithm}) readiness=${metadata.readiness} testAUC=${metadata.metrics.test.rocAuc ?? '—'}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

/** Redis marker of a running training (TTL 6 h; Redis problems never block training). */
async function trainingMarker(value: Record<string, unknown>) {
  const redis = createClient({ url: process.env.REDIS_URL, ...(process.env.REDIS_PASSWORD ? { password: process.env.REDIS_PASSWORD } : {}), socket: { connectTimeout: 3_000, reconnectStrategy: false } });
  redis.on('error', () => undefined);
  const connected = await redis.connect().then(() => true).catch(() => false);
  if (connected) await redis.set(ML_TRAINING_KEY, JSON.stringify(value), { EX: 6 * 3_600 }).catch(() => undefined);
  return {
    async clear() {
      if (!connected) return;
      await redis.del(ML_TRAINING_KEY).catch(() => undefined);
      await redis.quit().catch(() => undefined);
    },
  };
}

/** Redis target without credentials (host:port/db only). */
function maskedRedis(url: string | undefined) {
  try {
    const parsed = new URL(url ?? '');
    return `${parsed.protocol}//${parsed.hostname}:${parsed.port || '6379'}${parsed.pathname && parsed.pathname !== '/' ? parsed.pathname : ''}`;
  } catch {
    return 'invalid REDIS_URL';
  }
}

async function status() {
  const prisma = new PrismaClient();
  // Same connection settings as the worker (REDIS_URL + REDIS_PASSWORD).
  const redis = createClient({ url: process.env.REDIS_URL, ...(process.env.REDIS_PASSWORD ? { password: process.env.REDIS_PASSWORD } : {}), socket: { connectTimeout: 5_000, reconnectStrategy: false } });
  redis.on('error', () => undefined);
  let redisError: string | null = null;
  const keys: Record<string, { present: boolean; ttlSeconds: number | null }> = {};
  let health: unknown = null;
  try {
    try {
      await redis.connect();
      for (const key of ['ml:health', 'worker:heartbeat']) {
        const value = await redis.get(key);
        keys[key] = { present: value !== null, ttlSeconds: value !== null ? await redis.ttl(key) : null };
        if (key === 'ml:health' && value) health = JSON.parse(value);
      }
    } catch (error) {
      redisError = error instanceof Error ? error.message.slice(0, 200) : String(error);
    }
    const [snapshots, outcomes, datasets, models, lastSnapshot, lastOutcomeUpdate] = await Promise.all([
      prisma.mlFeatureSnapshot.groupBy({ by: ['kind'], _count: { _all: true } }),
      prisma.mlCandidateOutcome.groupBy({ by: ['status'], _count: { _all: true } }),
      prisma.mlDatasetVersion.findMany({ select: { version: true, rowCount: true, createdAt: true }, orderBy: { createdAt: 'desc' }, take: 5 }),
      prisma.mlModelVersion.findMany({ select: { version: true, algorithm: true, status: true, readiness: true }, orderBy: { createdAt: 'desc' }, take: 10 }),
      prisma.mlFeatureSnapshot.findFirst({ orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
      prisma.mlCandidateOutcome.findFirst({ orderBy: { updatedAt: 'desc' }, select: { updatedAt: true } }),
    ]);
    const ageSeconds = (date: Date | null | undefined) => (date ? Math.round((Date.now() - date.getTime()) / 1000) : null);
    const worker = health ?? (redisError
      ? `Redis unreachable from this shell (${maskedRedis(process.env.REDIS_URL)}): ${redisError}. The worker may still be running - see collection.lastSnapshotAgeSeconds.`
      : keys['worker:heartbeat']?.present
        ? 'worker heartbeat present but no ml:health (ML_MODE=OFF or an old worker build)'
        : `no worker:heartbeat / ml:health in ${maskedRedis(process.env.REDIS_URL)} (worker not running, or it uses a different Redis than this shell)`);
    console.log(JSON.stringify({
      redis: { target: maskedRedis(process.env.REDIS_URL), error: redisError, keys },
      worker,
      collection: { lastSnapshotAgeSeconds: ageSeconds(lastSnapshot?.createdAt), lastOutcomeUpdateAgeSeconds: ageSeconds(lastOutcomeUpdate?.updatedAt) },
      snapshots, outcomes, datasets, models,
    }, null, 2));
  } finally {
    if (redis.isOpen) await redis.quit().catch(() => undefined);
    await prisma.$disconnect();
  }
}

function test() {
  if (!existsSync(PYTHON)) throw new Error('Python environment missing: run pnpm ml:setup');
  const run = spawnSync(PYTHON, ['-m', 'pytest', '-q'], { cwd: ML_DIR, stdio: 'inherit' });
  process.exitCode = run.status ?? 1;
}

/** The web training (ml-trainer) and the CLI share one machine: never two heavy dataset / training runs at once. */
async function refuseWhileWebTrainingRuns(prisma: PrismaClient) {
  const active = await prisma.mlTrainingJob.findUnique({ where: { activeKey: 'ACTIVE' }, select: { id: true, status: true } });
  if (active && !args.includes('--force')) throw new Error(`A web training job is active (${active.id}, ${active.status}); wait for it or cancel it (--force overrides).`);
}

async function autonomousDataset() {
  const prisma = new PrismaClient();
  try {
    await refuseWhileWebTrainingRuns(prisma);
    let lastPhase = '';
    let lastAt = 0;
    // Same streaming builder as the web training (one implementation); real counts on stderr.
    const built = await buildAutonomousDatasetVersion(prisma, {
      rootDir: ROOT, actor, version: args.includes('--version') ? option('version', '') : undefined,
      onProgress: (progress) => {
        if (progress.phase === lastPhase && Date.now() - lastAt < 5_000) return;
        lastPhase = progress.phase;
        lastAt = Date.now();
        console.error(`dataset: ${progress.phase} replay ${progress.replay.processed}/${progress.replay.total} live ${progress.live.processed}/${progress.live.total} rows entry=${progress.rows.entry} position=${progress.rows.position} csv=${progress.csv.rowsWritten} rows ${Math.round(progress.csv.bytes / 1_048_576)} MB heap=${progress.heapUsedMb} MB`);
      },
    });
    await audit(prisma, 'ml_autonomous_dataset_created', { version: built.version, rows: built.rows, fileHash: built.fileHash });
    console.log(JSON.stringify({ version: built.version, rows: built.rows, coverage: built.manifest.coverage, directory: path.relative(ROOT, built.directory) }, (key, value) => (key === 'featureNullShare' ? undefined : value), 2));
  } finally {
    await prisma.$disconnect();
  }
}

async function autonomousTrain() {
  const prisma = new PrismaClient();
  try {
    const latest = await prisma.mlDatasetVersion.findFirst({ where: { featureVersion: ML_AUTONOMOUS_FEATURE_VERSION }, orderBy: { createdAt: 'desc' } });
    const version = option('dataset', latest?.version ?? '');
    if (!version) throw new Error('No autonomous dataset. Run pnpm ml:autonomous:dataset first.');
    const datasetRow = await prisma.mlDatasetVersion.findUnique({ where: { version } });
    const directory = path.join(ML_DIR, 'autonomous-datasets', version);
    if (!datasetRow || datasetRow.featureVersion !== ML_AUTONOMOUS_FEATURE_VERSION || !existsSync(path.join(directory, 'dataset.csv'))) throw new Error(`Autonomous dataset ${version} not found`);
    if (await sha256File(path.join(directory, 'dataset.csv')) !== datasetRow.fileHash) throw new Error('Dataset file hash mismatch (modified after creation)');
    await refuseWhileWebTrainingRuns(prisma);
    const python = defaultPython(ROOT);
    if (!existsSync(python)) throw new Error('Python environment missing: run pnpm ml:setup');
    const marker = await trainingMarker({ dataset: version, kind: 'AUTONOMOUS', startedAt: new Date().toISOString(), by: actor });
    const result = await runAutonomousTrainer({ python, rootDir: ROOT, datasetDir: directory, seed: Number(option('seed', '42')), timeoutMs: 6 * 3_600_000, allowSmall: args.includes('--allow-small'), onStage: (stage) => console.error(`stage: ${stage}`) });
    await marker.clear();
    await audit(prisma, 'ml_autonomous_training_run', { dataset: version, status: result.status, failures: result.failures, exitCode: result.exitCode });
    if (result.status !== 'TRAINED' || !result.dir) {
      console.log(JSON.stringify({ status: result.status, failures: result.failures, stderr: result.stderrTail.slice(-500) }, null, 2));
      process.exitCode = result.exitCode || 1;
      return;
    }
    const registered = await registerTrainerOutput(prisma, { rootDir: ROOT, dir: result.dir, datasetVersion: version, actor });
    await audit(prisma, 'ml_autonomous_bundle_registered', registered);
    console.log(`registered ${registered.bundleVersion} readiness=${registered.readiness} (TRAINED: not approved, not selected, not trading)`);
  } finally {
    await prisma.$disconnect();
  }
}

async function autonomousStatus() {
  const prisma = new PrismaClient();
  try {
    const [bundles, snapshots, decisions, accounts, open] = await Promise.all([
      prisma.mlAutonomousModelBundle.findMany({ orderBy: { trainedAt: 'desc' }, take: 10, select: { version: true, status: true, readiness: true, paperApproved: true, trainedAt: true } }),
      prisma.mlAutonomousDecisionSnapshot.groupBy({ by: ['kind'], _count: { _all: true } }),
      prisma.mlAutonomousDecision.groupBy({ by: ['mode', 'action', 'executionStatus'], _count: { _all: true } }),
      prisma.mlAutonomousAccount.count(),
      prisma.mlAutonomousPosition.count({ where: { status: 'OPEN' } }),
    ]);
    console.log(JSON.stringify({ bundles, snapshots, decisions, accounts, openPositions: open }, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

const command = process.argv[2];
const commands: Record<string, () => unknown> = { setup, schema: writeSchema, dataset, train, status, test, 'autonomous-dataset': autonomousDataset, 'autonomous-train': autonomousTrain, 'autonomous-status': autonomousStatus };
if (!commands[command]) {
  console.error(`Usage: ml-cli <${Object.keys(commands).join('|')}>`);
  process.exit(1);
}
await Promise.resolve(commands[command]()).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
