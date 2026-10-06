# Soltrader Implementation Plan

## 1. Executive summary

The repository is effectively empty at the moment. There are no application folders, no frontend/backend split, no database configuration, no TypeScript project, no package manifest, no tests, and no Docker setup in the current workspace. The project appears to be a greenfield initiative rather than a continuation of an existing codebase.

Because there is no existing implementation to preserve, the plan below is a safe, architecture-first blueprint for a Solana memecoin trading platform that supports SCANNER, PAPER TRADING, SEMI-AUTO, and LIVE TRADING, while enforcing the required safety constraints:

- PAPER is the default mode.
- LIVE is disabled by default.
- Private keys never reach the frontend.
- The user’s main wallet is never used as the automated trading wallet.
- Real-money execution requires explicit approval and safeguards.

This plan avoids large feature implementation in the current phase and focuses on creating the minimal secure foundation for a trading platform.

---

## 2. Current repository assessment

### Repository state

Observed state from inspection:

- Root folder exists but contains no application source code.
- Hidden .qodo directory exists, but no working project files were found under the workspace root.
- No Git repository content is present beyond an empty workspace state.
- No package manager files such as package.json, pnpm-lock.yaml, yarn.lock, or bun.lock are present.
- No TypeScript config is present.
- No Docker files (Dockerfile, docker-compose.yml, compose.yaml) are present.
- No environment configuration files (.env, .env.example, .env.local) are present.
- No frontend or backend app directories are present.
- No tests or CI setup are present.
- No database schema or migration files are present.
- No Solana or blockchain integration code is present.
- No authentication or API layer is present.

### Conclusion

This repository is not yet a monorepo and is not yet a working application. It is a blank slate with no code to reuse. The architecture therefore needs to be designed from a clean foundation rather than refactored.

---

## 3. Current architecture

At present, the current architecture is:

- No backend service
- No frontend app
- No database
- No message bus or queue
- No wallet infrastructure
- No deployment pipeline
- No domain model
- No security boundary around execution

In other words, the current architecture is effectively nonexistent.

---

## 4. Proposed architecture

The platform will be structured as a modular monorepo with strict runtime separation between observation, simulation, automation, and live execution.

### High-level design

- Frontend: user dashboard, market scanning, strategy review, execution status, settings, paper trade ledger
- API: authenticated backend service for frontend access and orchestration
- Core services:
  - Scanner
  - Market Data Ingestion
  - Strategy Engine
  - Risk Engine
  - Trading Engine
  - Execution Engine
  - Wallet & Key Management
  - Notification / Alerting
- Persistence:
  - PostgreSQL for relational data
  - Redis for cache, job queues, and pub/sub
  - object storage for logs and export artifacts
- Runtime model:
  - paper mode as default
  - live mode gated by explicit env + admin approvals + policy checks

### Runtime mode model

The platform will define a strict execution mode matrix:

- SCANNER: read-only signal collection and market scanning; always available
- PAPER TRADING: simulated order execution against a paper ledger; default runtime mode
- SEMI-AUTO: human approval required before each action; recommended for operational automation
- LIVE TRADING: real on-chain execution; disabled by default; requires explicit env policy + approval + isolated wallet

### Safety requirements

- LIVE must never be active by default.
- Frontend must never receive private keys, seed phrases, or raw signing material.
- Automated trading must use dedicated backend-managed wallet(s) separate from the user’s main wallet.
- Live execution must require multiple safeguards: policy gate, environment flag, explicit trade approval, risk limits, kill switch, and audit trail.

---

## 5. Directory structure

```text
soltrader/
├─ .env.example
├─ .gitignore
├─ docker-compose.yml
├─ Dockerfile
├─ package.json
├─ pnpm-workspace.yaml
├─ turbo.json
├─ README.md
├─ IMPLEMENTATION_PLAN.md
├─ apps/
│  ├─ web/
│  │  ├─ app/
│  │  ├─ components/
│  │  ├─ lib/
│  │  ├─ public/
│  │  └─ package.json
│  └─ api/
│     ├─ src/
│     ├─ test/
│     └─ package.json
├─ packages/
│  ├─ shared/
│  │  ├─ types/
│  │  ├─ schemas/
│  │  └─ utils/
│  ├─ config/
│  │  └─ env/
│  └─ ui/
│     └─ components/
├─ services/
│  ├─ scanner/
│  │  └─ src/
│  ├─ market-data/
│  │  └─ src/
│  ├─ strategy-engine/
│  │  └─ src/
│  ├─ risk-engine/
│  │  └─ src/
│  ├─ trading-engine/
│  │  └─ src/
│  └─ execution-engine/
│     └─ src/
├─ infra/
│  ├─ postgres/
│  ├─ redis/
│  ├─ monitoring/
│  └─ k8s/
├─ scripts/
│  ├─ bootstrap/
│  ├─ migrate/
│  └─ seed/
├─ docs/
│  ├─ architecture/
│  ├─ runbooks/
│  └─ security/
└─ tests/
   ├─ e2e/
   ├─ integration/
   └─ smoke/
```

This is a proposed layout for a scalable system. In Phase 1, a simplified version can be created without all sub-services being fully populated.

---

## 6. Technology choices

### Frontend

- Next.js with TypeScript
- App Router for route-based dashboard structure
- Tailwind CSS or component library for UI speed
- Zustand or React Query for client-side state
- HTTPS only, strict CORS policy, no wallet secrets in browser state

### Backend

- Node.js with TypeScript
- NestJS or Fastify as service framework
- REST API for dashboard and admin actions
- WebSocket or SSE for streaming scanner and order updates
- Background workers for scanner and strategy execution

### Database

- PostgreSQL for all relational domain data
- Redis for caching, queueing, and ephemeral state
- Optional ClickHouse or TimescaleDB later for high-volume OHLCV analytics, though not required for initial phase

### Solana stack

- @solana/web3.js (backend only)
- @solana/spl-token for token metadata / balance checks
- Jupiter API for quote routing when needed
- Helius or RPC provider for memecoin / token market data
- Wallet adapters only on backend-controlled service flows

### Package manager

- pnpm workspaces as the default monorepo package manager
- Lockfile committed for reproducibility

### Containerization

- Docker Compose for local development
- Production deployment via container orchestration or VM-based deployment later

---

## 7. Database architecture

### Core relational model

PostgreSQL should hold all structured system state:

- users
- portfolios
- wallets
- trading_accounts
- strategies
- scans
- market_events
- orders
- executions
- positions
- paper_balances
- live_balances
- alerts
- audit_logs
- approvals

### Data segregation

The platform must separate:

- user identity data
- trading wallet metadata
- execution ledger
- market data snapshots
- strategy output data
- audit trail and compliance trail

### Wallet model

The system should never store raw private keys in application data tables. Instead:

- use a secure key vault / HSM / KMS pattern or encrypted storage with restricted access
- backend-managed wallet descriptors only
- separate trading wallet(s) from user identity wallet(s)
- an explicit wallet registry mapping a user to an isolated trading wallet account

### Redis usage

Redis is intended for:

- real-time cache of scanner state
- job queues for strategy evaluation and execution
- pub/sub for live UI updates
- ephemeral rate-limit state

### Safety note

Paper and live balances should be modeled as separate ledger domains. Live execution should never be permitted to mutate paper state or vice versa without explicit stage transitions.

---

## 8. API architecture

### API layers

1. Public / auth API
   - user login
   - session management
   - MFA / SSO support if needed

2. Dashboard API
   - portfolio summary
   - scanner results
   - strategy states
   - recent executions
   - risk status

3. Strategy API
   - create/update strategy
   - enable/disable strategy
   - manual override
   - backtest results

4. Execution API
   - simulate order
   - submit paper order
   - approve live order
   - cancel / close position

5. Admin / policy API
   - enable live mode
   - modify risk limits
   - emergency kill switch

### Security requirements

- JWT or secure session tokens with refresh rotation
- RBAC for admin vs operator vs viewer
- all execution endpoints require strict backend validation
- no direct wallet signing from browser code
- signed server-side execution proofs for live routes

### Streaming

Use WebSockets or SSE for:

- live market updates
- order status changes
- scanner alerts
- execution events

---

## 9. Frontend routes

Recommended route structure:

```text
/app
├─ /login
├─ /dashboard
│  ├─ /overview
│  ├─ /scanner
│  ├─ /portfolio
│  ├─ /strategies
│  ├─ /orders
│  ├─ /risk
│  └─ /activity
├─ /paper
│  ├─ /overview
│  ├─ /positions
│  ├─ /history
│  └─ /settings
├─ /semi-auto
│  ├─ /watchlist
│  ├─ /approvals
│  └─ /automation
├─ /live
│  ├─ /status
│  ├─ /approvals
│  ├─ /wallets
│  └─ /kill-switch
├─ /admin
│  ├─ /settings
│  ├─ /risk-policy
│  ├─ /security
│  └─ /audit
└─ /help
```

### Frontend behavioral constraints

- PAPER dashboard should be the default landing experience.
- LIVE routes should be hidden or disabled unless a secure environment flag and policy approval are active.
- No private key fields displayed in browser UI.
- Wallet addresses can be shown only when non-sensitive and explicitly approved for display.

---

## 10. Trading-engine architecture

The trading engine will be the orchestration layer that evaluates market conditions and decides whether to:

- just scan,
- simulate paper order,
- queue a semi-auto approval,
- or submit a live managed order.

### Responsibilities

- subscribe to market events
- evaluate strategy signals
- compute target allocations
- apply risk constraints
- generate order intents
- handoff to execution service or paper ledger

### Core components

- signal ingestion
- portfolio state snapshot
- position sizing
- order generation
- mode-specific execution router

### Required modes

- SCANNER mode: no capital movement, pure signal observation
- PAPER mode: order intents are recorded to a simulation ledger
- SEMI-AUTO mode: human approval gate before actual action
- LIVE mode: live wallet execution only after explicit policy approval

### Important guardrails

The engine must never bypass risk checks. A real-money execution path must include:

- explicit mode enabled
- wallet identity validated
- balance verification
- slippage tolerance check
- position limits
- daily loss caps
- kill-switch validation
- execution audit log

---

## 11. Market-data architecture

The market-data layer is critical for memecoin detection, token health, and opportunity scanning.

### Sources

- Solana RPC node provider
- Helius / private RPC for transaction and token data
- DEX API and pool metadata
- Solana token metadata registry
- internal scanner heuristics for new token discovery

### Event types

- token creation / mint events
- liquidity pool movement
- volume spikes
- price and volatility events
- social/signal aggregation events
- pump/farm detection heuristics

### Data pipeline

- ingest raw market events
- normalize into canonical models
- enrich with liquidity and metadata
- store snapshots in Postgres/Redis
- push filtered events to strategy engine

### Anti-pattern to avoid

The market-data service must not be allowed to drive real execution directly without a strategy, risk, and approval pass.

---

## 12. Risk-engine architecture

The risk engine is the primary safety boundary for all trade decisions.

### Responsibilities

- maximum position sizing
- portfolio concentration checks
- max drawdown limits
- daily loss caps
- token-specific risk limits
- slippage and gas checks
- active wallet exposure controls
- blacklisting or circuit breakers

### Safety design

The risk engine should be a policy module with strict validation rules. If a rule fails, execution is blocked before any RPC call or on-chain action is initiated.

### Suggested rules

- max open positions
- max token exposure by wallet
- max trade size per symbol
- minimum liquidity threshold
- reject if market data stale
- reject if live mode disabled
- reject if order exceeds policy thresholds
- require two-stage approval for all live actions

---

## 13. Strategy-engine architecture

The strategy engine converts market conditions into trade ideas and order intents.

### Core inputs

- market data
- on-chain liquidity metrics
- volatility and volume signals
- risk limits
- portfolio state
- user-selected strategy parameters

### Outputs

- buy/sell/hold suggestions
- position sizing recommendations
- confidence score
- trade rationale metadata

### Strategy categories

- scanner-only detection strategies
- paper-trading strategies
- semi-auto approval strategies
- live strategies (disabled by default)

### Implementation approach

This engine should start as a deterministic, rule-based component rather than a large ML-heavy system. Rule-based strategies are easier to audit, safer to test, and more appropriate for an initial platform version.

---

## 14. Execution-engine architecture

The execution engine is responsible for turning approved intents into actions.

### Modes

1. Paper execution engine
   - mutates only paper ledger
   - no wallet network access
   - no real funds or on-chain transactions

2. Semi-auto execution engine
   - builds an execution package
   - requires manual approval
   - may still be simulated or backed by managed wallet depending on policy

3. Live execution engine
   - uses controlled backend-managed wallet
   - must include policy validation and explicit approvals
   - logs all transaction hash and receipt data

### Critical constraints

- no browser wallet signing
- no direct user wallet reuse for automated flows
- no direct broadcast in live mode unless policy gate passes
- all transaction receipts stored in immutable audit history

---

## 15. Security model

Security must be treated as a first-class architecture concern.

### Mandatory constraints

- Private keys must never be exposed to the frontend.
- User main wallet must never be used as the automated trading wallet.
- Paper mode is the default execution mode.
- Live mode is disabled unless explicitly enabled in secure configuration.
- Live actions require explicit approval flows and risk checks.
- Backend must own all secret storage and signing operations.
- Sensitive actions must be logged with actor, timestamp, intent, policy result, and outcome.

### Recommended controls

- KMS or encrypted secret manager for wallet key material
- strict environment variable protection
- least-privilege service accounts
- network segmentation between public frontend and internal execution services
- admin-only access to live controls
- emergency kill switch for all active strategies
- request signing and idempotency keys for execution requests

### Threats to address

- accidental live activation
- key leakage via frontend or logs
- stale or wrong RPC data
- excessive slippage or gas spikes
- runaway strategy loops
- compromised operator access
- failed order state reconciliation

---

## 16. Deployment architecture

### Local / dev

- Docker Compose for Postgres, Redis, API, frontend, and RPC proxy
- health checks and environment bootstrap scripts
- seeded sample portfolio and paper strategy state

### Staging

- same architecture, isolated environment
- live mode intentionally disabled
- production-like monitoring and logging enabled

### Production

- separate container services or Kubernetes deployment
- dedicated secrets management
- external database with backups
- logging and traces with audit retention
- strict network rules between frontend, API, and execution nodes

### Production safety rule

Real-money execution should not be enabled in any environment without explicit operational review and risk policy enforcement.

---

## 17. Phased implementation plan

### Phase 0: Foundation and repo initialization

Goals:

- initialize monorepo structure
- set up TypeScript and linting rules
- create environment templates
- create Docker Compose skeleton
- set up PostgreSQL and Redis containers
- establish base API/frontend shells

Deliverables:

- package.json and workspace config
- tsconfig base setup
- eslint and prettier config
- .env.example
- Docker Compose infrastructure
- initial README and architecture docs

### Phase 1: Core platform skeleton

Goals:

- create API service with health checks
- create web app shell with dashboard routes
- define core database schema
- add user and portfolio model
- add paper execution ledger and order tracking

Deliverables:

- app bootstrap
- login/dashboard shell
- base API endpoints
- DB migrations
- safety-config model and env flags

### Phase 2: Scanner and market-data ingestion

Goals:

- ingest market data from RPC and memecoin scanning feeds
- normalize data
- build detection heuristics
- expose scanner results via API

Deliverables:

- token scan logic
- scanner worker service
- alerts and watchlist
- market snapshot storage

### Phase 3: Paper trading and semi-auto workflow

Goals:

- simulate orders in paper mode
- create trade approval pipeline
- add strategy states
- support user-reviewed automation

Deliverables:

- paper ledger accounting
- strategy execution queue
- order approval workflow
- UI for reviewing semi-auto actions

### Phase 4: Live trading enablement with safeguards

Goals:

- enable backend-only execution wallet model
- gate live mode behind secure approval
- add kill switch and risk policy enforcement
- ensure audit trail and transaction receipts

Deliverables:

- isolated live wallet integration
- live policy checks
- kill switch controls
- deployment safeguards and runbooks

### Phase 5: Production hardening

Goals:

- monitoring, tracing, and alerting
- backups and restore checks
- load and resilience testing
- final security review

---

## 18. Known risks

- Memecoin market volatility is extreme and materially increases risk.
- Market data quality can be inconsistent or delayed.
- RPC provider outages can cause missed signals or stale state.
- Automated workflows may misinterpret token liquidity and market microstructure.
- Live wallet misuse is a major operational and legal risk.
- Frontend-only execution logic is unsafe for a trading system.
- Lack of robust audit trails can make incident review difficult.
- Incomplete risk logic can expose capital unexpectedly.

---

## 19. Assumptions

- The project is being started from a clean repository.
- The platform is intended for a Solana memecoin trading workflow.
- The system will be developed with strong emphasis on safety, not speed.
- Existing code is not available to reuse.
- The initial implementation should prioritize structure, safety, and testability before advanced trading features.
- The market strategy is exploratory and should stay rule-based early on.
- The user’s main wallet will not be used for automated trading.
- Real-money execution will remain gated behind explicit operational safeguards.

---

## 20. Existing repository summary

The repository currently contains no application code, no dependency manifests, no frontend/backend split, no database configuration, no test harness, and no blockchain integration. It is effectively a blank slate, which means all architecture decisions must be designed from the ground up.

---

## 21. Proposed architecture summary

The project should be structured as a secure TypeScript monorepo with a frontend, API layer, service-oriented trading architecture, PostgreSQL database, Redis for queueing and state, and backend-managed Solana wallet handling. The platform should support SCANNER, PAPER TRADING, SEMI-AUTO, and LIVE TRADING, with PAPER as the default and LIVE disabled by default. All live execution must be gated behind secure, server-side policy checks, isolated wallets, and explicit approvals.

---

## 22. Phase 1 files to create or modify

The following would be the initial priority file set in Phase 1:

- package.json
- pnpm-workspace.yaml
- turbo.json
- .gitignore
- .env.example
- README.md
- docker-compose.yml
- Dockerfile
- apps/web/package.json
- apps/web/tsconfig.json
- apps/web/app/page.tsx
- apps/api/package.json
- apps/api/tsconfig.json
- apps/api/src/main.ts
- apps/api/src/app.module.ts
- packages/shared/package.json
- packages/shared/src/types/index.ts
- packages/config/package.json
- infra/postgres/init.sql
- infra/redis/redis.conf
- docs/architecture/overview.md
- docs/security/security-model.md

This list is intentionally limited to the minimum project scaffold and safety foundation. It does not yet include full trading strategies or live execution logic.

---

## 23. Blockers

The major blockers for a production-ready trading platform are:

- the repository is empty, so there is no codebase to integrate with
- no existing wallet security model or key management process
- no database or service infrastructure is present
- no environment configuration exists yet
- no risk policies or approval flows exist yet
- no deployment or monitoring setup exists yet
- Solana execution and memecoin strategy logic must be designed with strict safety controls from the beginning

---

## 24. Completion note

This document intentionally avoids large feature implementation. The next step is to initialize the monorepo skeleton, environment files, and infrastructure foundation required before building scanner, paper, semi-auto, and live-trading workflows.
