/* eslint-disable @typescript-eslint/no-explicit-any -- in-memory prisma fakes */
/**
 * New Launch with the selectable entry strategy (tests 1, 3, 6, 8, 10): the same launch scenario as the SHADOW isolation
 * test, run with the DEFAULT strategy, with an ML model that says BUY / SKIP, with a broken model and with a crashing
 * engine. Exactly one strategy can create the BUY signal; ML failures never open anything and never stop the tick;
 * the SHADOW collection is identical in every mode.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { MlModelArtifact } from '@soltrader/strategy-engine';
import { describe, expect, it } from 'vitest';

import { NewLaunchService } from '../src/launch/new-launch-service.js';
import type { LaunchHandlers } from '../src/launch/providers.js';
import { MlPaperEntryEngine, MlPaperModelRegistry } from '../src/ml/ml-paper-engine.js';
import { MlShadowService } from '../src/ml/ml-shadow-service.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(path.join(here, '..', '..', '..', 'packages', 'strategy-engine', 'test', 'fixtures', 'ml-parity.json'), 'utf8')) as Record<string, { artifact: MlModelArtifact }>;
const MINT = 'MLpaperMint1111111111111111111111111111111pump';
const logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

const constantArtifact = (version: string, p: number): MlModelArtifact => ({ ...fixture.LR.artifact, modelVersion: version, calibration: null, logistic: { coef: fixture.LR.artifact.columns.map(() => 0), intercept: Math.log(p / (1 - p)) } });

interface Strategy { mode: 'DEFAULT' | 'ML'; probability?: number; approved?: boolean; engine?: 'real' | 'throwing' | 'none' }

function fakePrisma(record: { decisions: any[]; signals: any[]; ml: Record<string, any[]> }, strategy: Strategy) {
  let id = 0;
  const overrides: Record<string, Record<string, (args: any) => any>> = {
    newLaunchConfig: { findMany: () => [{ userId: 'u1', enabled: true }] },
    botConfig: {
      findMany: () => [{ userId: 'u1', minLiquidityUsd: null, minVolumeUsd: null, maxTokenAgeHours: 168, user: { riskConfigs: [{ riskPolicy: 'EXPLORATORY', maxSlippagePercent: 50, lowRiskMax: 30, moderateRiskMax: 50, highRiskMax: 90, veryHighRiskMax: 100, lowPositionMultiplier: 1, moderatePositionMultiplier: 1, highPositionMultiplier: 1, veryHighPositionMultiplier: 1 }] } }],
      findUnique: () => ({ tradingMode: 'PAPER' }),
    },
    paperAccount: { findUnique: () => ({ equity: 1_000 }) },
    launchDecision: { create: ({ data }: any) => { record.decisions.push({ decision: data.decision, status: data.status, reasons: data.reasons, score: data.score }); return { id: `d${++id}` }; } },
    signal: { create: ({ data }: any) => { record.signals.push({ strategyName: data.strategyName, direction: data.direction, entryStrategy: data.metadata.entryStrategy, ml: data.metadata.ml }); return { id: `s${++id}` }; } },
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

async function runScenario(strategy: Strategy, options: { shadow?: boolean } = {}) {
  let now = Date.parse('2026-10-05T10:00:00Z');
  const record = { decisions: [] as any[], signals: [] as any[], ml: {} as Record<string, any[]> };
  const prisma = fakePrisma(record, strategy);
  const paper = strategy.engine === 'none' ? null : mlPaper(strategy);
  const shadow = options.shadow ? new MlShadowService({ prisma, logger, mode: 'SHADOW', repoRoot: process.cwd(), now: () => now }) : undefined;
  let handlers: LaunchHandlers | null = null;
  const provider = { source: 'PUMP_FUN' as const, subscribe: (h: LaunchHandlers) => { handlers = h; }, unsubscribe: () => undefined, healthCheck: () => ({ source: 'PUMP_FUN' as const, label: 'Pump.fun', status: 'ACTIVE' as const, detail: null, lastEventAt: null, events: 0 }) };
  const service = new NewLaunchService({
    prisma, providers: [provider as any], logger, now: () => now,
    marketData: { getTokenMetrics: async () => ({ priceUsd: 150, metadata: { address: 'So11111111111111111111111111111111111111112' } }) } as any,
    getMintInfo: async () => ({ mintAuthority: null, freezeAuthority: null, tokenProgram: 'spl-token', extensions: [] }),
    store: { set: async () => 'OK', incrBy: async () => 1, expire: async () => 1 },
    publish: async () => undefined,
    ml: shadow,
    mlPaper: paper?.engine as any,
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

describe('Selectable entry strategy in New Launch', () => {
  it('1. DEFAULT strategy is unchanged by the ML PAPER engine (identical decisions and BUY signal)', async () => {
    const baseline = await runScenario({ mode: 'DEFAULT', engine: 'none' });
    const withEngine = await runScenario({ mode: 'DEFAULT', engine: 'real', probability: 0.99 });
    expect(baseline.record.signals).toHaveLength(1);
    expect(baseline.record.signals[0].entryStrategy).toBe('DEFAULT');
    expect(withEngine.record.decisions).toEqual(baseline.record.decisions);
    expect(withEngine.record.signals).toEqual(baseline.record.signals);
    expect(withEngine.paperDecisions).toHaveLength(0);
  }, 30_000);

  it('3. ML BUY: exactly one BUY signal, made by the ML (never a second, rule-based one)', async () => {
    const ml = await runScenario({ mode: 'ML', probability: 0.95 });
    expect(ml.paperDecisions).toHaveLength(1);
    expect(ml.paperDecisions[0]).toMatchObject({ mlDecision: 'ML_BUY', modelVersion: 'M1', snapshotKind: 'AGE_30S' });
    expect(ml.record.signals).toHaveLength(1);
    expect(ml.record.signals[0]).toMatchObject({ entryStrategy: 'ML', ml: { modelVersion: 'M1', decisionId: ml.paperDecisions[0].id, snapshotKind: 'AGE_30S' } });
    expect(ml.paperDecisions[0].outcome).toBe('SIGNALED');
    // The entry follows the decision (decided at the 30 s point; the signal can only come at / after it).
    expect(ml.paperDecisions[0].snapshotAt.getTime() - ml.paperDecisions[0].detectedAt.getTime()).toBeGreaterThanOrEqual(30_000);
  }, 30_000);

  it('3. ML SKIP: no entry although the rule-based strategy would have bought', async () => {
    const skip = await runScenario({ mode: 'ML', probability: 0.2 });
    expect(skip.paperDecisions[0]).toMatchObject({ mlDecision: 'ML_SKIP', outcome: 'SKIPPED' });
    expect(skip.record.signals).toHaveLength(0);
    // The rule-based decision is still recorded for comparison (it says BUY, nothing was bought).
    expect(skip.record.decisions.some((decision: any) => decision.decision === 'BUY')).toBe(true);
  }, 30_000);

  it('6 / 8. broken model or crashing engine: no entry, no fallback, the tick keeps working (data collection unchanged)', async () => {
    const baseline = await runScenario({ mode: 'DEFAULT', engine: 'none' });
    const revoked = await runScenario({ mode: 'ML', approved: false });
    expect(revoked.record.signals).toHaveLength(0);
    expect(revoked.paperDecisions[0]).toMatchObject({ mlDecision: 'ML_ERROR', errorReason: 'MODEL_NOT_PAPER_APPROVED' });
    // Same rule-based evaluation step by step (in ML mode it keeps being logged after the would-be BUY, for comparison).
    const prefix = (run: typeof baseline) => run.record.decisions.slice(0, baseline.record.decisions.length);
    expect(prefix(revoked)).toEqual(baseline.record.decisions);
    const crashing = await runScenario({ mode: 'ML', engine: 'throwing' });
    expect(crashing.record.signals).toHaveLength(0);
    expect(prefix(crashing)).toEqual(baseline.record.decisions);
  }, 30_000);

  it('10. SHADOW collection is identical in DEFAULT and ML mode; PAPER decisions are stored separately', async () => {
    const shadowOnly = await runScenario({ mode: 'DEFAULT', engine: 'none' }, { shadow: true });
    const withMlPaper = await runScenario({ mode: 'ML', probability: 0.95 }, { shadow: true });
    const kinds = (run: typeof shadowOnly) => (run.record.ml.mlFeatureSnapshot ?? []).map((row) => `${row.kind}:${row.featureVersion}`);
    expect(kinds(withMlPaper)).toEqual(kinds(shadowOnly));
    expect(kinds(shadowOnly)).toEqual(expect.arrayContaining(['AGE_15S:ML-FEATURES-v1', 'AGE_30S:ML-FEATURES-v1', 'AGE_60S:ML-FEATURES-v1']));
    // The PAPER engine never writes SHADOW tables (no shadow prediction / snapshot / outcome rows from it).
    expect((withMlPaper.record.ml.mlPrediction ?? []).length).toBe((shadowOnly.record.ml.mlPrediction ?? []).length);
    expect(withMlPaper.record.ml.mlPaperDecision).toBeUndefined();
    expect(withMlPaper.paperDecisions).toHaveLength(1);
  }, 60_000);
});
