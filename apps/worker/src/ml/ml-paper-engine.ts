/**
 * ML PAPER entry engine (New Launch, PAPER only). When a user selected the ML strategy, an admin-approved model makes the
 * strategic entry decision instead of the rule-based score thresholds; everything else stays mandatory.
 *
 * Fail-closed by design:
 *  - only models with `paperApproved = true` (separate, revocable admin approval) and a verified artifact hash are used;
 *  - a missing / revoked / corrupt model, a feature-version mismatch, a missing feature, feature leakage or a failed
 *    inference records ML_ERROR and opens NOTHING - there is no silent fallback to the rule-based strategy;
 *  - exactly one decision per user and candidate (DB unique key), made at the model's snapshot point from the features
 *    known at that moment; an ML BUY can only be executed after it, inside a short window, with all safety checks green;
 *  - the engine never touches open positions or the exit path.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { Prisma, type PrismaClient } from '@prisma/client';
import {
  classifyMlProbability, isSupportedFeatureVersion, ML_FEATURE_VERSION, ML_PAPER_SNAPSHOT_POINTS, ML_PERMANENT_BLOCKERS, mlBuyWindowOpen, mlDecisionTiming, predictMl, validateArtifact,
  type MlFeatureSnapshotResult, type MlModelArtifact,
} from '@soltrader/strategy-engine';

export type MlStrategyMode = 'DEFAULT' | 'ML';

export interface MlPaperUserConfig {
  mode: MlStrategyMode;
  modelVersion: string | null;
  buyThreshold: number;
  decisionWindowSeconds: number;
  /** Saved ML PAPER minimum liquidity (USD); null = not set (the DEFAULT minimum stays in force). */
  minLiquidityUsd: number | null;
  /** ML-only architecture: no new entries while paused. */
  tradingPaused?: boolean;
}

export const DEFAULT_ML_PAPER_CONFIG: MlPaperUserConfig = { mode: 'DEFAULT', modelVersion: null, buyThreshold: 0.7, decisionWindowSeconds: 10, minLiquidityUsd: null };

/** Normalises a MlPaperSettings row (missing row = DEFAULT strategy). */
export function toMlPaperConfig(row: { strategyMode: string; modelVersion: string | null; buyThreshold: unknown; decisionWindowSeconds: number; minLiquidityUsd?: unknown; tradingPaused?: boolean | null } | null | undefined): MlPaperUserConfig {
  if (!row) return DEFAULT_ML_PAPER_CONFIG;
  return {
    mode: row.strategyMode === 'ML' ? 'ML' : 'DEFAULT',
    modelVersion: row.modelVersion,
    buyThreshold: Number(row.buyThreshold),
    decisionWindowSeconds: row.decisionWindowSeconds,
    minLiquidityUsd: row.minLiquidityUsd === null || row.minLiquidityUsd === undefined || !Number.isFinite(Number(row.minLiquidityUsd)) ? null : Number(row.minLiquidityUsd),
    tradingPaused: Boolean(row.tradingPaused),
  };
}

export interface LoadedPaperModel {
  version: string;
  artifact: MlModelArtifact;
  snapshotKind: string;
  snapshotAgeMs: number;
  minDataQuality: number;
}

type ModelLookup = { ok: true; model: LoadedPaperModel } | { ok: false; reason: string };

interface ModelHealth {
  status: 'LOADED' | 'UNAVAILABLE';
  error: string | null;
  checkedAt: number;
  predictions: number;
  failures: number;
  lastPredictionAt: number | null;
  lastSuccessAt: number | null;
}

export interface MlPaperRegistryDeps {
  prisma: Pick<PrismaClient, 'mlModelVersion' | 'mlDatasetVersion'>;
  repoRoot: string;
  logger: { info(payload: unknown, message?: string): void; warn(payload: unknown, message?: string): void };
  now?: () => number;
  /** How long an approval / artifact check is reused (revocation takes effect within this time). */
  recheckMs?: number;
  /** Test hook: artifact loader (default: file under ml/models, sha256 verified). */
  loadArtifact?: (row: { artifactPath: string; artifactHash: string }) => Promise<unknown>;
}

/** Loads PAPER-approved models only; approval and artifact integrity are re-checked periodically. */
export class MlPaperModelRegistry {
  private readonly cache = new Map<string, { at: number; lookup: ModelLookup; hash: string | null }>();
  private readonly health = new Map<string, ModelHealth>();

  constructor(private readonly deps: MlPaperRegistryDeps) {}

  private now() {
    return this.deps.now?.() ?? Date.now();
  }

  private async readArtifact(row: { artifactPath: string; artifactHash: string }) {
    if (this.deps.loadArtifact) return this.deps.loadArtifact(row);
    const root = path.resolve(this.deps.repoRoot, 'ml', 'models');
    const file = path.resolve(this.deps.repoRoot, row.artifactPath);
    if (!file.startsWith(root)) throw new Error('Artifact path outside ml/models');
    const content = await readFile(file);
    if (createHash('sha256').update(content).digest('hex') !== row.artifactHash) throw new Error('Artifact hash mismatch (corrupt or modified file)');
    return JSON.parse(content.toString('utf8'));
  }

  private async load(version: string): Promise<{ lookup: ModelLookup; hash: string | null }> {
    const row = await this.deps.prisma.mlModelVersion.findUnique({ where: { version } });
    if (!row) return { lookup: { ok: false, reason: 'MODEL_NOT_FOUND' }, hash: null };
    if (!row.paperApproved) return { lookup: { ok: false, reason: 'MODEL_NOT_PAPER_APPROVED' }, hash: row.artifactHash };
    if (row.status === 'RETIRED') return { lookup: { ok: false, reason: 'MODEL_RETIRED' }, hash: row.artifactHash };
    // ML-FEATURES-v1 or ML-FEATURES-COMMUNITY-v1 (each model gets exactly its own feature set).
    if (!isSupportedFeatureVersion(row.featureVersion)) return { lookup: { ok: false, reason: 'FEATURE_VERSION_MISMATCH' }, hash: row.artifactHash };
    const cached = this.cache.get(version);
    // Same approved artifact as before: keep the parsed model (only approval / hash are re-checked).
    if (cached?.lookup.ok && cached.hash === row.artifactHash) return { lookup: cached.lookup, hash: row.artifactHash };
    const dataset = await this.deps.prisma.mlDatasetVersion.findUnique({ where: { version: row.datasetVersion } });
    const datasetConfig = (dataset?.config ?? {}) as { snapshotKind?: string; minDataQuality?: number };
    const snapshotKind = datasetConfig.snapshotKind ?? 'AGE_30S';
    const snapshotAgeMs = ML_PAPER_SNAPSHOT_POINTS[snapshotKind];
    if (snapshotAgeMs === undefined) return { lookup: { ok: false, reason: `UNSUPPORTED_SNAPSHOT_KIND_${snapshotKind}` }, hash: row.artifactHash };
    const artifact = validateArtifact(await this.readArtifact(row));
    if (artifact.featureVersion !== row.featureVersion) return { lookup: { ok: false, reason: 'ARTIFACT_FEATURE_VERSION_MISMATCH' }, hash: row.artifactHash };
    if (artifact.modelVersion !== row.version) return { lookup: { ok: false, reason: 'ARTIFACT_VERSION_MISMATCH' }, hash: row.artifactHash };
    this.deps.logger.info({ modelVersion: version, algorithm: artifact.algorithm, snapshotKind }, 'ML PAPER model loaded');
    return { lookup: { ok: true, model: { version, artifact, snapshotKind, snapshotAgeMs, minDataQuality: datasetConfig.minDataQuality ?? 50 } }, hash: row.artifactHash };
  }

  async get(version: string | null): Promise<ModelLookup> {
    if (!version) return { ok: false, reason: 'NO_MODEL_SELECTED' };
    const now = this.now();
    const cached = this.cache.get(version);
    if (cached && now - cached.at < (this.deps.recheckMs ?? 30_000)) return cached.lookup;
    let result: { lookup: ModelLookup; hash: string | null };
    try {
      result = await this.load(version);
    } catch (error) {
      result = { lookup: { ok: false, reason: `ARTIFACT_INVALID: ${error instanceof Error ? error.message.slice(0, 160) : String(error)}` }, hash: null };
    }
    this.cache.set(version, { at: now, ...result });
    const health = this.health.get(version) ?? { status: 'UNAVAILABLE', error: null, checkedAt: now, predictions: 0, failures: 0, lastPredictionAt: null, lastSuccessAt: null };
    health.status = result.lookup.ok ? 'LOADED' : 'UNAVAILABLE';
    health.error = result.lookup.ok ? null : result.lookup.reason;
    health.checkedAt = now;
    this.health.set(version, health);
    if (!result.lookup.ok) this.deps.logger.warn({ modelVersion: version, reason: result.lookup.reason }, 'ML PAPER model unavailable: no ML entries (no fallback)');
    return result.lookup;
  }

  notePrediction(version: string, ok: boolean, at: number) {
    const health = this.health.get(version);
    if (!health) return;
    health.lastPredictionAt = at;
    if (ok) {
      health.predictions += 1;
      health.lastSuccessAt = at;
    } else {
      health.failures += 1;
    }
  }

  snapshot() {
    return Object.fromEntries([...this.health.entries()].map(([version, health]) => [version, {
      ...health,
      checkedAt: new Date(health.checkedAt).toISOString(),
      lastPredictionAt: health.lastPredictionAt ? new Date(health.lastPredictionAt).toISOString() : null,
      lastSuccessAt: health.lastSuccessAt ? new Date(health.lastSuccessAt).toISOString() : null,
    }]));
  }
}

export interface MlPaperStepInput {
  userId: string;
  mint: string;
  detectedAt: number;
  now: number;
  config: MlPaperUserConfig;
  candidateId: () => Promise<string | null>;
  /** Builds the feature snapshot of `featureVersion` at `now` (same builder and inputs as the SHADOW collection). */
  buildFeatures: (featureVersion: string) => MlFeatureSnapshotResult | null;
  /** ML eligibility: a real price and at least two trades (same rule as the SHADOW collection). */
  eligible: (snapshot: MlFeatureSnapshotResult) => boolean;
  /** Mandatory safety blockers at this tick (empty = safe to hand to PAPER execution). */
  safetyBlockers: () => string[];
  /** Rule-based decision at the same moment (comparison only). */
  base: { decision: string; reasons: string[] };
  /** Facts recorded with the decision (applied ML minimum liquidity, token liquidity, sellability state). */
  facts?: () => MlDecisionFacts;
}

export interface MlDecisionFacts { minLiquidityUsd: number; liquidityUsd: number | null; sellability: string | null }

const factsData = (facts: MlDecisionFacts | null | undefined) => (facts ? {
  minLiquidityUsd: new Prisma.Decimal(facts.minLiquidityUsd.toFixed(2)),
  liquidityUsd: facts.liquidityUsd !== null && Number.isFinite(facts.liquidityUsd) ? new Prisma.Decimal(facts.liquidityUsd.toFixed(2)) : null,
  sellability: facts.sellability,
} : {});

export type MlPaperStepResult =
  | { action: 'NONE' }
  | { action: 'SIGNAL'; decisionId: string; modelVersion: string; probability: number; threshold: number; snapshotKind: string; snapshotAt: number; featureHash: string; minLiquidityUsd: number | null };

interface DecisionMemory {
  decisionId: string;
  mlDecision: 'ML_BUY' | 'ML_SKIP' | 'ML_ERROR';
  modelVersion: string;
  probability: number | null;
  threshold: number;
  snapshotKind: string;
  snapshotAt: number;
  decidedAt: number;
  featureHash: string;
  resolved: boolean;
  lastBlockers: string[];
  /** Facts of the last mandatory check (recorded when the decision resolves). */
  lastFacts?: MlDecisionFacts | null;
}

export interface MlPaperEngineDeps {
  prisma: Pick<PrismaClient, 'mlPaperDecision'>;
  registry: Pick<MlPaperModelRegistry, 'get' | 'notePrediction'>;
  logger: { info(payload: unknown, message?: string): void; warn(payload: unknown, message?: string): void };
}

const DEFAULT_SNAPSHOT_AGE_MS = ML_PAPER_SNAPSHOT_POINTS.AGE_30S;

export class MlPaperEntryEngine {
  private readonly memory = new Map<string, DecisionMemory>();
  readonly metrics = { decisions: 0, mlBuy: 0, mlSkip: 0, mlError: 0, signaled: 0, safetyBlocked: 0, expired: 0, writeFailures: 0 };

  constructor(private readonly deps: MlPaperEngineDeps) {}

  /** True once the ML decision for this user / candidate is final (no further work this candidate). */
  resolved(userId: string, mint: string) {
    return this.memory.get(`${userId}:${mint}`)?.resolved ?? false;
  }

  async step(input: MlPaperStepInput): Promise<MlPaperStepResult> {
    const key = `${input.userId}:${input.mint}`;
    let memory = this.memory.get(key);
    if (memory?.resolved) return { action: 'NONE' };
    if (!memory) {
      const decided = await this.decide(input);
      if (!decided) return { action: 'NONE' };
      memory = decided;
      this.memory.set(key, memory);
      if (memory.resolved) return { action: 'NONE' };
    }
    // ML BUY pending: the model must still be the approved, selected one.
    const facts = input.facts?.() ?? null;
    if (input.config.mode !== 'ML' || input.config.modelVersion !== memory.modelVersion) return this.resolve(key, memory, 'EXPIRED', 'STRATEGY_OR_MODEL_CHANGED', input.now, [], facts);
    const lookup = await this.deps.registry.get(memory.modelVersion);
    if (!lookup.ok) return this.resolve(key, memory, 'EXPIRED', lookup.reason, input.now, [], facts);
    if (!mlBuyWindowOpen(memory.decidedAt, input.config.decisionWindowSeconds, input.now)) {
      return this.resolve(key, memory, 'EXPIRED', memory.lastBlockers.length ? `WINDOW_EXPIRED: ${memory.lastBlockers.join(',')}` : 'WINDOW_EXPIRED', input.now, memory.lastBlockers, memory.lastFacts ?? facts);
    }
    const blockers = input.safetyBlockers();
    if (blockers.some((reason) => ML_PERMANENT_BLOCKERS.has(reason))) return this.resolve(key, memory, 'SAFETY_BLOCKED', blockers.join(','), input.now, blockers, facts);
    if (blockers.length) {
      memory.lastBlockers = blockers;
      memory.lastFacts = facts;
      return { action: 'NONE' };
    }
    memory.lastFacts = facts;
    return { action: 'SIGNAL', decisionId: memory.decisionId, modelVersion: memory.modelVersion, probability: memory.probability ?? 0, threshold: memory.threshold, snapshotKind: memory.snapshotKind, snapshotAt: memory.snapshotAt, featureHash: memory.featureHash, minLiquidityUsd: facts?.minLiquidityUsd ?? null };
  }

  /** The BUY signal for an ML BUY was created (PAPER execution decides the rest). */
  async markSignaled(userId: string, mint: string, signalId: string | null, now: number) {
    const key = `${userId}:${mint}`;
    const memory = this.memory.get(key);
    if (!memory) return;
    if (!signalId) {
      await this.resolve(key, memory, 'EXPIRED', 'SIGNAL_NOT_CREATED', now);
      return;
    }
    memory.resolved = true;
    this.metrics.signaled += 1;
    await this.write(() => this.deps.prisma.mlPaperDecision.update({ where: { id: memory.decisionId }, data: { outcome: 'SIGNALED', signalId, safetyPassed: true, safetyBlockers: [], resolvedAt: new Date(now), ...factsData(memory.lastFacts) } }));
  }

  private async resolve(key: string, memory: DecisionMemory, outcome: 'EXPIRED' | 'SAFETY_BLOCKED', reason: string, now: number, blockers: string[] = [], facts: MlDecisionFacts | null = null): Promise<MlPaperStepResult> {
    memory.resolved = true;
    if (outcome === 'EXPIRED') this.metrics.expired += 1;
    else this.metrics.safetyBlocked += 1;
    this.memory.set(key, memory);
    await this.write(() => this.deps.prisma.mlPaperDecision.update({ where: { id: memory.decisionId }, data: { outcome, executionReason: reason.slice(0, 500), safetyPassed: blockers.length ? false : null, safetyBlockers: blockers as Prisma.InputJsonValue, resolvedAt: new Date(now), ...factsData(facts) } }));
    return { action: 'NONE' };
  }

  private async write(task: () => Promise<unknown>) {
    try {
      await task();
    } catch (error) {
      this.metrics.writeFailures += 1;
      this.deps.logger.warn({ err: error instanceof Error ? error.message.slice(0, 200) : String(error) }, 'ML PAPER decision write failed');
    }
  }

  /** Makes (or recovers after a restart) the single ML decision of this user / candidate. Null = not yet. */
  private async decide(input: MlPaperStepInput): Promise<DecisionMemory | null> {
    const lookup = await this.deps.registry.get(input.config.modelVersion);
    const model = lookup.ok ? lookup.model : null;
    const timing = mlDecisionTiming(input.detectedAt, model?.snapshotAgeMs ?? DEFAULT_SNAPSHOT_AGE_MS, input.now);
    if (timing === 'WAIT') return null;
    const existing = await this.deps.prisma.mlPaperDecision.findUnique({ where: { userId_mint: { userId: input.userId, mint: input.mint } } });
    if (existing) return this.fromRow(existing);

    const threshold = input.config.buyThreshold;
    const base = { baseDecision: input.base.decision, baseReasons: input.base.reasons as Prisma.InputJsonValue };
    const empty = { features: {} as Prisma.InputJsonValue, featureHash: '', dataQuality: 0 };
    let row: Parameters<PrismaClient['mlPaperDecision']['create']>[0]['data'];
    const common = {
      userId: input.userId, candidateId: await input.candidateId().catch(() => null), mint: input.mint, modelVersion: model?.version ?? input.config.modelVersion ?? 'NONE',
      featureVersion: model?.artifact.featureVersion ?? ML_FEATURE_VERSION, snapshotKind: model?.snapshotKind ?? 'AGE_30S', detectedAt: new Date(input.detectedAt), decidedAt: new Date(input.now),
      threshold: new Prisma.Decimal(threshold.toFixed(3)), ...base,
      ...factsData((() => {
        try {
          return input.facts?.() ?? null;
        } catch {
          return null;
        }
      })()),
    };
    if (!model) {
      row = { ...common, ...empty, snapshotAt: new Date(input.now), mlDecision: 'ML_ERROR', errorReason: lookup.ok ? 'UNKNOWN' : lookup.reason, outcome: 'ERROR', resolvedAt: new Date(input.now) };
    } else if (timing === 'MISSED') {
      row = { ...common, ...empty, snapshotAt: new Date(input.now), mlDecision: 'ML_SKIP', errorReason: 'PREDICTION_POINT_MISSED', outcome: 'SKIPPED', resolvedAt: new Date(input.now) };
    } else {
      let snapshot: MlFeatureSnapshotResult | null = null;
      let failure: { decision: 'ML_SKIP' | 'ML_ERROR'; reason: string } | null = null;
      let probability: number | null = null;
      try {
        snapshot = input.buildFeatures(model.artifact.featureVersion);
        if (snapshot && snapshot.featureVersion !== model.artifact.featureVersion) failure = { decision: 'ML_ERROR', reason: 'FEATURE_VERSION_MISMATCH' };
        if (failure) { /* keep the version mismatch error */ }
        else if (!snapshot || !input.eligible(snapshot)) failure = { decision: 'ML_SKIP', reason: 'ML_INELIGIBLE' };
        // Critical groups (market / security / risk) observed after the snapshot, or a late optional group that still
        // carries a value: real leakage -> refused. Late SOCIAL data alone is excluded (null) by the builder, not leakage.
        else if (snapshot.invalidReasons.some((reason) => reason.startsWith('FUTURE_DATA') || reason.startsWith('LATE_DATA_NOT_EXCLUDED'))) {
          failure = { decision: 'ML_ERROR', reason: `FEATURE_LEAKAGE: ${snapshot.invalidReasons.filter((reason) => reason.startsWith('FUTURE_DATA') || reason.startsWith('LATE_DATA_NOT_EXCLUDED')).join(',')}`.slice(0, 300) };
        }
        else if (model.artifact.columns.some((column) => !(column.feature in snapshot!.features))) failure = { decision: 'ML_ERROR', reason: 'MISSING_FEATURE' };
        else if (snapshot.dataQuality < model.minDataQuality) failure = { decision: 'ML_SKIP', reason: 'LOW_DATA_QUALITY' };
        else {
          probability = predictMl(model.artifact, snapshot.features).probability;
          if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
            failure = { decision: 'ML_ERROR', reason: 'INFERENCE_INVALID_OUTPUT' };
            probability = null;
          }
        }
      } catch (error) {
        failure = { decision: 'ML_ERROR', reason: `INFERENCE_FAILED: ${error instanceof Error ? error.message.slice(0, 160) : String(error)}` };
        probability = null;
      }
      this.deps.registry.notePrediction(model.version, probability !== null, input.now);
      const mlDecision = failure ? failure.decision : classifyMlProbability(probability!, threshold);
      const features = (snapshot?.features ?? {}) as Prisma.InputJsonValue;
      row = {
        ...common, features, featureHash: snapshot ? createHash('sha256').update(JSON.stringify(snapshot.features)).digest('hex') : '', dataQuality: snapshot?.dataQuality ?? 0,
        observedAt: snapshot ? snapshot.observedAt as Prisma.InputJsonValue : Prisma.JsonNull, lateDataExcluded: snapshot ? snapshot.lateDataExcluded as Prisma.InputJsonValue : Prisma.JsonNull,
        snapshotAt: new Date(snapshot?.snapshotAt ?? input.now), probability: probability !== null ? new Prisma.Decimal(probability.toFixed(6)) : null,
        mlDecision, errorReason: failure?.reason ?? null, outcome: mlDecision === 'ML_BUY' ? 'PENDING' : mlDecision === 'ML_SKIP' ? 'SKIPPED' : 'ERROR',
        resolvedAt: mlDecision === 'ML_BUY' ? null : new Date(input.now),
      };
    }
    try {
      const created = await this.deps.prisma.mlPaperDecision.create({ data: row });
      this.metrics.decisions += 1;
      if (created.mlDecision === 'ML_BUY') this.metrics.mlBuy += 1;
      else if (created.mlDecision === 'ML_SKIP') this.metrics.mlSkip += 1;
      else this.metrics.mlError += 1;
      this.deps.logger.info({ event: 'ml_paper_decision', userId: input.userId, mint: input.mint, modelVersion: created.modelVersion, mlDecision: created.mlDecision, probability: created.probability === null ? null : Number(created.probability), threshold, reason: created.errorReason }, 'ml_paper_decision');
      return this.fromRow(created);
    } catch (error) {
      // Concurrent / repeated decision for the same user and candidate: the stored one wins (idempotent).
      if ((error as { code?: string }).code === 'P2002') {
        const stored = await this.deps.prisma.mlPaperDecision.findUnique({ where: { userId_mint: { userId: input.userId, mint: input.mint } } });
        if (stored) return this.fromRow(stored);
      }
      this.metrics.writeFailures += 1;
      this.deps.logger.warn({ mint: input.mint, err: error instanceof Error ? error.message.slice(0, 200) : String(error) }, 'ML PAPER decision could not be stored: no ML entry');
      // Not persisted -> never executed (an unaudited ML entry is not allowed).
      return { decisionId: '', mlDecision: 'ML_ERROR', modelVersion: '', probability: null, threshold, snapshotKind: '', snapshotAt: input.now, decidedAt: input.now, featureHash: '', resolved: true, lastBlockers: [] };
    }
  }

  private fromRow(row: { id: string; mlDecision: string; modelVersion: string; probability: unknown; threshold: unknown; snapshotKind: string; snapshotAt: Date; decidedAt: Date; featureHash: string; outcome: string }): DecisionMemory {
    return {
      decisionId: row.id, mlDecision: row.mlDecision as DecisionMemory['mlDecision'], modelVersion: row.modelVersion,
      probability: row.probability === null || row.probability === undefined ? null : Number(row.probability), threshold: Number(row.threshold),
      snapshotKind: row.snapshotKind, snapshotAt: row.snapshotAt.getTime(), decidedAt: row.decidedAt.getTime(), featureHash: row.featureHash,
      resolved: row.mlDecision !== 'ML_BUY' || row.outcome !== 'PENDING', lastBlockers: [],
    };
  }

  /** Forget bookkeeping of candidates that are long gone. */
  prune(isTracked: (mint: string) => boolean) {
    for (const [key] of this.memory) if (!isTracked(key.slice(key.indexOf(':') + 1))) this.memory.delete(key);
  }

  snapshot() {
    return { ...this.metrics, pending: [...this.memory.values()].filter((item) => !item.resolved).length };
  }
}
