/* eslint-disable @typescript-eslint/no-explicit-any -- in-memory prisma fakes */
/**
 * ML PAPER entry engine + model registry (tests 2, 3, 5, 6, 9): only PAPER-approved, intact models decide; one decision per
 * user and candidate at the snapshot point; ML BUY only with green safety inside the window; every failure is fail-closed.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildMlFeatureSnapshot, type LaunchSecurity, type MlModelArtifact } from '@soltrader/strategy-engine';
import { describe, expect, it } from 'vitest';

import { MlPaperEntryEngine, MlPaperModelRegistry, type MlPaperStepInput, type MlPaperUserConfig } from '../src/ml/ml-paper-engine.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(path.join(here, '..', '..', '..', 'packages', 'strategy-engine', 'test', 'fixtures', 'ml-parity.json'), 'utf8')) as Record<string, { artifact: MlModelArtifact }>;
const logger = { info: () => undefined, warn: () => undefined };
const T = Date.parse('2026-10-05T12:00:00Z');
const security: LaunchSecurity = { sellability: 'VERIFIED', mintAuthorityRevoked: true, freezeAuthorityRevoked: true, tokenProgram: 'spl-token', extensions: [], hardBlockReasons: [], warnings: [] };

/** Logistic artifact with a constant probability p (all coefficients 0). */
function constantArtifact(version: string, p: number): MlModelArtifact {
  const base = fixture.LR.artifact;
  return { ...base, modelVersion: version, calibration: null, logistic: { coef: base.columns.map(() => 0), intercept: Math.log(p / (1 - p)) } };
}

function snapshotAt(now: number) {
  const observations = Array.from({ length: 15 }, (_, i) => ({
    takenAt: T + i * 2_000, priceUsd: 0.00001, liquidityUsd: 30_000, buyCount: 3 + i, sellCount: 1, volumeUsd: 100 + i * 40, buyVolumeUsd: 80, sellVolumeUsd: 20, uniqueBuyers: 2 + i, uniqueSellers: 1,
  }));
  const state = { mint: 'M', detectedAt: T, createdAt: T - 1_000, observations, largestBuyerShare: 0.1, buysPerBuyer: 1.2, creatorSoldRatio: 0, largestHolderSupplyShare: 0.04, priceImpactPercent: 1, observedSellers: 3 };
  return buildMlFeatureSnapshot({ snapshotAt: now, source: 'PUMP_FUN', detectedAt: T, createdAt: T - 1_000, firstTradeAt: T + 500, state, security, securityObservedAt: T + 5_000, riskScore: 40, riskObservedAt: now, social: null, referenceImpactPct: 1 });
}

interface Row { id: string; [key: string]: any }

function fakeDb(models: Record<string, any>, options: { failCreate?: boolean } = {}) {
  const decisions: Row[] = [];
  let id = 0;
  const prisma = {
    mlModelVersion: { findUnique: async ({ where }: any) => models[where.version] ?? null },
    mlDatasetVersion: { findUnique: async () => ({ config: { snapshotKind: 'AGE_30S', minDataQuality: 0 } }) },
    mlPaperDecision: {
      findUnique: async ({ where }: any) => decisions.find((row) => row.userId === where.userId_mint.userId && row.mint === where.userId_mint.mint) ?? null,
      create: async ({ data }: any) => {
        if (options.failCreate) throw new Error('db down');
        if (decisions.some((row) => row.userId === data.userId && row.mint === data.mint)) throw Object.assign(new Error('unique'), { code: 'P2002' });
        const row = { id: `d${++id}`, ...data };
        decisions.push(row);
        return row;
      },
      update: async ({ where, data }: any) => Object.assign(decisions.find((row) => row.id === where.id)!, data),
    },
  };
  return { prisma: prisma as any, decisions };
}

function approvedModel(version: string, artifact: MlModelArtifact, overrides: Record<string, unknown> = {}) {
  const content = JSON.stringify(artifact);
  return { version, status: 'SHADOW', paperApproved: true, featureVersion: 'ML-FEATURES-v1', datasetVersion: 'DS', artifactPath: `ml/models/${version}/model.json`, artifactHash: createHash('sha256').update(content).digest('hex'), content, ...overrides };
}

function setup(models: Record<string, any>, options: { failCreate?: boolean } = {}) {
  const db = fakeDb(models, options);
  let clock = T;
  const registry = new MlPaperModelRegistry({ prisma: db.prisma, repoRoot: process.cwd(), logger, now: () => clock, recheckMs: 0, loadArtifact: async (row: any) => {
    const model = Object.values(models).find((item: any) => item.artifactPath === row.artifactPath) as any;
    if (createHash('sha256').update(model.content).digest('hex') !== row.artifactHash) throw new Error('Artifact hash mismatch');
    return JSON.parse(model.content);
  } });
  const engine = new MlPaperEntryEngine({ prisma: db.prisma, registry, logger });
  return { ...db, registry, engine, setClock: (value: number) => { clock = value; } };
}

const config = (modelVersion: string, overrides: Partial<MlPaperUserConfig> = {}): MlPaperUserConfig => ({ mode: 'ML', modelVersion, buyThreshold: 0.7, decisionWindowSeconds: 10, ...overrides });

function input(now: number, cfg: MlPaperUserConfig, overrides: Partial<MlPaperStepInput> = {}): MlPaperStepInput {
  return {
    userId: 'u1', mint: 'MINT1', detectedAt: T, now, config: cfg, candidateId: async () => 'cand1',
    buildFeatures: () => snapshotAt(now), eligible: () => true, safetyBlockers: () => [], base: { decision: 'WATCH', reasons: ['LAUNCH_SCORE_BELOW_MINIMUM'] }, ...overrides,
  };
}

describe('ML PAPER decisions (test 3)', () => {
  it('ML BUY: decided once at the 30 s point from the features of that moment, then signalled when safety is green', async () => {
    const { engine, decisions } = setup({ HIGH: approvedModel('HIGH', constantArtifact('HIGH', 0.9)) });
    expect(await engine.step(input(T + 20_000, config('HIGH')))).toEqual({ action: 'NONE' });
    expect(decisions).toHaveLength(0);
    const step = await engine.step(input(T + 31_000, config('HIGH')));
    expect(step).toMatchObject({ action: 'SIGNAL', modelVersion: 'HIGH', snapshotKind: 'AGE_30S' });
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ mlDecision: 'ML_BUY', outcome: 'PENDING', modelVersion: 'HIGH', snapshotKind: 'AGE_30S', baseDecision: 'WATCH', featureVersion: 'ML-FEATURES-v1' });
    expect(Number(decisions[0].probability)).toBeCloseTo(0.9, 5);
    expect(decisions[0].snapshotAt.getTime()).toBe(T + 31_000);
    expect(decisions[0].features.observationAgeSeconds).toBe(31);
    expect(decisions[0].featureHash).toMatch(/^[0-9a-f]{64}$/);
    await engine.markSignaled('u1', 'MINT1', 'sig1', T + 31_000);
    expect(decisions[0]).toMatchObject({ outcome: 'SIGNALED', signalId: 'sig1', safetyPassed: true });
    // Resolved: nothing more for this candidate (no second signal, no re-prediction with later data).
    expect(await engine.step(input(T + 33_000, config('HIGH')))).toEqual({ action: 'NONE' });
    expect(decisions).toHaveLength(1);
  });

  it('ML SKIP below the threshold: stored, never signalled', async () => {
    const { engine, decisions } = setup({ LOW: approvedModel('LOW', constantArtifact('LOW', 0.3)) });
    expect(await engine.step(input(T + 30_000, config('LOW')))).toEqual({ action: 'NONE' });
    expect(decisions[0]).toMatchObject({ mlDecision: 'ML_SKIP', outcome: 'SKIPPED' });
    expect(await engine.step(input(T + 32_000, config('LOW')))).toEqual({ action: 'NONE' });
  });

  it('a candidate first seen after the prediction point is skipped (never back-dated)', async () => {
    const { engine, decisions } = setup({ HIGH: approvedModel('HIGH', constantArtifact('HIGH', 0.9)) });
    expect(await engine.step(input(T + 45_000, config('HIGH')))).toEqual({ action: 'NONE' });
    expect(decisions[0]).toMatchObject({ mlDecision: 'ML_SKIP', errorReason: 'PREDICTION_POINT_MISSED', outcome: 'SKIPPED' });
  });
});

describe('Safety and window for an ML BUY (test 4)', () => {
  it('a pending safety check delays; a permanent blocker ends the ML BUY; the window expires', async () => {
    const pending = setup({ HIGH: approvedModel('HIGH', constantArtifact('HIGH', 0.9)) });
    expect(await pending.engine.step(input(T + 30_000, config('HIGH'), { safetyBlockers: () => ['SELLABILITY_NOT_VERIFIED'] }))).toEqual({ action: 'NONE' });
    expect((await pending.engine.step(input(T + 34_000, config('HIGH')))).action).toBe('SIGNAL');

    const blocked = setup({ HIGH: approvedModel('HIGH', constantArtifact('HIGH', 0.9)) });
    expect(await blocked.engine.step(input(T + 30_000, config('HIGH'), { safetyBlockers: () => ['SELLABILITY_FAILED'] }))).toEqual({ action: 'NONE' });
    expect(blocked.decisions[0]).toMatchObject({ outcome: 'SAFETY_BLOCKED', safetyPassed: false });
    expect(await blocked.engine.step(input(T + 32_000, config('HIGH')))).toEqual({ action: 'NONE' });

    const expired = setup({ HIGH: approvedModel('HIGH', constantArtifact('HIGH', 0.9)) });
    await expired.engine.step(input(T + 30_000, config('HIGH'), { safetyBlockers: () => ['SECURITY_CHECK_PENDING'] }));
    expect(await expired.engine.step(input(T + 41_000, config('HIGH')))).toEqual({ action: 'NONE' });
    expect(expired.decisions[0].outcome).toBe('EXPIRED');
    expect(expired.decisions[0].executionReason).toContain('SECURITY_CHECK_PENDING');
  });
});

describe('Only approved, intact models (tests 2 / 6)', () => {
  const cases: Array<[string, Record<string, any>, string]> = [
    ['not PAPER approved (SHADOW_READY alone is not enough)', { M: approvedModel('M', constantArtifact('M', 0.9), { paperApproved: false, readiness: 'SHADOW_READY' }) }, 'MODEL_NOT_PAPER_APPROVED'],
    ['retired', { M: approvedModel('M', constantArtifact('M', 0.9), { status: 'RETIRED' }) }, 'MODEL_RETIRED'],
    ['feature version mismatch', { M: approvedModel('M', constantArtifact('M', 0.9), { featureVersion: 'ML-FEATURES-v0' }) }, 'FEATURE_VERSION_MISMATCH'],
    ['corrupt artifact (hash mismatch)', { M: { ...approvedModel('M', constantArtifact('M', 0.9)), artifactHash: 'f'.repeat(64) } }, 'ARTIFACT_INVALID'],
    ['artifact of another model version', { M: approvedModel('M', constantArtifact('OTHER', 0.9)) }, 'ARTIFACT_VERSION_MISMATCH'],
    ['missing model', {}, 'MODEL_NOT_FOUND'],
  ];
  for (const [name, models, reason] of cases) {
    it(`${name}: ML_ERROR, no entry, no fallback`, async () => {
      const { engine, decisions } = setup(models);
      expect(await engine.step(input(T + 30_000, config('M')))).toEqual({ action: 'NONE' });
      expect(decisions[0]).toMatchObject({ mlDecision: 'ML_ERROR', outcome: 'ERROR' });
      expect(decisions[0].errorReason).toContain(reason);
    });
  }

  it('missing feature / leakage / failed inference -> ML_ERROR; ineligible or low quality -> ML_SKIP', async () => {
    const missing = setup({ M: approvedModel('M', constantArtifact('M', 0.9)) });
    await missing.engine.step(input(T + 30_000, config('M'), { buildFeatures: () => { const snapshot = snapshotAt(T + 30_000); delete (snapshot.features as Record<string, unknown>).liquidityUsd; return snapshot; } }));
    expect(missing.decisions[0]).toMatchObject({ mlDecision: 'ML_ERROR', errorReason: 'MISSING_FEATURE' });

    const leak = setup({ M: approvedModel('M', constantArtifact('M', 0.9)) });
    await leak.engine.step(input(T + 30_000, config('M'), { buildFeatures: () => ({ ...snapshotAt(T + 30_000), invalidReasons: ['FUTURE_DATA_SOCIAL'] }) }));
    expect(leak.decisions[0]).toMatchObject({ mlDecision: 'ML_ERROR', errorReason: 'FEATURE_LEAKAGE' });

    const crash = setup({ M: approvedModel('M', constantArtifact('M', 0.9)) });
    await crash.engine.step(input(T + 30_000, config('M'), { buildFeatures: () => { throw new Error('boom'); } }));
    expect(crash.decisions[0].mlDecision).toBe('ML_ERROR');
    expect(crash.decisions[0].errorReason).toContain('INFERENCE_FAILED');

    const ineligible = setup({ M: approvedModel('M', constantArtifact('M', 0.9)) });
    await ineligible.engine.step(input(T + 30_000, config('M'), { eligible: () => false }));
    expect(ineligible.decisions[0]).toMatchObject({ mlDecision: 'ML_SKIP', errorReason: 'ML_INELIGIBLE' });
  });

  it('a decision that cannot be stored is never executed (no unaudited ML entry)', async () => {
    const { engine } = setup({ M: approvedModel('M', constantArtifact('M', 0.9)) }, { failCreate: true });
    expect(await engine.step(input(T + 30_000, config('M')))).toEqual({ action: 'NONE' });
    expect(await engine.step(input(T + 32_000, config('M')))).toEqual({ action: 'NONE' });
  });

  it('real artifact files: path must stay inside ml/models and the sha256 must match', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'mlpaper-'));
    try {
      const artifact = constantArtifact('FILE', 0.9);
      const content = JSON.stringify(artifact);
      mkdirSync(path.join(root, 'ml', 'models', 'FILE'), { recursive: true });
      writeFileSync(path.join(root, 'ml', 'models', 'FILE', 'model.json'), content);
      const hash = createHash('sha256').update(content).digest('hex');
      const models: Record<string, any> = {
        FILE: { version: 'FILE', status: 'SHADOW', paperApproved: true, featureVersion: 'ML-FEATURES-v1', datasetVersion: 'DS', artifactPath: 'ml/models/FILE/model.json', artifactHash: hash },
        OUTSIDE: { version: 'OUTSIDE', status: 'SHADOW', paperApproved: true, featureVersion: 'ML-FEATURES-v1', datasetVersion: 'DS', artifactPath: '../outside.json', artifactHash: hash },
      };
      const registry = new MlPaperModelRegistry({ prisma: fakeDb(models).prisma, repoRoot: root, logger });
      expect((await registry.get('FILE')).ok).toBe(true);
      expect(await registry.get('OUTSIDE')).toMatchObject({ ok: false });
      writeFileSync(path.join(root, 'ml', 'models', 'FILE', 'model.json'), `${content} `);
      const fresh = new MlPaperModelRegistry({ prisma: fakeDb(models).prisma, repoRoot: root, logger });
      expect(await fresh.get('FILE')).toMatchObject({ ok: false, reason: expect.stringContaining('hash mismatch') });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('Idempotency (test 5) and model / strategy switches (test 9)', () => {
  it('one decision per user and candidate, also across an engine restart', async () => {
    const shared = setup({ HIGH: approvedModel('HIGH', constantArtifact('HIGH', 0.9)) });
    expect((await shared.engine.step(input(T + 30_000, config('HIGH')))).action).toBe('SIGNAL');
    await shared.engine.markSignaled('u1', 'MINT1', 'sig1', T + 30_000);
    // New engine (worker restart) on the same database: the stored decision wins, nothing new is decided or signalled.
    const restarted = new MlPaperEntryEngine({ prisma: shared.prisma, registry: shared.registry, logger });
    expect(await restarted.step(input(T + 32_000, config('HIGH')))).toEqual({ action: 'NONE' });
    expect(shared.decisions).toHaveLength(1);
  });

  it('a pending ML BUY expires when the model is changed or its approval is revoked', async () => {
    const models: Record<string, any> = { A: approvedModel('A', constantArtifact('A', 0.9)), B: approvedModel('B', constantArtifact('B', 0.9)) };
    const switched = setup(models);
    await switched.engine.step(input(T + 30_000, config('A'), { safetyBlockers: () => ['SELLABILITY_NOT_VERIFIED'] }));
    expect(await switched.engine.step(input(T + 32_000, config('B')))).toEqual({ action: 'NONE' });
    expect(switched.decisions[0]).toMatchObject({ outcome: 'EXPIRED', executionReason: 'STRATEGY_OR_MODEL_CHANGED' });

    const revoked = setup(models);
    await revoked.engine.step(input(T + 30_000, config('A'), { safetyBlockers: () => ['SELLABILITY_NOT_VERIFIED'] }));
    models.A.paperApproved = false;
    expect(await revoked.engine.step(input(T + 32_000, config('A')))).toEqual({ action: 'NONE' });
    expect(revoked.decisions[0]).toMatchObject({ outcome: 'EXPIRED', executionReason: 'MODEL_NOT_PAPER_APPROVED' });
    // History is never rewritten: the decision still names the model that made it.
    expect(revoked.decisions[0].modelVersion).toBe('A');
  });

  it('health: last successful prediction per model version', async () => {
    const { engine, registry } = setup({ HIGH: approvedModel('HIGH', constantArtifact('HIGH', 0.9)) });
    await engine.step(input(T + 30_000, config('HIGH')));
    expect(registry.snapshot().HIGH).toMatchObject({ status: 'LOADED', predictions: 1, failures: 0 });
    expect(registry.snapshot().HIGH.lastSuccessAt).toBeTruthy();
  });
});

