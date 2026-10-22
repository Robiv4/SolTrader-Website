import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config({ path: ['.env.local', '.env', '../../.env.local', '../../.env'] });

const booleanFromEnv = z.preprocess((value) => {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
}, z.boolean());

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.string().default('info'),
  REDIS_URL: z.string().url(),
  REDIS_PASSWORD: z.string().optional(),
  DATABASE_URL: z.string().url(),
  BOT_LOOP_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
  TRADING_MODE: z.enum(['PAPER', 'SEMI_AUTO', 'LIVE']).default('PAPER'),
  LIVE_TRADING_ENABLED: booleanFromEnv.default(false),
  MARKET_DATA_PROVIDER: z.string().default('dexscreener'),
  MARKET_DATA_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(30),
  MARKET_DATA_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  MARKET_DATA_DISCOVERY_LIMIT: z.coerce.number().int().positive().default(30),
  MARKET_DATA_STALE_AFTER_MS: z.coerce.number().int().positive().default(120_000),
  /** Exit evaluations on quotes older than this are flagged EXIT_DATA_STALE (never silently treated as fresh). */
  EXIT_MARKET_DATA_MAX_AGE_MS: z.coerce.number().int().positive().default(15_000),
  /**
   * NewLaunch exit monitor watchdog interval (stream health, fallback polling, time-based exits). Exits themselves are
   * evaluated on every market event (event-driven). 0 disables the hot monitor (NewLaunch positions then use the
   * main position loop only).
   */
  NEW_LAUNCH_EXIT_LOOP_MS: z.coerce.number().int().min(0).default(1_000),
  /** Market stream without events for this long is STALE and fallback polling starts. */
  NEW_LAUNCH_EXIT_STREAM_STALE_MS: z.coerce.number().int().positive().default(5_000),
  /** Fallback polling interval per token while the stream is unhealthy (respects provider limits). */
  NEW_LAUNCH_EXIT_FALLBACK_POLL_MS: z.coerce.number().int().positive().default(2_000),
  /** Non-critical hot state (marks, highest price, MFE) is persisted at most this often per position. */
  NEW_LAUNCH_EXIT_PERSIST_THROTTLE_MS: z.coerce.number().int().positive().default(1_000),
  /** Simulated PAPER execution latency between exit trigger and fill: NONE (default, unchanged behaviour) | FIXED | RANGE | EMPIRICAL. */
  PAPER_EXIT_LATENCY_MODE: z.enum(['NONE', 'FIXED', 'RANGE', 'EMPIRICAL']).default('NONE'),
  PAPER_EXIT_LATENCY_FIXED_MS: z.coerce.number().min(0).optional(),
  PAPER_EXIT_LATENCY_MIN_MS: z.coerce.number().min(0).optional(),
  PAPER_EXIT_LATENCY_MAX_MS: z.coerce.number().min(0).optional(),
  PAPER_EXIT_LATENCY_P50_MS: z.coerce.number().min(0).optional(),
  PAPER_EXIT_LATENCY_P75_MS: z.coerce.number().min(0).optional(),
  PAPER_EXIT_LATENCY_P95_MS: z.coerce.number().min(0).optional(),
  /** Social Intelligence collection (deterministic, no AI). Off = no provider requests at all. */
  /**
   * SolTrader 3.0 ML-only architecture (default OFF = legacy behaviour unchanged). ON: the rule-based DEFAULT strategy
   * never opens entries; only the user's selected, PAPER-approved model may; no model = data collection only.
   */
  ML_ONLY_ARCHITECTURE_ENABLED: z.string().optional().transform((value) => value === 'true'),
  SOCIAL_COLLECTION_ENABLED: z.string().optional().transform((value) => value !== 'false'),
  /** X is OPTIONAL (default off): with X_SOCIAL_ENABLED=false the X provider is DISABLED and makes zero requests. */
  X_SOCIAL_ENABLED: z.string().optional().transform((value) => value === 'true'),
  /** Telegram (primary social source, MTProto). Credentials are validated only when enabled. */
  TELEGRAM_SOCIAL_ENABLED: z.string().optional().transform((value) => value === 'true'),
  TELEGRAM_API_ID: z.string().optional(),
  /** Secrets: never logged, never returned by the API, never shown in Settings. */
  TELEGRAM_API_HASH: z.string().optional(),
  TELEGRAM_SESSION: z.string().optional(),
  /** Max distinct Telegram chats polled at once (subscription cap). */
  TELEGRAM_MAX_MONITORED_SOURCES: z.coerce.number().int().min(1).max(500).default(50),
  /** Mint-address searches per minute to find community chats (0 = only official links from token metadata). */
  TELEGRAM_GLOBAL_SEARCH_PER_MIN: z.coerce.number().int().min(0).max(20).default(2),
  /** Optional AI social analysis: default off (zero LLM calls). */
  AI_SOCIAL_ANALYSIS_ENABLED: z.string().optional().transform((value) => value === 'true'),
  /** Token metadata (social links): IPFS gateways tried in order by CID (comma separated https URLs ending in /ipfs/). */
  SOCIAL_IPFS_GATEWAYS: z.string().optional().transform((value) => (value ?? '').split(',').map((item) => item.trim()).filter((item) => /^https:\/\/[a-z0-9.-]+\/ipfs\/?$/i.test(item))),
  /** Extra non-IPFS metadata hosts (exact or *.suffix), in addition to the built-in allowlist. */
  SOCIAL_METADATA_EXTRA_HOSTS: z.string().optional().transform((value) => (value ?? '').split(',').map((item) => item.trim().toLowerCase()).filter((item) => /^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(item))),
  SOCIAL_METADATA_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(20_000).default(6_000),
  /** Official X API v2 bearer token (server-side secret; never logged or sent to the frontend). Unset = X not configured. */
  X_API_BEARER_TOKEN: z.string().optional(),
  /** Request budget per 15 minutes for X recent search (set to your API tier's limit). */
  X_API_MAX_REQUESTS_PER_15MIN: z.coerce.number().int().min(1).default(50),
  // ---- Community Intelligence (MONITOR_ONLY: collects and scores, never makes / blocks / sizes a trade) ----
  /** Master switch (default on). Off = no community provider requests at all; trading is unaffected either way. */
  COMMUNITY_INTELLIGENCE_ENABLED: z.string().optional().transform((value) => value !== 'false'),
  /** The only supported mode; any other value is refused at startup. */
  COMMUNITY_INTELLIGENCE_MODE: z.enum(['MONITOR_ONLY']).default('MONITOR_ONLY'),
  /** DEX Screener official public API (no key). */
  DEXSCREENER_ENABLED: z.string().optional().transform((value) => value !== 'false'),
  DEXSCREENER_REQUESTS_PER_MINUTE: z.coerce.number().int().min(1).max(300).default(40),
  DEXSCREENER_CACHE_TTL_MS: z.coerce.number().int().min(10_000).default(60_000),
  /** On-chain community statistics from the EXISTING launch trade stream (no extra Helius / RPC request). */
  HELIUS_COMMUNITY_ENABLED: z.string().optional().transform((value) => value !== 'false'),
  /** LunarCrush (optional, paid): off by default; without LUNARCRUSH_API_KEY it is NOT_CONFIGURED and makes no request. */
  LUNARCRUSH_ENABLED: z.string().optional().transform((value) => value === 'true'),
  /** Server-side secret: never logged, never returned by the API. */
  LUNARCRUSH_API_KEY: z.string().optional(),
  LUNARCRUSH_REQUESTS_PER_MINUTE: z.coerce.number().int().min(1).max(100).default(5),
  LUNARCRUSH_CACHE_TTL_MS: z.coerce.number().int().min(60_000).default(1_800_000),
  COMMUNITY_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(30_000).default(6_000),
  COMMUNITY_BACKOFF_BASE_MS: z.coerce.number().int().min(500).default(2_000),
  COMMUNITY_BACKOFF_MAX_MS: z.coerce.number().int().min(1_000).default(300_000),
  STRATEGY_LOOKBACK_MS: z.coerce.number().int().positive().default(600_000),
  STRATEGY_HISTORY_WINDOW: z.coerce.number().int().positive().default(20),
  PAPER_EXECUTION_CONCURRENCY: z.coerce.number().int().positive().default(4),
  PAPER_SIGNAL_LOOKBACK_MS: z.coerce.number().int().positive().default(120_000),
  PAPER_MAX_ENTRIES_PER_CYCLE: z.coerce.number().int().positive().default(10),
  SEMI_AUTO_APPROVAL_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  // AI Token Analyzer (infrastructure only; the API key itself is read from process.env by the provider factory
  // and never copied into this object, so it cannot end up in logs).
  AI_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  AI_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  /** Server-level hard ceiling of AI provider calls per minute (users can only be stricter). */
  AI_MAX_ANALYSES_PER_MINUTE: z.coerce.number().int().positive().default(30),
  AI_CONCURRENCY: z.coerce.number().int().positive().max(10).default(2),
  // New Launch / Sniper discovery (event-driven Solana program logs).
  SOLANA_WS_URL: z.string().optional(),
  SOLANA_RPC_URL: z.string().optional(),
  NEW_LAUNCH_DISCOVERY_ENABLED: booleanFromEnv.default(true),
});

export const env = envSchema.parse(process.env);
