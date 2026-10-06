# Solana RPC layer (SolanaRpcManager)

All worker on-chain reads go through one shared `SolanaRpcManager` (`packages/blockchain/src/rpc-manager.ts`). It is
created once per process from the RPC environment (`createRpcManagerFromEnv`).

**Principle:** make fewer requests, share identical ones, batch compatible ones, cache only what is safe, prioritise
critical traffic, stop sending traffic to unhealthy providers, and fail safely.

## Callers

| Caller | Method(s) | Priority |
| --- | --- | --- |
| `NewLaunchSecurity` | `getAccountInfo` (mint), cached 30 s, batched | P2 SECURITY |
| `NewLaunchDiscovery` (Raydium `initialize2`) | `getTransaction` (immutable, cached 10 min) | P4 ENRICHMENT |
| `TokenScanner` | `getAccountInfo` (mint) + `getTokenLargestAccounts`, dropped when the scan is aborted | P4 ENRICHMENT |

The exit path (HotPositionMonitor / PositionManager) uses **no Solana RPC**. Its prices come from the market-data
streams. P0–P2 still have reserved concurrency slots, so scanner load can never occupy them.

Other RPC traffic outside the manager:

- the API health probe (`getHealth`), used only when the worker's `rpc:health` snapshot is older than 30 s;
- wallet verification (`getBalance`, user-triggered);
- pump.fun / Raydium `logsSubscribe` WebSockets;
- the LIVE execution adapter, which is disabled.

## Providers

There can be 1–3 providers: PRIMARY, SECONDARY and FALLBACK. A missing optional provider is not an error, and duplicate
URLs are ignored. Each provider is tracked independently with:

- **status:** HEALTHY / DEGRADED / RATE_LIMITED / FORBIDDEN / TIMEOUT / UNHEALTHY / DISABLED;
- **circuit breaker:** CLOSED → OPEN after 3 consecutive failures, HALF_OPEN after 15 s (one probe), CLOSED on success;
- **health score:** from success rate, latency and consecutive failures;
- **cooldowns:** per provider and per method;
- **capability map:** methods learned to be unsupported (15 min).

Background traffic (P4/P5) is withheld from a provider whose health score is below 25.

| Response | Classification | Effect |
| --- | --- | --- |
| 429, method-specific ("Too many requests for a specific RPC call") | RATE_LIMITED, method-scoped | Only that method is cooled down on that provider. Exponential back-off with jitter; Retry-After is the lower bound. Then failover. |
| 429, general | RATE_LIMITED | The provider is cooled down. Repeated 429s open the circuit. |
| 401 / 403 / `-32052` / "API key is not allowed" | FORBIDDEN (configuration) | Out of rotation for `SOLANA_RPC_FORBIDDEN_RECHECK_MS` (30 min). |
| "Request blocked" / `-32601` (also when sent as HTTP 403) | METHOD_UNSUPPORTED | The method is skipped on that provider. The provider stays in rotation. |
| Timeout / 5xx / network | TIMEOUT / SERVER_ERROR | Counts toward the circuit breaker; failover. |
| `-32600` / `-32602` / `-32700` | INVALID_REQUEST | No failover (every provider would reject it). |

**Retry budget:** each provider is tried at most once per logical request (max 3 attempts), inside a per-priority
deadline (P0 4 s, P1 8 s, P2 10 s, P3 6 s, P4 8 s, P5 15 s). The provider chain is never repeated.

## Dedup, cache, batching, queue

- **Dedup:** identical in-flight requests share one promise. The key is method + stable JSON of the parameters, so
  commitment, encoding and options are all part of it. `sendTransaction` and `simulateTransaction` are never merged.
- **Cache:** each method has a data class and a TTL cap (`RPC_METHOD_POLICY`). Only successful, non-null results are
  cached; errors are never cached.

  | Data class | Methods | TTL |
  | --- | --- | --- |
  | STATIC | `getTransaction`, `getBlockTime`, `getGenesisHash`, `getVersion` | 10 min |
  | SLOW_CHANGING | `getTokenLargestAccounts`, `getTokenSupply` | 30 s |
  | SLOW_CHANGING (caller opt-in) | mint accounts via `getMintAccount` | 30 s |
  | FAST_CHANGING | `getBalance`, token balances, `getSignaturesForAddress`, account data by default | none by default, cap ≤ 2 s |
  | CRITICAL_REALTIME | `getLatestBlockhash`, `getSignatureStatuses`, `simulateTransaction`, `sendTransaction` | never cached |
  | CRITICAL_REALTIME | `getSlot` | 0.4 s |
- **Batching:** `getAccountInfo` calls (P2 and below) with the same encoding and commitment are collected for 10 ms
  and sent as one `getMultipleAccounts` (max 100). Results are mapped back to each caller. P0/P1 never wait.
- **Queue:** bounded (default 1,000) and by priority, with 2 of the 8 slots reserved for P0–P2. On overload the
  lowest-priority, newest work is shed. Work whose candidate expired (`isRelevant() === false`) or whose deadline passed
  is dropped before any network call.

## Security data: UNKNOWN is never SAFE

- **Scanner:** mint info and holders are fetched independently (`allSettled`), so a holder failure no longer discards
  the authorities. The result is COMPLETE, PARTIAL or UNAVAILABLE, with errors and a quality grade.
  - Unknown authorities → `authorityStatusKnown: false`. The conservative scoring values are kept, warnings
    `AUTHORITY_STATUS_UNKNOWN` and `RPC_SECURITY_DATA_UNAVAILABLE` are added, and the decision is capped at **WATCH**
    (`dataQualityBlockReasons`).
  - Such assessments never reach the strategies (no automatic entry). Unknown holders → `HOLDER_DATA_UNAVAILABLE`.
- **NewLaunch:** authorities stay `null` → WATCH. When every provider failed, the reason is
  `RPC_SECURITY_DATA_UNAVAILABLE`, otherwise `SECURITY_CHECK_PENDING`. A mint that does not exist yet is "not found"
  (retried), not an outage.

## Observability

The worker publishes `rpc:health` to Redis every 5 s. The **System → Solana RPC** panel shows:

- per provider: status, circuit, latency, success rate, 429 / 403 / timeouts, cooldowns, unsupported methods,
  requests/min;
- globals: queue, wait, cache hit rate, saved requests, failover / 429 / timeout rates;
- the method and caller tables;
- alerts: `RPC_HIGH_429_RATE`, `RPC_PROVIDER_FORBIDDEN`, `RPC_PROVIDER_TIMEOUT`, `RPC_ALL_PROVIDERS_UNAVAILABLE`,
  `RPC_QUEUE_OVERLOAD`, `RPC_CACHE_INEFFECTIVE`, `RPC_DUPLICATE_REQUEST_STORM`, `RPC_SECURITY_DATA_UNAVAILABLE`,
  `RPC_REDUNDANCY_LOW`.

Providers are labelled role + host. URLs with a path secret or query are shown as `host/***`. Error texts are stripped
of URLs and key-like strings.

## Configuration

| Variable | Default |
| --- | --- |
| `SOLANA_PRIMARY_RPC_URL` / `SOLANA_RPC_URL`, `SOLANA_SECONDARY_RPC_URL`, `SOLANA_FALLBACK_RPC_URL` | — |
| `SOLANA_RPC_TIMEOUT_MS` | 5000 |
| `SOLANA_RPC_MAX_CONCURRENCY` | 8 |
| `SOLANA_RPC_QUEUE_LIMIT` | 1000 |
| `SOLANA_RPC_RATE_LIMIT_BASE_MS` | 2000 |
| `SOLANA_RPC_FORBIDDEN_RECHECK_MS` | 1800000 |
| `SOLANA_RPC_CACHE_ENABLED` / `_DEDUP_ENABLED` / `_BATCHING_ENABLED` | true |
