import dotenv from 'dotenv';
import { z } from 'zod';

const booleanFromEnv = z.preprocess((value) => {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
}, z.boolean());

dotenv.config({ path: ['.env.local', '.env'] });

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.string().default('info'),
  TRADING_MODE: z.enum(['PAPER', 'SEMI_AUTO', 'LIVE']).default('PAPER'),
  LIVE_TRADING_ENABLED: booleanFromEnv.default(false),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
});

export const env = envSchema.parse(process.env);

export const appConfig = {
  nodeEnv: env.NODE_ENV,
  logLevel: env.LOG_LEVEL,
  tradingMode: env.TRADING_MODE,
  serverLiveTradingConfigured: env.LIVE_TRADING_ENABLED,
  databaseUrl: env.DATABASE_URL,
  redisUrl: env.REDIS_URL,
};
