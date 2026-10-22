/**
 * ml-trainer: separate process for web-started ML training jobs (`pnpm --dir apps/worker training`, Docker service
 * `ml-trainer`). It never trades and never runs inside the trading worker, so the worker and the Exit Engine are never
 * blocked. One job at a time; CPU priority / threads / timeout are configurable; container memory / CPU limits apply.
 *
 * Environment: DATABASE_URL (inside Docker: the compose network address, e.g. postgres:5432), REDIS_URL / REDIS_PASSWORD
 * (optional, health only), ML_PYTHON, ML_TRAINER_TIMEOUT_MIN (120), ML_TRAINER_NICE (10), ML_TRAINER_THREADS (1).
 */
import { hostname } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';
import { createClient } from 'redis';

import { TrainingJobRunner } from './job-runner.js';
import { defaultPython } from './pipeline.js';

dotenv.config({ path: ['.env.local', '.env', '../../.env.local', '../../.env'] });

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const positive = (value: string | undefined, fallback: number) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback);
const logger = {
  info: (payload: unknown, message?: string) => console.log(JSON.stringify({ level: 'info', message, ...(payload as object) })),
  warn: (payload: unknown, message?: string) => console.warn(JSON.stringify({ level: 'warn', message, ...(payload as object) })),
};

const prisma = new PrismaClient();
const runner = new TrainingJobRunner({
  prisma, logger, rootDir: ROOT, python: defaultPython(ROOT), owner: `${hostname()}:${process.pid}`,
  timeoutMs: positive(process.env.ML_TRAINER_TIMEOUT_MIN, 120) * 60_000, niceLevel: positive(process.env.ML_TRAINER_NICE, 10), threads: positive(process.env.ML_TRAINER_THREADS, 1),
});

const redis = process.env.REDIS_URL ? createClient({ url: process.env.REDIS_URL, ...(process.env.REDIS_PASSWORD ? { password: process.env.REDIS_PASSWORD } : {}) }) : null;
redis?.on('error', () => undefined);
await redis?.connect().catch(() => undefined);
const publish = () => void redis?.set('ml:trainer:health', JSON.stringify(runner.health()), { EX: 60 }).catch(() => undefined);
const healthTimer = globalThis.setInterval(publish, 10_000);
publish();

runner.start(5_000);
logger.info({ python: path.basename(defaultPython(ROOT)), owner: `${hostname()}:${process.pid}` }, 'ml-trainer started (no trading in this process)');

const shutdown = async () => {
  globalThis.clearInterval(healthTimer);
  await runner.stop();
  await redis?.quit().catch(() => undefined);
  await prisma.$disconnect();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
