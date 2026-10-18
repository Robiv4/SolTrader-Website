import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Prisma, PrismaClient } from '@prisma/client';
import { createRpcManagerFromEnv, RPC_PRIORITY } from '@soltrader/blockchain';
import { createMarketDataProvider, PrismaMarketDataRepository } from '@soltrader/market-data';
import { BotCommandSubscriber } from '@soltrader/shared';
import { createClient } from 'redis';

import { CommunityService } from './community/community-service.js';
import { DexScreenerClient } from './community/dexscreener.js';
import { HttpBudget } from './community/http-budget.js';
import { LunarCrushClient } from './community/lunarcrush.js';
import { env } from './config.js';
import { capacityMetrics } from './exit/entry-capacity.js';
import { HotPositionMonitor, type MarketEvent } from './exit/hot-position-monitor.js';
import { cycleMonitoredPositionsWhere, ThrottledWarning } from './exit/position-scope.js';
import { NewLaunchService } from './launch/new-launch-service.js';
import { MeteoraLaunchProvider, PumpFunLaunchProvider, RaydiumLaunchProvider } from './launch/providers.js';
import { TradeCandleAggregator } from './launch/trade-candles.js';
import { logger } from './logger.js';
import { MlPaperEntryEngine, MlPaperModelRegistry } from './ml/ml-paper-engine.js';
import { MlShadowService, startMlHealthPublisher, type MlMode } from './ml/ml-shadow-service.js';
import { PaperExecutionCoordinator } from './paper-execution.js';
import { type MarketQuote, PositionManager } from './position-manager.js';
import { createPrismaPositionStore } from './position-store.js';
import { XSocialProvider } from './social/providers.js';
import { SocialService } from './social/social-service.js';
import { createGramJsGateway, TelegramSocialProvider, type TelegramGateway } from './social/telegram.js';
import { ThrottledTokenDataProvider } from './throttled-provider.js';
import { BotTradingLoop, type TradingLoopStore } from './trading-loop.js';
import { type SkipRecord, type TrackerRedis, UnbuyableTokenTracker } from './unbuyable-tracker.js';

const prisma = new PrismaClient();
/** Maximum age of the quote used to evaluate SL/TP/trailing of an open position. */
const POSITION_QUOTE_MAX_AGE_MS = 5_000;
const noFreshPriceWarning = new ThrottledWarning(5 * 60_000);
const redisClient = createClient({ url: env.REDIS_URL, ...(env.REDIS_PASSWORD ? { password: env.REDIS_PASSWORD } : {}) });
const redisSubscriber = redisClient.duplicate();
const commandSubscriber = new BotCommandSubscriber(redisSubscriber);

// One cached, rate-limited provider shared by paper execution and position protection.
const marketDataProvider = new ThrottledTokenDataProvider(createMarketDataProvider({
  MARKET_DATA_PROVIDER: env.MARKET_DATA_PROVIDER,
  MARKET_DATA_REQUEST_TIMEOUT_MS: String(env.MARKET_DATA_REQUEST_TIMEOUT_MS),
}));

// One shared RPC manager for every on-chain read in the worker (NewLaunch security, Raydium discovery):
// dedup, method-aware cache, batching, priority queue, circuit breakers, failover. Provider URLs are never logged.
const rpcManager = createRpcManagerFromEnv(process.env, { logger });
if (!rpcManager) logger.warn('Solana RPC not configured: on-chain security data stays UNKNOWN (New Launch candidates stay WATCH)');

const eventPublisher = createClient({ url: env.REDIS_URL, ...(env.REDIS_PASSWORD ? { password: env.REDIS_PASSWORD } : {}) });
const trackerRedis: TrackerRedis = {
  get: (key) => redisClient.get(key),
  set: (key, value, options) => redisClient.set(key, value, options),
  del: (key) => redisClient.del(key),
  mGet: (keys) => redisClient.mGet(keys),
};
const unbuyableTracker = new UnbuyableTokenTracker(trackerRedis, prisma);

/** Audits and streams that a token is now skipped for a user, so the dashboard log explains the gap. */
async function onTokenSkipped(userId: string, tokenAddress: string, record: SkipRecord) {
  const details = { tokenAddress, reason: record.reason, skippedUntil: record.until };
  logger.info({ userId, ...details }, 'TOKEN_SKIPPED');
  await prisma.auditLog.create({ data: { userId, action: 'TOKEN_SKIPPED', details } });
  await publishLog({ userId, action: 'TOKEN_SKIPPED', details }).catch(() => undefined);
}

async function publishLog(entry: { userId: string | null; action: string; details: Record<string, unknown> }) {
  await eventPublisher.publish('bot:logs', JSON.stringify({ ...entry, source: 'worker', createdAt: new Date().toISOString() }));
}

// New Launch / Sniper (PAPER only): event-driven discovery from Solana program logs.
const solanaWsUrl = env.NEW_LAUNCH_DISCOVERY_ENABLED ? env.SOLANA_WS_URL?.trim() || null : null;
// Raydium pool discovery (getTransaction per initialize2 log): enrichment priority, immutable result cached.
const launchRpc = rpcManager ? rpcManager.rpcCall({ caller: 'NewLaunchDiscovery', priority: RPC_PRIORITY.ENRICHMENT }) : null;
// Social Intelligence (deterministic; MONITOR_ONLY; AI off by default). Telegram-first: MTProto user session for public /
// legitimately accessible chats (+ optional bot inbox). X is optional and disabled by default (zero requests).
// Credentials are validated only when the provider is enabled; missing ones -> NOT_CONFIGURED + one error log, no crash.
const telegramGateway: TelegramGateway | null = await (async () => {
  if (!env.SOCIAL_COLLECTION_ENABLED || !env.TELEGRAM_SOCIAL_ENABLED) return null;
  const apiId = Number(env.TELEGRAM_API_ID?.trim());
  const apiHash = env.TELEGRAM_API_HASH?.trim();
  const session = env.TELEGRAM_SESSION?.trim();
  const missing = [!Number.isInteger(apiId) || apiId <= 0 ? 'TELEGRAM_API_ID' : null, !apiHash ? 'TELEGRAM_API_HASH' : null, !session ? 'TELEGRAM_SESSION' : null].filter(Boolean);
  if (missing.length) {
    logger.error({ missing }, 'Telegram social provider enabled but not configured (values are never logged)');
    return null;
  }
  try {
    return await createGramJsGateway({ apiId, apiHash: apiHash!, session: session! });
  } catch (error) {
    logger.error({ err: error instanceof Error ? error.message.slice(0, 200) : 'unknown' }, 'Telegram MTProto client could not be created');
    return null;
  }
})();
let socialServiceRef: SocialService | null = null;
const telegramProvider = new TelegramSocialProvider({
  enabled: env.TELEGRAM_SOCIAL_ENABLED,
  gateway: telegramGateway,
  // Optional: groups the project's bot was added to (the API's bot forwards them through Redis).
  inbox: process.env.TELEGRAM_BOT_TOKEN?.trim() ? { popMany: async (count) => (await redisClient.rPopCount('social:telegram:inbox', count).catch(() => null)) ?? [] } : null,
  maxMonitoredSources: env.TELEGRAM_MAX_MONITORED_SOURCES,
  globalSearchPerMinute: env.TELEGRAM_GLOBAL_SEARCH_PER_MIN,
  onSource: (record) => socialServiceRef?.recordTelegramSource(record),
  logger,
});
const socialService = env.SOCIAL_COLLECTION_ENABLED ? new SocialService({
  prisma,
  logger,
  aiEnabled: env.AI_SOCIAL_ANALYSIS_ENABLED,
  providers: [
    telegramProvider,
    new XSocialProvider({ enabled: env.X_SOCIAL_ENABLED, bearerToken: env.X_SOCIAL_ENABLED ? env.X_API_BEARER_TOKEN?.trim() || null : null, maxRequestsPer15Min: env.X_API_MAX_REQUESTS_PER_15MIN }),
  ],
}) : null;
socialServiceRef = socialService;

// Community Intelligence (MONITOR_ONLY): DEX Screener (public API), on-chain stream statistics, optional LunarCrush.
// Background collection only; entries / exits never wait for it and an outage only removes community data.
const communityBudget = (source: string, enabled: boolean, configured: boolean, perMinute: number) => new HttpBudget({
  source, enabled, configured, perMinute, timeoutMs: env.COMMUNITY_REQUEST_TIMEOUT_MS, backoffBaseMs: env.COMMUNITY_BACKOFF_BASE_MS, backoffMaxMs: env.COMMUNITY_BACKOFF_MAX_MS,
});
const lunarKey = env.LUNARCRUSH_ENABLED ? env.LUNARCRUSH_API_KEY?.trim() || null : null;
const communityService = env.COMMUNITY_INTELLIGENCE_ENABLED ? (() => {
  const dexHttp = communityBudget('DEXSCREENER', env.DEXSCREENER_ENABLED, true, env.DEXSCREENER_REQUESTS_PER_MINUTE);
  const lunarHttp = communityBudget('LUNARCRUSH', env.LUNARCRUSH_ENABLED, Boolean(lunarKey), env.LUNARCRUSH_REQUESTS_PER_MINUTE);
  return new CommunityService({
    prisma,
    logger,
    onchainEnabled: env.HELIUS_COMMUNITY_ENABLED,
    dex: { http: dexHttp, client: new DexScreenerClient(dexHttp), cacheTtlMs: env.DEXSCREENER_CACHE_TTL_MS },
    lunar: { http: lunarHttp, client: new LunarCrushClient(lunarHttp, lunarKey), cacheTtlMs: env.LUNARCRUSH_CACHE_TTL_MS },
  });
})() : null;

// Machine Learning (learning pipeline, SHADOW only): snapshots + outcomes from data the NewLaunch pipeline already has.
// ENFORCE_PAPER is prepared but not available in this release; LIVE is never an ML mode.
const mlModeRequested = (process.env.ML_MODE?.trim().toUpperCase() || 'SHADOW') as MlMode;
const mlMode: MlMode = mlModeRequested === 'OFF' ? 'OFF' : 'SHADOW';
if (mlModeRequested === 'ENFORCE_PAPER') logger.warn('ML_MODE=ENFORCE_PAPER is not available yet; running in SHADOW mode (no trading influence)');
const mlRepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const mlService = new MlShadowService({
  prisma,
  logger,
  mode: mlMode,
  repoRoot: mlRepoRoot,
  maxTrackedPaths: Number(process.env.ML_MAX_TRACKED_CANDIDATES ?? 3_000),
  marketDataPerMinute: Number(process.env.ML_MAX_MARKET_DATA_PER_MIN ?? 20),
  outcomeKinds: (process.env.ML_OUTCOME_KINDS ?? 'AGE_30S,BUY_DECISION').split(',').map((kind) => kind.trim()).filter(Boolean),
  getMarketPrice: async (mint) => {
    const snapshot = await marketDataProvider.getTokenMetrics(mint).catch(() => null);
    return snapshot?.priceUsd ? { priceUsd: snapshot.priceUsd, liquidityUsd: snapshot.liquidityUsd ?? null } : null;
  },
  community: communityService ?? undefined,
  incrementDaily: (metric, amount = 1) => {
    const key = `ml:stats:${new Date().toISOString().slice(0, 10)}:${metric}`;
    void redisClient.incrBy(key, amount).then(() => redisClient.expire(key, 30 * 86_400)).catch(() => undefined);
  },
});

// ML PAPER entries (users who explicitly selected an admin-approved model; DEFAULT strategy otherwise). Independent of
// ML_MODE: SHADOW collection and PAPER decisions are separate. PAPER only - this engine never reaches LIVE execution.
const mlPaperRegistry = new MlPaperModelRegistry({ prisma, repoRoot: mlRepoRoot, logger });
const mlPaperEngine = new MlPaperEntryEngine({ prisma, registry: mlPaperRegistry, logger });

// Real-trade OHLCV (5 s) for the charts: Redis only, short TTL; no DB writes, no extra requests.
const tradeCandles = new TradeCandleAggregator({ store: { hSet: (key, values) => redisClient.hSet(key, values), expire: (key, seconds) => redisClient.expire(key, seconds) } });

const newLaunch = new NewLaunchService({
  mlPaper: mlPaperEngine,
  candles: tradeCandles,
  social: socialService ?? undefined,
  community: communityService ?? undefined,
  ml: mlService.enabled ? mlService : undefined,
  prisma,
  providers: [
    new PumpFunLaunchProvider(solanaWsUrl, logger),
    new RaydiumLaunchProvider(solanaWsUrl, launchRpc, logger),
    new MeteoraLaunchProvider(),
  ],
  marketData: marketDataProvider,
  // NewLaunch security (mint / freeze authority, token program, extensions): P2 through the shared manager (cached
  // 30 s, deduplicated, batched). RPC failure -> UNKNOWN -> WATCH (RPC_SECURITY_DATA_UNAVAILABLE), never "revoked".
  getMintInfo: rpcManager ? (mint: string) => rpcManager.getMintAccount(mint, { caller: 'NewLaunchSecurity', priority: RPC_PRIORITY.SECURITY, subject: mint }) : undefined,
  onSecurityDataUnavailable: () => rpcManager?.reportSecurityDataUnavailable('NewLaunchSecurity'),
  store: {
    set: (key, value, options) => redisClient.set(key, value, options),
    incrBy: (key, amount) => redisClient.incrBy(key, amount),
    expire: (key, seconds) => redisClient.expire(key, seconds),
  },
  logger,
  publish: async (payload) => {
    await eventPublisher.publish('bot:launches', JSON.stringify({ type: 'launch_update', payload, timestamp: new Date().toISOString() }));
  },
});

const paperExecution = new PaperExecutionCoordinator({
  getLaunchQuote: (mint) => newLaunch.quote(mint, 15_000),
  publishLaunchEvent: async (payload) => {
    await eventPublisher.publish('bot:launches', JSON.stringify({ type: 'launch_update', payload, timestamp: new Date().toISOString() }));
  },
  prisma,
  tracker: unbuyableTracker,
  onTokenSkipped,
  publishLog,
  provider: marketDataProvider,
  logger,
  concurrency: env.PAPER_EXECUTION_CONCURRENCY,
  lookbackMs: env.PAPER_SIGNAL_LOOKBACK_MS,
  maxEntriesPerCycle: env.PAPER_MAX_ENTRIES_PER_CYCLE,
  publishEvent: async (type, payload) => {
    const channels = { position_update: 'bot:positions', trade_update: 'bot:trades', pnl_update: 'bot:pnl', risk_update: 'bot:risk' } as const;
    await eventPublisher.publish(channels[type as keyof typeof channels], JSON.stringify({ type, payload, timestamp: new Date().toISOString() }));
  },
});

const positionStore = createPrismaPositionStore(prisma, {
  publishLog,
  async publishEvent(type, payload) {
    const channelMap: Record<'position_update' | 'trade_update' | 'pnl_update' | 'risk_update', string> = {
      position_update: 'bot:positions',
      trade_update: 'bot:trades',
      pnl_update: 'bot:pnl',
      risk_update: 'bot:risk',
    };
    const event = { type, payload, timestamp: new Date().toISOString() };
    await eventPublisher.publish(channelMap[type as keyof typeof channelMap], JSON.stringify(event));
  },
});
const positionManager = new PositionManager(positionStore, { exitMarketDataMaxAgeMs: env.EXIT_MARKET_DATA_MAX_AGE_MS });

const marketRepository = new PrismaMarketDataRepository(prisma);
const chartPointAt = new Map<string, number>();
/** Launch-token price points for the position chart (from the live trade stream). */
async function recordLaunchChartPoint(mint: string, quote: { priceUsd: number; liquidityUsd: number | null; timestamp: Date }, now: number, minIntervalMs = 15_000) {
  if (now - (chartPointAt.get(mint) ?? 0) < minIntervalMs) return;
  chartPointAt.set(mint, now);
  const candidate = await prisma.launchCandidate.findUnique({ where: { mint }, select: { id: true } }).catch(() => null);
  if (!candidate) return;
  await prisma.launchSnapshot.create({ data: { candidateId: candidate.id, takenAt: quote.timestamp, priceUsd: new Prisma.Decimal(quote.priceUsd), liquidityUsd: quote.liquidityUsd !== null ? new Prisma.Decimal(quote.liquidityUsd) : null } }).catch(() => undefined);
}

const store: TradingLoopStore = {
  async readState() {
    const state = await prisma.botState.findUnique({ where: { id: 'default-bot' } });
    return state ? { status: state.status } : null;
  },
  async writeState(status, updatedBy) {
    await prisma.botState.upsert({
      where: { id: 'default-bot' },
      update: { status, updatedBy },
      create: { id: 'default-bot', status, updatedBy },
    });
    await eventPublisher.publish('bot:events', JSON.stringify({ status, updatedBy, at: new Date().toISOString() })).catch(() => undefined);
  },
  async recordEvent(action, details) {
    await prisma.systemEvent.create({
      data: {
        eventType: action,
        severity: action === 'EMERGENCY_STOP' ? 'critical' : 'info',
        message: `Worker bot event: ${action}`,
        metadata: details as Prisma.InputJsonValue,
      },
    });
    await publishLog({ userId: null, action, details }).catch(() => undefined);
  },
};

const loop = new BotTradingLoop(store, commandSubscriber, {
  async runPaperExecution(signal) {
    if (signal.aborted) return;
    await paperExecution.runCycle(signal);
  },
  async monitorOpenPositions(signal) {
    if (signal.aborted) return;

    // NewLaunch positions are owned by the event-driven hot monitor (one evaluator per position, no stale overwrites).
    const openPositions = await prisma.position.findMany({ where: cycleMonitoredPositionsWhere(Boolean(hotMonitor)), select: { tokenId: true, token: { select: { address: true } } } });
    if (openPositions.length === 0) return;
    const now = Date.now();

    // Positions are marked with a fresh quote from the market-data provider. The latest stored metric
    // is only used when it is itself fresh; otherwise the token is left out and no exit is evaluated.
    const snapshot: Record<string, MarketQuote> = {};
    const tokens = new Map(openPositions.map((position) => [position.token.address, position.tokenId]));
    for (const [address, tokenId] of tokens) {
      if (signal.aborted) return;
      // Launch tokens: the live trade-stream quote (fresher than market data, which may not index them yet).
      const launchQuote = newLaunch.quote(address, POSITION_QUOTE_MAX_AGE_MS * 6);
      if (launchQuote) {
        snapshot[address] = { price: launchQuote.priceUsd, liquidityUsd: launchQuote.liquidityUsd, timestamp: launchQuote.timestamp };
        await recordLaunchChartPoint(address, launchQuote, now);
        continue;
      }
      // Exits use a quote at most POSITION_QUOTE_MAX_AGE_MS old (not the scanner's longer-lived cache).
      const live = await marketDataProvider.getFreshTokenMetrics(address, POSITION_QUOTE_MAX_AGE_MS).catch(() => null);
      const livePrice = Number(live?.priceUsd);
      if (live?.timestamp && Date.now() - live.timestamp.getTime() <= env.MARKET_DATA_STALE_AFTER_MS && livePrice > 0) {
        snapshot[address] = { price: livePrice, liquidityUsd: Number(live.liquidityUsd) || null, timestamp: live.timestamp };
        // Real price history for the position chart (at most every 15 s per token).
        if (now - (chartPointAt.get(address) ?? 0) >= 15_000) {
          chartPointAt.set(address, now);
          await marketRepository.save(live).catch((error: unknown) => logger.warn({ err: error instanceof Error ? error.message : String(error), token: address }, 'Chart price point failed'));
        }
        continue;
      }
      const stored = await prisma.tokenMetric.findFirst({ where: { tokenId }, orderBy: { timestamp: 'desc' } });
      const storedPrice = Number(stored?.priceUsd);
      if (stored && Date.now() - stored.timestamp.getTime() <= env.MARKET_DATA_STALE_AFTER_MS && storedPrice > 0) {
        snapshot[address] = { price: storedPrice, liquidityUsd: Number(stored.liquidityUsd) || null, timestamp: stored.timestamp };
      } else if (noFreshPriceWarning.shouldLog(address, now)) {
        logger.warn({ token: address }, 'No fresh price for open position; exit evaluation skipped (repeats at most every 5 min)');
      }
    }

    const closed = await positionManager.reconcileMarket(snapshot, new Date(), hotMonitor ? { positionFilter: (position) => position.exitPolicy !== 'NEW_LAUNCH' } : {});
    logger.info({ count: closed.length, status: loop.currentStatus }, 'Open-position protection cycle');
  },
  async cancelPendingOffers(reason) {
    logger.warn({ reason }, 'Pending paper offers cancelled');
    if (reason === 'EMERGENCY_STOP') {
      const closed = await positionManager.closeAll('EMERGENCY_STOP');
      logger.warn({ count: closed.length }, 'Open paper positions closed by emergency stop');
    }
  },
}, env.BOT_LOOP_INTERVAL_MS, logger);

redisClient.on('error', (error: Error) => logger.error({ err: error }, 'Redis client error'));
redisSubscriber.on('error', (error: Error) => logger.error({ err: error }, 'Redis subscriber error'));
redisSubscriber.on('ready', () => {
  void loop.resyncFromStore().catch((error) => logger.error({ err: error }, 'Failed to resync bot state after Redis reconnect'));
});

let heartbeatTimer: ReturnType<typeof globalThis.setInterval> | undefined;
let exitMonitorTimer: ReturnType<typeof globalThis.setInterval> | undefined;

/**
 * Event-driven NewLaunch exit monitor: every trade-stream price event is evaluated immediately against the in-memory
 * protective state (no database round trip before the decision). The main trading loop evaluates positions only
 * after the scanner / strategies / paper execution stages (~20-26 s apart) and the previous 1 s polling loop read
 * all open positions from PostgreSQL on every tick; both are replaced for NewLaunch positions by this monitor.
 * Fallback polling (market-data provider) protects positions when the stream is stale or a token has no stream.
 */
const hotMonitor = env.NEW_LAUNCH_EXIT_LOOP_MS > 0 ? new HotPositionMonitor({
  manager: positionManager,
  loadOpenPositions: () => positionStore.getOpenPositions({ exitPolicy: 'NEW_LAUNCH' }),
  persist: (id, updates) => positionStore.updatePosition(id, updates),
  publishEvent: (type, payload) => positionStore.publishEvent(type as never, payload),
  afterClose: async (userId) => {
    await positionStore.refreshAccount?.(userId);
  },
  refreshAccount: async (userId) => {
    await positionStore.refreshAccount?.(userId);
  },
  streamStatus: () => {
    const pump = newLaunch.providerStatuses().find((provider) => provider.source === 'PUMP_FUN');
    return { state: pump?.status ?? 'NOT_CONFIGURED', lastEventAt: pump?.lastEventAt ? new Date(pump.lastEventAt).getTime() : null };
  },
  latestStreamEvent: (mint) => newLaunch.latestEvent(mint),
  pollQuote: async (mint): Promise<MarketEvent | null> => {
    const receivedAt = Date.now();
    const live = await marketDataProvider.getFreshTokenMetrics(mint, POSITION_QUOTE_MAX_AGE_MS).catch(() => null);
    const price = Number(live?.priceUsd);
    if (live?.timestamp && price > 0) return { mint, price, liquidityUsd: Number(live.liquidityUsd) || null, marketTimestamp: live.timestamp.getTime(), sourceTimestamp: live.timestamp.getTime(), receivedAt, slot: null, eventId: null, source: 'POLL' };
    return null;
  },
  isActive: () => loop.currentStatus === 'RUNNING' || loop.currentStatus === 'PAUSED',
  // Chart points are written off the decision path (fire-and-forget, throttled).
  onObserved: (mint, event) => {
    void recordLaunchChartPoint(mint, { priceUsd: event.price, liquidityUsd: event.liquidityUsd, timestamp: new Date(event.marketTimestamp) }, Date.now(), 3_000);
  },
  logger,
}, {
  watchdogMs: env.NEW_LAUNCH_EXIT_LOOP_MS,
  streamStaleMs: env.NEW_LAUNCH_EXIT_STREAM_STALE_MS,
  fallbackPollMs: env.NEW_LAUNCH_EXIT_FALLBACK_POLL_MS,
  persistThrottleMs: env.NEW_LAUNCH_EXIT_PERSIST_THROTTLE_MS,
  paperLatency: {
    mode: env.PAPER_EXIT_LATENCY_MODE,
    fixedMs: env.PAPER_EXIT_LATENCY_FIXED_MS ?? null,
    minMs: env.PAPER_EXIT_LATENCY_MIN_MS ?? null,
    maxMs: env.PAPER_EXIT_LATENCY_MAX_MS ?? null,
    p50Ms: env.PAPER_EXIT_LATENCY_P50_MS ?? null,
    p75Ms: env.PAPER_EXIT_LATENCY_P75_MS ?? null,
    p95Ms: env.PAPER_EXIT_LATENCY_P95_MS ?? null,
  },
}) : null;
if (hotMonitor) newLaunch.onPriceEvent((event) => hotMonitor.onMarketEvent(event));

async function main() {
  await redisClient.connect();
  await redisSubscriber.connect();
  await eventPublisher.connect();
  await loop.start();
  newLaunch.start();
  globalThis.setInterval(() => void tradeCandles.flush().catch(() => undefined), 5_000);
  // ML PAPER health (model load / approval / last prediction; no secrets) + bookkeeping of finished candidates.
  globalThis.setInterval(() => {
    void eventPublisher.set('ml:paper:health', JSON.stringify({ at: new Date().toISOString(), models: mlPaperRegistry.snapshot(), engine: mlPaperEngine.snapshot() }), { EX: 60 }).catch(() => undefined);
    mlPaperEngine.prune((mint) => newLaunch.tracker.launches.has(mint));
  }, 10_000);
  if (mlService.enabled) {
    // ML observability first (counts / latencies only): health is published even while the resume below runs.
    startMlHealthPublisher(mlService, (key, value, options) => eventPublisher.set(key, value, options), 10_000, (error) => logger.warn({ err: error instanceof Error ? error.message : String(error) }, 'ml:health publish failed'));
    await mlService.resume().catch((error: unknown) => logger.warn({ err: error instanceof Error ? error.message : String(error) }, 'ML outcome resume failed (trading unaffected)'));
    void mlService.refreshModel(Date.now(), true);
  }
  if (communityService) {
    communityService.start();
    globalThis.setInterval(() => void eventPublisher.set('community:health', JSON.stringify(communityService.health()), { EX: 60 }).catch(() => undefined), 5_000);
  }
  if (socialService) {
    socialService.start();
    globalThis.setInterval(() => void eventPublisher.set('social:health', JSON.stringify(socialService.health()), { EX: 60 }).catch(() => undefined), 5_000);
  }
  if (hotMonitor) {
    await hotMonitor.start();
    // Diagnostics for the System page (Redis, short TTL).
    exitMonitorTimer = globalThis.setInterval(() => void eventPublisher.set('newlaunch:exitmonitor', JSON.stringify({ ...hotMonitor.snapshot(), capacity: capacityMetrics.snapshot() }), { EX: 30 }).catch(() => undefined), 2_000);
  }
  if (rpcManager) {
    // RPC observability for the System page (credential-free snapshot, short TTL).
    globalThis.setInterval(() => void eventPublisher.set('rpc:health', JSON.stringify(rpcManager.snapshot()), { EX: 30 }).catch(() => undefined), 5_000);
  }
  const beat = () => eventPublisher.set('worker:heartbeat', JSON.stringify({ at: new Date().toISOString(), status: loop.currentStatus }), { EX: 60 })
    .catch((error: unknown) => logger.warn({ err: error }, 'Worker heartbeat failed'));
  await beat();
  heartbeatTimer = globalThis.setInterval(() => void beat(), 10_000);
  logger.info({ mode: env.TRADING_MODE, serverLiveTradingConfigured: env.LIVE_TRADING_ENABLED }, 'Worker service started');
}

async function shutdown(signal: string) {
  logger.info({ signal }, 'Worker shutting down');
  if (heartbeatTimer) globalThis.clearInterval(heartbeatTimer);
  if (exitMonitorTimer) globalThis.clearInterval(exitMonitorTimer);
  await hotMonitor?.stop();
  socialService?.stop();
  communityService?.stop();
  await telegramProvider.stop();
  newLaunch.stop();
  await loop.stop();
  await eventPublisher.quit();
  await redisSubscriber.quit();
  await redisClient.quit();
  await prisma.$disconnect();
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

void main().catch(async (error) => {
  logger.error({ err: error }, 'Worker failed to start');
  await prisma.$disconnect();
  process.exitCode = 1;
});

export { commandSubscriber, loop, redisClient, redisSubscriber };
