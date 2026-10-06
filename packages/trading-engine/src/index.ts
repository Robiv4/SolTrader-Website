import { DEFAULT_TRADING_MODE, type LiveTradingAuthorization, type TradingMode, isLiveTradingAllowed } from '@soltrader/shared';

export interface TradeDecision {
  mode: TradingMode;
  action: 'scan' | 'paper' | 'semi-auto' | 'live' | 'blocked';
  reason: string;
  liveAllowed: boolean;
}

export function createTradeDecision(mode: TradingMode, authorization: LiveTradingAuthorization): TradeDecision {
  const safeMode = mode ?? DEFAULT_TRADING_MODE;
  const liveAllowed = isLiveTradingAllowed(safeMode, authorization);

  return {
    mode: safeMode,
    action: safeMode === 'LIVE' ? liveAllowed ? 'live' : 'blocked' : safeMode === 'SEMI_AUTO' ? 'semi-auto' : safeMode === 'PAPER' ? 'paper' : 'scan',
    reason: safeMode === 'LIVE' && !liveAllowed ? 'LIVE is blocked by the multi-layer safety gate.' : 'Mode-based routing approved by the trading engine.',
    liveAllowed,
  };
}

export * from './backtest.js';
export * from './paper-accounting.js';
export * from './exit-rules.js';
export * from './paper-fills.js';
export * from './exit-levels.js';
export * from './path-metrics.js';
export * from './launch-analysis.js';
export * from './launch-optimizer.js';
export * from './exit-latency.js';
export * from './exit-capacity.js';
