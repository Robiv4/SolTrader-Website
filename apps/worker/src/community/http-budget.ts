/**
 * Request budget + backoff for community providers. Every provider call goes through `run`, which never throws:
 *  - global per-minute budget per provider (requests beyond it are not made: null);
 *  - HTTP 429 -> RATE_LIMITED until the Retry-After / backoff time; 5xx / timeout / network -> DEGRADED with
 *    exponential backoff (base * 2^failures, capped); a success resets the backoff;
 *  - per-request timeout (AbortSignal).
 * Credentials never appear in logs or health output.
 */

export type CommunityProviderState = 'ACTIVE' | 'NOT_CONFIGURED' | 'DEGRADED' | 'RATE_LIMITED' | 'DISABLED';

export interface CommunityProviderHealth {
  source: string;
  state: CommunityProviderState;
  enabled: boolean;
  configured: boolean;
  requests: number;
  successes: number;
  errors: number;
  rateLimitEvents: number;
  cacheHits: number;
  cacheMisses: number;
  skippedBudget: number;
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  backoffUntil: string | null;
  budgetPerMinute: number;
  coverage?: Record<string, number>;
}

export type FetchLike = (url: string, init?: { headers?: Record<string, string>; signal?: globalThis.AbortSignal }) => Promise<{ ok: boolean; status: number; headers: { get(name: string): string | null }; json(): Promise<unknown> }>;

export interface BudgetOptions {
  source: string;
  enabled: boolean;
  configured: boolean;
  perMinute: number;
  timeoutMs: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  fetch?: FetchLike;
  now?: () => number;
}

export class HttpBudget {
  private window = { start: 0, used: 0 };
  private blockedUntil = 0;
  private failures = 0;
  private latencies: number[] = [];
  readonly stats = { requests: 0, successes: 0, errors: 0, rateLimitEvents: 0, cacheHits: 0, cacheMisses: 0, skippedBudget: 0 };
  private state: CommunityProviderState;
  private lastSuccessAt: number | null = null;
  private lastError: string | null = null;

  constructor(private readonly options: BudgetOptions) {
    this.state = !options.enabled ? 'DISABLED' : options.configured ? 'ACTIVE' : 'NOT_CONFIGURED';
  }

  private now() {
    return this.options.now?.() ?? Date.now();
  }

  /** True when a request could be made right now (enabled, configured, not backing off, budget left). */
  available() {
    if (!this.options.enabled || !this.options.configured) return false;
    const now = this.now();
    if (now < this.blockedUntil) return false;
    if (now - this.window.start >= 60_000) this.window = { start: now, used: 0 };
    return this.window.used < this.options.perMinute;
  }

  budgetLeft() {
    const now = this.now();
    if (now - this.window.start >= 60_000) return this.options.perMinute;
    return Math.max(0, this.options.perMinute - this.window.used);
  }

  /** GET JSON; null = not made (budget / backoff / off) or failed. */
  async getJson(url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: unknown } | null> {
    if (!this.available()) {
      if (this.options.enabled && this.options.configured) this.stats.skippedBudget += 1;
      return null;
    }
    this.window.used += 1;
    this.stats.requests += 1;
    const started = this.now();
    try {
      const response = await (this.options.fetch ?? (globalThis.fetch as unknown as FetchLike))(url, { headers: { Accept: 'application/json', ...headers }, signal: globalThis.AbortSignal.timeout(this.options.timeoutMs) });
      this.latencies = [...this.latencies.slice(-199), this.now() - started];
      if (response.status === 429) {
        const retryAfter = Number(response.headers.get('retry-after'));
        this.stats.rateLimitEvents += 1;
        this.failures += 1;
        this.blockedUntil = this.now() + (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : this.backoffMs());
        this.state = 'RATE_LIMITED';
        this.lastError = 'HTTP 429';
        return null;
      }
      if (response.status >= 500) throw new Error(`HTTP ${response.status}`);
      const body = response.status === 404 ? null : await response.json();
      if (!response.ok && response.status !== 404) {
        // 4xx other than 404 / 429: a request problem (auth / plan). No backoff storm: one minute pause.
        this.stats.errors += 1;
        this.blockedUntil = this.now() + 60_000;
        this.state = 'DEGRADED';
        this.lastError = `HTTP ${response.status}`;
        return null;
      }
      this.stats.successes += 1;
      this.failures = 0;
      this.state = 'ACTIVE';
      this.lastSuccessAt = this.now();
      this.lastError = null;
      return { status: response.status, body };
    } catch (error) {
      this.stats.errors += 1;
      this.failures += 1;
      this.blockedUntil = this.now() + this.backoffMs();
      this.state = 'DEGRADED';
      // Message only (never the URL with a key / headers).
      this.lastError = error instanceof Error ? error.name === 'TimeoutError' ? 'TIMEOUT' : error.message.slice(0, 120) : 'ERROR';
      return null;
    }
  }

  private backoffMs() {
    return Math.min(this.options.backoffMaxMs, this.options.backoffBaseMs * 2 ** Math.max(0, this.failures - 1));
  }

  health(extra: Partial<CommunityProviderHealth> = {}): CommunityProviderHealth {
    if ((this.state === 'RATE_LIMITED' || this.state === 'DEGRADED') && this.now() >= this.blockedUntil && this.failures === 0) this.state = 'ACTIVE';
    const sorted = [...this.latencies].sort((a, b) => a - b);
    return {
      source: this.options.source, state: this.state, enabled: this.options.enabled, configured: this.options.enabled && this.options.configured,
      ...this.stats,
      latencyP50Ms: sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : null,
      latencyP95Ms: sorted.length ? sorted[Math.floor((sorted.length - 1) * 0.95)] : null,
      lastSuccessAt: this.lastSuccessAt ? new Date(this.lastSuccessAt).toISOString() : null,
      lastError: this.lastError,
      backoffUntil: this.blockedUntil > this.now() ? new Date(this.blockedUntil).toISOString() : null,
      budgetPerMinute: this.options.perMinute,
      ...extra,
    };
  }
}
