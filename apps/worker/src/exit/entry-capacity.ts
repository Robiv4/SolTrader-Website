/**
 * NewLaunch entry: exit capacity + liquidity-aware (shadow or enforced) position sizing.
 * The capacity layer can only KEEP or REDUCE the risk-approved size; MONITOR_ONLY never changes the executed size.
 */
import type { ResolvedNewLaunchSettings } from '@soltrader/strategy-engine';
import {
  capacityCurve, DEFAULT_CAPACITY_CONFIG, evaluateExitCapacity, PAPER_FEE_BPS, planCapacitySizing, RollingPercentiles,
  type CapacityConfig, type CurveState, type ExitCapacityResult,
} from '@soltrader/trading-engine';

export function capacityConfigFrom(settings: ResolvedNewLaunchSettings): CapacityConfig {
  return {
    ...DEFAULT_CAPACITY_CONFIG,
    maxEntryImpactPct: settings.maxEstimatedEntryImpactPct,
    maxExitImpactPct: settings.maxEstimatedExitImpactPct,
    maxRoundTripImpactPct: settings.maxEstimatedRoundTripImpactPct,
    minExitCapacityScore: settings.minExitCapacityScore,
    maxLiquidityUtilizationPct: settings.maxLiquidityUtilizationPct,
    minimumExecutablePosition: settings.minimumExecutablePosition,
    positionSizeStep: settings.positionSizeStep,
    feeBps: PAPER_FEE_BPS,
  };
}

/** Runtime observability of the capacity layer (System page). */
export const capacityMetrics = {
  evaluations: 0,
  unknown: 0,
  wouldReduce: 0,
  wouldReject: 0,
  enforcedReductions: 0,
  enforcedRejections: 0,
  reductionPercentTotal: 0,
  deteriorations: 0,
  routeLosses: 0,
  latency: new RollingPercentiles(),
  snapshot() {
    return {
      evaluations: this.evaluations, unknown: this.unknown, wouldReduce: this.wouldReduce, wouldReject: this.wouldReject,
      enforcedReductions: this.enforcedReductions, enforcedRejections: this.enforcedRejections,
      averageRecommendedReductionPercent: this.wouldReduce ? this.reductionPercentTotal / this.wouldReduce : null,
      deteriorationsAfterEntry: this.deteriorations, routeLosses: this.routeLosses, latencyMs: this.latency.summary(),
    };
  },
};

export interface EntryCapacityInput {
  settings: ResolvedNewLaunchSettings;
  priceUsd: number;
  liquidityUsd: number | null;
  curve: CurveState | null;
  migrated: boolean;
  dataAgeMs: number | null;
  /** Size before the hard limits (the configured % of equity). */
  originalRequestedSize: number;
  /** Size after every existing limit and the risk multiplier (what NL-v2 executes). */
  riskApprovedSize: number;
}

export function assessEntryCapacity(input: EntryCapacityInput) {
  const started = globalThis.performance.now();
  const config = capacityConfigFrom(input.settings);
  const market = {
    priceUsd: input.priceUsd,
    liquidityUsd: input.liquidityUsd,
    curve: input.curve,
    // A migrated curve without a known pool has no sell route we can price.
    sellRouteAvailable: input.migrated && !input.curve && !input.liquidityUsd ? false : null,
    // NewLaunch BUY signals are only created after sellability was VERIFIED (observed independent sellers).
    sellability: 'VERIFIED' as const,
    dataAgeMs: input.dataAgeMs,
  };
  const capacity: ExitCapacityResult = evaluateExitCapacity(market, input.riskApprovedSize, config);
  const sizing = planCapacitySizing({ requestedSize: input.originalRequestedSize, riskApprovedSize: input.riskApprovedSize, capacity, liquidityUsd: input.liquidityUsd, mode: input.settings.exitCapacityMode, config });
  const curve = capacityCurve(market);
  const latencyMs = globalThis.performance.now() - started;
  capacityMetrics.evaluations += 1;
  capacityMetrics.latency.add(latencyMs);
  if (capacity.classification === 'UNKNOWN') capacityMetrics.unknown += 1;
  if (sizing.decision === 'REDUCE') {
    capacityMetrics.wouldReduce += 1;
    capacityMetrics.reductionPercentTotal += (1 - sizing.finalRecommendedSize / sizing.riskApprovedSize) * 100;
  }
  if (sizing.finalRecommendedSize === 0) capacityMetrics.wouldReject += 1;
  if (input.settings.exitCapacityMode === 'ENFORCE_PAPER') {
    if (sizing.decision === 'REDUCE') capacityMetrics.enforcedReductions += 1;
    if (sizing.executedSize === 0) capacityMetrics.enforcedRejections += 1;
  }
  // Immutable entry snapshot (stored in the trade's configSnapshot) + the shadow sizing record.
  const snapshot = {
    evaluatedAt: new Date().toISOString(),
    evaluationLatencyMs: latencyMs,
    config,
    atEntry: capacity,
    liquidityAtEntry: input.liquidityUsd,
    routeAtEntry: input.curve ? 'BONDING_CURVE' : input.liquidityUsd ? 'POOL_FROM_MARKET_DATA' : 'UNKNOWN',
    curveAtEntry: input.curve,
    capacityCurve: curve,
    sizing: {
      sizingMode: input.settings.exitCapacityMode,
      originalRequestedSize: input.originalRequestedSize,
      riskApprovedSize: input.riskApprovedSize,
      liquidityRecommendedSize: sizing.liquidityRecommendedSize,
      exitCapacityRecommendedSize: sizing.exitCapacityRecommendedSize,
      finalRecommendedSize: sizing.finalRecommendedSize,
      actualExecutedSize: sizing.executedSize,
      // MONITOR_ONLY comparison: what was executed vs what the liquidity-aware sizing would have executed.
      actualPaperPosition: sizing.executedSize,
      recommendedLiquidityAdjustedPosition: sizing.finalRecommendedSize,
      difference: sizing.finalRecommendedSize - sizing.executedSize,
      decision: sizing.decision,
      reductionReason: sizing.reductionReason,
      sizingReasons: sizing.reasons,
    },
  };
  return { capacity, sizing, snapshot };
}
