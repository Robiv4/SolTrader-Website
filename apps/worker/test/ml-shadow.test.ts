/* eslint-disable @typescript-eslint/no-explicit-any -- in-memory prisma fake */
/**
 * ML SHADOW isolation (tests 106 / 107 / 114 / 115 / 119): the same launch scenario run without ML, with the real
 * MlShadowService and with an ML observer that throws on every call produces identical NewLaunch decisions and BUY
 * signals. The ML side records snapshots / outcomes from the same trade stream with zero extra requests.
 */
import { describe, expect, it } from 'vitest';

import { NewLaunchService } from '../src/launch/new-launch-service.js';
import type { LaunchHandlers } from '../src/launch/providers.js';
import { MlShadowService } from '../src/ml/ml-shadow-service.js';

const MINT = 'MLshadowMint11111111111111111111111111111pump';
const logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

function fakePrisma(record: { decisions: any[]; signals: any[]; ml: Record<string, any[]> }, options: { failMlWrites?: boolean } = {}) {
  let id = 0;
  const overrides: Record<string, Record<string, (args: any) => any>> = {
    newLaunchConfig: { findMany: () => [{ userId: 'u1', enabled: true }] },
    botConfig: {
      findMany: () => [{ userId: 'u1', minLiquidityUsd: null, minVolumeUsd: null, maxTokenAgeHours: 168, user: { riskConfigs: [{ riskPolicy: 'EXPLORATORY', maxSlippagePercent: 50, lowRiskMax: 30, moderateRiskMax: 50, highRiskMax: 90, veryHighRiskMax: 100, lowPositionMultiplier: 1, moderatePositionMultiplier: 1, highPositionMultiplier: 1, veryHighPositionMultiplier: 1 }] } }],
      findUnique: () => ({ tradingMode: 'PAPER' }),
    },
    paperAccount: { findUnique: () => ({ equity: 1_000 }) },
    launchDecision: { create: ({ data }: any) => { record.decisions.push({ decision: data.decision, status: data.status, reasons: data.reasons, score: data.score }); return { id: `d${++id}` }; } },
    signal: { create: ({ data }: any) => { record.signals.push({ strategyName: data.strategyName, direction: data.direction }); return { id: `s${++id}` }; } },
  };
  const ml = (model: string) => ({
    create: async ({ data }: any) => {
      if (options.failMlWrites) throw new Error('db down');
      (record.ml[model] ??= []).push(data);
      return { id: `${model}-${++id}` };
    },
    update: async ({ data }: any) => {
      if (options.failMlWrites) throw new Error('db down');
      (record.ml[`${model}.update`] ??= []).push(data);
      return {};
    },
    findMany: async () => [],
    findFirst: async () => null,
  });
  return new Proxy({}, {
    get(_target, model: string) {
      if (model.startsWith('ml')) return ml(model);
      return new Proxy({}, {
        get(_inner, method: string) {
          const override = overrides[model]?.[method];
          return async (args: any) => {
            if (override) return override(args);
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

type MlOption = 'none' | 'real' | 'throwing';

async function runScenario(mode: MlOption, options: { failMlWrites?: boolean } = {}) {
  let now = Date.parse('2026-10-05T10:00:00Z');
  const record = { decisions: [] as any[], signals: [] as any[], ml: {} as Record<string, any[]> };
  const prisma = fakePrisma(record, options);
  let handlers: LaunchHandlers | null = null;
  const provider = { source: 'PUMP_FUN' as const, subscribe: (h: LaunchHandlers) => { handlers = h; }, unsubscribe: () => undefined, healthCheck: () => ({ source: 'PUMP_FUN' as const, label: 'Pump.fun', status: 'ACTIVE' as const, detail: null, lastEventAt: null, events: 0 }) };
  const ml = mode === 'real'
    ? new MlShadowService({ prisma, logger, mode: 'SHADOW', repoRoot: process.cwd(), now: () => now })
    : mode === 'throwing'
      ? { attach: () => { throw new Error('boom'); }, onTrade: () => { throw new Error('boom'); }, onComplete: () => { throw new Error('boom'); }, onEvaluation: () => { throw new Error('boom'); }, onTick: () => { throw new Error('boom'); } }
      : undefined;
  const service = new NewLaunchService({
    prisma, providers: [provider as any], logger, now: () => now,
    marketData: { getTokenMetrics: async () => ({ priceUsd: 150, metadata: { address: 'So11111111111111111111111111111111111111112' } }) } as any,
    getMintInfo: async () => ({ mintAuthority: null, freezeAuthority: null, tokenProgram: 'spl-token', extensions: [] }),
    store: { set: async () => 'OK', incrBy: async () => 1, expire: async () => 1 },
    publish: async () => undefined,
    ml: ml as any,
  });
  service.start();
  service.stop(); // no real timer: ticks are driven below
  const h = handlers!;
  await h.onLaunch({ source: 'PUMP_FUN', mint: MINT, detectedAt: now, createdAt: now - 1_000, bondingCurve: 'Curve1111', poolAddress: 'Curve1111', quoteMint: 'So11111111111111111111111111111111111111112', creator: 'Creator111', name: 'Shadow', symbol: 'SHDW' });
  let virtualSol = 30;
  let virtualToken = 1_073_000_000;
  for (let step = 0; step < 60; step += 1) {
    // Accelerating buys from many distinct wallets, a few sells from other wallets.
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
  if (ml instanceof MlShadowService) await ml.flush();
  return { record, ml };
}

describe('ML SHADOW has zero influence on trading', () => {
  it('identical NewLaunch decisions and BUY signals without ML, with real ML and with a crashing ML observer', async () => {
    const baseline = await runScenario('none');
    const withMl = await runScenario('real');
    const crashing = await runScenario('throwing');
    expect(baseline.record.decisions.length).toBeGreaterThan(0);
    if (process.env.ML_TEST_DEBUG) console.log(JSON.stringify({ decisions: baseline.record.decisions.map((d) => `${d.decision}:${d.status}:${(d.reasons as string[]).slice(0, 2).join('+')}`), signals: baseline.record.signals.length, snapshots: (withMl.record.ml.mlFeatureSnapshot ?? []).map((row) => `${row.kind}:${row.decision}:q${row.dataQuality}:${row.validForTraining}`) }));
    expect(withMl.record.decisions).toEqual(baseline.record.decisions);
    expect(crashing.record.decisions).toEqual(baseline.record.decisions);
    expect(withMl.record.signals).toEqual(baseline.record.signals);
    expect(crashing.record.signals).toEqual(baseline.record.signals);
    // The real ML service recorded immutable snapshots at the prediction points + started outcome tracking.
    const snapshots = withMl.record.ml.mlFeatureSnapshot ?? [];
    expect(snapshots.map((row) => row.kind)).toEqual(expect.arrayContaining(['AGE_15S', 'AGE_30S', 'AGE_60S']));
    expect(snapshots.every((row) => row.featureVersion === 'ML-FEATURES-v1')).toBe(true);
    // Outcome paths only for the configured kinds (default AGE_30S + BUY_DECISION).
    expect((withMl.record.ml.mlCandidateOutcome ?? []).length).toBe(snapshots.filter((row) => ['AGE_30S', 'BUY_DECISION'].includes(row.kind)).length);
    // No extra RPC / market-data traffic: outcomes come from the existing trade stream.
    const health = (withMl.ml as MlShadowService).snapshot();
    expect(health.additionalRpcRequests).toBe(0);
    expect(health.additionalMarketDataRequests).toBe(0);
  }, 30_000);

  it('ML database failures are isolated: trading decisions unchanged, failures counted', async () => {
    const baseline = await runScenario('none');
    const failing = await runScenario('real', { failMlWrites: true });
    expect(failing.record.decisions).toEqual(baseline.record.decisions);
    expect((failing.ml as MlShadowService).snapshot().writeFailures).toBeGreaterThan(0);
  }, 30_000);

  it('tracking budget: beyond the configured number of tracked candidates ML degrades (dropped), trading unaffected', async () => {
    const record = { decisions: [] as any[], signals: [] as any[], ml: {} as Record<string, any[]> };
    const service = new MlShadowService({ prisma: fakePrisma(record), logger, mode: 'SHADOW', repoRoot: process.cwd(), maxTrackedPaths: 0 });
    service.attach({
      launches: () => [{ mint: MINT, source: 'PUMP_FUN', detectedAt: Date.now() - 31_000, createdAt: null, firstTradeAt: Date.now() - 15_000, creator: null, hasStream: true, migrated: false }],
      state: () => ({ mint: MINT, detectedAt: Date.now() - 31_000, createdAt: null, observations: [{ takenAt: Date.now() - 1_000, priceUsd: 0.00001, liquidityUsd: 9_000, buyCount: 5, sellCount: 1, volumeUsd: 300, buyVolumeUsd: 250, sellVolumeUsd: 50, uniqueBuyers: 5, uniqueSellers: 1 }], largestBuyerShare: null, buysPerBuyer: null, creatorSoldRatio: null, largestHolderSupplyShare: null, priceImpactPercent: null, observedSellers: 0 }),
      impact: () => null, security: () => null, candidateId: async () => 'cand-1',
    });
    service.onTick(Date.now());
    await service.flush();
    expect(service.snapshot().trackingDropped).toBe(1);
    expect(record.ml.mlCandidateOutcome?.[0]).toMatchObject({ status: 'INSUFFICIENT', endReason: 'TRACKING_BUDGET_EXHAUSTED' });
  });

  it('corrupt / missing model artifact -> ML unavailable, no prediction, no exception', async () => {
    const record = { decisions: [] as any[], signals: [] as any[], ml: {} as Record<string, any[]> };
    const prisma = fakePrisma(record);
    const service = new MlShadowService({
      prisma: { ...prisma, mlModelVersion: { findFirst: async () => ({ version: 'ML-X', artifactPath: 'ml/models/ML-X/model.json', artifactHash: 'deadbeef' }) } } as any,
      logger, mode: 'SHADOW', repoRoot: process.cwd(),
    });
    await service.refreshModel(Date.now(), true);
    expect(service.snapshot().model.status).toBe('UNAVAILABLE');
  });
});
