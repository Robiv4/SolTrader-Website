/**
 * Mandatory protection layer of the Autonomous ML strategy (independent of the model, never strategic):
 *
 * Entries: account protection on top of the token fraud / honeypot / liquidity / impact checks (mlEntrySafetyBlockers):
 * PAPER only, emergency stop, fresh executable quote, one position per token, max open positions, position size,
 * portfolio exposure, daily loss limit and the impact limit. The size can only be REDUCED here, never increased.
 *
 * Exits: technical fail-safes that act even when the model is unavailable: hard maximum loss, liquidity collapse,
 * lost sell route and a technical maximum holding time. These are not DEFAULT take-profit / trailing rules; without a
 * fresh real price nothing is sold at an invented price (the position waits for a real quote).
 */
import { impactPercent } from '../ml/exit-simulation.js';

import { maxNotionalForImpact } from './bundle.js';

export interface AutonomousProtectionConfig {
  maxQuoteAgeMs: number;
  maxPositionPctOfEquity: number;
  maxExposurePctOfEquity: number;
  dailyLossLimitPct: number;
  maxOpenPositions: number;
  maxImpactPct: number;
  /** Fail-safe exits. */
  hardMaxLossPct: number;
  maxLiquidityDropPct: number;
  technicalMaxHoldMinutes: number;
}

export const DEFAULT_AUTONOMOUS_PROTECTION: AutonomousProtectionConfig = {
  maxQuoteAgeMs: 15_000, maxPositionPctOfEquity: 5, maxExposurePctOfEquity: 25, dailyLossLimitPct: 8, maxOpenPositions: 4, maxImpactPct: 8,
  hardMaxLossPct: 35, maxLiquidityDropPct: 60, technicalMaxHoldMinutes: 120,
};

export interface EntryProtectionInput {
  tradingMode: string | null;
  liveEnabled: boolean;
  emergencyStop: boolean;
  quoteAgeMs: number | null;
  liquidityUsd: number | null;
  requestedSizeUsd: number;
  equityUsd: number;
  cashUsd: number;
  exposureUsd: number;
  dayPnlUsd: number;
  dayStartEquityUsd: number;
  openPositions: number;
  alreadyHolding: boolean;
  /** Token security / liquidity / impact blockers (mlEntrySafetyBlockers + hard blocks). */
  tokenBlockers: string[];
}

export function entryProtection(input: EntryProtectionInput, config: AutonomousProtectionConfig = DEFAULT_AUTONOMOUS_PROTECTION) {
  const blockers = new Set(input.tokenBlockers);
  if (input.liveEnabled || input.tradingMode !== 'PAPER') blockers.add('PAPER_MODE_REQUIRED');
  if (input.emergencyStop) blockers.add('EMERGENCY_STOP');
  if (input.quoteAgeMs === null) blockers.add('MARKET_DATA_UNAVAILABLE');
  else if (input.quoteAgeMs > config.maxQuoteAgeMs) blockers.add('MARKET_DATA_STALE');
  if (input.alreadyHolding) blockers.add('ALREADY_HOLDING_TOKEN');
  if (input.openPositions >= config.maxOpenPositions) blockers.add('MAX_OPEN_POSITIONS');
  if (input.dayStartEquityUsd > 0 && -input.dayPnlUsd >= input.dayStartEquityUsd * config.dailyLossLimitPct / 100) blockers.add('DAILY_LOSS_LIMIT');
  if (!(input.equityUsd > 0)) blockers.add('ACCOUNT_EQUITY_UNKNOWN');
  // Size: only reduced (position cap, exposure room, cash incl. fee, impact limit).
  const caps = [
    input.requestedSizeUsd,
    input.equityUsd * config.maxPositionPctOfEquity / 100,
    Math.max(0, input.equityUsd * config.maxExposurePctOfEquity / 100 - input.exposureUsd),
    Math.max(0, input.cashUsd / 1.003),
    maxNotionalForImpact(input.liquidityUsd, config.maxImpactPct),
  ];
  const sizeUsd = Math.max(0, Math.floor(Math.min(...caps) * 100) / 100);
  if (sizeUsd < 1) blockers.add('SIZE_LIMIT_REACHED');
  if (input.liquidityUsd !== null && sizeUsd > 0 && impactPercent(sizeUsd, input.liquidityUsd) > config.maxImpactPct) blockers.add('PRICE_IMPACT_TOO_HIGH');
  return { allowed: blockers.size === 0, blockers: [...blockers], sizeUsd: blockers.size === 0 ? sizeUsd : 0 };
}

export interface ExitProtectionInput {
  netIfSoldPct: number | null;
  liquidityUsd: number | null;
  entryLiquidityUsd: number | null;
  holdMs: number;
  quoteAgeMs: number | null;
  sellRouteAvailable: boolean;
}

export type ProtectionExitReason = 'HARD_MAX_LOSS' | 'LIQUIDITY_COLLAPSE' | 'SELL_ROUTE_LOST' | 'TECHNICAL_MAX_HOLD';

/** Fail-safe exit (null = no forced exit). `waitForQuote` = a forced exit is due but there is no real price yet. */
export function exitProtection(input: ExitProtectionInput, config: AutonomousProtectionConfig = DEFAULT_AUTONOMOUS_PROTECTION): { reason: ProtectionExitReason | null; waitForQuote: boolean } {
  const fresh = input.quoteAgeMs !== null && input.quoteAgeMs <= config.maxQuoteAgeMs;
  let reason: ProtectionExitReason | null = null;
  if (!input.sellRouteAvailable) reason = 'SELL_ROUTE_LOST';
  else if (input.netIfSoldPct !== null && input.netIfSoldPct <= -config.hardMaxLossPct) reason = 'HARD_MAX_LOSS';
  else if (input.liquidityUsd !== null && input.entryLiquidityUsd !== null && input.entryLiquidityUsd > 0 && input.liquidityUsd <= input.entryLiquidityUsd * (1 - config.maxLiquidityDropPct / 100)) reason = 'LIQUIDITY_COLLAPSE';
  else if (input.holdMs >= config.technicalMaxHoldMinutes * 60_000) reason = 'TECHNICAL_MAX_HOLD';
  // A forced exit needs a real, fresh price (never an invented sell price).
  return { reason, waitForQuote: reason !== null && !fresh };
}
