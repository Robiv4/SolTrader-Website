import { calculateTopHolderConcentrationPercent, type SolanaMintInfo, type TokenHolder } from '@soltrader/blockchain';
import type { TokenMarketSnapshot } from '@soltrader/market-data';

import type { TokenCandidate } from './index.js';

export interface CandidateInputs {
  snapshot: TokenMarketSnapshot;
  mintInfo?: SolanaMintInfo;
  holders?: TokenHolder[];
  /** Aggregate concentration across the largest tracked holders (distribution risk). */
  holderConcentrationPercent?: number;
  liquidityConcentrationPercent?: number;
  /** false when the RPC enrichment failed for that part (UNKNOWN, never assumed safe). */
  authorityStatusKnown?: boolean;
  holderDataAvailable?: boolean;
}

/** Notional trade size used to estimate price impact from pool depth when no quote API is available. */
const REFERENCE_TRADE_SIZE_USD = 1_000;

const SUSPICIOUS_SYMBOL_PATTERN = /(test|scam|rug|airdrop|claim|\.com|\.io|http)/i;

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function estimateSlippagePercent(liquidityUsd: number | undefined): number {
  if (!liquidityUsd || liquidityUsd <= 0) {
    return 100;
  }
  return clampPercent((REFERENCE_TRADE_SIZE_USD / liquidityUsd) * 100);
}

function estimateAbnormalActivity(snapshot: TokenMarketSnapshot): boolean {
  if (snapshot.transactionCount === undefined || snapshot.volume24h === undefined || snapshot.transactionCount === 0) {
    return false;
  }
  return snapshot.volume24h / snapshot.transactionCount > 250_000;
}

function computeBuyPressure(snapshot: TokenMarketSnapshot): number {
  if (snapshot.buyVolume === undefined || snapshot.sellVolume === undefined || snapshot.buyVolume + snapshot.sellVolume === 0) {
    return 50;
  }
  return clampPercent((snapshot.buyVolume / (snapshot.buyVolume + snapshot.sellVolume)) * 100);
}

/** Heuristic metadata sanity check: missing symbol/name or suspicious patterns commonly seen in scam tokens. */
export function detectMetadataAnomaly(metadata: TokenMarketSnapshot['metadata']): boolean {
  const symbol = metadata.symbol?.trim() ?? '';
  const name = metadata.name?.trim() ?? '';
  if (symbol.length === 0 || symbol.length > 15) return true;
  if (name.length > 60) return true;
  return SUSPICIOUS_SYMBOL_PATTERN.test(symbol) || SUSPICIOUS_SYMBOL_PATTERN.test(name);
}

/**
 * Normalizes a real market-data snapshot (plus optional on-chain enrichment) into the
 * TokenCandidate shape consumed by the risk engine. Fields with no upstream data source use
 * conservative (worst-case) defaults instead of fabricated "safe" values.
 */
export function buildTokenCandidate(inputs: CandidateInputs): TokenCandidate {
  const { snapshot, mintInfo, holders, holderConcentrationPercent, liquidityConcentrationPercent } = inputs;
  const liquidityUsd = snapshot.liquidityUsd ?? 0;
  const volume24h = snapshot.volume24h ?? 0;
  const transactionCount = snapshot.transactionCount ?? 0;
  const tokenAgeSeconds = snapshot.metadata.tokenAgeSeconds ?? Number.MAX_SAFE_INTEGER;
  const poolAgeSeconds = snapshot.metadata.poolAgeSeconds ?? snapshot.metadata.tokenAgeSeconds ?? 0;
  const volatilityPercent = Math.max(Math.abs(snapshot.priceChange1h ?? 0), Math.abs(snapshot.priceChange24h ?? 0));
  const topHolderConcentrationPercent = mintInfo && holders ? calculateTopHolderConcentrationPercent(holders, mintInfo) : 100;

  return {
    address: snapshot.metadata.address,
    liquidityUsd,
    liquidityConcentrationPercent: liquidityConcentrationPercent ?? 100,
    tokenAgeSeconds,
    poolAgeSeconds,
    volume24h,
    transactionCount,
    slippageEstimatePercent: estimateSlippagePercent(snapshot.liquidityUsd),
    holderConcentrationPercent: holderConcentrationPercent ?? 100,
    topHolderConcentrationPercent,
    authority: {
      mintAuthorityRevoked: mintInfo ? mintInfo.mintAuthority === null : false,
      freezeAuthorityRevoked: mintInfo ? mintInfo.freezeAuthority === null : false,
      metadataMutable: true,
    },
    // Conservative numeric values stay for scoring; the flags make the UNKNOWN explicit (decision capped at WATCH).
    authorityStatusKnown: inputs.authorityStatusKnown ?? Boolean(mintInfo),
    holderDataAvailable: inputs.holderDataAvailable ?? Boolean(mintInfo && holders),
    metadataAnomalyDetected: detectMetadataAnomaly(snapshot.metadata),
    abnormalTradingActivity: estimateAbnormalActivity(snapshot),
    volatilityPercent,
    scoreFactors: {
      momentum: clampPercent(50 + (snapshot.priceChange1h ?? 0)),
      volume: clampPercent((volume24h / 100_000) * 100),
      volumeAcceleration: clampPercent(50 + (snapshot.priceChange1h ?? 0) * 2),
      buyPressure: computeBuyPressure(snapshot),
      liquidity: clampPercent((liquidityUsd / 50_000) * 100),
      holderDistribution: clampPercent(100 - (holderConcentrationPercent ?? 100)),
      walletActivity: clampPercent((transactionCount / 500) * 100),
      marketConditions: clampPercent(50 + (snapshot.priceChange24h ?? 0)),
    },
  };
}

