import crypto from 'node:crypto';

import { Prisma, type PrismaClient } from '@prisma/client';

import {
  calculatePriorityFee,
  ExecutionError,
  type BuiltTransaction,
  type ExecutionConfig,
  type ExecutionFailureClass,
  type ExecutionQuote,
  type ExecutionRecord,
  type ExecutionRequest,
  type PriorityFeeOracle,
  type QuoteProvider,
  type RouteSelector,
  type RpcHealthProbe,
  type SignedTransaction,
  type TransactionBroadcaster,
  type TransactionBuilder,
  type TransactionSimulator,
  type TradingWalletSigner,
} from './index.js';

export interface LiveExecutionRequest extends ExecutionRequest {
  walletAddress: string;
  walletConfigurationValid: boolean;
  riskEngineAvailable: boolean;
}

export interface LiveExecutionConfig extends ExecutionConfig {
  enabled: boolean;
  maxAttempts: number;
}

export const DEFAULT_LIVE_EXECUTION_CONFIG: LiveExecutionConfig = {
  mode: 'PAPER',
  enabled: false,
  quoteMaxAgeMs: 10_000,
  maxPriceImpactPercent: 3,
  maxSlippagePercent: 3,
  priorityFeeMode: 'CAPPED',
  fixedPriorityFeeLamports: 1_000,
  maxPriorityFeeLamports: 10_000,
  retryableFailures: ['RPC_UNHEALTHY'],
  maxAttempts: 2,
};

export type SubmissionStatus = 'NOT_FOUND' | 'SUBMITTED' | 'CONFIRMED' | 'FAILED' | 'UNKNOWN';

export interface ReconciliationBroadcaster extends TransactionBroadcaster {
  lookupSubmission(idempotencyKey: string, signature?: string): Promise<SubmissionStatus>;
}

export interface LiveExecutionSafetyGate {
  check(userId: string, request: LiveExecutionRequest): Promise<{ allowed: boolean; reason?: string }>;
}

export interface LiveExecutionProvider extends QuoteProvider, RouteSelector, TransactionBuilder, TransactionSimulator, RpcHealthProbe, PriorityFeeOracle {
  validateRoute(quote: ExecutionQuote, route: string[]): Promise<{ valid: boolean; reason?: string }>;
}

export interface PersistedExecutionAttempt {
  userId: string;
  idempotencyKey: string;
  requestFingerprint: string;
  request: LiveExecutionRequest;
  record: ExecutionRecord;
}

export interface ExecutionAttemptStore {
  get(userId: string, idempotencyKey: string): Promise<PersistedExecutionAttempt | null>;
  createIfAbsent(attempt: PersistedExecutionAttempt): Promise<{ attempt: PersistedExecutionAttempt; created: boolean }>;
  claimSafeRetry(attempt: PersistedExecutionAttempt, nextAttemptCount: number): Promise<boolean>;
  save(attempt: PersistedExecutionAttempt): Promise<void>;
}

function fingerprint(userId: string, request: LiveExecutionRequest) {
  return crypto.createHash('sha256').update(JSON.stringify({
    userId,
    idempotencyKey: request.idempotencyKey,
    tokenIn: request.tokenIn,
    tokenOut: request.tokenOut,
    amountIn: request.amountIn,
    maxSlippagePercent: request.maxSlippagePercent,
    walletAddress: request.walletAddress,
  })).digest('hex');
}

function serializeRecord(record: ExecutionRecord): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(record)) as Prisma.InputJsonValue;
}

function hydrateRecord(value: Prisma.JsonValue): ExecutionRecord {
  const raw = value as unknown as ExecutionRecord & { updatedAt: string; quote?: ExecutionQuote & { quotedAt: string; expiresAt: string } };
  return {
    ...raw,
    updatedAt: new Date(raw.updatedAt),
    quote: raw.quote ? { ...raw.quote, quotedAt: new Date(raw.quote.quotedAt), expiresAt: new Date(raw.quote.expiresAt) } : undefined,
  };
}

export class PrismaExecutionAttemptStore implements ExecutionAttemptStore {
  constructor(private readonly prisma: Pick<PrismaClient, 'executionAttempt'>) {}

  async get(userId: string, idempotencyKey: string): Promise<PersistedExecutionAttempt | null> {
    const row = await this.prisma.executionAttempt.findUnique({ where: { userId_idempotencyKey: { userId, idempotencyKey } } });
    if (!row) return null;
    return {
      userId,
      idempotencyKey,
      requestFingerprint: row.requestFingerprint,
      request: row.request as unknown as LiveExecutionRequest,
      record: hydrateRecord(row.record),
    };
  }

  async createIfAbsent(attempt: PersistedExecutionAttempt) {
    try {
      const row = await this.prisma.executionAttempt.create({ data: {
        userId: attempt.userId,
        idempotencyKey: attempt.idempotencyKey,
        requestFingerprint: attempt.requestFingerprint,
        state: attempt.record.state,
        attemptCount: attempt.record.attempts,
        transactionSignature: attempt.record.signed?.signature,
        request: attempt.request as unknown as Prisma.InputJsonValue,
        record: serializeRecord(attempt.record),
        lastError: attempt.record.failure?.message,
      } });
      return { attempt: { ...attempt, record: hydrateRecord(row.record) }, created: true };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const existing = await this.get(attempt.userId, attempt.idempotencyKey);
        if (existing) return { attempt: existing, created: false };
      }
      throw error;
    }
  }

  async save(attempt: PersistedExecutionAttempt) {
    await this.prisma.executionAttempt.update({
      where: { userId_idempotencyKey: { userId: attempt.userId, idempotencyKey: attempt.idempotencyKey } },
      data: {
        requestFingerprint: attempt.requestFingerprint,
        state: attempt.record.state,
        attemptCount: attempt.record.attempts,
        transactionSignature: attempt.record.signed?.signature,
        request: attempt.request as unknown as Prisma.InputJsonValue,
        record: serializeRecord(attempt.record),
        lastError: attempt.record.failure?.message ?? null,
      },
    });
  }

  async claimSafeRetry(attempt: PersistedExecutionAttempt, nextAttemptCount: number) {
    const claimed = await this.prisma.executionAttempt.updateMany({
      where: {
        userId: attempt.userId,
        idempotencyKey: attempt.idempotencyKey,
        state: 'FAILED',
        attemptCount: attempt.record.attempts,
        transactionSignature: null,
      },
      data: { state: 'CREATED', attemptCount: nextAttemptCount, lastError: null },
    });
    return claimed.count === 1;
  }
}

export class MemoryExecutionAttemptStore implements ExecutionAttemptStore {
  private readonly attempts = new Map<string, PersistedExecutionAttempt>();
  private key(userId: string, idempotencyKey: string) { return `${userId}:${idempotencyKey}`; }
  async get(userId: string, idempotencyKey: string) { return this.attempts.get(this.key(userId, idempotencyKey)) ?? null; }
  async createIfAbsent(attempt: PersistedExecutionAttempt) {
    const key = this.key(attempt.userId, attempt.idempotencyKey);
    const current = this.attempts.get(key);
    if (current) return { attempt: current, created: false };
    this.attempts.set(key, attempt);
    return { attempt, created: true };
  }
  async save(attempt: PersistedExecutionAttempt) { this.attempts.set(this.key(attempt.userId, attempt.idempotencyKey), attempt); }
  async claimSafeRetry(attempt: PersistedExecutionAttempt, nextAttemptCount: number) {
    const key = this.key(attempt.userId, attempt.idempotencyKey);
    const current = this.attempts.get(key);
    if (!current || current.record.state !== 'FAILED' || current.record.attempts !== attempt.record.attempts || current.record.signed) return false;
    void nextAttemptCount;
    return true;
  }
}

export interface LiveExecutionDependencies {
  provider: LiveExecutionProvider;
  signer: TradingWalletSigner;
  broadcaster: ReconciliationBroadcaster;
  store: ExecutionAttemptStore;
  safetyGate: LiveExecutionSafetyGate;
  config?: LiveExecutionConfig;
  now?: () => Date;
}

/** Fail-closed LIVE orchestrator. An UNKNOWN submission is only queried/reconciled, never rebroadcast. */
export class SafeLiveExecutionEngine {
  private readonly config: LiveExecutionConfig;
  private readonly now: () => Date;

  constructor(private readonly deps: LiveExecutionDependencies) {
    this.config = deps.config ?? DEFAULT_LIVE_EXECUTION_CONFIG;
    this.now = deps.now ?? (() => new Date());
    if (!Number.isFinite(this.config.maxSlippagePercent) || this.config.maxSlippagePercent < 0 || this.config.maxSlippagePercent > 100) throw new Error('Live maximum slippage must be finite and between 0 and 100 percent.');
    if (!Number.isFinite(this.config.maxPriceImpactPercent) || this.config.maxPriceImpactPercent < 0 || this.config.maxPriceImpactPercent > 100) throw new Error('Live maximum price impact must be finite and between 0 and 100 percent.');
    if (!Number.isInteger(this.config.maxAttempts) || this.config.maxAttempts < 1 || this.config.maxAttempts > 5) throw new Error('Live execution attempts must be between 1 and 5.');
  }

  async execute(userId: string, request: LiveExecutionRequest): Promise<ExecutionRecord> {
    const requestFingerprint = fingerprint(userId, request);
    let attempt = await this.deps.store.get(userId, request.idempotencyKey);
    if (attempt && attempt.requestFingerprint !== requestFingerprint) throw new ExecutionError('DUPLICATE', 'Idempotency key is already bound to a different request.');
    if (attempt && (attempt.record.state === 'UNKNOWN' || attempt.record.state === 'SIGNED' || attempt.record.state === 'SUBMITTED')) return this.reconcile(userId, request.idempotencyKey);
    if (attempt && attempt.record.state !== 'FAILED') return attempt.record;
    if (attempt && (attempt.record.signed || !attempt.record.failure?.classification || !this.config.retryableFailures.includes(attempt.record.failure.classification) || attempt.record.attempts >= this.config.maxAttempts)) return attempt.record;

    if (attempt) {
      const claimed = await this.deps.store.claimSafeRetry(attempt, attempt.record.attempts + 1);
      if (!claimed) return (await this.deps.store.get(userId, request.idempotencyKey))?.record ?? attempt.record;
      attempt.record.state = 'CREATED';
      attempt.record.failure = undefined;
      attempt.record.attempts += 1;
      await this.deps.store.save(attempt);
    } else {
      const initial: ExecutionRecord = { idempotencyKey: request.idempotencyKey, state: 'CREATED', attempts: 0, updatedAt: this.now() };
      const created = await this.deps.store.createIfAbsent({ userId, idempotencyKey: request.idempotencyKey, requestFingerprint, request, record: initial });
      attempt = created.attempt;
      if (!created.created) {
        if (attempt.requestFingerprint !== requestFingerprint) throw new ExecutionError('DUPLICATE', 'Idempotency key is already bound to a different request.');
        return attempt.record.state === 'UNKNOWN' || attempt.record.state === 'SIGNED' || attempt.record.state === 'SUBMITTED'
          ? this.reconcile(userId, request.idempotencyKey)
          : attempt.record;
      }
    }
    const record = attempt.record;

    const persist = async () => {
      record.updatedAt = this.now();
      await this.deps.store.save({ userId, idempotencyKey: request.idempotencyKey, requestFingerprint, request, record });
    };
    const fail = async (classification: ExecutionFailureClass, message: string) => {
      record.state = 'FAILED';
      record.failure = { classification, message };
      await persist();
      return record;
    };
    const setState = async (state: ExecutionRecord['state']) => { record.state = state; await persist(); };

    if (!this.config.enabled || this.config.mode !== 'LIVE') return fail('LIVE_DISABLED', 'Live execution is disabled by server configuration.');
    if (!request.idempotencyKey || !Number.isFinite(request.amountIn) || request.amountIn <= 0) return fail('RISK_LIMIT', 'Execution request is invalid.');
    if (!request.riskEngineAvailable || !request.riskApproved) return fail('RISK_LIMIT', 'Risk engine approval is required and must be available.');
    if (!request.walletConfigurationValid || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(request.walletAddress)) return fail('LIVE_DISABLED', 'Trading wallet configuration is invalid.');
    if (!Number.isFinite(request.walletBalance) || request.walletBalance < request.amountIn) return fail('INSUFFICIENT_BALANCE', 'Wallet balance is insufficient.');
    if (!Number.isFinite(request.maxSlippagePercent) || request.maxSlippagePercent < 0 || request.maxSlippagePercent > this.config.maxSlippagePercent) return fail('SLIPPAGE_TOO_HIGH', 'Requested slippage exceeds the configured cap.');

    try {
      if (record.attempts === 0) record.attempts = 1;
      await persist();
      const gate = await this.deps.safetyGate.check(userId, request);
      if (!gate.allowed) return fail('LIVE_DISABLED', gate.reason ?? 'Live safety gate rejected execution.');
      if (!(await this.deps.provider.isHealthy())) return fail('RPC_UNHEALTHY', 'RPC health check failed.');

      const quote = await this.deps.provider.requestQuote(request);
      record.quote = quote;
      await setState('QUOTED');
      const now = this.now();
      if (quote.requestKey !== request.idempotencyKey || quote.amountIn !== request.amountIn || !Number.isFinite(quote.expectedOutput) || quote.expectedOutput <= 0) return fail('QUOTE_STALE', 'Quote does not match the request or has invalid amounts.');
      if (quote.quotedAt.getTime() > now.getTime() || quote.expiresAt.getTime() <= now.getTime() || now.getTime() - quote.quotedAt.getTime() > this.config.quoteMaxAgeMs) return fail('QUOTE_STALE', 'Quote is stale or expired.');
      if (!Number.isFinite(quote.priceImpactPercent) || quote.priceImpactPercent < 0 || quote.priceImpactPercent > this.config.maxPriceImpactPercent) return fail('PRICE_IMPACT_TOO_HIGH', 'Quote price impact exceeds the configured cap.');
      const route = this.deps.provider.selectRoute(quote);
      if (route.length === 0 || !(await this.deps.provider.validateRoute(quote, route)).valid) return fail('BUILD_FAILED', 'Quote route is invalid.');

      const fee = calculatePriorityFee(this.config, await this.deps.provider.getRecommendedPriorityFeeLamports());
      const minOutput = quote.expectedOutput * (1 - request.maxSlippagePercent / 100);
      if (!Number.isFinite(minOutput) || minOutput <= 0) return fail('SLIPPAGE_TOO_HIGH', 'Minimum acceptable output is invalid.');
      const built = await this.deps.provider.build(request, { ...quote, expectedOutput: minOutput }, route, fee);
      record.built = built;
      await setState('BUILT');
      const simulation = await this.deps.provider.simulate(built);
      if (!simulation.ok) return fail('SIMULATION_FAILED', simulation.error ?? 'Transaction simulation failed.');
      await setState('SIMULATED');

      const finalGate = await this.deps.safetyGate.check(userId, request);
      if (!finalGate.allowed) return fail('LIVE_DISABLED', finalGate.reason ?? 'Live safety gate rejected execution before signing.');
      const signed = await this.deps.signer.sign(built);
      record.signed = signed;
      await setState('SIGNED');

      let signature: string;
      try {
        signature = await this.deps.broadcaster.broadcast(signed);
      } catch (error) {
        record.state = 'UNKNOWN';
        record.failure = { classification: 'UNKNOWN', message: error instanceof Error ? error.message : 'Broadcast outcome is unknown.' };
        await persist();
        return this.reconcile(userId, request.idempotencyKey);
      }
      record.signed = { ...signed, signature };
      await setState('SUBMITTED');
      try {
        if (await this.deps.broadcaster.confirm(signature)) {
          await setState('CONFIRMED');
          return record;
        }
      } catch (error) {
        record.failure = { classification: 'UNKNOWN', message: error instanceof Error ? error.message : 'Confirmation outcome is unknown.' };
      }
      record.state = 'UNKNOWN';
      await persist();
      return this.reconcile(userId, request.idempotencyKey);
    } catch (error) {
      if (record.state === 'SIGNED' || record.state === 'SUBMITTED' || record.state === 'UNKNOWN') {
        record.state = 'UNKNOWN';
        record.failure = { classification: 'UNKNOWN', message: error instanceof Error ? error.message : String(error) };
        await persist();
        return record;
      }
      const classification = error instanceof ExecutionError ? error.classification : 'UNKNOWN';
      return fail(classification, error instanceof Error ? error.message : String(error));
    }
  }

  async reconcile(userId: string, idempotencyKey: string): Promise<ExecutionRecord> {
    const attempt = await this.deps.store.get(userId, idempotencyKey);
    if (!attempt) throw new ExecutionError('UNKNOWN', 'Execution attempt not found.');
    const record = attempt.record;
    if (record.state !== 'UNKNOWN' && record.state !== 'SUBMITTED') return record;
    const status = await this.deps.broadcaster.lookupSubmission(idempotencyKey, record.signed?.signature);
    if (status === 'CONFIRMED') { record.state = 'CONFIRMED'; record.failure = undefined; }
    else if (status === 'SUBMITTED') record.state = 'SUBMITTED';
    else if (status === 'FAILED') record.state = 'FAILED';
    else record.state = 'UNKNOWN';
    record.updatedAt = this.now();
    await this.deps.store.save({ ...attempt, record });
    return record;
  }

  async executeWithSafeRetry(userId: string, request: LiveExecutionRequest): Promise<ExecutionRecord> {
    let result = await this.execute(userId, request);
    while (
      result.state === 'FAILED'
      && !result.signed
      && result.failure?.classification
      && this.config.retryableFailures.includes(result.failure.classification)
      && result.attempts < this.config.maxAttempts
    ) {
      result = await this.execute(userId, request);
    }
    return result;
  }
}

