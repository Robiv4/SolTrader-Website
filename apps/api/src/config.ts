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
  /** Public GeckoTerminal OHLCV for pool tokens (charts only; cached, max 20 requests / minute). 'false' disables it. */
  CHART_OHLCV_GECKOTERMINAL: z.string().optional().transform((value) => value !== 'false'),
  PORT: z.coerce.number().default(3001),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.string().default('info'),
  TRADING_MODE: z.enum(['PAPER', 'SEMI_AUTO', 'LIVE']).default('PAPER'),
  /** SolTrader 3.0 ML-only architecture (default OFF = legacy DEFAULT / ML selector unchanged). */
  ML_ONLY_ARCHITECTURE_ENABLED: z.string().optional().transform((value) => value === 'true'),
  LIVE_TRADING_ENABLED: booleanFromEnv.default(false),
  SESSION_SECRET: z.string().min(32),
  SESSION_TTL_SECONDS: z.coerce.number().int().min(30).max(86400).default(1800),
  SEMI_AUTO_APPROVAL_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  ADMIN_EMAIL: z.string().email().default('admin@soltrader.local'),
  ADMIN_PASSWORD: z.string().min(12),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  REDIS_PASSWORD: z.string().optional(),
  TELEGRAM_NOTIFICATIONS_ENABLED: booleanFromEnv.default(false),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),
  TELEGRAM_ALERT_THROTTLE_MS: z.coerce.number().int().positive().default(60000),
  CORS_ORIGINS: z.string().default('http://localhost:3000'),
  MARKET_DATA_PROVIDER: z.string().default('dexscreener'),
  MARKET_DATA_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  MARKET_DATA_STALE_AFTER_MS: z.coerce.number().int().positive().default(120000),
  SOLANA_RPC_URL: z.string().url().optional().or(z.literal('')),
  SOLANA_PRIMARY_RPC_URL: z.string().url().optional().or(z.literal('')),
  SOLANA_RPC_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
});

export const env = envSchema.parse(process.env);
