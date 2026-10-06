import type { PrismaClient } from '@prisma/client';
import { createConfiguredStrategy, type Strategy } from '@soltrader/strategy-engine';
import { buildStrategyMarketData } from '@soltrader/token-discovery';
import { HistoricalBacktestEngine, type BacktestConfig, type BacktestResult, type HistoricalBar } from '@soltrader/trading-engine';

interface BacktestRequest {
  tokenAddress: string;
  strategyName: string;
  startDate: Date;
  endDate: Date;
  initialBalance: number;
  walkForward?: { trainingBars: number; validationBars: number; outOfSampleBars: number };
}

function numeric(value: unknown, fallback = 0) {
  if (value === null || value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toHistoricalBars(rows: Array<{ timestamp: Date; priceUsd: unknown }>): HistoricalBar[] {
  let previous = numeric(rows[0]?.priceUsd);
  return rows.map((row) => {
    const close = numeric(row.priceUsd);
    const open = previous > 0 ? previous : close;
    previous = close;
    return { timestamp: row.timestamp, token: '', open, high: Math.max(open, close), low: Math.min(open, close), close, volume: 0 };
  });
}

function buildConfig(initialBalance: number, risk: { maxPositionPercent: unknown; stopLossPercent: unknown; takeProfitPercent: unknown; trailingStopPercent: unknown; maxSlippagePercent: unknown } | null): BacktestConfig {
  return {
    initialEquity: initialBalance,
    feeBps: 30,
    slippagePercent: numeric(risk?.maxSlippagePercent, 0.5),
    executionDelayBars: 1,
    partialExitPercent: 0.5,
    stopLossPercent: numeric(risk?.stopLossPercent, 2),
    takeProfitPercent: numeric(risk?.takeProfitPercent, 4),
    trailingStopPercent: numeric(risk?.trailingStopPercent, 2),
    positionPercent: numeric(risk?.maxPositionPercent, 2),
  };
}

export async function runHistoricalBacktest(prisma: PrismaClient, userId: string, request: BacktestRequest) {
  const token = await prisma.token.findUnique({ where: { address: request.tokenAddress } });
  if (!token) throw new Error('Token not found');
  const strategyConfig = await prisma.strategyConfig.findUnique({ where: { userId_strategyName: { userId, strategyName: request.strategyName } } });
  const strategy = createConfiguredStrategy(request.strategyName, (strategyConfig?.params as Record<string, unknown> | null) ?? {}) as Strategy | null;
  if (!strategy) throw new Error('Unsupported strategy');

  const [metrics, risks, riskConfig] = await Promise.all([
    prisma.tokenMetric.findMany({ where: { tokenId: token.id, timestamp: { gte: request.startDate, lte: request.endDate }, priceUsd: { not: null } }, orderBy: { timestamp: 'asc' } }),
    prisma.riskAssessment.findMany({ where: { tokenId: token.id, createdAt: { lte: request.endDate }, OR: [{ userId }, { userId: null }] }, orderBy: { createdAt: 'asc' } }),
    prisma.riskConfig.findUnique({ where: { userId } }),
  ]);
  if (metrics.length < 2) throw new Error('At least two historical market observations are required');

  const bars = toHistoricalBars(metrics).map((bar) => ({ ...bar, token: token.address }));
  const engine = new HistoricalBacktestEngine(buildConfig(request.initialBalance, riskConfig));
  const riskAt = (timestamp: Date) => {
    let current = risks[0];
    for (const assessment of risks) {
      if (assessment.createdAt.getTime() > timestamp.getTime()) break;
      current = assessment;
    }
    return current;
  };
  const evaluator = ({ current, history }: { current: HistoricalBar; history: readonly HistoricalBar[] }) => {
    const currentIndex = metrics.findIndex((metric) => metric.timestamp.getTime() === current.timestamp.getTime());
    const metric = metrics[currentIndex];
    const risk = riskAt(current.timestamp);
    const riskScore = numeric(risk?.riskScore, 100);
    if (risk?.decision === 'REJECT') return { action: 'REJECT' as const, score: 0, riskScore, strategy: strategy.name, reasons: ['Historical risk assessment rejected this observation.'] };
    const currentSnapshot = {
      metadata: { address: token.address, symbol: token.symbol }, timestamp: current.timestamp,
      priceUsd: numeric(metric.priceUsd), liquidityUsd: numeric(metric.liquidityUsd), volume24h: numeric(metric.volume24h),
      buyCount24h: metric.buyCount24h ?? undefined, sellCount24h: metric.sellCount24h ?? undefined,
      priceChange1h: currentIndex > 0 && numeric(metrics[currentIndex - 1].priceUsd) > 0 ? (numeric(metric.priceUsd) - numeric(metrics[currentIndex - 1].priceUsd)) / numeric(metrics[currentIndex - 1].priceUsd) * 100 : undefined,
      provider: 'historical-database',
    };
    const historical = history.map((bar, index) => {
      const row = metrics[Math.max(0, currentIndex - index)];
      return { timestamp: bar.timestamp, priceUsd: numeric(row?.priceUsd), volume24h: numeric(row?.volume24h), liquidityUsd: numeric(row?.liquidityUsd), buyCount24h: row?.buyCount24h ?? undefined, sellCount24h: row?.sellCount24h ?? undefined };
    });
    const signal = strategy.evaluate(buildStrategyMarketData(token.address, currentSnapshot, historical, riskScore), { hasOpenPosition: false });
    return { action: signal.recommendedAction, score: signal.score, riskScore: signal.riskScore, strategy: signal.strategy, reasons: signal.reasons };
  };

  const results = request.walkForward
    ? engine.walkForward(bars, evaluator, request.walkForward.trainingBars, request.walkForward.validationBars, request.walkForward.outOfSampleBars)
    : [engine.run(bars, evaluator, 'OUT_OF_SAMPLE')];
  return { token, strategy, results, configuration: { ...buildConfig(request.initialBalance, riskConfig), startDate: request.startDate, endDate: request.endDate, walkForward: request.walkForward ?? null } };
}

export function serializeBacktestResult(result: BacktestResult) {
  return {
    split: result.split,
    metrics: result.metrics,
    trades: result.trades,
    equityCurve: result.equityCurve,
  };
}
