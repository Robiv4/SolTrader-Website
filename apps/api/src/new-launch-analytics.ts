/**
 * NewLaunch trade pattern analyzer (per user). Descriptive analytics are computed on request from stored
 * data; the expensive optimizer / exit-parameter simulation runs as a background job (see
 * new-launch-optimizer-job.ts) and is cached in NewLaunchOptimizationRun.
 *
 * Every value comes from what was recorded at the time: entry features and configuration from the entry
 * snapshot, price paths from stored market snapshots. Missing data stays null ("N/A"), never 0 / SAFE.
 */
import { Prisma } from '@prisma/client';
import { evaluateQualityGate, type QualityGateSettings } from '@soltrader/strategy-engine';
import {
  bucketPerformance,
  classifyTrade,
  distribution,
  pathMetricFromSeries,
  performanceStats,
  profitCaptureRatio,
  profitGivebackPercent,
  range,
  simulateEntryFilter,
  summarizePathMetric,
  type EntryFilterCondition,
  type OptimizerTrade,
  type PathMetricSummary,
  type TradeDiagnosis,
} from '@soltrader/trading-engine';

import { prisma } from './database.js';
import { buildExitForensics, EXIT_ANOMALY_THRESHOLDS } from './exit-forensics.js';
import { priceLiquiditySeries, priceSeries } from './position-detail.js';

type Json = Record<string, unknown>;
const record = (value: unknown): Json => (value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {});
const num = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'object' && value !== null && 'toNumber' in value ? (value as { toNumber(): number }).toNumber() : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const ms = (value: unknown): number | null => {
  if (!value) return null;
  const time = new Date(String(value)).getTime();
  return Number.isFinite(time) ? time : null;
};
const diff = (to: number | null, from: number | null) => (to !== null && from !== null ? to - from : null);

export interface AnalysisScope {
  /** 'current' (default) = active config version only, 'all' = every version, or a concrete version (NL-v3). */
  version: string;
  /** Last N closed trades, or 'all'. */
  sample: number | 'all';
}

export function parseScope(query: Record<string, unknown>): AnalysisScope {
  const version = typeof query.version === 'string' && /^(current|all|NL-v\d+)$/.test(query.version) ? query.version : 'current';
  const sampleRaw = String(query.sample ?? 'all');
  const sample = ['50', '100', '250'].includes(sampleRaw) ? Number(sampleRaw) : 'all';
  return { version, sample };
}

export type ExitGroup = 'STOP_LOSS' | 'TAKE_PROFIT' | 'TRAILING_STOP' | 'BREAK_EVEN' | 'LIQUIDITY_SAFETY' | 'MAX_HOLD_TIME' | 'MANUAL' | 'OTHER';

export interface LaunchTradeRow {
  id: string;
  positionId: string | null;
  tokenId: string;
  tokenAddress: string;
  symbol: string;
  entryAt: number;
  closedAt: number;
  netPnl: number;
  size: number;
  quantity: number;
  returnPercent: number;
  holdMs: number | null;
  exitReason: string | null;
  exitGroup: ExitGroup;
  configVersion: string;
  features: Record<string, number | null>;
  riskClassification: string | null;
  entryPrice: number | null;
  exitPrice: number | null;
  path: PathMetricSummary | null;
  pathSource: string | null;
  mfePercent: number | null;
  maePercent: number | null;
  captureRatio: number | null;
  givebackPercent: number | null;
  diagnosis: TradeDiagnosis;
  breakEvenAppliedAtMs: number | null;
  trailingActivatedAtMs: number | null;
  trailingActivationPrice: number | null;
  trailingFinalStop: number | null;
  highestPrice: number | null;
  trailingMonotonic: boolean | null;
  liquidityAtEntry: number | null;
  exitLiquidity: number | null;
  liquidityChangePercent: number | null;
  exitBuySellRatio: number | null;
  exitConfig: Json | null;
  qualityGate: { evaluated?: boolean; wouldPass?: boolean | null; reasons?: string[]; mode?: string; version?: number } | null;
  latency: { observationMs: number | null; securityMs: number | null; decisionMs: number | null; executionMs: number | null; totalMs: number | null; postObservationMs: number | null };
  /** Stored-data exit reconstruction (trigger vs fill, stops, costs, anomalies, primary cause). */
  forensics: ReturnType<typeof buildExitForensics> | null;
  prices: { detected: number | null; decision: number | null; requested: number | null; fill: number | null; exitTrigger: number | null; exitFill: number | null };
  fees: number;
  entrySlippage: number | null;
  exitSlippage: number | null;
  /** Market prices before impact (entry quote / exit fill reference). */
  entryMarketPrice: number | null;
  exitMarketPrice: number | null;
  /** Immutable exit-capacity entry snapshot (trades opened after the capacity engine was added). */
  capacityAtEntry: Json | null;
  exitCapacityAtTrigger: Json | null;
  /** Immutable social shadow snapshot at entry (null for trades before the Social Intelligence engine). */
  socialAtEntry: Json | null;
}

/** Exit reason groups used for NewLaunch analytics (the break-even stop is a raised stop loss). */
function exitGroup(exitReason: string | null, breakEvenApplied: boolean): ExitGroup {
  if (exitReason === 'BREAK_EVEN_STOP') return 'BREAK_EVEN';
  if (exitReason === 'STOP_LOSS') return breakEvenApplied ? 'BREAK_EVEN' : 'STOP_LOSS';
  if (exitReason === 'TAKE_PROFIT' || exitReason === 'TRAILING_STOP' || exitReason === 'MAX_HOLD_TIME') return exitReason;
  if (exitReason === 'LIQUIDITY_OUTFLOW' || exitReason === 'LIQUIDITY_SAFETY') return 'LIQUIDITY_SAFETY';
  if (exitReason === 'manual-close' || exitReason === 'MANUAL') return 'MANUAL';
  return 'OTHER';
}

/** Entry features as recorded at entry; older trades only have the fields stored at the time. */
function entryFeatures(launch: Json): Record<string, number | null> {
  const f = record(launch.entryFeatures);
  const pick = (...values: unknown[]) => {
    for (const value of values) {
      const parsed = num(value);
      if (parsed !== null) return parsed;
    }
    return null;
  };
  return {
    launchScore: pick(f.launchScore, launch.score),
    launchMomentumScore: pick(f.launchMomentumScore, launch.launchMomentumScore),
    exhaustionScore: pick(f.exhaustionScore, launch.exhaustionScore),
    dataQuality: pick(f.dataQuality, launch.dataQuality),
    tokenAgeSeconds: pick(f.tokenAgeSeconds, launch.ageSeconds),
    tradableAgeSeconds: pick(f.tradableAgeSeconds),
    liquidityUsd: pick(f.liquidityUsd, launch.liquidityUsd),
    marketCapUsd: pick(f.marketCapUsd),
    volumeUsd: pick(f.volumeUsd),
    uniqueBuyers: pick(f.uniqueBuyers, launch.uniqueBuyers),
    uniqueSellers: pick(f.uniqueSellers),
    buyCount: pick(f.buyCount),
    sellCount: pick(f.sellCount),
    buySellRatio: pick(f.buySellRatio, launch.buySellRatio),
    buyVolumeRatio: pick(f.buyVolumeRatio),
    transactionRate: pick(f.transactionRate),
    priceVelocity: pick(f.priceVelocity),
    volumeVelocity: pick(f.volumeVelocity),
    liquidityChangePercent: pick(f.liquidityChangePercent),
    priceImpactPercent: pick(f.priceImpactPercent, launch.priceImpactPercent),
    devAllocationPercent: pick(f.devAllocationPercent),
    holderConcentrationPercent: pick(f.topHolderConcentrationPercent),
    largestBuyerShare: pick(f.largestBuyerShare),
    // Execution-quality features from the exit-capacity entry snapshot (never a direction signal).
    exitCapacityScoreAtEntry: pick(record(record(launch.exitCapacity).atEntry).exitCapacityScore),
    estimatedExitImpactPct: pick(record(record(launch.exitCapacity).atEntry).estimatedImmediateSellImpactPct),
    liquidityUtilizationPct: pick(record(record(launch.exitCapacity).atEntry).liquidityUtilizationPct),
    roundTripImpactPct: pick(record(record(launch.exitCapacity).atEntry).estimatedRoundTripImpactPct),
    // Social shadow features at entry (deterministic; null when unavailable - never 0).
    socialScore: pick(record(launch.social).socialScore),
    socialMomentum: pick(record(launch.social).momentum),
    socialQuality: pick(record(launch.social).quality),
    socialSpam: pick(record(launch.social).spam),
    socialExhaustion: pick(record(launch.social).exhaustion),
    socialDataQuality: pick(record(launch.social).dataQuality),
    repeatBuyerConcentration: pick(f.repeatBuyerConcentration),
    riskScore: pick(f.riskScore),
    riskMultiplier: pick(f.riskMultiplier),
  };
}

const TRADE_LIMIT = 1_000;
const FORENSICS_LIMIT = 300;
const BACKFILL_LIMIT = 150;

/**
 * Loads the user's closed NewLaunch trades for the scope, attaching the real path metrics. Positions without
 * a live-tracked path are backfilled from stored timestamped snapshots when (and only when) enough exist.
 */
export async function loadLaunchTrades(userId: string, scope: AnalysisScope, currentVersion: string) {
  const trades = await prisma.trade.findMany({
    where: { userId, decisionSource: 'NEW_LAUNCH', status: 'CLOSED', netPnl: { not: null } },
    include: { position: { include: { pathMetric: true, events: { orderBy: { at: 'asc' } } } } },
    orderBy: { exitAt: 'desc' },
    take: TRADE_LIMIT,
  });
  let backfills = 0;
  const rows: LaunchTradeRow[] = [];
  for (const trade of trades) {
    const snapshot = record(trade.configSnapshot);
    const launch = record(snapshot.launch);
    const newLaunch = record(snapshot.newLaunch);
    const configVersion = String(newLaunch.configVersion ?? trade.position?.configVersion ?? 'NL-v1');
    if (scope.version === 'current' && configVersion !== currentVersion) continue;
    if (scope.version !== 'current' && scope.version !== 'all' && configVersion !== scope.version) continue;
    const entryAt = (trade.entryAt ?? trade.createdAt).getTime();
    const closedAt = (trade.exitAt ?? trade.updatedAt).getTime();
    const size = num(trade.size) ?? 0;
    const quantity = num(trade.quantity) ?? 0;
    const netPnl = num(trade.netPnl) ?? 0;
    const entryPrice = num(trade.entry);
    const position = trade.position;
    let pathSource: string | null = position?.pathMetric?.source ?? null;
    let summary: PathMetricSummary | null = null;
    if (position?.pathMetric && position.pathMetric.sampleCount > 0) {
      const metric = position.pathMetric;
      summary = {
        maxPriceAfterEntry: num(metric.maxPriceAfterEntry), minPriceAfterEntry: num(metric.minPriceAfterEntry), mfePercent: num(metric.mfePercent), mfeUsd: num(metric.mfeUsd),
        timeToMfeMs: metric.timeToMfeMs, maePercent: num(metric.maePercent), maeUsd: num(metric.maeUsd), timeToMaeMs: metric.timeToMaeMs,
        milestones: record(metric.milestones) as Record<string, number>,
        liquidityChangePercent: num(metric.liquidityAtEntry) && num(metric.lastLiquidityUsd) ? (num(metric.lastLiquidityUsd)! / num(metric.liquidityAtEntry)! - 1) * 100 : null,
        sampleCount: metric.sampleCount,
      };
    } else if (position && entryPrice && backfills < BACKFILL_LIMIT) {
      // Backfill only from real stored snapshots between entry and exit; otherwise stays null (N/A).
      backfills += 1;
      const points = await priceSeries(trade.tokenId, trade.tokenAddress, new Date(entryAt), new Date(closedAt), 2_000);
      const state = pathMetricFromSeries(points, entryPrice, entryAt, closedAt, quantity, num(position.entryLiquidityUsd));
      if (state) {
        summary = summarizePathMetric(state);
        pathSource = 'SNAPSHOT_BACKFILL';
        const decimal = (value: number | null) => (value === null ? null : new Prisma.Decimal(value));
        await prisma.positionPathMetric.upsert({
          where: { positionId: position.id },
          update: {},
          create: {
            positionId: position.id, userId, decisionSource: 'NEW_LAUNCH', configVersion, entryPrice: new Prisma.Decimal(entryPrice), entryAt: new Date(entryAt), quantity: new Prisma.Decimal(quantity),
            maxPriceAfterEntry: decimal(summary.maxPriceAfterEntry), minPriceAfterEntry: decimal(summary.minPriceAfterEntry), mfePercent: decimal(summary.mfePercent), mfeUsd: decimal(summary.mfeUsd),
            timeToMfeMs: summary.timeToMfeMs, maePercent: decimal(summary.maePercent), maeUsd: decimal(summary.maeUsd), timeToMaeMs: summary.timeToMaeMs,
            milestones: summary.milestones as Prisma.InputJsonValue, liquidityAtEntry: decimal(num(position.entryLiquidityUsd)), sampleCount: summary.sampleCount, source: 'SNAPSHOT_BACKFILL',
          },
        }).catch(() => undefined);
      }
    }
    const returnPercent = size > 0 ? netPnl / size * 100 : 0;
    const holdMs = trade.exitAt && trade.entryAt ? trade.exitAt.getTime() - trade.entryAt.getTime() : null;
    const breakEvenAppliedAtMs = position?.breakEvenAppliedAt ? position.breakEvenAppliedAt.getTime() : null;
    const moves = (position?.events ?? []).filter((event) => event.type === 'TRAILING_MOVED').map((event) => ({ from: num(record(event.details).from), to: num(record(event.details).to) }));
    const monotonic = moves.length ? moves.every((move, index) => (move.to ?? 0) >= (move.from ?? 0) && (index === 0 || (move.to ?? 0) >= (moves[index - 1].to ?? 0))) : null;
    const mfe = summary?.mfePercent ?? null;
    const exitDiagnostics = record(trade.exitDiagnostics);
    const exitMarket = num(trade.exitMarketPrice);
    const exitPrice = num(trade.exit);
    // Forensics from stored data only (stored price/liquidity points around the holding period).
    const forensics = position && rows.length < FORENSICS_LIMIT
      ? buildExitForensics({ position, trade, events: position.events, pathMetric: position.pathMetric, series: await priceLiquiditySeries(trade.tokenId, trade.tokenAddress, new Date(entryAt - 5_000), new Date(closedAt + 5_000)) })
      : null;
    rows.push({
      id: trade.id,
      positionId: trade.positionId,
      tokenId: trade.tokenId,
      tokenAddress: trade.tokenAddress,
      symbol: trade.symbol,
      entryAt,
      closedAt,
      netPnl,
      size,
      quantity,
      returnPercent,
      holdMs,
      exitReason: trade.exitReason,
      // Grouped by the stop that actually set the effective protective stop (legacy precedence mislabels are corrected).
      exitGroup: exitGroup(forensics?.exit.effectiveReason ?? trade.exitReason, breakEvenAppliedAtMs !== null),
      forensics,
      configVersion,
      features: entryFeatures(launch),
      riskClassification: trade.riskClassification,
      entryPrice,
      exitPrice,
      path: summary,
      pathSource,
      mfePercent: mfe,
      maePercent: summary?.maePercent ?? null,
      captureRatio: profitCaptureRatio(returnPercent, mfe),
      givebackPercent: profitGivebackPercent(returnPercent, mfe),
      diagnosis: classifyTrade({ netPnl, realizedReturnPercent: returnPercent, mfePercent: mfe, maePercent: summary?.maePercent ?? null, timeToMaeMs: summary?.timeToMaeMs ?? null, holdMs, exitReason: trade.exitReason }),
      breakEvenAppliedAtMs,
      trailingActivatedAtMs: position?.trailingActivatedAt ? position.trailingActivatedAt.getTime() : null,
      trailingActivationPrice: num(position?.trailingActivationPrice),
      trailingFinalStop: num(position?.trailingTriggerPrice),
      highestPrice: num(position?.highestPrice),
      trailingMonotonic: monotonic,
      liquidityAtEntry: num(position?.entryLiquidityUsd) ?? num(newLaunch.liquidityAtEntry),
      exitLiquidity: num(exitDiagnostics.liquidityUsd),
      entryMarketPrice: num(launch.requestedEntryPrice) ?? num(position?.entryMarketPrice),
      exitMarketPrice: num(exitDiagnostics.requestedExitPrice) ?? exitMarket,
      capacityAtEntry: Object.keys(record(launch.exitCapacity)).length ? record(launch.exitCapacity) : null,
      socialAtEntry: Object.keys(record(launch.social)).length ? record(launch.social) : null,
      exitCapacityAtTrigger: Object.keys(record(exitDiagnostics.exitCapacityAtTrigger)).length ? record(exitDiagnostics.exitCapacityAtTrigger) : null,
      liquidityChangePercent: summary?.liquidityChangePercent ?? (num(exitDiagnostics.liquidityUsd) && num(position?.entryLiquidityUsd) ? (num(exitDiagnostics.liquidityUsd)! / num(position?.entryLiquidityUsd)! - 1) * 100 : null),
      exitBuySellRatio: null,
      exitConfig: Object.keys(record(newLaunch.exitConfig)).length ? record(newLaunch.exitConfig) : null,
      qualityGate: Object.keys(record(newLaunch.qualityGate ?? launch.qualityGate)).length ? record(newLaunch.qualityGate ?? launch.qualityGate) as LaunchTradeRow['qualityGate'] : null,
      latency: (() => {
        const detected = ms(launch.detectedAt);
        const observationStart = ms(launch.observationStartedAt);
        const observationDone = ms(launch.observationCompletedAt);
        const securityDone = ms(launch.securityCompletedAt);
        const decisionAt = ms(launch.decisionAt);
        const fillAt = ms(launch.fillAt);
        const ready = observationDone !== null && securityDone !== null ? Math.max(observationDone, securityDone) : observationDone ?? securityDone;
        return {
          observationMs: diff(observationDone, observationStart ?? detected),
          securityMs: diff(securityDone, detected),
          decisionMs: diff(decisionAt, ready),
          executionMs: diff(fillAt, decisionAt),
          totalMs: diff(fillAt, detected),
          // Infrastructure latency after the configured observation window (the metric used for buckets).
          postObservationMs: diff(fillAt, observationDone),
        };
      })(),
      prices: {
        detected: num(launch.detectedPrice),
        decision: num(launch.decisionPrice),
        requested: num(launch.requestedEntryPrice),
        fill: num(launch.simulatedFillPrice) ?? entryPrice,
        exitTrigger: num(exitDiagnostics.triggerLevel) ?? exitMarket,
        exitFill: exitPrice,
      },
      fees: num(trade.fees) ?? 0,
      entrySlippage: num(launch.fillSlippagePercent),
      exitSlippage: exitMarket && exitPrice ? (1 - exitPrice / exitMarket) * 100 : null,
    });
  }
  rows.sort((a, b) => b.closedAt - a.closedAt);
  const limited = scope.sample === 'all' ? rows : rows.slice(0, scope.sample);
  await attachExitMarketState(limited);
  return limited;
}

/** Buy/sell ratio and liquidity at exit from the last stored launch snapshot before the exit. */
async function attachExitMarketState(rows: LaunchTradeRow[]) {
  const losers = rows.filter((row) => row.netPnl <= 0).slice(0, 100);
  for (const row of losers) {
    const snapshot = await prisma.launchSnapshot.findFirst({ where: { candidate: { mint: row.tokenAddress }, takenAt: { gte: new Date(row.entryAt), lte: new Date(row.closedAt) } }, orderBy: { takenAt: 'desc' }, select: { buyCount: true, sellCount: true, liquidityUsd: true } }).catch(() => null);
    if (!snapshot) continue;
    if (snapshot.buyCount !== null && snapshot.sellCount !== null) row.exitBuySellRatio = snapshot.sellCount > 0 ? snapshot.buyCount / snapshot.sellCount : null;
    if (row.exitLiquidity === null) row.exitLiquidity = num(snapshot.liquidityUsd);
  }
}

// ---------------------------------------------------------------------------------------------

const perf = (rows: LaunchTradeRow[]) => performanceStats(rows.map((row) => ({ netPnl: row.netPnl, closedAt: row.closedAt, mfePercent: row.mfePercent, maePercent: row.maePercent, holdMs: row.holdMs, captureRatio: row.captureRatio })));
const bucket = (rows: LaunchTradeRow[], value: (row: LaunchTradeRow) => number | null, buckets: Array<{ label: string; test: (value: number) => boolean }>) =>
  bucketPerformance(rows.map((row) => ({ ...row, netPnl: row.netPnl, closedAt: row.closedAt, captureRatio: row.captureRatio })), value, buckets);

const COMPARE_METRICS: Array<[string, (row: LaunchTradeRow) => number | null]> = [
  ['launchScore', (row) => row.features.launchScore],
  ['launchMomentumScore', (row) => row.features.launchMomentumScore],
  ['exhaustionScore', (row) => row.features.exhaustionScore],
  ['tokenAgeSeconds', (row) => row.features.tokenAgeSeconds],
  ['liquidityUsd', (row) => row.features.liquidityUsd],
  ['uniqueBuyers', (row) => row.features.uniqueBuyers],
  ['buySellRatio', (row) => row.features.buySellRatio],
  ['buyVolumeRatio', (row) => row.features.buyVolumeRatio],
  ['priceImpactPercent', (row) => row.features.priceImpactPercent],
  ['holderConcentrationPercent', (row) => row.features.holderConcentrationPercent],
  ['devAllocationPercent', (row) => row.features.devAllocationPercent],
  ['entryLatencyMs', (row) => row.latency.postObservationMs],
  ['riskScore', (row) => row.features.riskScore],
  ['mfePercent', (row) => row.mfePercent],
  ['maePercent', (row) => row.maePercent],
  ['holdMs', (row) => row.holdMs],
];

const MILESTONE_LEVELS = [3, 5, 10, 15, 20, 25];

/**
 * EXIT SPEED: measured latency components, touches of exit levels, trigger-to-fill price deterioration, TP capture and
 * profit giveback. Only instrumented exits have latency / touch records; older exits contribute only path facts.
 */
function exitSpeedSummary(rows: LaunchTradeRow[]) {
  const speeds = rows.map((row) => row.forensics?.exitSpeed).filter((speed): speed is NonNullable<typeof speed> => Boolean(speed));
  const instrumented = speeds.filter((speed) => speed.instrumented);
  const latency = (pick: (value: NonNullable<(typeof speeds)[number]['latency']>) => number | null) => {
    const values = instrumented.map((speed) => (speed.latency ? pick(speed.latency) : null));
    return { median: distribution(values).median, p95: percentile(values, 0.95), count: values.filter((value) => typeof value === 'number').length };
  };
  const deterioration = instrumented.map((speed) => speed.triggerToFillDeteriorationPercent);
  const tpDeterioration = speeds.map((speed) => speed.tpTouchToFillDeteriorationPercent);
  const tpReached = rows.filter((row) => row.forensics && (row.forensics.exitSpeed.takeProfit.firstTouchedAt || row.forensics.exitSpeed.takeProfit.reachedByPathOnly));
  const tpLevelOf = (row: LaunchTradeRow) => row.forensics?.exitSpeed.takeProfit.level ?? null;
  const givebacks = rows.map((row) => row.givebackPercent);
  const qualityCounts: Record<string, number> = {};
  for (const row of rows) for (const quality of row.forensics?.exitQuality ?? []) qualityCounts[quality] = (qualityCounts[quality] ?? 0) + 1;
  return {
    closedTrades: rows.length,
    instrumentedTrades: instrumented.length,
    touches: {
      TAKE_PROFIT: speeds.filter((speed) => speed.touches.TAKE_PROFIT).length,
      STOP_LOSS: speeds.filter((speed) => speed.touches.STOP_LOSS).length,
      BREAK_EVEN_STOP: speeds.filter((speed) => speed.touches.BREAK_EVEN_STOP).length,
      TRAILING_STOP: speeds.filter((speed) => speed.touches.TRAILING_STOP).length,
    },
    marketEventToEvaluationMs: latency((value) => value.receiveToEvaluationLatencyMs),
    exitEvaluationDurationMs: latency((value) => value.exitEvaluationDurationMs),
    triggerToExecutionRequestMs: latency((value) => value.triggerToExecutionRequestLatencyMs),
    executionRequestToFillMs: latency((value) => (value.executionRequestToStartLatencyMs !== null && value.executionStartToFillLatencyMs !== null ? value.executionRequestToStartLatencyMs + value.executionStartToFillLatencyMs : null)),
    triggerToFillMs: latency((value) => value.triggerToFillLatencyMs),
    marketEventToFillMs: latency((value) => value.marketEventToFillLatencyMs),
    triggerToFillDeterioration: { average: distribution(deterioration).average, median: distribution(deterioration).median, p95Adverse: percentile(deterioration, 0.05), count: distribution(deterioration).count },
    tpTouchToFillDeterioration: { average: distribution(tpDeterioration).average, median: distribution(tpDeterioration).median, count: distribution(tpDeterioration).count },
    tpCapture: {
      reached: tpReached.length,
      touchRecorded: tpReached.filter((row) => row.forensics?.exitSpeed.takeProfit.firstTouchedAt).length,
      reachedByPathOnly: tpReached.filter((row) => row.forensics?.exitSpeed.takeProfit.reachedByPathOnly).length,
      exitedAtOrAboveTp: tpReached.filter((row) => tpLevelOf(row) !== null && row.exitPrice !== null && row.exitPrice >= tpLevelOf(row)!).length,
      exitedBelowTp: tpReached.filter((row) => tpLevelOf(row) !== null && row.exitPrice !== null && row.exitPrice < tpLevelOf(row)!).length,
      closedNegative: tpReached.filter((row) => row.netPnl <= 0).length,
    },
    profitGiveback: { p50: percentile(givebacks, 0.5), p75: percentile(givebacks, 0.75), p95: percentile(givebacks, 0.95), count: givebacks.filter((value) => typeof value === 'number').length },
    qualityCounts,
  };
}

function percentile(values: Array<number | null | undefined>, q: number) {
  const known = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value)).sort((a, b) => a - b);
  if (!known.length) return null;
  return known[Math.min(known.length - 1, Math.floor((known.length - 1) * q))];
}

export function buildLaunchAnalytics(rows: LaunchTradeRow[], currentGate: QualityGateSettings) {
  const winners = rows.filter((row) => row.netPnl > 0);
  const losers = rows.filter((row) => row.netPnl <= 0);
  const withPath = rows.filter((row) => row.path !== null);

  const profitReachedButLost = MILESTONE_LEVELS.map((level) => {
    const reached = withPath.filter((row) => row.path!.milestones[`+${level}`] !== undefined);
    const lost = reached.filter((row) => row.netPnl <= 0);
    return {
      level, reached: reached.length, closedNegative: lost.length, share: reached.length ? lost.length / reached.length * 100 : null,
      medianMfePercent: distribution(lost.map((row) => row.mfePercent)).median,
      medianFinalReturnPercent: distribution(lost.map((row) => row.returnPercent)).median,
      medianGivebackPp: distribution(lost.map((row) => row.givebackPercent)).median,
    };
  });

  // Every GOOD_ENTRY_BAD_EXIT trade with its full stored-data reconstruction.
  const forensicSummary = (row: LaunchTradeRow) => ({
    id: row.id, positionId: row.positionId, symbol: row.symbol, tokenAddress: row.tokenAddress, closedAt: new Date(row.closedAt).toISOString(), diagnosis: row.diagnosis,
    netPnl: row.netPnl, mfePercent: row.mfePercent, realizedReturnPercent: row.returnPercent, givebackPercentagePoints: row.givebackPercent,
    breakEvenActivated: row.forensics?.breakEven.activated ?? row.breakEvenAppliedAtMs !== null, breakEvenActivatedAt: row.forensics?.breakEven.activatedAt ?? null,
    trailingActivated: row.forensics?.trailing.activated ?? row.trailingActivatedAtMs !== null, trailingActivatedAt: row.forensics?.trailing.activatedAt ?? null,
    highestPrice: row.forensics?.highestPrice ?? row.highestPrice, effectiveStop: row.forensics?.effectiveStop ?? null,
    triggerPrice: row.forensics?.exit.triggerPrice ?? null, requestedExitPrice: row.forensics?.exit.requestedExitPrice ?? null, fillPrice: row.forensics?.exit.fillPrice ?? row.exitPrice,
    triggerGapPercent: row.forensics?.exit.triggerGapPercent ?? null, exitSlippagePercent: row.forensics?.exit.exitSlippagePercent ?? row.exitSlippage,
    evaluationGapMs: row.forensics?.exit.evaluationGapMs ?? null, exitExecutionLatencyMs: row.forensics?.exit.exitExecutionLatencyMs ?? null,
    liquidityChangePercent: row.forensics?.liquidity.changePercent ?? row.liquidityChangePercent, recordedReason: row.forensics?.exit.recordedReason ?? row.exitReason,
    effectiveReason: row.forensics?.exit.effectiveReason ?? row.exitReason, anomalies: row.forensics?.anomalies ?? [], primaryCause: row.forensics?.primaryCause ?? 'INSUFFICIENT_DATA',
    pathDataQuality: row.forensics?.pathDataQuality ?? 'INSUFFICIENT_PRICE_PATH_DATA',
    exitQuality: row.forensics?.exitQuality ?? ['INSUFFICIENT_DATA'],
    triggerToFillMs: row.forensics?.exitSpeed.latency?.triggerToFillLatencyMs ?? null,
    tpFirstTouchPrice: row.forensics?.exitSpeed.takeProfit.firstTouchPrice ?? null,
  });
  const goodEntryBadExit = rows.filter((row) => row.diagnosis === 'GOOD_ENTRY_BAD_EXIT').map(forensicSummary);
  const suspiciousExits = rows.filter((row) => (row.forensics?.anomalies.length ?? 0) > 0).map(forensicSummary);

  // Data integrity checks before trusting any optimisation result.
  const positionIds = rows.map((row) => row.positionId).filter((id): id is string => Boolean(id));
  const now = Date.now();
  const dataIntegrity = {
    duplicateTradesPerPosition: positionIds.length - new Set(positionIds).size,
    invalidPrices: rows.filter((row) => !(row.entryPrice && row.entryPrice > 0) || !(row.exitPrice && row.exitPrice > 0)).length,
    futureTimestamps: rows.filter((row) => row.closedAt > now + 60_000 || row.entryAt > now + 60_000).length,
    exitBeforeEntry: rows.filter((row) => row.closedAt < row.entryAt).length,
    mfeBelowRealizedReturn: rows.filter((row) => row.forensics?.anomalies.includes('MFE_BELOW_REALIZED_RETURN')).length,
    maeAboveRealizedReturn: rows.filter((row) => row.forensics?.anomalies.includes('MAE_ABOVE_REALIZED_RETURN')).length,
    mislabeledExitReasons: rows.filter((row) => row.forensics?.anomalies.includes('MISLABELED_EXIT_REASON')).length,
    trailingMovedDown: rows.filter((row) => row.trailingMonotonic === false).length,
    insufficientPathData: rows.filter((row) => row.forensics?.pathDataQuality === 'INSUFFICIENT_PRICE_PATH_DATA').length,
    thresholds: EXIT_ANOMALY_THRESHOLDS,
  };

  const within = (row: LaunchTradeRow, key: string, limitMs: number) => row.path?.milestones[key] !== undefined && row.path.milestones[key] <= limitMs;
  const slWithin = (limitMs: number) => rows.filter((row) => row.exitGroup === 'STOP_LOSS' && row.holdMs !== null && row.holdMs <= limitMs).length;
  const immediateFailure = {
    tradesWithPath: withPath.length,
    neverReached3: withPath.filter((row) => row.path!.milestones['+3'] === undefined).length,
    neverReached5: withPath.filter((row) => row.path!.milestones['+5'] === undefined).length,
    hitMinus5Within30s: withPath.filter((row) => within(row, '-5', 30_000)).length,
    hitMinus10Within60s: withPath.filter((row) => within(row, '-10', 60_000)).length,
    stopLossWithin: { '15s': slWithin(15_000), '30s': slWithin(30_000), '60s': slWithin(60_000), '120s': slWithin(120_000) },
  };

  const diagnosisCounts: Record<string, number> = {};
  for (const row of rows) diagnosisCounts[row.diagnosis] = (diagnosisCounts[row.diagnosis] ?? 0) + 1;

  const exitReasons = (['STOP_LOSS', 'TAKE_PROFIT', 'TRAILING_STOP', 'BREAK_EVEN', 'LIQUIDITY_SAFETY', 'MAX_HOLD_TIME', 'MANUAL', 'OTHER'] as const)
    .map((group) => ({ group, rows: rows.filter((row) => row.exitGroup === group) }))
    .filter((item) => item.rows.length)
    .map((item) => ({ group: item.group, ...perf(item.rows), averagePnl: item.rows.reduce((sum, row) => sum + row.netPnl, 0) / item.rows.length }));

  const stopLossDiagnostics = rows.filter((row) => row.exitGroup === 'STOP_LOSS').slice(0, 100).map((row) => ({
    id: row.id, positionId: row.positionId, symbol: row.symbol, mfePercent: row.mfePercent, maePercent: row.maePercent, timeToStopMs: row.holdMs,
    highestPriceBeforeStop: row.path?.maxPriceAfterEntry ?? row.highestPrice, breakEvenActivationReached: row.breakEvenAppliedAtMs !== null,
    trailingActivated: row.trailingActivatedAtMs !== null, liquidityChangePercent: row.liquidityChangePercent, entryPriceImpactPercent: row.features.priceImpactPercent, netPnl: row.netPnl,
  }));
  const takeProfitDiagnostics = rows.filter((row) => row.exitGroup === 'TAKE_PROFIT').slice(0, 100).map((row) => ({
    id: row.id, positionId: row.positionId, symbol: row.symbol, timeToTakeProfitMs: row.holdMs, maeBeforeTakeProfitPercent: row.maePercent, mfePercent: row.mfePercent, netPnl: row.netPnl,
  }));
  const trailingDiagnostics = rows.filter((row) => row.exitGroup === 'TRAILING_STOP').slice(0, 100).map((row) => ({
    id: row.id, positionId: row.positionId, symbol: row.symbol, mfePercent: row.mfePercent, activationPrice: row.trailingActivationPrice,
    activationAfterMs: row.trailingActivatedAtMs !== null ? row.trailingActivatedAtMs - row.entryAt : null, highestPrice: row.highestPrice, finalTrailingStop: row.trailingFinalStop,
    exitPrice: row.exitPrice, givebackFromHighPercent: row.highestPrice && row.exitPrice ? (1 - row.exitPrice / row.highestPrice) * 100 : null, captureRatio: row.captureRatio, neverMovedDown: row.trailingMonotonic,
  }));
  const breakEvenRows = rows.filter((row) => row.breakEvenAppliedAtMs !== null);
  const breakEvenDiagnostics = {
    activated: breakEvenRows.length,
    ...perf(breakEvenRows),
    trades: breakEvenRows.slice(0, 100).map((row) => ({
      id: row.id, positionId: row.positionId, symbol: row.symbol, activationAfterMs: row.breakEvenAppliedAtMs! - row.entryAt, exitGroup: row.exitGroup, netPnl: row.netPnl,
      // MFE after activation is known only when the peak was observed after the activation time.
      mfeAfterActivationPercent: row.path?.timeToMfeMs !== null && row.path?.timeToMfeMs !== undefined && row.path.timeToMfeMs >= row.breakEvenAppliedAtMs! - row.entryAt ? row.mfePercent : null,
    })),
  };

  const execution = {
    entrySlippagePercent: distribution(rows.map((row) => row.entrySlippage)),
    exitSlippagePercent: distribution(rows.map((row) => row.exitSlippage)),
    feesTotal: rows.reduce((sum, row) => sum + row.fees, 0),
    detectionToDecisionPriceChangePercent: distribution(rows.map((row) => (row.prices.detected && row.prices.decision ? (row.prices.decision / row.prices.detected - 1) * 100 : null))),
    decisionToFillPriceChangePercent: distribution(rows.map((row) => (row.prices.decision && row.prices.fill ? (row.prices.fill / row.prices.decision - 1) * 100 : null))),
    latency: {
      observationMs: distribution(rows.map((row) => row.latency.observationMs)),
      securityMs: distribution(rows.map((row) => row.latency.securityMs)),
      decisionMs: distribution(rows.map((row) => row.latency.decisionMs)),
      executionMs: distribution(rows.map((row) => row.latency.executionMs)),
      totalMs: distribution(rows.map((row) => row.latency.totalMs)),
      postObservationMs: distribution(rows.map((row) => row.latency.postObservationMs)),
    },
    // Exit timing: the gap between the last observation and the exit observation (evaluation cadence),
    // trigger -> paper fill, quote age at the exit, and exits made on stale data.
    exitSpeed: exitSpeedSummary(rows),
    exitEvaluationGapMs: distribution(rows.map((row) => row.forensics?.exit.evaluationGapMs)),
    exitEvaluationGapP95Ms: percentile(rows.map((row) => row.forensics?.exit.evaluationGapMs), 0.95),
    triggerToFillMs: distribution(rows.map((row) => row.forensics?.exit.exitExecutionLatencyMs)),
    triggerToFillP95Ms: percentile(rows.map((row) => row.forensics?.exit.exitExecutionLatencyMs), 0.95),
    exitQuoteAgeMs: distribution(rows.map((row) => row.forensics?.exit.marketDataAgeMs)),
    staleDataExits: rows.filter((row) => row.forensics?.exit.exitDataStale === true).length,
    exitTriggerGapPercent: distribution(rows.filter((row) => row.exitGroup !== 'TAKE_PROFIT').map((row) => row.forensics?.exit.triggerGapPercent)),
    byLatency: bucket(rows, (row) => row.latency.postObservationMs, [
      { label: '<1 mp', test: range(-Infinity, 1_000) }, { label: '1–3 mp', test: range(1_000, 3_000) }, { label: '3–5 mp', test: range(3_000, 5_000) },
      { label: '5–10 mp', test: range(5_000, 10_000) }, { label: '10+ mp', test: range(10_000, Infinity) },
    ]),
  };

  // Quality gate: what was recorded at entry, and a what-if of the CURRENT gate on the recorded entry features.
  const recordedGate = rows.filter((row) => row.qualityGate?.evaluated);
  const currentGateRows = rows.map((row) => ({ row, result: evaluateQualityGate({
    launchScore: row.features.launchScore, uniqueBuyers: row.features.uniqueBuyers, liquidityUsd: row.features.liquidityUsd, buySellRatio: row.features.buySellRatio,
    exhaustionScore: row.features.exhaustionScore, priceImpactPercent: row.features.priceImpactPercent, holderConcentrationPercent: row.features.holderConcentrationPercent,
    devAllocationPercent: row.features.devAllocationPercent, dataQuality: row.features.dataQuality,
  }, { ...currentGate, mode: currentGate.mode === 'OFF' ? 'MONITOR_ONLY' : currentGate.mode }) }));
  const qualityGate = {
    recorded: { evaluated: recordedGate.length, actual: perf(recordedGate), wouldPass: perf(recordedGate.filter((row) => row.qualityGate?.wouldPass)), wouldFail: perf(recordedGate.filter((row) => row.qualityGate?.wouldPass === false)) },
    currentGateWhatIf: {
      label: 'HISTORICAL SIMULATION — NOT FUTURE PERFORMANCE',
      gateVersion: currentGate.version,
      actual: perf(rows),
      wouldPass: perf(currentGateRows.filter((item) => item.result.wouldPass).map((item) => item.row)),
      removed: perf(currentGateRows.filter((item) => !item.result.wouldPass).map((item) => item.row)),
      failReasons: Object.entries(currentGateRows.flatMap((item) => item.result.reasons).reduce<Record<string, number>>((acc, reason) => ({ ...acc, [reason]: (acc[reason] ?? 0) + 1 }), {})).sort((a, b) => b[1] - a[1]),
    },
  };

  const versions = [...new Set(rows.map((row) => row.configVersion))];
  const riskScoreBuckets = [
    { label: '0–30', test: range(0, 30.0001) }, { label: '31–50', test: range(30.0001, 50.0001) }, { label: '51–70', test: range(50.0001, 70.0001) }, { label: '71–85', test: range(70.0001, 85.0001) }, { label: '86–100', test: range(85.0001, 101) },
  ];
  return {
    sampleSize: rows.length,
    summary: { ...perf(rows), tradesWithPath: withPath.length },
    winnerVsLoser: COMPARE_METRICS.map(([metric, value]) => ({ metric, winners: distribution(winners.map(value)), losers: distribution(losers.map(value)) })),
    diagnosisCounts,
    profitReachedButLost,
    immediateFailure,
    buckets: {
      launchScore: bucket(rows, (row) => row.features.launchScore, [{ label: '<60', test: range(-Infinity, 60) }, { label: '60–69', test: range(60, 70) }, { label: '70–79', test: range(70, 80) }, { label: '80–89', test: range(80, 90) }, { label: '90–100', test: range(90, Infinity) }]),
      tokenAge: bucket(rows, (row) => row.features.tokenAgeSeconds, [{ label: '0–5 mp', test: range(-Infinity, 5.0001) }, { label: '6–10 mp', test: range(5.0001, 10.0001) }, { label: '11–20 mp', test: range(10.0001, 20.0001) }, { label: '21–30 mp', test: range(20.0001, 30.0001) }, { label: '31–60 mp', test: range(30.0001, 60.0001) }, { label: '61–90 mp', test: range(60.0001, 90.0001) }, { label: '90+ mp', test: range(90.0001, Infinity) }]),
      liquidity: bucket(rows, (row) => row.features.liquidityUsd, [{ label: '<$5k', test: range(-Infinity, 5_000) }, { label: '$5k–10k', test: range(5_000, 10_000) }, { label: '$10k–20k', test: range(10_000, 20_000) }, { label: '$20k–50k', test: range(20_000, 50_000) }, { label: '$50k–100k', test: range(50_000, 100_000) }, { label: '$100k+', test: range(100_000, Infinity) }]),
      uniqueBuyers: bucket(rows, (row) => row.features.uniqueBuyers, [{ label: '<5', test: range(-Infinity, 5) }, { label: '5–9', test: range(5, 10) }, { label: '10–19', test: range(10, 20) }, { label: '20–49', test: range(20, 50) }, { label: '50+', test: range(50, Infinity) }]),
      buySellRatio: bucket(rows, (row) => row.features.buySellRatio, [{ label: '<1', test: range(-Infinity, 1) }, { label: '1–1,5', test: range(1, 1.5) }, { label: '1,5–2', test: range(1.5, 2) }, { label: '2–3', test: range(2, 3) }, { label: '3+', test: range(3, Infinity) }]),
      exhaustion: bucket(rows, (row) => row.features.exhaustionScore, [{ label: '0–20', test: range(-Infinity, 20.0001) }, { label: '21–40', test: range(20.0001, 40.0001) }, { label: '41–60', test: range(40.0001, 60.0001) }, { label: '61–80', test: range(60.0001, 80.0001) }, { label: '81–100', test: range(80.0001, Infinity) }]),
      priceImpact: bucket(rows, (row) => row.features.priceImpactPercent, [{ label: '<0,5%', test: range(-Infinity, 0.5) }, { label: '0,5–1%', test: range(0.5, 1) }, { label: '1–2%', test: range(1, 2) }, { label: '2–3%', test: range(2, 3) }, { label: '3%+', test: range(3, Infinity) }]),
      riskClass: ['LOW', 'MODERATE', 'HIGH', 'VERY_HIGH'].map((label) => ({ label, ...perf(rows.filter((row) => row.riskClassification === label)) })).filter((item) => item.trades > 0),
      riskScore: bucket(rows, (row) => row.features.riskScore, riskScoreBuckets),
    },
    exitReasons,
    goodEntryBadExit,
    suspiciousExits,
    dataIntegrity,
    stopLossDiagnostics,
    takeProfitDiagnostics,
    trailingDiagnostics,
    breakEvenDiagnostics,
    execution,
    qualityGate,
    configComparison: versions.map((version) => ({ version, ...perf(rows.filter((row) => row.configVersion === version)) })),
    trades: rows.slice(0, 250).map((row) => ({
      id: row.id, positionId: row.positionId, symbol: row.symbol, tokenAddress: row.tokenAddress, entryPrice: row.entryPrice, exitPrice: row.exitPrice, netPnl: row.netPnl,
      returnPercent: row.returnPercent, mfePercent: row.mfePercent, maePercent: row.maePercent, exitReason: row.exitReason, exitGroup: row.exitGroup, entryAgeSeconds: row.features.tokenAgeSeconds,
      launchScore: row.features.launchScore, holdMs: row.holdMs, closedAt: new Date(row.closedAt).toISOString(), configVersion: row.configVersion, diagnosis: row.diagnosis,
      captureRatio: row.captureRatio, givebackPercent: row.givebackPercent, pathSource: row.pathSource,
      // "Mi történt?" facts (diagnostic, not certainty); the UI renders them in Hungarian.
      facts: {
        neverExceededPercent: row.mfePercent, timeToExitMs: row.holdMs, stopHitFast: row.exitGroup === 'STOP_LOSS' && row.holdMs !== null && row.holdMs <= 60_000,
        liquidityChangePercent: row.liquidityChangePercent, entryBuySellRatio: row.features.buySellRatio, exitBuySellRatio: row.exitBuySellRatio,
        trailingActive: row.trailingActivatedAtMs !== null, breakEvenActive: row.breakEvenAppliedAtMs !== null, reachedMilestones: row.path ? Object.keys(row.path.milestones) : [],
      },
    })),
  };
}

// ---------------------------------------------------------------------------------------------
// Funnel + rejection reasons (from the user's own launch decisions)
// ---------------------------------------------------------------------------------------------

const REJECTION_MAP: Record<string, string> = {
  LIQUIDITY_BELOW_MINIMUM: 'LOW_LIQUIDITY', CRITICAL_LIQUIDITY: 'LOW_LIQUIDITY', PRICE_IMPACT_TOO_HIGH: 'HIGH_PRICE_IMPACT', PRICE_IMPACT_UNKNOWN: 'INSUFFICIENT_DATA',
  SELLABILITY_NOT_VERIFIED: 'SELLABILITY_UNKNOWN', SELLABILITY_FAILED: 'SELLABILITY_FAILED', MINT_AUTHORITY_ACTIVE: 'MINT_AUTHORITY', FREEZE_AUTHORITY_ACTIVE: 'FREEZE_AUTHORITY',
  HIGH_EARLY_SUPPLY_CONCENTRATION: 'HOLDER_CONCENTRATION', CREATOR_SELLING: 'DEV_ALLOCATION', LAUNCH_EXHAUSTED: 'HIGH_EXHAUSTION',
  UNIQUE_BUYERS_BELOW_MINIMUM: 'LOW_UNIQUE_BUYERS', UNIQUE_BUYERS_UNKNOWN: 'LOW_UNIQUE_BUYERS', BUY_SELL_RATIO_BELOW_MINIMUM: 'LOW_BUY_SELL_RATIO', LAUNCH_SCORE_BELOW_MINIMUM: 'LOW_LAUNCH_SCORE',
  RISK_SCORE_ABOVE_LAUNCH_MAXIMUM: 'HIGH_RISK', RISK_NOT_ASSESSED: 'INSUFFICIENT_DATA', LAUNCH_WINDOW_EXPIRED: 'EXPIRED_LAUNCH', INSUFFICIENT_LAUNCH_DATA: 'INSUFFICIENT_DATA',
  OBSERVATION_IN_PROGRESS: 'INSUFFICIENT_DATA', LAUNCH_TOO_YOUNG: 'INSUFFICIENT_DATA', SECURITY_CHECK_PENDING: 'INSUFFICIENT_DATA', TRANSACTIONS_BELOW_MINIMUM: 'INSUFFICIENT_DATA',
  LAUNCH_VOLUME_BELOW_MINIMUM: 'LOW_LAUNCH_VOLUME', CRITICAL_TOKEN_EXTENSION: 'TOKEN_EXTENSION', UNSUPPORTED_TRANSFER_RESTRICTION: 'TOKEN_EXTENSION', LIQUIDITY_ABOVE_MAXIMUM: 'HIGH_LIQUIDITY',
};

/**
 * Funnel stages in the order evaluateNewLaunch applies its checks: age / window, critical liquidity, hard security
 * blocks, creator selling (dev dump), sellability, observation / data quality, launch score, remaining entry
 * requirements and risk, then the PAPER buy. CREATOR_SELLING is a security-type rejection evaluated BEFORE the
 * score requirements, so it must not be counted as "Launch Score passed but risk rejected".
 */
const STAGES = ['detected', 'ageEligible', 'liquidityEligible', 'securityPassed', 'devNotSelling', 'sellabilityVerified', 'observationCompleted', 'launchScorePassed', 'riskApproved', 'paperBuy', 'winner'] as const;

function stageReached(decision: { decision: string; status: string; reasons: unknown }) {
  const reasons = new Set(Array.isArray(decision.reasons) ? decision.reasons.map(String) : []);
  const has = (...codes: string[]) => codes.some((code) => reasons.has(code));
  if (has('LAUNCH_TOO_YOUNG', 'LAUNCH_WINDOW_EXPIRED')) return 1;
  if (has('LIQUIDITY_BELOW_MINIMUM', 'CRITICAL_LIQUIDITY', 'LIQUIDITY_ABOVE_MAXIMUM')) return 2;
  if (decision.status === 'BLOCKED' || has('SECURITY_CHECK_PENDING', 'MINT_AUTHORITY_ACTIVE', 'FREEZE_AUTHORITY_ACTIVE', 'CRITICAL_TOKEN_EXTENSION')) return 3;
  if (has('CREATOR_SELLING')) return 4;
  if (has('SELLABILITY_NOT_VERIFIED', 'SELLABILITY_FAILED')) return 5;
  if (has('OBSERVATION_IN_PROGRESS', 'INSUFFICIENT_LAUNCH_DATA')) return 6;
  if (has('LAUNCH_SCORE_BELOW_MINIMUM', 'LAUNCH_EXHAUSTED')) return 7;
  return decision.decision === 'BUY' ? 9 : 8;
}

const timing = (values: Array<number | null>) => ({ ...distribution(values), p95: percentile(values, 0.95), max: (() => { const known = values.filter((value): value is number => typeof value === 'number'); return known.length ? Math.max(...known) : null; })() });

export async function launchFunnel(userId: string, sinceDays = 7) {
  const since = new Date(Date.now() - sinceDays * 86_400_000);
  const decisions = await prisma.launchDecision.findMany({ where: { userId, decisionAt: { gte: since } }, select: { mint: true, decision: true, status: true, reasons: true, qualityGateMode: true, qualityGateWouldPass: true, qualityGateReasons: true, detectedAt: true, decisionAt: true, securityCompletedAt: true }, orderBy: { decisionAt: 'asc' }, take: 50_000 });
  const trades = await prisma.trade.findMany({ where: { userId, decisionSource: 'NEW_LAUNCH', createdAt: { gte: since } }, select: { tokenAddress: true, netPnl: true, status: true, configSnapshot: true } });
  const best = new Map<string, number>();
  const latest = new Map<string, (typeof decisions)[number]>();
  for (const decision of decisions) {
    best.set(decision.mint, Math.max(best.get(decision.mint) ?? 0, stageReached(decision)));
    latest.set(decision.mint, decision);
  }
  const bought = new Set(trades.map((trade) => trade.tokenAddress));
  const won = new Set(trades.filter((trade) => num(trade.netPnl) !== null && num(trade.netPnl)! > 0).map((trade) => trade.tokenAddress));
  for (const mint of bought) best.set(mint, Math.max(best.get(mint) ?? 0, 10));
  for (const mint of won) best.set(mint, 11);
  const counts = STAGES.map((stage, index) => ({ stage, count: [...best.values()].filter((value) => value >= index + 1).length }));
  const detected = counts[0].count;
  const funnel = counts.map((item, index) => ({ ...item, conversionFromPrevious: index === 0 || !counts[index - 1].count ? null : item.count / counts[index - 1].count * 100, conversionFromDetected: detected ? item.count / detected * 100 : null }));
  // Rejection reasons of the final (latest) decision per launch that was not bought.
  const reasonCounts: Record<string, number> = {};
  let rejectedLaunches = 0;
  for (const [mint, decision] of latest) {
    if (bought.has(mint) || decision.decision === 'BUY') {
      if (decision.qualityGateMode === 'ENFORCE_PAPER' && decision.qualityGateWouldPass === false && !bought.has(mint)) {
        rejectedLaunches += 1;
        reasonCounts.QUALITY_GATE = (reasonCounts.QUALITY_GATE ?? 0) + 1;
      }
      continue;
    }
    rejectedLaunches += 1;
    const mapped = new Set((Array.isArray(decision.reasons) ? decision.reasons.map(String) : []).map((reason) => REJECTION_MAP[reason] ?? reason));
    for (const reason of mapped) reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;
  }
  // Paper-execution (risk / limits) rejections of NewLaunch BUY signals, by reason.
  const launchSignals = await prisma.signal.findMany({ where: { userId, strategyName: 'NewLaunchStrategy', createdAt: { gte: since } }, select: { id: true } });
  const signalIds = new Set(launchSignals.map((signal) => signal.id));
  const rejections = signalIds.size ? await prisma.auditLog.findMany({ where: { userId, action: { in: ['TRADE_REJECTED', 'HARD_BLOCK_TRIGGERED'] }, createdAt: { gte: since } }, select: { details: true }, take: 20_000 }) : [];
  const executionRejections: Record<string, number> = {};
  for (const row of rejections) {
    const details = record(row.details);
    if (!signalIds.has(String(details.signalId))) continue;
    for (const reason of Array.isArray(details.decisionReasons) ? details.decisionReasons.map(String) : ['UNKNOWN']) executionRejections[reason] = (executionRejections[reason] ?? 0) + 1;
  }
  if (executionRejections.NEW_LAUNCH_ALREADY_TRADED) reasonCounts.DUPLICATE_POSITION = executionRejections.NEW_LAUNCH_ALREADY_TRADED;

  // Launches that passed the Launch Score but got no BUY: what stopped them (their last decision's reasons).
  const afterScore: Record<string, number> = {};
  let afterScoreCount = 0;
  for (const [mint, decision] of latest) {
    if ((best.get(mint) ?? 0) !== 8) continue;
    afterScoreCount += 1;
    for (const reason of Array.isArray(decision.reasons) ? decision.reasons.map(String) : []) afterScore[reason] = (afterScore[reason] ?? 0) + 1;
  }

  // Why launches expired: the state of the launch right before its window ran out.
  const byMintDecisions = new Map<string, typeof decisions>();
  for (const decision of decisions) byMintDecisions.set(decision.mint, [...(byMintDecisions.get(decision.mint) ?? []), decision]);
  const expiryCauses: Record<string, number> = {};
  for (const list of byMintDecisions.values()) {
    const index = list.findIndex((decision) => Array.isArray(decision.reasons) && decision.reasons.includes('LAUNCH_WINDOW_EXPIRED'));
    if (index < 0) continue;
    const previous = list[index - 1];
    const reasons = new Set(previous && Array.isArray(previous.reasons) ? previous.reasons.map(String) : []);
    const cause = !previous ? 'DETECTED_TOO_LATE_OR_NO_PRIOR_DECISION'
      : reasons.has('OBSERVATION_IN_PROGRESS') || reasons.has('INSUFFICIENT_LAUNCH_DATA') ? 'OBSERVATION_NOT_FINISHED'
        : reasons.has('SECURITY_CHECK_PENDING') || reasons.has('RISK_NOT_ASSESSED') ? 'SECURITY_OR_RISK_DATA_PENDING'
          : reasons.has('SELLABILITY_NOT_VERIFIED') ? 'SELLABILITY_NOT_VERIFIED'
            : reasons.has('LIQUIDITY_BELOW_MINIMUM') ? 'LIQUIDITY_NEVER_REACHED_MINIMUM'
              : reasons.has('TRANSACTIONS_BELOW_MINIMUM') || reasons.has('UNIQUE_BUYERS_BELOW_MINIMUM') || reasons.has('LAUNCH_VOLUME_BELOW_MINIMUM') ? 'ACTIVITY_TOO_LOW'
                : reasons.has('LAUNCH_SCORE_BELOW_MINIMUM') ? 'LAUNCH_SCORE_TOO_LOW' : 'OTHER';
    expiryCauses[cause] = (expiryCauses[cause] ?? 0) + 1;
  }

  // Pipeline timing (measured timestamps only).
  const firstDecisions = [...byMintDecisions.values()].map((list) => list[0]);
  const traded = trades.map((trade) => record(record(trade.configSnapshot).launch));
  const at = (value: unknown) => (value ? new Date(String(value)).getTime() : null);
  const between = (a: number | null, b: number | null) => (a !== null && b !== null ? b - a : null);
  const pipelineTiming = {
    detectionToCandidateMs: timing(firstDecisions.map((decision) => decision.decisionAt.getTime() - decision.detectedAt.getTime())),
    detectionToSecurityMs: timing(firstDecisions.map((decision) => (decision.securityCompletedAt ? decision.securityCompletedAt.getTime() - decision.detectedAt.getTime() : null))),
    observationDurationMs: timing(traded.map((launch) => between(at(launch.observationStartedAt), at(launch.observationCompletedAt)))),
    observationToDecisionMs: timing(traded.map((launch) => between(at(launch.observationCompletedAt), at(launch.decisionAt)))),
    decisionToOrderMs: timing(traded.map((launch) => between(at(launch.decisionAt), at(launch.orderCreatedAt)))),
    orderToFillMs: timing(traded.map((launch) => between(at(launch.orderCreatedAt), at(launch.fillAt)))),
    detectionToFillMs: timing(traded.map((launch) => between(at(launch.detectedAt), at(launch.fillAt)))),
  };
  return {
    sinceDays,
    afterScoreBreakdown: { launches: afterScoreCount, reasons: Object.entries(afterScore).sort((a, b) => b[1] - a[1]) },
    executionRejections: Object.entries(executionRejections).sort((a, b) => b[1] - a[1]),
    expiryCauses: Object.entries(expiryCauses).sort((a, b) => b[1] - a[1]),
    pipelineTiming,
    funnel,
    rejectionReasons: Object.entries(reasonCounts).map(([reason, count]) => ({ reason, count, share: rejectedLaunches ? count / rejectedLaunches * 100 : null })).sort((a, b) => b.count - a.count),
    rejectedLaunches,
  };
}

// ---------------------------------------------------------------------------------------------
// Historical entry-filter simulation (on demand, cheap)
// ---------------------------------------------------------------------------------------------

export function toOptimizerTrades(rows: LaunchTradeRow[]): OptimizerTrade[] {
  return rows.map((row) => ({ id: row.id, netPnl: row.netPnl, closedAt: row.closedAt, mfePercent: row.mfePercent, maePercent: row.maePercent, holdMs: row.holdMs, features: row.features, diagnosis: row.diagnosis }));
}

export function simulateFilter(rows: LaunchTradeRow[], conditions: EntryFilterCondition[]) {
  return simulateEntryFilter(toOptimizerTrades(rows), conditions);
}
