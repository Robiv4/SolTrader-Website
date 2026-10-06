import type { PrismaClient } from '@prisma/client';
import type { TokenMarketSnapshot } from '@soltrader/market-data';
import {
  type AdvancedStrategySettings,
  analyzeToken,
  type CandidateFeatures,
  computeMarketFeatures,
  type MarketObservation,
  resolveAdvancedSettings,
  type SignalAnalysis,
  type StrategyResult,
  type StrategySignal,
} from '@soltrader/strategy-engine';

/** Market history window loaded for the feature engine. */
export const ANALYSIS_HISTORY_MINUTES = 65;

function numberOrNull(value: unknown) {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Persisted TokenMetric rows (+ the current provider snapshot) as feature-engine observations. */
export async function loadObservations(prisma: PrismaClient, tokenId: string, snapshot: TokenMarketSnapshot | null, now = new Date()): Promise<MarketObservation[]> {
  const rows = await prisma.tokenMetric.findMany({
    where: { tokenId, timestamp: { gte: new Date(now.getTime() - ANALYSIS_HISTORY_MINUTES * 60_000) } },
    orderBy: { timestamp: 'asc' },
    select: {
      timestamp: true, priceUsd: true, liquidityUsd: true, volume5m: true, volume1h: true, buyCount5m: true, sellCount5m: true,
      buyCount1h: true, sellCount1h: true, priceChange5m: true, priceChange1h: true, priceChange24h: true,
    },
  });
  const observations: MarketObservation[] = rows.map((row) => ({
    timestamp: row.timestamp,
    priceUsd: numberOrNull(row.priceUsd),
    liquidityUsd: numberOrNull(row.liquidityUsd),
    volume5m: numberOrNull(row.volume5m),
    volume1h: numberOrNull(row.volume1h),
    buyCount5m: row.buyCount5m,
    sellCount5m: row.sellCount5m,
    buyCount1h: row.buyCount1h,
    sellCount1h: row.sellCount1h,
    priceChange5m: numberOrNull(row.priceChange5m),
    priceChange1h: numberOrNull(row.priceChange1h),
    priceChange24h: numberOrNull(row.priceChange24h),
  }));
  if (snapshot && (!observations.length || snapshot.timestamp.getTime() > observations.at(-1)!.timestamp.getTime())) {
    observations.push({
      timestamp: snapshot.timestamp,
      priceUsd: snapshot.priceUsd ?? null,
      liquidityUsd: snapshot.liquidityUsd ?? null,
      volume5m: snapshot.volume5m ?? null,
      volume1h: snapshot.volume1h ?? null,
      buyCount5m: snapshot.buyCount5m ?? null,
      sellCount5m: snapshot.sellCount5m ?? null,
      buyCount1h: snapshot.buyCount1h ?? null,
      sellCount1h: snapshot.sellCount1h ?? null,
      priceChange5m: snapshot.priceChange5m ?? null,
      priceChange1h: snapshot.priceChange1h ?? null,
      priceChange24h: snapshot.priceChange24h ?? null,
    });
  }
  return observations;
}

export interface TokenFeatureSet {
  tokenAddress: string;
  observations: MarketObservation[];
  features: CandidateFeatures['features'];
}

export function buildFeatureSet(tokenAddress: string, observations: MarketObservation[], now: Date, staleAfterMs: number): TokenFeatureSet {
  return { tokenAddress, observations, features: computeMarketFeatures(observations, now, { staleAfterMs }) };
}

/** The existing MomentumStrategy's evaluation as a standard StrategyResult for the composite signal. */
export function momentumAsResult(signal: StrategySignal | null, available: boolean, settings: AdvancedStrategySettings, now: Date): StrategyResult {
  const moduleSettings = settings.modules.Momentum;
  const base = { strategy: 'Momentum' as const, enabled: moduleSettings.enabled, requiredHistoryMinutes: 0, evaluatedAt: now.toISOString(), features: {}, warnings: [] };
  if (!moduleSettings.enabled) return { ...base, available: false, status: 'DISABLED', unavailableReason: 'DISABLED', triggered: false, score: null, confidence: 0, reasons: [] };
  if (!signal || !available) return { ...base, available: false, status: 'UNAVAILABLE', unavailableReason: 'INSUFFICIENT_MARKET_DATA', triggered: false, score: null, confidence: 0, reasons: ['A Momentum stratégiához nincs elég ártörténet.'] };
  return {
    ...base,
    available: true,
    status: 'OK',
    unavailableReason: null,
    triggered: signal.recommendedAction === 'BUY' && signal.score >= moduleSettings.minScore,
    score: Math.min(100, Math.max(0, Math.round(signal.score))),
    confidence: 1,
    reasons: signal.reasons.slice(0, 4),
  };
}

export function runAnalysis(featureSet: TokenFeatureSet, universe: TokenFeatureSet[], settings: AdvancedStrategySettings, momentum: StrategyResult, now: Date): SignalAnalysis {
  return analyzeToken({
    features: featureSet.features,
    observations: featureSet.observations,
    now,
    universe: universe.map((entry) => ({ tokenAddress: entry.tokenAddress, features: entry.features })),
    tokenAddress: featureSet.tokenAddress,
  }, settings, momentum);
}

export async function loadAdvancedSettings(prisma: PrismaClient, userId: string) {
  const row = prisma.advancedStrategyConfig?.findUnique ? await prisma.advancedStrategyConfig.findUnique({ where: { userId } }).catch(() => null) : null;
  return resolveAdvancedSettings(row as Parameters<typeof resolveAdvancedSettings>[0]);
}

/** Compact, explainable summary persisted with signals and trades (analytics reads it later). */
export function summarizeAnalysis(analysis: SignalAnalysis, includeSettings: boolean, compact = false) {
  const composite = analysis.composite;
  return {
    version: analysis.version,
    evaluatedAt: analysis.evaluatedAt,
    compositeScore: composite.score,
    confirmations: composite.confirmations,
    confirmedModules: composite.confirmedModules,
    unconfirmedModules: composite.unconfirmedModules,
    unavailableModules: composite.unavailableModules,
    coverage: composite.coverage,
    exhaustionScore: composite.exhaustionScore,
    exhaustionLevel: composite.exhaustionLevel,
    exhaustionBlocked: composite.exhaustionBlocked,
    criticalLiquidityOutflow: composite.criticalLiquidityOutflow,
    entryEligible: composite.entryEligible,
    action: composite.action,
    reasons: composite.reasons,
    warnings: composite.warnings,
    results: analysis.results.map((result) => (compact
      ? { strategy: result.strategy, status: result.status, available: result.available, triggered: result.triggered, score: result.score, unavailableReason: result.unavailableReason }
      : {
        strategy: result.strategy, status: result.status, available: result.available, triggered: result.triggered, score: result.score,
        confidence: result.confidence, reasons: result.reasons, warnings: result.warnings, unavailableReason: result.unavailableReason, features: result.features,
      })),
    features: {
      priceUsd: analysis.features.priceUsd, liquidityUsd: analysis.features.liquidityUsd, priceChange5m: analysis.features.priceChange5m,
      priceChange15m: analysis.features.priceChange15m, priceChange1h: analysis.features.priceChange1h, volumeSpikeRatio: analysis.features.volumeSpikeRatio,
      buyShare5m: analysis.features.buyShare5m, liquidityChange15m: analysis.features.liquidityChange15m, historyMinutes: analysis.features.historyMinutes,
      snapshotCount: analysis.features.snapshotCount, dataQuality: analysis.features.dataQuality,
    },
    ...(includeSettings ? { settings: analysis.settings } : {}),
  };
}

export type AnalysisSummary = ReturnType<typeof summarizeAnalysis>;
