/**
 * Exit Capacity Engine (pure, no I/O).
 *
 * Question answered: "if this whole position had to be sold right now, could it realistically be exited with an
 * acceptable price impact?" It measures EXECUTABILITY, never the token's direction, and is kept separate from the
 * Launch Score / AI confidence.
 *
 * Impact models, in order of preference (the basis is always reported):
 *   EXECUTABLE_QUOTE / ROUTE_SIMULATION - an executable quote / route simulation (no PAPER provider wired yet);
 *   POOL_MODEL         - constant-product math on the live pool reserves (pump.fun bonding curve: virtual SOL /
 *                        virtual token reserves from the trade stream; real SOL reserve bounds what can be withdrawn);
 *   LIQUIDITY_ESTIMATE - the conservative liquidity formula of the PAPER fill model (impact = 0.1 + 100 x / (L/2 + x));
 *   INSUFFICIENT_DATA  - nothing reliable: classification UNKNOWN (never treated as safe).
 *
 * Full exit test: 100% of the planned position is sold at once into the CURRENT pool state (the transient lift of
 * our own buy is not assumed to persist), so round trip = buy impact + immediate full-sell impact vs spot.
 */
import { estimatePriceImpactPercent } from './paper-fills.js';

export type CapacityBasis = 'EXECUTABLE_QUOTE' | 'ROUTE_SIMULATION' | 'POOL_MODEL' | 'LIQUIDITY_ESTIMATE' | 'INSUFFICIENT_DATA';
export type CapacityClass = 'EXCELLENT' | 'GOOD' | 'MODERATE' | 'POOR' | 'UNSAFE' | 'UNKNOWN';
export type CapacityConfidence = 'MODEL' | 'ESTIMATE' | 'UNKNOWN';
export type ExitCapacityMode = 'MONITOR_ONLY' | 'ENFORCE_PAPER';

export interface CurveState {
  /** Virtual quote reserve (SOL) and virtual base reserve (tokens) of a constant-product bonding curve. */
  virtualQuote: number;
  virtualBase: number;
  /** Real quote reserve (SOL): the most that can actually be withdrawn by selling. */
  realQuote: number | null;
  /** USD value of one quote unit (SOL price). */
  quoteUsd: number;
}

export interface CapacityMarket {
  priceUsd: number | null;
  liquidityUsd: number | null;
  curve?: CurveState | null;
  /** false = no sell route exists (e.g. curve migrated and no pool known); null = unknown. */
  sellRouteAvailable?: boolean | null;
  sellability?: 'VERIFIED' | 'NOT_VERIFIED' | 'FAILED' | 'UNKNOWN';
  /** Age of the market state (0 for a live stream whose curve state is current). */
  dataAgeMs?: number | null;
}

export interface CapacityConfig {
  maxEntryImpactPct: number;
  maxExitImpactPct: number;
  maxRoundTripImpactPct: number;
  minExitCapacityScore: number;
  maxLiquidityUtilizationPct: number;
  minimumExecutablePosition: number;
  positionSizeStep: number;
  /** Market state older than this cannot support a capacity estimate (UNKNOWN). */
  maxDataAgeMs: number;
  /** PAPER fee per side (bps) used for the estimated round-trip COST (not part of the impact). */
  feeBps: number;
}

export const DEFAULT_CAPACITY_CONFIG: CapacityConfig = {
  maxEntryImpactPct: 3,
  maxExitImpactPct: 3,
  maxRoundTripImpactPct: 6,
  minExitCapacityScore: 50,
  maxLiquidityUtilizationPct: 5,
  minimumExecutablePosition: 5,
  positionSizeStep: 1,
  maxDataAgeMs: 30_000,
  feeBps: 30,
};

export interface ImpactAtSize {
  sizeUsd: number;
  buyImpactPct: number | null;
  sellImpactPct: number | null;
  roundTripImpactPct: number | null;
  liquidityUtilizationPct: number | null;
  /** False when the pool cannot pay out the full exit at all (real reserve exceeded). */
  feasible: boolean;
}

export interface ExitCapacityResult {
  available: boolean;
  basis: CapacityBasis;
  confidence: CapacityConfidence;
  plannedPosition: number;
  maxSafePosition: number | null;
  /** Constraint that sets maxSafePosition. */
  bindingConstraint: 'ENTRY_IMPACT' | 'EXIT_IMPACT' | 'ROUND_TRIP' | 'LIQUIDITY_UTILIZATION' | 'POOL_RESERVE' | null;
  estimatedBuyImpactPct: number | null;
  estimatedImmediateSellImpactPct: number | null;
  estimatedRoundTripImpactPct: number | null;
  /** Impacts + both fees, percent of the position. */
  estimatedRoundTripCostPct: number | null;
  expectedBuyFill: number | null;
  expectedImmediateSellFill: number | null;
  liquidityUtilizationPct: number | null;
  exitCapacityScore: number | null;
  classification: CapacityClass;
  warnings: string[];
  reasons: string[];
  dataQuality: 'LIVE' | 'FRESH' | 'STALE' | 'MISSING';
  dataAgeMs: number | null;
}

const finite = (value: number | null | undefined): value is number => typeof value === 'number' && Number.isFinite(value);

/** Impact of one position size under the best available model. */
export function impactAtSize(market: CapacityMarket, sizeUsd: number): ImpactAtSize & { basis: CapacityBasis } {
  const curve = market.curve;
  if (curve && curve.virtualQuote > 0 && curve.virtualBase > 0 && curve.quoteUsd > 0 && sizeUsd > 0) {
    const spot = curve.virtualQuote / curve.virtualBase;
    const quoteIn = sizeUsd / curve.quoteUsd;
    const tokensOut = curve.virtualBase - (curve.virtualQuote * curve.virtualBase) / (curve.virtualQuote + quoteIn);
    const buyImpact = (quoteIn / tokensOut / spot - 1) * 100;
    // Full exit of those tokens into the current (pre-buy) curve state.
    const quoteOut = curve.virtualQuote - (curve.virtualQuote * curve.virtualBase) / (curve.virtualBase + tokensOut);
    const sellImpact = (1 - quoteOut / tokensOut / spot) * 100;
    const feasible = curve.realQuote === null || quoteOut <= curve.realQuote;
    const roundTrip = (1 - (1 - sellImpact / 100) / (1 + buyImpact / 100)) * 100;
    return { basis: 'POOL_MODEL', sizeUsd, buyImpactPct: buyImpact, sellImpactPct: sellImpact, roundTripImpactPct: roundTrip, liquidityUtilizationPct: finite(market.liquidityUsd) && market.liquidityUsd > 0 ? sizeUsd / market.liquidityUsd * 100 : null, feasible };
  }
  if (finite(market.liquidityUsd) && market.liquidityUsd > 0 && sizeUsd > 0) {
    const buyImpact = estimatePriceImpactPercent(sizeUsd, market.liquidityUsd);
    // The position is worth about size / (1 + buy impact) at spot when it has to be sold.
    const sellImpact = Math.min(99, estimatePriceImpactPercent(sizeUsd / (1 + buyImpact / 100), market.liquidityUsd));
    const roundTrip = (1 - (1 - sellImpact / 100) / (1 + buyImpact / 100)) * 100;
    return { basis: 'LIQUIDITY_ESTIMATE', sizeUsd, buyImpactPct: buyImpact, sellImpactPct: sellImpact, roundTripImpactPct: roundTrip, liquidityUtilizationPct: sizeUsd / market.liquidityUsd * 100, feasible: true };
  }
  return { basis: 'INSUFFICIENT_DATA', sizeUsd, buyImpactPct: null, sellImpactPct: null, roundTripImpactPct: null, liquidityUtilizationPct: null, feasible: false };
}

function withinLimits(point: ImpactAtSize, config: CapacityConfig) {
  if (!point.feasible) return 'POOL_RESERVE' as const;
  if (point.buyImpactPct === null || point.sellImpactPct === null || point.roundTripImpactPct === null) return 'POOL_RESERVE' as const;
  if (point.buyImpactPct > config.maxEntryImpactPct) return 'ENTRY_IMPACT' as const;
  if (point.sellImpactPct > config.maxExitImpactPct) return 'EXIT_IMPACT' as const;
  if (point.roundTripImpactPct > config.maxRoundTripImpactPct) return 'ROUND_TRIP' as const;
  if (point.liquidityUtilizationPct !== null && point.liquidityUtilizationPct > config.maxLiquidityUtilizationPct) return 'LIQUIDITY_UTILIZATION' as const;
  return null;
}

/** Largest position (floored to the size step) that satisfies every limit; impacts grow monotonically with size. */
export function maxSafePosition(market: CapacityMarket, config: CapacityConfig = DEFAULT_CAPACITY_CONFIG): { size: number | null; binding: ExitCapacityResult['bindingConstraint'] } {
  if (impactAtSize(market, 1).basis === 'INSUFFICIENT_DATA') return { size: null, binding: null };
  let low = 0;
  let high = 1;
  let binding: ExitCapacityResult['bindingConstraint'] = null;
  // Expand until a limit binds (bounded so an extremely deep pool cannot loop forever).
  while (high < 1e9) {
    const violated = withinLimits(impactAtSize(market, high), config);
    if (violated) {
      binding = violated;
      break;
    }
    low = high;
    high *= 2;
  }
  if (!binding) return { size: low, binding: null };
  for (let iteration = 0; iteration < 60; iteration += 1) {
    const middle = (low + high) / 2;
    const violated = withinLimits(impactAtSize(market, middle), config);
    if (violated) {
      high = middle;
      binding = violated;
    } else low = middle;
  }
  const step = config.positionSizeStep > 0 ? config.positionSizeStep : 1;
  return { size: Math.floor(low / step) * step, binding };
}

/** 0-100 execution-quality score (separate from Launch Score / AI confidence). */
export function exitCapacityScore(point: ImpactAtSize, basis: CapacityBasis, config: CapacityConfig) {
  if (point.sellImpactPct === null) return null;
  if (!point.feasible) return 0;
  const impact = Math.max(0, Math.min(100, 100 * (1 - point.sellImpactPct / (2 * config.maxExitImpactPct))));
  const utilization = point.liquidityUtilizationPct === null ? impact : Math.max(0, Math.min(100, 100 * (1 - point.liquidityUtilizationPct / (2 * config.maxLiquidityUtilizationPct))));
  const raw = 0.7 * impact + 0.3 * utilization;
  // An estimate cannot score as high as a pool model of the actual reserves.
  return Math.round(basis === 'LIQUIDITY_ESTIMATE' ? raw * 0.9 : raw);
}

export function classifyCapacity(score: number | null): CapacityClass {
  if (score === null) return 'UNKNOWN';
  if (score >= 85) return 'EXCELLENT';
  if (score >= 70) return 'GOOD';
  if (score >= 50) return 'MODERATE';
  if (score >= 25) return 'POOR';
  return 'UNSAFE';
}

export const CAPACITY_RANK: Record<CapacityClass, number> = { EXCELLENT: 5, GOOD: 4, MODERATE: 3, POOR: 2, UNSAFE: 1, UNKNOWN: 0 };

/** Full-exit capacity of a planned position. */
export function evaluateExitCapacity(market: CapacityMarket, plannedPosition: number, config: CapacityConfig = DEFAULT_CAPACITY_CONFIG): ExitCapacityResult {
  const warnings: string[] = [];
  const reasons: string[] = [];
  const age = finite(market.dataAgeMs) ? market.dataAgeMs : null;
  const dataQuality: ExitCapacityResult['dataQuality'] = !finite(market.priceUsd) && !market.curve && !finite(market.liquidityUsd) ? 'MISSING' : age === null ? 'FRESH' : age > config.maxDataAgeMs ? 'STALE' : age === 0 ? 'LIVE' : 'FRESH';
  const point = impactAtSize(market, plannedPosition);
  const unknown = (reason: string): ExitCapacityResult => ({
    available: false, basis: point.basis === 'INSUFFICIENT_DATA' ? 'INSUFFICIENT_DATA' : point.basis, confidence: 'UNKNOWN', plannedPosition, maxSafePosition: null, bindingConstraint: null,
    estimatedBuyImpactPct: null, estimatedImmediateSellImpactPct: null, estimatedRoundTripImpactPct: null, estimatedRoundTripCostPct: null, expectedBuyFill: null, expectedImmediateSellFill: null,
    liquidityUtilizationPct: null, exitCapacityScore: null, classification: 'UNKNOWN', warnings, reasons: [...reasons, reason], dataQuality, dataAgeMs: age,
  });
  if (market.sellRouteAvailable === false) {
    reasons.push('NO_SELL_ROUTE');
    return { ...unknown('NO_SELL_ROUTE'), classification: 'UNSAFE', exitCapacityScore: 0, available: true };
  }
  if (market.sellability === 'FAILED') {
    reasons.push('SELLABILITY_FAILED');
    return { ...unknown('SELLABILITY_FAILED'), classification: 'UNSAFE', exitCapacityScore: 0, available: true };
  }
  if (point.basis === 'INSUFFICIENT_DATA') return unknown('INSUFFICIENT_LIQUIDITY_DATA');
  if (dataQuality === 'STALE') return unknown('MARKET_DATA_STALE');
  if (point.basis === 'LIQUIDITY_ESTIMATE') warnings.push('ESTIMATED_FROM_LIQUIDITY');
  const safe = maxSafePosition(market, config);
  let score = exitCapacityScore(point, point.basis, config);
  if (market.sellability !== 'VERIFIED') {
    warnings.push('SELLABILITY_NOT_VERIFIED');
    if (score !== null) score = Math.min(score, 49);
  }
  if (!point.feasible) reasons.push('POOL_CANNOT_PAY_FULL_EXIT');
  if (safe.size !== null && plannedPosition > safe.size) reasons.push(`ABOVE_MAX_SAFE_POSITION:${safe.binding}`);
  const fee = 2 * config.feeBps / 100;
  const price = finite(market.priceUsd) ? market.priceUsd : null;
  return {
    available: true,
    basis: point.basis,
    confidence: point.basis === 'POOL_MODEL' ? 'MODEL' : 'ESTIMATE',
    plannedPosition,
    maxSafePosition: safe.size,
    bindingConstraint: safe.binding,
    estimatedBuyImpactPct: point.buyImpactPct,
    estimatedImmediateSellImpactPct: point.sellImpactPct,
    estimatedRoundTripImpactPct: point.roundTripImpactPct,
    estimatedRoundTripCostPct: point.roundTripImpactPct !== null ? point.roundTripImpactPct + fee : null,
    expectedBuyFill: price !== null && point.buyImpactPct !== null ? price * (1 + point.buyImpactPct / 100) : null,
    expectedImmediateSellFill: price !== null && point.sellImpactPct !== null ? price * (1 - point.sellImpactPct / 100) : null,
    liquidityUtilizationPct: point.liquidityUtilizationPct,
    exitCapacityScore: score,
    classification: classifyCapacity(score),
    warnings,
    reasons,
    dataQuality,
    dataAgeMs: age,
  };
}

/** POSITION SIZE -> EXPECTED IMPACT curve (same model as the capacity result). */
export function capacityCurve(market: CapacityMarket, sizes: number[] = [25, 50, 100, 200, 500, 1_000]) {
  return sizes.map((size) => {
    const point = impactAtSize(market, size);
    return { sizeUsd: size, basis: point.basis, buyImpactPct: point.buyImpactPct, sellImpactPct: point.sellImpactPct, roundTripImpactPct: point.roundTripImpactPct, liquidityUtilizationPct: point.liquidityUtilizationPct, feasible: point.feasible };
  });
}

export interface CapacitySizingDecision {
  mode: ExitCapacityMode;
  requestedSize: number;
  riskApprovedSize: number;
  liquidityRecommendedSize: number | null;
  exitCapacityRecommendedSize: number | null;
  finalRecommendedSize: number;
  /** Size that is actually executed: unchanged in MONITOR_ONLY, the recommendation in ENFORCE_PAPER (0 = rejected). */
  executedSize: number;
  decision: 'KEEP' | 'REDUCE' | 'TOO_SMALL_TO_TRADE' | 'BLOCK_UNSAFE' | 'BLOCK_UNKNOWN' | 'BLOCK_LOW_SCORE';
  reductionReason: string | null;
  reasons: string[];
}

/**
 * Applies the capacity limit to the risk-approved size. It can only KEEP or REDUCE (min with every other limit),
 * never increase. MONITOR_ONLY records the recommendation and executes the original size unchanged.
 */
export function planCapacitySizing(input: { requestedSize: number; riskApprovedSize: number; capacity: ExitCapacityResult; liquidityUsd: number | null; mode: ExitCapacityMode; config: CapacityConfig }): CapacitySizingDecision {
  const { capacity, config } = input;
  const step = config.positionSizeStep > 0 ? config.positionSizeStep : 1;
  const liquidityRecommendedSize = input.liquidityUsd && input.liquidityUsd > 0 ? Math.floor(input.liquidityUsd * config.maxLiquidityUtilizationPct / 100 / step) * step : null;
  const reasons: string[] = [...capacity.reasons];
  let decision: CapacitySizingDecision['decision'] = 'KEEP';
  let reductionReason: string | null = null;
  let final = input.riskApprovedSize;
  // The pool itself is unusable (no route, failed sellability): block. A class measured at an
  // oversized PLANNED size is not a reason to block - the size is reduced to the safe maximum instead.
  const poolUnusable = capacity.reasons.includes('NO_SELL_ROUTE') || capacity.reasons.includes('SELLABILITY_FAILED');
  if (poolUnusable) {
    decision = 'BLOCK_UNSAFE';
    final = 0;
  } else if (capacity.classification === 'UNKNOWN' || capacity.maxSafePosition === null) {
    decision = 'BLOCK_UNKNOWN';
    final = 0;
  } else {
    if (capacity.maxSafePosition < final) {
      final = capacity.maxSafePosition;
      decision = 'REDUCE';
      reductionReason = capacity.bindingConstraint === 'LIQUIDITY_UTILIZATION' ? 'LIQUIDITY_UTILIZATION' : 'EXIT_CAPACITY';
    }
    if (final < config.minimumExecutablePosition) {
      decision = 'TOO_SMALL_TO_TRADE';
      final = 0;
    } else if (capacity.exitCapacityScore !== null && capacity.exitCapacityScore < config.minExitCapacityScore && decision === 'KEEP') {
      // Score is measured at the PLANNED size; a reduction already addresses it.
      decision = 'BLOCK_LOW_SCORE';
      final = 0;
    }
  }
  final = Math.min(final, input.riskApprovedSize);
  return {
    mode: input.mode,
    requestedSize: input.requestedSize,
    riskApprovedSize: input.riskApprovedSize,
    liquidityRecommendedSize,
    exitCapacityRecommendedSize: capacity.maxSafePosition,
    finalRecommendedSize: final,
    executedSize: input.mode === 'ENFORCE_PAPER' ? final : input.riskApprovedSize,
    decision,
    reductionReason,
    reasons,
  };
}

// ---------------------------------------------------------------------------------------------
// Historical counterfactual replay (analytics only; never rewrites trades)
// ---------------------------------------------------------------------------------------------

export interface ReplayTrade {
  id: string;
  closedAt: number;
  /** Market prices (before impact) at entry and at the exit fill reference. */
  entryMarketPrice: number;
  exitMarketPrice: number;
  entryLiquidityUsd: number | null;
  exitLiquidityUsd: number | null;
}

export interface SizeScenarioResult {
  sizeUsd: number;
  variant: 'UNCONSTRAINED' | 'CAPACITY_LIMITED';
  tradesExecutable: number;
  tradesReduced: number;
  tradesRejected: number;
  tradesWithoutData: number;
  capitalDeployed: number;
  netPnl: number;
  profitFactor: number | null;
  expectancy: number | null;
  /** Net P&L per USDC deployed (percent): the scalability measure. */
  returnOnCapitalPct: number | null;
  maxDrawdown: number;
  averageBuyImpactPct: number | null;
  averageSellImpactPct: number | null;
  averageRoundTripCostPct: number | null;
}

const mean = (values: number[]) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null);

/**
 * Replays historical trades at other position sizes with the LIQUIDITY_ESTIMATE model at the stored entry / exit
 * liquidity (the only depth data stored for old trades). The market path is held fixed: a larger order is assumed not
 * to change other participants' behaviour (an optimistic assumption for large sizes - stated in the UI).
 */
export function replaySizeScenarios(trades: ReplayTrade[], sizes: number[], config: CapacityConfig = DEFAULT_CAPACITY_CONFIG): SizeScenarioResult[] {
  const ordered = [...trades].sort((a, b) => a.closedAt - b.closedAt);
  const results: SizeScenarioResult[] = [];
  for (const variant of ['UNCONSTRAINED', 'CAPACITY_LIMITED'] as const) {
    for (const size of sizes) {
      let deployed = 0;
      let reduced = 0;
      let rejected = 0;
      let missing = 0;
      const pnls: number[] = [];
      const buys: number[] = [];
      const sells: number[] = [];
      const costs: number[] = [];
      for (const trade of ordered) {
        if (!(trade.entryLiquidityUsd && trade.entryLiquidityUsd > 0 && trade.exitLiquidityUsd && trade.exitLiquidityUsd > 0 && trade.entryMarketPrice > 0 && trade.exitMarketPrice > 0)) {
          missing += 1;
          continue;
        }
        let tradeSize = size;
        if (variant === 'CAPACITY_LIMITED') {
          const safe = maxSafePosition({ priceUsd: trade.entryMarketPrice, liquidityUsd: trade.entryLiquidityUsd }, config).size;
          if (safe === null || safe < config.minimumExecutablePosition) {
            rejected += 1;
            continue;
          }
          if (safe < size) {
            tradeSize = safe;
            reduced += 1;
          }
        }
        const buyImpact = estimatePriceImpactPercent(tradeSize, trade.entryLiquidityUsd);
        const buyFill = trade.entryMarketPrice * (1 + buyImpact / 100);
        const quantity = tradeSize / buyFill;
        const sellImpact = Math.min(99, estimatePriceImpactPercent(quantity * trade.exitMarketPrice, trade.exitLiquidityUsd));
        const sellFill = trade.exitMarketPrice * (1 - sellImpact / 100);
        const fees = (tradeSize + quantity * sellFill) * config.feeBps / 10_000;
        const pnl = quantity * (sellFill - buyFill) - fees;
        pnls.push(pnl);
        deployed += tradeSize;
        buys.push(buyImpact);
        sells.push(sellImpact);
        costs.push((1 - (1 - sellImpact / 100) / (1 + buyImpact / 100)) * 100 + 2 * config.feeBps / 100);
      }
      const wins = pnls.filter((pnl) => pnl > 0).reduce((sum, pnl) => sum + pnl, 0);
      const losses = -pnls.filter((pnl) => pnl <= 0).reduce((sum, pnl) => sum + pnl, 0);
      let peak = 0;
      let equity = 0;
      let drawdown = 0;
      for (const pnl of pnls) {
        equity += pnl;
        peak = Math.max(peak, equity);
        drawdown = Math.max(drawdown, peak - equity);
      }
      const net = pnls.reduce((sum, pnl) => sum + pnl, 0);
      results.push({
        sizeUsd: size, variant, tradesExecutable: pnls.length, tradesReduced: reduced, tradesRejected: rejected, tradesWithoutData: missing, capitalDeployed: deployed,
        netPnl: net, profitFactor: losses > 0 ? wins / losses : null, expectancy: pnls.length ? net / pnls.length : null, returnOnCapitalPct: deployed > 0 ? net / deployed * 100 : null,
        maxDrawdown: drawdown, averageBuyImpactPct: mean(buys), averageSellImpactPct: mean(sells), averageRoundTripCostPct: mean(costs),
      });
    }
  }
  return results;
}

/**
 * Chronological partial-exit simulation (analytics only): chunk i is sold at the newest observation at or before
 * start + i * intervalMs (never a later price), each chunk with its own impact at that moment's liquidity.
 */
export function simulatePartialExit(path: Array<{ t: number; price: number; liquidityUsd: number | null }>, startAt: number, quantity: number, chunks: number, intervalMs: number) {
  const ordered = [...path].sort((a, b) => a.t - b.t);
  let proceeds = 0;
  const fills: Array<{ at: number; price: number; impactPct: number }> = [];
  for (let index = 0; index < chunks; index += 1) {
    const at = startAt + index * intervalMs;
    const observation = [...ordered].reverse().find((point) => point.t <= at);
    if (!observation || !observation.liquidityUsd) return null;
    const chunkQuantity = quantity / chunks;
    const impact = Math.min(99, estimatePriceImpactPercent(chunkQuantity * observation.price, observation.liquidityUsd));
    const fill = observation.price * (1 - impact / 100);
    proceeds += chunkQuantity * fill;
    fills.push({ at, price: fill, impactPct: impact });
  }
  return { proceeds, fills };
}
