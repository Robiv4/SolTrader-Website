/** Shapes of the token page APIs (/api/tokens/:address, /trading, /social) used by the UI. */

export interface LaunchSnapshot {
  takenAt: string;
  priceUsd: number | null;
  liquidityUsd: number | null;
  volumeUsd: number | null;
  marketCapUsd: number | null;
  buyCount: number | null;
  sellCount: number | null;
  uniqueBuyers: number | null;
  uniqueSellers: number | null;
  largestBuyerShare: number | null;
  bondingProgress: number | null;
}

export interface LaunchDecision {
  decision: 'BUY' | 'WATCH' | 'REJECT';
  status: string;
  decisionAt: string;
  score: number | null;
  launchMomentumScore: number | null;
  exhaustionScore: number | null;
  liquidityScore: number | null;
  buyerQualityScore: number | null;
  buyPressureScore: number | null;
  securityScore: number | null;
  dataQuality: number | null;
  riskScore: number | null;
  riskClassification: string | null;
  reasons: unknown;
  warnings: unknown;
}

export interface LaunchInfo {
  source: string;
  status: string;
  name: string | null;
  symbol: string | null;
  poolAddress: string | null;
  bondingCurve: string | null;
  creator: string | null;
  detectedAt: string;
  createdAt: string | null;
  ageSeconds: number;
  detectedPriceUsd: number | null;
  security: Record<string, unknown> | null;
  snapshot: LaunchSnapshot | null;
  decision: LaunchDecision | null;
}

export interface RiskAssessment {
  id: string;
  riskScore: number | null;
  decision: string;
  factors: Record<string, number> | null;
  classification: string | null;
  hardBlocked: boolean;
  hardBlockReasons: unknown;
  positionMultiplier: number | null;
  rejectionReasons: unknown;
  warnings: unknown;
  source: string;
  createdAt: string;
}

export interface TokenDetail {
  id: string | null;
  openPositionId: string | null;
  address: string;
  symbol: string | null;
  name: string | null;
  decimals: number | null;
  priceUsd: number | null;
  liquidityUsd: number | null;
  volume24h: number | null;
  marketCap: number | null;
  priceChange1h: number | null;
  priceChange24h: number | null;
  tokenAgeSeconds: number | null;
  dexId: string | null;
  poolAddress: string | null;
  lastUpdatedAt: string | null;
  dataSource: 'MARKET_DATA' | 'LAUNCH' | 'TOKEN';
  launch: LaunchInfo | null;
  riskAssessments: RiskAssessment[];
  signals: Array<{ id: string; strategyName: string | null; signalType: string | null; direction: string | null; score: number | null; riskScore: number | null; createdAt: string }>;
  aiAnalysis: unknown;
  analysis: unknown;
}

export interface TokenTrading {
  ml: {
    paperDecision: { modelVersion: string; mlDecision: string; probability: number | null; threshold: number | null; decidedAt: string; snapshotKind: string; outcome: string; errorReason: string | null; executionReason: string | null; baseDecision: string | null; lateDataExcluded: unknown } | null;
    shadowPrediction: { modelVersion: string; probability: number | null; predictedClass: string; mlEntryScore: number; predictedAt: string } | null;
  };
  paperTrades: Array<{ id: string; entryAt: string | null; exitAt: string | null; entry: number | null; exit: number | null; size: number | null; netPnl: number | null; fees: number | null; slippage: number | null; exitReason: string | null; status: string; entryStrategy: string | null; mlModelVersion: string | null; positionId: string | null }>;
  openPosition: { id: string; entry: number | null; current: number | null; quantity: number | null; unrealizedPnl: number | null; pnlPercent: number | null; openedAt: string; entryStrategy: string | null } | null;
}

export const SOURCE_LABELS: Record<string, string> = { PUMP_FUN: 'Pump.fun', RAYDIUM: 'Raydium', METEORA: 'Meteora' };
export const DECISION_INFO: Record<string, { text: string; tone: 'positive' | 'warning' | 'negative' }> = { BUY: { text: 'VÉTEL', tone: 'positive' }, WATCH: { text: 'FIGYELÉS', tone: 'warning' }, REJECT: { text: 'ELUTASÍTVA', tone: 'negative' } };

export function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item)) : [];
}
