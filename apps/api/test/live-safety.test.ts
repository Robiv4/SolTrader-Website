import { describe, expect, it } from 'vitest';

import { LiveSafetyController, evaluateLiveSafety, type LiveSafetyState } from '../src/live-safety.js';

const readyState: LiveSafetyState = {
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

describe('live safety system', () => {
  it('passes only when every independent prerequisite is satisfied', () => {
    expect(evaluateLiveSafety(readyState).canEnable).toBe(true);

    for (const key of Object.keys(readyState) as Array<keyof LiveSafetyState>) {
      const report = evaluateLiveSafety({ ...readyState, [key]: false });
      expect(report.canEnable, `${key} should block LIVE`).toBe(false);
      expect(report.failedChecks).not.toHaveLength(0);
      expect(report.status).toBe('LIVE BLOCKED');
    }
  });

  it('does not allow the server setting alone to enable LIVE', () => {
    const report = evaluateLiveSafety({
      ...readyState,
      userAuthenticated: false,
      userLiveEnabled: false,
      liveApprovalCompleted: false,
    });

    expect(report.canEnable).toBe(false);
    expect(report.failedChecks).toEqual(expect.arrayContaining([
      'USER_AUTHENTICATED',
      'USER_LIVE_ENABLED',
      'LIVE_APPROVAL_COMPLETED',
    ]));
  });

  it('offers final confirmation only when every non-user-action check passes', () => {
    const report = evaluateLiveSafety({ ...readyState, userLiveEnabled: false, liveApprovalCompleted: false });
    expect(report.canEnable).toBe(false);
    expect(report.canRequestEnable).toBe(true);
    expect(evaluateLiveSafety({ ...readyState, rpcHealthy: false, userLiveEnabled: false, liveApprovalCompleted: false }).canRequestEnable).toBe(false);
  });

  it('blocks entries after circuit breakers and emergency stop', () => {
    const controller = new LiveSafetyController();
    controller.tripCircuitBreaker('RPC', 'RPC degraded');
    expect(evaluateLiveSafety(readyState, controller).failedChecks).toContain('NO_ACTIVE_CIRCUIT_BREAKERS');
    controller.resetCircuitBreaker('RPC');
    controller.activateEmergencyStop();
    expect(evaluateLiveSafety(readyState, controller).failedChecks).toContain('EMERGENCY_STOP_CLEAR');
  });
});