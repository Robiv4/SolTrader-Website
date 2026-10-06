/**
 * Background NewLaunch optimization run (per user, PAPER only). Results are persisted and cached; the
 * Analytics page only reads completed runs. Recommendations are stored as PENDING and are never applied
 * without an explicit user action (which creates a new PAPER config version).
 */
import { Prisma } from '@prisma/client';
import { exitParameterGrid, optimizeEntryFilters, PAPER_FEE_BPS, type ExitSimulationTrade } from '@soltrader/trading-engine';

import { prisma } from './database.js';
import { loadLaunchTrades, toOptimizerTrades, type AnalysisScope } from './new-launch-analytics.js';
import { loadNewLaunchSettings } from './new-launch-config.js';
import { priceSeries } from './position-detail.js';

const SL_GRID = [10, 12, 15, 18, 20, 25];
const TP_GRID = [15, 20, 25, 30, 35, 50];
const BREAK_EVEN_GRID = [5, 8, 10, 12, 15];
const TRAIL_ACTIVATION_GRID = [10, 12, 15, 20, 25];
const TRAIL_DISTANCE_GRID = [5, 8, 10, 12, 15];
/** How far after the actual exit stored prices are used, so wider targets can still be evaluated. */
const POST_EXIT_WINDOW_MS = 30 * 60_000;
const RUNNING_TIMEOUT_MS = 10 * 60_000;

export async function startOptimizationRun(userId: string, scope: AnalysisScope, logger: { error: (payload: unknown, message: string) => void }) {
  const running = await prisma.newLaunchOptimizationRun.findFirst({ where: { userId, status: 'RUNNING', startedAt: { gte: new Date(Date.now() - RUNNING_TIMEOUT_MS) } } });
  if (running) return { run: running, alreadyRunning: true };
  const run = await prisma.newLaunchOptimizationRun.create({ data: { userId, status: 'RUNNING', scope: scope as unknown as Prisma.InputJsonValue } });
  // Runs after the response; failures are recorded on the run.
  globalThis.setTimeout(() => {
    void executeRun(run.id, userId, scope).catch(async (error: unknown) => {
      logger.error({ err: error, runId: run.id }, 'NewLaunch optimization run failed');
      await prisma.newLaunchOptimizationRun.update({ where: { id: run.id }, data: { status: 'FAILED', error: error instanceof Error ? error.message.slice(0, 500) : 'unknown error', completedAt: new Date() } }).catch(() => undefined);
    });
  }, 0);
  return { run, alreadyRunning: false };
}

export async function executeRun(runId: string, userId: string, scope: AnalysisScope) {
  const { settings } = await loadNewLaunchSettings(userId);
  const rows = await loadLaunchTrades(userId, scope, settings.configVersion);
  const entry = optimizeEntryFilters(toOptimizerTrades(rows), {
    minScore: settings.minScore, minUniqueBuyers: settings.minUniqueBuyers, minLiquidityUsd: settings.minLiquidityUsd,
    minBuySellRatio: settings.minBuySellRatio, maxExhaustionScore: settings.maxExhaustionScore, maxPriceImpactPercent: settings.maxPriceImpactPercent,
    maxAgeSeconds: settings.maxAgeSeconds, maxRiskScore: settings.maxRiskScore,
    'qualityGate.minDataQuality': settings.qualityGate.minDataQuality,
    'qualityGate.maxHolderConcentrationPercent': settings.qualityGate.maxHolderConcentrationPercent,
    'qualityGate.maxDevAllocationPercent': settings.qualityGate.maxDevAllocationPercent,
  }, { minimumSampleSize: settings.minimumRecommendationSampleSize, trainFraction: 0.7, minimumRetention: 0.25, minimumKeptTrades: 10, walkForwardFolds: 3 });

  // Exit parameter simulation on real stored price paths (entry fill as reference, costs included).
  const simulationTrades: ExitSimulationTrade[] = [];
  for (const row of rows.slice(0, 300)) {
    if (!row.entryPrice || !row.quantity) continue;
    const points = await priceSeries(row.tokenId, row.tokenAddress, new Date(row.entryAt), new Date(row.closedAt + POST_EXIT_WINDOW_MS), 3_000);
    if (points.length < 3) continue;
    simulationTrades.push({
      id: row.id, actualNetPnl: row.netPnl, diagnosis: row.diagnosis, entryAt: row.entryAt, entryPrice: row.entryPrice, quantity: row.quantity, path: points, feeBps: PAPER_FEE_BPS,
      exitSlippagePercent: Math.max(0, row.exitSlippage ?? row.entrySlippage ?? 0.5),
    });
  }
  const current = settings;
  const slTpGrid = exitParameterGrid(simulationTrades, SL_GRID, TP_GRID, (sl, tp) => ({
    stopLossPercent: sl, takeProfitPercent: tp,
    breakEvenActivationPercent: current.breakEvenEnabled ? current.breakEvenActivationPercent : null,
    trailingActivationPercent: current.trailingEnabled ? current.trailingActivationPercent : null,
    trailingDistancePercent: current.trailingEnabled ? current.trailingDistancePercent : null,
  }));
  const trailingGrid = exitParameterGrid(simulationTrades, TRAIL_ACTIVATION_GRID, TRAIL_DISTANCE_GRID, (activation, distance) => ({
    stopLossPercent: current.stopLossPercent, takeProfitPercent: current.takeProfitPercent,
    breakEvenActivationPercent: current.breakEvenEnabled ? current.breakEvenActivationPercent : null,
    trailingActivationPercent: activation, trailingDistancePercent: distance,
  }));

  // Break-even activation (single dimension; the y-axis is the current trailing distance only for display).
  const breakEvenGrid = exitParameterGrid(simulationTrades, BREAK_EVEN_GRID, [current.stopLossPercent], (activation) => ({
    stopLossPercent: current.stopLossPercent, takeProfitPercent: current.takeProfitPercent,
    breakEvenActivationPercent: activation,
    trailingActivationPercent: current.trailingEnabled ? current.trailingActivationPercent : null,
    trailingDistancePercent: current.trailingEnabled ? current.trailingDistancePercent : null,
  }));
  // Resolution of the stored paths used by the simulation (median gap between stored observations).
  const gaps = simulationTrades.flatMap((trade) => trade.path.slice(1).map((point, index) => point.t - trade.path[index].t)).sort((a, b) => a - b);
  const medianGapMs = gaps.length ? gaps[Math.floor(gaps.length / 2)] : null;
  const result = {
    label: 'HISTORICAL SIMULATION — NOT FUTURE PERFORMANCE',
    configVersion: settings.configVersion,
    sampleSize: rows.length,
    entry: { sufficientData: entry.sufficientData, minimumSampleSize: entry.minimumSampleSize, trainSize: 'trainSize' in entry ? entry.trainSize : null, validationSize: 'validationSize' in entry ? entry.validationSize : null },
    exit: {
      simulatedTrades: simulationTrades.length,
      policy: 'Only stored, timestamped prices; replayed through the live Exit Engine. AMBIGUOUS_EVENT_ORDER (both a stop-side level and the take profit inside one unresolved interval), LOW_RESOLUTION (exit after a > 60 s gap) and NO_EXIT_IN_DATA results are excluded from the metrics.',
      current: { stopLossPercent: current.stopLossPercent, takeProfitPercent: current.takeProfitPercent, breakEvenActivationPercent: current.breakEvenEnabled ? current.breakEvenActivationPercent : null, trailingActivationPercent: current.trailingActivationPercent, trailingDistancePercent: current.trailingDistancePercent },
      slTpGrid: { xLabel: 'Stop Loss %', yLabel: 'Take Profit %', xs: SL_GRID, ys: TP_GRID, cells: slTpGrid },
      trailingGrid: { xLabel: 'Követő stop aktiválás %', yLabel: 'Követő stop távolság %', xs: TRAIL_ACTIVATION_GRID, ys: TRAIL_DISTANCE_GRID, cells: trailingGrid },
      breakEvenGrid: { xLabel: 'Break-even aktiválás %', yLabel: 'Stop Loss % (jelenlegi)', xs: BREAK_EVEN_GRID, ys: [current.stopLossPercent], cells: breakEvenGrid },
      pathResolution: { medianGapMs, warning: medianGapMs !== null && medianGapMs > 10_000 ? 'A tárolt árfolyam-út ritka (medián rés > 10 mp): a szimuláció bizonytalan, a régi trade-ek a lassú kiértékelési ciklus idejéből valók.' : null },
    },
  };

  await prisma.$transaction(async (transaction) => {
    await transaction.newLaunchOptimizationRecommendation.updateMany({ where: { userId, status: 'PENDING' }, data: { status: 'SUPERSEDED', decidedAt: new Date() } });
    // Analysis-only features (no setting behind them) stay in the run result and are never stored as actionable.
    for (const recommendation of entry.recommendations.filter((item) => !item.analysisOnly)) {
      await transaction.newLaunchOptimizationRecommendation.create({ data: {
        userId, runId, parameter: recommendation.parameter,
        currentValue: recommendation.currentValue !== null ? new Prisma.Decimal(recommendation.currentValue) : null,
        suggestedValue: new Prisma.Decimal(recommendation.suggestedValue),
        sampleSize: recommendation.sampleSize, confidenceLevel: recommendation.confidenceLevel,
        trainingMetrics: recommendation.trainingMetrics as unknown as Prisma.InputJsonValue,
        validationMetrics: { ...recommendation.validationMetrics, walkForwardStability: recommendation.walkForwardStability, possibleOverfit: recommendation.possibleOverfit, poorEntryRejection: recommendation.poorEntryRejection } as unknown as Prisma.InputJsonValue,
        tradeRetention: new Prisma.Decimal(recommendation.tradeRetention),
        winnerRetention: recommendation.winnerRetention !== null ? new Prisma.Decimal(recommendation.winnerRetention) : null,
        loserRejection: recommendation.loserRejection !== null ? new Prisma.Decimal(recommendation.loserRejection) : null,
        reason: recommendation.reason, warnings: recommendation.warnings as Prisma.InputJsonValue,
      } });
    }
    await transaction.newLaunchOptimizationRun.update({ where: { id: runId }, data: { status: 'COMPLETED', sampleSize: rows.length, result: result as unknown as Prisma.InputJsonValue, completedAt: new Date() } });
  });
  return result;
}
