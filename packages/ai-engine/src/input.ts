import { createHash } from 'node:crypto';

/** A numeric value as sent to the model: a finite number or null (never NaN, Infinity or a string). */
export type AiNumber = number | null;

export interface AiSnapshotPoint {
  minutesAgo: number;
  priceUsd: AiNumber;
  liquidityUsd: AiNumber;
  volume5m: AiNumber;
  buys5m: AiNumber;
  sells5m: AiNumber;
}

/**
 * Structured, point-in-time input of one analysis. Everything is public market / risk data known at
 * `evaluatedAt`; no wallet, account, secret or future (post-T) information is ever included.
 */
export interface AiTokenAnalysisInput {
  evaluatedAt: string;
  token: { address: string; symbol: string | null; name: string | null; tokenAgeMinutes: AiNumber };
  market: {
    priceUsd: number;
    priceChange1m: AiNumber;
    priceChange5m: AiNumber;
    priceChange15m: AiNumber;
    priceChange1h: AiNumber;
    priceChange24h: AiNumber;
    liquidityUsd: AiNumber;
    liquidityChange5m: AiNumber;
    liquidityChange15m: AiNumber;
    volume5m: AiNumber;
    volume1h: AiNumber;
    volume24h: AiNumber;
    volumeSpikeRatio: AiNumber;
    volumeAcceleration: AiNumber;
    buys5m: AiNumber;
    sells5m: AiNumber;
    buySellCountRatio: AiNumber;
    buyShare5m: AiNumber;
    buyShare1h: AiNumber;
    /** Not reported by the current provider (null = unknown, not zero). */
    buyVolume5m: AiNumber;
    sellVolume5m: AiNumber;
    averageTradeSizeUsd5m: AiNumber;
    momentumWindows5m: AiNumber[] | null;
    momentumAcceleration: AiNumber;
    recentHigh30m: AiNumber;
    recentLow30m: AiNumber;
    distanceFromRecentHighPercent: AiNumber;
    volatility30mPercent: AiNumber;
    estimatedPriceImpactPercent: AiNumber;
    marketCapUsd: AiNumber;
    fdvUsd: AiNumber;
    dataQuality: string;
    historyMinutes: AiNumber;
  };
  risk: {
    riskScore: AiNumber;
    classification: string | null;
    factors: Record<string, AiNumber>;
    warnings: string[];
    hardBlocked: boolean;
    hardBlockReasons: string[];
    security: Record<string, AiNumber | boolean | string | null>;
  };
  /** Deterministic strategy module scores (context only; they do not decide in AI mode). */
  strategyFeatures: Record<string, { status: string; score: AiNumber; triggered: boolean }>;
  compositeScore: AiNumber;
  exhaustionScore: AiNumber;
  recentSnapshots: AiSnapshotPoint[];
}

export function aiNumber(value: unknown, digits = 6): AiNumber {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : typeof (value as { toNumber?: () => number }).toNumber === 'function' ? (value as { toNumber: () => number }).toNumber() : Number.NaN;
  if (!Number.isFinite(parsed)) return null;
  return Number(parsed.toPrecision(digits));
}

export class AiInputValidationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'AiInputValidationError';
  }
}

/** Rejects inputs the model must never see: missing/invalid price, stale data, missing risk analysis, hard blocks. */
export function assertValidAiInput(input: AiTokenAnalysisInput, now = new Date(), maxAgeMs = 120_000) {
  if (!input.token.address) throw new AiInputValidationError('TOKEN_MISSING', 'Token address missing');
  if (!(typeof input.market.priceUsd === 'number' && Number.isFinite(input.market.priceUsd) && input.market.priceUsd > 0)) throw new AiInputValidationError('INVALID_PRICE', 'Invalid price');
  const evaluatedAt = Date.parse(input.evaluatedAt);
  if (!Number.isFinite(evaluatedAt) || evaluatedAt > now.getTime() + 60_000) throw new AiInputValidationError('INVALID_TIMESTAMP', 'Invalid evaluation timestamp');
  if (now.getTime() - evaluatedAt > maxAgeMs || input.market.dataQuality === 'STALE' || input.market.dataQuality === 'INVALID') throw new AiInputValidationError('STALE_MARKET_DATA', 'Market data is not fresh');
  if (input.risk.riskScore === null || !input.risk.classification) throw new AiInputValidationError('RISK_ANALYSIS_MISSING', 'Risk analysis missing');
  if (input.risk.hardBlocked) throw new AiInputValidationError('HARD_BLOCKED', 'Hard-blocked tokens are never analysed');
  const json = JSON.stringify(input);
  if (/NaN|Infinity/.test(json.replace(/"[^"]*"/g, ''))) throw new AiInputValidationError('MALFORMED_NUMBER', 'Malformed numeric value');
}

/**
 * Coarse fingerprint of the market state: identical within small moves, different after a meaningful change.
 * Used as part of the cache key so an unchanged market does not trigger a new provider call.
 */
export function marketStateHash(input: AiTokenAnalysisInput) {
  const bucket = (value: AiNumber, step: number) => (value === null ? 'n' : Math.round(value / step));
  const logBucket = (value: AiNumber, step: number) => (value === null || value <= 0 ? 'n' : Math.round(Math.log(value) / Math.log(1 + step)));
  const state = [
    input.token.address,
    logBucket(input.market.priceUsd, 0.03),
    logBucket(input.market.liquidityUsd, 0.1),
    logBucket(input.market.volume5m, 0.5),
    bucket(input.market.buyShare5m, 0.1),
    input.risk.classification,
    bucket(input.exhaustionScore, 15),
    bucket(input.compositeScore, 10),
  ].join('|');
  return createHash('sha256').update(state).digest('hex').slice(0, 24);
}

/** Hash of the exact input (stored with the analysis for reproducibility). */
export function inputHash(input: AiTokenAnalysisInput) {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}
