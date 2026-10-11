# Soltrader

A Solana memecoin trading platform scaffold designed for safe Phase 1 deployment.

## Included in this phase

- Monorepo workspace layout
- TypeScript config
- ESLint + Prettier
- Vitest configuration
- Environment variables and `.env.example`
- Docker Compose setup for PostgreSQL and Redis
- Backend API with health and simulation endpoints
- Worker service for queue and runtime startup
- Basic dashboard shell for trading platform UI
- Shared types and platform guardrails

## Default behavior

- Trading mode defaults to `PAPER`
- Live trading remains disabled unless explicitly enabled in the environment
- No private key material is exposed to the frontend
- Real execution is intentionally not implemented in this phase

## Quick start

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

## Local services

PostgreSQL and Redis must be reachable at the `DATABASE_URL` / `REDIS_URL` from `.env`. Either use locally
installed services, or Docker Compose (which requires `POSTGRES_*`, `REDIS_PASSWORD` and `DATABASE_URL_DOCKER`
to be set in `.env`):

```bash
docker compose up -d postgres redis
```

Then prepare the database and start the three processes (each in its own terminal):

```bash
pnpm install
pnpm db:generate
pnpm db:deploy
pnpm --dir apps/api dev      # http://localhost:3001
pnpm --dir apps/worker dev   # New Launch discovery, paper execution, position protection, ML SHADOW
pnpm --dir apps/web dev      # http://localhost:3000
```

Sign in with `ADMIN_EMAIL` / `ADMIN_PASSWORD` from `.env`, then start the bot on the System page.

`pnpm db:deploy` takes a backup first. Never reset the database; see [docs/DATABASE_SAFETY.md](docs/DATABASE_SAFETY.md). Exit rules, formulas and priority: [docs/EXIT_ENGINE.md](docs/EXIT_ENGINE.md).

Note: the API test suite (`pnpm test`) runs against the database in `DATABASE_URL` and creates its own
`admin@soltrader.local` test user and fixture rows there.

## Wallets

- **User wallet** (Settings → Wallet): connected through a browser wallet extension (Phantom, Solflare,
  Backpack or another injected Solana wallet). The wallet signs a one-time challenge issued by the API
  (`POST /api/settings/wallet/challenge`), and the API verifies the ed25519 signature before linking the
  address. The message authorizes no transaction and costs no fee. Only the public address is stored.
- **Bot trading wallet**: an administrator registers its public address. Its signing key is never sent to
  the browser; it is provided to the server through secret management (`BOT_TRADING_WALLET_SECRET`).
- SOL balances are read from the Solana RPC for the wallet's network (`SOLANA_PRIMARY_RPC_URL` /
  `SOLANA_RPC_URL` for mainnet, the public endpoints for devnet/testnet).

## Environment

Use `.env.example` as the template for local environment configuration. Never commit real secrets.
