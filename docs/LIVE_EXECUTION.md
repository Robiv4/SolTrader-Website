# Live Solana Execution

The execution package provides a provider-neutral `SafeLiveExecutionEngine`, a Jupiter adapter, and a Solana JSON-RPC adapter. `ExecutionAttempt` persists idempotency keys, transaction state, signatures, and reconciliation data.

## Default Safety State

`DEFAULT_LIVE_EXECUTION_CONFIG` uses `mode: PAPER` and `enabled: false`. The engine will not quote, sign, or broadcast in this state. Keep `LIVE_TRADING_ENABLED=false` until the deployment has an approved server-side signer and all safety checks are operational. PAPER flows must continue using the paper execution coordinator, not this engine.

The API also defaults every account to PAPER with LIVE approval incomplete. `LIVE_TRADING_ENABLED=true` is only one required server condition; it never enables an account by itself. The authenticated administrator must pass the complete readiness gate in System or Settings and acknowledge the final LIVE confirmation. A failed runtime gate automatically disables LIVE and records a trading-halted event.

## API Live Safety Gate

The gate requires an active `BOT_TRADING` wallet whose address matches the account's bot configuration, a matching `RPC_NETWORK` (defaults to `mainnet-beta`), and `BOT_TRADING_WALLET_SECRET` injected into the API process by the deployment's secret manager. Never put that secret in `.env`, a database field, logs, browser storage, or an API request. The API does not return the secret.

The following health values must be explicitly set to `true` only after their real probes pass: `RPC_HEALTHY`, `REDIS_HEALTHY`, `EXECUTION_PROVIDER_HEALTHY`, `MARKET_DATA_HEALTHY`, `RISK_ENGINE_HEALTHY`, and `POSITION_MANAGER_HEALTHY`. `EXECUTION_PROVIDER_URL` must also be configured and `CRITICAL_SYSTEM_ERRORS` must be zero. Positive daily-loss, maximum-position, maximum-slippage, and maximum-exposure limits must exist in the account's persisted risk settings.

The status endpoint lists every check and its exact blocking reason. Settings writes cannot change LIVE authorization; the dedicated enable and disable endpoints persist and audit it. Enabling requires an extra acknowledgement in the UI. Emergency stop is persisted globally, and clearing it requires a separate administrator confirmation; clearing it does not enable LIVE. Audit actions include `live_mode_enabled`, `live_mode_disabled`, `safety_gate_passed`, `safety_gate_failed`, `emergency_stop`, and `trading_halted`.

## Required Server Integrations Before Enabling

- Supply a `TradingWalletSigner` backed by an approved custody/KMS implementation. Do not put private keys or seed phrases in `.env`, browser storage, database plaintext, or approval request bodies.
- Supply a `LiveExecutionSafetyGate` that reads the authenticated user's current PostgreSQL mode/settings, current risk decision, wallet ownership/configuration, circuit-breaker state, and global LIVE enablement.
- Construct `SafeLiveExecutionEngine` only in a server process and inject `PrismaExecutionAttemptStore` with the Prisma client.
- Build the request from server-side signal, risk, size, and wallet records. Do not accept quote, slippage, output minimum, route, wallet, or signing parameters from a browser client.
- Configure Jupiter and RPC endpoints through server deployment configuration. The Jupiter provider stays behind the generic provider interface.

## Submission Recovery

Broadcast uses `maxRetries: 0`. If broadcast or confirmation has an ambiguous result, the attempt becomes `UNKNOWN`; subsequent calls query signature status through `lookupSubmission` and never resend the signed transaction. A confirmed status, failed status, pending submission, or still-unknown status is persisted.

The adapter does not treat a missing signature status as proof that submission failed. An operator must continue reconciliation until the network outcome is definitive; a new idempotency key must not be created to retry an `UNKNOWN` transaction.
