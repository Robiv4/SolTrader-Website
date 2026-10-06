import { Prisma, type PrismaClient } from '@prisma/client';
import {
  AI_PROMPT_VERSION,
  AiInputValidationError,
  aiNumber,
  AiProviderError,
  type AIProvider,
  type AiProviderInfo,
  type AiTokenAnalysisInput,
  type AiUserSettings,
  assertValidAiInput,
  DEFAULT_AI_USER_SETTINGS,
  effectiveAiDecision,
  type EffectiveDecision,
  inputHash,
  isSignificantChange,
  marketStateHash,
  MIN_REANALYSIS_SECONDS,
  recheckDelaySeconds,
  validateAiTokenAnalysis,
} from '@soltrader/ai-engine';
import type { MarketFeatures, MarketObservation } from '@soltrader/strategy-engine';

import type { AnalysisSummary } from './signal-analysis.js';
import type { TradingLoopLogger } from './trading-loop.js';

/** Minimal key-value store (Redis in production) used for cache state, rate limits and usage counters. */
export interface AiKeyValueStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options?: { EX?: number }): Promise<unknown>;
  incrBy(key: string, amount: number): Promise<number>;
  expire(key: string, seconds: number): Promise<unknown>;
}

export interface AiRiskContext {
  id: string;
  riskScore: number;
  classification: string;
  riskPolicy: string;
  positionMultiplier: number;
  hardBlocked: boolean;
  hardBlockReasons: string[];
  warnings: string[];
  factors: Record<string, unknown>;
}

export interface AiAnalysisJob {
  userId: string;
  tokenId: string;
  tokenAddress: string;
  symbol: string | null;
  name: string | null;
  tokenAgeSeconds: number | null;
  settings: AiUserSettings;
  risk: AiRiskContext;
  features: MarketFeatures;
  observations: MarketObservation[];
  analysis: AnalysisSummary | null;
  market: { volume24h: number | null; priceChange24h: number | null; marketCap: number | null; fdv: number | null };
  /** Order size used to estimate price impact (normal automatic size). */
  referenceOrderUsd: number | null;
}

export type AiJobOutcome =
  | 'ANALYZED'
  | 'CACHED'
  | 'RATE_LIMITED'
  | 'IN_FLIGHT'
  | 'HARD_BLOCKED'
  | 'INPUT_INVALID'
  | 'PROVIDER_UNAVAILABLE'
  | 'INVALID_OUTPUT';

export interface AiAnalysisServiceDependencies {
  prisma: PrismaClient;
  provider: AIProvider | null;
  providerInfo: AiProviderInfo;
  store: AiKeyValueStore;
  logger: TradingLoopLogger;
  timeoutMs: number;
  maxRetries: number;
  /** Server-level hard ceiling of provider calls per minute (users can only be stricter). */
  serverMaxPerMinute: number;
  concurrency: number;
  staleAfterMs?: number;
  publishLog?: (entry: { userId: string; action: string; details: Record<string, unknown> }) => Promise<void>;
  publishEvent?: (type: 'signal_update', payload: Record<string, unknown>) => Promise<void>;
  now?: () => Date;
}

interface AiState {
  analysisId: string;
  analyzedAt: number;
  nextEligibleAt: number;
  effectiveDecision: EffectiveDecision;
  input: AiTokenAnalysisInput;
}

export const AI_SIGNAL_STRATEGY = 'AiTokenAnalyzer';

const stateKey = (userId: string, tokenAddress: string) => `ai:state:${userId}:${tokenAddress}`;
const dayKey = (date: Date) => date.toISOString().slice(0, 10);

/** Loads a user's AI settings (defaults until the user saves them; AI mode OFF by default). */
export async function loadAiSettings(prisma: PrismaClient, userId: string): Promise<AiUserSettings> {
  const row = prisma.aiConfig?.findUnique ? await prisma.aiConfig.findUnique({ where: { userId } }).catch(() => null) : null;
  if (!row) return { ...DEFAULT_AI_USER_SETTINGS };
  return {
    aiAnalysisEnabled: row.aiAnalysisEnabled,
    aiMinimumConfidence: row.aiMinimumConfidence,
    aiRecheckSeconds: row.aiRecheckSeconds,
    aiMaxAnalysesPerMinute: row.aiMaxAnalysesPerMinute,
    aiAllowHighRisk: row.aiAllowHighRisk,
    aiAllowVeryHighRisk: row.aiAllowVeryHighRisk,
    aiDynamicExitSuggestionsEnabled: row.aiDynamicExitSuggestionsEnabled,
    aiDecisionTtlSeconds: row.aiDecisionTtlSeconds,
    aiUseExitParameters: row.aiUseExitParameters,
  };
}

/** Builds the point-in-time structured AI input (public market/risk data only; nothing after `now`). */
export function buildAiInput(job: AiAnalysisJob, now: Date): AiTokenAnalysisInput {
  const f = job.features;
  const reference = now.getTime();
  const pastObservations = job.observations.filter((observation) => observation.timestamp.getTime() <= reference + 60_000);
  const prices30 = pastObservations.filter((observation) => observation.timestamp.getTime() >= reference - 30 * 60_000).map((observation) => observation.priceUsd).filter((price): price is number => typeof price === 'number' && price > 0);
  const mean = prices30.length ? prices30.reduce((a, b) => a + b, 0) / prices30.length : null;
  const volatility = mean && prices30.length > 2 ? Math.sqrt(prices30.reduce((sum, price) => sum + (price - mean) ** 2, 0) / prices30.length) / mean * 100 : null;
  const liquidity = f.liquidityUsd;
  const impact = liquidity && job.referenceOrderUsd && job.referenceOrderUsd > 0 ? 0.1 + 100 * job.referenceOrderUsd / (liquidity / 2 + job.referenceOrderUsd) : null;
  const securityKeys = ['mintAuthorityActive', 'freezeAuthorityActive', 'sellability', 'holderConcentration', 'topHolderConcentration', 'liquidityConcentration', 'token2022Extensions', 'honeypot'];
  const factors = Object.fromEntries(Object.entries(job.risk.factors ?? {}).filter(([, value]) => typeof value === 'number').map(([key, value]) => [key, aiNumber(value)]));
  const security = Object.fromEntries(Object.entries(job.risk.factors ?? {}).filter(([key]) => securityKeys.some((name) => key.toLowerCase().includes(name.toLowerCase()))).map(([key, value]) => [key, typeof value === 'boolean' || typeof value === 'string' ? value : aiNumber(value)]));
  const recent = pastObservations.slice(-12).map((observation) => ({
    minutesAgo: aiNumber((reference - observation.timestamp.getTime()) / 60_000, 3) ?? 0,
    priceUsd: aiNumber(observation.priceUsd),
    liquidityUsd: aiNumber(observation.liquidityUsd),
    volume5m: aiNumber(observation.volume5m),
    buys5m: aiNumber(observation.buyCount5m),
    sells5m: aiNumber(observation.sellCount5m),
  }));
  const strategyFeatures = Object.fromEntries((job.analysis?.results ?? []).map((result) => [result.strategy, { status: result.status, score: aiNumber(result.score), triggered: Boolean(result.triggered) }]));
  return {
    evaluatedAt: (f.evaluatedAt && Date.parse(f.evaluatedAt) <= reference + 60_000 ? new Date(Date.parse(f.evaluatedAt)) : now).toISOString(),
    token: { address: job.tokenAddress, symbol: job.symbol, name: job.name, tokenAgeMinutes: job.tokenAgeSeconds === null ? null : aiNumber(job.tokenAgeSeconds / 60, 4) },
    market: {
      priceUsd: f.priceUsd ?? Number.NaN,
      priceChange1m: aiNumber(f.priceChange1m),
      priceChange5m: aiNumber(f.priceChange5m),
      priceChange15m: aiNumber(f.priceChange15m),
      priceChange1h: aiNumber(f.priceChange1h),
      priceChange24h: aiNumber(job.market.priceChange24h),
      liquidityUsd: aiNumber(f.liquidityUsd),
      liquidityChange5m: aiNumber(f.liquidityChange5m),
      liquidityChange15m: aiNumber(f.liquidityChange15m),
      volume5m: aiNumber(f.volume5m),
      volume1h: aiNumber(f.volume1h),
      volume24h: aiNumber(job.market.volume24h),
      volumeSpikeRatio: aiNumber(f.volumeSpikeRatio),
      volumeAcceleration: aiNumber(f.volumeAcceleration),
      buys5m: aiNumber(f.buys5m),
      sells5m: aiNumber(f.sells5m),
      buySellCountRatio: aiNumber(f.buySellCountRatio),
      buyShare5m: aiNumber(f.buyShare5m),
      buyShare1h: aiNumber(f.buyShare1h),
      buyVolume5m: aiNumber(f.buyVolume5m),
      sellVolume5m: aiNumber(f.sellVolume5m),
      averageTradeSizeUsd5m: aiNumber(f.averageTradeSizeUsd5m),
      momentumWindows5m: f.momentumWindows ? f.momentumWindows.map((value) => aiNumber(value)) : null,
      momentumAcceleration: aiNumber(f.momentumAcceleration),
      recentHigh30m: aiNumber(f.recentHigh30m),
      recentLow30m: aiNumber(f.recentLow30m),
      distanceFromRecentHighPercent: aiNumber(f.distanceFromRecentHighPercent),
      volatility30mPercent: aiNumber(volatility),
      estimatedPriceImpactPercent: aiNumber(impact),
      marketCapUsd: aiNumber(job.market.marketCap),
      fdvUsd: aiNumber(job.market.fdv),
      dataQuality: f.dataQuality,
      historyMinutes: aiNumber(f.historyMinutes, 4),
    },
    risk: {
      riskScore: aiNumber(job.risk.riskScore),
      classification: job.risk.classification,
      factors,
      warnings: job.risk.warnings.slice(0, 12),
      hardBlocked: job.risk.hardBlocked,
      hardBlockReasons: job.risk.hardBlockReasons,
      security,
    },
    strategyFeatures,
    compositeScore: aiNumber(job.analysis?.compositeScore),
    exhaustionScore: aiNumber(job.analysis?.exhaustionScore),
    recentSnapshots: recent,
  };
}

/**
 * AI Token Analyzer: bounded-concurrency queue that analyses eligible candidates for users in AI mode.
 * It never executes trades: an effective BUY only becomes a Signal that the normal PAPER execution
 * pipeline re-validates (mode, TTL, confidence, hard blocks, limits) before any order exists.
 */
export class AiAnalysisService {
  private readonly queue: Array<() => Promise<void>> = [];
  private readonly inFlight = new Set<string>();
  private readonly pending = new Set<Promise<void>>();
  private running = 0;

  constructor(private readonly deps: AiAnalysisServiceDependencies) {}

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  get providerInfo() {
    return this.deps.providerInfo;
  }

  /** Queues an analysis; returns immediately so a slow provider never blocks the scanner. */
  enqueue(job: AiAnalysisJob): boolean {
    const key = `${job.userId}:${job.tokenAddress}`;
    if (this.inFlight.has(key)) return false;
    this.inFlight.add(key);
    this.queue.push(async () => {
      try {
        await this.process(job);
      } catch (error) {
        this.deps.logger.error({ err: error instanceof Error ? error.message : String(error), userId: job.userId, tokenAddress: job.tokenAddress }, 'AI analysis job failed');
      } finally {
        this.inFlight.delete(key);
      }
    });
    this.pump();
    return true;
  }

  /** Waits until the queue is empty (tests, graceful shutdown). */
  async drain() {
    while (this.pending.size > 0 || this.queue.length > 0) {
      await Promise.all([...this.pending]);
    }
  }

  private pump() {
    while (this.running < Math.max(1, this.deps.concurrency) && this.queue.length > 0) {
      const task = this.queue.shift()!;
      this.running += 1;
      const promise = task().finally(() => {
        this.running -= 1;
        this.pending.delete(promise);
        this.pump();
      });
      this.pending.add(promise);
    }
  }

  private async counter(userId: string, field: string, amount = 1) {
    const key = `ai:usage:${userId}:${dayKey(this.now())}:${field}`;
    await this.deps.store.incrBy(key, amount).catch(() => 0);
    await this.deps.store.expire(key, 3 * 86_400).catch(() => undefined);
  }

  private async readState(userId: string, tokenAddress: string): Promise<AiState | null> {
    const raw = await this.deps.store.get(stateKey(userId, tokenAddress)).catch(() => null);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as AiState;
    } catch {
      return null;
    }
  }

  /** Per-user limit (never above the server ceiling) plus a global ceiling, per wall-clock minute. */
  private async withinRateLimit(userId: string, settings: AiUserSettings) {
    const minute = Math.floor(this.now().getTime() / 60_000);
    const userLimit = Math.max(1, Math.min(settings.aiMaxAnalysesPerMinute, this.deps.serverMaxPerMinute));
    const userKey = `ai:rate:user:${userId}:${minute}`;
    const globalKey = `ai:rate:global:${minute}`;
    const userCount = await this.deps.store.incrBy(userKey, 1);
    await this.deps.store.expire(userKey, 120).catch(() => undefined);
    if (userCount > userLimit) return false;
    const globalCount = await this.deps.store.incrBy(globalKey, 1);
    await this.deps.store.expire(globalKey, 120).catch(() => undefined);
    return globalCount <= this.deps.serverMaxPerMinute;
  }

  async process(job: AiAnalysisJob): Promise<AiJobOutcome> {
    const now = this.now();
    if (job.risk.hardBlocked) return 'HARD_BLOCKED';
    const input = buildAiInput(job, now);
    try {
      assertValidAiInput(input, now, this.deps.staleAfterMs ?? 120_000);
    } catch (error) {
      if (error instanceof AiInputValidationError) return error.code === 'HARD_BLOCKED' ? 'HARD_BLOCKED' : 'INPUT_INVALID';
      throw error;
    }

    // Cache / recheck policy: reuse the last analysis while it is fresh and the market did not change meaningfully.
    const state = await this.readState(job.userId, job.tokenAddress);
    if (state) {
      const sinceLast = now.getTime() - state.analyzedAt;
      const significant = isSignificantChange(state.input, input);
      const sameState = marketStateHash(state.input) === marketStateHash(input);
      if (sinceLast < MIN_REANALYSIS_SECONDS * 1000 || (now.getTime() < state.nextEligibleAt && (!significant || sameState))) {
        await this.counter(job.userId, 'cached');
        return 'CACHED';
      }
    }

    if (!(await this.withinRateLimit(job.userId, job.settings))) {
      await this.counter(job.userId, 'rateLimited');
      return 'RATE_LIMITED';
    }

    const provider = this.deps.provider;
    const providerName = provider?.getProviderName() ?? this.deps.providerInfo.provider ?? 'none';
    const modelName = provider?.getModelName() ?? this.deps.providerInfo.model ?? 'none';
    const started = Date.now();
    const common = {
      userId: job.userId,
      tokenId: job.tokenId,
      tokenAddress: job.tokenAddress,
      provider: providerName,
      model: modelName,
      promptVersion: AI_PROMPT_VERSION,
      riskAssessmentId: job.risk.id,
      inputHash: inputHash(input),
      marketStateHash: marketStateHash(input),
      input: input as unknown as Prisma.InputJsonValue,
    };

    let result: Awaited<ReturnType<AIProvider['analyzeToken']>> | null = null;
    let failure: { code: string; message: string } | null = null;
    if (!provider) {
      failure = { code: 'AI_PROVIDER_UNAVAILABLE', message: 'AI provider is not configured' };
    } else {
      for (let attempt = 0; attempt <= Math.max(0, this.deps.maxRetries); attempt += 1) {
        const controller = new globalThis.AbortController();
        let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
        try {
          result = await Promise.race([
            provider.analyzeToken(input, controller.signal),
            new Promise<never>((_resolve, reject) => {
              timer = globalThis.setTimeout(() => {
                controller.abort();
                reject(new AiProviderError('AI request timed out', true));
              }, this.deps.timeoutMs);
            }),
          ]);
          failure = null;
          break;
        } catch (error) {
          const providerError = error instanceof AiProviderError ? error : new AiProviderError('AI provider request failed', true);
          failure = { code: providerError.code, message: providerError.message };
          if (!providerError.retryable) break;
        } finally {
          if (timer) globalThis.clearTimeout(timer);
        }
      }
    }
    const latencyMs = Date.now() - started;

    if (failure || !result) {
      const code = failure?.code ?? 'AI_PROVIDER_UNAVAILABLE';
      const row = await this.deps.prisma.aiAnalysis.create({ data: { ...common, status: code === 'AI_ANALYSIS_INVALID' ? 'INVALID' : 'FAILED', effectiveDecision: 'NONE', effectiveReason: code, errorMessage: failure?.message ?? null, latencyMs, expiresAt: now } });
      // Without any configured provider there is nothing to retry soon: back off for 5 minutes per token.
      await this.saveState(job, input, row.id, 'NONE', now, provider ? undefined : 300);
      await this.counter(job.userId, code === 'AI_ANALYSIS_INVALID' ? 'invalid' : 'failed');
      this.deps.logger.warn({ userId: job.userId, tokenAddress: job.tokenAddress, code, latencyMs }, 'AI_ANALYSIS_FAILED');
      await this.deps.publishLog?.({ userId: job.userId, action: 'AI_ANALYSIS_FAILED', details: { tokenAddress: job.tokenAddress, reason: code } }).catch(() => undefined);
      return code === 'AI_ANALYSIS_INVALID' ? 'INVALID_OUTPUT' : 'PROVIDER_UNAVAILABLE';
    }

    const validated = validateAiTokenAnalysis(result.output);
    if (!validated.ok) {
      const row = await this.deps.prisma.aiAnalysis.create({ data: { ...common, status: 'INVALID', effectiveDecision: 'NONE', effectiveReason: 'AI_ANALYSIS_INVALID', errorMessage: validated.error.slice(0, 500), latencyMs, inputTokens: result.inputTokens, outputTokens: result.outputTokens, expiresAt: now } });
      await this.saveState(job, input, row.id, 'NONE', now);
      await this.counter(job.userId, 'invalid');
      this.deps.logger.warn({ userId: job.userId, tokenAddress: job.tokenAddress, error: validated.error }, 'AI_ANALYSIS_INVALID');
      return 'INVALID_OUTPUT';
    }

    const analysis = validated.analysis;
    const effective = effectiveAiDecision(analysis, job.settings, job.risk.classification);
    const expiresAt = new Date(now.getTime() + Math.max(30, job.settings.aiDecisionTtlSeconds) * 1000);
    const decimal = (value: number | null) => (value === null ? null : new Prisma.Decimal(value));
    const row = await this.deps.prisma.aiAnalysis.create({
      data: {
        ...common,
        status: 'COMPLETED',
        rawDecision: analysis.decision,
        effectiveDecision: effective.decision,
        effectiveReason: effective.reason,
        confidence: decimal(analysis.confidence),
        entryQuality: decimal(analysis.entryQuality),
        marketStrength: decimal(analysis.marketStrength),
        momentumQuality: decimal(analysis.momentumQuality),
        liquidityQuality: decimal(analysis.liquidityQuality),
        timingQuality: decimal(analysis.timingQuality),
        exhaustionRisk: decimal(analysis.exhaustionRisk),
        recommendedPositionMultiplier: decimal(analysis.recommendedPositionMultiplier),
        suggestedStopLossPercent: decimal(analysis.suggestedStopLossPercent),
        suggestedTakeProfitPercent: decimal(analysis.suggestedTakeProfitPercent),
        suggestedTrailingActivationPercent: decimal(analysis.suggestedTrailingActivationPercent),
        suggestedTrailingDistancePercent: decimal(analysis.suggestedTrailingDistancePercent),
        recheckSeconds: analysis.recheckSeconds,
        reasons: analysis.reasons as Prisma.InputJsonValue,
        warnings: analysis.warnings as Prisma.InputJsonValue,
        latencyMs,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        expiresAt,
      },
    });
    await this.saveState(job, input, row.id, effective.decision, now);
    await this.counter(job.userId, 'requests');
    this.deps.logger.info({ userId: job.userId, tokenAddress: job.tokenAddress, rawDecision: analysis.decision, effectiveDecision: effective.decision, reason: effective.reason, confidence: analysis.confidence, latencyMs }, 'AI_ANALYSIS_COMPLETED');
    await this.deps.publishLog?.({ userId: job.userId, action: 'AI_ANALYSIS_COMPLETED', details: { tokenAddress: job.tokenAddress, rawDecision: analysis.decision, effectiveDecision: effective.decision, reason: effective.reason, confidence: analysis.confidence } }).catch(() => undefined);

    if (effective.decision === 'BUY') await this.createBuySignal(job, row.id, analysis.confidence, analysis.recommendedPositionMultiplier, expiresAt, analysis.reasons);
    return 'ANALYZED';
  }

  private async saveState(job: AiAnalysisJob, input: AiTokenAnalysisInput, analysisId: string, decision: EffectiveDecision, now: Date, delaySeconds?: number) {
    const state: AiState = { analysisId, analyzedAt: now.getTime(), nextEligibleAt: now.getTime() + (delaySeconds ?? recheckDelaySeconds(decision, job.settings)) * 1000, effectiveDecision: decision, input };
    await this.deps.store.set(stateKey(job.userId, job.tokenAddress), JSON.stringify(state), { EX: 3_600 }).catch(() => undefined);
  }

  /** An effective AI BUY becomes a Signal; the PAPER execution pipeline decides whether an order may follow. */
  private async createBuySignal(job: AiAnalysisJob, analysisId: string, confidence: number, multiplier: number, expiresAt: Date, reasons: string[]) {
    const strategy = await this.deps.prisma.strategy.upsert({ where: { name: AI_SIGNAL_STRATEGY }, update: {}, create: { name: AI_SIGNAL_STRATEGY, type: 'ai', mode: 'SCANNER', isEnabled: true } });
    await this.deps.prisma.signal.create({
      data: {
        tokenId: job.tokenId,
        userId: job.userId,
        strategyId: strategy.id,
        strategyName: AI_SIGNAL_STRATEGY,
        direction: 'BUY',
        score: new Prisma.Decimal(confidence),
        riskScore: new Prisma.Decimal(job.risk.riskScore),
        signalType: 'AI',
        mode: 'SCANNER',
        reasons: reasons as Prisma.InputJsonValue,
        entryConditions: ['AI effective decision BUY', 'confidence >= aiMinimumConfidence', 'no hard block'] as Prisma.InputJsonValue,
        invalidationConditions: [] as Prisma.InputJsonValue,
        metadata: {
          decisionSource: 'AI',
          aiAnalysisId: analysisId,
          aiExpiresAt: expiresAt.toISOString(),
          aiRecommendedPositionMultiplier: multiplier,
          primaryStrategy: AI_SIGNAL_STRATEGY,
          riskClassification: job.risk.classification,
          hardBlocked: job.risk.hardBlocked,
          hardBlockReasons: job.risk.hardBlockReasons,
          riskPolicy: job.risk.riskPolicy,
          riskPositionMultiplier: job.risk.positionMultiplier,
          riskWarnings: job.risk.warnings,
          riskFactors: job.risk.factors,
          exhaustionBlocked: false,
          criticalLiquidityOutflow: job.analysis?.criticalLiquidityOutflow === true,
          analysis: job.analysis,
        } as unknown as Prisma.InputJsonValue,
      },
    });
    await this.deps.publishEvent?.('signal_update', { userId: job.userId, tokenId: job.tokenId, strategy: AI_SIGNAL_STRATEGY, signalDirection: 'BUY', signalScore: confidence, decisionSource: 'AI' }).catch(() => undefined);
  }
}
