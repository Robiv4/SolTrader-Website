# Social Intelligence (NewLaunch, Telegram-first, deterministic, MONITOR_ONLY)

**Principle:** measure first, do not trade on it.

The engine asks five questions about a token:

1. Is attention accelerating?
2. Is it spread across independent participants?
3. Does on-chain activity confirm it?
4. Is liquidity sufficient?
5. Is the move already exhausted?

It never says "Twitter is hyped → BUY".

## Architecture

| Layer | Code |
| --- | --- |
| Deterministic core (no LLM, pure) | `packages/strategy-engine/src/social/index.ts` |
| Providers | `apps/worker/src/social/providers.ts` (X, optional), `apps/worker/src/social/telegram.ts` (Telegram MTProto, primary) |
| Telegram login (one-time) | `apps/worker/scripts/telegram-login.ts` |
| Telegram analytics | `apps/api/src/telegram-analytics.ts` |
| Metadata (stage 1) | `apps/worker/src/social/metadata.ts` |
| Collection and snapshots | `apps/worker/src/social/social-service.ts` |
| NewLaunch integration | `apps/worker/src/launch/new-launch-service.ts` (`socialFor`, `socialBlocksEntry`) |
| Analytics | `apps/api/src/social-analytics.ts` (**Elemzések → Új token → Közösségi**) |

Token page: `GET /api/tokens/:address/social`. System page: `social:health`.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `TELEGRAM_SOCIAL_ENABLED` | `false` | Telegram provider on. Credentials are validated only when on; missing ones give `NOT_CONFIGURED` and one error log, never a crash. |
| `TELEGRAM_API_ID`, `TELEGRAM_API_HASH` | — | From https://my.telegram.org (API development tools). |
| `TELEGRAM_SESSION` | — | MTProto StringSession, created once with `pnpm --filter @soltrader/worker telegram:login`. A secret with full account access: never logged, never returned by the API, never shown in Settings, never committed. |
| `TELEGRAM_MAX_MONITORED_SOURCES` | `50` | Max distinct chats polled at once. |
| `TELEGRAM_GLOBAL_SEARCH_PER_MIN` | `2` | Mint-address searches per minute for community chats (0 = official links only). |
| `X_SOCIAL_ENABLED` | `false` | X off = provider `DISABLED`, zero requests, no warnings. |
| `AI_SOCIAL_ANALYSIS_ENABLED` | `false` | Off = zero LLM calls. |

Engine status: `HEALTHY` (all enabled providers usable), `PARTIAL`, `DEGRADED`, `NO_PROVIDER` (nothing enabled and configured).

## Telegram provider

- **Connection states:** `DISABLED`, `NOT_CONFIGURED`, `CONNECTING`, `CONNECTED`, `DEGRADED`, `RATE_LIMITED`, `DISCONNECTED`.
- **Reconnect:** exponential back-off 5 s to 5 min; an unauthorized session retries every 10 min (run `telegram:login` again).
- **FLOOD_WAIT:** GramJS never sleeps internally (`floodSleepThreshold: 0`); the provider makes no request until the wait (+1 s) has passed.
- **Discovery order (registry `TelegramSource`, provenance in `matchBasis`):**
  1. the official link from the mint's metadata (`OFFICIAL`, `OFFICIAL_SOCIAL_LINK`, 0.9, via `PUMP_FUN_METADATA`);
  2. a Telegram link from the DEX Screener profile of a pair whose **base token is the mint** (`PROBABLE_OFFICIAL`, `DEXSCREENER_LINK`, 0.8, via `DEXSCREENER`). The link is handed over read-only from the Community service (no extra request);
  3. only while no verified source is readable: a budgeted public search for the exact mint (`COMMUNITY`, `MINT_ADDRESS`, 0.6, via `TELEGRAM_SEARCH`). Only public groups whose message contains the exact mint are attached (max 2 per token). Broadcast channels, chats without a public username and ticker / name-only hits are rejected and counted. Messages from such groups count only when they contain the exact mint (`mintOnly`): call groups discuss many tokens.

  A name or ticker never attaches a chat. Links are normalised (`normalizeTelegramLink`: t.me / telegram.me / telegram.dog / tg://resolve / @handle). Rejected: private invites (`t.me/+…`, `joinchat`, `t.me/c/…`, never resolved or joined), reserved paths, other hosts, invalid usernames and bots. Inaccessible chats are stored as `NO_ACCESS`.
- **Subscriptions:** one buffer per chat shared by all tokens (one history request per chat per 5 s), per-token cursors, released when the token is no longer tracked.
- **Messages:** stable id `tg:<chat>:<message>` (deduplicated), SHA-256 hashed sender, reply / forward / forwards / views. Raw text stays in memory only for 31 minutes (the longest window is 30 min); stored snapshots contain features only.
- **History vs. fresh:** the first page of a chat is mostly history (possibly years old). Messages older than 31 minutes at fetch time are counted as `historicalMessagesSkipped` and are never in any window. `freshMessages` / `lastFreshMessageAt` show real live activity.
- **Time correctness:** a source is only available to snapshots taken at or after the moment it was first read (`coverageKnownAt`). An earlier moment reports "no source" (null), never zero activity.
- **Broadcast channels** are admin announcements, not community activity: they contribute member counts only (no message coverage).
- **Member growth** is computed only from real member-count samples (1 / 5 / 15 min); otherwise `null`.

## Data sources (authorized only)

| Source | Access | Without access |
| --- | --- | --- |
| Telegram (MTProto) | Public channels / groups by public username and chats the configured account already belongs to. | `NO_ACCESS`; nothing is joined or scraped. |
| X (optional, off by default) | Official API v2 recent search with a server-side `X_API_BEARER_TOKEN`. The request budget is set by `X_API_MAX_REQUESTS_PER_15MIN`, with back-off on HTTP 429 using `x-rate-limit-reset`. The query uses the mint address and the official X account / website, never a bare ticker. | `NOT_CONFIGURED`: no requests, no data. |
| Telegram bot inbox (optional) | Only groups this project's bot was **added** to. The API's bot (long polling) forwards those group messages to a short-lived Redis list (`social:telegram:inbox`, TTL 1 h). The author is stored only as a SHA-256 hash. To see all group messages, the bot's privacy mode must be disabled in BotFather. | Private groups are never read; nothing is scraped. |
| Token metadata | The pump.fun `uri` gives the official `twitter` / `telegram` / `website`. Fetches are restricted (SSRF protection), see below. | `MISSING_URI` / `REJECTED_URL` / … counted per class. |
| DEX Screener profile | Telegram links of the identity-confirmed pair (base token = mint), from the Community service's existing requests. | No link. |

Secrets stay server-side environment variables. They are never logged and never sent to the frontend.

## Token metadata resolution

Root cause of the 2026-10 coverage gap (2 of 142 tokens resolved): most pump.fun metadata URIs are
`https://ipfs.io/ipfs/<CID>`. The public path gateways ipfs.io / dweb.link (and w3s.link / nftstorage.link, which
redirect there) now answer **every** request with HTTP 429 "switching to a service worker gateway only".
cf-ipfs.com / ipfs.pump.fun / metadata.pump.fun no longer resolve. The old fetcher also refused every redirect, used a
3 s timeout (gateway.pinata.cloud needs 3–4.5 s), and rejected the launch-tool hosts that serve about a third of the URIs.

- **IPFS:** the CID is taken from any IPFS-style URL (`ipfs://`, `/ipfs/<cid>` on a known gateway, `<cid>.ipfs.<gateway>`) and fetched from `SOCIAL_IPFS_GATEWAYS` in order (default `ipfs.filebase.io`, `gateway.pinata.cloud`). Content is addressed by its CID, so the gateway cannot change it.
- **Other hosts:** allowlist `arweave.net`, `metadata.j7tracker.io`, `meta.uxento.io`, `m.rapidlaunch.io`, plus `SOCIAL_METADATA_EXTRA_HOSTS`.
- **SSRF protection:** https only, no credentials / ports / IP literals. Every resolved address must be public (private, loopback, link-local, CGNAT, ULA and mapped addresses are refused). Redirects are followed manually (max 3) and every target passes the same checks. 64 KiB cap, `SOCIAL_METADATA_TIMEOUT_MS` (6 s), JSON object only, identity fields only.
- **Failure classes:** `MISSING_URI`, `REJECTED_URL`, `DNS`, `PRIVATE_ADDRESS`, `HTTP`, `RATE_LIMITED`, `TIMEOUT`, `NETWORK`, `TOO_LARGE`, `JSON`, `REDIRECT_REJECTED`. Transient failures (timeout, network, 5xx, 429, `EAI_AGAIN`) are retried after 30 s / 2 min / 8 min, then given up. Telegram search may run meanwhile.
- **Research collection:** every evaluated launch is tracked for collection, independent of the users' social settings. A user's own social result, `socialBlocksEntry` and the ML-FEATURES-v1 inputs stay tied to that user's settings. The Community features read the research collection (`SocialService.assessAt`, side-effect free).
- Metadata is untrusted: it only feeds social identity, never a trading decision.

## Identity resolution

| Basis | Confidence |
| --- | --- |
| `MINT_ADDRESS` | 1.0 |
| `OFFICIAL_SOCIAL_LINK` (official account / group / website) | 0.85–0.9 |
| `MULTI_SIGNAL_MATCH` (ticker + exact non-generic name) | 0.55–0.7 |
| `EXACT_PROJECT_NAME` | 0.5 |
| `TICKER` | 0.1–0.25 |

Only events with confidence ≥ 0.5 count. Ticker-only matches are reported as `AMBIGUOUS_TOKEN_MATCH` and never attributed. Unrelated messages are dropped.

## Metrics

**Windows:** 30 s, 1, 2, 5, 10, 15 and 30 min.

- A window is computed only if a source covered it. Missing history is never filled with zeroes.
- Only events created *and* received by the scoring time are used, so there is no lookahead.

**Per window:**

- mentions, unique authors, mentions per minute;
- engagements and views (only when the platform exposes them);
- top and top-3 author share;
- duplicate ratio: normalised hash, plus word-3-gram Jaccard ≥ 0.8;
- repeated-URL ratio, call-to-action ratio;
- rug / scam warning keyword count, question ratio.

These are keyword counters, not sentiment.

**Trends** (`ACCELERATING`, `STABLE`, `DECELERATING`, `UNKNOWN`) compare the last minute with the minute before. Both windows must be covered.

## Scores (0–100, all documented in code)

| Score | Formula |
| --- | --- |
| Momentum | 100 × (sum of AVAILABLE components) / (their maximum): rate min(40, 20·log₂(1 + mentions/min)); acceleration 25 / 10 / 0 (if the trend is known); new authors min(20, 4·Δ) (if both minutes are covered); engagement min(15, 5·log₂(1 + eng/min)) (only if the platform exposes it); member growth min(10, Δ5m/5) (only with member samples). Unavailable components are left out, never counted as zero. |
| Quality | 30·author diversity + 25·(1 − top-3 share) + 25·(1 − duplicates) + 10·match confidence + 10·completeness |
| Spam (likelihood, **not** proof of bots) | 35·duplicates + 25·concentration + 15·repeated URLs + 15·call-to-action + 10·[> 5 messages per author] |
| Exhaustion | Normalised over known inputs: 30·[high but decelerating attention] + 15·[engagement decelerating, or unique users decelerating when engagement is not exposed] + 30·price extension (up to +200%) + 25·[on-chain buyers decelerating] |
| DataQuality | 30 (≥ 1 source) + 15 (2nd source) + 15·match confidence + 15·[5 min window covered] + 10·fresh (5 aging) + 15·observation depth (10+ messages in 5 min). Telegram-only reaches 85. |
| SocialScore | 0.35·Momentum + 0.35·Quality + 0.15·(100 − Spam) + 0.15·DataQuality − 0.2·Exhaustion |

The SocialScore uses only AVAILABLE providers: no fixed X / Telegram split and no halving when X is off; a missing provider only lowers DataQuality (confidence). Provenance is stored with every snapshot: `providersUsed`, `providersUnavailable` (with reason: `DISABLED`, `NOT_CONFIGURED`, `DISCONNECTED`, `NO_SOURCE_FOUND`, …) and `providerWeights` (share of events). Per-provider sub-scores (`perSource.TELEGRAM`: momentum, quality, spam, exhaustion, data quality, velocity, unique users per window, user growth, duplicates, top / top-3 share, forwards, freshness, confirmation) are stored too.

Every component is shown, with reasons and warnings. With no available source, every score is `null` and every state is `UNKNOWN`.

**Freshness:** FRESH ≤ 30 s, AGING ≤ 2 min, STALE above that.

## Social ↔ on-chain confirmation

On-chain strength is the existing Launch Momentum score (fallback: the buy/sell ratio). It is combined with the on-chain buyer trend (last 30 s vs the 30 s before). `STRONG_CONFIRMATION` additionally requires liquidity not draining (≥ −10%) and buy volume not decelerating (when known).

The possible states:

- `STRONG_CONFIRMATION`
- `MODERATE_CONFIRMATION`
- `SOCIAL_LEADING` (`TELEGRAM_LEADING` when Telegram is the only provider)
- `ONCHAIN_LEADING`
- `DIVERGENCE`
- `SOCIAL_ONLY_HYPE`
- `WEAK_ACTIVITY`
- `UNKNOWN`

The shadow decision (`POSITIVE_CONFIRMATION`, `NEUTRAL`, `WARNING`, `AVOID`, `UNKNOWN`) is set as follows:

- **AVOID:** spam ≥ 70, or social-only hype with exhaustion ≥ 60.
- **WARNING:** spam ≥ 50, exhaustion ≥ 60, divergence, or hype.
- **POSITIVE_CONFIRMATION:** strong or moderate confirmation with spam < 40.

## Modes and safety

| Mode | Effect |
| --- | --- |
| `MONITOR_ONLY` (default) | Nothing changes: BUY, size, SL / TP / BE / trailing, risk and Launch Score stay as they were. Shadow features are stored on every decision (`LaunchDecision.socialSummary`, rejected candidates included) and as an immutable entry snapshot (`configSnapshot.launch.social`). |
| `ENFORCE_PAPER` | Prepared, not enabled. The only effect: an `AVOID` removes a BUY (`socialBlocksEntry`). Social can never add a BUY, raise a size, or override security, risk, sellability, the sell route, liquidity safety or exit capacity. Switching to it creates a new configuration version (e.g. an NL-v3-SOCIAL experiment). |
| AI | `aiSocialAnalysisEnabled = false`. `AISocialAnalyzer` is an optional interface; a failure returns `aiSocialAvailable = false`. |

## Staged, budgeted collection

| Stage | Who | What |
| --- | --- | --- |
| 1 | Every evaluated launch | Metadata identity. |
| 2 | A deterministic ~10% sample of early-rejected launches | Basic activity every 60 s. Needed so filters can be evaluated on rejected candidates too. |
| 3 | Candidates past the basic security / liquidity / age checks | Monitoring every 15 s. |

At most 5 provider queries per tick, highest priority first.

- **Entry decisions** read the cached snapshot synchronously. Window metrics are reused for 1 s per token; nothing waits for a provider.
- **Exit path:** social code is never on it.
- **Stored snapshots:** a `SocialSnapshot` row every 30 s per stage ≥ 2 token, for analytics and lead / lag.

## Analytics

**Telegram-only view** (Elemzések → Új token → Közösségi, top): overview (enabled, state, monitored tokens, matched sources, coverage / fresh coverage, messages, unique users, average scores); Momentum and Quality buckets (0–30 / 31–50 / 51–70 / 71–85 / 86–100 with trades, wins, losses, WR, P&L, PF, expectancy, MFE, MAE); spam L / M / H; Telegram × on-chain; Launch Score (70–79 / 80–89 / 90–100) × TG L / M / H; entry age (0–10 / 11–30 / 31–60 / 61–90 s) × TG; confirmation / divergence; diagnosis comparison; hypothetical filters ranked by PF → expectancy → P&L → drawdown → winner retention (never win rate), with 70/30 chronological validation and small-N warnings. Trades from before Telegram collection are `TELEGRAM_DATA_NOT_AVAILABLE` (no backfill).

All analytics use entry-time snapshots only. Sample notes: < 50 insufficient, 50+ exploratory, 100+ more useful, 200+ stronger evidence. No threshold is recommended from small samples.

Contents:

- coverage;
- Social Score buckets;
- social × on-chain and social × exit-capacity matrices;
- momentum trend, spam, exhaustion and confirmation tables;
- diagnosis classes vs social features;
- lead / lag (about 30 s resolution, no causality claimed);
- hypothetical filters: winner retention, P&L / PF / expectancy change, 70/30 chronological validation from 50 trades.

Unknown social data always passes the hypothetical filters.
