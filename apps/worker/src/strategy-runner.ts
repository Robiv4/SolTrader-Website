import type { Prisma, PrismaClient } from '@prisma/client';
import { type AiUserSettings, automaticEntryDecisionSource } from '@soltrader/ai-engine';
import type { TokenDataProvider, TokenMarketSnapshot } from '@soltrader/market-data';
import { createCorrelationId, type MonitoringRegistry } from '@soltrader/monitoring';
import { type AdvancedStrategySettings, createConfiguredStrategy, type SignalAnalysis, type Strategy, type StrategySignal } from '@soltrader/strategy-engine';
import { buildStrategyMarketData, type HistoricalMetricPoint } from '@soltrader/token-discovery';

import { type AiAnalysisService, loadAiSettings } from './ai-analysis-service.js';
import { type AnalysisSummary, buildFeatureSet, loadAdvancedSettings, loadObservations, momentumAsResult, runAnalysis, summarizeAnalysis, type TokenFeatureSet } from './signal-analysis.js';
import type { TradingLoopLogger } from './trading-loop.js';
import type { UnbuyableTokenTracker } from './unbuyable-tracker.js';

export interface StrategyRunnerDependencies {
  prisma: PrismaClient;
  provider: TokenDataProvider;
  logger: TradingLoopLogger;
  registry: MonitoringRegistry;
  /** How far back to look for fresh (non-REJECT) risk assessments to evaluate. */
  lookbackMs: number;
  /** Number of prior TokenMetric rows used to derive technical features. */
  historyWindow: number;
  publishEvent?: (type: 'signal_update', payload: Record<string, unknown>) => Promise<void>;
  /** Tokens the user currently skips as unbuyable get no new signals. */
  tracker?: UnbuyableTokenTracker;
  /** Keeps the latest analysis per user/token (e.g. in Redis) for the token details view and manual buys. */
  cacheAnalysis?: (userId: string, tokenAddress: string, analysis: AnalysisSummary) => Promise<void>;
  /** Snapshots older than this are STALE for the feature engine. */
  staleAfterMs?: number;
  now?: () => Date;
  /** AI Token Analyzer; used only for users whose decision mode is AI. */
  aiService?: AiAnalysisService;
}

export interface StrategyCycleSummary {
  candidates: number;
  evaluated: number;
  signaled: number;
  errors: number;
}

type RiskAssessmentWithToken = Awaited<ReturnType<PrismaClient['riskAssessment']['findMany']>>[number] & {
  token: { id: string; address: string };
};

type RiskConfigRow = Awaited<ReturnType<PrismaClient['riskConfig']['findUnique']>>;

/** A composite BUY for the same user/token is not repeated within this window. */
const COMPOSITE_BUY_COOLDOWN_MS = 10 * 60_000;
/** WATCH analyses are persisted at most this often unless the picture changes materially. */
const COMPOSITE_WATCH_REFRESH_MS = 10 * 60_000;
const COMPOSITE_STRATEGY_NAME = 'CompositeSignal';

/** Only BUY entries get a recommended stop/target — derived from the user's own risk config, never fabricated. */
function computeRecommendedLevels(priceUsd: number | undefined, riskConfig: RiskConfigRow, direction: StrategySignal['recommendedAction']) {
  if (priceUsd === undefined || direction !== 'BUY' || !riskConfig) {
    return { recommendedStop: undefined as number | undefined, recommendedTarget: undefined as number | undefined };
  }

  const stopLossPercent = riskConfig.stopLossPercent !== null ? Number(riskConfig.stopLossPercent) : undefined;
  const takeProfitPercent = riskConfig.takeProfitPercent !== null ? Number(riskConfig.takeProfitPercent) : undefined;

  return {
    recommendedStop: stopLossPercent !== undefined ? priceUsd * (1 - stopLossPercent / 100) : undefined,
    recommendedTarget: takeProfitPercent !== undefined ? priceUsd * (1 + takeProfitPercent / 100) : undefined,
  };
}

/** Per-cycle, per-user context: decision mode and whether new entries may be analysed at all. */
interface UserCycleContext {
  settings: AdvancedStrategySettings;
  ai: AiUserSettings;
  aiMode: boolean;
  /** Bot running, scanner enabled, no emergency stop: AI analyses (and entries) are allowed. */
  entriesAllowed: boolean;
  referenceOrderUsd: number | null;
}

interface TokenCycleData {
  snapshot: TokenMarketSnapshot;
  featureSet: TokenFeatureSet;
}

/**
 * Risk Engine -> Feature Engine -> Strategy modules -> Signal stage of the pipeline. Only ever evaluates
 * tokens whose most recent RiskAssessment decision is ACCEPT or WATCH (never REJECT); strategies and the
 * composite signal only produce Signal rows — they never place orders. WATCH tokens are re-evaluated on
 * every cycle while their assessment is fresh.
 */
export class StrategyRunner {
  /** Last persisted composite analysis per user:token (throttles WATCH rows). */
  private readonly lastComposite = new Map<string, { at: number; score: number; action: string; confirmations: number }>();

  constructor(private readonly deps: StrategyRunnerDependencies) {}

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  async runCycle(signal: globalThis.AbortSignal | { aborted: boolean }): Promise<StrategyCycleSummary> {
    const correlationId = createCorrelationId();
    const summary: StrategyCycleSummary = { candidates: 0, evaluated: 0, signaled: 0, errors: 0 };
    const { prisma, logger } = this.deps;
    const now = this.now();

    // Strategies / AI only evaluate tokens of users whose token scanner is on (RUNNING, PAPER / SEMI_AUTO).
    const scannerUsers = (await prisma.botConfig.findMany({
      where: { isScannerEnabled: true, status: 'RUNNING', tradingMode: { in: ['PAPER', 'SEMI_AUTO'] }, isEmergencyStop: false },
      select: { userId: true },
    })).map((config) => config.userId);
    if (scannerUsers.length === 0) {
      logger.info({ correlationId }, 'Token scanner is off for every user; strategy cycle skipped');
      return summary;
    }

    const since = new Date(now.getTime() - this.deps.lookbackMs);
    const assessments = (await prisma.riskAssessment.findMany({
      where: { decision: { in: ['ACCEPT', 'WATCH'] }, createdAt: { gte: since }, userId: { in: scannerUsers } },
      orderBy: { createdAt: 'desc' },
      include: { token: true },
    })) as unknown as RiskAssessmentWithToken[];

    const latestByKey = new Map<string, RiskAssessmentWithToken>();
    for (const assessment of assessments) {
      const key = `${assessment.tokenId}:${assessment.userId}`;
      if (!latestByKey.has(key)) latestByKey.set(key, assessment);
    }
    // Required security data UNKNOWN (RPC unavailable) is an infrastructure block: no strategy / automatic entry.
    for (const [key, assessment] of latestByKey) {
      const warnings = Array.isArray((assessment as { warnings?: unknown }).warnings) ? (assessment as { warnings: unknown[] }).warnings : [];
      if (warnings.includes('RPC_SECURITY_DATA_UNAVAILABLE')) latestByKey.delete(key);
    }
    summary.candidates = latestByKey.size;

    // Stage 1: market data + features once per token (shared by every user and by the relative-strength universe).
    const tokens = new Map<string, TokenCycleData>();
    for (const assessment of latestByKey.values()) {
      if (signal.aborted) break;
      if (tokens.has(assessment.tokenId)) continue;
      try {
        const snapshot = await this.deps.provider.getTokenMetrics(assessment.token.address).catch(() => null);
        if (!snapshot) continue;
        const observations = await loadObservations(prisma, assessment.tokenId, snapshot, now);
        tokens.set(assessment.tokenId, { snapshot, featureSet: buildFeatureSet(assessment.token.address, observations, now, this.deps.staleAfterMs ?? 120_000) });
      } catch (error) {
        summary.errors += 1;
        logger.error({ err: error, tokenId: assessment.tokenId, correlationId }, 'Feature calculation failed');
      }
    }
    const universe = [...tokens.values()].map((entry) => entry.featureSet);
    const settingsByUser = new Map<string, UserCycleContext>();

    // Stage 2: per user strategies + composite.
    for (const assessment of latestByKey.values()) {
      if (signal.aborted) break;
      const data = tokens.get(assessment.tokenId);
      if (!data) continue;
      try {
        await this.evaluateToken(assessment, data, universe, settingsByUser, correlationId, summary, now);
      } catch (error) {
        summary.errors += 1;
        logger.error({ err: error, tokenId: assessment.tokenId, correlationId }, 'Strategy evaluation failed');
      }
    }

    logger.info({ ...summary, correlationId }, 'Strategy cycle complete');
    return summary;
  }

  private async userContext(userId: string, cache: Map<string, UserCycleContext>): Promise<UserCycleContext> {
    const cached = cache.get(userId);
    if (cached) return cached;
    const [settings, ai, bot, account, risk] = await Promise.all([
      loadAdvancedSettings(this.deps.prisma, userId),
      loadAiSettings(this.deps.prisma, userId),
      this.deps.prisma.botConfig.findUnique({ where: { userId }, select: { status: true, isScannerEnabled: true, isEmergencyStop: true, tradingMode: true } }).catch(() => null),
      this.deps.prisma.paperAccount?.findUnique ? this.deps.prisma.paperAccount.findUnique({ where: { userId }, select: { equity: true } }).catch(() => null) : null,
      this.deps.prisma.riskConfig.findUnique({ where: { userId }, select: { maxPositionPercent: true } }).catch(() => null),
    ]);
    const equity = account ? Number(account.equity) : null;
    const context: UserCycleContext = {
      settings,
      ai,
      aiMode: automaticEntryDecisionSource(ai) === 'AI',
      entriesAllowed: Boolean(bot && bot.status === 'RUNNING' && bot.isScannerEnabled && !bot.isEmergencyStop && (bot.tradingMode === 'PAPER' || bot.tradingMode === 'SEMI_AUTO')),
      referenceOrderUsd: equity && risk?.maxPositionPercent ? equity * Number(risk.maxPositionPercent) / 100 : null,
    };
    cache.set(userId, context);
    return context;
  }

  private async evaluateToken(
    assessment: RiskAssessmentWithToken,
    data: TokenCycleData,
    universe: TokenFeatureSet[],
    settingsCache: Map<string, UserCycleContext>,
    correlationId: string,
    summary: StrategyCycleSummary,
    now: Date,
  ) {
    const userId = assessment.userId;
    if (!userId) return;
    if (this.deps.tracker && await this.deps.tracker.isSkipped(userId, assessment.token.address)) return;

    const allStrategyConfigs = await this.deps.prisma.strategyConfig.findMany({ where: { userId } });
    const strategyConfigs = allStrategyConfigs.filter((config) => config.isEnabled);
    const userContext = await this.userContext(userId, settingsCache);
    const settings = userContext.settings;
    const { snapshot } = data;

    const historyRows = await this.deps.prisma.tokenMetric.findMany({
      where: { tokenId: assessment.token.id },
      orderBy: { timestamp: 'desc' },
      take: this.deps.historyWindow,
    });
    const history: HistoricalMetricPoint[] = historyRows.map((row) => ({
      timestamp: row.timestamp,
      priceUsd: row.priceUsd !== null ? Number(row.priceUsd) : undefined,
      volume24h: row.volume24h !== null ? Number(row.volume24h) : undefined,
      liquidityUsd: row.liquidityUsd !== null ? Number(row.liquidityUsd) : undefined,
      buyCount24h: row.buyCount24h ?? undefined,
      sellCount24h: row.sellCount24h ?? undefined,
    }));

    const marketData = buildStrategyMarketData(assessment.token.address, snapshot, history, Number(assessment.riskScore));
    summary.evaluated += 1;

    // The existing MomentumStrategy (with the user's parameters) feeds the composite as its "Momentum" factor.
    const momentumConfig = allStrategyConfigs.find((config) => config.strategyName === 'Momentum');
    const momentumSignal = createConfiguredStrategy('Momentum', (momentumConfig?.params as Record<string, unknown> | null) ?? {})?.evaluate(marketData, { hasOpenPosition: false }) ?? null;
    const analysis = runAnalysis(data.featureSet, universe, settings, momentumAsResult(momentumSignal, marketData.shortTermMomentum !== undefined, settings, now), now);
    const compactAnalysis = summarizeAnalysis(analysis, false);

    // AI mode: only the AI works. Strategies and the composite signal neither run nor record signals;
    // the market features above are passed to the AI purely as input data.
    if (userContext.aiMode) {
      if (userContext.entriesAllowed && this.deps.aiService && !assessment.hardBlocked) this.enqueueAi(assessment, userId, userContext, data, compactAnalysis);
      return;
    }

    await this.deps.cacheAnalysis?.(userId, assessment.token.address, compactAnalysis).catch(() => undefined);
    const riskConfig = await this.deps.prisma.riskConfig.findUnique({ where: { userId } });

    for (const config of strategyConfigs) {
      const strategy = createConfiguredStrategy(config.strategyName, (config.params as Record<string, unknown> | null) ?? {});
      if (!strategy) continue;

      if (await this.isOnCooldown(assessment.tokenId, userId, strategy.name, strategy.cooldownMs)) continue;

      const strategySignal = strategy.evaluate(marketData, { hasOpenPosition: false });
      if (strategySignal.recommendedAction === 'REJECT') {
        // The strategy's own secondary risk opt-out; the primary risk gate already ran upstream.
        continue;
      }

      // Exhaustion filter: an existing strategy's BUY is downgraded to WATCH when the pump looks spent.
      const exhaustionDowngrade = strategySignal.recommendedAction === 'BUY' && analysis.composite.exhaustionBlocked;
      const effective: StrategySignal = exhaustionDowngrade
        ? { ...strategySignal, recommendedAction: 'WATCH', reasons: [...strategySignal.reasons, `Pump kifáradás ${analysis.composite.exhaustionScore}/100 – automatikus belépés tiltva (PUMP_EXHAUSTION_BLOCK).`] }
        : strategySignal;
      await this.persistSignal(assessment, userId, strategy.name, effective, snapshot.priceUsd, riskConfig, correlationId, {
        signalType: 'STRATEGY',
        strategy,
        analysis: summarizeAnalysis(analysis, false, true),
        exhaustionBlocked: exhaustionDowngrade,
      });
      summary.signaled += 1;
    }

    if (settings.compositeEnabled) {
      const persisted = await this.maybePersistComposite(assessment, userId, analysis, snapshot, riskConfig, correlationId);
      if (persisted) summary.signaled += 1;
    }
  }

  /** Queues the AI Token Analyzer for this user/token (never blocks the cycle). */
  private enqueueAi(assessment: RiskAssessmentWithToken, userId: string, userContext: UserCycleContext, data: TokenCycleData, compactAnalysis: AnalysisSummary) {
    const { snapshot } = data;
    this.deps.aiService!.enqueue({
      userId,
      tokenId: assessment.tokenId,
      tokenAddress: assessment.token.address,
      symbol: snapshot.metadata.symbol ?? null,
      name: snapshot.metadata.name ?? null,
      tokenAgeSeconds: snapshot.metadata.tokenAgeSeconds ?? null,
      settings: userContext.ai,
      risk: {
        id: assessment.id,
        riskScore: Number(assessment.riskScore),
        classification: String(assessment.classification),
        riskPolicy: String(assessment.riskPolicy),
        positionMultiplier: Number(assessment.positionMultiplier),
        hardBlocked: assessment.hardBlocked,
        hardBlockReasons: Array.isArray(assessment.hardBlockReasons) ? assessment.hardBlockReasons.filter((reason): reason is string => typeof reason === 'string') : [],
        warnings: Array.isArray(assessment.warnings) ? assessment.warnings.filter((warning): warning is string => typeof warning === 'string') : [],
        factors: (assessment.factors && typeof assessment.factors === 'object' ? assessment.factors : {}) as Record<string, unknown>,
      },
      features: data.featureSet.features,
      observations: data.featureSet.observations,
      analysis: compactAnalysis,
      market: { volume24h: snapshot.volume24h ?? null, priceChange24h: snapshot.priceChange24h ?? null, marketCap: snapshot.marketCap ?? null, fdv: snapshot.fdv ?? null },
      referenceOrderUsd: userContext.referenceOrderUsd,
    });
  }

  private async maybePersistComposite(
    assessment: RiskAssessmentWithToken,
    userId: string,
    analysis: SignalAnalysis,
    snapshot: TokenMarketSnapshot,
    riskConfig: RiskConfigRow,
    correlationId: string,
  ) {
    const composite = analysis.composite;
    const key = `${userId}:${assessment.tokenId}`;
    const now = this.now().getTime();
    const last = this.lastComposite.get(key) ?? await this.lastPersistedComposite(assessment.tokenId, userId);
    if (composite.action === 'BUY') {
      if (last && last.action === 'BUY' && now - last.at < COMPOSITE_BUY_COOLDOWN_MS) return false;
    } else if (last) {
      const changed = last.action !== composite.action || Math.abs(last.score - composite.score) >= 10 || last.confirmations !== composite.confirmations;
      if (!changed && now - last.at < COMPOSITE_WATCH_REFRESH_MS) return false;
    }
    const signal: StrategySignal = {
      token: assessment.token.address,
      timestamp: new Date(now),
      strategy: COMPOSITE_STRATEGY_NAME,
      score: composite.score,
      riskScore: Number(assessment.riskScore),
      reasons: [...composite.reasons, ...composite.warnings],
      recommendedAction: composite.action,
    };
    await this.persistSignal(assessment, userId, COMPOSITE_STRATEGY_NAME, signal, snapshot.priceUsd, riskConfig, correlationId, {
      signalType: 'COMPOSITE',
      // BUY rows carry the full settings snapshot so the resulting trade keeps the configuration used at entry.
      analysis: summarizeAnalysis(analysis, composite.action === 'BUY'),
      exhaustionBlocked: composite.exhaustionBlocked,
    });
    this.lastComposite.set(key, { at: now, score: composite.score, action: composite.action, confirmations: composite.confirmations });
    this.deps.logger.info({
      event: 'strategy_evaluation',
      userId,
      tokenAddress: assessment.token.address,
      strategy: COMPOSITE_STRATEGY_NAME,
      score: composite.score,
      triggered: composite.entryEligible,
      confirmations: composite.confirmedModules,
      exhaustionScore: composite.exhaustionScore,
      modules: analysis.results.map((result) => ({ strategy: result.strategy, status: result.status, score: result.score, triggered: result.triggered })),
      reasons: composite.reasons,
      timestamp: analysis.evaluatedAt,
    }, 'strategy_evaluation');
    return true;
  }

  private async lastPersistedComposite(tokenId: string, userId: string) {
    const last = await this.deps.prisma.signal.findFirst({ where: { tokenId, userId, strategyName: COMPOSITE_STRATEGY_NAME }, orderBy: { createdAt: 'desc' }, select: { createdAt: true, score: true, direction: true, metadata: true } });
    if (!last) return null;
    const analysis = (last.metadata as { analysis?: { confirmations?: number } } | null)?.analysis;
    return { at: last.createdAt.getTime(), score: Number(last.score), action: last.direction ?? 'WATCH', confirmations: analysis?.confirmations ?? 0 };
  }

  private async isOnCooldown(tokenId: string, userId: string, strategyName: string, cooldownMs: number): Promise<boolean> {
    const last = await this.deps.prisma.signal.findFirst({
      where: { tokenId, userId, strategyName },
      orderBy: { createdAt: 'desc' },
    });
    if (!last) return false;
    return Date.now() - last.createdAt.getTime() < cooldownMs;
  }

  private async persistSignal(
    assessment: RiskAssessmentWithToken,
    userId: string,
    strategyName: string,
    strategySignal: StrategySignal,
    priceUsd: number | undefined,
    riskConfig: RiskConfigRow,
    correlationId: string,
    extra: { signalType: 'STRATEGY' | 'COMPOSITE'; strategy?: Strategy; analysis: AnalysisSummary; exhaustionBlocked: boolean },
  ) {
    const tokenId = assessment.tokenId;
    const strategyRow = await this.deps.prisma.strategy.upsert({
      where: { name: strategySignal.strategy },
      update: {},
      create: { name: strategySignal.strategy, type: extra.signalType === 'COMPOSITE' ? 'composite' : 'rule-based', mode: 'SCANNER', isEnabled: true },
    });

    const direction = strategySignal.recommendedAction === 'REJECT' ? undefined : strategySignal.recommendedAction;
    const { recommendedStop, recommendedTarget } = computeRecommendedLevels(priceUsd, riskConfig, strategySignal.recommendedAction);

    await this.deps.prisma.signal.create({
      data: {
        tokenId,
        userId,
        strategyId: strategyRow.id,
        strategyName: strategySignal.strategy,
        direction,
        score: strategySignal.score,
        riskScore: strategySignal.riskScore,
        signalType: extra.signalType,
        mode: 'SCANNER',
        reasons: strategySignal.reasons as unknown as Prisma.InputJsonValue,
        entryConditions: (extra.strategy?.entryConditions ?? ['compositeScore >= minimumCompositeScore', 'confirmations >= minimumConfirmations', 'no exhaustion block', 'no critical liquidity outflow']) as unknown as Prisma.InputJsonValue,
        invalidationConditions: (extra.strategy?.exitConditions ?? []) as unknown as Prisma.InputJsonValue,
        recommendedStop,
        recommendedTarget,
        metadata: {
          correlationId,
          riskClassification: assessment.classification,
          hardBlocked: assessment.hardBlocked,
          hardBlockReasons: assessment.hardBlockReasons,
          riskPolicy: assessment.riskPolicy,
          riskPositionMultiplier: assessment.positionMultiplier,
          riskWarnings: assessment.warnings,
          riskFactors: assessment.factors,
          primaryStrategy: strategyName,
          exhaustionBlocked: extra.exhaustionBlocked,
          criticalLiquidityOutflow: extra.analysis.criticalLiquidityOutflow,
          analysis: extra.analysis,
        } as unknown as Prisma.InputJsonValue,
      },
    });
    await this.deps.publishEvent?.('signal_update', {
      userId,
      tokenId,
      signalScore: strategySignal.score,
      signalDirection: direction,
      strategy: strategySignal.strategy,
      riskScore: assessment.riskScore,
      compositeScore: extra.analysis.compositeScore,
      confirmations: extra.analysis.confirmations,
    });
  }
}
