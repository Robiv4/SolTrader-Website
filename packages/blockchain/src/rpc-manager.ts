/**
 * SolanaRpcManager: the single owner of Solana JSON-RPC traffic in the worker.
 *
 * Design principle: make fewer requests (cache only what is safe, coalesce identical in-flight requests, batch
 * compatible account reads), prioritise critical traffic, stop sending traffic to unhealthy providers, and fail
 * safely (a failure is reported as a failure - never turned into a default value).
 *
 *  - Providers PRIMARY / SECONDARY / FALLBACK (1-3 configured), each with its own status, circuit breaker
 *    (CLOSED / OPEN / HALF_OPEN), cooldowns, learned method capabilities and metrics.
 *  - 429: exponential back-off with jitter (or Retry-After) on that provider - per METHOD when the provider says the
 *    limit is method specific ("Too many requests for a specific RPC call") - then fail over. Never a tight loop.
 *  - 401 / 403 / "API key is not allowed": FORBIDDEN (configuration error), out of rotation until a long recheck.
 *  - Timeout: bounded per attempt and by the logical request deadline; counts toward the circuit breaker.
 *  - "Request blocked" / method not found: that method is skipped on that provider for a while (capability map).
 *  - Invalid request: no failover (every provider would reject it the same way).
 *  - Retry budget: each provider is tried at most once per logical request (max `maxAttempts`), never a second lap.
 *  - Bounded priority queue with slots reserved for P0-P2; expired low-priority work is dropped, not executed.
 *
 * Secrets: provider URLs are never logged or exported; providers are identified by name + host (masked when the
 * host itself looks like a credential).
 */

export const RPC_PRIORITY = {
  CRITICAL_EXIT: 0,
  EXECUTION: 1,
  SECURITY: 2,
  ACTIVE_POSITION: 3,
  ENRICHMENT: 4,
  BACKGROUND: 5,
} as const;
export type RpcPriority = (typeof RPC_PRIORITY)[keyof typeof RPC_PRIORITY];
export const RPC_PRIORITY_NAMES: Record<RpcPriority, string> = { 0: 'P0_CRITICAL_EXIT', 1: 'P1_EXECUTION', 2: 'P2_SECURITY', 3: 'P3_ACTIVE_POSITION', 4: 'P4_ENRICHMENT', 5: 'P5_BACKGROUND' };

export type RpcProviderRole = 'primary' | 'secondary' | 'fallback';
export type RpcProviderStatus = 'HEALTHY' | 'DEGRADED' | 'RATE_LIMITED' | 'FORBIDDEN' | 'TIMEOUT' | 'UNHEALTHY' | 'DISABLED';
export type RpcCircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';
export type RpcErrorKind = 'RATE_LIMITED' | 'FORBIDDEN' | 'TIMEOUT' | 'SERVER_ERROR' | 'METHOD_UNSUPPORTED' | 'INVALID_REQUEST' | 'NETWORK' | 'RPC_ERROR';

/** Data classes drive the cache policy. */
export type RpcDataClass = 'STATIC' | 'SLOW_CHANGING' | 'FAST_CHANGING' | 'CRITICAL_REALTIME';

interface MethodPolicy {
  dataClass: RpcDataClass;
  /** Default TTL (ms) when the caller does not choose one; 0 = not cached. */
  defaultTtlMs: number;
  /** Upper bound for a caller-provided TTL (0 = never cached, whatever the caller asks). */
  maxTtlMs: number;
  dedup: boolean;
}

/**
 * Cache policy per method. Prices, balances, liquidity, blockhashes, signature statuses, simulations and sends are
 * never cached (or only for a few hundred ms). Account data is not cached by default; callers opt in for data they
 * know to be slow-changing (e.g. mint accounts: authorities / program / extensions).
 */
export const RPC_METHOD_POLICY: Record<string, MethodPolicy> = {
  getAccountInfo: { dataClass: 'FAST_CHANGING', defaultTtlMs: 0, maxTtlMs: 60_000, dedup: true },
  getMultipleAccounts: { dataClass: 'FAST_CHANGING', defaultTtlMs: 0, maxTtlMs: 60_000, dedup: true },
  getTokenLargestAccounts: { dataClass: 'SLOW_CHANGING', defaultTtlMs: 30_000, maxTtlMs: 60_000, dedup: true },
  getTokenSupply: { dataClass: 'SLOW_CHANGING', defaultTtlMs: 30_000, maxTtlMs: 60_000, dedup: true },
  // A confirmed transaction is immutable (null results are not cached).
  getTransaction: { dataClass: 'STATIC', defaultTtlMs: 10 * 60_000, maxTtlMs: 60 * 60_000, dedup: true },
  getBlockTime: { dataClass: 'STATIC', defaultTtlMs: 10 * 60_000, maxTtlMs: 60 * 60_000, dedup: true },
  getGenesisHash: { dataClass: 'STATIC', defaultTtlMs: 60 * 60_000, maxTtlMs: 24 * 60 * 60_000, dedup: true },
  getVersion: { dataClass: 'STATIC', defaultTtlMs: 10 * 60_000, maxTtlMs: 60 * 60_000, dedup: true },
  getSlot: { dataClass: 'CRITICAL_REALTIME', defaultTtlMs: 400, maxTtlMs: 1_000, dedup: true },
  getHealth: { dataClass: 'CRITICAL_REALTIME', defaultTtlMs: 1_000, maxTtlMs: 5_000, dedup: true },
  getBalance: { dataClass: 'FAST_CHANGING', defaultTtlMs: 0, maxTtlMs: 2_000, dedup: true },
  getTokenAccountBalance: { dataClass: 'FAST_CHANGING', defaultTtlMs: 0, maxTtlMs: 2_000, dedup: true },
  getTokenAccountsByOwner: { dataClass: 'FAST_CHANGING', defaultTtlMs: 0, maxTtlMs: 2_000, dedup: true },
  getSignaturesForAddress: { dataClass: 'FAST_CHANGING', defaultTtlMs: 0, maxTtlMs: 1_000, dedup: true },
  getLatestBlockhash: { dataClass: 'CRITICAL_REALTIME', defaultTtlMs: 0, maxTtlMs: 0, dedup: true },
  getSignatureStatuses: { dataClass: 'CRITICAL_REALTIME', defaultTtlMs: 0, maxTtlMs: 0, dedup: true },
  simulateTransaction: { dataClass: 'CRITICAL_REALTIME', defaultTtlMs: 0, maxTtlMs: 0, dedup: false },
  sendTransaction: { dataClass: 'CRITICAL_REALTIME', defaultTtlMs: 0, maxTtlMs: 0, dedup: false },
};
const DEFAULT_POLICY: MethodPolicy = { dataClass: 'FAST_CHANGING', defaultTtlMs: 0, maxTtlMs: 0, dedup: true };
export const policyFor = (method: string) => RPC_METHOD_POLICY[method] ?? DEFAULT_POLICY;

export class RpcCallError extends Error {
  constructor(readonly kind: RpcErrorKind, message: string, readonly provider: string, readonly method: string, readonly retryAfterMs: number | null = null, readonly methodScoped = false) {
    super(message);
    this.name = 'RpcCallError';
  }
}

/** Every eligible provider failed (or none was eligible). `attempts` carries the per-provider reasons. */
export class RpcAllProvidersFailedError extends Error {
  constructor(readonly method: string, readonly attempts: Array<{ provider: string; kind: RpcErrorKind | 'SKIPPED'; message: string }>) {
    super(`All RPC providers failed: ${attempts.map((attempt) => `${attempt.provider}: ${attempt.message}`).join('; ') || 'no eligible provider'}`);
    this.name = 'RpcAllProvidersFailedError';
  }
}

/** Low-priority work dropped before execution (candidate expired, deadline passed, or queue overload). */
export class RpcRequestDroppedError extends Error {
  constructor(readonly reason: 'EXPIRED' | 'DEADLINE' | 'OVERLOAD') {
    super(`RPC request dropped: ${reason}`);
    this.name = 'RpcRequestDroppedError';
  }
}

export interface RpcTransportResponse {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}
export type RpcTransport = (input: { url: string; body: string; timeoutMs: number }) => Promise<RpcTransportResponse>;

/** fetch (undici) keeps HTTP connections alive and reuses them per origin: one manager = one connection pool. */
export const fetchTransport: RpcTransport = async ({ url, body, timeoutMs }) => globalThis.fetch(url, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: globalThis.AbortSignal.timeout(timeoutMs),
});

export interface RpcManagerLogger {
  warn(payload: unknown, message?: string): void;
  error?(payload: unknown, message?: string): void;
}

export interface RpcProviderConfig {
  role: RpcProviderRole;
  url: string;
}

export interface RpcManagerOptions {
  providers: RpcProviderConfig[];
  commitment?: string;
  /** Per-attempt timeout. */
  timeoutMs?: number;
  /** Logical request deadline per priority (ms). */
  deadlineMs?: Partial<Record<RpcPriority, number>>;
  maxConcurrency?: number;
  /** Slots only P0-P2 may use (scanner load cannot occupy them). */
  reservedCriticalSlots?: number;
  queueLimit?: number;
  maxAttempts?: number;
  cacheEnabled?: boolean;
  dedupEnabled?: boolean;
  batchingEnabled?: boolean;
  batchWindowMs?: number;
  maxBatchSize?: number;
  rateLimitBaseMs?: number;
  rateLimitMaxMs?: number;
  forbiddenRecheckMs?: number;
  methodUnsupportedMs?: number;
  circuitFailureThreshold?: number;
  circuitOpenMs?: number;
  /** Max requests per second per provider (0 = unlimited). Keep below the provider plan's limit. */
  maxRps?: number;
  transport?: RpcTransport;
  logger?: RpcManagerLogger;
  now?: () => number;
  random?: () => number;
}

export interface RpcRequestOptions {
  /** Module issuing the request (metrics / logs), e.g. "TokenScanner", "NewLaunchSecurity". */
  caller: string;
  priority: RpcPriority;
  /** Optional per-call cache TTL (bounded by the method policy). */
  cacheTtlMs?: number;
  /** The token / pool / account the request is for (requests-per-candidate accounting). */
  subject?: string | null;
  /** Checked before execution: false = the work is no longer useful (dropped, never sent). */
  isRelevant?: () => boolean;
  deadlineMs?: number;
  correlationId?: string;
  /** Allow batching into getMultipleAccounts (getAccountInfo only; never for P0/P1). Default true. */
  batchable?: boolean;
}

// ---------------------------------------------------------------------------------------------

class Percentiles {
  private values: number[] = [];
  constructor(private readonly size = 500) {}
  add(value: number) {
    this.values.push(value);
    if (this.values.length > this.size) this.values.shift();
  }
  summary() {
    if (!this.values.length) return { p50: null, p95: null, p99: null, count: 0 };
    const sorted = [...this.values].sort((a, b) => a - b);
    const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q))];
    return { p50: at(0.5), p95: at(0.95), p99: at(0.99), count: sorted.length };
  }
}

/** Events within the last 60 s (requests/min). */
class MinuteRate {
  private times: number[] = [];
  add(now: number) {
    this.times.push(now);
    if (this.times.length > 50_000) this.times.splice(0, this.times.length - 50_000);
  }
  count(now: number) {
    while (this.times.length && now - this.times[0] > 60_000) this.times.shift();
    return this.times.length;
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => globalThis.setTimeout(resolve, Math.max(0, ms)));

/** Deterministic JSON (sorted object keys) for dedup / cache keys. */
export function stableKey(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  if (Array.isArray(value)) return `[${value.map(stableKey).join(',')}]`;
  return `{${Object.keys(value as Record<string, unknown>).sort().filter((key) => (value as Record<string, unknown>)[key] !== undefined).map((key) => `${JSON.stringify(key)}:${stableKey((value as Record<string, unknown>)[key])}`).join(',')}}`;
}

/** Provider label without secrets: role + host (a credential-looking host label is masked). */
export function maskRpcUrl(url: string) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.split('.').map((label) => (label.length > 24 || /[0-9a-f]{16,}/i.test(label) ? '***' : label)).join('.');
    const hasSecretPart = parsed.pathname.split('/').some((segment) => segment.length > 16) || parsed.search.length > 0 || parsed.username || parsed.password;
    return `${parsed.protocol}//${host}${hasSecretPart ? '/***' : parsed.pathname === '/' ? '' : parsed.pathname}`;
  } catch {
    return 'invalid-url';
  }
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return url;
  }
};
const sanitize = (message: string) => message.replace(/https?:\/\/\S+/g, '[url]').replace(/[A-Za-z0-9_-]{32,}/g, '[redacted]').slice(0, 200);

interface ProviderState {
  role: RpcProviderRole;
  url: string;
  label: string;
  host: string;
  circuit: RpcCircuitState;
  openUntil: number;
  halfOpenProbe: boolean;
  consecutiveFailures: number;
  cooldownUntil: number;
  rateLimitStreak: number;
  forbiddenUntil: number;
  forbiddenReason: string | null;
  methodCooldownUntil: Map<string, number>;
  methodRateLimitStreak: Map<string, number>;
  unsupportedUntil: Map<string, number>;
  lastErrorKind: RpcErrorKind | null;
  lastError: string | null;
  lastErrorAt: number | null;
  lastSuccessAt: number | null;
  inFlight: number;
  /** Send times (incl. reserved future slots) within the last second, for the client-side RPS limit. */
  sendSlots: number[];
  outcomes: boolean[];
  latency: Percentiles;
  rate: MinuteRate;
  counters: { requests: number; success: number; rateLimited: number; forbidden: number; timeouts: number; serverErrors: number; unsupported: number; otherErrors: number };
  methods: Map<string, { requests: number; rateLimited: number; timeouts: number }>;
}

interface QueueEntry {
  priority: RpcPriority;
  seq: number;
  enqueuedAt: number;
  deadlineAt: number;
  isRelevant?: () => boolean;
  start: () => void;
  drop: (error: RpcRequestDroppedError) => void;
}

interface PendingBatchItem {
  pubkey: string;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  options: RpcRequestOptions;
}

type MethodMetrics = { logical: number; network: number; rateLimited: number; timeouts: number; cacheHits: number; dedupHits: number; batched: number; errors: number; latency: Percentiles };
type CallerMetrics = { logical: number; network: number; rateLimited: number; failures: number; cacheHits: number; dedupHits: number; dropped: number; subjects: Set<string> };

export class SolanaRpcManager {
  private readonly providers: ProviderState[];
  private readonly options: Required<Omit<RpcManagerOptions, 'providers' | 'logger' | 'deadlineMs' | 'commitment'>> & { commitment: string; deadlineMs: Record<RpcPriority, number> };
  private readonly logger?: RpcManagerLogger;
  private readonly cache = new Map<string, { value: unknown; expiresAt: number; storedAt: number }>();
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private readonly queue: QueueEntry[] = [];
  private readonly batches = new Map<string, { items: PendingBatchItem[]; timer: ReturnType<typeof globalThis.setTimeout> | null; priority: RpcPriority; config: Record<string, unknown> }>();
  private active = 0;
  private seq = 0;
  private readonly logThrottle = new Map<string, number>();
  private readonly methodMetrics = new Map<string, MethodMetrics>();
  private readonly callerMetrics = new Map<string, CallerMetrics>();
  private readonly queueWait = new Percentiles();
  private readonly logicalLatency = new Percentiles();
  private readonly logicalRate = new MinuteRate();
  private readonly networkRate = new MinuteRate();
  private readonly rate429 = new MinuteRate();
  readonly totals = {
    logicalRequests: 0, networkRequests: 0, success: 0, failed: 0, rateLimited: 0, forbidden: 0, timeouts: 0, serverErrors: 0,
    retries: 0, failovers: 0, cacheHits: 0, cacheMisses: 0, dedupHits: 0, batchedRequests: 0, batches: 0, dropped: 0, droppedExpired: 0,
    droppedOverload: 0, allProvidersFailed: 0, securityDataUnavailable: 0, maxQueueDepth: 0, rateLimitWaits: 0,
  };

  constructor(options: RpcManagerOptions) {
    this.logger = options.logger;
    this.options = {
      commitment: options.commitment ?? 'confirmed',
      timeoutMs: options.timeoutMs ?? 5_000,
      deadlineMs: { 0: 4_000, 1: 8_000, 2: 10_000, 3: 6_000, 4: 8_000, 5: 15_000, ...(options.deadlineMs ?? {}) },
      maxConcurrency: options.maxConcurrency ?? 8,
      reservedCriticalSlots: options.reservedCriticalSlots ?? 2,
      queueLimit: options.queueLimit ?? 1_000,
      maxAttempts: options.maxAttempts ?? 3,
      cacheEnabled: options.cacheEnabled ?? true,
      dedupEnabled: options.dedupEnabled ?? true,
      batchingEnabled: options.batchingEnabled ?? true,
      batchWindowMs: options.batchWindowMs ?? 10,
      maxBatchSize: options.maxBatchSize ?? 100,
      rateLimitBaseMs: options.rateLimitBaseMs ?? 2_000,
      rateLimitMaxMs: options.rateLimitMaxMs ?? 120_000,
      forbiddenRecheckMs: options.forbiddenRecheckMs ?? 30 * 60_000,
      methodUnsupportedMs: options.methodUnsupportedMs ?? 15 * 60_000,
      circuitFailureThreshold: options.circuitFailureThreshold ?? 3,
      circuitOpenMs: options.circuitOpenMs ?? 15_000,
      maxRps: options.maxRps ?? 0,
      transport: options.transport ?? fetchTransport,
      now: options.now ?? Date.now,
      random: options.random ?? Math.random,
    };
    const seen = new Set<string>();
    this.providers = options.providers.filter((provider) => {
      // The same URL twice adds no failover value.
      if (!provider.url || seen.has(provider.url)) return false;
      seen.add(provider.url);
      return true;
    }).map((provider) => ({
      role: provider.role, url: provider.url, label: `${provider.role}:${maskRpcUrl(provider.url).replace(/^https?:\/\//, '')}`, host: hostOf(provider.url),
      circuit: 'CLOSED', openUntil: 0, halfOpenProbe: false, consecutiveFailures: 0, cooldownUntil: 0, rateLimitStreak: 0, forbiddenUntil: 0, forbiddenReason: null,
      methodCooldownUntil: new Map(), methodRateLimitStreak: new Map(), unsupportedUntil: new Map(), lastErrorKind: null, lastError: null, lastErrorAt: null,
      lastSuccessAt: null, inFlight: 0, sendSlots: [], outcomes: [], latency: new Percentiles(), rate: new MinuteRate(),
      counters: { requests: 0, success: 0, rateLimited: 0, forbidden: 0, timeouts: 0, serverErrors: 0, unsupported: 0, otherErrors: 0 }, methods: new Map(),
    }));
  }

  get commitment() {
    return this.options.commitment;
  }

  get providerCount() {
    return this.providers.length;
  }

  private now() {
    return this.options.now();
  }

  private method(method: string) {
    let metrics = this.methodMetrics.get(method);
    if (!metrics) {
      metrics = { logical: 0, network: 0, rateLimited: 0, timeouts: 0, cacheHits: 0, dedupHits: 0, batched: 0, errors: 0, latency: new Percentiles() };
      this.methodMetrics.set(method, metrics);
    }
    return metrics;
  }

  private caller(name: string) {
    let metrics = this.callerMetrics.get(name);
    if (!metrics) {
      metrics = { logical: 0, network: 0, rateLimited: 0, failures: 0, cacheHits: 0, dedupHits: 0, dropped: 0, subjects: new Set() };
      this.callerMetrics.set(name, metrics);
    }
    return metrics;
  }

  /** Callers report a security decision that could not be made because RPC data was unavailable. */
  reportSecurityDataUnavailable(caller: string) {
    this.totals.securityDataUnavailable += 1;
    this.caller(caller);
  }

  // -------------------------------------------------------------------------------------------
  // Public request API
  // -------------------------------------------------------------------------------------------

  async request<T = unknown>(method: string, params: unknown[], options: RpcRequestOptions): Promise<T> {
    const started = this.now();
    this.totals.logicalRequests += 1;
    this.logicalRate.add(started);
    const methodMetrics = this.method(method);
    methodMetrics.logical += 1;
    const callerMetrics = this.caller(options.caller);
    callerMetrics.logical += 1;
    if (options.subject && callerMetrics.subjects.size < 100_000) callerMetrics.subjects.add(options.subject);

    const policy = policyFor(method);
    const key = `${method}|${stableKey(params)}`;
    const ttl = Math.min(policy.maxTtlMs, options.cacheTtlMs ?? policy.defaultTtlMs);
    if (this.options.cacheEnabled && ttl > 0) {
      const cached = this.cache.get(key);
      if (cached && cached.expiresAt > started) {
        this.totals.cacheHits += 1;
        methodMetrics.cacheHits += 1;
        callerMetrics.cacheHits += 1;
        return cached.value as T;
      }
      this.totals.cacheMisses += 1;
    }
    if (this.options.dedupEnabled && policy.dedup) {
      const pending = this.inFlight.get(key);
      if (pending) {
        this.totals.dedupHits += 1;
        methodMetrics.dedupHits += 1;
        callerMetrics.dedupHits += 1;
        return pending as Promise<T>;
      }
    }

    const run = (async () => {
      const batchable = method === 'getAccountInfo' && (options.batchable ?? true) && this.options.batchingEnabled && options.priority >= RPC_PRIORITY.SECURITY;
      const result = batchable ? await this.enqueueBatch(params, options) : await this.schedule(() => this.execute(method, params, options), options);
      if (this.options.cacheEnabled && ttl > 0 && result !== null && result !== undefined && !(method === 'getAccountInfo' && (result as { value?: unknown }).value === null)) {
        this.cache.set(key, { value: result, expiresAt: this.now() + ttl, storedAt: this.now() });
        if (this.cache.size > 10_000) this.cache.delete(this.cache.keys().next().value as string);
      }
      return result;
    })();
    if (this.options.dedupEnabled && policy.dedup) this.inFlight.set(key, run);
    try {
      const result = await run;
      this.logicalLatency.add(this.now() - started);
      return result as T;
    } catch (error) {
      if (error instanceof RpcRequestDroppedError) callerMetrics.dropped += 1;
      else callerMetrics.failures += 1;
      throw error;
    } finally {
      if (this.inFlight.get(key) === run) this.inFlight.delete(key);
    }
  }

  // -------------------------------------------------------------------------------------------
  // Batching: getAccountInfo -> getMultipleAccounts (same encoding / commitment / dataSlice)
  // -------------------------------------------------------------------------------------------

  private enqueueBatch(params: unknown[], options: RpcRequestOptions) {
    const [pubkey, config = {}] = params as [string, Record<string, unknown> | undefined];
    const groupKey = stableKey(config);
    return new Promise<unknown>((resolve, reject) => {
      let batch = this.batches.get(groupKey);
      if (!batch) {
        batch = { items: [], timer: null, priority: options.priority, config: config ?? {} };
        this.batches.set(groupKey, batch);
        batch.timer = globalThis.setTimeout(() => this.flushBatch(groupKey), this.options.batchWindowMs);
      }
      batch.items.push({ pubkey, resolve, reject, options });
      batch.priority = Math.min(batch.priority, options.priority) as RpcPriority;
      if (batch.items.length >= this.options.maxBatchSize) this.flushBatch(groupKey);
    });
  }

  private flushBatch(groupKey: string) {
    const batch = this.batches.get(groupKey);
    if (!batch) return;
    this.batches.delete(groupKey);
    if (batch.timer) globalThis.clearTimeout(batch.timer);
    // Items whose work expired meanwhile are dropped before the network call.
    const live = batch.items.filter((item) => {
      if (item.options.isRelevant && !item.options.isRelevant()) {
        this.totals.dropped += 1;
        this.totals.droppedExpired += 1;
        item.reject(new RpcRequestDroppedError('EXPIRED'));
        return false;
      }
      return true;
    });
    if (!live.length) return;
    const keys = [...new Set(live.map((item) => item.pubkey))];
    const options: RpcRequestOptions = { caller: live.length === 1 ? live[0].options.caller : 'Batch', priority: batch.priority, correlationId: live[0].options.correlationId };
    const single = keys.length === 1;
    if (!single) {
      this.totals.batches += 1;
      this.totals.batchedRequests += live.length;
      this.method('getAccountInfo').batched += live.length;
    }
    const call = single
      ? this.schedule(() => this.execute('getAccountInfo', [keys[0], batch.config], options), options)
      : this.schedule(() => this.execute('getMultipleAccounts', [keys, batch.config], options), options);
    void call.then((result) => {
      if (single) {
        for (const item of live) item.resolve(result);
        return;
      }
      const response = result as { context?: unknown; value?: unknown[] } | null;
      const values = response?.value ?? [];
      for (const item of live) item.resolve({ context: response?.context ?? null, value: values[keys.indexOf(item.pubkey)] ?? null });
    }, (error: unknown) => {
      for (const item of live) item.reject(error);
    });
  }

  // -------------------------------------------------------------------------------------------
  // Priority queue / concurrency
  // -------------------------------------------------------------------------------------------

  private canStart(priority: RpcPriority) {
    const limit = priority <= RPC_PRIORITY.SECURITY ? this.options.maxConcurrency : Math.max(1, this.options.maxConcurrency - this.options.reservedCriticalSlots);
    return this.active < limit;
  }

  private schedule<T>(work: () => Promise<T>, options: RpcRequestOptions): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const now = this.now();
      const entry: QueueEntry = {
        priority: options.priority, seq: this.seq++, enqueuedAt: now, deadlineAt: now + (options.deadlineMs ?? this.options.deadlineMs[options.priority]), isRelevant: options.isRelevant,
        start: () => {
          this.active += 1;
          this.queueWait.add(this.now() - entry.enqueuedAt);
          work().then(resolve, reject).finally(() => {
            this.active -= 1;
            this.pump();
          });
        },
        drop: reject,
      };
      if (!this.queue.length && this.canStart(entry.priority)) {
        entry.start();
        return;
      }
      if (this.queue.length >= this.options.queueLimit) {
        // Overload: the lowest-priority, newest work is shed first.
        const worstIndex = this.queue.reduce((worst, item, index) => (item.priority > this.queue[worst].priority || (item.priority === this.queue[worst].priority && item.seq > this.queue[worst].seq) ? index : worst), 0);
        if (this.queue[worstIndex].priority <= entry.priority) {
          this.countDrop('OVERLOAD');
          reject(new RpcRequestDroppedError('OVERLOAD'));
          return;
        }
        const [evicted] = this.queue.splice(worstIndex, 1);
        this.countDrop('OVERLOAD');
        evicted.drop(new RpcRequestDroppedError('OVERLOAD'));
      }
      this.queue.push(entry);
      this.totals.maxQueueDepth = Math.max(this.totals.maxQueueDepth, this.queue.length);
      this.pump();
    });
  }

  private countDrop(reason: 'EXPIRED' | 'DEADLINE' | 'OVERLOAD') {
    this.totals.dropped += 1;
    if (reason === 'OVERLOAD') this.totals.droppedOverload += 1;
    else this.totals.droppedExpired += 1;
  }

  private pump() {
    while (this.queue.length) {
      let bestIndex = -1;
      for (let index = 0; index < this.queue.length; index += 1) {
        const item = this.queue[index];
        if (bestIndex < 0 || item.priority < this.queue[bestIndex].priority || (item.priority === this.queue[bestIndex].priority && item.seq < this.queue[bestIndex].seq)) bestIndex = index;
      }
      const best = this.queue[bestIndex];
      const now = this.now();
      // Dead work is never executed: the candidate expired or the logical deadline already passed.
      if ((best.isRelevant && !best.isRelevant()) || now >= best.deadlineAt) {
        this.queue.splice(bestIndex, 1);
        const reason = best.isRelevant && !best.isRelevant() ? 'EXPIRED' : 'DEADLINE';
        this.countDrop(reason);
        best.drop(new RpcRequestDroppedError(reason));
        continue;
      }
      if (!this.canStart(best.priority)) return;
      this.queue.splice(bestIndex, 1);
      best.start();
    }
  }

  // -------------------------------------------------------------------------------------------
  // Provider selection / execution
  // -------------------------------------------------------------------------------------------

  private eligibility(provider: ProviderState, method: string, priority: RpcPriority): string | null {
    const now = this.now();
    if (provider.forbiddenUntil > now) return `FORBIDDEN (${provider.forbiddenReason ?? 'configuration'})`;
    if ((provider.unsupportedUntil.get(method) ?? 0) > now) return `METHOD_UNSUPPORTED (${method})`;
    if (provider.cooldownUntil > now) return `RATE_LIMITED (cooldown ${Math.ceil((provider.cooldownUntil - now) / 1000)} s)`;
    if ((provider.methodCooldownUntil.get(method) ?? 0) > now) return `RATE_LIMITED (${method} cooldown ${Math.ceil(((provider.methodCooldownUntil.get(method) ?? 0) - now) / 1000)} s)`;
    if (provider.circuit === 'OPEN') {
      if (now < provider.openUntil) return 'CIRCUIT_OPEN';
      provider.circuit = 'HALF_OPEN';
      provider.halfOpenProbe = false;
    }
    if (provider.circuit === 'HALF_OPEN' && provider.halfOpenProbe) return 'CIRCUIT_HALF_OPEN (probe in flight)';
    // Background / enrichment traffic avoids a provider that is clearly failing (critical traffic may still try it).
    if (priority >= RPC_PRIORITY.ENRICHMENT && this.healthScore(provider) < 25 && provider.outcomes.length >= 10) return 'UNHEALTHY (low-priority traffic withheld)';
    return null;
  }

  private healthScore(provider: ProviderState) {
    const outcomes = provider.outcomes;
    const successRate = outcomes.length ? outcomes.filter(Boolean).length / outcomes.length : 1;
    const p95 = provider.latency.summary().p95 ?? 0;
    return Math.max(0, Math.round(successRate * 100 - Math.min(20, p95 / 250) - 10 * Math.min(5, provider.consecutiveFailures)));
  }

  private record(provider: ProviderState, ok: boolean) {
    provider.outcomes.push(ok);
    if (provider.outcomes.length > 50) provider.outcomes.shift();
  }

  private async execute(method: string, params: unknown[], options: RpcRequestOptions): Promise<unknown> {
    const attempts: Array<{ provider: string; kind: RpcErrorKind | 'SKIPPED'; message: string }> = [];
    const deadline = this.now() + (options.deadlineMs ?? this.options.deadlineMs[options.priority]);
    // Retry budget: every provider at most once, at most maxAttempts network attempts, inside the deadline.
    let networkAttempts = 0;
    const tried = new Set<ProviderState>();
    for (let pass = 0; pass < 2; pass += 1) {
      if (pass === 1) {
        // Nothing was sent because every untried provider is only in a SHORT rate-limit cooldown: wait it out once
        // (backpressure) instead of failing the request. Forbidden / unsupported / open-circuit providers never wait.
        const resumeAt = this.earliestCooldownEnd(method, tried);
        if (resumeAt === null || resumeAt >= deadline - 50 || networkAttempts >= this.options.maxAttempts) break;
        this.totals.rateLimitWaits += 1;
        await sleep(resumeAt - this.now());
      }
    for (const provider of this.providers) {
      if (networkAttempts >= this.options.maxAttempts || tried.has(provider)) continue;
      const ineligible = this.eligibility(provider, method, options.priority);
      if (ineligible) {
        if (pass === 0) attempts.push({ provider: provider.label, kind: 'SKIPPED', message: ineligible });
        continue;
      }
      // Client-side request rate per provider (stay under the plan's RPS instead of provoking 429s).
      const rateWait = this.reserveRateSlot(provider);
      if (rateWait > 0) {
        if (this.now() + rateWait >= deadline - 50) {
          attempts.push({ provider: provider.label, kind: 'SKIPPED', message: 'RPS budget exhausted before deadline' });
          continue;
        }
        this.totals.rateLimitWaits += 1;
        await sleep(rateWait);
      }
      const remaining = deadline - this.now();
      if (remaining <= 0) break;
      tried.add(provider);
      if (networkAttempts > 0) this.totals.retries += 1;
      networkAttempts += 1;
      try {
        const result = await this.attempt(provider, method, params, options, Math.min(this.options.timeoutMs, remaining), networkAttempts);
        if (networkAttempts > 1 || attempts.length > 0) this.totals.failovers += 1;
        this.totals.success += 1;
        return result;
      } catch (error) {
        const failure = error instanceof RpcCallError ? error : new RpcCallError('NETWORK', sanitize(String(error)), provider.label, method);
        attempts.push({ provider: provider.label, kind: failure.kind, message: failure.message });
        // Same request would fail on every provider: no failover.
        if (failure.kind === 'INVALID_REQUEST') {
          this.totals.failed += 1;
          throw failure;
        }
      }
    }
      if (networkAttempts > 0) break;
    }
    this.totals.failed += 1;
    this.totals.allProvidersFailed += 1;
    this.log('all', 'RPC_ALL_PROVIDERS_UNAVAILABLE', { method, caller: options.caller, priority: RPC_PRIORITY_NAMES[options.priority], attempts, correlationId: options.correlationId }, 'All RPC providers failed or are unavailable');
    throw new RpcAllProvidersFailedError(method, attempts);
  }

  /** When the first untried provider leaves a pure rate-limit cooldown (null = none is merely cooling down). */
  private earliestCooldownEnd(method: string, tried: Set<ProviderState>) {
    const now = this.now();
    let earliest: number | null = null;
    for (const provider of this.providers) {
      if (tried.has(provider) || provider.forbiddenUntil > now || (provider.unsupportedUntil.get(method) ?? 0) > now) continue;
      if (provider.circuit === 'OPEN' && provider.openUntil > now) continue;
      const until = Math.max(provider.cooldownUntil, provider.methodCooldownUntil.get(method) ?? 0);
      if (until > now && (earliest === null || until < earliest)) earliest = until;
    }
    return earliest;
  }

  /** Sliding 1 s window per provider; returns how long to wait for a send slot (slot is reserved). */
  private reserveRateSlot(provider: ProviderState) {
    const limit = this.options.maxRps;
    if (!limit || limit <= 0) return 0;
    const now = this.now();
    while (provider.sendSlots.length && provider.sendSlots[0] <= now - 1_000) provider.sendSlots.shift();
    const at = provider.sendSlots.length < limit ? now : Math.max(now, provider.sendSlots[provider.sendSlots.length - limit] + 1_025); // small margin: timers / provider clocks drift
    provider.sendSlots.push(at);
    return at - now;
  }

  private async attempt(provider: ProviderState, method: string, params: unknown[], options: RpcRequestOptions, timeoutMs: number, attemptNumber: number): Promise<unknown> {
    const started = this.now();
    if (provider.circuit === 'HALF_OPEN') provider.halfOpenProbe = true;
    provider.inFlight += 1;
    provider.counters.requests += 1;
    provider.rate.add(started);
    const perMethod = provider.methods.get(method) ?? { requests: 0, rateLimited: 0, timeouts: 0 };
    perMethod.requests += 1;
    provider.methods.set(method, perMethod);
    this.totals.networkRequests += 1;
    this.networkRate.add(started);
    const methodMetrics = this.method(method);
    methodMetrics.network += 1;
    this.caller(options.caller).network += 1;
    try {
      const result = await this.send(provider, method, params, timeoutMs);
      const duration = this.now() - started;
      provider.latency.add(duration);
      methodMetrics.latency.add(duration);
      provider.counters.success += 1;
      provider.lastSuccessAt = this.now();
      provider.consecutiveFailures = 0;
      provider.rateLimitStreak = 0;
      provider.methodRateLimitStreak.delete(method);
      if (provider.circuit !== 'CLOSED') provider.circuit = 'CLOSED';
      provider.halfOpenProbe = false;
      if (provider.forbiddenUntil) {
        provider.forbiddenUntil = 0;
        provider.forbiddenReason = null;
      }
      this.record(provider, true);
      return result;
    } catch (error) {
      const failure = error instanceof RpcCallError ? error : this.classifyThrown(error, provider.label, method);
      const duration = this.now() - started;
      methodMetrics.errors += 1;
      this.onFailure(provider, failure, method, options, duration, attemptNumber);
      throw failure;
    } finally {
      provider.inFlight -= 1;
    }
  }

  private classifyThrown(error: unknown, provider: string, method: string) {
    const name = (error as { name?: string })?.name ?? '';
    const message = sanitize(error instanceof Error ? error.message : String(error));
    if (name === 'TimeoutError' || name === 'AbortError' || /timed? ?out|aborted/i.test(message)) return new RpcCallError('TIMEOUT', 'RPC request timed out', provider, method);
    return new RpcCallError('NETWORK', message, provider, method);
  }

  private async send(provider: ProviderState, method: string, params: unknown[], timeoutMs: number) {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
    const response = await this.options.transport({ url: provider.url, body, timeoutMs });
    const text = await response.text().catch(() => '');
    const parsed = ((): { result?: unknown; error?: unknown } | null => {
      try {
        return text ? JSON.parse(text) as { result?: unknown; error?: unknown } : null;
      } catch {
        return null;
      }
    })();
    // JSON-RPC error object, or a gateway's plain {"error": "..."} string.
    const rawError = parsed?.error;
    const rpcError = typeof rawError === 'string' ? { message: rawError, code: undefined } : rawError as { code?: number; message?: string } | undefined;
    const message = sanitize(rpcError?.message ?? (text ? text.slice(0, 160) : `HTTP ${response.status}`));
    const code = rpcError?.code ?? null;
    const retryAfterHeader = response.headers.get('retry-after');
    const retryAfterMs = retryAfterHeader && Number.isFinite(Number(retryAfterHeader)) ? Number(retryAfterHeader) * 1000 : null;
    if (response.status === 429 || code === 429 || code === -32005 || /too many requests|rate.?limit/i.test(message)) {
      return Promise.reject(new RpcCallError('RATE_LIMITED', message || '429 Too Many Requests', provider.label, method, retryAfterMs, /specific rpc call/i.test(message)));
    }
    // A method-level block can arrive as HTTP 403 (publicnode: 403 + "Request blocked" for getTokenLargestAccounts):
    // only that method is skipped on this provider - the provider itself stays in rotation.
    if (code === -32601 || /request blocked|method not found|not supported|method.*disabled|not available on/i.test(message)) {
      return Promise.reject(new RpcCallError('METHOD_UNSUPPORTED', message, provider.label, method));
    }
    if (response.status === 401 || response.status === 403 || code === -32052 || /api key|not allowed to access|unauthori[sz]ed|forbidden/i.test(message)) {
      return Promise.reject(new RpcCallError('FORBIDDEN', message || `HTTP ${response.status}`, provider.label, method));
    }
    if (response.status >= 500) return Promise.reject(new RpcCallError('SERVER_ERROR', message || `HTTP ${response.status}`, provider.label, method));
    if (code === -32600 || code === -32602 || code === -32700) return Promise.reject(new RpcCallError('INVALID_REQUEST', message, provider.label, method));
    if (rpcError) return Promise.reject(new RpcCallError('RPC_ERROR', message, provider.label, method));
    if (response.status >= 400 || !parsed) return Promise.reject(new RpcCallError('SERVER_ERROR', message || `HTTP ${response.status}`, provider.label, method));
    return parsed.result ?? null;
  }

  /** Exponential back-off with jitter; Retry-After is a lower bound (a persistently limited method backs off further). */
  private backoff(streak: number, retryAfterMs: number | null) {
    const base = Math.min(this.options.rateLimitMaxMs, this.options.rateLimitBaseMs * 2 ** Math.max(0, streak - 1));
    const jittered = Math.round(base * (0.8 + this.options.random() * 0.4));
    return Math.min(this.options.rateLimitMaxMs, Math.max(retryAfterMs ?? 0, jittered));
  }

  private onFailure(provider: ProviderState, failure: RpcCallError, method: string, options: RpcRequestOptions, durationMs: number, attempt: number) {
    const now = this.now();
    provider.lastErrorKind = failure.kind;
    provider.lastError = failure.message;
    provider.lastErrorAt = now;
    const perMethod = provider.methods.get(method)!;
    const methodMetrics = this.method(method);
    let circuitFailure = false;
    switch (failure.kind) {
      case 'RATE_LIMITED': {
        provider.counters.rateLimited += 1;
        perMethod.rateLimited += 1;
        methodMetrics.rateLimited += 1;
        this.totals.rateLimited += 1;
        this.rate429.add(now);
        this.caller(options.caller).rateLimited += 1;
        if (failure.methodScoped) {
          const streak = (provider.methodRateLimitStreak.get(method) ?? 0) + 1;
          provider.methodRateLimitStreak.set(method, streak);
          provider.methodCooldownUntil.set(method, now + this.backoff(streak, failure.retryAfterMs));
        } else {
          provider.rateLimitStreak += 1;
          provider.cooldownUntil = now + this.backoff(provider.rateLimitStreak, failure.retryAfterMs);
          circuitFailure = provider.rateLimitStreak >= this.options.circuitFailureThreshold;
        }
        break;
      }
      case 'FORBIDDEN':
        provider.counters.forbidden += 1;
        this.totals.forbidden += 1;
        // Configuration error (missing / wrong key, plan without this chain): not transient - long deactivation.
        provider.forbiddenUntil = now + this.options.forbiddenRecheckMs;
        provider.forbiddenReason = failure.message;
        break;
      case 'TIMEOUT':
        provider.counters.timeouts += 1;
        perMethod.timeouts += 1;
        methodMetrics.timeouts += 1;
        this.totals.timeouts += 1;
        circuitFailure = true;
        break;
      case 'SERVER_ERROR':
      case 'NETWORK':
        provider.counters.serverErrors += 1;
        this.totals.serverErrors += 1;
        circuitFailure = true;
        break;
      case 'METHOD_UNSUPPORTED':
        provider.counters.unsupported += 1;
        provider.unsupportedUntil.set(method, now + this.options.methodUnsupportedMs);
        break;
      default:
        provider.counters.otherErrors += 1;
    }
    if (failure.kind !== 'INVALID_REQUEST' && failure.kind !== 'RPC_ERROR') this.record(provider, false);
    if (circuitFailure) {
      provider.consecutiveFailures += 1;
      if (provider.circuit === 'HALF_OPEN' || provider.consecutiveFailures >= this.options.circuitFailureThreshold) {
        provider.circuit = 'OPEN';
        provider.openUntil = now + this.options.circuitOpenMs;
      }
    }
    provider.halfOpenProbe = false;
    this.log(`${provider.role}:${failure.kind}:${failure.methodScoped ? method : ''}`, `RPC_${failure.kind}`, {
      provider: provider.label, method, caller: options.caller, priority: RPC_PRIORITY_NAMES[options.priority], durationMs, status: failure.kind, retry: attempt - 1,
      failover: attempt > 1, circuit: provider.circuit, error: failure.message, correlationId: options.correlationId,
    }, 'Solana RPC request failed');
  }

  /** Structured warning, at most once per 30 s per (provider, kind): no log storms. */
  private log(key: string, code: string, payload: Record<string, unknown>, message: string) {
    const now = this.now();
    if (now - (this.logThrottle.get(key) ?? 0) < 30_000) return;
    this.logThrottle.set(key, now);
    this.logger?.warn({ code, ...payload }, message);
  }

  // -------------------------------------------------------------------------------------------
  // Typed helpers
  // -------------------------------------------------------------------------------------------

  /** JSON-RPC call function for modules that speak raw RPC (launch providers). */
  rpcCall(defaults: Omit<RpcRequestOptions, 'subject'>) {
    return (method: string, params: unknown[], overrides: Partial<RpcRequestOptions> = {}) => this.request(method, params, { ...defaults, ...overrides });
  }

  /**
   * Mint account (authorities, token program, Token-2022 extensions). Slow-changing: cached 30 s, deduplicated and
   * batched (getMultipleAccounts). Returns null when the account does not exist (yet); throws on RPC failure.
   */
  async getMintAccount(mint: string, options: RpcRequestOptions) {
    const result = await this.request<{ value?: { data?: { program?: string; parsed?: { info?: Record<string, unknown> } } } | null } | null>(
      'getAccountInfo', [mint, { encoding: 'jsonParsed', commitment: this.options.commitment }], { cacheTtlMs: 30_000, ...options },
    );
    const data = result?.value?.data;
    const info = data?.parsed?.info;
    if (!info) return null;
    return {
      address: mint,
      decimals: Number(info.decimals ?? 0),
      supply: String(info.supply ?? '0'),
      mintAuthority: (info.mintAuthority as string | null | undefined) ?? null,
      freezeAuthority: (info.freezeAuthority as string | null | undefined) ?? null,
      tokenProgram: data?.program ?? null,
      extensions: Array.isArray(info.extensions) ? (info.extensions as Array<{ extension?: unknown }>).map((entry) => String(entry.extension)) : [],
    };
  }

  async getTokenLargestAccounts(mint: string, options: RpcRequestOptions, limit = 10) {
    const result = await this.request<{ value?: Array<{ address: string; amount: string; decimals: number; uiAmount: number | null }> } | null>(
      'getTokenLargestAccounts', [mint, { commitment: this.options.commitment }], options,
    );
    return (result?.value ?? []).slice(0, limit).map((entry) => ({ address: entry.address, amount: entry.amount, decimals: entry.decimals, uiAmount: entry.uiAmount }));
  }

  // -------------------------------------------------------------------------------------------
  // Observability
  // -------------------------------------------------------------------------------------------

  providerStatus(provider: ProviderState): RpcProviderStatus {
    const now = this.now();
    if (provider.forbiddenUntil > now) return 'FORBIDDEN';
    if (provider.circuit === 'OPEN' && now < provider.openUntil) return provider.lastErrorKind === 'TIMEOUT' ? 'TIMEOUT' : 'UNHEALTHY';
    if (provider.cooldownUntil > now) return 'RATE_LIMITED';
    const methodLimited = [...provider.methodCooldownUntil.values()].some((until) => until > now);
    const score = this.healthScore(provider);
    if (methodLimited || score < 80 || provider.circuit === 'HALF_OPEN') return 'DEGRADED';
    return 'HEALTHY';
  }

  /** Credential-free diagnostics (Redis `rpc:health` -> System page). */
  snapshot() {
    const now = this.now();
    const providers = this.providers.map((provider) => {
      const total = provider.counters.requests;
      const latency = provider.latency.summary();
      const cooldowns = [...provider.methodCooldownUntil.entries()].filter(([, until]) => until > now).map(([method, until]) => ({ method, remainingMs: until - now }));
      const unsupported = [...provider.unsupportedUntil.entries()].filter(([, until]) => until > now).map(([method]) => method);
      return {
        role: provider.role, label: provider.label, host: maskRpcUrl(provider.url).replace(/^https?:\/\//, '').split('/')[0],
        status: this.providerStatus(provider), circuit: provider.circuit, healthScore: this.healthScore(provider),
        latencyP50Ms: latency.p50, latencyP95Ms: latency.p95,
        successRatePct: total ? provider.counters.success / total * 100 : null,
        requestsPerMinute: provider.rate.count(now), ...provider.counters,
        rateLimitRatePct: total ? provider.counters.rateLimited / total * 100 : null,
        cooldownRemainingMs: Math.max(0, provider.cooldownUntil - now, provider.forbiddenUntil - now, provider.circuit === 'OPEN' ? provider.openUntil - now : 0),
        methodCooldowns: cooldowns, unsupportedMethods: unsupported,
        forbiddenReason: provider.forbiddenUntil > now ? provider.forbiddenReason : null,
        lastSuccessAt: provider.lastSuccessAt ? new Date(provider.lastSuccessAt).toISOString() : null,
        lastErrorKind: provider.lastErrorKind, lastError: provider.lastError, lastErrorAt: provider.lastErrorAt ? new Date(provider.lastErrorAt).toISOString() : null,
        methods: Object.fromEntries(provider.methods),
      };
    });
    const t = this.totals;
    const cacheLookups = t.cacheHits + t.cacheMisses;
    const methods = [...this.methodMetrics.entries()].map(([method, metrics]) => {
      const latency = metrics.latency.summary();
      return { method, logical: metrics.logical, network: metrics.network, sharePct: t.networkRequests ? metrics.network / t.networkRequests * 100 : 0, p50Ms: latency.p50, p95Ms: latency.p95, rateLimited: metrics.rateLimited, timeouts: metrics.timeouts, errors: metrics.errors, cacheHits: metrics.cacheHits, dedupHits: metrics.dedupHits, batched: metrics.batched, dataClass: policyFor(method).dataClass };
    }).sort((a, b) => b.network - a.network || b.logical - a.logical);
    const callers = [...this.callerMetrics.entries()].map(([caller, metrics]) => ({
      caller, logical: metrics.logical, network: metrics.network, rateLimited: metrics.rateLimited, failures: metrics.failures, dropped: metrics.dropped, cacheHits: metrics.cacheHits, dedupHits: metrics.dedupHits,
      subjects: metrics.subjects.size, networkPerSubject: metrics.subjects.size ? metrics.network / metrics.subjects.size : null, logicalPerSubject: metrics.subjects.size ? metrics.logical / metrics.subjects.size : null,
    })).sort((a, b) => b.network - a.network);
    const usable = providers.filter((provider) => provider.status !== 'FORBIDDEN' && provider.status !== 'DISABLED');
    const hosts = this.providers.map((provider) => provider.host);
    const alerts: Array<{ code: string; detail: string }> = [];
    const per429 = this.rate429.count(now);
    const perNetwork = this.networkRate.count(now);
    if (perNetwork >= 10 && per429 / perNetwork > 0.1) alerts.push({ code: 'RPC_HIGH_429_RATE', detail: `${per429} / ${perNetwork} hálózati kérés 429 az utolsó percben` });
    for (const provider of providers) {
      if (provider.status === 'FORBIDDEN') alerts.push({ code: 'RPC_PROVIDER_FORBIDDEN', detail: `${provider.label}: ${provider.forbiddenReason ?? '403'}` });
      if (provider.status === 'TIMEOUT') alerts.push({ code: 'RPC_PROVIDER_TIMEOUT', detail: `${provider.label}: ismételt időtúllépés` });
    }
    if (!usable.length || usable.every((provider) => provider.status === 'UNHEALTHY' || provider.status === 'TIMEOUT')) alerts.push({ code: 'RPC_ALL_PROVIDERS_UNAVAILABLE', detail: 'Nincs használható RPC szolgáltató' });
    if (this.queue.length >= this.options.queueLimit * 0.8 || t.droppedOverload > 0) alerts.push({ code: 'RPC_QUEUE_OVERLOAD', detail: `sor: ${this.queue.length}, túlterhelés miatt eldobva: ${t.droppedOverload}` });
    if (cacheLookups >= 200 && t.cacheHits / cacheLookups < 0.05) alerts.push({ code: 'RPC_CACHE_INEFFECTIVE', detail: `cache találat ${Math.round(t.cacheHits / cacheLookups * 100)}%` });
    if (t.logicalRequests >= 200 && t.dedupHits / t.logicalRequests > 0.3) alerts.push({ code: 'RPC_DUPLICATE_REQUEST_STORM', detail: `${t.dedupHits} azonos párhuzamos kérés összevonva` });
    if (t.securityDataUnavailable > 0) alerts.push({ code: 'RPC_SECURITY_DATA_UNAVAILABLE', detail: `${t.securityDataUnavailable} biztonsági ellenőrzés RPC adat nélkül maradt (nincs automatikus vétel)` });
    if (this.providers.length < 2 || new Set(hosts).size < hosts.length || usable.length < 2) alerts.push({ code: 'RPC_REDUNDANCY_LOW', detail: this.providers.length < 2 ? 'csak egy szolgáltató van beállítva' : new Set(hosts).size < hosts.length ? 'több szerep ugyanarra a hosztra mutat' : 'csak egy használható szolgáltató' });
    const queueWait = this.queueWait.summary();
    return {
      at: new Date(now).toISOString(),
      config: {
        timeoutMs: this.options.timeoutMs, maxConcurrency: this.options.maxConcurrency, reservedCriticalSlots: this.options.reservedCriticalSlots, queueLimit: this.options.queueLimit,
        maxAttempts: this.options.maxAttempts, maxRps: this.options.maxRps, cacheEnabled: this.options.cacheEnabled, dedupEnabled: this.options.dedupEnabled, batchingEnabled: this.options.batchingEnabled,
        batchWindowMs: this.options.batchWindowMs, deadlineMs: this.options.deadlineMs,
      },
      providers,
      totals: { ...t },
      requestsPerMinute: perNetwork,
      logicalRequestsPerMinute: this.logicalRate.count(now),
      rateLimitedPerMinute: per429,
      queueDepth: this.queue.length,
      activeRequests: this.active,
      queueWaitMs: queueWait,
      logicalLatencyMs: this.logicalLatency.summary(),
      cacheHitRatePct: cacheLookups ? t.cacheHits / cacheLookups * 100 : null,
      savedRequests: { cache: t.cacheHits, dedup: t.dedupHits, batching: Math.max(0, t.batchedRequests - t.batches) },
      failoverRatePct: t.logicalRequests ? t.failovers / t.logicalRequests * 100 : null,
      rateLimitRatePct: t.networkRequests ? t.rateLimited / t.networkRequests * 100 : null,
      timeoutRatePct: t.networkRequests ? t.timeouts / t.networkRequests * 100 : null,
      methods,
      callers,
      alerts,
    };
  }
}

export type RpcManagerSnapshot = ReturnType<SolanaRpcManager['snapshot']>;

/** Builds the manager from the existing RPC environment (1-3 providers; missing optional ones are fine). */
export function createRpcManagerFromEnv(environment: Record<string, string | undefined>, extra: Partial<RpcManagerOptions> = {}): SolanaRpcManager | null {
  const valid = (value: string | undefined) => {
    if (!value?.trim()) return null;
    try {
      const url = new URL(value.trim());
      return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString().replace(/\/$/, '') : null;
    } catch {
      return null;
    }
  };
  const primary = valid(environment.SOLANA_PRIMARY_RPC_URL) ?? valid(environment.SOLANA_RPC_URL);
  if (!primary) return null;
  const providers: RpcProviderConfig[] = [{ role: 'primary', url: primary }];
  const secondary = valid(environment.SOLANA_SECONDARY_RPC_URL);
  const fallback = valid(environment.SOLANA_FALLBACK_RPC_URL);
  if (secondary) providers.push({ role: 'secondary', url: secondary });
  if (fallback) providers.push({ role: 'fallback', url: fallback });
  const int = (value: string | undefined, fallbackValue: number) => {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallbackValue;
  };
  const flag = (value: string | undefined, fallbackValue: boolean) => (value === undefined || value === '' ? fallbackValue : value !== 'false');
  return new SolanaRpcManager({
    providers,
    commitment: environment.SOLANA_COMMITMENT || 'confirmed',
    timeoutMs: int(environment.SOLANA_RPC_TIMEOUT_MS, 5_000),
    maxConcurrency: int(environment.SOLANA_RPC_MAX_CONCURRENCY, 8),
    // Free / public plans allow ~10 requests/s: stay below it by default.
    maxRps: int(environment.SOLANA_RPC_MAX_RPS, 8),
    queueLimit: int(environment.SOLANA_RPC_QUEUE_LIMIT, 1_000),
    rateLimitBaseMs: int(environment.SOLANA_RPC_RATE_LIMIT_BASE_MS, 2_000),
    forbiddenRecheckMs: int(environment.SOLANA_RPC_FORBIDDEN_RECHECK_MS, 30 * 60_000),
    cacheEnabled: flag(environment.SOLANA_RPC_CACHE_ENABLED, true),
    dedupEnabled: flag(environment.SOLANA_RPC_DEDUP_ENABLED, true),
    batchingEnabled: flag(environment.SOLANA_RPC_BATCHING_ENABLED, true),
    ...extra,
  });
}
