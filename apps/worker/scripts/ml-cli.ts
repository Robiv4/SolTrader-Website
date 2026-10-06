/**
 * SolTrader ML command line (explicit actions only; nothing here runs automatically).
 *
 *   pnpm ml:setup                       create ml/.venv (Python 3.12 x64) and install pinned requirements
 *   pnpm ml:schema                      export ML_FEATURE_SCHEMA -> ml/schema/features-v1.json
 *   pnpm ml:dataset [--target T] [--kind AGE_30S] [--min-quality 50]
 *                                       build an immutable dataset version from DB snapshots + outcomes
 *   pnpm ml:train [--dataset VERSION] [--seed 42]
 *                                       train baseline + LightGBM offline, register models as TRAINED
 *   pnpm ml:status                      shadow collection / model status
 *   pnpm ml:test                        Python tests (split / purge / reproducibility / export parity)
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
  buildMlDataset, ML_FEATURE_VERSION, ML_LABEL_VERSION, ML_TARGETS, mlFeatureSchemaJson,
  type CandidateOutcomeResult, type MlDatasetSourceRow, type MlFeatures,
} from '@soltrader/strategy-engine';
import { createClient } from 'redis';

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
  const target = path.join(ML_DIR, 'schema', 'features-v1.json');
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(mlFeatureSchemaJson(), null, 2)}\n`);
  console.log(`schema written: ${path.relative(ROOT, target)} (${ML_FEATURE_VERSION})`);
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
    const snapshots = await prisma.mlFeatureSnapshot.findMany({
      where: { featureVersion: ML_FEATURE_VERSION, kind },
      include: { outcome: { select: { status: true, result: true } } },
      orderBy: [{ snapshotAt: 'asc' }, { id: 'asc' }],
    });
    // Realised PAPER P&L of candidates that were actually bought (joined by mint, position opened after the snapshot).
    const mints = [...new Set(snapshots.filter((row) => row.decision === 'BUY').map((row) => row.mint))];
    const trades = mints.length ? await prisma.trade.findMany({ where: { tokenAddress: { in: mints }, decisionSource: 'NEW_LAUNCH', status: 'CLOSED' }, select: { tokenAddress: true, netPnl: true, entryAt: true } }) : [];
    const rows: MlDatasetSourceRow[] = snapshots.map((row) => {
      const trade = trades.filter((item) => item.tokenAddress === row.mint && item.entryAt && item.entryAt.getTime() >= row.snapshotAt.getTime() - 60_000).sort((a, b) => a.entryAt!.getTime() - b.entryAt!.getTime())[0];
      const outcome = row.outcome && row.outcome.status !== 'TRACKING' ? row.outcome.result as unknown as CandidateOutcomeResult : null;
      return {
        snapshotId: row.id, candidateId: row.candidateId, mint: row.mint, source: row.source, kind: row.kind, snapshotAt: row.snapshotAt.getTime(), featureVersion: row.featureVersion,
        features: row.features as MlFeatures, validForTraining: row.validForTraining, invalidReasons: row.invalidReasons as string[], dataQuality: row.dataQuality,
        decision: row.decision, outcome, paperNetPnl: trade?.netPnl !== undefined && trade.netPnl !== null ? Number(trade.netPnl) : null,
      };
    });
    const existing = await prisma.mlDatasetVersion.count();
    const version = option('version', `NL-DATASET-v${existing + 1}`);
    const config = { version, featureVersion: ML_FEATURE_VERSION, labelVersion: ML_LABEL_VERSION, target, snapshotKind: kind, minDataQuality: minQuality };
    const built = buildMlDataset(rows, config);
    const directory = path.join(ML_DIR, 'datasets', version);
    if (existsSync(directory)) throw new Error(`Dataset ${version} already exists (immutable)`);
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, 'dataset.csv'), built.csv);
    const fileHash = sha256(built.csv);
    const manifest = { ...built.manifest, createdAt: new Date().toISOString(), fileHash, snapshotIds: rows.length };
    writeFileSync(path.join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    await prisma.mlDatasetVersion.create({ data: { version, featureVersion: ML_FEATURE_VERSION, labelVersion: ML_LABEL_VERSION, target, config: config as Prisma.InputJsonValue, manifest: manifest as unknown as Prisma.InputJsonValue, rowCount: built.rows, filePath: path.relative(ROOT, path.join(directory, 'dataset.csv')).replace(/\\/g, '/'), fileHash, createdBy: actor } });
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
    const run = spawnSync(PYTHON, ['-m', 'soltrader_ml.train', '--dataset', directory, '--out', path.join(ML_DIR, 'models'), '--seed', option('seed', '42')], { cwd: ML_DIR, encoding: 'utf8' });
    process.stderr.write(run.stderr ?? '');
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
      await prisma.mlModelVersion.create({
        data: {
          version: metadata.modelVersion, algorithm: metadata.algorithm, status: 'TRAINED', readiness: metadata.readiness, featureVersion: metadata.featureVersion,
          labelVersion: metadata.labelVersion, target: metadata.target, datasetVersion: version, config: metadata.config, artifactPath, artifactHash,
          metrics: { metrics: metadata.metrics, walkForward: metadata.walkForward, walkForwardAucStd: metadata.walkForwardAucStd, overfittingRisk: metadata.overfittingRisk, featureImportance: metadata.featureImportance, socialAblation: metadata.socialAblation, bySource: metadata.bySource, calibration: metadata.calibration, quality: metadata.quality, split: metadata.split, periods: metadata.periods, packages: metadata.packages } as Prisma.InputJsonValue,
          statusHistory: [{ status: 'TRAINED', at: new Date().toISOString(), by: actor }] as Prisma.InputJsonValue, createdBy: actor, trainedAt: new Date(metadata.trainedAt),
        },
      });
      await audit(prisma, 'ml_model_registered', { modelVersion: metadata.modelVersion, readiness: metadata.readiness, artifactHash });
      console.log(`registered ${metadata.modelVersion} (${metadata.algorithm}) readiness=${metadata.readiness} testAUC=${metadata.metrics.test.rocAuc ?? '—'}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

async function status() {
  const prisma = new PrismaClient();
  const redis = createClient({ url: process.env.REDIS_URL });
  try {
    await redis.connect().catch(() => undefined);
    const health = redis.isOpen ? await redis.get('ml:health').catch(() => null) : null;
    const [snapshots, outcomes, datasets, models] = await Promise.all([
      prisma.mlFeatureSnapshot.groupBy({ by: ['kind'], _count: { _all: true } }),
      prisma.mlCandidateOutcome.groupBy({ by: ['status'], _count: { _all: true } }),
      prisma.mlDatasetVersion.findMany({ select: { version: true, rowCount: true, createdAt: true }, orderBy: { createdAt: 'desc' }, take: 5 }),
      prisma.mlModelVersion.findMany({ select: { version: true, algorithm: true, status: true, readiness: true }, orderBy: { createdAt: 'desc' }, take: 10 }),
    ]);
    console.log(JSON.stringify({ worker: health ? JSON.parse(health) : 'no ml:health (worker not running?)', snapshots, outcomes, datasets, models }, null, 2));
  } finally {
    if (redis.isOpen) await redis.quit();
    await prisma.$disconnect();
  }
}

function test() {
  if (!existsSync(PYTHON)) throw new Error('Python environment missing: run pnpm ml:setup');
  const run = spawnSync(PYTHON, ['-m', 'pytest', '-q'], { cwd: ML_DIR, stdio: 'inherit' });
  process.exitCode = run.status ?? 1;
}

const command = process.argv[2];
const commands: Record<string, () => unknown> = { setup, schema: writeSchema, dataset, train, status, test };
if (!commands[command]) {
  console.error(`Usage: ml-cli <${Object.keys(commands).join('|')}>`);
  process.exit(1);
}
await Promise.resolve(commands[command]()).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
