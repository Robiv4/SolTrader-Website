/**
 * Machine Learning SHADOW service (learning pipeline). Zero influence on trading:
 *  - it only receives copies of data the NewLaunch pipeline already has (trade stream, evaluations, tick);
 *  - every hook is synchronous bookkeeping; all I/O goes through a bounded background write queue;
 *  - nothing it does is awaited by the trading pipeline, and every hook is wrapped by the caller (failures isolated).
 *
 * What it does:
 *  1. Immutable feature snapshots at fixed prediction points (AGE_15S / AGE_30S / AGE_60S after detection) for every
 *     ML-eligible candidate (BUY, WATCH, REJECT and not-evaluated alike) + one at the moment of a BUY decision.
 *  2. Shadow outcome tracking for 60 minutes from the SAME pump.fun trade stream (no extra RPC, no polling);
 *     sources without a stream (Raydium / Meteora) use a small market-data budget.
 *  3. Shadow predictions with the model whose status is SHADOW (if any) - stored, never acted upon.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { Prisma, type PrismaClient } from '@prisma/client';
import {
  buildMlFeatureSnapshot, computeCandidateOutcome, ML_FEATURE_VERSION, ML_LABEL_VERSION, newOutcomePath, predictMl, recordPathPoint, validateArtifact,
  type LaunchSecurity, type LaunchState, type MlModelArtifact, type OutcomePathState, type SocialSnapshotResult,
} from '@soltrader/strategy-engine';
import { RollingPercentiles } from '@soltrader/trading-engine';

export type MlMode = 'OFF' | 'SHADOW' | 'ENFORCE_PAPER';
export const ML_SNAPSHOT_POINTS: Array<{ kind: string; ageMs: number }> = [
  { kind: 'AGE_15S', ageMs: 15_000 },
  { kind: 'AGE_30S', ageMs: 30_000 },
  { kind: 'AGE_60S', ageMs: 60_000 },
];
/** A prediction point that is missed by more than this (e.g. worker busy / restarted) is skipped, not back-dated. */
const POINT_TOLERANCE_MS = 10_000;
const TRACK_MS = 60 * 60_000;
const STREAM_GAP_MS = 15_000;
const REFERENCE_ORDER_USD = 20;
const PERSIST_CHECKPOINTS_S = [130, 610, 1810, 3610];

export interface MlLaunchView {
  mint: string;
  source: string;
  detectedAt: number;
  createdAt: number | null;
  firstTradeAt: number | null;
  creator: string | null;
  hasStream: boolean;
  migrated: boolean;
}

/** Read-only access to the NewLaunch tracker (provided by NewLaunchService). */
export interface MlLaunchAccessor {
  launches(): Iterable<MlLaunchView>;
  state(mint: string, referenceOrderUsd: number): LaunchState | null;
  impact(mint: string, referenceOrderUsd: number): number | null;
  security(mint: string): { security: LaunchSecurity; completedAt: number | null } | null;
  candidateId(mint: string): Promise<string>;
}

export interface MlEvaluationRecord {
  userId: string;
  mint: string;
  at: number;
  decision: string;
  status: string;
  reasons: string[];
  score: number | null;
  riskScore: number | null;
  configVersion: string | null;
  social: SocialSnapshotResult | null;
}

interface TrackedPath {
  snapshotId: string;
  mint: string;
  path: OutcomePathState;
  stream: boolean;
  lastPersistS: number;
  lastPollAt: number;
  creator: string | null;
}

export interface MlShadowDeps {
  prisma: Pick<PrismaClient, 'mlFeatureSnapshot' | 'mlCandidateOutcome' | 'mlPrediction' | 'mlModelVersion'>;
  logger: { info(payload: unknown, message?: string): void; warn(payload: unknown, message?: string): void };
  mode: MlMode;
  /** Root for model artifact paths stored in the DB (repository root). */
  repoRoot: string;
  maxTrackedPaths?: number;
  maxWriteQueue?: number;
  /**
   * Snapshot kinds that get a 60-minute outcome path (storage: one path per tracked snapshot).
   * Default AGE_30S (training rows) + BUY_DECISION (link to real PAPER trades).
   */
  outcomeKinds?: string[];
  /** Market-data budget for sources without a trade stream (requests per minute). */
  marketDataPerMinute?: number;
  getMarketPrice?: (mint: string) => Promise<{ priceUsd: number; liquidityUsd: number | null } | null>;
  incrementDaily?: (metric: string, amount?: number) => void;
  now?: () => number;
}

export class MlShadowService {
  private accessor: MlLaunchAccessor | null = null;
  private readonly taken = new Map<string, Set<string>>();
  private readonly evaluations = new Map<string, Map<string, MlEvaluationRecord>>();
  private readonly paths = new Map<string, TrackedPath[]>();
  private readonly writeQueue: Array<() => Promise<unknown>> = [];
  private writing = 0;
  private lastStreamEventAt = 0;
  private gapStart: number | null = null;
  private marketWindow = { start: 0, used: 0 };
  private model: { artifact: MlModelArtifact; version: string } | null = null;
  private modelCheckedAt = 0;
  private modelStatus: 'NONE' | 'LOADED' | 'UNAVAILABLE' = 'NONE';
  private modelError: string | null = null;
  readonly metrics = {
    candidatesSeen: 0, candidatesEligible: 0, candidatesIneligible: 0, snapshotsCreated: 0, snapshotsMissedPoint: 0, leakageViolations: 0,
    trackingStarted: 0, trackingDropped: 0, trackingCompleted: 0, outcomeUpdates: 0, streamGaps: 0,
    predictions: 0, predictionFailures: 0, writeFailures: 0, writesDropped: 0, additionalMarketDataRequests: 0, additionalRpcRequests: 0,
    inferenceLatency: new RollingPercentiles(), snapshotLatency: new RollingPercentiles(),
  };

  constructor(private readonly deps: MlShadowDeps) {}

  private now() {
    return this.deps.now?.() ?? Date.now();
  }

  get enabled() {
    return this.deps.mode !== 'OFF';
  }

  attach(accessor: MlLaunchAccessor) {
    this.accessor = accessor;
  }

  // ------------------------------------------------------------------ hooks (sync, never throw to the caller)

  /** Every pump.fun trade (already decoded by the launch provider). */
  onTrade(trade: { mint: string; wallet: string; isBuy: boolean; virtualSolReserves: number; virtualTokenReserves: number; realSolReserves: number; receivedAt?: number }, solUsd: number | null) {
    if (!this.enabled) return;
    const at = trade.receivedAt ?? this.now();
    this.noteStream(at);
    const list = this.paths.get(trade.mint);
    if (!list || !solUsd || !(trade.virtualTokenReserves > 0)) return;
    const price = (trade.virtualSolReserves / trade.virtualTokenReserves) * solUsd;
    const liquidity = trade.realSolReserves * solUsd * 2;
    for (const tracked of list) {
      recordPathPoint(tracked.path, at, price, liquidity);
      if (!trade.isBuy && tracked.creator && trade.wallet === tracked.creator && tracked.path.creatorSellAt === null && at >= tracked.path.startAt) tracked.path.creatorSellAt = at;
    }
  }

  /** Bonding curve completed: the stream price ends here. */
  onComplete(mint: string) {
    for (const tracked of this.paths.get(mint) ?? []) {
      if (tracked.path.endedAt === null) {
        tracked.path.endedAt = this.now();
        tracked.path.endReason = 'MIGRATED';
      }
    }
  }

  onEvaluation(record: MlEvaluationRecord) {
    if (!this.enabled) return;
    let byUser = this.evaluations.get(record.mint);
    if (!byUser) {
      byUser = new Map();
      this.evaluations.set(record.mint, byUser);
    }
    byUser.set(record.userId, record);
    if (record.decision === 'BUY') this.trySnapshot(record.mint, 'BUY_DECISION', record.at);
  }

  /** Called at the end of every NewLaunch tick (2 s). */
  onTick(now: number) {
    if (!this.enabled || !this.accessor) return;
    this.noteStreamHealth(now);
    for (const launch of this.accessor.launches()) {
      const age = now - launch.detectedAt;
      for (const point of ML_SNAPSHOT_POINTS) {
        if (age < point.ageMs || this.taken.get(launch.mint)?.has(point.kind)) continue;
        if (age > point.ageMs + POINT_TOLERANCE_MS) {
          this.markTaken(launch.mint, point.kind);
          this.metrics.snapshotsMissedPoint += 1;
          continue;
        }
        this.trySnapshot(launch.mint, point.kind, now);
      }
    }
    this.housekeeping(now);
    void this.refreshModel(now);
  }

  // ------------------------------------------------------------------ snapshots

  private markTaken(mint: string, kind: string) {
    let set = this.taken.get(mint);
    if (!set) {
      set = new Set();
      this.taken.set(mint, set);
    }
    set.add(kind);
  }

  private bestDecision(mint: string) {
    const records = [...(this.evaluations.get(mint)?.values() ?? [])];
    const rank = (decision: string) => (decision === 'BUY' ? 3 : decision === 'WATCH' ? 2 : decision === 'REJECT' ? 1 : 0);
    const best = records.sort((a, b) => rank(b.decision) - rank(a.decision))[0] ?? null;
    return { best, records };
  }

  private trySnapshot(mint: string, kind: string, at: number) {
    if (!this.accessor || this.taken.get(mint)?.has(kind)) return;
    const launch = [...this.accessor.launches()].find((item) => item.mint === mint);
    if (!launch) return;
    this.markTaken(mint, kind);
    const started = globalThis.performance.now();
    this.metrics.candidatesSeen += kind === 'AGE_15S' ? 1 : 0;
    const state = this.accessor.state(mint, REFERENCE_ORDER_USD);
    const security = this.accessor.security(mint);
    const { best, records } = this.bestDecision(mint);
    const snapshot = buildMlFeatureSnapshot({
      snapshotAt: at, source: launch.source, detectedAt: launch.detectedAt, createdAt: launch.createdAt, firstTradeAt: launch.firstTradeAt,
      state, security: security?.security ?? null, securityObservedAt: security?.completedAt ?? null,
      riskScore: best?.riskScore ?? null, riskObservedAt: best?.at ?? null, social: best?.social ?? null,
      referenceImpactPct: this.accessor.impact(mint, REFERENCE_ORDER_USD),
    });
    // ML eligibility (separate from trading eligibility): a real price and at least two trades.
    const trades = (state?.observations.at(-1)?.buyCount ?? 0) + (state?.observations.at(-1)?.sellCount ?? 0);
    if (snapshot.referencePriceUsd === null || trades < 2) {
      if (kind === 'AGE_15S') this.metrics.candidatesIneligible += 1;
      return;
    }
    if (kind === 'AGE_15S') this.metrics.candidatesEligible += 1;
    if (!snapshot.validForTraining && snapshot.invalidReasons.some((reason) => reason.startsWith('FUTURE_DATA'))) this.metrics.leakageViolations += 1;
    this.metrics.snapshotLatency.add(globalThis.performance.now() - started);
    const decisionContext = {
      users: records.map((record) => ({ user: createHash('sha256').update(record.userId).digest('hex').slice(0, 12), decision: record.decision, status: record.status, reasons: record.reasons, score: record.score, riskScore: record.riskScore, configVersion: record.configVersion, at: new Date(record.at).toISOString() })),
      evaluated: records.length > 0,
    };
    const decision = best?.decision ?? 'NOT_EVALUATED';
    const accessor = this.accessor;
    this.enqueue(async () => {
      const candidateId = await accessor.candidateId(mint);
      const row = await this.deps.prisma.mlFeatureSnapshot.create({
        data: {
          candidateId, mint, source: launch.source, kind, snapshotAt: new Date(at), detectedAt: new Date(launch.detectedAt), featureVersion: ML_FEATURE_VERSION,
          features: snapshot.features as Prisma.InputJsonValue, observedAt: snapshot.observedAt as Prisma.InputJsonValue, dataQuality: snapshot.dataQuality,
          validForTraining: snapshot.validForTraining, invalidReasons: snapshot.invalidReasons as Prisma.InputJsonValue, decision,
          decisionContext: decisionContext as Prisma.InputJsonValue, newLaunchConfigVersion: best?.configVersion ?? null,
          referencePriceUsd: new Prisma.Decimal(snapshot.referencePriceUsd!),
        },
        select: { id: true },
      });
      this.metrics.snapshotsCreated += 1;
      this.deps.incrementDaily?.('snapshots');
      if ((this.deps.outcomeKinds ?? ['AGE_30S', 'BUY_DECISION']).includes(kind)) this.startTracking(row.id, mint, launch, snapshot.referencePriceUsd!, snapshot.referenceLiquidityUsd, at);
      this.predict(row.id, mint, snapshot.features, snapshot.dataQuality);
    });
  }

  // ------------------------------------------------------------------ outcome tracking

  private trackedCount() {
    let count = 0;
    for (const list of this.paths.values()) count += list.length;
    return count;
  }

  private startTracking(snapshotId: string, mint: string, launch: MlLaunchView, entryPrice: number, entryLiquidity: number | null, at: number) {
    const max = this.deps.maxTrackedPaths ?? 3_000;
    const path = newOutcomePath(at, entryPrice, entryLiquidity);
    if (this.trackedCount() >= max) {
      // Budget exhausted: outcome stays INSUFFICIENT (recorded), trading is unaffected.
      this.metrics.trackingDropped += 1;
      path.endedAt = at;
      path.endReason = 'TRACKING_BUDGET_EXHAUSTED';
      this.enqueue(() => this.deps.prisma.mlCandidateOutcome.create({ data: this.outcomeData(snapshotId, mint, path, at, true) }));
      return;
    }
    if (launch.migrated) {
      path.endedAt = at;
      path.endReason = 'MIGRATED_BEFORE_SNAPSHOT';
    }
    const tracked: TrackedPath = { snapshotId, mint, path, stream: launch.hasStream, lastPersistS: 0, lastPollAt: 0, creator: launch.creator };
    const list = this.paths.get(mint) ?? [];
    list.push(tracked);
    this.paths.set(mint, list);
    this.metrics.trackingStarted += 1;
    this.enqueue(() => this.deps.prisma.mlCandidateOutcome.create({ data: this.outcomeData(snapshotId, mint, path, at, false) }));
  }

  private outcomeData(snapshotId: string, mint: string, path: OutcomePathState, now: number, final: boolean) {
    const result = computeCandidateOutcome(path, now);
    return {
      snapshotId, mint, labelVersion: ML_LABEL_VERSION, status: final ? result.quality : 'TRACKING', entryPriceUsd: new Prisma.Decimal(path.entryPrice),
      result: result as unknown as Prisma.InputJsonValue, path: path as unknown as Prisma.InputJsonValue, validHorizons: result.validHorizons as Prisma.InputJsonValue,
      endReason: path.endReason, trackingEndedAt: final ? new Date(Math.min(now, path.endedAt ?? now)) : null,
    };
  }

  private noteStream(at: number) {
    if (this.gapStart !== null) {
      // Stream back: every active stream path gets the gap (horizons overlapping it become invalid).
      for (const list of this.paths.values()) for (const tracked of list) if (tracked.stream) tracked.path.gaps.push([this.gapStart, at]);
      this.gapStart = null;
    }
    this.lastStreamEventAt = Math.max(this.lastStreamEventAt, at);
  }

  private noteStreamHealth(now: number) {
    if (this.gapStart === null && this.lastStreamEventAt > 0 && now - this.lastStreamEventAt > STREAM_GAP_MS) {
      this.gapStart = this.lastStreamEventAt;
      this.metrics.streamGaps += 1;
    }
  }

  private housekeeping(now: number) {
    for (const [mint, list] of this.paths) {
      const remaining: TrackedPath[] = [];
      for (const tracked of list) {
        if (!tracked.stream) this.pollMarket(tracked, now);
        const ageS = (now - tracked.path.startAt) / 1000;
        const done = now - tracked.path.startAt >= TRACK_MS + 5_000 || (tracked.path.endedAt !== null && now - tracked.path.endedAt > 1_000);
        if (done) {
          if (this.gapStart !== null && tracked.stream) tracked.path.gaps.push([this.gapStart, now]);
          if (tracked.path.endedAt === null) {
            tracked.path.endedAt = Math.min(now, tracked.path.startAt + TRACK_MS + 1);
            tracked.path.endReason = 'HORIZON_REACHED';
          }
          const snapshotId = tracked.snapshotId;
          const pathCopy = tracked.path;
          this.enqueue(() => this.deps.prisma.mlCandidateOutcome.update({ where: { snapshotId }, data: this.outcomeData(snapshotId, mint, pathCopy, now, true) }));
          this.metrics.trackingCompleted += 1;
          this.deps.incrementDaily?.('outcomesCompleted');
          continue;
        }
        const checkpoint = PERSIST_CHECKPOINTS_S.find((value) => ageS >= value && tracked.lastPersistS < value);
        if (checkpoint) {
          tracked.lastPersistS = checkpoint;
          const snapshotId = tracked.snapshotId;
          const pathCopy = { ...tracked.path, buckets: tracked.path.buckets.map((bucket) => [...bucket] as typeof bucket), gaps: [...tracked.path.gaps] };
          this.metrics.outcomeUpdates += 1;
          this.enqueue(() => this.deps.prisma.mlCandidateOutcome.update({ where: { snapshotId }, data: this.outcomeData(snapshotId, mint, pathCopy, now, false) }));
        }
        remaining.push(tracked);
      }
      if (remaining.length) this.paths.set(mint, remaining);
      else this.paths.delete(mint);
    }
    // Forget per-mint bookkeeping of candidates that left the tracker long ago.
    if (this.taken.size > 20_000) for (const mint of [...this.taken.keys()].slice(0, 5_000)) if (!this.paths.has(mint)) {
      this.taken.delete(mint);
      this.evaluations.delete(mint);
    }
  }

  /** Sources without a trade stream: at most one poll per minute per path, inside the market-data budget. */
  private pollMarket(tracked: TrackedPath, now: number) {
    if (!this.deps.getMarketPrice || now - tracked.lastPollAt < 60_000 || tracked.path.endedAt !== null) return;
    if (now - this.marketWindow.start >= 60_000) this.marketWindow = { start: now, used: 0 };
    if (this.marketWindow.used >= (this.deps.marketDataPerMinute ?? 20)) {
      // Budget exhausted: the unobserved interval is recorded as a gap (ML degrades, trading does not).
      if (tracked.lastPollAt && now - tracked.lastPollAt > 120_000) tracked.path.gaps.push([tracked.lastPollAt, now]);
      return;
    }
    this.marketWindow.used += 1;
    this.metrics.additionalMarketDataRequests += 1;
    const previous = tracked.lastPollAt || tracked.path.startAt;
    tracked.lastPollAt = now;
    void this.deps.getMarketPrice(tracked.mint).then((quote) => {
      if (!quote) {
        tracked.path.gaps.push([previous, now]);
        return;
      }
      // A minute between polls is a coarse path: intra-minute ordering is unknown, recorded as a gap-free poll.
      if (now - previous > 120_000) tracked.path.gaps.push([previous, now]);
      recordPathPoint(tracked.path, now, quote.priceUsd, quote.liquidityUsd);
    }).catch(() => tracked.path.gaps.push([previous, now]));
  }

  /** After a restart: resume outcomes that are still inside their 60 minutes (the downtime is a gap). */
  async resume() {
    if (!this.enabled) return;
    const now = this.now();
    const rows = await this.deps.prisma.mlCandidateOutcome.findMany({ where: { status: 'TRACKING' }, select: { snapshotId: true, mint: true, path: true, snapshot: { select: { source: true } } }, take: 5_000 }).catch(() => []);
    for (const row of rows) {
      const path = row.path as unknown as OutcomePathState;
      const lastSeen = path.startAt + (path.buckets.at(-1)?.[0] ?? 0);
      path.gaps.push([Math.max(path.startAt, lastSeen), now]);
      if (now - path.startAt >= TRACK_MS) {
        path.endedAt = path.endedAt ?? path.startAt + TRACK_MS + 1;
        path.endReason = path.endReason ?? 'WORKER_RESTART';
        this.enqueue(() => this.deps.prisma.mlCandidateOutcome.update({ where: { snapshotId: row.snapshotId }, data: this.outcomeData(row.snapshotId, row.mint, path, now, true) }));
        continue;
      }
      const list = this.paths.get(row.mint) ?? [];
      list.push({ snapshotId: row.snapshotId, mint: row.mint, path, stream: row.snapshot.source === 'PUMP_FUN', lastPersistS: 0, lastPollAt: 0, creator: null });
      this.paths.set(row.mint, list);
    }
  }

  // ------------------------------------------------------------------ shadow predictions

  private predict(snapshotId: string, mint: string, features: Record<string, unknown>, dataQuality: number) {
    const model = this.model;
    if (!model) return;
    const started = globalThis.performance.now();
    try {
      const prediction = predictMl(model.artifact, features as never);
      const latency = globalThis.performance.now() - started;
      this.metrics.inferenceLatency.add(latency);
      this.metrics.predictions += 1;
      this.enqueue(() => this.deps.prisma.mlPrediction.create({
        data: {
          snapshotId, modelVersion: model.version, mint, probability: new Prisma.Decimal(prediction.probability.toFixed(6)), calibrated: prediction.calibrated,
          mlEntryScore: prediction.mlEntryScore, predictedClass: prediction.predictedClass, dataQuality,
          contributions: prediction.contributions ? prediction.contributions as Prisma.InputJsonValue : Prisma.JsonNull, latencyMs: new Prisma.Decimal(latency.toFixed(3)),
        },
      }));
    } catch (error) {
      this.metrics.predictionFailures += 1;
      this.deps.logger.warn({ mint, snapshotId, err: error instanceof Error ? error.message : String(error) }, 'ML shadow prediction failed');
    }
  }

  /** Loads the model with status SHADOW (artifact hash verified). Failure -> ML unavailable, trading unchanged. */
  async refreshModel(now: number, force = false) {
    if (!force && now - this.modelCheckedAt < 5 * 60_000) return;
    this.modelCheckedAt = now;
    try {
      const row = await this.deps.prisma.mlModelVersion.findFirst({ where: { status: 'SHADOW' }, orderBy: { trainedAt: 'desc' } });
      if (!row) {
        this.model = null;
        this.modelStatus = 'NONE';
        return;
      }
      if (this.model?.version === row.version) return;
      const file = path.resolve(this.deps.repoRoot, row.artifactPath);
      if (!file.startsWith(path.resolve(this.deps.repoRoot, 'ml', 'models'))) throw new Error('Artifact path outside ml/models');
      const content = await readFile(file);
      const hash = createHash('sha256').update(content).digest('hex');
      if (hash !== row.artifactHash) throw new Error('Artifact hash mismatch (corrupt or modified file)');
      const artifact = validateArtifact(JSON.parse(content.toString('utf8')));
      if (artifact.featureVersion !== ML_FEATURE_VERSION) throw new Error(`Model feature version ${artifact.featureVersion} != ${ML_FEATURE_VERSION}`);
      this.model = { artifact, version: row.version };
      this.modelStatus = 'LOADED';
      this.modelError = null;
      this.deps.logger.info({ modelVersion: row.version, algorithm: artifact.algorithm }, 'ML shadow model loaded');
    } catch (error) {
      this.model = null;
      this.modelStatus = 'UNAVAILABLE';
      this.modelError = error instanceof Error ? error.message.slice(0, 200) : String(error);
      this.deps.logger.warn({ err: this.modelError }, 'ML shadow model unavailable (trading unaffected)');
    }
  }

  // ------------------------------------------------------------------ bounded background writes

  private enqueue(task: () => Promise<unknown>) {
    if (this.writeQueue.length >= (this.deps.maxWriteQueue ?? 5_000)) {
      this.metrics.writesDropped += 1;
      return;
    }
    this.writeQueue.push(task);
    this.drain();
  }

  private drain() {
    while (this.writing < 2 && this.writeQueue.length) {
      const task = this.writeQueue.shift()!;
      this.writing += 1;
      void task().catch((error: unknown) => {
        this.metrics.writeFailures += 1;
        if (this.metrics.writeFailures % 50 === 1) this.deps.logger.warn({ err: error instanceof Error ? error.message.slice(0, 200) : String(error) }, 'ML write failed (trading unaffected)');
      }).finally(() => {
        this.writing -= 1;
        this.drain();
      });
    }
  }

  /** Waits for queued writes (tests / shutdown). */
  async flush() {
    while (this.writeQueue.length || this.writing) await new Promise((resolve) => globalThis.setTimeout(resolve, 5));
  }

  snapshot() {
    const m = this.metrics;
    return {
      at: new Date(this.now()).toISOString(),
      mode: this.deps.mode,
      featureVersion: ML_FEATURE_VERSION,
      labelVersion: ML_LABEL_VERSION,
      model: { status: this.modelStatus, version: this.model?.version ?? null, algorithm: this.model?.artifact.algorithm ?? null, error: this.modelError },
      candidatesSeen: m.candidatesSeen, candidatesEligible: m.candidatesEligible, candidatesIneligible: m.candidatesIneligible,
      snapshotsCreated: m.snapshotsCreated, snapshotsMissedPoint: m.snapshotsMissedPoint, leakageViolations: m.leakageViolations,
      trackedPaths: this.trackedCount(), trackingStarted: m.trackingStarted, trackingDropped: m.trackingDropped, trackingCompleted: m.trackingCompleted,
      outcomeUpdates: m.outcomeUpdates, streamGaps: m.streamGaps, streamGapOpen: this.gapStart !== null,
      predictions: m.predictions, predictionFailures: m.predictionFailures, inferenceLatencyMs: m.inferenceLatency.summary(), snapshotLatencyMs: m.snapshotLatency.summary(),
      writeQueueDepth: this.writeQueue.length, writeFailures: m.writeFailures, writesDropped: m.writesDropped,
      additionalRpcRequests: m.additionalRpcRequests, additionalMarketDataRequests: m.additionalMarketDataRequests,
    };
  }
}
