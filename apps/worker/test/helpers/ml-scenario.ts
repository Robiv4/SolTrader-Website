/* eslint-disable @typescript-eslint/no-explicit-any -- in-memory prisma fakes */
/**
 * Shared New Launch scenario for the ML PAPER tests: one launch with accelerating trades, ticks every 2 s, optional
 * SHADOW service, ML PAPER engine with a constant-probability model, optional social source.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { MlModelArtifact } from '@soltrader/strategy-engine';

import { NewLaunchService } from '../../src/launch/new-launch-service.js';
import type { LaunchHandlers } from '../../src/launch/providers.js';
import { MlPaperEntryEngine, MlPaperModelRegistry } from '../../src/ml/ml-paper-engine.js';
import { MlShadowService } from '../../src/ml/ml-shadow-service.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(path.join(here, '..', '..', '..', '..', 'packages', 'strategy-engine', 'test', 'fixtures', 'ml-parity.json'), 'utf8')) as Record<string, { artifact: MlModelArtifact }>;
const MINT = 'MLpaperMint1111111111111111111111111111111pump';
const logger = { info: () => undefined, warn: (payload: unknown, message?: string) => { if (process.env.DBG) console.log('WARN', message, JSON.stringify(payload)); }, error: (payload: unknown, message?: string) => { if (process.env.DBG) console.log('ERR', message, JSON.stringify(payload)); } };

const constantArtifact = (version: string, p: number): MlModelArtifact => ({ ...fixture.LR.artifact, modelVersion: version, calibration: null, logistic: { coef: fixture.LR.artifact.columns.map(() => 0), intercept: Math.log(p / (1 - p)) } });

interface Strategy { mode: 'DEFAULT' | 'ML'; probability?: number; approved?: boolean; engine?: 'real' | 'throwing' | 'none'; /** New Launch config overrides of the user (e.g. thresholds, quality gate). */ config?: Record<string, unknown>; /** Token security (default: authorities revoked, classic SPL). */ mint?: { mintAuthority: string | null; freezeAuthority: string | null; tokenProgram: string; extensions: string[] } }

function fakePrisma(record: { decisions: any[]; signals: any[]; signalMetadata: any[]; ml: Record<string, any[]> }, strategy: Strategy) {
  let id = 0;
  const overrides: Record<string, Record<string, (args: any) => any>> = {
    newLaunchConfig: { findMany: () => [{ userId: 'u1', enabled: true, ...strategy.config }] },
    botConfig: {
      findMany: () => [{ userId: 'u1', minLiquidityUsd: null, minVolumeUsd: null, maxTokenAgeHours: 168, user: { riskConfigs: [{ riskPolicy: 'EXPLORATORY', maxSlippagePercent: 50, lowRiskMax: 30, moderateRiskMax: 50, highRiskMax: 90, veryHighRiskMax: 100, lowPositionMultiplier: 1, moderatePositionMultiplier: 1, highPositionMultiplier: 1, veryHighPositionMultiplier: 1 }] } }],
      findUnique: () => ({ tradingMode: 'PAPER' }),
    },
    paperAccount: { findUnique: () => ({ equity: 1_000 }) },
    launchDecision: { create: ({ data }: any) => { record.decisions.push({ decision: data.decision, status: data.status, reasons: data.reasons, score: data.score }); return { id: `d${++id}` }; } },
    signal: { create: ({ data }: any) => { record.signals.push({ strategyName: data.strategyName, direction: data.direction, entryStrategy: data.metadata.entryStrategy, ml: data.metadata.ml }); record.signalMetadata.push(data.metadata); return { id: `s${++id}` }; } },
    mlPaperSettings: { findMany: () => (strategy.mode === 'ML' ? [{ userId: 'u1', strategyMode: 'ML', modelVersion: 'M1', buyThreshold: 0.7, decisionWindowSeconds: 30 }] : [{ userId: 'u1', strategyMode: 'DEFAULT', modelVersion: null, buyThreshold: 0.7, decisionWindowSeconds: 10 }]) },
  };
  const shadowTable = (model: string) => ({
    create: async ({ data }: any) => { (record.ml[model] ??= []).push(data); return { id: `${model}-${++id}` }; },
    update: async ({ data }: any) => { (record.ml[`${model}.update`] ??= []).push(data); return {}; },
    findMany: async () => [],
    findFirst: async () => null,
  });
  return new Proxy({}, {
    get(_target, model: string) {
      if (overrides[model]) {
        return new Proxy({}, { get: (_inner, method: string) => async (args: any) => (overrides[model][method] ? overrides[model][method](args) : method === 'findMany' ? [] : null) });
      }
      if (model.startsWith('ml')) return shadowTable(model);
      return new Proxy({}, {
        get(_inner, method: string) {
          return async (args: any) => {
            if (method === 'findMany') return [];
            if (method === 'findUnique' || method === 'findFirst') return null;
            if (method === 'count') return 0;
            if (method === 'updateMany' || method === 'deleteMany') return { count: 0 };
            return { id: `${model}-${++id}`, ...(args?.data ?? args?.create ?? {}) };
          };
        },
      });
    },
  }) as any;
}

function mlPaper(strategy: Strategy) {
  const decisions: any[] = [];
  const artifact = constantArtifact('M1', strategy.probability ?? 0.9);
  const content = JSON.stringify(artifact);
  const model = { version: 'M1', status: 'SHADOW', paperApproved: strategy.approved ?? true, featureVersion: 'ML-FEATURES-v1', datasetVersion: 'DS', artifactPath: 'ml/models/M1/model.json', artifactHash: createHash('sha256').update(content).digest('hex') };
  let id = 0;
  const prisma = {
    mlModelVersion: { findUnique: async () => model },
    mlDatasetVersion: { findUnique: async () => ({ config: { snapshotKind: 'AGE_30S', minDataQuality: 0 } }) },
    mlPaperDecision: {
      findUnique: async ({ where }: any) => decisions.find((row) => row.userId === where.userId_mint.userId && row.mint === where.userId_mint.mint) ?? null,
      create: async ({ data }: any) => { const row = { id: `pd${++id}`, ...data }; decisions.push(row); return row; },
      update: async ({ where, data }: any) => Object.assign(decisions.find((row) => row.id === where.id)!, data),
    },
  } as any;
  if (strategy.engine === 'throwing') return { decisions, engine: { step: async () => { throw new Error('engine down'); }, markSignaled: async () => { throw new Error('engine down'); }, resolved: () => false } };
  const registry = new MlPaperModelRegistry({ prisma, repoRoot: process.cwd(), logger, loadArtifact: async () => JSON.parse(content) });
  return { decisions, engine: new MlPaperEntryEngine({ prisma, registry, logger }) };
}

export async function runScenario(strategy: Strategy, options: { shadow?: boolean; social?: (now: () => number) => any } = {}) {
  let now = Date.parse('2026-10-05T10:00:00Z');
  const record = { decisions: [] as any[], signals: [] as any[], signalMetadata: [] as any[], ml: {} as Record<string, any[]> };
  const prisma = fakePrisma(record, strategy);
  const paper = strategy.engine === 'none' ? null : mlPaper(strategy);
  const shadow = options.shadow ? new MlShadowService({ prisma, logger, mode: 'SHADOW', repoRoot: process.cwd(), now: () => now }) : undefined;
  let handlers: LaunchHandlers | null = null;
  const provider = { source: 'PUMP_FUN' as const, subscribe: (h: LaunchHandlers) => { handlers = h; }, unsubscribe: () => undefined, healthCheck: () => ({ source: 'PUMP_FUN' as const, label: 'Pump.fun', status: 'ACTIVE' as const, detail: null, lastEventAt: null, events: 0 }) };
  const service = new NewLaunchService({
    prisma, providers: [provider as any], logger, now: () => now,
    marketData: { getTokenMetrics: async () => ({ priceUsd: 150, metadata: { address: 'So11111111111111111111111111111111111111112' } }) } as any,
    getMintInfo: async () => strategy.mint ?? ({ mintAuthority: null, freezeAuthority: null, tokenProgram: 'spl-token', extensions: [] }),
    store: { set: async () => 'OK', incrBy: async () => 1, expire: async () => 1 },
    publish: async () => undefined,
    ml: shadow,
    mlPaper: paper?.engine as any,
    social: options.social?.(() => now),
  });
  service.start();
  service.stop();
  const h = handlers!;
  await h.onLaunch({ source: 'PUMP_FUN', mint: MINT, detectedAt: now, createdAt: now - 1_000, bondingCurve: 'Curve1111', poolAddress: 'Curve1111', quoteMint: 'So11111111111111111111111111111111111111112', creator: 'Creator111', name: 'Paper', symbol: 'PPR' });
  let virtualSol = 30;
  let virtualToken = 1_073_000_000;
  for (let step = 0; step < 60; step += 1) {
    for (let k = 0; k < 3 + Math.floor(step / 6); k += 1) {
      const isBuy = (step + k) % 7 !== 0;
      const sol = isBuy ? 0.4 : 0.15;
      const tokens = (sol / virtualSol) * virtualToken;
      virtualSol += isBuy ? sol : -sol;
      virtualToken += isBuy ? -tokens : tokens;
      h.onTrade?.({ mint: MINT, wallet: `w${step}-${k}`, isBuy, solAmount: sol, tokenAmount: tokens, timestamp: now, virtualSolReserves: virtualSol, virtualTokenReserves: virtualToken, realSolReserves: virtualSol - 30, slot: step, signature: `sig${step}-${k}`, receivedAt: now });
    }
    await service.tick();
    now += 2_000;
  }
  if (shadow) await shadow.flush();
  return { record, paperDecisions: paper?.decisions ?? [] };
}

