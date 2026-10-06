import { describe, expect, it } from 'vitest';

import {
  DEFAULT_EXECUTION_CONFIG,
  MemoryExecutionAttemptStore,
  SafeLiveExecutionEngine,
  type BuiltTransaction,
  type ExecutionQuote,
  type LiveExecutionProvider,
  type LiveExecutionRequest,
  type ReconciliationBroadcaster,
} from '../src/index.js';

const request: LiveExecutionRequest = {
  idempotencyKey: 'live-test-1',
  tokenIn: 'So11111111111111111111111111111111111111112',
  tokenOut: 'TokenAddress',
  amountIn: 1,
  maxSlippagePercent: 0.5,
  riskApproved: true,
  riskEngineAvailable: true,
  walletBalance: 10,
  walletAddress: '9xQ7QfL54wA7pM9JqimGJmP4XhQ5v1VJz2aS2b3s1Q4',
  walletConfigurationValid: true,
};

const quote: ExecutionQuote = {
  id: 'quote-1',
  requestKey: request.idempotencyKey,
  route: [request.tokenIn, request.tokenOut],
  amountIn: 1,
  expectedOutput: 10,
  referencePrice: 10,
  priceImpactPercent: 0.1,
  quotedAt: new Date(),
  expiresAt: new Date(Date.now() + 10_000),
};

function fixture(options: { enabled?: boolean; gateAllowed?: boolean; broadcastThrows?: boolean; lookup?: 'NOT_FOUND' | 'SUBMITTED' | 'CONFIRMED' | 'FAILED' | 'UNKNOWN'; healthSequence?: boolean[]; retryableFailures?: typeof DEFAULT_EXECUTION_CONFIG.retryableFailures } = {}) {
  let signatures = 0;
  let broadcasts = 0;
  let lookups = 0;
  let healthChecks = 0;
  const built: BuiltTransaction = { quoteId: quote.id, serialized: 'unsigned-bytes', computeUnitLimit: 200_000, priorityFeeLamports: 500, minimumAcceptableOutput: 9.95 };
  const provider: LiveExecutionProvider = {
    requestQuote: async (value) => ({ ...quote, requestKey: value.idempotencyKey }),
    selectRoute: (value) => value.route,
    validateRoute: async () => ({ valid: true }),
    build: async () => built,
    simulate: async () => ({ ok: true }),
    isHealthy: async () => options.healthSequence ? options.healthSequence[healthChecks++] ?? false : true,
    getRecommendedPriorityFeeLamports: async () => 500,
  };
  const broadcaster: ReconciliationBroadcaster = {
    async broadcast() { broadcasts += 1; if (options.broadcastThrows) throw new Error('RPC timeout after send'); return 'signature-1'; },
    async confirm() { return true; },
    async lookupSubmission() { lookups += 1; return options.lookup ?? 'UNKNOWN'; },
  };
  const engine = new SafeLiveExecutionEngine({
    provider,
    signer: { async sign(value) { signatures += 1; return { quoteId: value.quoteId, serialized: 'signed-bytes', signature: 'local-signature' }; } },
    broadcaster,
    store: new MemoryExecutionAttemptStore(),
    safetyGate: { check: async () => ({ allowed: options.gateAllowed ?? true }) },
    config: { ...DEFAULT_EXECUTION_CONFIG, mode: 'LIVE', enabled: options.enabled ?? false, maxAttempts: 2, retryableFailures: options.retryableFailures ?? [] },
  });
  return { engine, get signatures() { return signatures; }, get broadcasts() { return broadcasts; }, get lookups() { return lookups; } };
}

describe('strict LIVE execution gate', () => {
  it('is disabled by default and never signs or broadcasts', async () => {
    const test = fixture();
    const result = await test.engine.execute('user-1', request);
    expect(result.state).toBe('FAILED');
    expect(result.failure?.classification).toBe('LIVE_DISABLED');
    expect(test.signatures).toBe(0);
    expect(test.broadcasts).toBe(0);
  });

  it('rejects unavailable risk and invalid wallet before obtaining a quote', async () => {
    const test = fixture({ enabled: true });
    const noRisk = await test.engine.execute('user-1', { ...request, idempotencyKey: 'risk-unavailable', riskEngineAvailable: false });
    expect(noRisk.failure?.classification).toBe('RISK_LIMIT');
    const badWallet = await test.engine.execute('user-1', { ...request, idempotencyKey: 'wallet-invalid', walletConfigurationValid: false });
    expect(badWallet.failure?.classification).toBe('LIVE_DISABLED');
    expect(test.signatures).toBe(0);
    expect(test.broadcasts).toBe(0);
  });

  it('marks broadcast timeouts UNKNOWN and reconciles without rebroadcasting', async () => {
    const test = fixture({ enabled: true, broadcastThrows: true, lookup: 'CONFIRMED' });
    const result = await test.engine.execute('user-1', request);
    expect(result.state).toBe('CONFIRMED');
    expect(test.signatures).toBe(1);
    expect(test.broadcasts).toBe(1);
    expect(test.lookups).toBe(1);
  });

  it('requires the safety gate to allow execution before signing', async () => {
    const test = fixture({ enabled: true, gateAllowed: false });
    const result = await test.engine.execute('user-1', request);
    expect(result.failure?.classification).toBe('LIVE_DISABLED');
    expect(test.signatures).toBe(0);
    expect(test.broadcasts).toBe(0);
  });

  it('retries a configured RPC health failure before signing only', async () => {
    const test = fixture({ enabled: true, healthSequence: [false, true], retryableFailures: ['RPC_UNHEALTHY'] });
    const result = await test.engine.executeWithSafeRetry('user-1', { ...request, idempotencyKey: 'safe-rpc-retry' });
    expect(result.failure).toBeUndefined();
    expect(result.state).toBe('CONFIRMED');
    expect(result.attempts).toBe(2);
    expect(test.signatures).toBe(1);
    expect(test.broadcasts).toBe(1);
  });
});
