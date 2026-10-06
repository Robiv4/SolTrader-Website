/**
 * PAPER fill model (documented formulas):
 *   priceImpact% = 0.1 + 100 * notional / (liquidityUsd / 2 + notional)
 *     - constant-product impact of the order against the quote side of the pool (about half of the
 *       reported USD liquidity) plus a fixed 0.1% allowance for latency.
 *   BUY  fill = market * (1 + impact%)   -> always worse (higher) than the reference price
 *   SELL fill = market * (1 - impact%)   -> always worse (lower) than the reference price
 *   slippage cost (USD) = |fill - market| * quantity   (already inside the fill price; never deducted again)
 *   fee (USD) = 0.30% of the filled notional, charged on entry and on exit.
 */

/** Fixed allowance applied when no liquidity figure is available for an exit. */
export const PAPER_LATENCY_SLIPPAGE_PERCENT = 0.1;

export function estimatePriceImpactPercent(notional: number, liquidityUsd: number) {
  const quoteReserve = liquidityUsd / 2;
  if (!(quoteReserve > 0) || !(notional > 0)) return Number.POSITIVE_INFINITY;
  return PAPER_LATENCY_SLIPPAGE_PERCENT + 100 * notional / (quoteReserve + notional);
}

/** Inverse of estimatePriceImpactPercent: the largest notional whose estimated impact is at most `maxSlippagePercent`. */
export function maxNotionalForSlippage(liquidityUsd: number, maxSlippagePercent: number) {
  const quoteReserve = liquidityUsd / 2;
  const allowed = maxSlippagePercent - PAPER_LATENCY_SLIPPAGE_PERCENT;
  if (!(quoteReserve > 0) || !(allowed > 0)) return 0;
  return quoteReserve * allowed / (100 - allowed);
}

export function simulatedBuyFill(marketPrice: number, slippagePercent: number) {
  return marketPrice * (1 + Math.max(0, slippagePercent) / 100);
}

export function simulatedSellFill(marketPrice: number, slippagePercent: number) {
  return marketPrice * (1 - Math.min(99, Math.max(0, slippagePercent)) / 100);
}

/** Exit slippage for selling `quantity` at `marketPrice`; falls back to the latency allowance without liquidity data. */
export function estimateExitSlippagePercent(marketPrice: number, quantity: number, liquidityUsd: number | null | undefined) {
  const notional = marketPrice * quantity;
  if (!(notional > 0)) return 0;
  if (liquidityUsd === null || liquidityUsd === undefined || !(liquidityUsd > 0)) return PAPER_LATENCY_SLIPPAGE_PERCENT;
  return Math.min(99, estimatePriceImpactPercent(notional, liquidityUsd));
}
