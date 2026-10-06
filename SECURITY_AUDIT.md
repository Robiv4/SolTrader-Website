# Security Audit

Date: 2026-09-26
Scope: API, web app, worker, PostgreSQL/Prisma, Redis, RPC and market-data adapters, execution/paper engine, wallet abstractions, Telegram monitoring, Docker, dependencies, logging, and generated build output.

This is a code/configuration audit, not a penetration test. No claim of system security is made solely from automated test results.

## Executive Summary

The API defaults to PAPER and LIVE authorization is multi-layered. The security pass found cross-user reads/mutations in trading resources and realtime event delivery, as well as overly broad diagnostic/error payloads. Those paths are now scoped by authenticated ownership or restricted to administrators, with security regression tests.

The local `.env` contains plaintext credentials and must be treated as compromised and rotated. It is ignored and not tracked by Git; that does not protect secrets from local backups, shell history, logs, or prior commits.

## Findings

### HIGH-01: Plaintext local credentials and secret-like placeholders

Status: Partially remediated, rotation required.

The local `.env` contains a plaintext PostgreSQL password and placeholder JWT material. `.env` is ignored, but ignored files are still exposed to local users, backups, process tooling, and accidental distribution. The repository also previously had known fallback database/session/admin values in runtime configuration and Docker Compose.

Actions taken:

- Removed API session/admin/database fallback values.
- Removed shared package and worker database/Redis URL defaults.
- Removed Docker Compose database credential fallbacks.
- Added mandatory environment placeholders to `.env.example`.

Required operator action: rotate the local database password and any secret that has ever been used outside the local machine. Do not paste replacement secrets into source control.

### HIGH-02: Privileged mutations were not role-restricted

Status: Fixed.

Authenticated users could reach bot lifecycle, emergency-stop, settings, and live-safety mutations because authentication was present but role authorization was not consistently enforced.

Actions taken:

- Added server-side `requireAdmin` enforcement to global bot lifecycle, emergency stop, and LIVE authorization endpoints. Per-user settings mutations remain available to authenticated users but are keyed by their session user ID.
- Added direct API bypass tests.

### HIGH-03: Credentialed wildcard CORS enabled cross-origin abuse risk

Status: Fixed.

The API used `origin: true` with credentials, reflecting arbitrary origins. This is unsafe for cookie-authenticated APIs.

Actions taken:

- Added an explicit `CORS_ORIGINS` allowlist.
- Rejected disallowed origins on state-changing requests.
- Added production rejection when a state-changing cookie request has no Origin header.
- Kept the LIVE safety status GET read-only; state changes require explicit POST actions.

### HIGH-05: Cross-user trading-resource access (IDOR)

Status: Fixed and regression-tested.

Position, trade, signal, wallet, risk-setting, approval, analytics, backtest, and embedded token data are scoped to the authenticated owner. Position closure and worker position/trade/account writes include owner predicates. Global bot control and monitoring are administrator-only. Realtime events are owner-tagged; ownerless platform events are admin-only.

Actions taken:

- Added multi-user tests for wallet confidentiality, risk-setting isolation, trade/position/signal/analytics isolation, and unauthorized position closure.
- Added SSE tenant-filter tests and role checks for bot controls and system diagnostics.
- Removed global monitoring snapshots from the health response.

### HIGH-04: Docker defaults allowed unsafe deployment configuration

Status: Fixed in Compose; deployment review still required.

PostgreSQL used known fallback credentials and Redis was unauthenticated. Database and Redis ports are also published to the host.

Actions taken:

- Compose now requires explicit PostgreSQL credentials and connection URLs.
- Redis requires an explicit password and starts with `requirepass`.
- Removed known password/URL fallbacks.

Residual risk: host-published database/Redis ports should be removed or bound to loopback/private networks in production. Compose secrets should use a secret manager rather than environment interpolation.

### MEDIUM-01: CSRF protection is origin-based, not token-based

Status: Mitigated, residual risk remains.

Cookie-authenticated state changes now enforce an origin allowlist and production requires Origin. There is no synchronizer token or double-submit CSRF token.

Residual risk: non-browser clients and unusual proxy/header behavior require separate review. Add a CSRF token scheme before exposing the API to untrusted browser origins.

### MEDIUM-02: API rate limiting was previously authentication-only

Status: Mitigated.

Auth requests are limited to 10 failed attempts per 15 minutes, sensitive route families to 30 requests per minute, and general `/api` traffic to 120 requests per minute. JSON bodies are bounded to 1 MB.

Residual risk: limits are process-local and may be bypassed across multiple instances. Use a shared Redis-backed limiter at scale.

### MEDIUM-03: Session revocation depends on database availability

Status: Production fallback disabled; development fallback remains.

The API uses in-memory users/sessions only for non-production database outages. Production session lookup fails closed when PostgreSQL is unavailable; PostgreSQL is checked before any development fallback session.

Residual risk: development fallback state is process-local and must not be used for multi-instance deployments.

### MEDIUM-04: Telegram and monitoring data exfiltration risk

Status: Mitigated.

Telegram delivery is opt-in and throttled. Pino paths, audit data, realtime payloads, and legacy strategy JSON responses redact secret-like keys; strategy writes reject such fields. Health responses omit raw probe errors.

Residual risk: arbitrary secret values under innocuous field names cannot be recognized by key-based redaction. Keep notification and event payloads allowlisted by event type.

### MEDIUM-05: RPC and market-data trust boundaries

Status: Residual risk.

RPC and provider adapters have timeout/failover and malformed-data handling, but provider responses are external trust boundaries. Token metadata, market data, quote output, and RPC responses require validation and independent corroboration before any future live enablement.

### MEDIUM-06: SSRF and egress controls

Status: Residual risk.

HTTP market-data endpoints are environment-configured, but there is no URL allowlist, private-network rejection, DNS rebinding defense, or outbound egress policy. Keep provider URLs operator-controlled and add network-level egress restrictions before multi-tenant/provider-configurable operation.

### MEDIUM-07: Remaining transitive dependency advisories

Status: Residual risk, no critical/high findings remain in the final audit.

`pnpm audit --prod` after remediation reports two moderate transitive advisories: `uuid@8.3.2` and `stream-json@1.9.1`, both reached through `@solana/web3.js` and its `jayson` dependency. They are not direct application dependencies. Upgrading or replacing the upstream Solana client should be tested as a separate compatibility change.

The audit initially found critical Next.js RCE advisories and high `sharp`/PostCSS advisories. These were remediated by upgrading Next.js to `15.5.24` and applying patched `sharp >=0.35.4` and `postcss >=8.5.18` pnpm overrides.

### LOW-01: Generated `.next` and build artifacts contain source-derived strings

Status: Informational.

Build output is ignored and was included in local search results. It should not be packaged or uploaded as an authoritative source tree. Run secret scanning on release artifacts separately.

### LOW-02: Realtime events require tenant ownership metadata

Status: Mitigated.

Authenticated SSE clients are associated with a principal. Tenant events are delivered only to their owner; ownerless events are admin-only. Re-audit payload ownership when adding event types.

## Threat Model Coverage

- Stolen credentials: bcrypt password hashes, rate-limited login, signed HTTP-only cookies; rotate local credentials and disable production DB fallback.
- Stolen trading key: no raw private-key storage/signing material was found in source; live signing remains disabled. Dedicated wallet custody still requires operational review.
- Malicious frontend requests: backend authentication, admin authorization, live safety gate, role checks, origin enforcement, and rate limits.
- API abuse: auth/API rate limits and 1 MB JSON body cap; distributed throttling remains.
- SSRF: environment-only provider URLs reduce exposure; no network egress policy yet.
- SQL/NoSQL injection: Prisma parameterized queries observed; no raw user SQL construction found in the inspected API paths.
- XSS: React rendering is escaped; no `dangerouslySetInnerHTML` was found in application source. CSP is not configured.
- CSRF: explicit CORS/origin enforcement added; token-based CSRF remains.
- Replay/duplicate transactions: execution engine has idempotency keys; production durable idempotency storage needs verification before live use.
- Race conditions: in-memory safety/session state is process-local; multi-instance locking and durable circuit-breaker state are still required.
- Compromised RPC/provider: health/failover and malformed-data protections exist; independent validation is still required.
- Privilege escalation: admin checks guard global bot controls; user-owned mutations include owner filters; role provisioning/bootstrap must be reviewed operationally.
- Logging/Telegram: correlation IDs and recursive key redaction are in place; payload allowlists remain recommended.

## Checks Performed

- Repository searches for private keys, seed phrases, mnemonics, passwords, secrets, API keys, database URLs, Redis URLs, and token material.
- Authentication/session/API/live-safety code inspection.
- Multi-user API tests for wallet, settings, positions, trades, signals, analytics, role enforcement, CSRF, rate limiting, and realtime ownership.
- Frontend route and API client inspection.
- Worker, Docker Compose, Dockerfile, Prisma schema, RPC, market-data, execution, wallet abstraction, monitoring, and Telegram inspection.
- Dependency metadata inspection.
- `pnpm audit --prod` before and after dependency remediation.

No raw private key, seed phrase, or mnemonic was found in application source. A plaintext database password was found in the ignored local `.env` and must be rotated.

## Validation

The following commands were run after the fixes:

- `pnpm typecheck`
- `pnpm lint`
- `pnpm test`
- `pnpm build`

The final production dependency audit reports two moderate transitive advisories and no critical/high advisories. These checks validate compilation and regression behavior only; they do not replace secret scanning, container scanning, penetration testing, production configuration review, or database/Redis network review.

## Recommended Next Actions

1. Immediately rotate the admin credential, PostgreSQL credential, session signing secret, and any other credential present in the shared `.env` excerpt; verify no historical commit or backup contains those values.
2. Add durable distributed idempotency and circuit-breaker state.
3. Add CSRF tokens and a strict Content Security Policy.
4. Run `pnpm audit`, container image scanning, secret scanning, and infrastructure scans in CI.
5. Remove public database/Redis port publishing in production and use managed secrets.
6. Add allowlisted Telegram payload schemas and provider URL/egress restrictions.
7. Do not enable LIVE trading until an independent review verifies wallet custody, signing isolation, RPC/provider integrity, and durable safety state.
