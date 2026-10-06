import type {
  BuiltTransaction,
  ExecutionConfig,
  ExecutionQuote,
  ExecutionRequest,
  PriorityFeeOracle,
  SignedTransaction,
} from './index.js';
import { ExecutionError } from './index.js';
import type { LiveExecutionConfig, LiveExecutionProvider, ReconciliationBroadcaster, SubmissionStatus } from './live-execution.js';

function providerError(message: string, retryable = true) {
  return new ExecutionError(retryable ? 'UNKNOWN' : 'BUILD_FAILED', message, retryable);
}

export interface SolanaRpcAdapterOptions {
  endpoint: string;
  timeoutMs?: number;
  commitment?: 'processed' | 'confirmed' | 'finalized';
  fetcher?: typeof globalThis.fetch;
}

interface RpcEnvelope<T> {
  result?: T;
  error?: { code?: number; message?: string };
}

export class SolanaRpcAdapter implements ReconciliationBroadcaster, PriorityFeeOracle {
  private readonly fetcher: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private readonly commitment: string;
  private requestId = 0;

  constructor(private readonly options: SolanaRpcAdapterOptions) {
    this.fetcher = options.fetcher ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 8_000;
    this.commitment = options.commitment ?? 'confirmed';
  }

  private async rpc<T>(method: string, params: unknown[] = []): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetcher(this.options.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++this.requestId, method, params }),
        signal: controller.signal,
      });
      if (!response.ok) throw providerError(`Solana RPC returned HTTP ${response.status}`);
      const body = await response.json() as RpcEnvelope<T>;
      if (body.error) throw providerError(`Solana RPC ${method} failed: ${body.error.message ?? body.error.code ?? 'unknown error'}`);
      if (body.result === undefined) throw providerError(`Solana RPC ${method} returned no result`);
      return body.result;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw providerError(`Solana RPC ${method} timed out`);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async isHealthy() {
    try { return (await this.rpc<string>('getHealth')) === 'ok'; } catch { return false; }
  }

  async getRecommendedPriorityFeeLamports() {
    const fees = await this.rpc<Array<{ prioritizationFee?: number }>>('getRecentPrioritizationFees');
    const valid = fees.map((fee) => fee.prioritizationFee).filter((fee): fee is number => typeof fee === 'number' && Number.isFinite(fee) && fee >= 0).sort((left, right) => left - right);
    return valid.length ? valid[Math.floor(valid.length * 0.75)] : 0;
  }

  async simulate(transaction: BuiltTransaction) {
    try {
      const response = await this.rpc<{ value?: Array<{ err?: unknown; logs?: string[] }> }>('simulateTransaction', [transaction.serialized, {
        encoding: 'base64',
        commitment: this.commitment,
        sigVerify: false,
        replaceRecentBlockhash: true,
        minContextSlot: undefined,
      }]);
      const result = response.value?.[0];
      return result && !result.err ? { ok: true } : { ok: false, error: JSON.stringify(result?.err ?? 'No simulation result') };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async broadcast(transaction: SignedTransaction) {
    const signature = await this.rpc<string>('sendTransaction', [transaction.serialized, {
      encoding: 'base64',
      skipPreflight: false,
      preflightCommitment: this.commitment,
      maxRetries: 0,
    }]);
    return signature;
  }

  async confirm(signature: string) {
    const status = await this.signatureStatus(signature);
    return status === 'CONFIRMED';
  }

  async lookupSubmission(_idempotencyKey: string, signature?: string): Promise<SubmissionStatus> {
    if (!signature) return 'UNKNOWN';
    return this.signatureStatus(signature);
  }

  private async signatureStatus(signature: string): Promise<SubmissionStatus> {
    const result = await this.rpc<{ value?: Array<{ err?: unknown; confirmationStatus?: string } | null> }>('getSignatureStatuses', [[signature], { searchTransactionHistory: true }]);
    const status = result.value?.[0];
    if (!status) return 'NOT_FOUND';
    if (status.err) return 'FAILED';
    if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') return 'CONFIRMED';
    return 'SUBMITTED';
  }
}

export interface JupiterAdapterOptions {
  baseUrl?: string;
  apiKey?: string;
  timeoutMs?: number;
  priceImpactIsFraction?: boolean;
  fetcher?: typeof globalThis.fetch;
  rpc: SolanaRpcAdapter;
}

interface JupiterQuoteResponse {
  inputMint?: string;
  outputMint?: string;
  inAmount?: string;
  outAmount?: string;
  otherAmountThreshold?: string;
  priceImpactPct?: string | number;
  routePlan?: Array<{ swapInfo?: { ammKey?: string; label?: string } }>;
  [key: string]: unknown;
}

/** Jupiter-specific HTTP translation stays contained behind the provider-neutral LiveExecutionProvider contract. */
export class JupiterExecutionProvider implements LiveExecutionProvider {
  private readonly baseUrl: string;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private readonly impactMultiplier: number;

  constructor(private readonly options: JupiterAdapterOptions) {
    this.baseUrl = (options.baseUrl ?? 'https://api.jup.ag/swap/v1').replace(/\/$/, '');
    this.fetcher = options.fetcher ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 8_000;
    this.impactMultiplier = options.priceImpactIsFraction === false ? 1 : 100;
  }

  private async request<T>(url: URL, init?: RequestInit): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetcher(url, {
        ...init,
        signal: controller.signal,
        headers: { ...(this.options.apiKey ? { 'x-api-key': this.options.apiKey } : {}), ...init?.headers },
      });
      if (response.status === 429 || response.status >= 500) throw providerError(`Jupiter returned HTTP ${response.status}`);
      if (!response.ok) throw providerError(`Jupiter returned HTTP ${response.status}`, false);
      return await response.json() as T;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw providerError('Jupiter request timed out');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async requestQuote(request: ExecutionRequest): Promise<ExecutionQuote> {
    const url = new URL(`${this.baseUrl}/quote`);
    url.searchParams.set('inputMint', request.tokenIn);
    url.searchParams.set('outputMint', request.tokenOut);
    url.searchParams.set('amount', String(Math.floor(request.amountIn)));
    url.searchParams.set('slippageBps', String(Math.floor(request.maxSlippagePercent * 100)));
    const quote = await this.request<JupiterQuoteResponse>(url);
    const amountIn = Number(quote.inAmount);
    const output = Number(quote.outAmount);
    const impact = Number(quote.priceImpactPct);
    if (quote.inputMint !== request.tokenIn || quote.outputMint !== request.tokenOut || !Number.isFinite(amountIn) || !Number.isFinite(output) || output <= 0 || !Number.isFinite(impact)) {
      throw providerError('Jupiter returned an invalid or mismatched quote', false);
    }
    const now = new Date();
    return {
      id: `${request.idempotencyKey}:${now.getTime()}`,
      requestKey: request.idempotencyKey,
      route: (quote.routePlan ?? []).map((step) => step.swapInfo?.ammKey ?? step.swapInfo?.label ?? '').filter(Boolean),
      amountIn,
      expectedOutput: output,
      referencePrice: output / amountIn,
      priceImpactPercent: impact * this.impactMultiplier,
      quotedAt: now,
      expiresAt: new Date(now.getTime() + this.timeoutMs),
      providerData: quote,
    };
  }

  selectRoute(quote: ExecutionQuote) { return [...quote.route]; }

  async validateRoute(quote: ExecutionQuote, route: string[]) {
    const source = quote.providerData as JupiterQuoteResponse | undefined;
    const expected = (source?.routePlan ?? []).map((step) => step.swapInfo?.ammKey ?? step.swapInfo?.label ?? '').filter(Boolean);
    const valid = expected.length > 0 && route.length === expected.length && route.every((part, index) => part === expected[index]);
    return { valid, reason: valid ? undefined : 'Jupiter route is empty or differs from the quoted route.' };
  }

  async build(request: ExecutionRequest, quote: ExecutionQuote, route: string[], priorityFeeLamports: number): Promise<BuiltTransaction> {
    if (!request.walletAddress) throw providerError('A server-validated wallet address is required to build a live swap', false);
    const routeCheck = await this.validateRoute(quote, route);
    if (!routeCheck.valid) throw providerError(routeCheck.reason ?? 'Invalid route', false);
    const response = await this.request<{ swapTransaction?: string; prioritizationFeeLamports?: number; computeUnitLimit?: number }>(new URL(`${this.baseUrl}/swap`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        quoteResponse: quote.providerData,
        userPublicKey: request.walletAddress,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: priorityFeeLamports,
      }),
    });
    if (!response.swapTransaction) throw providerError('Jupiter did not return a serialized transaction');
    const minimumAcceptableOutput = Number((quote.providerData as JupiterQuoteResponse | undefined)?.otherAmountThreshold ?? quote.expectedOutput);
    return {
      quoteId: quote.id,
      serialized: response.swapTransaction,
      computeUnitLimit: response.computeUnitLimit ?? 0,
      priorityFeeLamports: response.prioritizationFeeLamports ?? priorityFeeLamports,
      minimumAcceptableOutput,
    };
  }

  simulate(transaction: BuiltTransaction) { return this.options.rpc.simulate(transaction); }
  isHealthy() { return this.options.rpc.isHealthy(); }
  getRecommendedPriorityFeeLamports() { return this.options.rpc.getRecommendedPriorityFeeLamports(); }
}

export function liveExecutionConfigFromSafety(mode: 'PAPER' | 'LIVE', serverLiveTradingEnabled: boolean, safetyGatePassed = false, overrides: Partial<LiveExecutionConfig> = {}): LiveExecutionConfig {
  return {
    enabled: mode === 'LIVE' && serverLiveTradingEnabled === true && safetyGatePassed === true,
    mode,
    quoteMaxAgeMs: overrides.quoteMaxAgeMs ?? 10_000,
    maxPriceImpactPercent: overrides.maxPriceImpactPercent ?? 3,
    maxSlippagePercent: overrides.maxSlippagePercent ?? 3,
    priorityFeeMode: overrides.priorityFeeMode ?? 'CAPPED',
    fixedPriorityFeeLamports: overrides.fixedPriorityFeeLamports ?? 1_000,
    maxPriorityFeeLamports: overrides.maxPriorityFeeLamports ?? 10_000,
    retryableFailures: overrides.retryableFailures ?? ['RPC_UNHEALTHY'],
    maxAttempts: overrides.maxAttempts ?? 1,
  };
}
