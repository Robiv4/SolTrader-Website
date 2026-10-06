export type TradingMode = 'PAPER' | 'SEMI_AUTO' | 'LIVE';

export interface SystemState {
  scanner: 'active' | 'inactive';
  paperTrading: 'enabled' | 'disabled';
  liveTrading: 'enabled' | 'disabled';
  keyExposure: 'blocked' | 'exposed';
}

export interface HealthResponse {
  ok: boolean;
  service: string;
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  mode: TradingMode;
  liveTradingEnabled: boolean;
}

export const DEFAULT_TRADING_MODE: TradingMode = 'PAPER';

export interface LiveTradingAuthorization {
  userAuthenticated: boolean;
  userLiveEnabled: boolean;
  serverLiveTradingEnabled: boolean;
  liveApprovalCompleted: boolean;
  dedicatedTradingWalletConfigured: boolean;
  walletSecretAvailable: boolean;
  walletNetworkCorrect: boolean;
  rpcHealthy: boolean;
  executionProviderHealthy: boolean;
  marketDataHealthy: boolean;
  riskEngineHealthy: boolean;
  positionManagerHealthy: boolean;
  dailyLossLimitConfigured: boolean;
  maxPositionConfigured: boolean;
  maxSlippageConfigured: boolean;
  maxExposureConfigured: boolean;
  emergencyStopClear: boolean;
  noUnresolvedTransaction: boolean;
  systemHealthAcceptable: boolean;
  noActiveCircuitBreakers: boolean;
}

export function isLiveTradingAllowed(mode: TradingMode, authorization: LiveTradingAuthorization): boolean {
  return mode === 'LIVE' && Object.values(authorization).every((condition) => condition === true);
}

export * from './command-bus.js';
export * from './realtime-events.js';
