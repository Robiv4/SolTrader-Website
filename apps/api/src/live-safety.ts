export type LiveSafetyCheckName =
  | 'USER_AUTHENTICATED'
  | 'USER_LIVE_ENABLED'
  | 'SERVER_LIVE_TRADING_ENABLED'
  | 'LIVE_APPROVAL_COMPLETED'
  | 'DEDICATED_TRADING_WALLET'
  | 'WALLET_SECRET_AVAILABLE'
  | 'WALLET_NETWORK_CORRECT'
  | 'RPC_HEALTHY'
  | 'EXECUTION_PROVIDER_HEALTHY'
  | 'MARKET_DATA_HEALTHY'
  | 'RISK_ENGINE_HEALTHY'
  | 'POSITION_MANAGER_HEALTHY'
  | 'DAILY_LOSS_LIMIT_CONFIGURED'
  | 'MAX_POSITION_CONFIGURED'
  | 'MAX_SLIPPAGE_CONFIGURED'
  | 'MAX_EXPOSURE_CONFIGURED'
  | 'EMERGENCY_STOP_CLEAR'
  | 'NO_UNRESOLVED_TRANSACTION'
  | 'SYSTEM_HEALTH_ACCEPTABLE'
  | 'NO_ACTIVE_CIRCUIT_BREAKERS';

export type LiveSafetyState = import('@soltrader/shared').LiveTradingAuthorization;

export interface LiveSafetyCheck {
  name: LiveSafetyCheckName;
  passed: boolean;
  reason: string;
}

export interface LiveSafetyReport {
  canEnable: boolean;
  canRequestEnable: boolean;
  status: 'LIVE READY' | 'LIVE BLOCKED';
  checks: LiveSafetyCheck[];
  failedChecks: LiveSafetyCheckName[];
  blockingReasons: string[];
}

export type CircuitBreakerName = 'DAILY_LOSS' | 'EXPOSURE' | 'SLIPPAGE' | 'RPC' | 'EXECUTION_FAILURE';

export class LiveSafetyController {
  private readonly breakers = new Map<CircuitBreakerName, string>();
  private emergencyStopActive = false;

  tripCircuitBreaker(name: CircuitBreakerName, reason: string) {
    this.breakers.set(name, reason);
  }

  resetCircuitBreaker(name: CircuitBreakerName) {
    this.breakers.delete(name);
  }

  activateEmergencyStop(reason = 'Manual emergency stop activated') {
    this.emergencyStopActive = true;
    return { event: 'EMERGENCY_STOP_ACTIVATED', reason };
  }

  clearEmergencyStop() {
    this.emergencyStopActive = false;
  }

  get emergencyStop() {
    return this.emergencyStopActive;
  }

  get activeBreakers() {
    return new Map(this.breakers);
  }

  canOpenNewEntry() {
    return !this.emergencyStopActive && this.breakers.size === 0;
  }
}

export function evaluateLiveSafety(
  state: LiveSafetyState,
  controller: LiveSafetyController = new LiveSafetyController(),
): LiveSafetyReport {
  const checks: LiveSafetyCheck[] = [
    { name: 'USER_AUTHENTICATED', passed: state.userAuthenticated, reason: 'An authenticated user session is required.' },
    { name: 'USER_LIVE_ENABLED', passed: state.userLiveEnabled, reason: 'The authenticated user has not explicitly enabled LIVE mode.' },
    { name: 'SERVER_LIVE_TRADING_ENABLED', passed: state.serverLiveTradingEnabled, reason: 'Server-side LIVE trading is disabled.' },
    { name: 'LIVE_APPROVAL_COMPLETED', passed: state.liveApprovalCompleted, reason: 'Live trading approval has not been completed.' },
    { name: 'DEDICATED_TRADING_WALLET', passed: state.dedicatedTradingWalletConfigured, reason: 'An active dedicated BOT_TRADING wallet must be configured.' },
    { name: 'WALLET_SECRET_AVAILABLE', passed: state.walletSecretAvailable, reason: 'The wallet signing secret is not available from server-side secret management.' },
    { name: 'WALLET_NETWORK_CORRECT', passed: state.walletNetworkCorrect, reason: 'The BOT_TRADING wallet network does not match the configured RPC network.' },
    { name: 'RPC_HEALTHY', passed: state.rpcHealthy, reason: 'RPC health is not confirmed.' },
    { name: 'EXECUTION_PROVIDER_HEALTHY', passed: state.executionProviderHealthy, reason: 'The execution provider is not configured and healthy.' },
    { name: 'MARKET_DATA_HEALTHY', passed: state.marketDataHealthy, reason: 'Market-data health is not confirmed.' },
    { name: 'RISK_ENGINE_HEALTHY', passed: state.riskEngineHealthy, reason: 'Risk engine health is not confirmed.' },
    { name: 'POSITION_MANAGER_HEALTHY', passed: state.positionManagerHealthy, reason: 'Position manager health is not confirmed.' },
    { name: 'DAILY_LOSS_LIMIT_CONFIGURED', passed: state.dailyLossLimitConfigured, reason: 'A positive daily loss limit must be configured.' },
    { name: 'MAX_POSITION_CONFIGURED', passed: state.maxPositionConfigured, reason: 'A positive maximum position must be configured.' },
    { name: 'MAX_SLIPPAGE_CONFIGURED', passed: state.maxSlippageConfigured, reason: 'A positive maximum slippage limit must be configured.' },
    { name: 'MAX_EXPOSURE_CONFIGURED', passed: state.maxExposureConfigured, reason: 'A positive maximum exposure must be configured.' },
    { name: 'EMERGENCY_STOP_CLEAR', passed: state.emergencyStopClear && !controller.emergencyStop, reason: 'Emergency stop is active.' },
    { name: 'NO_UNRESOLVED_TRANSACTION', passed: state.noUnresolvedTransaction, reason: 'An unresolved LIVE transaction must be reconciled before trading.' },
    { name: 'SYSTEM_HEALTH_ACCEPTABLE', passed: state.systemHealthAcceptable, reason: 'System health is not acceptable for LIVE trading.' },
    { name: 'NO_ACTIVE_CIRCUIT_BREAKERS', passed: state.noActiveCircuitBreakers && controller.activeBreakers.size === 0, reason: 'One or more trading circuit breakers are active.' },
  ];

  const failed = checks.filter((check) => !check.passed);
  return {
    canEnable: failed.length === 0,
    canRequestEnable: failed.every((check) => check.name === 'USER_LIVE_ENABLED' || check.name === 'LIVE_APPROVAL_COMPLETED') && state.userAuthenticated,
    status: failed.length === 0 ? 'LIVE READY' : 'LIVE BLOCKED',
    checks,
    failedChecks: failed.map((check) => check.name),
    blockingReasons: failed.map((check) => check.reason),
  };
}

export function assertLiveEntryAllowed(report: LiveSafetyReport) {
  if (!report.canEnable) {
    throw new Error(`LIVE entry rejected: ${report.blockingReasons.join(' ')}`);
  }
}