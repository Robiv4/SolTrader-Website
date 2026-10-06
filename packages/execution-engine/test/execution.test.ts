import { describe, expect, it } from 'vitest';

import {
  DEFAULT_EXECUTION_CONFIG,
  ExecutionEngine,
  calculatePriorityFee,
  type BuiltTransaction,
  type ExecutionQuote,
  type ExecutionRequest,
} from '../src/index.js';

const request: ExecutionRequest = {
  idempotencyKey: 'order-1',
  tokenIn: 'SOL',
  tokenOut: 'TOKEN',
  amountIn: 10,
  maxSlippagePercent: 1,
  riskApproved: true,
  walletBalance: 100,
  requestedAt: new Date('2026-09-23T10:00:00.000Z'),
};

const quote: ExecutionQuote = {
  id: 'quote-1',
  requestKey: 'order-1',
  route: ['SOL', 'TOKEN'],
  amountIn: 10,
  expectedOutput: 100,
  referencePrice: 10,
  priceImpactPercent: 1,
  quotedAt: new Date('2026-09-23T10:00:00.000Z'),
  expiresAt: new Date('2026-09-23T10:00:05.000Z'),
};

function engine(overrides: Partial<{
  quote: ExecutionQuote;
  healthy: boolean;
  simulationOk: boolean;
  config: typeof DEFAULT_EXECUTION_CONFIG;
}> = {}) {
  const built: BuiltTransaction = { quoteId: 'quote-1', serialized: 'unsigned', computeUnitLimit: 200_000, priorityFeeLamports: 5_000, minimumAcceptableOutput: 0 };
  return new ExecutionEngine(
    { requestQuote: async () => overrides.quote ?? quote },
    { selectRoute: (selected) => selected.route },
    { build: async (_request, selected, route, fee) => ({ ...built, quoteId: selected.id, serialized: route.join('>'), priorityFeeLamports: fee, minimumAcceptableOutput: selected.expectedOutput }) },
    { simulate: async () => ({ ok: overrides.simulationOk ?? true }) },
    { sign: async () => ({ quoteId: 'quote-1', serialized: 'signed', signature: 'sig' }) },
    { broadcast: async () => 'sig', confirm: async () => true },
    { isHealthy: async () => overrides.healthy ?? true },
    { getRecommendedPriorityFeeLamports: async () => 5_000 },
    overrides.config ?? DEFAULT_EXECUTION_CONFIG,
  );
}

describe('execution safety gates', () => {
  it('keeps LIVE disabled before signing and broadcast', async () => {
    const live = engine({ config: { ...DEFAULT_EXECUTION_CONFIG, mode: 'LIVE' } });
    const result = await live.execute(request);
    expect(result.state).toBe('CANCELLED');
    expect(result.failure?.classification).toBe('LIVE_DISABLED');
  });

  it('rejects stale quotes, excessive price impact, slippage, risk, and balance failures', async () => {
    const stale = await engine({ quote: { ...quote, expiresAt: new Date('2026-09-23T09:59:00.000Z') } }).execute(request);
    expect(stale.failure?.classification).toBe('QUOTE_STALE');

    const impact = await engine({ quote: { ...quote, priceImpactPercent: 5 } }).execute(request);
    expect(impact.failure?.classification).toBe('PRICE_IMPACT_TOO_HIGH');

    const slippage = await engine().execute({ ...request, maxSlippagePercent: 5 });
    expect(slippage.failure?.classification).toBe('SLIPPAGE_TOO_HIGH');

    const risk = await engine().execute({ ...request, riskApproved: false });
    expect(risk.failure?.classification).toBe('RISK_LIMIT');

    const balance = await engine().execute({ ...request, walletBalance: 1 });
    expect(balance.failure?.classification).toBe('INSUFFICIENT_BALANCE');
  });

  it('rejects unhealthy RPC and failed simulation', async () => {
    const unhealthy = await engine({ healthy: false }).execute(request);
    expect(unhealthy.failure?.classification).toBe('RPC_UNHEALTHY');

    const simulation = await engine({ simulationOk: false }).execute(request);
    expect(simulation.failure?.classification).toBe('SIMULATION_FAILED');
  });
});

describe('execution lifecycle', () => {
  it('builds and simulates paper execution with minimum output and priority fee', async () => {
    const result = await engine().execute(request);
    expect(result.state).toBe('SIMULATED');
    expect(result.built?.serialized).toBe('SOL>TOKEN');
    expect(result.built?.priorityFeeLamports).toBe(5_000);
    expect(result.built?.minimumAcceptableOutput).toBe(99);
  });

  it('prevents duplicate execution and never signs paper transactions', async () => {
    const instance = engine();
    const first = await instance.execute(request);
    const second = await instance.execute(request);
    expect(second).toBe(first);
    const signed = await instance.signAndBroadcast(request.idempotencyKey);
    expect(signed.state).toBe('FAILED');
    expect(signed.failure?.classification).toBe('LIVE_DISABLED');
  });

  it('supports fixed, dynamic, and capped priority fee modes', () => {
    expect(calculatePriorityFee({ ...DEFAULT_EXECUTION_CONFIG, priorityFeeMode: 'FIXED', fixedPriorityFeeLamports: 100 }, 500)).toBe(100);
    expect(calculatePriorityFee({ ...DEFAULT_EXECUTION_CONFIG, priorityFeeMode: 'DYNAMIC' }, 500)).toBe(500);
    expect(calculatePriorityFee({ ...DEFAULT_EXECUTION_CONFIG, priorityFeeMode: 'CAPPED', maxPriorityFeeLamports: 300 }, 500)).toBe(300);
  });

  it('retries only configured safe failures', async () => {
    let healthChecks = 0;
    const instance = new ExecutionEngine(
      { requestQuote: async () => quote },
      { selectRoute: (selected) => selected.route },
      { build: async () => ({ quoteId: 'quote-1', serialized: 'unsigned', computeUnitLimit: 200_000, priorityFeeLamports: 1, minimumAcceptableOutput: 1 }) },
      { simulate: async () => ({ ok: true }) },
      { sign: async () => ({ quoteId: 'quote-1', serialized: 'signed', signature: 'sig' }) },
      { broadcast: async () => 'sig', confirm: async () => true },
      { isHealthy: async () => { healthChecks += 1; return healthChecks > 1; } },
      undefined,
      DEFAULT_EXECUTION_CONFIG,
    );
    const retried = await instance.executeWithSafeRetry(request, 2);
    expect(retried.state).toBe('SIMULATED');
    expect(healthChecks).toBe(2);

    const stale = await engine({ quote: { ...quote, expiresAt: new Date('2026-09-23T09:59:00.000Z') } }).executeWithSafeRetry(request, 2);
    expect(stale.failure?.classification).toBe('QUOTE_STALE');
  });
});
