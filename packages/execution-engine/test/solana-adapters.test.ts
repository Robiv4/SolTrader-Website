import { describe, expect, it } from 'vitest';

import { JupiterExecutionProvider, SolanaRpcAdapter, liveExecutionConfigFromSafety } from '../src/index.js';

describe('LIVE execution configuration gate', () => {
  it('requires an explicit passed safety gate in addition to the server flag', () => {
    expect(liveExecutionConfigFromSafety('LIVE', true).enabled).toBe(false);
    expect(liveExecutionConfigFromSafety('LIVE', true, true).enabled).toBe(true);
    expect(liveExecutionConfigFromSafety('PAPER', true, true).enabled).toBe(false);
  });
});

describe('Solana RPC execution adapter', () => {
  it('broadcasts with RPC retries disabled and reconciles by signature', async () => {
    const methods: string[] = [];
    const adapter = new SolanaRpcAdapter({
      endpoint: 'https://rpc.example.test',
      fetcher: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
        methods.push(body.method);
        if (body.method === 'sendTransaction') {
          expect((body.params[1] as { maxRetries: number }).maxRetries).toBe(0);
          return new Response(JSON.stringify({ result: 'chain-signature' }), { status: 200 });
        }
        return new Response(JSON.stringify({ result: { value: [{ err: null, confirmationStatus: 'confirmed' }] } }), { status: 200 });
      },
    });
    const signature = await adapter.broadcast({ quoteId: 'q', serialized: 'signed-base64', signature: 'local-signature' });
    expect(signature).toBe('chain-signature');
    expect(await adapter.confirm(signature)).toBe(true);
    expect(await adapter.lookupSubmission('idem', signature)).toBe('CONFIRMED');
    expect(methods).toEqual(['sendTransaction', 'getSignatureStatuses', 'getSignatureStatuses']);
  });
});

describe('Jupiter provider adapter', () => {
  it('maps provider quote/build responses behind the generic execution contract', async () => {
    const requests: Array<{ url: string; body?: Record<string, unknown> }> = [];
    const rpc = new SolanaRpcAdapter({ endpoint: 'https://rpc.example.test', fetcher: async () => new Response(JSON.stringify({ result: 'ok' }), { status: 200 }) });
    const provider = new JupiterExecutionProvider({
      baseUrl: 'https://jupiter.example.test/swap/v1',
      rpc,
      fetcher: async (input, init) => {
        const url = String(input);
        const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
        requests.push({ url, body });
        if (url.includes('/quote?')) {
          return new Response(JSON.stringify({ inputMint: 'IN', outputMint: 'OUT', inAmount: '1000000', outAmount: '2500000', otherAmountThreshold: '2487500', priceImpactPct: '0.001', routePlan: [{ swapInfo: { ammKey: 'pool-1' } }] }), { status: 200 });
        }
        return new Response(JSON.stringify({ swapTransaction: 'unsigned-base64', computeUnitLimit: 180_000, prioritizationFeeLamports: 400 }), { status: 200 });
      },
    });
    const request = { idempotencyKey: 'idem-1', tokenIn: 'IN', tokenOut: 'OUT', amountIn: 1_000_000, maxSlippagePercent: 0.5, riskApproved: true, walletBalance: 5_000_000, walletAddress: '9xQ7QfL54wA7pM9JqimGJmP4XhQ5v1VJz2aS2b3s1Q4' };
    const quote = await provider.requestQuote(request);
    expect(quote.priceImpactPercent).toBe(0.1);
    expect(await provider.validateRoute(quote, provider.selectRoute(quote))).toMatchObject({ valid: true });
    const built = await provider.build(request, quote, quote.route, 400);
    expect(built).toMatchObject({ serialized: 'unsigned-base64', computeUnitLimit: 180_000, priorityFeeLamports: 400, minimumAcceptableOutput: 2_487_500 });
    expect(requests[1].body?.userPublicKey).toBe(request.walletAddress);
  });
});