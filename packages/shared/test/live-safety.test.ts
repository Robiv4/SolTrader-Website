import { describe, expect, it } from 'vitest';

import { isLiveTradingAllowed, type LiveTradingAuthorization } from '../src/index.js';

const readyAuthorization: LiveTradingAuthorization = {
  userAuthenticated: true,
  userLiveEnabled: true,
  serverLiveTradingEnabled: true,
  liveApprovalCompleted: true,
  dedicatedTradingWalletConfigured: true,
  walletSecretAvailable: true,
  walletNetworkCorrect: true,
  rpcHealthy: true,
  executionProviderHealthy: true,
  marketDataHealthy: true,
  riskEngineHealthy: true,
  positionManagerHealthy: true,
  dailyLossLimitConfigured: true,
  maxPositionConfigured: true,
  maxSlippageConfigured: true,
  maxExposureConfigured: true,
  emergencyStopClear: true,
  noUnresolvedTransaction: true,
  systemHealthAcceptable: true,
  noActiveCircuitBreakers: true,
};

describe('shared LIVE authorization', () => {
  it('requires every independent safety condition', () => {
    expect(isLiveTradingAllowed('LIVE', readyAuthorization)).toBe(true);

    for (const key of Object.keys(readyAuthorization) as Array<keyof LiveTradingAuthorization>) {
      expect(isLiveTradingAllowed('LIVE', { ...readyAuthorization, [key]: false }), `${key} must block LIVE`).toBe(false);
    }
  });

  it('does not treat a true server flag as sufficient authorization', () => {
    const authorization = {
      ...readyAuthorization,
      userAuthenticated: false,
      userLiveEnabled: false,
      liveApprovalCompleted: false,
    };
    expect(authorization.serverLiveTradingEnabled).toBe(true);
    expect(isLiveTradingAllowed('LIVE', authorization)).toBe(false);
    expect(isLiveTradingAllowed('PAPER', readyAuthorization)).toBe(false);
  });
});
