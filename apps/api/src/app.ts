import crypto from 'node:crypto';

import { Prisma } from '@prisma/client';
import { AI_PROMPT_VERSION, type AiProviderStatus, createAiProvider, DEFAULT_AI_USER_SETTINGS } from '@soltrader/ai-engine';
import { createMarketDataProvider } from '@soltrader/market-data';
import { checkHealth, MonitoringRegistry, TelegramNotifier, createCorrelationId } from '@soltrader/monitoring';
import { BotCommandPublisher } from '@soltrader/shared';
import { CONFIGURABLE_STRATEGY_NAMES, DEFAULT_ADVANCED_SETTINGS, isConfigurableStrategyName, REQUIRED_HISTORY_MINUTES, resolveAdvancedSettings, STRATEGY_PARAMETER_DEFAULTS } from '@soltrader/strategy-engine';
import { closePaperPosition, debitPaperCash, DEFAULT_CAPACITY_CONFIG, describeExitLevels, effectiveDailyLossLimit, estimateExitSlippagePercent, estimatePriceImpactPercent, hashApprovalProposal, InsufficientPaperCashError, paperFee, protectionLevels, recomputePaperAccount, simulatedBuyFill } from '@soltrader/trading-engine';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { createClient } from 'redis';
import { z } from 'zod';

import { createAdminUsersRouter } from './admin-users.js';
import {
  comparePasswords,
  createSessionForUser,
  deleteSessionForToken,
  ensureInitialAdminUser,
  findSessionByToken,
  getSessionTtlMs,
  getUserByEmail,
  getUserById,
  hashPassword,
  hashToken,
  logAuditEvent,
  onAuditEvent,
  verifySignedSessionToken,
} from './auth.js';
import { runHistoricalBacktest, serializeBacktestResult } from './backtesting.js';
import { createBotController } from './bot-controller.js';
import { buildCapacityAnalytics } from './capacity-analytics.js';
import { env } from './config.js';
import { prisma } from './database.js';
import { createEmailVerification, createStepUpGate, EmailDeliveryError, normalizeIp, VERIFY_FAILURE_MESSAGES, verificationEnabled } from './email-verification.js';
import { createTokenImageProxy, parseAvatarDataUrl, sendImage } from './images.js';
import { loadLaunchInfo } from './launch-info.js';
import { evaluateLiveSafety, LiveSafetyController, type LiveSafetyState } from './live-safety.js';
import { logger } from './logger.js';
import { createMlRouter } from './ml-analytics.js';
import { buildLaunchAnalytics, launchFunnel, loadLaunchTrades, parseScope, simulateFilter } from './new-launch-analytics.js';
import { applyNewLaunchSettingsChange, loadNewLaunchSettings } from './new-launch-config.js';
import { startOptimizationRun } from './new-launch-optimizer-job.js';
import { buildPositionChart, buildPositionDetail, buildTokenChart, type ChartRange, persistedExitState, positionDecisionSource, priceLiquiditySeries } from './position-detail.js';
import { redactSensitiveFields } from './secret-redaction.js';
import { buildSocialAnalytics } from './social-analytics.js';
import { SseEventHub } from './sse.js';
import { buildTelegramAnalytics } from './telegram-analytics.js';
import { TelegramBotService } from './telegram-bot.js';
import { aiDecisionFunnel, type AnalyticsTrade, computeTradeAnalytics, groupBy as groupTrades } from './trade-analytics.js';
import {
  advancedStrategySettingsSchema,
  aiSettingsSchema,
  newLaunchSettingsSchema,
  closePositionSchema,
  liveEnableSchema,
  manualPaperBuySchema,
  paginationSchema,
  settingsNotificationUpdateSchema,
  settingsRiskUpdateSchema,
  settingsStrategyUpdateSchema,
  settingsUpdateSchema,
  signalQuerySchema,
  walletChallengeSchema,
  walletConnectSchema,
  walletDisconnectSchema,
} from './validation.js';
import { decodeSignature, decodeSolanaPublicKey, fetchSolBalance, rpcUrlForNetwork, verifyEd25519Signature, WalletChallengeStore } from './wallet-verification.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: {
        id: string;
        email: string;
        role: string;
      };
      correlationId?: string;
      /** SHA-256 of the current session token (lets admin actions keep the acting admin's own session). */
      sessionTokenHash?: string;
    }
  }
}

const app = express();
const liveSafetyController = new LiveSafetyController();
// E-mail verification codes: login from a new IP, and sensitive admin actions (sent to the acting admin).
const emailVerification = createEmailVerification({ prisma, secret: env.SESSION_SECRET, logger, production: env.NODE_ENV === 'production' });
const stepUp = createStepUpGate(emailVerification);
const monitoring = new MonitoringRegistry();
const telegram = new TelegramNotifier(env);
const sseEventHub = new SseEventHub();
const apiMarketDataProvider = createMarketDataProvider({
  MARKET_DATA_PROVIDER: env.MARKET_DATA_PROVIDER,
  MARKET_DATA_REQUEST_TIMEOUT_MS: String(env.MARKET_DATA_REQUEST_TIMEOUT_MS),
});
let botRedisPublisher: BotCommandPublisher | undefined;

async function getBotCommandPublisher() {
  if (!botRedisPublisher) {
    const client = createClient({ url: env.REDIS_URL, ...(env.REDIS_PASSWORD ? { password: env.REDIS_PASSWORD } : {}) });
    client.on('error', (error: Error) => logger.error({ err: error }, 'Bot command Redis client error'));
    await client.connect();
    botRedisPublisher = new BotCommandPublisher(client);
  }
  return botRedisPublisher;
}

let realtimePublisher: Promise<ReturnType<typeof createClient>> | undefined;

function getRealtimeClient() {
  if (!realtimePublisher) {
    const client = createClient({ url: env.REDIS_URL, ...(env.REDIS_PASSWORD ? { password: env.REDIS_PASSWORD } : {}) });
    client.on('error', (error: Error) => logger.error({ err: error }, 'Realtime Redis publisher error'));
    realtimePublisher = client.connect().then(() => client).catch((error: unknown) => {
      realtimePublisher = undefined;
      throw error;
    });
  }
  return realtimePublisher;
}

/** Publishes an event to the Redis channels the SSE hub relays to the dashboard; failures are logged, never thrown. */
async function publishRealtime(channel: string, payload: Record<string, unknown>) {
  try {
    await (await getRealtimeClient()).publish(channel, JSON.stringify(payload));
  } catch (error) {
    logger.warn({ err: error, channel }, 'Realtime event publish failed');
  }
}

if (env.NODE_ENV !== 'test') {
  onAuditEvent((entry) => void publishRealtime('bot:logs', { ...entry, source: 'api' }));
}

async function safeNotify(event: Parameters<TelegramNotifier['notify']>[0], data: Record<string, unknown>, correlationId?: string) {
  try {
    return await telegram.notify(event, data, correlationId);
  } catch (error) {
    monitoring.record('SYSTEM_ERROR', { source: 'telegram', message: error instanceof Error ? error.message : String(error) }, correlationId);
    logger.error({ correlationId, err: error }, 'telegram_notification_failed');
    return { sent: false, reason: 'notification_failed' as const };
  }
}
const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Too many authentication attempts. Please try again later.' },
});
const READ_METHODS = ['GET', 'HEAD', 'OPTIONS'];

/**
 * Rate-limit key: the signed session cookie for signed-in users (so several open tabs of one user share one
 * budget and different users never share one), the client IP otherwise.
 */
function rateLimitKey(req: Request) {
  // Only a correctly signed cookie counts, so random cookie values cannot be used to dodge the IP limit.
  const session = verifySignedSessionToken(getCookieValue(req.cookies?.session_token));
  // ipKeyGenerator groups IPv6 addresses by subnet so a client cannot rotate addresses to dodge the limit.
  return session ? `session:${crypto.createHash('sha256').update(session).digest('hex').slice(0, 32)}` : `ip:${ipKeyGenerator(req.ip ?? 'unknown')}`;
}

// Dashboard reads (polling, live refreshes) and state-changing actions have separate budgets, so page
// refreshes can never use up the budget needed to buy, close or approve.
const apiReadRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 600,
  skip: (req) => !READ_METHODS.includes(req.method) || req.path === '/stream/events',
  keyGenerator: rateLimitKey,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Túl sok lekérdezés rövid idő alatt. Pár másodperc múlva automatikusan folytatódik.' },
});
const apiWriteRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  skip: (req) => READ_METHODS.includes(req.method) || req.path.startsWith('/auth/'),
  keyGenerator: rateLimitKey,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Túl sok művelet rövid idő alatt. Várj néhány másodpercet, majd próbáld újra.' },
});
const sensitiveActionRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  skip: (req) => READ_METHODS.includes(req.method),
  keyGenerator: rateLimitKey,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Túl sok biztonsági/beállítási művelet rövid idő alatt. Várj egy percet, majd próbáld újra.' },
});
const allowedOrigins = new Set(env.CORS_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean));

function errorResponse(res: Response, status: number, message: string, details?: unknown) {
  return res.status(status).json({ ok: false, error: message, details });
}

async function logSafetyEvent(action: string, userId: string | null, description: string, metadata: Record<string, unknown> = {}) {
  const writes = [
    logAuditEvent(action, userId, metadata),
    prisma.riskEvent.create({
      data: { type: 'MANUAL_OVERRIDE', description, severity: 'warning', metadata: metadata as Prisma.InputJsonValue },
    }),
    prisma.systemEvent.create({
      data: { eventType: action, severity: 'warning', message: description, metadata: metadata as Prisma.InputJsonValue },
    }),
  ];
  if (env.NODE_ENV === 'production') await Promise.all(writes);
  else await Promise.allSettled(writes);
}

async function getLiveSafetyReport(userId: string, userAuthenticated: boolean, activationRequested = false) {
  const [botConfig, riskConfig, wallet, unresolvedTransactions, unresolvedAttempts, databaseHealthy, globalEmergencyStop] = await Promise.all([
    prisma.botConfig.findUnique({ where: { userId } }).catch(() => null),
    prisma.riskConfig.findUnique({ where: { userId } }).catch(() => null),
    prisma.wallet.findFirst({ where: { userId, type: 'BOT_TRADING', isActive: true } }).catch(() => null),
    prisma.transaction.count({
      where: {
        mode: 'LIVE',
        status: { notIn: ['confirmed', 'failed', 'cancelled', 'reconciled', 'finalized', 'expired'] },
        trade: { userId },
      },
    }).catch(() => null),
    prisma.executionAttempt.count({ where: { userId, state: { in: ['UNKNOWN', 'SIGNED', 'SUBMITTED'] } } }).catch(() => null),
    prisma.$queryRaw<Array<{ ok: number }>>`SELECT 1 as ok`.then(() => true).catch(() => false),
    prisma.botConfig.findFirst({ where: { isEmergencyStop: true }, select: { id: true } }).then(Boolean).catch(() => true),
  ]);
  const expectedNetwork = process.env.RPC_NETWORK?.trim() || 'mainnet-beta';
  const positive = (value: Prisma.Decimal | number | string | null | undefined) => {
    const numeric = toNumber(value);
    return numeric !== null && Number.isFinite(numeric) && numeric > 0;
  };
  const state: LiveSafetyState = {
    userAuthenticated,
    userLiveEnabled: (botConfig?.isLiveEnabled === true && botConfig.tradingMode === 'LIVE') || activationRequested,
    serverLiveTradingEnabled: env.LIVE_TRADING_ENABLED,
    liveApprovalCompleted: botConfig?.liveApprovalCompleted === true || activationRequested,
    dedicatedTradingWalletConfigured: Boolean(wallet && wallet.publicAddress === botConfig?.botTradingWalletAddress),
    walletSecretAvailable: Boolean(process.env.BOT_TRADING_WALLET_SECRET?.trim()),
    walletNetworkCorrect: Boolean(wallet && wallet.network === expectedNetwork),
    rpcHealthy: process.env.RPC_HEALTHY === 'true',
    executionProviderHealthy: Boolean(process.env.EXECUTION_PROVIDER_URL?.trim()) && process.env.EXECUTION_PROVIDER_HEALTHY === 'true',
    marketDataHealthy: process.env.MARKET_DATA_HEALTHY === 'true',
    riskEngineHealthy: process.env.RISK_ENGINE_HEALTHY === 'true',
    positionManagerHealthy: process.env.POSITION_MANAGER_HEALTHY === 'true',
    dailyLossLimitConfigured: positive(riskConfig?.dailyLossLimitPercent) || positive(botConfig?.maxDailyLoss),
    maxPositionConfigured: positive(riskConfig?.maxPositionPercent) || positive(botConfig?.maxPositionSize),
    maxSlippageConfigured: positive(riskConfig?.maxSlippagePercent),
    maxExposureConfigured: positive(riskConfig?.maxTotalExposurePercent),
    emergencyStopClear: !liveSafetyController.emergencyStop && botConfig?.isEmergencyStop !== true && !globalEmergencyStop,
    noUnresolvedTransaction: unresolvedTransactions === 0 && unresolvedAttempts === 0,
    noActiveCircuitBreakers: liveSafetyController.activeBreakers.size === 0,
    systemHealthAcceptable: databaseHealthy
      && process.env.REDIS_HEALTHY === 'true'
      && Number(process.env.CRITICAL_SYSTEM_ERRORS ?? 0) === 0
      && process.env.RPC_HEALTHY === 'true'
      && process.env.EXECUTION_PROVIDER_HEALTHY === 'true'
      && process.env.MARKET_DATA_HEALTHY === 'true'
      && process.env.RISK_ENGINE_HEALTHY === 'true'
      && process.env.POSITION_MANAGER_HEALTHY === 'true',
  };
  return { report: evaluateLiveSafety(state, liveSafetyController), botConfig };
}

async function evaluateLiveSettingsMutation(userId: string, tradingMode: string | undefined, isLiveEnabled: boolean | undefined) {
  if (tradingMode === 'LIVE' || isLiveEnabled === true) {
    const { report } = await getLiveSafetyReport(userId, true);
    await logSafetyEvent('safety_gate_failed', userId, 'Direct settings mutation cannot enable LIVE authorization', { failedChecks: report.failedChecks });
    return { blocked: true as const, report, disableAuthorization: false };
  }

  const current = await prisma.botConfig.findUnique({ where: { userId } });
  const disableRequested = isLiveEnabled === false || (tradingMode !== undefined && tradingMode !== 'LIVE');
  const disableAuthorization = Boolean(current && disableRequested && (current.isLiveEnabled || current.liveApprovalCompleted || current.tradingMode === 'LIVE'));
  return { blocked: false as const, report: null, disableAuthorization };
}

async function activateLiveEmergencyStop(userId: string, reason: string) {
  const event = liveSafetyController.activateEmergencyStop(reason);
  const previouslyLive = await prisma.botConfig.count({ where: { isLiveEnabled: true } }).catch(() => 0);
  await prisma.botConfig.updateMany({
    where: {},
    data: { tradingMode: 'PAPER', isLiveEnabled: false, liveApprovalCompleted: false, isEmergencyStop: true, status: 'EMERGENCY_STOP', updatedAt: new Date() },
  });
  await prisma.botConfig.upsert({
    where: { userId },
    update: { tradingMode: 'PAPER', isLiveEnabled: false, liveApprovalCompleted: false, isEmergencyStop: true, status: 'EMERGENCY_STOP', updatedAt: new Date() },
    create: { userId, tradingMode: 'PAPER', isLiveEnabled: false, liveApprovalCompleted: false, isEmergencyStop: true, status: 'EMERGENCY_STOP' },
  });
  await logSafetyEvent('emergency_stop', userId, event.reason, event);
  if (previouslyLive > 0) await logSafetyEvent('trading_halted', userId, 'Trading halted by emergency stop', { affectedBotConfigs: previouslyLive });
  return { event, previouslyLive };
}

function getCookieValue(value: string | undefined) {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const signedToken = getCookieValue(req.cookies?.session_token);
  const token = verifySignedSessionToken(signedToken);

  if (!token) {
    return errorResponse(res, 401, 'Authentication required');
  }

  const session = await findSessionByToken(token);
  if (!session || session.expiresAt <= Date.now()) {
    return errorResponse(res, 401, 'Session expired or invalid');
  }

  const user = await getUserById(session.userId);
  if (!user) {
    return errorResponse(res, 401, 'Account not found');
  }

  req.user = { id: user.id, email: user.email, role: user.role };
  req.sessionTokenHash = hashToken(token);
  return next();
}

function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (req.user?.role !== 'ADMIN') {
    return errorResponse(res, 403, 'Administrator authorization required');
  }
  return next();
}

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.has(origin)) return callback(null, true);
    return callback(null, false);
  },
  credentials: true,
}));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (env.NODE_ENV === 'production') res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  return next();
});
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.use('/api/auth', authRateLimiter);
app.use('/api', apiReadRateLimiter, apiWriteRateLimiter);
app.use(['/api/safety', '/api/bot', '/api/settings', '/api/positions', '/api/approvals', '/api/backtests', '/api/stream/events', '/api/v1/trades/simulate'], sensitiveActionRateLimiter);
app.use((req, res, next) => {
  const origin = req.header('origin');
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && env.NODE_ENV === 'production' && !origin) {
    return errorResponse(res, 403, 'Origin is required for state-changing requests');
  }
  if (origin && !allowedOrigins.has(origin) && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    return errorResponse(res, 403, 'Origin is not allowed');
  }
  const correlationId = req.header('x-correlation-id') ?? createCorrelationId();
  req.correlationId = correlationId;
  res.setHeader('x-correlation-id', correlationId);
  const startedAt = Date.now();
  res.on('finish', () => {
    monitoring.measure('API', 'request_latency', startedAt, correlationId);
    monitoring.record('api_request', { method: req.method, path: req.path, statusCode: res.statusCode }, correlationId);
    logger.info({ correlationId, method: req.method, path: req.path, statusCode: res.statusCode, latencyMs: Date.now() - startedAt }, 'api_request');
  });
  return next();
});

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'api',
    status: 'healthy',
    mode: env.TRADING_MODE,
    liveTradingEnabled: false,
    serverLiveTradingConfigured: env.LIVE_TRADING_ENABLED,
  });
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const loginSchema = z.object({
      email: z.string().email(),
      password: z.string().min(8),
    });

    const parsed = loginSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return errorResponse(res, 400, 'Invalid login payload', parsed.error.issues);
    }

    const admin = await ensureInitialAdminUser();
    const user = await getUserByEmail(parsed.data.email);

    if (!user) {
      return errorResponse(res, 401, 'Invalid email or password');
    }

    const valid = await comparePasswords(parsed.data.password, user.passwordHash || admin.passwordHash);
    if (!valid) {
      return errorResponse(res, 401, 'Invalid email or password');
    }

    // Login from an IP this account has not confirmed yet: a code goes to the account's e-mail; no session until then.
    const ip = req.ip ?? '';
    if (verificationEnabled() && !user.id.startsWith('memory-') && !await emailVerification.isTrustedIp(user.id, ip)) {
      const challenge = await emailVerification.createChallenge({ userId: user.id, email: user.email, purpose: 'LOGIN_NEW_IP', action: 'login', params: { ip: normalizeIp(ip) }, ip });
      if ('error' in challenge) return errorResponse(res, 429, 'Túl sok megerősítő kód rövid időn belül – várj néhány percet.');
      await logAuditEvent('login_verification_sent', user.id, { email: user.email });
      return res.json({ ok: true, data: { verificationRequired: true, ...challenge } });
    }
    return completeLogin(res, user);
  } catch (error) {
    if (error instanceof EmailDeliveryError) return errorResponse(res, 503, error.message);
    logger.error({ err: error }, 'Login failed');
    return errorResponse(res, 500, 'Unable to log in');
  }
});

async function completeLogin(res: Response, user: { id: string; email: string; role: string }, extraAudit: Record<string, unknown> = {}) {
  const session = await createSessionForUser(user.id);
  await ensurePaperAccountForUser(user.id);
  res.cookie('session_token', session.signedToken, {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.NODE_ENV === 'production',
    path: '/',
    maxAge: getSessionTtlMs(),
  });
  await logAuditEvent('login', user.id, { email: user.email, ...extraAudit });
  return res.json({ ok: true, data: { email: user.email, role: user.role, expiresAt: new Date(session.expiresAt).toISOString() } });
}

/** Second login step from a new IP: the e-mailed code. Success trusts this IP for the account. */
app.post('/api/auth/login/verify', async (req, res) => {
  const parsed = z.object({ challengeId: z.string().min(1).max(100), code: z.string().trim().regex(/^\d{6}$/, 'A kód 6 számjegy') }).safeParse(req.body ?? {});
  if (!parsed.success) return errorResponse(res, 400, parsed.error.issues[0]?.message ?? 'Érvénytelen kód');
  try {
    const ip = req.ip ?? '';
    const result = await emailVerification.verifyChallenge({ challengeId: parsed.data.challengeId, purpose: 'LOGIN_NEW_IP', action: 'login', params: { ip: normalizeIp(ip) }, ip, code: parsed.data.code });
    if (!result.ok) {
      return res.status(400).json({ ok: false, error: VERIFY_FAILURE_MESSAGES[result.reason], code: 'VERIFICATION_FAILED', data: { reason: result.reason, retryable: result.reason === 'INVALID_CODE' && (result.attemptsLeft ?? 0) > 0, attemptsLeft: result.attemptsLeft ?? 0 } });
    }
    const user = await getUserById(result.userId);
    if (!user) return errorResponse(res, 401, 'Invalid email or password');
    await emailVerification.trustIp(user.id, ip);
    await logAuditEvent('login_new_ip_verified', user.id, { email: user.email });
    return completeLogin(res, user, { newIpVerified: true });
  } catch (error) {
    logger.error({ err: error }, 'Login verification failed');
    return errorResponse(res, 500, 'Unable to verify login');
  }
});

app.post('/api/auth/logout', async (req, res) => {
  try {
    const signedToken = getCookieValue(req.cookies?.session_token);
    const token = verifySignedSessionToken(signedToken);

    if (token) {
      await deleteSessionForToken(signedToken);
      await logAuditEvent('logout', req.user?.id ?? null, { sessionRevoked: true });
    }

    res.clearCookie('session_token', { path: '/', httpOnly: true, sameSite: 'lax', secure: env.NODE_ENV === 'production' });
    return res.json({ ok: true, data: { loggedOut: true } });
  } catch (error) {
    logger.error({ err: error }, 'Logout failed');
    return errorResponse(res, 500, 'Unable to log out');
  }
});

/** The signed-in user (profile card). */
app.get('/api/auth/me', requireAuth, async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.user!.id }, select: { name: true, createdAt: true, avatarUpdatedAt: true } }).catch(() => null);
  return res.json({ ok: true, data: { id: req.user!.id, email: req.user!.email, role: req.user!.role, name: user?.name ?? null, memberSince: user?.createdAt ?? null, avatarVersion: user?.avatarUpdatedAt?.getTime() ?? null } });
});

app.get('/api/safety/live', requireAuth, async (req, res) => {
  try {
    const userId = req.user!.id;
    const { report, botConfig } = await getLiveSafetyReport(userId, true);
    const liveEnabled = botConfig?.isLiveEnabled === true && report.canEnable;
    const approvalCompleted = botConfig?.liveApprovalCompleted === true && report.canEnable;
    return res.json({ ok: true, data: { ...report, liveEnabled, approvalCompleted, canManageLive: req.user?.role === 'ADMIN', emergencyStop: report.failedChecks.includes('EMERGENCY_STOP_CLEAR'), activeBreakerCount: liveSafetyController.activeBreakers.size, activeBreakers: req.user?.role === 'ADMIN' ? Object.fromEntries(liveSafetyController.activeBreakers) : undefined } });
  } catch (error) {
    logger.error({ err: error }, 'Failed to evaluate live safety gate');
    return errorResponse(res, 503, 'LIVE BLOCKED: Unable to verify all safety conditions');
  }
});

app.post('/api/safety/live/enable', requireAuth, requireAdmin, async (req, res) => {
  try {
  const parsed = liveEnableSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return errorResponse(res, 400, 'Explicit live-trading confirmation is required', parsed.error.issues);
  }

  const { report } = await getLiveSafetyReport(req.user!.id, true, parsed.data.confirmLiveTrading);
  if (!report.canEnable) {
    await logSafetyEvent('safety_gate_failed', req.user?.id ?? null, 'LIVE mode enable rejected by safety gate', { failedChecks: report.failedChecks, blockingReasons: report.blockingReasons });
    return errorResponse(res, 403, 'LIVE mode cannot be enabled', report);
  }
  if (!await stepUp(req, res, 'live_enable', { confirmLiveTrading: true })) return;

  await prisma.botConfig.upsert({
    where: { userId: req.user!.id },
    update: { tradingMode: 'LIVE', isLiveEnabled: true, liveApprovalCompleted: true, isPaperModeDefault: false, updatedAt: new Date() },
    create: { userId: req.user!.id, tradingMode: 'LIVE', isLiveEnabled: true, liveApprovalCompleted: true, isPaperModeDefault: false },
  });
  const verified = await getLiveSafetyReport(req.user!.id, true);
  if (!verified.report.canEnable) {
    await prisma.botConfig.updateMany({
      where: { userId: req.user!.id, isLiveEnabled: true },
      data: { tradingMode: 'PAPER', isLiveEnabled: false, liveApprovalCompleted: false, isPaperModeDefault: true, updatedAt: new Date() },
    });
    await logSafetyEvent('safety_gate_failed', req.user?.id ?? null, 'LIVE activation failed its post-write safety recheck', { failedChecks: verified.report.failedChecks, blockingReasons: verified.report.blockingReasons });
    return errorResponse(res, 403, 'LIVE mode cannot be enabled', verified.report);
  }
  await logSafetyEvent('safety_gate_passed', req.user?.id ?? null, 'LIVE safety gate passed', { checksPassed: verified.report.checks.length });
  await logSafetyEvent('live_mode_enabled', req.user?.id ?? null, 'LIVE mode enabled after explicit confirmation', { confirmed: true });
  return res.json({ ok: true, data: { liveEnabled: true, approvalCompleted: true, status: 'LIVE READY' } });
  } catch (error) {
    logger.error({ err: error }, 'Failed to enable live trading');
    return errorResponse(res, 503, 'LIVE BLOCKED: Unable to verify all safety conditions');
  }
});

app.post('/api/safety/live/disable', requireAuth, requireAdmin, async (req, res) => {
  try {
    await prisma.botConfig.updateMany({
      where: { userId: req.user!.id },
      data: { tradingMode: 'PAPER', isLiveEnabled: false, liveApprovalCompleted: false, isPaperModeDefault: true, updatedAt: new Date() },
    });
    await logSafetyEvent('live_mode_disabled', req.user?.id ?? null, 'LIVE mode disabled by explicit user action');
    return res.json({ ok: true, data: { liveEnabled: false, approvalCompleted: false, status: 'LIVE BLOCKED' } });
  } catch (error) {
    logger.error({ err: error }, 'Failed to disable live trading');
    return errorResponse(res, 500, 'Unable to disable LIVE trading');
  }
});

app.post('/api/safety/emergency-stop', requireAuth, requireAdmin, async (req, res) => {
  try {
    await activateLiveEmergencyStop(req.user!.id, 'Manual emergency stop requested');
    return res.json({ ok: true, data: { emergencyStop: true, preventsNewEntries: true } });
  } catch (error) {
    logger.error({ err: error }, 'Failed to activate emergency stop');
    return errorResponse(res, 500, 'Unable to activate emergency stop');
  }
});

app.post('/api/safety/emergency-stop/clear', requireAuth, requireAdmin, async (req, res) => {
  if (req.body?.confirmEmergencyStopClear !== true) {
    return errorResponse(res, 400, 'Explicit emergency-stop reset confirmation is required');
  }
  try {
    // Clearing the stop re-enables trading: needs the acting admin's e-mail code. (Activating the stop never does.)
    if (!await stepUp(req, res, 'emergency_stop_clear', { confirmEmergencyStopClear: true })) return;
    await prisma.botConfig.updateMany({ where: { isEmergencyStop: true }, data: { isEmergencyStop: false, status: 'STOPPED', updatedAt: new Date() } });
    liveSafetyController.clearEmergencyStop();
    await logSafetyEvent('emergency_stop_cleared', req.user?.id ?? null, 'Emergency stop cleared by explicit administrator action', { confirmed: true });
    return res.json({ ok: true, data: { emergencyStop: false, status: 'STOPPED' } });
  } catch (error) {
    logger.error({ err: error }, 'Failed to clear emergency stop');
    return errorResponse(res, 500, 'Unable to clear emergency stop');
  }
});

app.use((req, res, next) => {
  if (req.path === '/api/auth/login' || req.path === '/api/auth/login/verify' || req.path === '/api/auth/logout' || req.path === '/health') {
    return next();
  }

  return requireAuth(req, res, next);
});

// Token logos through a safe server-side proxy (the browser never contacts third-party image hosts).
const tokenImages = createTokenImageProxy({ prisma });
app.get('/api/token-images/:address', async (req, res) => {
  const address = String(req.params.address);
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) return errorResponse(res, 400, 'Invalid token address');
  try {
    const image = await tokenImages(address);
    if (!image) {
      res.setHeader('Cache-Control', 'private, max-age=1800');
      return errorResponse(res, 404, 'No image');
    }
    return sendImage(res, image.bytes, image.mime, 86_400);
  } catch (error) {
    logger.warn({ err: error instanceof Error ? error.message : String(error) }, 'Token image proxy failed');
    return errorResponse(res, 404, 'No image');
  }
});

/** Own profile picture: client-resized PNG / JPEG / WebP data URL, verified server-side. */
app.put('/api/profile/avatar', async (req, res) => {
  const parsed = parseAvatarDataUrl((req.body as { image?: unknown } | undefined)?.image);
  if ('error' in parsed) return errorResponse(res, 400, parsed.error);
  const user = await prisma.user.update({ where: { id: req.user!.id }, data: { avatarImage: parsed.bytes, avatarMime: parsed.mime, avatarUpdatedAt: new Date() }, select: { avatarUpdatedAt: true } });
  await logAuditEvent('profile_avatar_updated', req.user!.id, { bytes: parsed.bytes.length, mime: parsed.mime });
  return res.json({ ok: true, data: { avatarVersion: user.avatarUpdatedAt?.getTime() ?? null } });
});

app.delete('/api/profile/avatar', async (req, res) => {
  await prisma.user.update({ where: { id: req.user!.id }, data: { avatarImage: null, avatarMime: null, avatarUpdatedAt: null } });
  await logAuditEvent('profile_avatar_removed', req.user!.id, {});
  return res.json({ ok: true, data: { avatarVersion: null } });
});

/** Profile pictures are visible to their owner and to administrators. */
app.get('/api/users/:id/avatar', async (req, res) => {
  const id = String(req.params.id);
  if (id !== req.user!.id && req.user!.role !== 'ADMIN') return errorResponse(res, 403, 'Forbidden');
  const user = await prisma.user.findUnique({ where: { id }, select: { avatarImage: true, avatarMime: true } }).catch(() => null);
  if (!user?.avatarImage || !user.avatarMime) return errorResponse(res, 404, 'No avatar');
  return sendImage(res, user.avatarImage, user.avatarMime, 3_600);
});

// Machine Learning (shadow research; read for every signed-in user, model status: admin + e-mail code).
app.use('/api/ml', createMlRouter({ prisma, readJson: (key) => readJsonKey<Record<string, unknown>>(key), logAuditEvent, stepUp, logger }));

// Administrator user management (list / create / role / password / sessions / delete).
app.use('/api/admin/users', sensitiveActionRateLimiter, requireAdmin, createAdminUsersRouter({ prisma, hashPassword, logAuditEvent, bootstrapAdminEmail: env.ADMIN_EMAIL, logger, stepUp }));

const botController = createBotController({ prisma, getPublisher: getBotCommandPublisher, logAuditEvent, logger });
app.get('/api/stream/events', requireAuth, (req, res) => sseEventHub.handle(req, res, { userId: req.user!.id, role: req.user!.role }));
app.get('/api/bot/status', requireAdmin, botController.status);
app.post('/api/bot/start', requireAdmin, botController.start);
app.post('/api/bot/pause', requireAdmin, botController.pause);
app.post('/api/bot/stop', requireAdmin, botController.stop);
app.post('/api/bot/emergency-stop', requireAdmin, async (req, res) => {
  try {
    await activateLiveEmergencyStop(req.user!.id, 'Emergency stop activated from Bot Master controls');
    return botController.emergencyStop(req, res);
  } catch (error) {
    logger.error({ err: error }, 'Failed to activate live emergency stop');
    return errorResponse(res, 500, 'Unable to activate emergency stop');
  }
});
app.post('/api/bot/resume', requireAdmin, botController.start);
app.post('/api/bot/strategies/:name/toggle', requireAdmin, botController.toggleStrategy);

const settingsStrategyNames = [...CONFIGURABLE_STRATEGY_NAMES];

/** No AI token analyst is wired into the worker yet; AI-dependent risk rules therefore cannot be satisfied. */
const AI_PROVIDER_CONFIGURED = false;

function storedStrategyParams(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Strategy settings as the worker will actually run them: known strategies only, stored params merged over engine defaults. */
function serializeStrategySettings(configs: Array<{ strategyName: string; isEnabled: boolean; params: unknown }>) {
  return Object.fromEntries(CONFIGURABLE_STRATEGY_NAMES.map((name) => {
    const row = configs.find((config) => config.strategyName === name);
    const stored = storedStrategyParams(row?.params);
    const defaults = STRATEGY_PARAMETER_DEFAULTS[name];
    const params = Object.fromEntries(Object.entries(defaults).map(([key, fallback]) => {
      const value = stored[key];
      return [key, typeof value === 'number' && Number.isFinite(value) ? value : fallback];
    }));
    return [name, { isEnabled: row?.isEnabled ?? false, params, defaults }];
  }));
}

function toNumber(value: Prisma.Decimal | number | string | null | undefined) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return Number(value);
  if (typeof value === 'object' && 'toNumber' in value && typeof value.toNumber === 'function') {
    return value.toNumber();
  }
  return null;
}

async function ensurePaperAccountForUser(userId: string, initialBalance = 1000) {
  const normalizedInitialBalance = Number.isFinite(initialBalance) ? Math.max(initialBalance, 0) : 1000;
  const existing = await prisma.paperAccount.findUnique({ where: { userId } });
  if (existing) return existing;

  return prisma.paperAccount.create({
    data: {
      userId,
      currency: 'USDC',
      initialBalance: new Prisma.Decimal(normalizedInitialBalance),
      cashBalance: new Prisma.Decimal(normalizedInitialBalance),
      equity: new Prisma.Decimal(normalizedInitialBalance),
      realizedPnl: new Prisma.Decimal(0),
      unrealizedPnl: new Prisma.Decimal(0),
      totalFees: new Prisma.Decimal(0),
    },
  });
}

async function ensurePaperAccountExistsForRequest(req: Request) {
  if (!req.user?.id) return null;
  return ensurePaperAccountForUser(req.user.id);
}

export function serializeTokenListRow(token: Prisma.TokenGetPayload<{ include: { tokenMetrics: true; riskAssessments: true; signals: true } }>) {
  const latestMetric = Array.isArray(token.tokenMetrics) && token.tokenMetrics.length > 0 ? token.tokenMetrics[0] : null;
  const latestRisk = Array.isArray(token.riskAssessments) && token.riskAssessments.length > 0 ? token.riskAssessments[0] : null;
  const latestSignal = Array.isArray(token.signals)
    ? token.signals.find((signal) => signal.signalType !== 'MANUAL_PAPER' && (signal.signalType === 'STRATEGY' || Boolean(signal.strategyName))) ?? null
    : null;
  const priceUsd = toNumber(latestMetric?.priceUsd ?? token.priceUsd);
  const snapshotAgeMs = latestMetric?.timestamp ? Date.now() - latestMetric.timestamp.getTime() : Number.POSITIVE_INFINITY;
  const dataQuality = priceUsd !== null && priceUsd > 0
    ? snapshotAgeMs > 120_000 ? 'STALE' : latestMetric?.liquidityUsd == null ? 'PARTIAL' : 'VALID'
    : 'INVALID';
  const signalMetadata = latestSignal?.metadata && typeof latestSignal.metadata === 'object' && !Array.isArray(latestSignal.metadata)
    ? latestSignal.metadata as Record<string, unknown>
    : {};
  const finalDecision = typeof signalMetadata.finalDecision === 'string'
    ? signalMetadata.finalDecision
    : latestRisk?.hardBlocked ? 'BLOCKED' : latestSignal ? 'WATCH' : latestRisk ? 'ANALYZING' : 'ANALYZING';

  return {
    id: token.id,
    address: token.address,
    symbol: token.symbol,
    name: token.name,
    decimals: token.decimals,
    isVerified: token.isVerified,
    priceUsd,
    priceNative: toNumber(latestMetric?.priceNative),
    dataQuality,
    liquidityUsd: toNumber(latestMetric?.liquidityUsd),
    volume24h: toNumber(latestMetric?.volume24h ?? token.volume24h),
    marketCap: toNumber(latestMetric?.marketCap ?? token.marketCap),
    fdv: toNumber(latestMetric?.fdv ?? token.fdv),
    priceChange1h: toNumber(latestMetric?.priceChange1h),
    priceChange24h: toNumber(latestMetric?.priceChange24h),
    lastUpdatedAt: latestMetric?.timestamp ?? token.updatedAt,
    riskScore: latestRisk ? toNumber(latestRisk.riskScore) : null,
    riskDecision: latestRisk?.decision ?? null,
    riskClassification: latestRisk?.classification ?? null,
    riskHardBlocked: latestRisk?.hardBlocked ?? null,
    riskPositionMultiplier: latestRisk ? toNumber(latestRisk.positionMultiplier) : null,
    riskWarnings: latestRisk?.warnings ?? [],
    hardBlockReasons: latestRisk?.hardBlockReasons ?? [],
    riskStatus: latestRisk ? 'COMPLETED' : 'PENDING',
    decision: finalDecision,
    signalStatus: latestSignal ? 'COMPLETED' : latestRisk ? 'PENDING' : 'PENDING',
    signalDirection: latestSignal?.direction ?? null,
    signalScore: latestSignal ? toNumber(latestSignal.score) : null,
    signalStrategyName: latestSignal?.strategyName ?? latestSignal?.signalType ?? null,
    createdAt: token.createdAt,
  };
}

async function ensureUserSettings(userId: string) {
  const [botConfig, riskConfig, notificationConfig, strategyConfigs] = await Promise.all([
    prisma.botConfig.upsert({
      where: { userId },
      update: {},
      create: {
        userId,
        botName: 'main-bot',
        tradingMode: 'PAPER',
        isLiveEnabled: false,
        isScannerEnabled: true,
        isPaperModeDefault: true,
        preferredQuoteCurrency: 'USDC',
        maxTokenAgeHours: 168,
      },
    }),
    prisma.riskConfig.upsert({
      where: { userId },
      update: {},
      create: {
        userId,
        maxPositionPercent: 10,
        maxTotalExposurePercent: 25,
        maxConcurrentPositions: 3,
        dailyLossLimitPercent: 5,
        maxSlippagePercent: 1,
        minSignalScore: 60,
        cooldownSeconds: 60,
        stopLossPercent: 2,
        takeProfitPercent: 4,
        trailingStopPercent: 1,
        trailingActivationPercent: 15,
      },
    }),
    prisma.notificationConfig.upsert({
      where: { userId },
      update: {},
      create: {
        userId,
        telegramEnabled: false,
        telegramChatId: null,
        emailAlerts: false,
        pushAlerts: false,
      },
    }),
    Promise.all(
      settingsStrategyNames.map(async (strategyName) => prisma.strategyConfig.upsert({
        where: { userId_strategyName: { userId, strategyName } },
        update: {},
        create: {
          userId,
          strategyName,
          isEnabled: false,
          params: {},
        },
      })),
    ),
  ]);

  return { botConfig, riskConfig, notificationConfig, strategyConfigs };
}

async function getUserSettingsView(userId: string) {
  const { botConfig, riskConfig, notificationConfig, strategyConfigs } = await ensureUserSettings(userId);
  const wallets = await prisma.wallet.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
  });

  return {
    tradingMode: botConfig.tradingMode,
    isLiveEnabled: botConfig.isLiveEnabled,
    isScannerEnabled: botConfig.isScannerEnabled,
    isPaperModeDefault: botConfig.isPaperModeDefault,
    maxPositionSize: toNumber(botConfig.maxPositionSize),
    maxDailyLoss: toNumber(botConfig.maxDailyLoss),
    riskThreshold: toNumber(botConfig.riskThreshold),
    preferredQuoteCurrency: botConfig.preferredQuoteCurrency,
    maxTokenAgeHours: botConfig.maxTokenAgeHours,
    minLiquidityUsd: toNumber(botConfig.minLiquidityUsd),
    minVolumeUsd: toNumber(botConfig.minVolumeUsd),
    skipUnbuyableAfterMinutes: botConfig.skipUnbuyableAfterMinutes,
    skipUnbuyableForMinutes: botConfig.skipUnbuyableForMinutes,
    maxMonitoredTokens: botConfig.maxMonitoredTokens,
    risk: {
      riskPolicy: riskConfig.riskPolicy,
      lowRiskMax: riskConfig.lowRiskMax,
      moderateRiskMax: riskConfig.moderateRiskMax,
      highRiskMax: riskConfig.highRiskMax,
      veryHighRiskMax: riskConfig.veryHighRiskMax,
      lowPositionMultiplier: toNumber(riskConfig.lowPositionMultiplier),
      moderatePositionMultiplier: toNumber(riskConfig.moderatePositionMultiplier),
      highPositionMultiplier: toNumber(riskConfig.highPositionMultiplier),
      veryHighPositionMultiplier: toNumber(riskConfig.veryHighPositionMultiplier),
      aiAnalysisEnabled: riskConfig.aiAnalysisEnabled,
      aiRequiredForHighRisk: riskConfig.aiRequiredForHighRisk,
      aiRequiredForVeryHighRisk: riskConfig.aiRequiredForVeryHighRisk,
      aiProviderConfigured: AI_PROVIDER_CONFIGURED,
      allowManualPaperWatchBuy: riskConfig.allowManualPaperWatchBuy,
      maxPositionPercent: toNumber(riskConfig.maxPositionPercent),
      maxTotalExposurePercent: toNumber(riskConfig.maxTotalExposurePercent),
      maxConcurrentPositions: riskConfig.maxConcurrentPositions,
      dailyLossLimitPercent: toNumber(riskConfig.dailyLossLimitPercent),
      maxSlippagePercent: toNumber(riskConfig.maxSlippagePercent),
      minSignalScore: toNumber(riskConfig.minSignalScore),
      cooldownSeconds: riskConfig.cooldownSeconds,
      stopLossPercent: toNumber(riskConfig.stopLossPercent),
      takeProfitPercent: toNumber(riskConfig.takeProfitPercent),
      trailingStopPercent: toNumber(riskConfig.trailingStopPercent),
      trailingActivationPercent: toNumber(riskConfig.trailingActivationPercent),
      breakEvenActivationPercent: toNumber(riskConfig.breakEvenActivationPercent),
    },
    strategies: serializeStrategySettings(strategyConfigs),
    wallet: wallets.map((wallet) => ({
      id: wallet.id,
      label: wallet.label ?? (wallet.type === 'BOT_TRADING' ? 'Bot trading wallet' : 'User wallet'),
      address: wallet.publicAddress,
      walletType: wallet.provider ?? 'PHANTOM',
      status: wallet.isActive ? 'CONNECTED' : 'DISCONNECTED',
      isPrimary: wallet.isActive,
      isPaper: wallet.type === 'BOT_TRADING',
      type: wallet.type,
      publicAddress: wallet.publicAddress,
      network: wallet.network,
      provider: wallet.provider,
      connected: wallet.isActive,
      isActive: wallet.isActive,
    })),
    notifications: {
      telegramEnabled: notificationConfig.telegramEnabled,
      telegramChatId: notificationConfig.telegramChatId,
      emailAlerts: notificationConfig.emailAlerts,
      pushAlerts: notificationConfig.pushAlerts,
    },
  };
}

/**
 * Social provider states for Settings (read-only): Telegram / X ON-OFF, connection state, AI, mode. Built from the
 * worker's published health; credentials are never part of it (only "configured: true/false").
 */
app.get('/api/social/status', async (_req, res) => {
  try {
    const health = await readJsonKey<Record<string, unknown>>('social:health').catch(() => null);
    const providers = Array.isArray(health?.providers) ? health!.providers as Array<Record<string, unknown>> : [];
    const pick = (source: string) => {
      const provider = providers.find((item) => item.source === source) ?? null;
      const details = (provider?.details ?? {}) as Record<string, unknown>;
      return provider ? {
        enabled: provider.enabled === true, configured: provider.configured === true, state: provider.state ?? 'UNKNOWN', lastSuccessAt: provider.lastSuccessAt ?? null,
        connectedSince: details.connectedSince ?? null, lastMessageAt: details.lastMessageAt ?? null, rateLimitedUntil: details.rateLimitedUntil ?? null,
      } : null;
    };
    return res.json({ ok: true, data: {
      available: Boolean(health), at: health?.at ?? null, mode: 'MONITOR_ONLY', engineStatus: health?.engineStatus ?? 'UNKNOWN', aiEnabled: health?.aiEnabled === true,
      telegram: pick('TELEGRAM'), x: pick('X'),
    } });
  } catch (error) {
    logger.error({ err: error }, 'Failed to read social status');
    return errorResponse(res, 500, 'Unable to read social status');
  }
});

app.get('/api/settings', async (req, res) => {
  try {
    const settings = await getUserSettingsView(req.user!.id);
    return res.json({ ok: true, data: settings });
  } catch (error) {
    logger.error({ err: error }, 'Failed to fetch settings');
    return errorResponse(res, 500, 'Unable to fetch settings');
  }
});

app.put('/api/settings', async (req, res) => {
  try {
    const parsed = settingsUpdateSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return errorResponse(res, 400, 'Invalid request body', parsed.error.issues);
    }

    const userId = req.user!.id;
    const liveMutation = await evaluateLiveSettingsMutation(userId, parsed.data.tradingMode, parsed.data.isLiveEnabled);
    if (liveMutation.blocked) return errorResponse(res, 403, 'LIVE mode cannot be enabled or changed through general settings', liveMutation.report);
    const next = await prisma.botConfig.upsert({
      where: { userId },
      update: {
        tradingMode: liveMutation.disableAuthorization && parsed.data.tradingMode === undefined ? 'PAPER' : parsed.data.tradingMode ?? undefined,
        isLiveEnabled: liveMutation.disableAuthorization ? false : parsed.data.isLiveEnabled ?? undefined,
        liveApprovalCompleted: liveMutation.disableAuthorization ? false : undefined,
        isPaperModeDefault: liveMutation.disableAuthorization ? true : parsed.data.isPaperModeDefault ?? undefined,
        status: liveMutation.disableAuthorization ? 'PAUSED' : undefined,
        isScannerEnabled: parsed.data.isScannerEnabled ?? undefined,
        maxPositionSize: parsed.data.maxPositionSize,
        maxDailyLoss: parsed.data.maxDailyLoss,
        riskThreshold: parsed.data.riskThreshold,
        preferredQuoteCurrency: parsed.data.preferredQuoteCurrency ?? undefined,
        maxTokenAgeHours: parsed.data.maxTokenAgeHours ?? undefined,
        minLiquidityUsd: parsed.data.minLiquidityUsd,
        minVolumeUsd: parsed.data.minVolumeUsd,
        skipUnbuyableAfterMinutes: parsed.data.skipUnbuyableAfterMinutes ?? undefined,
        skipUnbuyableForMinutes: parsed.data.skipUnbuyableForMinutes ?? undefined,
        maxMonitoredTokens: parsed.data.maxMonitoredTokens ?? undefined,
        updatedAt: new Date(),
      },
      create: {
        userId,
        botName: 'main-bot',
        tradingMode: parsed.data.tradingMode ?? 'PAPER',
        isLiveEnabled: parsed.data.isLiveEnabled ?? false,
        isScannerEnabled: parsed.data.isScannerEnabled ?? true,
        isPaperModeDefault: parsed.data.isPaperModeDefault ?? true,
        maxPositionSize: parsed.data.maxPositionSize,
        maxDailyLoss: parsed.data.maxDailyLoss,
        riskThreshold: parsed.data.riskThreshold,
        preferredQuoteCurrency: parsed.data.preferredQuoteCurrency ?? 'USDC',
        maxTokenAgeHours: parsed.data.maxTokenAgeHours ?? 168,
        maxMonitoredTokens: parsed.data.maxMonitoredTokens ?? 50,
        minLiquidityUsd: parsed.data.minLiquidityUsd,
        minVolumeUsd: parsed.data.minVolumeUsd,
      },
    });

    if (liveMutation.disableAuthorization) await logSafetyEvent('live_mode_disabled', userId, 'LIVE mode disabled through safe settings mutation');
    await logAuditEvent('settings_update', req.user?.id ?? null, { fields: Object.keys(parsed.data), botId: next.id });
    return res.json({ ok: true, data: await getUserSettingsView(userId) });
  } catch (error) {
    logger.error({ err: error }, 'Failed to update settings');
    return errorResponse(res, 500, 'Unable to update settings');
  }
});

app.patch('/api/settings', async (req, res) => {
  try {
    const parsed = settingsUpdateSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return errorResponse(res, 400, 'Invalid request body', parsed.error.issues);
    }

    const userId = req.user!.id;
    const liveMutation = await evaluateLiveSettingsMutation(userId, parsed.data.tradingMode, parsed.data.isLiveEnabled);
    if (liveMutation.blocked) return errorResponse(res, 403, 'LIVE mode cannot be enabled or changed through general settings', liveMutation.report);
    const next = await prisma.botConfig.upsert({
      where: { userId },
      update: {
        tradingMode: liveMutation.disableAuthorization && parsed.data.tradingMode === undefined ? 'PAPER' : parsed.data.tradingMode ?? undefined,
        isLiveEnabled: liveMutation.disableAuthorization ? false : parsed.data.isLiveEnabled ?? undefined,
        liveApprovalCompleted: liveMutation.disableAuthorization ? false : undefined,
        isPaperModeDefault: liveMutation.disableAuthorization ? true : parsed.data.isPaperModeDefault ?? undefined,
        status: liveMutation.disableAuthorization ? 'PAUSED' : undefined,
        isScannerEnabled: parsed.data.isScannerEnabled ?? undefined,
        maxPositionSize: parsed.data.maxPositionSize,
        maxDailyLoss: parsed.data.maxDailyLoss,
        riskThreshold: parsed.data.riskThreshold,
        preferredQuoteCurrency: parsed.data.preferredQuoteCurrency ?? undefined,
        maxTokenAgeHours: parsed.data.maxTokenAgeHours ?? undefined,
        minLiquidityUsd: parsed.data.minLiquidityUsd,
        minVolumeUsd: parsed.data.minVolumeUsd,
        skipUnbuyableAfterMinutes: parsed.data.skipUnbuyableAfterMinutes ?? undefined,
        skipUnbuyableForMinutes: parsed.data.skipUnbuyableForMinutes ?? undefined,
        maxMonitoredTokens: parsed.data.maxMonitoredTokens ?? undefined,
        updatedAt: new Date(),
      },
      create: {
        userId,
        botName: 'main-bot',
        tradingMode: parsed.data.tradingMode ?? 'PAPER',
        isLiveEnabled: parsed.data.isLiveEnabled ?? false,
        isScannerEnabled: parsed.data.isScannerEnabled ?? true,
        isPaperModeDefault: parsed.data.isPaperModeDefault ?? true,
        maxPositionSize: parsed.data.maxPositionSize,
        maxDailyLoss: parsed.data.maxDailyLoss,
        riskThreshold: parsed.data.riskThreshold,
        preferredQuoteCurrency: parsed.data.preferredQuoteCurrency ?? 'USDC',
        maxTokenAgeHours: parsed.data.maxTokenAgeHours ?? 168,
        maxMonitoredTokens: parsed.data.maxMonitoredTokens ?? 50,
        minLiquidityUsd: parsed.data.minLiquidityUsd,
        minVolumeUsd: parsed.data.minVolumeUsd,
      },
    });

    if (liveMutation.disableAuthorization) await logSafetyEvent('live_mode_disabled', userId, 'LIVE mode disabled through safe settings mutation');
    await logAuditEvent('user_settings_update', req.user?.id ?? null, { fields: Object.keys(parsed.data), botId: next.id });
    return res.json({ ok: true, data: await getUserSettingsView(userId) });
  } catch (error) {
    logger.error({ err: error }, 'Failed to update settings');
    return errorResponse(res, 500, 'Unable to update settings');
  }
});

app.get('/api/settings/risk', async (req, res) => {
  try {
    const { riskConfig } = await ensureUserSettings(req.user!.id);
    return res.json({
      ok: true,
      data: {
        riskPolicy: riskConfig.riskPolicy,
        lowRiskMax: riskConfig.lowRiskMax,
        moderateRiskMax: riskConfig.moderateRiskMax,
        highRiskMax: riskConfig.highRiskMax,
        veryHighRiskMax: riskConfig.veryHighRiskMax,
        lowPositionMultiplier: toNumber(riskConfig.lowPositionMultiplier),
        moderatePositionMultiplier: toNumber(riskConfig.moderatePositionMultiplier),
        highPositionMultiplier: toNumber(riskConfig.highPositionMultiplier),
        veryHighPositionMultiplier: toNumber(riskConfig.veryHighPositionMultiplier),
        aiAnalysisEnabled: riskConfig.aiAnalysisEnabled,
        aiRequiredForHighRisk: riskConfig.aiRequiredForHighRisk,
        aiRequiredForVeryHighRisk: riskConfig.aiRequiredForVeryHighRisk,
      aiProviderConfigured: AI_PROVIDER_CONFIGURED,
        maxPositionPercent: toNumber(riskConfig.maxPositionPercent),
        maxTotalExposurePercent: toNumber(riskConfig.maxTotalExposurePercent),
        maxConcurrentPositions: riskConfig.maxConcurrentPositions,
        dailyLossLimitPercent: toNumber(riskConfig.dailyLossLimitPercent),
        maxSlippagePercent: toNumber(riskConfig.maxSlippagePercent),
        minSignalScore: toNumber(riskConfig.minSignalScore),
        cooldownSeconds: riskConfig.cooldownSeconds,
        stopLossPercent: toNumber(riskConfig.stopLossPercent),
        takeProfitPercent: toNumber(riskConfig.takeProfitPercent),
        trailingStopPercent: toNumber(riskConfig.trailingStopPercent),
        trailingActivationPercent: toNumber(riskConfig.trailingActivationPercent),
        breakEvenActivationPercent: toNumber(riskConfig.breakEvenActivationPercent),
      },
    });
  } catch (error) {
    logger.error({ err: error }, 'Failed to fetch risk settings');
    return errorResponse(res, 500, 'Unable to fetch risk settings');
  }
});

// ---------- AI Token Analyzer: provider status and per-user AI settings ----------
// The provider is created from server-side env; only its name/model/status ever leave the server.
const aiProviderHandle = createAiProvider(process.env);
let aiHealthCache: { status: AiProviderStatus; at: number } | null = null;

export async function getAiProviderStatus(force = false): Promise<AiProviderStatus> {
  if (!aiProviderHandle.provider) return 'NOT_CONFIGURED';
  if (!force && aiHealthCache && Date.now() - aiHealthCache.at < 60_000) return aiHealthCache.status;
  const controller = new globalThis.AbortController();
  const timer = globalThis.setTimeout(() => controller.abort(), 8_000);
  const healthy = await aiProviderHandle.provider.healthCheck(controller.signal).catch(() => false).finally(() => globalThis.clearTimeout(timer));
  aiHealthCache = { status: healthy ? 'CONNECTED' : 'UNAVAILABLE', at: Date.now() };
  return aiHealthCache.status;
}

async function aiUsageToday(userId: string) {
  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);
  const [rows, cached] = await Promise.all([
    prisma.aiAnalysis.groupBy({ by: ['status'], where: { userId, createdAt: { gte: since } }, _count: { _all: true }, _avg: { latencyMs: true }, _sum: { inputTokens: true, outputTokens: true } }).catch(() => []),
    getRealtimeClient().then((client) => client.get(`ai:usage:${userId}:${since.toISOString().slice(0, 10)}:cached`)).catch(() => null),
  ]);
  const count = (status: string) => rows.find((row) => row.status === status)?._count._all ?? 0;
  const completed = rows.find((row) => row.status === 'COMPLETED');
  // Only attempts that actually reached a provider count as API calls (not 'provider not configured').
  const apiCalls = await prisma.aiAnalysis.count({ where: { userId, createdAt: { gte: since }, provider: { not: 'none' }, NOT: { errorMessage: 'AI provider is not configured' } } }).catch(() => 0);
  return {
    analyses: count('COMPLETED'),
    cacheHits: Number(cached ?? 0),
    apiCalls,
    failed: count('FAILED'),
    invalid: count('INVALID'),
    averageLatencyMs: completed?._avg.latencyMs ?? null,
    inputTokens: rows.reduce((total, row) => total + (row._sum.inputTokens ?? 0), 0) || null,
    outputTokens: rows.reduce((total, row) => total + (row._sum.outputTokens ?? 0), 0) || null,
  };
}

async function serializeAiSettings(userId: string) {
  const row = await prisma.aiConfig.findUnique({ where: { userId } });
  const settings = row ? {
    aiAnalysisEnabled: row.aiAnalysisEnabled, aiMinimumConfidence: row.aiMinimumConfidence, aiRecheckSeconds: row.aiRecheckSeconds,
    aiMaxAnalysesPerMinute: row.aiMaxAnalysesPerMinute, aiAllowHighRisk: row.aiAllowHighRisk, aiAllowVeryHighRisk: row.aiAllowVeryHighRisk,
    aiDynamicExitSuggestionsEnabled: row.aiDynamicExitSuggestionsEnabled, aiDecisionTtlSeconds: row.aiDecisionTtlSeconds, aiUseExitParameters: row.aiUseExitParameters,
  } : { ...DEFAULT_AI_USER_SETTINGS };
  return {
    ...settings,
    decisionMode: settings.aiAnalysisEnabled ? 'AI' : 'STRATEGY',
    provider: { name: aiProviderHandle.info.provider, model: aiProviderHandle.info.model, status: await getAiProviderStatus(), promptVersion: AI_PROMPT_VERSION },
    usageToday: await aiUsageToday(userId),
  };
}

app.get('/api/settings/ai', async (req, res) => {
  try {
    return res.json({ ok: true, data: await serializeAiSettings(req.user!.id) });
  } catch (error) {
    logger.error({ err: error }, 'Failed to load AI settings');
    return errorResponse(res, 500, 'Unable to load AI settings');
  }
});

app.put('/api/settings/ai', async (req, res) => {
  try {
    const parsed = aiSettingsSchema.safeParse(req.body ?? {});
    if (!parsed.success) return errorResponse(res, 400, 'Érvénytelen AI-beállítás', parsed.error.issues);
    const userId = req.user!.id;
    const current = await prisma.aiConfig.findUnique({ where: { userId } });
    const enabling = parsed.data.aiAnalysisEnabled === true && !current?.aiAnalysisEnabled;
    if (enabling) {
      // AI mode is never switched on without a working, server-side configured provider.
      const status = await getAiProviderStatus(true);
      if (status === 'NOT_CONFIGURED') return errorResponse(res, 400, 'Az AI szolgáltató nincs konfigurálva. Állíts be érvényes szerveroldali AI API-kulcsot.');
      if (status !== 'CONNECTED') return errorResponse(res, 409, 'Az AI szolgáltató nem elérhető, ezért az AI mód most nem kapcsolható be.');
    }
    await prisma.aiConfig.upsert({ where: { userId }, update: parsed.data, create: { userId, ...parsed.data } });
    const modeChanged = parsed.data.aiAnalysisEnabled !== undefined && parsed.data.aiAnalysisEnabled !== (current?.aiAnalysisEnabled ?? false);
    await logAuditEvent(modeChanged ? 'ai_mode_changed' : 'ai_settings_update', userId, {
      fields: Object.keys(parsed.data),
      ...(modeChanged ? { from: current?.aiAnalysisEnabled ? 'AI' : 'STRATEGY', to: parsed.data.aiAnalysisEnabled ? 'AI' : 'STRATEGY' } : {}),
    });
    if (modeChanged) await publishRealtime('bot:events', { type: 'decision_mode_changed', userId, decisionMode: parsed.data.aiAnalysisEnabled ? 'AI' : 'STRATEGY', at: new Date().toISOString() });
    return res.json({ ok: true, data: await serializeAiSettings(userId) });
  } catch (error) {
    logger.error({ err: error }, 'Failed to save AI settings');
    return errorResponse(res, 500, 'Unable to save AI settings');
  }
});

/** Latest AI analysis of a token for this user (+ when the worker may analyse it again). */
async function latestAiAnalysis(userId: string, tokenId: string, tokenAddress: string) {
  const row = await prisma.aiAnalysis.findFirst({ where: { userId, tokenId }, orderBy: { createdAt: 'desc' } }).catch(() => null);
  if (!row) return null;
  const state = await getRealtimeClient().then((client) => client.get(`ai:state:${userId}:${tokenAddress}`)).catch(() => null);
  let nextAnalysisAt: string | null = null;
  try {
    nextAnalysisAt = state ? new Date((JSON.parse(state) as { nextEligibleAt: number }).nextEligibleAt).toISOString() : null;
  } catch {
    nextAnalysisAt = null;
  }
  return {
    id: row.id, status: row.status, provider: row.provider, model: row.model, promptVersion: row.promptVersion,
    rawDecision: row.rawDecision, effectiveDecision: row.effectiveDecision, effectiveReason: row.effectiveReason,
    confidence: toNumber(row.confidence), entryQuality: toNumber(row.entryQuality), marketStrength: toNumber(row.marketStrength),
    momentumQuality: toNumber(row.momentumQuality), liquidityQuality: toNumber(row.liquidityQuality), timingQuality: toNumber(row.timingQuality),
    exhaustionRisk: toNumber(row.exhaustionRisk), recommendedPositionMultiplier: toNumber(row.recommendedPositionMultiplier),
    suggestedStopLossPercent: toNumber(row.suggestedStopLossPercent), suggestedTakeProfitPercent: toNumber(row.suggestedTakeProfitPercent),
    suggestedTrailingActivationPercent: toNumber(row.suggestedTrailingActivationPercent), suggestedTrailingDistancePercent: toNumber(row.suggestedTrailingDistancePercent),
    reasons: row.reasons, warnings: row.warnings, latencyMs: row.latencyMs, createdAt: row.createdAt, expiresAt: row.expiresAt, nextAnalysisAt,
  };
}

function serializeAdvancedSettings(row: Parameters<typeof resolveAdvancedSettings>[0]) {
  return { ...resolveAdvancedSettings(row), requiredHistoryMinutes: REQUIRED_HISTORY_MINUTES, defaults: DEFAULT_ADVANCED_SETTINGS, persisted: Boolean(row) };
}

app.get('/api/settings/advanced-strategies', async (req, res) => {
  try {
    const row = await prisma.advancedStrategyConfig.findUnique({ where: { userId: req.user!.id } });
    return res.json({ ok: true, data: serializeAdvancedSettings(row as Parameters<typeof resolveAdvancedSettings>[0]) });
  } catch (error) {
    logger.error({ err: error }, 'Failed to load advanced strategy settings');
    return errorResponse(res, 500, 'Unable to load advanced strategy settings');
  }
});

app.put('/api/settings/advanced-strategies', async (req, res) => {
  try {
    const parsed = advancedStrategySettingsSchema.safeParse(req.body ?? {});
    if (!parsed.success) return errorResponse(res, 400, 'Érvénytelen stratégia-beállítás', parsed.error.issues);
    const userId = req.user!.id;
    const current = await prisma.advancedStrategyConfig.findUnique({ where: { userId } });
    // Module settings are merged per module, so a partial update never wipes other modules' values.
    const currentModules = (current?.modules ?? {}) as Record<string, Record<string, unknown>>;
    const modules = { ...currentModules };
    for (const [name, value] of Object.entries(parsed.data.modules ?? {})) modules[name] = { ...(currentModules[name] ?? {}), ...value };
    const scalars: Partial<typeof parsed.data> = { ...parsed.data };
    delete scalars.modules;
    const merged = resolveAdvancedSettings({ ...(current ?? {}), ...scalars, modules } as Parameters<typeof resolveAdvancedSettings>[0]);
    if (merged.exhaustionWarningThreshold > merged.exhaustionStrongWarningThreshold || merged.exhaustionStrongWarningThreshold > merged.exhaustionBlockThreshold) {
      return errorResponse(res, 400, 'A kifáradási küszöbök sorrendje: figyelmeztetés ≤ erős figyelmeztetés ≤ tiltás.');
    }
    const data = {
      compositeEnabled: merged.compositeEnabled,
      minimumConfirmations: merged.minimumConfirmations,
      minimumCompositeScore: merged.minimumCompositeScore,
      penalizeUnavailable: merged.penalizeUnavailable,
      exhaustionEnabled: merged.exhaustionEnabled,
      exhaustionWarningThreshold: merged.exhaustionWarningThreshold,
      exhaustionStrongWarningThreshold: merged.exhaustionStrongWarningThreshold,
      exhaustionBlockThreshold: merged.exhaustionBlockThreshold,
      exhaustionPolicy: merged.exhaustionPolicy,
      exhaustionPenaltyWeight: new Prisma.Decimal(merged.exhaustionPenaltyWeight),
      liquidityOutflowExitEnabled: merged.liquidityOutflowExitEnabled,
      liquidityOutflowExitPercent: new Prisma.Decimal(merged.liquidityOutflowExitPercent),
      modules: merged.modules as unknown as Prisma.InputJsonValue,
    };
    const row = await prisma.advancedStrategyConfig.upsert({ where: { userId }, update: data, create: { userId, ...data } });
    await logAuditEvent('advanced_strategy_settings_update', userId, { fields: Object.keys(parsed.data), modules: Object.keys(parsed.data.modules ?? {}) });
    return res.json({ ok: true, data: serializeAdvancedSettings(row as Parameters<typeof resolveAdvancedSettings>[0]) });
  } catch (error) {
    logger.error({ err: error }, 'Failed to save advanced strategy settings');
    return errorResponse(res, 500, 'Unable to save advanced strategy settings');
  }
});

app.patch('/api/settings/risk', async (req, res) => {
  try {
    const parsed = settingsRiskUpdateSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return errorResponse(res, 400, 'Invalid risk settings payload', parsed.error.issues);
    }

    const currentRisk = await prisma.riskConfig.findUnique({ where: { userId: req.user!.id } });
    const aiEnabled = parsed.data.aiAnalysisEnabled ?? currentRisk?.aiAnalysisEnabled ?? false;
    const aiRequiredForHigh = parsed.data.aiRequiredForHighRisk ?? currentRisk?.aiRequiredForHighRisk ?? false;
    const aiRequiredForVeryHigh = parsed.data.aiRequiredForVeryHighRisk ?? currentRisk?.aiRequiredForVeryHighRisk ?? false;
    const aiRequired = aiRequiredForHigh || aiRequiredForVeryHigh;
    // Without an AI analyst an "AI required" rule can never pass and silently rejects every HIGH/VERY_HIGH
    // trade, so it cannot be switched on; switching it off is always allowed.
    const enablingAi = (parsed.data.aiAnalysisEnabled === true && !currentRisk?.aiAnalysisEnabled)
      || (parsed.data.aiRequiredForHighRisk === true && !currentRisk?.aiRequiredForHighRisk)
      || (parsed.data.aiRequiredForVeryHighRisk === true && !currentRisk?.aiRequiredForVeryHighRisk);
    if (!AI_PROVIDER_CONFIGURED && enablingAi) {
      return errorResponse(res, 400, 'Nincs AI-elemző szolgáltató bekötve, ezért az AI-elemzés nem kapcsolható be.');
    }
    if (aiRequired && !aiEnabled) {
      return errorResponse(res, 400, 'AI analysis must be enabled when it is required for a risk class');
    }
    const thresholds = [
      parsed.data.lowRiskMax ?? currentRisk?.lowRiskMax ?? 30,
      parsed.data.moderateRiskMax ?? currentRisk?.moderateRiskMax ?? 50,
      parsed.data.highRiskMax ?? currentRisk?.highRiskMax ?? 70,
      parsed.data.veryHighRiskMax ?? currentRisk?.veryHighRiskMax ?? 85,
    ];
    if (thresholds.some((threshold, index) => index > 0 && threshold <= thresholds[index - 1])) {
      return errorResponse(res, 400, 'Risk classification thresholds must be strictly increasing');
    }

    const riskConfig = await prisma.riskConfig.upsert({
      where: { userId: req.user!.id },
      update: {
        riskPolicy: parsed.data.riskPolicy ?? undefined,
        lowRiskMax: parsed.data.lowRiskMax ?? undefined,
        moderateRiskMax: parsed.data.moderateRiskMax ?? undefined,
        highRiskMax: parsed.data.highRiskMax ?? undefined,
        veryHighRiskMax: parsed.data.veryHighRiskMax ?? undefined,
        lowPositionMultiplier: parsed.data.lowPositionMultiplier ?? undefined,
        moderatePositionMultiplier: parsed.data.moderatePositionMultiplier ?? undefined,
        highPositionMultiplier: parsed.data.highPositionMultiplier ?? undefined,
        veryHighPositionMultiplier: parsed.data.veryHighPositionMultiplier ?? undefined,
        aiAnalysisEnabled: parsed.data.aiAnalysisEnabled ?? undefined,
        aiRequiredForHighRisk: parsed.data.aiRequiredForHighRisk ?? undefined,
        aiRequiredForVeryHighRisk: parsed.data.aiRequiredForVeryHighRisk ?? undefined,
        allowManualPaperWatchBuy: parsed.data.allowManualPaperWatchBuy ?? undefined,
        maxPositionPercent: parsed.data.maxPositionPercent,
        maxTotalExposurePercent: parsed.data.maxTotalExposurePercent,
        maxConcurrentPositions: parsed.data.maxConcurrentPositions ?? undefined,
        dailyLossLimitPercent: parsed.data.dailyLossLimitPercent,
        maxSlippagePercent: parsed.data.maxSlippagePercent,
        minSignalScore: parsed.data.minSignalScore,
        cooldownSeconds: parsed.data.cooldownSeconds ?? undefined,
        stopLossPercent: parsed.data.stopLossPercent,
        takeProfitPercent: parsed.data.takeProfitPercent,
        trailingStopPercent: parsed.data.trailingStopPercent,
        trailingActivationPercent: parsed.data.trailingActivationPercent,
        breakEvenActivationPercent: parsed.data.breakEvenActivationPercent,
        updatedAt: new Date(),
      },
      create: {
        userId: req.user!.id,
        maxPositionPercent: parsed.data.maxPositionPercent !== undefined ? Number(parsed.data.maxPositionPercent) : 10,
        maxTotalExposurePercent: parsed.data.maxTotalExposurePercent !== undefined ? Number(parsed.data.maxTotalExposurePercent) : 25,
        maxConcurrentPositions: parsed.data.maxConcurrentPositions ?? 3,
        dailyLossLimitPercent: parsed.data.dailyLossLimitPercent !== undefined ? Number(parsed.data.dailyLossLimitPercent) : 5,
        maxSlippagePercent: parsed.data.maxSlippagePercent !== undefined ? Number(parsed.data.maxSlippagePercent) : 1,
        minSignalScore: parsed.data.minSignalScore !== undefined ? Number(parsed.data.minSignalScore) : 60,
        cooldownSeconds: parsed.data.cooldownSeconds ?? 60,
        stopLossPercent: parsed.data.stopLossPercent !== undefined ? Number(parsed.data.stopLossPercent) : 2,
        takeProfitPercent: parsed.data.takeProfitPercent !== undefined ? Number(parsed.data.takeProfitPercent) : 4,
        trailingStopPercent: parsed.data.trailingStopPercent !== undefined ? Number(parsed.data.trailingStopPercent) : 1,
        // New accounts: trailing arms only after +15% (profit protection, not a second stop loss).
        trailingActivationPercent: parsed.data.trailingActivationPercent !== undefined ? parsed.data.trailingActivationPercent : 15,
        breakEvenActivationPercent: parsed.data.breakEvenActivationPercent ?? null,
      },
    });

    await logAuditEvent('risk_settings_update', req.user!.id, { fields: Object.keys(parsed.data) });
    return res.json({ ok: true, data: {
      riskPolicy: riskConfig.riskPolicy,
      lowRiskMax: riskConfig.lowRiskMax,
      moderateRiskMax: riskConfig.moderateRiskMax,
      highRiskMax: riskConfig.highRiskMax,
      veryHighRiskMax: riskConfig.veryHighRiskMax,
      lowPositionMultiplier: toNumber(riskConfig.lowPositionMultiplier),
      moderatePositionMultiplier: toNumber(riskConfig.moderatePositionMultiplier),
      highPositionMultiplier: toNumber(riskConfig.highPositionMultiplier),
      veryHighPositionMultiplier: toNumber(riskConfig.veryHighPositionMultiplier),
      aiAnalysisEnabled: riskConfig.aiAnalysisEnabled,
      aiRequiredForHighRisk: riskConfig.aiRequiredForHighRisk,
      aiRequiredForVeryHighRisk: riskConfig.aiRequiredForVeryHighRisk,
      aiProviderConfigured: AI_PROVIDER_CONFIGURED,
      allowManualPaperWatchBuy: riskConfig.allowManualPaperWatchBuy,
      maxPositionPercent: toNumber(riskConfig.maxPositionPercent),
      maxTotalExposurePercent: toNumber(riskConfig.maxTotalExposurePercent),
      maxConcurrentPositions: riskConfig.maxConcurrentPositions,
      dailyLossLimitPercent: toNumber(riskConfig.dailyLossLimitPercent),
      maxSlippagePercent: toNumber(riskConfig.maxSlippagePercent),
      minSignalScore: toNumber(riskConfig.minSignalScore),
      cooldownSeconds: riskConfig.cooldownSeconds,
      stopLossPercent: toNumber(riskConfig.stopLossPercent),
      takeProfitPercent: toNumber(riskConfig.takeProfitPercent),
      trailingStopPercent: toNumber(riskConfig.trailingStopPercent),
      trailingActivationPercent: toNumber(riskConfig.trailingActivationPercent),
      breakEvenActivationPercent: toNumber(riskConfig.breakEvenActivationPercent),
    } });
  } catch (error) {
    logger.error({ err: error }, 'Failed to update risk settings');
    return errorResponse(res, 500, 'Unable to update risk settings');
  }
});

app.get('/api/settings/strategies', async (req, res) => {
  try {
    const strategies = await prisma.strategyConfig.findMany({
      where: { userId: req.user!.id },
      orderBy: { strategyName: 'asc' },
    });

    return res.json({ ok: true, data: serializeStrategySettings(strategies) });
  } catch (error) {
    logger.error({ err: error }, 'Failed to fetch strategy settings');
    return errorResponse(res, 500, 'Unable to fetch strategy settings');
  }
});

app.patch('/api/settings/strategies/:name', async (req, res) => {
  try {
    const parsed = settingsStrategyUpdateSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return errorResponse(res, 400, 'Invalid strategy settings payload', parsed.error.issues);
    }

    const strategyName = (req.params.name || '').trim();
    if (!isConfigurableStrategyName(strategyName)) {
      return errorResponse(res, 404, `Unknown strategy. Available strategies: ${CONFIGURABLE_STRATEGY_NAMES.join(', ')}`);
    }

    // Only the strategy's known numeric parameters are accepted; anything else is rejected, not silently stored.
    const defaults = STRATEGY_PARAMETER_DEFAULTS[strategyName];
    const incoming = parsed.data.params ?? {};
    const invalidKeys = Object.entries(incoming)
      .filter(([key, value]) => !(key in defaults) || typeof value !== 'number' || !Number.isFinite(value) || value < 0)
      .map(([key]) => key);
    if (invalidKeys.length > 0) {
      return errorResponse(res, 400, `Invalid strategy parameters: ${invalidKeys.join(', ')}`);
    }
    const current = await prisma.strategyConfig.findUnique({ where: { userId_strategyName: { userId: req.user!.id, strategyName } } });
    const mergedParams = { ...storedStrategyParams(current?.params), ...incoming } as Prisma.InputJsonValue;

    const strategy = await prisma.strategyConfig.upsert({
      where: { userId_strategyName: { userId: req.user!.id, strategyName } },
      update: {
        isEnabled: parsed.data.isEnabled ?? undefined,
        params: parsed.data.params ? mergedParams : undefined,
        updatedAt: new Date(),
      },
      create: {
        userId: req.user!.id,
        strategyName,
        isEnabled: parsed.data.isEnabled ?? false,
        params: mergedParams,
      },
    });

    await logAuditEvent('strategy_settings_update', req.user!.id, { strategyName, fields: Object.keys(parsed.data), isEnabled: strategy.isEnabled });
    return res.json({ ok: true, data: { name: strategy.strategyName, ...serializeStrategySettings([strategy])[strategyName] } });
  } catch (error) {
    logger.error({ err: error }, 'Failed to update strategy settings');
    return errorResponse(res, 500, 'Unable to update strategy settings');
  }
});

const validSolanaNetwork = new Set(['mainnet-beta', 'testnet', 'devnet', 'solana']);

function normalizeWalletAddress(value: string | undefined) {
  if (!value) return null;
  const address = value.trim();
  if (!address || !/^[1-9A-HJ-NP-Za-km-z]+$/.test(address) || address.length < 32 || address.length > 44) {
    return null;
  }
  return address;
}

function normalizeWalletNetwork(value: string | undefined) {
  const network = (value ?? 'mainnet-beta').trim();
  return validSolanaNetwork.has(network) ? network : null;
}

function serializeWallet(wallet: { id: string; type: 'USER' | 'BOT_TRADING'; publicAddress: string; network: string; label: string | null; provider: string | null; isActive: boolean; lastBalance: Prisma.Decimal | number | string | null; lastBalanceAt: Date | string | null; createdAt: Date; updatedAt: Date; userId: string; }) {
  const lastBalance = wallet.lastBalance == null ? null : typeof wallet.lastBalance === 'number' ? wallet.lastBalance : Number(wallet.lastBalance.toString());
  return {
    id: wallet.id,
    userId: wallet.userId,
    type: wallet.type,
    publicAddress: wallet.publicAddress,
    network: wallet.network,
    label: wallet.label ?? (wallet.type === 'BOT_TRADING' ? 'Bot trading wallet' : 'User wallet'),
    provider: wallet.provider ?? 'PHANTOM',
    isActive: wallet.isActive,
    status: wallet.isActive ? 'CONNECTED' : 'DISCONNECTED',
    lastBalance,
    lastBalanceAt: wallet.lastBalanceAt ? new Date(wallet.lastBalanceAt).toISOString() : null,
    connected: wallet.isActive,
    configured: wallet.isActive,
    createdAt: wallet.createdAt.toISOString(),
    updatedAt: wallet.updatedAt.toISOString(),
  };
}

app.get('/api/settings/wallet', async (req, res) => {
  try {
    const wallets = await prisma.wallet.findMany({
      where: { userId: req.user!.id },
      orderBy: { createdAt: 'desc' },
    });

    const userWallet = wallets.find((wallet) => wallet.type === 'USER' && wallet.isActive) ?? null;
    const botTradingWallet = wallets.find((wallet) => wallet.type === 'BOT_TRADING' && wallet.isActive) ?? null;
    const botConfig = await prisma.botConfig.findUnique({ where: { userId: req.user!.id } });
    const fallbackBotAddress = botConfig?.botTradingWalletAddress || null;

    return res.json({
      ok: true,
      data: {
        userWallet: userWallet ? serializeWallet(userWallet) : {
          id: null,
          type: 'USER',
          publicAddress: null,
          network: 'mainnet-beta',
          label: 'User wallet',
          provider: null,
          isActive: false,
          status: 'DISCONNECTED',
          connected: false,
          configured: false,
          lastBalance: null,
          lastBalanceAt: null,
        },
        botTradingWallet: botTradingWallet ? serializeWallet(botTradingWallet) : {
          id: null,
          type: 'BOT_TRADING',
          publicAddress: fallbackBotAddress,
          network: botConfig?.tradingMode ? 'mainnet-beta' : 'mainnet-beta',
          label: 'Bot trading wallet',
          provider: null,
          isActive: false,
          status: 'NOT_CONFIGURED',
          connected: false,
          configured: !!fallbackBotAddress,
          lastBalance: null,
          lastBalanceAt: null,
        },
        wallets: wallets.map((wallet) => serializeWallet(wallet)),
      },
    });
  } catch (error) {
    logger.error({ err: error }, 'Failed to fetch wallet settings');
    return errorResponse(res, 500, 'Unable to fetch wallet settings');
  }
});

const walletChallenges = new WalletChallengeStore();

function walletRpcUrl(network: string) {
  return rpcUrlForNetwork(network, env.SOLANA_PRIMARY_RPC_URL || env.SOLANA_RPC_URL || undefined);
}

/** Reads the native SOL balance of one of the user's wallets and stores it on the wallet row. */
async function refreshWalletBalance(walletId: string, userId: string) {
  const wallet = await prisma.wallet.findFirst({ where: { id: walletId, userId } });
  if (!wallet) return null;
  const balance = await fetchSolBalance(walletRpcUrl(wallet.network), wallet.publicAddress, env.SOLANA_RPC_TIMEOUT_MS);
  return prisma.wallet.update({
    where: { id: wallet.id, userId },
    data: { lastBalance: new Prisma.Decimal(balance.toFixed(8)), lastBalanceAt: new Date() },
  });
}

app.post('/api/settings/wallet/challenge', async (req, res) => {
  try {
    const parsed = walletChallengeSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return errorResponse(res, 400, 'Invalid wallet challenge payload', parsed.error.issues);
    }
    if (!decodeSolanaPublicKey(parsed.data.publicAddress)) {
      return errorResponse(res, 400, 'Not a valid Solana public key');
    }
    const challenge = walletChallenges.issue(req.user!.id, req.user!.email, parsed.data.publicAddress, parsed.data.network);
    return res.json({ ok: true, data: challenge });
  } catch (error) {
    logger.error({ err: error }, 'Failed to issue wallet challenge');
    return errorResponse(res, 500, 'Unable to start wallet verification');
  }
});

app.post('/api/settings/wallet/connect', async (req, res) => {
  try {
    const parsed = walletConnectSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return errorResponse(res, 400, 'Invalid wallet connection payload', parsed.error.issues);
    }

    const userId = req.user!.id;
    const type = parsed.data.type ?? 'USER';
    const publicAddress = normalizeWalletAddress(parsed.data.publicAddress ?? parsed.data.address);
    let network = normalizeWalletNetwork(parsed.data.network);
    const publicKey = publicAddress ? decodeSolanaPublicKey(publicAddress) : null;
    if (!publicAddress || !network || !publicKey) {
      return errorResponse(res, 400, 'Wallet address and network are required and must be valid Solana values');
    }

    if (type === 'BOT_TRADING') {
      // The bot wallet is registered by its public address only; its signing secret stays in server-side secret management.
      if (req.user!.role !== 'ADMIN') return errorResponse(res, 403, 'Administrator authorization required');
    } else {
      // A user wallet is only linked after the wallet proves ownership by signing a one-time challenge.
      if (!parsed.data.nonce || !parsed.data.signature) {
        return errorResponse(res, 400, 'Wallet ownership proof is required: request a challenge and sign it with the wallet');
      }
      const challenge = walletChallenges.consume(userId, publicAddress, parsed.data.nonce);
      if (!challenge) return errorResponse(res, 400, 'The wallet verification challenge expired or is unknown. Please try again.');
      const signature = decodeSignature(parsed.data.signature);
      if (!signature || !verifyEd25519Signature(publicKey, Buffer.from(challenge.message, 'utf8'), signature)) {
        await logAuditEvent('wallet_verification_failed', userId, { type, publicAddress });
        return errorResponse(res, 401, 'Wallet signature verification failed');
      }
      network = challenge.network;
    }

    const provider = parsed.data.provider ?? parsed.data.walletType ?? 'PHANTOM';
    const label = parsed.data.label ?? (type === 'BOT_TRADING' ? 'Bot trading wallet' : 'User wallet');
    const existingWallet = await prisma.wallet.findUnique({
      where: { userId_publicAddress: { userId, publicAddress } },
    });
    if (existingWallet && existingWallet.type !== type && existingWallet.isActive) {
      return errorResponse(res, 409, `This address is already linked as the active ${existingWallet.type === 'BOT_TRADING' ? 'bot trading' : 'user'} wallet`);
    }

    const wallet = await prisma.$transaction(async (transaction) => {
      // Exactly one active wallet per type: the previous one is deactivated, never deleted.
      await transaction.wallet.updateMany({
        where: { userId, type, isActive: true, NOT: { publicAddress } },
        data: { isActive: false, updatedAt: new Date() },
      });
      return existingWallet
        ? transaction.wallet.update({
            where: { id: existingWallet.id, userId },
            data: { type, network, label, provider, isActive: true, updatedAt: new Date() },
          })
        : transaction.wallet.create({
            data: { userId, type, publicAddress, network, label, provider, isActive: true, lastBalance: null, lastBalanceAt: null },
          });
    });

    if (type === 'BOT_TRADING') {
      await prisma.botConfig.upsert({
        where: { userId },
        update: { botTradingWalletAddress: publicAddress, updatedAt: new Date() },
        create: {
          userId,
          botName: 'main-bot',
          tradingMode: 'PAPER',
          isLiveEnabled: false,
          isScannerEnabled: true,
          isPaperModeDefault: true,
          preferredQuoteCurrency: 'USDC',
          maxTokenAgeHours: 168,
          botTradingWalletAddress: publicAddress,
        },
      });
      await logAuditEvent('bot_wallet_configured', userId, { type, publicAddress, network, label });
    } else {
      await logAuditEvent('wallet_connected', userId, { type, publicAddress, network, label, provider, ownershipVerified: true });
    }

    // Balance lookup is best-effort: a slow or failing RPC must not fail the link itself.
    const withBalance = env.NODE_ENV === 'test'
      ? wallet
      : await refreshWalletBalance(wallet.id, userId).catch((error: unknown) => {
          logger.warn({ err: error, walletId: wallet.id }, 'Wallet balance refresh failed');
          return wallet;
        });
    return res.json({ ok: true, data: serializeWallet(withBalance ?? wallet) });
  } catch (error) {
    logger.error({ err: error }, 'Failed to connect wallet');
    return errorResponse(res, 500, 'Unable to connect wallet');
  }
});

app.post('/api/settings/wallet/refresh-balance', async (req, res) => {
  try {
    const userId = req.user!.id;
    const wallets = await prisma.wallet.findMany({ where: { userId, isActive: true } });
    const results = await Promise.all(wallets.map(async (wallet) => {
      try {
        const updated = await refreshWalletBalance(wallet.id, userId);
        return { id: wallet.id, type: wallet.type, ok: true, lastBalance: updated?.lastBalance == null ? null : Number(updated.lastBalance) };
      } catch (error) {
        logger.warn({ err: error, walletId: wallet.id }, 'Wallet balance refresh failed');
        return { id: wallet.id, type: wallet.type, ok: false, error: 'RPC balance lookup failed' };
      }
    }));
    return res.json({ ok: true, data: results });
  } catch (error) {
    logger.error({ err: error }, 'Failed to refresh wallet balances');
    return errorResponse(res, 500, 'Unable to refresh wallet balances');
  }
});

async function disconnectWallet(req: Request, res: Response) {
  try {
    const parsed = walletDisconnectSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return errorResponse(res, 400, 'Invalid disconnect payload', parsed.error.issues);
    }

    const userId = req.user!.id;
    const targetType = parsed.data.type ?? 'USER';
    if (targetType === 'BOT_TRADING' && req.user!.role !== 'ADMIN') {
      return errorResponse(res, 403, 'Administrator authorization required');
    }
    const publicAddress = normalizeWalletAddress(parsed.data.publicAddress ?? parsed.data.address);

    const wallet = await prisma.wallet.findFirst({
      where: {
        userId,
        type: targetType,
        ...(publicAddress ? { publicAddress } : { isActive: true }),
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!wallet) {
      return errorResponse(res, 404, 'Wallet not found for this user');
    }

    const updatedWallet = await prisma.wallet.update({
      where: { id: wallet.id, userId },
      data: { isActive: false, updatedAt: new Date() },
    });

    if (targetType === 'BOT_TRADING') {
      await prisma.botConfig.updateMany({
        where: { userId, botTradingWalletAddress: updatedWallet.publicAddress },
        data: { botTradingWalletAddress: null, updatedAt: new Date() },
      });
      await logAuditEvent('bot_wallet_disabled', userId, { type: targetType, publicAddress: updatedWallet.publicAddress });
    } else {
      await logAuditEvent('wallet_disconnected', userId, { type: targetType, publicAddress: updatedWallet.publicAddress });
    }

    return res.json({ ok: true, data: { ...serializeWallet(updatedWallet), status: 'DISCONNECTED' } });
  } catch (error) {
    logger.error({ err: error }, 'Failed to disconnect wallet');
    return errorResponse(res, 500, 'Unable to disconnect wallet');
  }
}

app.post('/api/settings/wallet/disconnect', disconnectWallet);
app.delete('/api/settings/wallet/disconnect', disconnectWallet);

app.get('/api/settings/notifications', async (req, res) => {
  try {
    const { notificationConfig } = await ensureUserSettings(req.user!.id);
    return res.json({ ok: true, data: {
      telegramEnabled: notificationConfig.telegramEnabled,
      telegramChatId: notificationConfig.telegramChatId,
      emailAlerts: notificationConfig.emailAlerts,
      pushAlerts: notificationConfig.pushAlerts,
    } });
  } catch (error) {
    logger.error({ err: error }, 'Failed to fetch notification settings');
    return errorResponse(res, 500, 'Unable to fetch notification settings');
  }
});

app.patch('/api/settings/notifications', async (req, res) => {
  try {
    const parsed = settingsNotificationUpdateSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return errorResponse(res, 400, 'Invalid notification settings payload', parsed.error.issues);
    }

    const notificationConfig = await prisma.notificationConfig.upsert({
      where: { userId: req.user!.id },
      update: {
        telegramEnabled: parsed.data.telegramEnabled ?? undefined,
        // The chat id is only set by the verified Telegram link flow (/api/settings/telegram/link).
        emailAlerts: parsed.data.emailAlerts ?? undefined,
        pushAlerts: parsed.data.pushAlerts ?? undefined,
        updatedAt: new Date(),
      },
      create: {
        userId: req.user!.id,
        telegramEnabled: parsed.data.telegramEnabled ?? false,
        telegramChatId: null,
        emailAlerts: parsed.data.emailAlerts ?? false,
        pushAlerts: parsed.data.pushAlerts ?? false,
      },
    });

    await logAuditEvent('notification_settings_update', req.user!.id, { fields: Object.keys(parsed.data) });
    return res.json({ ok: true, data: {
      telegramEnabled: notificationConfig.telegramEnabled,
      telegramChatId: notificationConfig.telegramChatId,
      emailAlerts: notificationConfig.emailAlerts,
      pushAlerts: notificationConfig.pushAlerts,
    } });
  } catch (error) {
    logger.error({ err: error }, 'Failed to update notification settings');
    return errorResponse(res, 500, 'Unable to update notification settings');
  }
});

app.get('/api/positions', async (req, res) => {
  try {
    const query = paginationSchema.extend({ status: z.enum(['OPEN', 'CLOSED']).optional() }).parse(req.query);
    const include = { token: { select: { address: true, symbol: true } }, pathMetric: { select: { lastLiquidityUsd: true } }, trades: { orderBy: { createdAt: 'asc' as const }, take: 1, select: { decisionSource: true, strategyName: true, riskClassification: true, riskScore: true, size: true, netPnl: true } } };
    // Every OPEN position is always returned (an old open position must never fall off the list because of newer
    // closed ones); limit / offset page through the closed history.
    const [open, closed] = await Promise.all([
      query.status === 'CLOSED' ? Promise.resolve([]) : prisma.position.findMany({ where: { userId: req.user!.id, status: 'OPEN' }, take: 500, orderBy: { openedAt: 'desc' }, include }).catch(() => []),
      query.status === 'OPEN' ? Promise.resolve([]) : prisma.position.findMany({ where: { userId: req.user!.id, status: { not: 'OPEN' } }, take: query.limit, skip: query.offset, orderBy: { openedAt: 'desc' }, include }).catch(() => []),
    ]);
    const positions = [...open, ...closed];

    return res.json({ ok: true, data: positions.map(({ token, trades, pathMetric, ...position }) => {
      const levels = describeExitLevels(persistedExitState(position), toNumber(position.currentPrice));
      return redactSensitiveFields({
        ...position, symbol: token.symbol, tokenAddress: token.address,
        ...(position.status === 'OPEN' ? closeNowEstimate(position, toNumber(pathMetric?.lastLiquidityUsd)) : {}),
        decisionSource: positionDecisionSource(trades[0]), strategyName: trades[0]?.strategyName ?? null,
        riskClassification: trades[0]?.riskClassification ?? null, riskScore: toNumber(trades[0]?.riskScore), invested: toNumber(trades[0]?.size),
        exitSummary: {
          stopLossPercent: levels.stopLoss?.percentFromEntry ?? null, takeProfitPercent: levels.takeProfit?.percentFromEntry ?? null,
          trailingStatus: levels.trailing.status, trailingTriggerPrice: levels.trailing.triggerPrice, trailingActivationPercent: levels.trailing.activationPercent,
          breakEvenStatus: levels.breakEven.status,
        },
      });
    }) });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return errorResponse(res, 400, 'Invalid query parameters', error.issues);
    }

    logger.error({ err: error }, 'Failed to fetch positions');
    return errorResponse(res, 500, 'Unable to fetch positions');
  }
});

app.post('/api/positions/:id/close', async (req, res) => {
  try {
    const parsed = closePositionSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return errorResponse(res, 400, 'Invalid request body', parsed.error.issues);
    }

    const userId = req.user!.id;
    const existing = await prisma.position.findFirst({ where: { id: req.params.id, userId }, include: { token: true } });
    if (!existing || existing.status !== 'OPEN') {
      return errorResponse(res, 404, 'Open position not found');
    }
    if (existing.mode !== 'PAPER') {
      return errorResponse(res, 409, 'Only PAPER positions can be closed from the dashboard');
    }

    // Close at a fresh market quote when available; otherwise at the last mark.
    const quote = await apiMarketDataProvider.getTokenMetrics(existing.token.address).catch(() => null);
    const quotePrice = toNumber(quote?.priceUsd);
    const freshQuote = quote?.timestamp && Date.now() - quote.timestamp.getTime() <= env.MARKET_DATA_STALE_AFTER_MS && quotePrice !== null && quotePrice > 0;
    const markPrice = freshQuote ? quotePrice! : Number(existing.currentPrice ?? existing.avgEntryPrice);
    const closed = await prisma.$transaction(async (transaction) => {
      const result = await closePaperPosition(transaction, {
        positionId: existing.id,
        userId,
        exitPrice: freshQuote ? quotePrice : null,
        exitSlippagePercent: estimateExitSlippagePercent(markPrice, Number(existing.quantity), freshQuote ? toNumber(quote?.liquidityUsd) : null),
        exitReason: parsed.data.reason,
        diagnostics: { observedPrice: markPrice, quoteFresh: Boolean(freshQuote), closedBy: 'USER' },
      });
      if (result) await transaction.positionEvent.create({ data: { positionId: existing.id, userId, type: 'EXIT', price: new Prisma.Decimal(result.exitPrice), details: { exitReason: parsed.data.reason, exitMarketPrice: result.exitMarketPrice, netPnl: result.netPnl, closedBy: 'USER' } } });
      return result;
    });
    if (!closed) {
      return errorResponse(res, 409, 'Position is no longer open');
    }
    const position = await prisma.position.findUniqueOrThrow({ where: { id: existing.id } });
    const trade = { id: closed.tradeId };

    await logAuditEvent('position_close', req.user?.id ?? null, { positionId: req.params.id, reason: parsed.data.reason, exitPrice: closed.exitPrice, netPnl: closed.netPnl });
    monitoring.record('TRADE_CLOSED', { positionId: req.params.id, reason: parsed.data.reason }, req.correlationId);
    await safeNotify('TRADE_CLOSED', { positionId: req.params.id, reason: parsed.data.reason }, req.correlationId);
    return res.json({ ok: true, data: { ...position, tradeId: trade.id, reason: parsed.data.reason } });
  } catch (error) {
    logger.error({ err: error }, 'Failed to close position');
    return errorResponse(res, 500, 'Unable to close position');
  }
});

app.get('/api/trades', async (req, res) => {
  try {
    const query = paginationSchema.parse(req.query);
    const trades = await prisma.trade.findMany({
      where: { userId: req.user!.id },
      take: query.limit,
      skip: query.offset,
      orderBy: { createdAt: 'desc' },
    }).catch(() => []);

    return res.json({ ok: true, data: trades.map((trade) => redactSensitiveFields(trade)) });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return errorResponse(res, 400, 'Invalid query parameters', error.issues);
    }

    logger.error({ err: error }, 'Failed to fetch trades');
    return errorResponse(res, 500, 'Unable to fetch trades');
  }
});

/**
 * Full lifecycle of one PAPER trade: entry/exit reference and fill prices, costs, protection levels,
 * trailing state and the settings in force at entry. Only stored facts are returned; values that were
 * not recorded for older trades are null (never reconstructed).
 */
app.get('/api/trades/:id', async (req, res) => {
  try {
    const trade = await prisma.trade.findFirst({ where: { id: req.params.id, userId: req.user!.id }, include: { position: true } });
    if (!trade) return errorResponse(res, 404, 'Trade not found');
    const position = trade.position;
    const quantity = toNumber(trade.quantity) ?? 0;
    const entryFill = toNumber(trade.entry);
    const exitFill = toNumber(trade.exit);
    const entryMarket = toNumber(trade.entryMarketPrice) ?? toNumber(position?.entryMarketPrice);
    const exitMarket = toNumber(trade.exitMarketPrice);
    const totalSlippage = toNumber(trade.slippage) ?? 0;
    const exitSlippage = toNumber(trade.exitSlippage);
    // Trades closed before exit slippage was modelled only carry the entry slippage.
    const entrySlippage = exitSlippage !== null ? totalSlippage - exitSlippage : totalSlippage;
    const size = toNumber(trade.size) ?? 0;
    const diagnostics = (trade.exitDiagnostics ?? null) as Record<string, unknown> | null;
    const holdingMs = trade.entryAt && trade.exitAt ? trade.exitAt.getTime() - trade.entryAt.getTime() : null;
    return res.json({ ok: true, data: {
      id: trade.id,
      positionId: trade.positionId,
      decisionSource: trade.decisionSource,
      symbol: trade.symbol,
      tokenAddress: trade.tokenAddress,
      status: trade.status,
      mode: trade.mode,
      strategyName: trade.strategyName,
      executionSource: trade.strategyName === 'MANUAL_PAPER' ? 'MANUAL_PAPER' : (trade.configSnapshot as Record<string, unknown> | null)?.executionSource ?? 'STRATEGY',
      signalScore: toNumber(trade.signalScore),
      riskScore: toNumber(trade.riskScore),
      riskClassification: trade.riskClassification,
      entryAt: trade.entryAt,
      exitAt: trade.exitAt,
      holdingMs,
      size,
      quantity,
      entryMarketPrice: entryMarket,
      entryFillPrice: entryFill,
      exitMarketPrice: exitMarket,
      exitFillPrice: exitFill,
      entrySlippageAmount: entrySlippage,
      exitSlippageAmount: exitSlippage,
      totalSlippageAmount: totalSlippage,
      entrySlippagePercent: entryMarket && entryFill ? (entryFill / entryMarket - 1) * 100 : null,
      exitSlippagePercent: exitMarket && exitFill ? (1 - exitFill / exitMarket) * 100 : null,
      fees: toNumber(trade.fees),
      grossPnl: toNumber(trade.pnl),
      netPnl: toNumber(trade.netPnl),
      returnPercent: size > 0 && trade.netPnl !== null ? (toNumber(trade.netPnl) ?? 0) / size * 100 : null,
      exitReason: trade.exitReason,
      stopLossPrice: toNumber(position?.stopLossPrice) ?? toNumber(trade.stopLoss),
      takeProfitPrice: toNumber(position?.takeProfitPrice) ?? toNumber(trade.takeProfit),
      trailingStopPercent: position?.trailingStopPercent != null ? (toNumber(position.trailingStopPercent) ?? 0) * 100 : null,
      trailingActivationPercent: position?.trailingActivationPercent != null ? (toNumber(position.trailingActivationPercent) ?? 0) * 100 : null,
      trailingArmedFromEntry: position ? position.trailingStopPercent !== null && position.trailingActivationPercent === null : null,
      trailingActive: position?.trailingActive ?? null,
      trailingActivatedAt: position?.trailingActivatedAt ?? null,
      trailingActivationPrice: toNumber(position?.trailingActivationPrice),
      trailingTriggerPrice: toNumber(position?.trailingTriggerPrice),
      breakEvenActivationPercent: position?.breakEvenActivationPercent != null ? (toNumber(position.breakEvenActivationPercent) ?? 0) * 100 : null,
      breakEvenAppliedAt: position?.breakEvenAppliedAt ?? null,
      highestPrice: toNumber(position?.highestPrice),
      lowestPrice: toNumber(position?.lowestPrice),
      maxFavorableExcursionPercent: entryFill && position?.highestPrice ? ((toNumber(position.highestPrice) ?? 0) / entryFill - 1) * 100 : null,
      maxAdverseExcursionPercent: entryFill && position?.lowestPrice ? ((toNumber(position.lowestPrice) ?? 0) / entryFill - 1) * 100 : null,
      triggerLevel: typeof diagnostics?.triggerLevel === 'number' ? diagnostics.triggerLevel : null,
      observedPrice: typeof diagnostics?.observedPrice === 'number' ? diagnostics.observedPrice : null,
      exitDiagnostics: diagnostics,
      configSnapshot: trade.configSnapshot ?? null,
      diagnosticsRecorded: trade.exitDiagnostics !== null || trade.configSnapshot !== null,
    } });
  } catch (error) {
    logger.error({ err: error }, 'Failed to fetch trade details');
    return errorResponse(res, 500, 'Unable to fetch trade details');
  }
});

type SignalOutcome = { status: 'EXECUTED' | 'PROPOSED' | 'REJECTED' | 'BLOCKED' | 'PENDING'; reasons: string[] };

/**
 * What the worker actually did with each signal: a PAPER order exists (EXECUTED), a SEMI_AUTO proposal
 * was made (PROPOSED), or a rejection / hard block was recorded. Anything else is still PENDING.
 */
async function loadSignalOutcomes(userId: string, signalIds: string[]) {
  const outcomes = new Map<string, SignalOutcome>();
  if (signalIds.length === 0) return outcomes;
  const [orders, decisions] = await Promise.all([
    prisma.paperOrder.findMany({ where: { userId, signalId: { in: signalIds } }, select: { signalId: true } }),
    prisma.$queryRaw<Array<{ signalId: string; action: string; reasons: unknown }>>`
      SELECT DISTINCT ON (details->>'signalId') details->>'signalId' AS "signalId", action, details->'decisionReasons' AS reasons
      FROM "AuditLog"
      WHERE "userId" = ${userId}
        AND action IN ('TRADE_REJECTED', 'HARD_BLOCK_TRIGGERED', 'SEMI_AUTO_TRADE_PROPOSED')
        AND details->>'signalId' IN (${Prisma.join(signalIds)})
      ORDER BY details->>'signalId', "createdAt" DESC`,
  ]);
  for (const decision of decisions) {
    const reasons = Array.isArray(decision.reasons) ? decision.reasons.filter((reason): reason is string => typeof reason === 'string') : [];
    outcomes.set(decision.signalId, {
      status: decision.action === 'HARD_BLOCK_TRIGGERED' ? 'BLOCKED' : decision.action === 'SEMI_AUTO_TRADE_PROPOSED' ? 'PROPOSED' : 'REJECTED',
      reasons,
    });
  }
  for (const order of orders) if (order.signalId) outcomes.set(order.signalId, { status: 'EXECUTED', reasons: [] });
  return outcomes;
}

app.get('/api/signals', async (req, res) => {
  try {
    const query = signalQuerySchema.parse(req.query);
    const signals = await prisma.signal.findMany({
      take: query.limit,
      skip: query.offset,
      where: {
        userId: req.user!.id,
        ...(query.tokenAddress ? { token: { address: query.tokenAddress } } : {}),
        ...(query.mode ? { mode: query.mode } : {}),
      },
      include: { token: { select: { address: true, symbol: true } } },
      orderBy: { createdAt: 'desc' },
    }).catch(() => []);

    for (const signal of signals.slice(0, 25)) {
      monitoring.record(signal.score && Number(signal.score) >= 70 ? 'strategy_decision' : 'rejected_signal', { signalId: signal.id, mode: signal.mode, score: signal.score, riskScore: signal.riskScore }, req.correlationId);
      monitoring.record('risk_decision', { signalId: signal.id, riskScore: signal.riskScore }, req.correlationId);
    }
    const outcomes = await loadSignalOutcomes(req.user!.id, signals.map((signal) => signal.id)).catch((error: unknown) => {
      logger.warn({ err: error }, 'Signal outcome lookup failed');
      return new Map<string, SignalOutcome>();
    });
    return res.json({ ok: true, data: signals.map(({ token, ...signal }) => redactSensitiveFields({
      ...signal,
      symbol: token.symbol,
      tokenAddress: token.address,
      outcome: outcomes.get(signal.id) ?? { status: 'PENDING', reasons: [] },
    })) });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return errorResponse(res, 400, 'Invalid query parameters', error.issues);
    }

    logger.error({ err: error }, 'Failed to fetch signals');
    return errorResponse(res, 500, 'Unable to fetch signals');
  }
});

app.get('/api/approvals', async (req, res) => {
  try {
    const now = new Date();
    await prisma.approvalRequest.updateMany({ where: { userId: req.user!.id, status: 'PENDING', expiresAt: { lte: now } }, data: { status: 'EXPIRED', reviewedAt: now, rejectionReason: 'Approval expired' } });
    const approvals = await prisma.approvalRequest.findMany({ where: { userId: req.user!.id, status: 'PENDING' }, include: { signal: true, token: true }, orderBy: { proposedAt: 'desc' } });
    return res.json({ ok: true, data: approvals.map((approval) => ({
      id: approval.id,
      signalId: approval.signalId,
      token: approval.token.address,
      symbol: approval.token.symbol,
      direction: approval.direction,
      signalScore: toNumber(approval.signalScore),
      riskScore: toNumber(approval.riskScore),
      entryPrice: toNumber(approval.entryPrice),
      positionSize: toNumber(approval.positionSize),
      stopLoss: toNumber(approval.stopLoss),
      takeProfit: toNumber(approval.takeProfit),
      trailingStop: toNumber(approval.trailingStop),
      reasons: approval.signal.reasons ?? approval.reasons,
      proposedAt: approval.proposedAt,
      expiresAt: approval.expiresAt,
      status: approval.status,
    })) });
  } catch (error) {
    logger.error({ err: error }, 'Failed to fetch SEMI_AUTO approvals');
    return errorResponse(res, 500, 'Unable to fetch approval requests');
  }
});

type ApprovalActionResult = { status: number; body: { ok: boolean; error?: string; mode?: string; data?: Record<string, unknown> } };

/** Minimum tolerated upward price move between proposal and approval (approvals via Telegram take a while). */
const MIN_APPROVAL_DRIFT_PERCENT = 5;

/** Rejects a pending SEMI_AUTO proposal. Shared by the dashboard and the Telegram buttons. */
async function rejectSemiAutoApproval(userId: string, approvalId: string, source: 'web' | 'telegram'): Promise<ApprovalActionResult> {
  const now = new Date();
  const approval = await prisma.approvalRequest.findFirst({ where: { id: approvalId, userId } });
  if (!approval) return { status: 404, body: { ok: false, error: 'Approval request not found' } };
  if (approval.status !== 'PENDING') return { status: 409, body: { ok: false, error: 'Approval request is no longer pending' } };
  if (approval.expiresAt <= now) {
    await prisma.approvalRequest.update({ where: { id: approval.id, userId }, data: { status: 'EXPIRED', reviewedAt: now, rejectionReason: 'Approval expired' } });
    return { status: 410, body: { ok: false, error: 'Approval request expired' } };
  }
  const locked = await prisma.approvalRequest.updateMany({ where: { id: approval.id, userId, status: 'PENDING' }, data: { status: 'REJECTED', reviewedAt: now, rejectionReason: 'Rejected by user' } });
  if (locked.count !== 1) return { status: 409, body: { ok: false, error: 'Approval request is no longer pending' } };
  await logAuditEvent('semi_auto_trade_rejected', userId, { approvalId: approval.id, signalId: approval.signalId, proposedOrderHash: approval.proposedOrderHash, source });
  return { status: 200, body: { ok: true, data: { id: approval.id, status: 'REJECTED' } } };
}

/**
 * Executes a pending SEMI_AUTO proposal as a PAPER order at the current market price, keeping the
 * approved USD amount. Shared by the dashboard and the Telegram buttons.
 */
async function approveSemiAutoApproval(userId: string, approvalId: string, source: 'web' | 'telegram', correlationId?: string): Promise<ApprovalActionResult> {
  const now = new Date();
  const approval = await prisma.approvalRequest.findFirst({ where: { id: approvalId, userId }, include: { signal: true, token: true } });
  if (!approval) return { status: 404, body: { ok: false, error: 'Approval request not found' } };
  if (approval.status !== 'PENDING') return { status: 409, body: { ok: false, error: 'Approval request is no longer pending' } };
  if (approval.expiresAt <= now) {
    await prisma.approvalRequest.update({ where: { id: approval.id, userId }, data: { status: 'EXPIRED', reviewedAt: now, rejectionReason: 'Approval expired' } });
    return { status: 410, body: { ok: false, error: 'Approval request expired' } };
  }

  const [bot, riskConfig, latestRisk, storedMetric, account, openPosition, openPositions, quote] = await Promise.all([
    prisma.botConfig.findUnique({ where: { userId } }),
    prisma.riskConfig.findUnique({ where: { userId } }),
    prisma.riskAssessment.findFirst({ where: { userId, tokenId: approval.tokenId }, orderBy: { createdAt: 'desc' } }),
    prisma.tokenMetric.findFirst({ where: { tokenId: approval.tokenId }, orderBy: { timestamp: 'desc' } }),
    prisma.paperAccount.findUnique({ where: { userId } }),
    prisma.position.findFirst({ where: { userId, tokenId: approval.tokenId, status: 'OPEN', mode: 'PAPER' } }),
    prisma.position.count({ where: { userId, status: 'OPEN', mode: 'PAPER' } }),
    apiMarketDataProvider.getTokenMetrics(approval.token.address).catch(() => null),
  ]);
  // Prefer a fresh quote; fall back to the scanner's stored metric when it is itself fresh.
  const quotePrice = toNumber(quote?.priceUsd);
  const freshQuote = quote?.timestamp && Date.now() - quote.timestamp.getTime() <= env.MARKET_DATA_STALE_AFTER_MS && quotePrice !== null && quotePrice > 0;
  const storedPrice = toNumber(storedMetric?.priceUsd);
  const freshStored = storedMetric && Date.now() - storedMetric.timestamp.getTime() <= env.MARKET_DATA_STALE_AFTER_MS && storedPrice !== null && storedPrice > 0;
  const currentPrice = freshQuote ? quotePrice! : freshStored ? storedPrice! : 0;
  const proposedPrice = toNumber(approval.entryPrice) ?? 0;
  const notional = proposedPrice * (toNumber(approval.positionSize) ?? 0);
  const maxDrift = Math.max(toNumber(riskConfig?.maxSlippagePercent) ?? 3, MIN_APPROVAL_DRIFT_PERCENT);
  const upwardDrift = proposedPrice > 0 ? (currentPrice - proposedPrice) / proposedPrice * 100 : Number.POSITIVE_INFINITY;
  const fee = paperFee(notional);
  const staleReason = bot?.tradingMode !== 'SEMI_AUTO' || bot.isLiveEnabled || env.LIVE_TRADING_ENABLED
    ? 'SEMI_AUTO mode is not active'
    : latestRisk?.hardBlocked === true || latestRisk?.decision === 'REJECT'
      ? 'Risk conditions changed'
      : currentPrice <= 0
        ? 'Market data is unavailable or stale'
        : upwardDrift > maxDrift
          ? `Price moved up ${upwardDrift.toFixed(1)}% since the proposal`
          : hashApprovalProposal(approval) !== approval.proposedOrderHash
            ? 'Proposal integrity check failed'
            : openPosition || openPositions >= (riskConfig?.maxConcurrentPositions ?? 3)
              ? 'Position limit reached'
              : !account || (toNumber(account.cashBalance) ?? 0) < notional + fee
                ? 'Insufficient paper balance'
                : null;
  if (staleReason) {
    await prisma.approvalRequest.updateMany({ where: { id: approval.id, userId, status: 'PENDING' }, data: { status: 'STALE', reviewedAt: now, rejectionReason: staleReason } });
    await logAuditEvent('semi_auto_trade_stale', userId, { approvalId: approval.id, signalId: approval.signalId, reason: staleReason, source });
    return { status: 409, body: { ok: false, error: `Approval rejected: ${staleReason}` } };
  }

  // The approved USD amount is executed at the current price (with the same impact model as the worker).
  const liquidity = toNumber(quote?.liquidityUsd) ?? toNumber(storedMetric?.liquidityUsd) ?? 0;
  const impactPercent = liquidity > 0 ? estimatePriceImpactPercent(notional, liquidity) : 0.1;
  const executionPrice = simulatedBuyFill(currentPrice, impactPercent);
  const quantity = notional / executionPrice;
  const entrySlippage = (executionPrice - currentPrice) * quantity;
  const stopLossPercent = toNumber(riskConfig?.stopLossPercent) ?? 0;
  const takeProfitPercent = toNumber(riskConfig?.takeProfitPercent) ?? 0;
  // Protection levels are derived from the actual entry fill, exactly like automatic PAPER entries.
  const levels = protectionLevels(executionPrice, stopLossPercent, takeProfitPercent);
  const trailingFraction = toNumber(approval.trailingStop) ?? 0;
  const trailingActivationPercent = toNumber(riskConfig?.trailingActivationPercent) ?? 0;
  const breakEvenActivationPercent = toNumber(riskConfig?.breakEvenActivationPercent) ?? 0;
  const configSnapshot = {
    capturedAt: now.toISOString(), executionSource: 'SEMI_AUTO_APPROVAL', stopLossPercent, takeProfitPercent,
    trailingStopPercent: trailingFraction * 100 || null, trailingActivationPercent: trailingActivationPercent || null,
    breakEvenActivationPercent: breakEvenActivationPercent || null, maxSlippagePercent: toNumber(riskConfig?.maxSlippagePercent),
    minSignalScore: toNumber(riskConfig?.minSignalScore), riskPolicy: riskConfig?.riskPolicy ?? null,
    entryMarket: { priceUsd: currentPrice, liquidityUsd: liquidity, proposedPrice }, entrySlippagePercent: impactPercent,
  };
  try {
    const result = await prisma.$transaction(async (transaction) => {
      const locked = await transaction.approvalRequest.updateMany({ where: { id: approval.id, userId, status: 'PENDING' }, data: { status: 'APPROVED', reviewedAt: now } });
      if (locked.count !== 1) throw new Error('Approval request is no longer pending');
      await debitPaperCash(transaction, account!.id, notional, fee);
      const order = await transaction.paperOrder.create({ data: { paperAccountId: account!.id, userId, tokenAddress: approval.token.address, symbol: approval.token.symbol, side: approval.direction, strategyName: approval.signal.strategyName, signalId: approval.signalId, status: 'FILLED', requestedNotionalUsd: new Prisma.Decimal(notional), filledNotionalUsd: new Prisma.Decimal(notional), quantity: new Prisma.Decimal(quantity), executionPriceUsd: new Prisma.Decimal(executionPrice), feeUsd: new Prisma.Decimal(fee), slippageUsd: new Prisma.Decimal(entrySlippage), partialFillRatio: new Prisma.Decimal(1), signalScore: approval.signalScore, riskScore: approval.riskScore, metadata: { approvalId: approval.id, proposedOrderHash: approval.proposedOrderHash, proposedPrice, source } } });
      await transaction.paperFill.create({ data: { paperOrderId: order.id, tokenAddress: approval.token.address, symbol: approval.token.symbol, quantity: new Prisma.Decimal(quantity), priceUsd: new Prisma.Decimal(executionPrice), notionalUsd: new Prisma.Decimal(notional), feeUsd: new Prisma.Decimal(fee), slippageUsd: new Prisma.Decimal(entrySlippage) } });
      const position = await transaction.position.create({ data: { userId, tokenId: approval.tokenId, signalId: approval.signalId, side: approval.direction, quantity: new Prisma.Decimal(quantity), avgEntryPrice: new Prisma.Decimal(executionPrice), currentPrice: new Prisma.Decimal(currentPrice), stopLossPrice: levels.stopLossPrice !== null ? new Prisma.Decimal(levels.stopLossPrice) : null, takeProfitPrice: levels.takeProfitPrice !== null ? new Prisma.Decimal(levels.takeProfitPrice) : null, trailingStopPercent: trailingFraction > 0 ? approval.trailingStop : null, entryMarketPrice: new Prisma.Decimal(currentPrice), trailingActivationPercent: trailingActivationPercent > 0 ? new Prisma.Decimal(trailingActivationPercent / 100) : null, breakEvenActivationPercent: breakEvenActivationPercent > 0 ? new Prisma.Decimal(breakEvenActivationPercent / 100) : null, highestPrice: new Prisma.Decimal(currentPrice), lowestPrice: new Prisma.Decimal(currentPrice), unrealizedPnl: new Prisma.Decimal(0), realizedPnl: new Prisma.Decimal(0), mode: 'PAPER' } });
      const trade = await transaction.trade.create({ data: { userId, tokenId: approval.tokenId, signalId: approval.signalId, positionId: position.id, side: approval.direction, tokenAddress: approval.token.address, symbol: approval.token.symbol, strategyName: approval.signal.strategyName, signalScore: approval.signalScore, riskScore: approval.riskScore, riskClassification: latestRisk?.classification ?? null, riskPolicy: latestRisk?.riskPolicy ?? null, aiConfirmed: false, entry: new Prisma.Decimal(executionPrice), size: new Prisma.Decimal(notional), quantity: new Prisma.Decimal(quantity), fees: new Prisma.Decimal(fee), slippage: new Prisma.Decimal(entrySlippage), entryMarketPrice: new Prisma.Decimal(currentPrice), stopLoss: levels.stopLossPrice !== null ? new Prisma.Decimal(levels.stopLossPrice) : null, takeProfit: levels.takeProfitPrice !== null ? new Prisma.Decimal(levels.takeProfitPrice) : null, trailingStop: trailingFraction > 0 ? approval.trailingStop : null, configSnapshot: configSnapshot as Prisma.InputJsonValue, entryAt: now, mode: 'PAPER', status: 'OPEN' } });
      await recomputePaperAccount(transaction, userId);
      await transaction.approvalRequest.update({ where: { id: approval.id, userId }, data: { status: 'EXECUTED', executedAt: now } });
      await transaction.auditLog.create({ data: { userId, action: 'SEMI_AUTO_TRADE_APPROVED', details: { approvalId: approval.id, signalId: approval.signalId, orderId: order.id, positionId: position.id, tradeId: trade.id, proposedOrderHash: approval.proposedOrderHash, source } } });
      return { order, position, trade };
    });
    await safeNotify('TRADE_OPENED', { mode: 'SEMI_AUTO', approvalId: approval.id, tradeId: result.trade.id }, correlationId);
    return { status: 200, body: { ok: true, mode: 'SEMI_AUTO', data: { approvalId: approval.id, orderId: result.order.id, positionId: result.position.id, tradeId: result.trade.id, status: 'EXECUTED', symbol: approval.token.symbol, notionalUsd: notional, executionPrice } } };
  } catch (error) {
    if (error instanceof InsufficientPaperCashError) return { status: 409, body: { ok: false, error: 'Approval rejected: Insufficient paper balance' } };
    if (error instanceof Error && error.message === 'Approval request is no longer pending') return { status: 409, body: { ok: false, error: error.message } };
    throw error;
  }
}

/** Per-user Telegram bot (account linking + SEMI_AUTO approvals). Started by server.ts, not by tests. */
export const telegramBot = new TelegramBotService({
  token: env.TELEGRAM_BOT_TOKEN?.trim() || undefined,
  prisma,
  redis: getRealtimeClient,
  logger,
  approve: (userId, approvalId) => approveSemiAutoApproval(userId, approvalId, 'telegram'),
  reject: (userId, approvalId) => rejectSemiAutoApproval(userId, approvalId, 'telegram'),
  audit: logAuditEvent,
});

app.get('/api/settings/telegram', async (req, res) => {
  try {
    const config = await prisma.notificationConfig.findUnique({ where: { userId: req.user!.id } });
    const chatId = config?.telegramChatId ?? null;
    return res.json({ ok: true, data: {
      botConfigured: telegramBot.configured,
      botRunning: Boolean(telegramBot.botUsername),
      botUsername: telegramBot.botUsername ?? null,
      linked: Boolean(chatId),
      enabled: Boolean(config?.telegramEnabled && chatId),
      chatIdHint: chatId ? `…${chatId.slice(-4)}` : null,
    } });
  } catch (error) {
    logger.error({ err: error }, 'Failed to read Telegram settings');
    return errorResponse(res, 500, 'Unable to read Telegram settings');
  }
});

app.post('/api/settings/telegram/link', async (req, res) => {
  try {
    if (!telegramBot.configured) return errorResponse(res, 409, 'A Telegram bot nincs beállítva (TELEGRAM_BOT_TOKEN hiányzik).');
    if (!telegramBot.botUsername) return errorResponse(res, 503, 'A Telegram bot nem fut. Ellenőrizd a TELEGRAM_BOT_TOKEN értékét és az API naplóját.');
    const link = await telegramBot.createLink(req.user!.id);
    await logAuditEvent('telegram_link_requested', req.user!.id);
    return res.json({ ok: true, data: link });
  } catch (error) {
    logger.error({ err: error }, 'Failed to create Telegram link');
    return errorResponse(res, 500, 'A Telegram csatolási link nem hozható létre');
  }
});

app.post('/api/settings/telegram/unlink', async (req, res) => {
  try {
    const config = await prisma.notificationConfig.findUnique({ where: { userId: req.user!.id } });
    await prisma.notificationConfig.updateMany({ where: { userId: req.user!.id }, data: { telegramChatId: null, telegramEnabled: false } });
    if (config?.telegramChatId && telegramBot.botUsername) await telegramBot.notifyUnlinked(config.telegramChatId);
    await logAuditEvent('telegram_unlinked', req.user!.id, { source: 'web' });
    return res.json({ ok: true, data: { linked: false } });
  } catch (error) {
    logger.error({ err: error }, 'Failed to unlink Telegram');
    return errorResponse(res, 500, 'A Telegram leválasztása sikertelen');
  }
});

app.post('/api/settings/telegram/test', async (req, res) => {
  try {
    const config = await prisma.notificationConfig.findUnique({ where: { userId: req.user!.id } });
    if (!config?.telegramChatId) return errorResponse(res, 409, 'Nincs csatolt Telegram-fiók');
    if (!telegramBot.botUsername) return errorResponse(res, 503, 'A Telegram bot nem fut');
    await telegramBot.sendTestMessage(config.telegramChatId);
    return res.json({ ok: true, data: { sent: true } });
  } catch (error) {
    logger.error({ err: error }, 'Failed to send Telegram test message');
    return errorResponse(res, 502, 'A tesztüzenet küldése sikertelen');
  }
});

app.post('/api/approvals/:id/reject', async (req, res) => {
  try {
    const result = await rejectSemiAutoApproval(req.user!.id, req.params.id, 'web');
    return res.status(result.status).json(result.body);
  } catch (error) {
    logger.error({ err: error }, 'Failed to reject SEMI_AUTO approval');
    return errorResponse(res, 500, 'Unable to reject approval request');
  }
});

app.post('/api/approvals/:id/approve', async (req, res) => {
  try {
    const result = await approveSemiAutoApproval(req.user!.id, req.params.id, 'web', req.correlationId);
    return res.status(result.status).json(result.body);
  } catch (error) {
    logger.error({ err: error }, 'Failed to approve SEMI_AUTO trade');
    return errorResponse(res, 500, 'Unable to approve trade');
  }
});

const tokenListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(300).optional(),
  offset: z.coerce.number().int().min(0).default(0),
});

app.get('/api/tokens', async (req, res) => {
  try {
    const query = tokenListQuerySchema.parse(req.query);
    // Without an explicit limit the list shows as many tokens as the user's "monitored tokens" setting.
    const bot = query.limit ? null : await prisma.botConfig.findUnique({ where: { userId: req.user!.id }, select: { maxMonitoredTokens: true } });
    const limit = query.limit ?? bot?.maxMonitoredTokens ?? 50;
    const [tokens, activeStrategyCount] = await Promise.all([prisma.token.findMany({
      take: limit,
      skip: query.offset,
      // Most recently scanned first (every fresh snapshot updates the token row).
      orderBy: { updatedAt: 'desc' },
      include: {
        tokenMetrics: { orderBy: { timestamp: 'desc' }, take: 1 },
        riskAssessments: { where: { OR: [{ userId: req.user!.id }, { userId: null }] }, orderBy: { createdAt: 'desc' }, take: 1 },
        signals: { where: { OR: [{ userId: req.user!.id }, { userId: null }] }, orderBy: { createdAt: 'desc' }, take: 5 },
      },
    }).catch(() => []), prisma.strategyConfig.count({ where: { userId: req.user!.id, isEnabled: true } }).catch(() => 0)]);

    const aiRows = tokens.length === 0 ? [] : await prisma.aiAnalysis.findMany({
      where: { userId: req.user!.id, tokenId: { in: tokens.map((token) => token.id) }, createdAt: { gte: new Date(Date.now() - 30 * 60_000) } },
      orderBy: { createdAt: 'desc' },
      select: { tokenId: true, effectiveDecision: true, rawDecision: true, confidence: true, status: true, createdAt: true },
    }).catch(() => []);
    const aiByToken = new Map<string, (typeof aiRows)[number]>();
    for (const row of aiRows) if (!aiByToken.has(row.tokenId)) aiByToken.set(row.tokenId, row);
    // Tokens the worker currently skips for this user (stayed blocked/unbuyable too long).
    const skipped = tokens.length === 0 ? [] : await (async () => (await getRealtimeClient()).mGet(tokens.map((token) => `unbuyable:skip:${req.user!.id}:${token.address}`)))()
      .catch((error: unknown) => {
        logger.warn({ err: error }, 'Skipped-token lookup failed');
        return tokens.map(() => null);
      });
    return res.json({ ok: true, data: tokens.map((token, index) => {
      const row = serializeTokenListRow(token);
      const skip = skipped[index] ? JSON.parse(skipped[index]!) as { until: string; reason: string } : null;
      const ai = aiByToken.get(token.id);
      return { ...row, skipped: skip, ai: ai ? { decision: ai.effectiveDecision, rawDecision: ai.rawDecision, confidence: toNumber(ai.confidence), status: ai.status, at: ai.createdAt } : null, signalStatus: row.signalStatus === 'COMPLETED' ? 'COMPLETED' : activeStrategyCount === 0 ? 'NO_ACTIVE_STRATEGY' : 'PENDING' };
    }) });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return errorResponse(res, 400, 'Invalid query parameters', error.issues);
    }

    logger.error({ err: error }, 'Failed to fetch tokens');
    return errorResponse(res, 500, 'Unable to fetch tokens');
  }
});

app.post('/api/paper/orders/manual-buy', async (req, res) => {
  try {
    const parsed = manualPaperBuySchema.safeParse(req.body ?? {});
    if (!parsed.success) return errorResponse(res, 400, 'Invalid manual Paper buy payload', parsed.error.issues);
    const userId = req.user!.id;
    const [bot, riskConfig, account, token] = await Promise.all([
      prisma.botConfig.findUnique({ where: { userId } }),
      prisma.riskConfig.findUnique({ where: { userId } }),
      ensurePaperAccountForUser(userId),
      prisma.token.findUnique({ where: { address: parsed.data.tokenAddress }, include: { tokenMetrics: { orderBy: { timestamp: 'desc' }, take: 1 }, riskAssessments: { where: { OR: [{ userId }, { userId: null }] }, orderBy: { createdAt: 'desc' }, take: 1 }, signals: { where: { userId, signalType: 'STRATEGY' }, orderBy: { createdAt: 'desc' }, take: 1 } } }),
    ]);
    if (!bot || bot.tradingMode !== 'PAPER' || bot.isLiveEnabled || bot.status !== 'RUNNING' || bot.isEmergencyStop || env.TRADING_MODE !== 'PAPER') return errorResponse(res, 409, 'Paper kereskedés jelenleg nem engedélyezett');
    if (!account) return errorResponse(res, 409, 'Nincs érvényes Paper számla');
    if (riskConfig?.allowManualPaperWatchBuy === false) return errorResponse(res, 403, 'A manuális Paper vétel le van tiltva');
    if (!token) return errorResponse(res, 404, 'Token nem található');
    const risk = token.riskAssessments[0];
    if (!risk) return errorResponse(res, 409, 'A token kockázati elemzése még nem készült el');
    if (risk.hardBlocked || risk.decision === 'REJECT') return errorResponse(res, 409, 'A token kritikus biztonsági feltétel miatt blokkolva van');
    const equity = toNumber(account.equity) ?? 0;
    const requestedAmount = parsed.data.amountType === 'EQUITY_PERCENT' ? equity * parsed.data.requestedAmount / 100 : parsed.data.requestedAmount;
    if (requestedAmount <= 0 || !Number.isFinite(requestedAmount)) return errorResponse(res, 400, 'Érvénytelen pozícióméret');
    // A manual buy is executed with exactly this amount or not at all, so obvious conflicts are reported right away.
    const configuredPositionSize = toNumber(bot.maxPositionSize);
    if (configuredPositionSize !== null && configuredPositionSize > 0 && requestedAmount > configuredPositionSize) {
      return errorResponse(res, 409, `A megadott összeg (${requestedAmount.toFixed(2)} USDC) nagyobb a Beállításokban megadott maximális pozícióméretnél (${configuredPositionSize.toFixed(2)} USDC).`);
    }
    const availableCash = toNumber(account.cashBalance) ?? 0;
    if (requestedAmount + paperFee(requestedAmount) > availableCash) {
      return errorResponse(res, 409, `Nincs elég szabad paper egyenleg: ${requestedAmount.toFixed(2)} USDC + díj kellene, ${availableCash.toFixed(2)} USDC áll rendelkezésre.`);
    }
    const market = await apiMarketDataProvider.getTokenMetrics(token.address).catch(() => null);
    const price = toNumber(market?.priceUsd);
    const fresh = Boolean(market?.timestamp && Date.now() - market.timestamp.getTime() <= env.MARKET_DATA_STALE_AFTER_MS);
    const liquidity = toNumber(market?.liquidityUsd);
    if (!market || price === null || price <= 0 || !fresh) return errorResponse(res, 409, fresh ? 'Nincs érvényes ár' : 'Az árfolyamadat elavult');
    if (!market.poolAddress || liquidity === null || liquidity <= 0) return errorResponse(res, 409, 'Nincs elegendő megbízható likviditási adat');
    const openPosition = await prisma.position.findFirst({ where: { userId, tokenId: token.id, status: 'OPEN', mode: 'PAPER' } });
    if (openPosition) return errorResponse(res, 409, 'Ehhez a tokenhez már van nyitott pozíció');
    const pendingManual = await prisma.signal.findFirst({ where: { userId, tokenId: token.id, signalType: 'MANUAL_PAPER', createdAt: { gte: new Date(Date.now() - 60_000) } } });
    if (pendingManual) return errorResponse(res, 409, 'A manuális Paper vétel már feldolgozás alatt áll');
    const latestSignal = token.signals[0];
    const signalScore = latestSignal ? toNumber(latestSignal.score) ?? 0 : 0;
    const signal = await prisma.signal.create({
      data: {
        tokenId: token.id,
        userId,
        direction: 'BUY',
        score: new Prisma.Decimal(signalScore),
        riskScore: risk.riskScore,
        signalType: 'MANUAL_PAPER',
        strategyName: 'MANUAL_PAPER',
        mode: 'SCANNER',
        reasons: ['MANUAL_PAPER_BUY'],
        metadata: { executionSource: 'MANUAL_PAPER', signalThresholdOverridden: true, requestedAmount, requestedAmountType: parsed.data.amountType, priceAtRequest: price, riskClassification: risk.classification, hardBlocked: false } as unknown as Prisma.InputJsonValue,
      },
    });
    await logAuditEvent('MANUAL_PAPER_BUY_REQUESTED', userId, { tokenAddress: token.address, signalId: signal.id, riskScore: toNumber(risk.riskScore), riskClassification: risk.classification, signalScore, requestedAmount, overrideReason: 'EXPLICIT_USER_ACTION' });
    return res.status(202).json({ ok: true, data: { status: 'PROCESSING', signalId: signal.id, tokenAddress: token.address, requestedAmount, message: 'A Paper vétel feldolgozása folyamatban.' } });
  } catch (error) {
    logger.error({ err: error }, 'Manual Paper buy failed');
    return errorResponse(res, 500, 'A Paper vétel feldolgozása sikertelen');
  }
});

/** Outcome of a manual Paper buy request, so the dashboard can tell the user what the worker decided. */
app.get('/api/paper/orders/manual-buy/:signalId', async (req, res) => {
  try {
    const userId = req.user!.id;
    const signal = await prisma.signal.findFirst({ where: { id: req.params.signalId, userId, signalType: 'MANUAL_PAPER' } });
    if (!signal) return errorResponse(res, 404, 'A kérés nem található');

    const order = await prisma.paperOrder.findFirst({ where: { userId, signalId: signal.id } });
    if (order) {
      const position = await prisma.position.findFirst({ where: { userId, signalId: signal.id } });
      const signalMeta = signal.metadata && typeof signal.metadata === 'object' && !Array.isArray(signal.metadata) ? signal.metadata as Record<string, unknown> : {};
      const orderMeta = order.metadata && typeof order.metadata === 'object' && !Array.isArray(order.metadata) ? order.metadata as Record<string, unknown> : {};
      const finalDecision = orderMeta.finalDecision && typeof orderMeta.finalDecision === 'object' ? orderMeta.finalDecision as Record<string, unknown> : {};
      return res.json({ ok: true, data: {
        status: 'EXECUTED',
        orderId: order.id,
        positionId: position?.id ?? null,
        positionStatus: position?.status ?? null,
        exitReason: position?.exitReason ?? null,
        notionalUsd: toNumber(order.filledNotionalUsd),
        feeUsd: toNumber(order.feeUsd),
        priceUsd: toNumber(order.executionPriceUsd),
        requestedAmount: typeof signalMeta.requestedAmount === 'number' ? signalMeta.requestedAmount : null,
        positionMultiplier: typeof finalDecision.positionMultiplier === 'number' ? finalDecision.positionMultiplier : null,
        riskClassification: typeof finalDecision.riskClassification === 'string' ? finalDecision.riskClassification : null,
      } });
    }
    const decision = await prisma.auditLog.findFirst({ where: { userId, details: { path: ['signalId'], equals: signal.id } }, orderBy: { createdAt: 'desc' } });
    if (decision && (decision.action === 'TRADE_REJECTED' || decision.action === 'HARD_BLOCK_TRIGGERED')) {
      const details = decision.details && typeof decision.details === 'object' && !Array.isArray(decision.details) ? decision.details as Record<string, unknown> : {};
      const reasons = Array.isArray(details.decisionReasons) ? details.decisionReasons.filter((reason): reason is string => typeof reason === 'string') : [];
      return res.json({ ok: true, data: { status: decision.action === 'HARD_BLOCK_TRIGGERED' ? 'BLOCKED' : 'REJECTED', reasons } });
    }
    // The worker only picks up requests while the bot is RUNNING and within its signal look-back window.
    const expired = Date.now() - signal.createdAt.getTime() > 3 * 60_000;
    return res.json({ ok: true, data: { status: expired ? 'EXPIRED' : 'PROCESSING', reasons: [] } });
  } catch (error) {
    logger.error({ err: error }, 'Failed to read manual Paper buy status');
    return errorResponse(res, 500, 'A kérés állapota nem kérdezhető le');
  }
});

/** Recent audit trail for the Logs page: the user's own events, plus system events for administrators. */
app.get('/api/audit-logs', async (req, res) => {
  try {
    const limit = z.coerce.number().int().min(1).max(200).default(100).parse(req.query.limit ?? undefined);
    const logs = await prisma.auditLog.findMany({
      where: req.user!.role === 'ADMIN' ? { OR: [{ userId: req.user!.id }, { userId: null }] } : { userId: req.user!.id },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return res.json({ ok: true, data: logs.map((log) => ({ id: log.id, userId: log.userId, action: log.action, details: redactSensitiveFields(log.details), createdAt: log.createdAt.toISOString() })) });
  } catch (error) {
    if (error instanceof z.ZodError) return errorResponse(res, 400, 'Invalid query parameters', error.issues);
    logger.error({ err: error }, 'Failed to fetch audit logs');
    return errorResponse(res, 500, 'Unable to fetch audit logs');
  }
});

/** The latest signal analysis of a token for this user: live (Redis, refreshed every worker cycle) or last persisted. */
async function loadLatestAnalysis(userId: string, tokenAddress: string, tokenId: string) {
  const client = await getRealtimeClient().catch(() => null);
  const cached = client ? await client.get(`analysis:${userId}:${tokenAddress}`).catch(() => null) : null;
  if (cached) {
    try {
      return { source: 'LIVE', ...(JSON.parse(cached) as Record<string, unknown>) };
    } catch {
      // Fall through to the persisted analysis.
    }
  }
  const signal = await prisma.signal.findFirst({ where: { tokenId, userId, metadata: { path: ['analysis', 'version'], equals: 1 } }, orderBy: { createdAt: 'desc' }, select: { metadata: true } }).catch(() => null);
  const persisted = (signal?.metadata as { analysis?: Record<string, unknown> } | null)?.analysis;
  return persisted ? { source: 'PERSISTED', ...persisted } : null;
}

app.get('/api/tokens/:address', async (req, res) => {
  try {
    const token = await prisma.token.findUnique({
      where: { address: req.params.address },
      include: {
        tokenMetrics: { orderBy: { timestamp: 'desc' }, take: 1 },
        riskAssessments: { where: { OR: [{ userId: req.user!.id }, { userId: null }] }, orderBy: { createdAt: 'desc' }, take: 5 },
        signals: { where: { OR: [{ userId: req.user!.id }, { userId: null }] }, orderBy: { createdAt: 'desc' }, take: 20 },
      },
    }).catch(() => null);

    // Freshly detected launches often have no Token row yet (only watched, never bought): serve their launch data.
    const launch = await loadLaunchInfo(req.user!.id, req.params.address);
    if (!token) {
      if (!launch) return errorResponse(res, 404, 'Token not found');
      const aiConfig = await prisma.aiConfig.findUnique({ where: { userId: req.user!.id }, select: { aiAnalysisEnabled: true } }).catch(() => null);
      return res.json({ ok: true, data: {
        id: null, openPositionId: null, address: req.params.address,
        symbol: launch.symbol ?? req.params.address.slice(0, 6), name: launch.name, decimals: null, isVerified: false,
        priceUsd: launch.snapshot?.priceUsd ?? launch.detectedPriceUsd, liquidityUsd: launch.snapshot?.liquidityUsd ?? null,
        volume24h: launch.snapshot?.volumeUsd ?? null, marketCap: launch.snapshot?.marketCapUsd ?? null,
        priceChange1h: null, priceChange24h: null, tokenAgeSeconds: launch.ageSeconds, poolAgeSeconds: launch.ageSeconds,
        dexId: launch.source === 'PUMP_FUN' ? 'pumpfun' : launch.source.toLowerCase(), poolAddress: launch.poolAddress ?? launch.bondingCurve,
        lastUpdatedAt: launch.snapshot?.takenAt ?? launch.detectedAt,
        analysis: null, aiAnalysis: null, decisionMode: aiConfig?.aiAnalysisEnabled ? 'AI' : 'STRATEGY',
        riskAssessments: [], signals: [], launch, dataSource: 'LAUNCH',
      } });
    }

    const latestMetric = token.tokenMetrics[0] ?? null;
    const [analysis, aiAnalysis, aiConfig, openPosition] = await Promise.all([
      loadLatestAnalysis(req.user!.id, token.address, token.id),
      latestAiAnalysis(req.user!.id, token.id, token.address),
      prisma.aiConfig.findUnique({ where: { userId: req.user!.id }, select: { aiAnalysisEnabled: true } }).catch(() => null),
      prisma.position.findFirst({ where: { userId: req.user!.id, tokenId: token.id, status: 'OPEN' }, select: { id: true }, orderBy: { openedAt: 'desc' } }).catch(() => null),
    ]);

    return res.json({
      ok: true,
      data: {
        id: token.id,
        openPositionId: openPosition?.id ?? null,
        address: token.address,
        symbol: token.symbol,
        name: token.name,
        decimals: token.decimals,
        isVerified: token.isVerified,
        priceUsd: toNumber(latestMetric?.priceUsd ?? token.priceUsd) ?? launch?.snapshot?.priceUsd ?? null,
        liquidityUsd: toNumber(latestMetric?.liquidityUsd) ?? launch?.snapshot?.liquidityUsd ?? null,
        launch,
        dataSource: latestMetric ? 'MARKET_DATA' : launch ? 'LAUNCH' : 'TOKEN',
        volume24h: toNumber(latestMetric?.volume24h ?? token.volume24h),
        marketCap: toNumber(latestMetric?.marketCap ?? token.marketCap),
        priceChange1h: toNumber(latestMetric?.priceChange1h),
        priceChange24h: toNumber(latestMetric?.priceChange24h),
        tokenAgeSeconds: latestMetric?.tokenAgeSeconds ?? null,
        poolAgeSeconds: latestMetric?.poolAgeSeconds ?? null,
        dexId: latestMetric?.dexId ?? null,
        poolAddress: latestMetric?.poolAddress ?? null,
        lastUpdatedAt: latestMetric?.timestamp ?? token.updatedAt,
        analysis,
        aiAnalysis,
        decisionMode: aiConfig?.aiAnalysisEnabled ? 'AI' : 'STRATEGY',
        riskAssessments: token.riskAssessments.map((assessment) => ({
          id: assessment.id,
          riskScore: toNumber(assessment.riskScore),
          decision: assessment.decision,
          factors: assessment.factors,
          classification: assessment.classification,
          hardBlocked: assessment.hardBlocked,
          hardBlockReasons: assessment.hardBlockReasons,
          positionMultiplier: toNumber(assessment.positionMultiplier),
          rejectionReasons: assessment.rejectionReasons,
          warnings: assessment.warnings,
          source: assessment.source,
          createdAt: assessment.createdAt,
        })),
        signals: token.signals.map((signal) => ({
          id: signal.id,
          strategyName: signal.strategyName,
          direction: signal.direction,
          score: toNumber(signal.score),
          riskScore: toNumber(signal.riskScore),
          signalType: signal.signalType,
          reasons: signal.reasons,
          entryConditions: signal.entryConditions,
          invalidationConditions: signal.invalidationConditions,
          recommendedStop: toNumber(signal.recommendedStop),
          recommendedTarget: toNumber(signal.recommendedTarget),
          mode: signal.mode,
          createdAt: signal.createdAt,
        })),
      },
    });
  } catch (error) {
    logger.error({ err: error }, 'Failed to fetch token');
    return errorResponse(res, 500, 'Unable to fetch token');
  }
});

const analyticsRangeSchema = z.enum(['today', '7d', '30d', 'all']).default('all');
const backtestRequestSchema = z.object({
  tokenAddress: z.string().min(1),
  strategyName: z.string().min(1),
  startDate: z.coerce.date(),
  endDate: z.coerce.date(),
  initialBalance: z.number().positive().default(10_000),
  walkForward: z.object({ trainingBars: z.number().int().positive(), validationBars: z.number().int().positive(), outOfSampleBars: z.number().int().positive() }).optional(),
}).refine((value) => value.endDate > value.startDate, { message: 'endDate must be after startDate', path: ['endDate'] });

function getAnalyticsWindow(value: unknown) {
  const range = analyticsRangeSchema.parse(value ?? 'all');
  if (range === 'all') return { range, start: undefined as Date | undefined };
  const now = new Date();
  if (range === 'today') return { range, start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())) };
  const days = range === '7d' ? 7 : 30;
  return { range, start: new Date(now.getTime() - days * 24 * 60 * 60 * 1000) };
}

function sumNumbers(values: Array<number | null | undefined>): number {
  return values.reduce<number>((total, value) => total + (value ?? 0), 0);
}

app.get('/api/portfolio/snapshot', async (req, res) => {
  try {
    const { range, start } = getAnalyticsWindow(req.query.range);
    const userId = req.user!.id;
    const [account, positions, trades, riskLimits, botLimits] = await Promise.all([
      ensurePaperAccountForUser(userId),
      prisma.position.findMany({ where: { userId, status: 'OPEN', mode: 'PAPER' } }),
      prisma.trade.findMany({ where: { userId, status: 'CLOSED', mode: 'PAPER', ...(start ? { exitAt: { gte: start } } : {}) }, select: { netPnl: true, fees: true, slippage: true, exitAt: true } }),
      prisma.riskConfig.findUnique({ where: { userId }, select: { dailyLossLimitPercent: true } }),
      prisma.botConfig.findUnique({ where: { userId }, select: { maxDailyLoss: true } }),
    ]);

    const cash = toNumber(account.cashBalance) ?? 0;
    const openPositionValue = sumNumbers(positions.map((position) => (toNumber(position.currentPrice) ?? 0) * (toNumber(position.quantity) ?? 0)));
    const unrealizedPnl = sumNumbers(positions.map((position) => toNumber(position.unrealizedPnl)));
    // For the whole account life the account ledger is authoritative (it restarts on a Paper reset).
    const realizedPnl = range === 'all' ? toNumber(account.realizedPnl) ?? 0 : sumNumbers(trades.map((trade) => toNumber(trade.netPnl)));
    const fees = toNumber(account.totalFees) ?? sumNumbers(trades.map((trade) => toNumber(trade.fees)));
    const totalPnl = realizedPnl + unrealizedPnl;
    const equity = cash + openPositionValue;
    const initialBalance = toNumber(account.initialBalance) ?? equity - totalPnl;
    const dailyStart = new Date();
    dailyStart.setUTCHours(0, 0, 0, 0);
    const dailyTrades: Array<{ netPnl: Prisma.Decimal | null }> = start && range === 'today' ? trades : await prisma.trade.findMany({ where: { userId, status: 'CLOSED', mode: 'PAPER', exitAt: { gte: dailyStart } }, select: { netPnl: true } });
    const dailyPnl = sumNumbers(dailyTrades.map((trade) => toNumber(trade.netPnl))) + unrealizedPnl;
    const peakEquity = Math.max(initialBalance, equity, initialBalance + realizedPnl);
    const drawdown = peakEquity > 0 ? Math.max(0, (peakEquity - equity) / peakEquity * 100) : 0;
    const exposure = equity > 0 ? openPositionValue / equity * 100 : 0;

    // Same rule as the worker's entry gate: today's closed net PnL plus open unrealized PnL against the limit.
    const { limit: dailyLossLimit, source: dailyLossLimitSource } = effectiveDailyLossLimit(equity, toNumber(riskLimits?.dailyLossLimitPercent), toNumber(botLimits?.maxDailyLoss));
    const dailyLoss = Math.max(0, -dailyPnl);
    const dailyLossLimitReached = dailyLossLimit !== null && dailyLoss > 0 && dailyLoss >= dailyLossLimit;
    return res.json({ ok: true, data: { range, cash, openPositionValue, totalEquity: equity, realizedPnl, unrealizedPnl, totalPnl, dailyPnl, fees, drawdown, exposure, openPositions: positions.length, dailyLoss, dailyLossLimit, dailyLossLimitSource, dailyLossLimitReached, generatedAt: new Date().toISOString() } });
  } catch (error) {
    if (error instanceof z.ZodError) return errorResponse(res, 400, 'Invalid analytics range', error.issues);
    logger.error({ err: error }, 'Failed to fetch portfolio snapshot');
    return errorResponse(res, 500, 'Unable to fetch portfolio snapshot');
  }
});

app.get('/api/backtests', async (req, res) => {
  try {
    const runs = await prisma.backtestRun.findMany({ where: { userId: req.user!.id }, orderBy: { createdAt: 'desc' }, take: 50, include: { trades: true } });
    return res.json({ ok: true, data: runs.map((run) => ({
      id: run.id,
      name: run.name,
      strategyName: run.strategyName,
      startDate: run.startDate,
      endDate: run.endDate,
      startingBalance: toNumber(run.startingBalance),
      endingBalance: toNumber(run.endingBalance),
      returnPercent: toNumber(run.returnPercent),
      maxDrawdown: toNumber(run.maxDrawdown),
      winRate: toNumber(run.winRate),
      profitFactor: toNumber(run.profitFactor),
      expectancy: toNumber(run.expectancy),
      tradeCount: run.tradeCount,
      fees: toNumber(run.fees),
      slippage: toNumber(run.slippage),
      configuration: redactSensitiveFields(run.configuration),
      summary: redactSensitiveFields(run.summary),
      trades: run.trades.map((trade) => redactSensitiveFields(trade)),
      historicalSimulation: true,
      createdAt: run.createdAt,
    })) });
  } catch (error) {
    logger.error({ err: error }, 'Failed to fetch backtest runs');
    return errorResponse(res, 500, 'Unable to fetch backtest runs');
  }
});

app.post('/api/backtests', async (req, res) => {
  try {
    const parsed = backtestRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) return errorResponse(res, 400, 'Invalid backtest request', parsed.error.issues);
    const input = parsed.data;
    const result = await runHistoricalBacktest(prisma, req.user!.id, input);
    const runs = [];
    for (const simulation of result.results) {
      const serialized = serializeBacktestResult(simulation);
      const metrics = simulation.metrics;
      const run = await prisma.backtestRun.create({
        data: {
          userId: req.user!.id,
          name: `Historical simulation: ${input.strategyName} (${simulation.split})`,
          strategyName: input.strategyName,
          startDate: input.startDate,
          endDate: input.endDate,
          startingBalance: new Prisma.Decimal(input.initialBalance),
          endingBalance: new Prisma.Decimal(metrics.endingEquity),
          returnPercent: new Prisma.Decimal(metrics.returnPercent),
          maxDrawdown: new Prisma.Decimal(metrics.maximumDrawdown * 100),
          winRate: new Prisma.Decimal(metrics.winRate),
          profitFactor: Number.isFinite(metrics.profitFactor) ? new Prisma.Decimal(metrics.profitFactor) : null,
          expectancy: new Prisma.Decimal(metrics.expectancy),
          tradeCount: metrics.totalTrades,
          fees: new Prisma.Decimal(metrics.fees),
          slippage: new Prisma.Decimal(metrics.slippage),
          configuration: result.configuration as unknown as Prisma.InputJsonValue,
          summary: { historicalSimulation: true, split: simulation.split, metrics, equityCurve: serialized.equityCurve } as unknown as Prisma.InputJsonValue,
        },
      });
      if (simulation.trades.length > 0) {
        await prisma.backtestTrade.createMany({ data: simulation.trades.map((trade) => ({
          backtestRunId: run.id,
          token: trade.token,
          symbol: result.token.symbol,
          entry: new Prisma.Decimal(trade.entryPrice),
          exit: new Prisma.Decimal(trade.exitPrice),
          quantity: new Prisma.Decimal(trade.quantity),
          entryTime: trade.entryTime,
          exitTime: trade.exitTime,
          holdingTimeMs: trade.holdingTimeMs,
          fees: new Prisma.Decimal(trade.fees),
          slippage: new Prisma.Decimal(trade.slippage),
          split: trade.split,
          pnl: new Prisma.Decimal(trade.grossPnl),
          netPnl: new Prisma.Decimal(trade.netPnl),
          exitReason: trade.exitReason,
        })) });
      }
      runs.push({ ...run, result: serialized });
    }
    await logAuditEvent('backtest_completed', req.user!.id, { strategyName: input.strategyName, tokenAddress: input.tokenAddress, runs: runs.length, historicalSimulation: true });
    return res.status(201).json({ ok: true, historicalSimulation: true, data: runs });
  } catch (error) {
    if (error instanceof z.ZodError) return errorResponse(res, 400, 'Invalid backtest request', error.issues);
    logger.error({ err: error }, 'Failed to run backtest');
    return errorResponse(res, 500, 'Unable to run backtest');
  }
});

/** NewLaunch entry facts stored with the trade (score, age and liquidity at entry). */
function launchFields(configSnapshot: Prisma.JsonValue | null, exitDiagnostics: Prisma.JsonValue | null) {
  const launch = (configSnapshot as { launch?: Record<string, unknown> } | null)?.launch;
  const numberOrNull = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
  return {
    launchScore: launch ? numberOrNull(launch.score) : null,
    launchAgeSeconds: launch ? numberOrNull(launch.ageSeconds) : null,
    launchLiquidityUsd: launch ? numberOrNull(launch.liquidityUsd) : null,
    breakEvenApplied: Boolean((exitDiagnostics as { breakEvenAppliedAt?: unknown } | null)?.breakEvenAppliedAt),
  };
}

/** Signal context stored with the trade at entry (trades opened before it was recorded have none). */
function signalContextFields(configSnapshot: Prisma.JsonValue | null) {
  const context = (configSnapshot as { signalContext?: Record<string, unknown> } | null)?.signalContext;
  if (!context || typeof context !== 'object') return { primaryStrategy: null, confirmations: null, compositeScore: null, exhaustionScore: null };
  const numberOrNull = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
  return {
    primaryStrategy: typeof context.primaryStrategy === 'string' ? context.primaryStrategy : null,
    confirmations: Array.isArray(context.confirmedModules) ? context.confirmedModules.filter((item): item is string => typeof item === 'string') : null,
    compositeScore: numberOrNull(context.compositeScore),
    exhaustionScore: numberOrNull(context.exhaustionScore),
  };
}

app.get('/api/positions/:id', async (req, res) => {
  try {
    const detail = await buildPositionDetail(req.user!.id, req.params.id);
    if (!detail) return errorResponse(res, 404, 'Position not found');
    return res.json({ ok: true, data: redactSensitiveFields(detail) });
  } catch (error) {
    logger.error({ err: error }, 'Failed to load position detail');
    return errorResponse(res, 500, 'Unable to load position');
  }
});

const chartQuerySchema = z.object({ range: z.enum(['1m', '5m', '15m', '30m', '1h', 'lifetime']).default('lifetime') });
app.get('/api/positions/:id/chart', async (req, res) => {
  try {
    const query = chartQuerySchema.parse(req.query);
    const chart = await buildPositionChart(req.user!.id, req.params.id, query.range as ChartRange);
    if (!chart) return errorResponse(res, 404, 'Position not found');
    return res.json({ ok: true, data: chart });
  } catch (error) {
    if (error instanceof z.ZodError) return errorResponse(res, 400, 'Invalid chart range', error.issues);
    logger.error({ err: error }, 'Failed to load position chart');
    return errorResponse(res, 500, 'Unable to load chart');
  }
});

const tokenChartQuerySchema = z.object({ from: z.coerce.number().int().optional(), to: z.coerce.number().int().optional() });
app.get('/api/tokens/:address/chart', async (req, res) => {
  try {
    const query = tokenChartQuerySchema.parse(req.query);
    const to = new Date(query.to ?? Date.now());
    const from = new Date(query.from ?? to.getTime() - 3_600_000);
    if (to.getTime() - from.getTime() > 7 * 86_400_000 || from > to) return errorResponse(res, 400, 'Invalid chart window');
    const chart = await buildTokenChart(req.params.address, from, to);
    if (!chart) return errorResponse(res, 404, 'Token not found');
    return res.json({ ok: true, data: chart });
  } catch (error) {
    if (error instanceof z.ZodError) return errorResponse(res, 400, 'Invalid chart window', error.issues);
    logger.error({ err: error }, 'Failed to load token chart');
    return errorResponse(res, 500, 'Unable to load chart');
  }
});

async function readJsonKey<T>(key: string): Promise<T | null> {
  const raw = await getRealtimeClient().then((client) => client.get(key)).catch(() => null);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function serializeNewLaunchSettings(userId: string) {
  const [{ row, settings }, versions, recommendations] = await Promise.all([
    loadNewLaunchSettings(userId),
    prisma.newLaunchConfigVersion.findMany({ where: { userId }, orderBy: { versionNumber: 'desc' }, take: 20, select: { version: true, versionNumber: true, parentVersion: true, createdFromRecommendationId: true, note: true, createdAt: true } }),
    prisma.newLaunchOptimizationRecommendation.count({ where: { userId, status: 'PENDING' } }),
  ]);
  return {
    ...settings,
    persisted: Boolean(row),
    paperOnly: true,
    paperOnlyNotice: 'Az Új token / Sniper stratégia jelenleg csak PAPER módban használható.',
    exitNotice: 'Ezek a beállítások csak az Új token / Sniper pozíciókra vonatkoznak.',
    qualityGateNotice: 'MONITOR_ONLY módban a szűrő nem tiltja a PAPER belépést, csak méri, mit szűrt volna ki.',
    // Tiered take-profit is prepared (configurable) but not executed yet: partial exits are not implemented.
    tieredTakeProfitSupported: false,
    versions,
    pendingRecommendations: recommendations,
    providers: (await readJsonKey<unknown[]>('newlaunch:providers')) ?? [],
    // System-level security rules: displayed, never switchable from the UI.
    mandatorySecurity: ['SELLABILITY_VERIFIED', 'MINT_AUTHORITY_CHECK', 'FREEZE_AUTHORITY_CHECK', 'TOKEN_EXTENSION_CHECK', 'HOLDER_CONCENTRATION_CHECK', 'DEV_ALLOCATION_CHECK', 'LIQUIDITY_VALIDATION'],
  };
}

app.get('/api/settings/new-launch', async (req, res) => {
  try {
    return res.json({ ok: true, data: await serializeNewLaunchSettings(req.user!.id) });
  } catch (error) {
    logger.error({ err: error }, 'Failed to load new launch settings');
    return errorResponse(res, 500, 'Unable to load new launch settings');
  }
});

app.put('/api/settings/new-launch', async (req, res) => {
  try {
    const parsed = newLaunchSettingsSchema.safeParse(req.body ?? {});
    if (!parsed.success) return errorResponse(res, 400, 'Érvénytelen Új token / Sniper beállítás', parsed.error.issues);
    const userId = req.user!.id;
    const { settings: current } = await loadNewLaunchSettings(userId);
    const minAge = parsed.data.minAgeSeconds ?? current.minAgeSeconds;
    const maxAge = parsed.data.maxAgeSeconds ?? current.maxAgeSeconds;
    if (minAge >= maxAge) return errorResponse(res, 400, 'A minimum életkornak kisebbnek kell lennie a maximumnál.');
    const result = await applyNewLaunchSettingsChange(userId, parsed.data as Record<string, unknown>);
    const toggled = parsed.data.enabled !== undefined && parsed.data.enabled !== current.enabled;
    await logAuditEvent(toggled ? (parsed.data.enabled ? 'new_launch_enabled' : 'new_launch_disabled') : 'new_launch_settings_update', userId, { fields: Object.keys(parsed.data), configVersion: result.configVersion, previousVersion: result.previousVersion, newVersion: result.changed });
    return res.json({ ok: true, data: await serializeNewLaunchSettings(userId) });
  } catch (error) {
    logger.error({ err: error }, 'Failed to save new launch settings');
    return errorResponse(res, 500, 'Unable to save new launch settings');
  }
});

const filterConditionSchema = z.object({
  feature: z.enum(['launchScore', 'uniqueBuyers', 'liquidityUsd', 'buySellRatio', 'exhaustionScore', 'priceImpactPercent', 'holderConcentrationPercent', 'devAllocationPercent', 'dataQuality', 'tokenAgeSeconds', 'riskScore']),
  kind: z.enum(['min', 'max']),
  value: z.number().finite(),
}).strict();

const AUTO_OPTIMIZER_MIN_TRADES = 50;

/**
 * "If closed now" estimate of an open PAPER position: the stored open P&L (mark minus entry fee) minus the exit fee and
 * the modelled exit impact for this size at the last known liquidity - the same model the PAPER sell uses.
 */
function closeNowEstimate(position: { quantity: Prisma.Decimal; currentPrice: Prisma.Decimal | null; avgEntryPrice: Prisma.Decimal; unrealizedPnl: Prisma.Decimal | null }, liquidityUsd: number | null) {
  const price = toNumber(position.currentPrice) ?? toNumber(position.avgEntryPrice) ?? 0;
  const quantity = toNumber(position.quantity) ?? 0;
  const impactPercent = estimateExitSlippagePercent(price, quantity, liquidityUsd);
  const proceeds = price * quantity * (1 - impactPercent / 100);
  const exitCosts = price * quantity - proceeds + paperFee(proceeds);
  const unrealized = toNumber(position.unrealizedPnl);
  return { estimatedExitCosts: exitCosts, estimatedExitImpactPercent: impactPercent, estimatedCloseNowPnl: unrealized === null ? null : unrealized - exitCosts };
}

function capacityConfigFromSettings(settings: Awaited<ReturnType<typeof loadNewLaunchSettings>>['settings']) {
  return {
    ...DEFAULT_CAPACITY_CONFIG,
    maxEntryImpactPct: settings.maxEstimatedEntryImpactPct, maxExitImpactPct: settings.maxEstimatedExitImpactPct, maxRoundTripImpactPct: settings.maxEstimatedRoundTripImpactPct,
    minExitCapacityScore: settings.minExitCapacityScore, maxLiquidityUtilizationPct: settings.maxLiquidityUtilizationPct, minimumExecutablePosition: settings.minimumExecutablePosition, positionSizeStep: settings.positionSizeStep,
  };
}

/**
 * Lead / lag between social acceleration and the price move (traded tokens with stored social snapshots, last 100).
 * Social snapshots are stored every ~30 s, so the lag resolution is ~30 s. Correlation in time only - no causality.
 */
/** TelegramSource registry counts (no usernames / credentials leave this function). */
async function telegramSourceCounts() {
  const rows = await prisma.telegramSource.findMany({ select: { officialStatus: true, accessStatus: true, active: true }, take: 50_000 }).catch(() => []);
  return {
    total: rows.length,
    accessible: rows.filter((row) => row.active && row.accessStatus === 'ACCESSIBLE').length,
    official: rows.filter((row) => row.officialStatus === 'OFFICIAL').length,
    community: rows.filter((row) => row.officialStatus === 'COMMUNITY').length,
    noAccess: rows.filter((row) => row.accessStatus === 'NO_ACCESS').length,
  };
}

async function socialLeadLag(rows: Awaited<ReturnType<typeof loadLaunchTrades>>) {
  let pairs = 0;
  let socialFirst = 0;
  let priceFirst = 0;
  const lags: number[] = [];
  for (const row of rows.slice(-100)) {
    const from = new Date(row.entryAt - 30 * 60_000);
    const to = new Date(row.closedAt);
    const socials = await prisma.socialSnapshot.findMany({ where: { mint: row.tokenAddress, at: { gte: from, lte: to } }, orderBy: { at: 'asc' }, select: { at: true, mentionTrend: true } }).catch(() => []);
    const accelerating = socials.find((item) => item.mentionTrend === 'ACCELERATING');
    if (!accelerating) continue;
    const prices = await priceLiquiditySeries(row.tokenId, row.tokenAddress, from, to).catch(() => []);
    const first = prices[0]?.price;
    const move = first ? prices.find((point) => point.price >= first * 1.1) : undefined;
    if (!move) continue;
    pairs += 1;
    const lag = move.t - accelerating.at.getTime();
    lags.push(lag);
    if (lag > 0) socialFirst += 1;
    else priceFirst += 1;
  }
  const sorted = [...lags].sort((a, b) => a - b);
  return { pairs, socialFirst, priceFirst, medianLagMs: sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : null, resolutionMs: 30_000 };
}

/** Stored observations in the 15 s after each exit trigger (partial-exit analysis; last 100 trades). */
async function partialExitPaths(rows: Awaited<ReturnType<typeof loadLaunchTrades>>) {
  const paths = new Map<string, Array<{ t: number; price: number; liquidityUsd: number | null }>>();
  for (const row of rows.slice(-100)) {
    const triggerAt = row.forensics?.exit.triggerAt ? Date.parse(row.forensics.exit.triggerAt) : null;
    if (triggerAt === null || !Number.isFinite(triggerAt)) continue;
    const series = await priceLiquiditySeries(row.tokenId, row.tokenAddress, new Date(triggerAt - 3_000), new Date(triggerAt + 15_000)).catch(() => []);
    if (series.length) paths.set(row.id, series.map((point) => ({ t: point.t, price: point.price, liquidityUsd: point.liquidityUsd ?? null })));
  }
  return paths;
}

/**
 * Social Intelligence of one token: latest stored snapshot + short history and the official links from metadata.
 * Public social data (not user-specific); computed only from data the worker was authorized to collect.
 */
app.get('/api/tokens/:address/social', async (req, res) => {
  try {
    const mint = String(req.params.address);
    const [snapshots, candidate] = await Promise.all([
      prisma.socialSnapshot.findMany({ where: { mint }, orderBy: { at: 'desc' }, take: 60 }),
      prisma.launchCandidate.findUnique({ where: { mint }, select: { socialLinks: true } }),
    ]);
    const latest = snapshots[0] ?? null;
    return res.json({ ok: true, data: {
      links: candidate?.socialLinks ?? null,
      latest: latest ? { ...latest, tokenMatchConfidence: toNumber(latest.tokenMatchConfidence), dataAgeMs: Date.now() - latest.at.getTime() } : null,
      history: snapshots.reverse().map((item) => ({ at: item.at, socialScore: item.socialScore, momentumScore: item.momentumScore, spamScore: item.spamScore, mentions5m: item.mentions5m, confirmation: item.confirmation })),
    } });
  } catch (error) {
    logger.error({ err: error }, 'Failed to load token social data');
    return errorResponse(res, 500, 'Unable to load social data');
  }
});

/** NewLaunch analytics (descriptive, computed from stored data; per user). */
app.get('/api/analytics/new-launch', async (req, res) => {
  try {
    const userId = req.user!.id;
    const scope = parseScope(req.query as Record<string, unknown>);
    const { settings } = await loadNewLaunchSettings(userId);
    const [rows, funnel, versions, latestRun, recommendations] = await Promise.all([
      loadLaunchTrades(userId, scope, settings.configVersion),
      launchFunnel(userId, 7),
      prisma.newLaunchConfigVersion.findMany({ where: { userId }, orderBy: { versionNumber: 'desc' }, take: 30, select: { version: true, parentVersion: true, createdAt: true, note: true, createdFromRecommendationId: true } }),
      prisma.newLaunchOptimizationRun.findFirst({ where: { userId }, orderBy: { startedAt: 'desc' } }),
      prisma.newLaunchOptimizationRecommendation.findMany({ where: { userId, status: 'PENDING' }, orderBy: { createdAt: 'desc' }, take: 20 }),
    ]);
    // Once the current config version has >= 50 closed trades, the optimizer runs once automatically for it.
    // It only produces PENDING recommendations; nothing is applied without an explicit user action.
    let autoRunStarted = false;
    if (scope.version === 'current' && scope.sample === 'all' && rows.length >= AUTO_OPTIMIZER_MIN_TRADES) {
      const existing = await prisma.newLaunchOptimizationRun.findMany({ where: { userId, status: { in: ['RUNNING', 'COMPLETED'] } }, orderBy: { startedAt: 'desc' }, take: 20, select: { status: true, sampleSize: true, result: true, startedAt: true } });
      const covered = existing.some((run) => run.status === 'RUNNING' || ((run.result as { configVersion?: string } | null)?.configVersion === settings.configVersion && (run.sampleSize ?? 0) >= AUTO_OPTIMIZER_MIN_TRADES));
      if (!covered) {
        const started = await startOptimizationRun(userId, { version: 'current', sample: 'all' }, logger);
        autoRunStarted = !started.alreadyRunning;
        if (autoRunStarted) await logAuditEvent('new_launch_optimizer_auto_run', userId, { runId: started.run.id, configVersion: settings.configVersion, closedTrades: rows.length });
      }
    }
    const socialDecisions = await prisma.launchDecision.findMany({ where: { userId, decisionAt: { gte: new Date(Date.now() - 7 * 86_400_000) }, socialSummary: { not: Prisma.DbNull } }, select: { mint: true, decision: true, socialSummary: true }, take: 20_000 });
    return res.json({ ok: true, data: redactSensitiveFields({
      scope,
      autoRunStarted,
      autoOptimizerMinTrades: AUTO_OPTIMIZER_MIN_TRADES,
      currentConfigVersion: settings.configVersion,
      minimumRecommendationSampleSize: settings.minimumRecommendationSampleSize,
      qualityGate: settings.qualityGate,
      analytics: buildLaunchAnalytics(rows, settings.qualityGate),
      capacity: buildCapacityAnalytics(rows, capacityConfigFromSettings(settings), await partialExitPaths(rows)),
      social: buildSocialAnalytics(rows, socialDecisions, await socialLeadLag(rows)),
      // Telegram-only view (features frozen at decision / entry; older trades are TELEGRAM_DATA_NOT_AVAILABLE).
      telegram: buildTelegramAnalytics(rows, socialDecisions, { health: await readJsonKey<Record<string, unknown>>('social:health').catch(() => null), sources: await telegramSourceCounts() }),
      funnel,
      versions,
      latestRun: latestRun ? { id: latestRun.id, status: latestRun.status, startedAt: latestRun.startedAt, completedAt: latestRun.completedAt, sampleSize: latestRun.sampleSize, error: latestRun.error, scope: latestRun.scope, result: latestRun.result } : null,
      recommendations,
    }) });
  } catch (error) {
    logger.error({ err: error }, 'Failed to load new launch analytics');
    return errorResponse(res, 500, 'Unable to load new launch analytics');
  }
});

/** Historical what-if of stricter entry filters (label: HISTORICAL SIMULATION — NOT FUTURE PERFORMANCE). */
app.post('/api/analytics/new-launch/simulate-filter', async (req, res) => {
  try {
    const parsed = z.object({ conditions: z.array(filterConditionSchema).min(1).max(10), version: z.string().optional(), sample: z.union([z.literal('all'), z.number().int()]).optional() }).strict().safeParse(req.body ?? {});
    if (!parsed.success) return errorResponse(res, 400, 'Érvénytelen szűrő', parsed.error.issues);
    const userId = req.user!.id;
    const scope = parseScope({ version: parsed.data.version, sample: parsed.data.sample });
    const { settings } = await loadNewLaunchSettings(userId);
    const rows = await loadLaunchTrades(userId, scope, settings.configVersion);
    return res.json({ ok: true, data: simulateFilter(rows, parsed.data.conditions) });
  } catch (error) {
    logger.error({ err: error }, 'Failed to simulate new launch filter');
    return errorResponse(res, 500, 'Unable to simulate filter');
  }
});

/** Starts a background optimization run (entry filters + exit parameter grids); results are cached. */
app.post('/api/new-launch/optimizer/run', async (req, res) => {
  try {
    const userId = req.user!.id;
    const scope = parseScope((req.body ?? {}) as Record<string, unknown>);
    const { run, alreadyRunning } = await startOptimizationRun(userId, scope, logger);
    await logAuditEvent('new_launch_optimizer_run', userId, { runId: run.id, scope, alreadyRunning });
    return res.status(202).json({ ok: true, data: { id: run.id, status: run.status, alreadyRunning } });
  } catch (error) {
    logger.error({ err: error }, 'Failed to start new launch optimizer');
    return errorResponse(res, 500, 'Unable to start optimizer');
  }
});

app.get('/api/new-launch/optimizer', async (req, res) => {
  try {
    const userId = req.user!.id;
    const [latestRun, recommendations] = await Promise.all([
      prisma.newLaunchOptimizationRun.findFirst({ where: { userId }, orderBy: { startedAt: 'desc' } }),
      prisma.newLaunchOptimizationRecommendation.findMany({ where: { userId, status: 'PENDING' }, orderBy: { createdAt: 'desc' }, take: 20 }),
    ]);
    return res.json({ ok: true, data: { latestRun, recommendations } });
  } catch (error) {
    logger.error({ err: error }, 'Failed to load new launch optimizer');
    return errorResponse(res, 500, 'Unable to load optimizer');
  }
});

/**
 * Accepting a recommendation creates a NEW PAPER config version (parent = current, createdFromRecommendationId);
 * history is not mutated, open positions keep their snapshotted configuration, LIVE is never touched.
 */
/** Quality-gate thresholds without the server-managed version counter (the settings schema rejects it). */
function gateThresholds(gate: { version: number } & object) {
  const rest: Record<string, unknown> = { ...gate };
  delete rest.version;
  return rest;
}

app.post('/api/new-launch/recommendations/:id/accept', async (req, res) => {
  try {
    const userId = req.user!.id;
    const recommendation = await prisma.newLaunchOptimizationRecommendation.findFirst({ where: { id: req.params.id, userId, status: 'PENDING' } });
    if (!recommendation) return errorResponse(res, 404, 'Recommendation not found');
    const value = toNumber(recommendation.suggestedValue);
    if (value === null) return errorResponse(res, 400, 'Recommendation has no value');
    // Quality-gate thresholds are nested ("qualityGate.<field>"); the rest of the gate is kept unchanged.
    const gateField = recommendation.parameter.startsWith('qualityGate.') ? recommendation.parameter.slice('qualityGate.'.length) : null;
    const patch = newLaunchSettingsSchema.safeParse(gateField ? { qualityGate: { ...gateThresholds((await loadNewLaunchSettings(userId)).settings.qualityGate), [gateField]: value } } : { [recommendation.parameter]: value });
    if (!patch.success) return errorResponse(res, 400, 'A javasolt érték érvénytelen', patch.error.issues);
    const result = await applyNewLaunchSettingsChange(userId, patch.data as Record<string, unknown>, { createdFromRecommendationId: recommendation.id, note: `Javaslatból: ${recommendation.parameter} ${toNumber(recommendation.currentValue) ?? '—'} → ${value}` });
    await prisma.newLaunchOptimizationRecommendation.update({ where: { id: recommendation.id }, data: { status: 'ACCEPTED', createdVersion: result.configVersion, decidedAt: new Date() } });
    await logAuditEvent('new_launch_recommendation_accepted', userId, { recommendationId: recommendation.id, parameter: recommendation.parameter, value, configVersion: result.configVersion, previousVersion: result.previousVersion });
    return res.json({ ok: true, data: { configVersion: result.configVersion, previousVersion: result.previousVersion } });
  } catch (error) {
    logger.error({ err: error }, 'Failed to accept new launch recommendation');
    return errorResponse(res, 500, 'Unable to accept recommendation');
  }
});

app.post('/api/new-launch/recommendations/:id/dismiss', async (req, res) => {
  try {
    const userId = req.user!.id;
    const updated = await prisma.newLaunchOptimizationRecommendation.updateMany({ where: { id: req.params.id, userId, status: 'PENDING' }, data: { status: 'DISMISSED', decidedAt: new Date() } });
    if (!updated.count) return errorResponse(res, 404, 'Recommendation not found');
    return res.json({ ok: true, data: { dismissed: true } });
  } catch (error) {
    logger.error({ err: error }, 'Failed to dismiss new launch recommendation');
    return errorResponse(res, 500, 'Unable to dismiss recommendation');
  }
});

/** New Launch monitor: live launches (worker, Redis) merged with this user's latest decisions, plus day stats. */
app.get('/api/new-launch', async (req, res) => {
  try {
    const userId = req.user!.id;
    const day = new Date().toISOString().slice(0, 10);
    const startOfDay = new Date(`${day}T00:00:00.000Z`);
    const live = (await readJsonKey<{ at: string; launches: Array<Record<string, unknown> & { mint: string }> }>('newlaunch:live')) ?? { at: null, launches: [] };
    const [decisions, todayDecisions, openLaunchTrades, config, detected, latencyMs, latencyCount] = await Promise.all([
      prisma.launchDecision.findMany({ where: { userId, decisionAt: { gte: new Date(Date.now() - 30 * 60_000) } }, orderBy: { decisionAt: 'desc' }, take: 1_000 }),
      prisma.launchDecision.findMany({ where: { userId, decisionAt: { gte: startOfDay } }, orderBy: { decisionAt: 'desc' }, select: { mint: true, decision: true } }),
      prisma.trade.findMany({ where: { userId, decisionSource: 'NEW_LAUNCH', status: 'OPEN' }, select: { tokenAddress: true, positionId: true } }),
      prisma.newLaunchConfig.findUnique({ where: { userId }, select: { enabled: true } }),
      readJsonKey<number>(`newlaunch:stats:${day}:detected`),
      readJsonKey<number>(`newlaunch:stats:${day}:latencyMs`),
      readJsonKey<number>(`newlaunch:stats:${day}:latencyCount`),
    ]);
    const latestByMint = new Map<string, (typeof decisions)[number]>();
    for (const decision of decisions) if (!latestByMint.has(decision.mint)) latestByMint.set(decision.mint, decision);
    const latestToday = new Map<string, string>();
    for (const decision of todayDecisions) if (!latestToday.has(decision.mint)) latestToday.set(decision.mint, decision.decision);
    const positionByMint = new Map(openLaunchTrades.map((trade) => [trade.tokenAddress, trade.positionId]));
    const rows = live.launches.map((launch) => {
      const decision = latestByMint.get(launch.mint);
      return {
        ...launch,
        decision: decision?.decision ?? null, status: decision?.status ?? null, score: decision?.score ?? null, exhaustionScore: decision?.exhaustionScore ?? null,
        riskScore: toNumber(decision?.riskScore), riskClassification: decision?.riskClassification ?? null, securityScore: decision?.securityScore ?? null,
        reasons: decision?.reasons ?? [], positionId: positionByMint.get(launch.mint) ?? null,
      };
    });
    const counts = [...latestToday.values()];
    return res.json({ ok: true, data: {
      enabled: config?.enabled ?? false,
      paperOnly: true,
      updatedAt: live.at,
      providers: (await readJsonKey<unknown[]>('newlaunch:providers')) ?? [],
      stats: {
        detectedToday: Number(detected ?? 0),
        watching: counts.filter((decision) => decision === 'WATCH').length,
        eligible: counts.filter((decision) => decision === 'BUY').length,
        rejected: counts.filter((decision) => decision === 'REJECT').length,
        paperPositions: openLaunchTrades.length,
        averageDetectionLatencyMs: latencyCount ? Number(latencyMs ?? 0) / Number(latencyCount) : null,
      },
      launches: rows,
    } });
  } catch (error) {
    logger.error({ err: error }, 'Failed to load new launch monitor');
    return errorResponse(res, 500, 'Unable to load new launches');
  }
});

app.get('/api/analytics', async (req, res) => {
  try {
    const { range, start } = getAnalyticsWindow(req.query.range);
    const userId = req.user!.id;
    // Optional decision-mode filter (Összes / Stratégia / AI / Manuális); never mixes sources silently.
    const sourceFilter = typeof req.query.decisionSource === 'string' && ['STRATEGY', 'AI', 'NEW_LAUNCH', 'MANUAL_PAPER'].includes(req.query.decisionSource) ? req.query.decisionSource : null;
    const [trades, openPositions, recentSignals, account, earlier, aiEvents] = await Promise.all([
      prisma.trade.findMany({ where: { userId, status: 'CLOSED', mode: 'PAPER', ...(start ? { exitAt: { gte: start } } : {}), ...(sourceFilter ? { decisionSource: sourceFilter } : {}) }, orderBy: { exitAt: 'asc' }, include: { position: true } }),
      prisma.position.findMany({ where: { userId, status: 'OPEN', mode: 'PAPER' }, include: { token: true } }),
      prisma.signal.findMany({ where: { userId }, take: 5, orderBy: { createdAt: 'desc' } }).catch(() => []),
      prisma.paperAccount.findUnique({ where: { userId }, select: { initialBalance: true } }).catch(() => null),
      start ? prisma.trade.aggregate({ where: { userId, status: 'CLOSED', mode: 'PAPER', exitAt: { lt: start } }, _sum: { netPnl: true } }) : Promise.resolve(null),
      prisma.aiAnalysis.findMany({ where: { userId, ...(start ? { createdAt: { gte: start } } : {}) }, select: { tokenId: true, effectiveDecision: true, createdAt: true }, orderBy: { createdAt: 'asc' }, take: 20_000 }).catch(() => []),
    ]);
    // Realized equity at the start of the window: initial balance plus everything realized before it.
    const windowStartEquity = (toNumber(account?.initialBalance) ?? 1_000) + (toNumber(earlier?._sum.netPnl) ?? 0);
    const analyticsRows: AnalyticsTrade[] = trades.map((trade) => ({
      netPnl: toNumber(trade.netPnl) ?? 0,
      grossPnl: toNumber(trade.pnl) ?? 0,
      fees: toNumber(trade.fees) ?? 0,
      slippage: toNumber(trade.slippage) ?? 0,
      size: toNumber(trade.size) ?? 0,
      entryPrice: toNumber(trade.entry),
      exitPrice: toNumber(trade.exit),
      entryAt: trade.entryAt,
      exitAt: trade.exitAt,
      strategy: trade.strategyName ?? 'Unspecified',
      exitReason: trade.exitReason ?? 'Unspecified',
      riskClassification: trade.riskClassification ?? 'UNKNOWN',
      signalScore: toNumber(trade.signalScore),
      manual: trade.strategyName === 'MANUAL_PAPER',
      highestPrice: toNumber(trade.position?.highestPrice),
      lowestPrice: toNumber(trade.position?.lowestPrice),
      trailingActivationPercent: toNumber(trade.position?.trailingActivationPercent),
      trailingActivationPrice: toNumber(trade.position?.trailingActivationPrice),
      trailingActivatedAt: trade.position?.trailingActivatedAt ?? null,
      token: trade.symbol || trade.tokenAddress,
      aiConfirmed: trade.aiConfirmed,
      ...signalContextFields(trade.configSnapshot),
      decisionSource: trade.decisionSource,
      aiConfidence: toNumber(trade.aiConfidence),
      ...launchFields(trade.configSnapshot, trade.exitDiagnostics),
    }));
    const metrics = computeTradeAnalytics(analyticsRows, windowStartEquity);

    const totalNetPnl = metrics.realizedPnl;
    const openUnrealizedPnl = sumNumbers(openPositions.map((position) => toNumber(position.unrealizedPnl)));
    // Cumulative realized net P&L per exit; open positions are shown as a separate last point only.
    const equityCurve = [{ at: start?.toISOString() ?? null, equity: 0 }];
    let runningPnl = 0;
    for (const trade of trades) {
      runningPnl += toNumber(trade.netPnl) ?? 0;
      equityCurve.push({ at: (trade.exitAt ?? trade.createdAt).toISOString(), equity: runningPnl });
    }
    if (openPositions.length > 0) equityCurve.push({ at: new Date().toISOString(), equity: runningPnl + openUnrealizedPnl });

    return res.json({
      ok: true,
      data: {
        range,
        ...metrics,
        openPositions: openPositions.length,
        realizedPnl: totalNetPnl,
        unrealizedPnl: openUnrealizedPnl,
        totalPnl: totalNetPnl + openUnrealizedPnl,
        drawdownBasis: 'REALIZED_EQUITY',
        decisionSourceFilter: sourceFilter,
        aiDecisionFunnel: aiDecisionFunnel(aiEvents),
        tokenPerformance: groupTrades(analyticsRows, (row) => row.token ?? 'Unspecified'),
        aiConfirmationPerformance: groupTrades(analyticsRows, (row) => (row.aiConfirmed ? 'igen' : 'nem')),
        equityCurve,
        recentSignals: recentSignals.map((signal) => redactSensitiveFields(signal)),
        generatedAt: new Date().toISOString(),
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) return errorResponse(res, 400, 'Invalid analytics range', error.issues);
    logger.error({ err: error }, 'Failed to fetch analytics');
    return errorResponse(res, 500, 'Unable to fetch analytics');
  }
});

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => { timer = globalThis.setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs); })]);
  } finally {
    if (timer) globalThis.clearTimeout(timer);
  }
}

/** The risk engine and position manager run inside the worker, which refreshes a Redis heartbeat every 10 s. */
async function assertWorkerAlive() {
  const raw = await withTimeout((async () => (await getRealtimeClient()).get('worker:heartbeat'))(), 2000);
  const at = raw ? Date.parse((JSON.parse(raw) as { at?: string }).at ?? '') : Number.NaN;
  if (!Number.isFinite(at) || Date.now() - at > 30_000) throw new Error('Worker heartbeat missing – is the worker running?');
}

app.get('/api/system/health', async (req, res) => {
  try {
    const components = await Promise.all([
      checkHealth('DATABASE', async () => { await prisma.$queryRaw<Array<{ ok: number }>>`SELECT 1 as ok`; }, monitoring),
      // Real probes. (The LIVE safety gate deliberately still requires explicit operator confirmation flags.)
      checkHealth('REDIS', async () => { await withTimeout((async () => { await (await getRealtimeClient()).ping(); })(), 2000); }, monitoring),
      checkHealth('RPC', async () => {
        // Prefer the worker's RPC manager snapshot (no extra traffic on the providers); probe only without it.
        const managed = await readJsonKey<{ at?: string; providers?: Array<{ status?: string }> }>('rpc:health').catch(() => null);
        if (managed?.at && Date.now() - Date.parse(managed.at) < 30_000) {
          if (!managed.providers?.some((provider) => provider.status === 'HEALTHY' || provider.status === 'DEGRADED')) throw new Error('No usable Solana RPC provider (see RPC panel)');
          return;
        }
        const rpcUrl = env.SOLANA_PRIMARY_RPC_URL || env.SOLANA_RPC_URL;
        if (!rpcUrl) throw new Error('No Solana RPC configured');
        const response = await globalThis.fetch(rpcUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth' }), signal: globalThis.AbortSignal.timeout(env.SOLANA_RPC_TIMEOUT_MS) });
        const body = await response.json() as { result?: string; error?: { message?: string } };
        if (!response.ok || body.result !== 'ok') throw new Error(body.error?.message ?? `RPC answered HTTP ${response.status}`);
      }, monitoring),
      checkHealth('MARKET DATA', async () => {
        const quote = await withTimeout(apiMarketDataProvider.getTokenMetrics('So11111111111111111111111111111111111111112'), env.MARKET_DATA_REQUEST_TIMEOUT_MS);
        if (!quote || !(Number(quote.priceUsd) > 0)) throw new Error('Market data provider returned no price');
      }, monitoring),
      checkHealth('EXECUTION ENGINE', async () => { if (!process.env.EXECUTION_PROVIDER_URL?.trim() || process.env.EXECUTION_PROVIDER_HEALTHY !== 'true') throw new Error('LIVE execution provider is not configured'); }, monitoring),
      checkHealth('RISK ENGINE', async () => { await assertWorkerAlive(); }, monitoring),
      checkHealth('POSITION MANAGER', async () => { await assertWorkerAlive(); }, monitoring),
      checkHealth('TRADING ENGINE', async () => { if (env.TRADING_MODE === 'LIVE' && !env.LIVE_TRADING_ENABLED) throw new Error('Server LIVE trading is disabled'); }, monitoring),
    ]);
    monitoring.setHealth('API', 'HEALTHY');
    for (const component of components.filter((item) => item.state !== 'HEALTHY')) {
      const event = component.component === 'RPC' ? 'RPC_FAILURE' : 'SYSTEM_ERROR';
      monitoring.record(event, { component: component.component, state: component.state, message: component.message }, req.correlationId);
      if (component.component === 'RPC') void safeNotify('RPC_FAILURE', { component: component.component, message: component.message }, req.correlationId);
    }
    return res.json({
      ok: true,
      data: {
        api: 'healthy',
        // The LIVE execution provider is optional: without one it is reported as not configured, not as a failure.
        components: components.map(({ component, state, latencyMs }) => ({ component, latencyMs, state: component === 'EXECUTION ENGINE' && state !== 'HEALTHY' && !process.env.EXECUTION_PROVIDER_URL?.trim() ? 'NOT_CONFIGURED' : state })),
        database: components.find((component) => component.component === 'DATABASE')?.state.toLowerCase() ?? 'down',
        mode: env.TRADING_MODE,
        liveTradingEnabled: false,
        serverLiveTradingEnabled: env.LIVE_TRADING_ENABLED,
        // NewLaunch exit monitor diagnostics published by the worker (counts / latencies only, no user data).
        exitMonitor: await readJsonKey<Record<string, unknown>>('newlaunch:exitmonitor').catch(() => null),
        // Social Intelligence provider health / request & rate-limit counters (no secrets).
        social: await readJsonKey<Record<string, unknown>>('social:health').catch(() => null),
        // Solana RPC manager diagnostics (masked provider labels, counters, latencies, alerts; never URLs or keys).
        rpc: await readJsonKey<Record<string, unknown>>('rpc:health').catch(() => null),
      },
    });
  } catch (error) {
    logger.error({ err: error }, 'System health check failed');
    return errorResponse(res, 500, 'System health check failed');
  }
});

app.get('/api/v1/system', (_req, res) => {
  res.json({
    ok: true,
    service: 'api',
    mode: env.TRADING_MODE,
    liveTradingEnabled: false,
    serverLiveTradingEnabled: env.LIVE_TRADING_ENABLED,
    states: {
      scanner: 'active',
      paperTrading: 'enabled',
      liveTrading: 'blocked',
      keyExposure: 'blocked',
    },
  });
});

const createTradeInput = z.object({
  symbol: z.string().min(1),
  side: z.enum(['buy', 'sell']),
  amount: z.number().positive(),
});

app.get('/api/paper-account', requireAuth, async (req, res) => {
  try {
    const account = await ensurePaperAccountExistsForRequest(req);
    if (!account) return errorResponse(res, 401, 'Authentication required');
    return res.json({
      ok: true,
      data: {
        id: account.id,
        userId: account.userId,
        currency: account.currency,
        initialBalance: toNumber(account.initialBalance),
        cashBalance: toNumber(account.cashBalance),
        equity: toNumber(account.equity),
        realizedPnl: toNumber(account.realizedPnl),
        unrealizedPnl: toNumber(account.unrealizedPnl),
        totalFees: toNumber(account.totalFees),
        createdAt: account.createdAt,
        updatedAt: account.updatedAt,
      },
    });
  } catch (error) {
    logger.error({ err: error }, 'Failed to fetch paper account');
    return errorResponse(res, 500, 'Unable to fetch paper account');
  }
});

app.get('/api/paper-account/orders', requireAuth, async (req, res) => {
  try {
    const account = await ensurePaperAccountExistsForRequest(req);
    if (!account) return errorResponse(res, 401, 'Authentication required');
    const orders = await prisma.paperOrder.findMany({
      where: { userId: req.user!.id },
      orderBy: { createdAt: 'desc' },
      take: 25,
      include: { fills: true },
    });

    return res.json({
      ok: true,
      data: orders.map((order) => ({
        id: order.id,
        symbol: order.symbol,
        side: order.side,
        status: order.status,
        tokenAddress: order.tokenAddress,
        requestedNotionalUsd: toNumber(order.requestedNotionalUsd),
        filledNotionalUsd: toNumber(order.filledNotionalUsd),
        executionPriceUsd: toNumber(order.executionPriceUsd),
        feeUsd: toNumber(order.feeUsd),
        slippageUsd: toNumber(order.slippageUsd),
        createdAt: order.createdAt,
        fills: order.fills.map((fill) => ({
          id: fill.id,
          quantity: toNumber(fill.quantity),
          priceUsd: toNumber(fill.priceUsd),
          notionalUsd: toNumber(fill.notionalUsd),
          feeUsd: toNumber(fill.feeUsd),
          slippageUsd: toNumber(fill.slippageUsd),
          filledAt: fill.filledAt,
        })),
      })),
    });
  } catch (error) {
    logger.error({ err: error }, 'Failed to fetch paper orders');
    return errorResponse(res, 500, 'Unable to fetch paper orders');
  }
});

const paperResetSchema = z.object({ initialBalance: z.number().positive().max(10_000_000).optional() });

/** Restarts the PAPER account from a clean balance. Trade history is kept; open positions must be closed first. */
app.post('/api/paper-account/reset', requireAuth, async (req, res) => {
  try {
    const parsed = paperResetSchema.safeParse(req.body ?? {});
    if (!parsed.success) return errorResponse(res, 400, 'Érvénytelen kezdőtőke', parsed.error.issues);
    const userId = req.user!.id;
    const openPositions = await prisma.position.count({ where: { userId, status: 'OPEN', mode: 'PAPER' } });
    if (openPositions > 0) return errorResponse(res, 409, 'Előbb zárd le a nyitott Paper pozíciókat');
    const account = await ensurePaperAccountForUser(userId);
    const balance = new Prisma.Decimal(parsed.data.initialBalance ?? toNumber(account.initialBalance) ?? 1000);
    const updated = await prisma.paperAccount.update({
      where: { id: account.id, userId },
      data: { initialBalance: balance, cashBalance: balance, equity: balance, realizedPnl: new Prisma.Decimal(0), unrealizedPnl: new Prisma.Decimal(0), totalFees: new Prisma.Decimal(0) },
    });
    await logAuditEvent('paper_account_reset', userId, { initialBalance: toNumber(balance) });
    return res.json({ ok: true, data: { initialBalance: toNumber(updated.initialBalance), cashBalance: toNumber(updated.cashBalance), equity: toNumber(updated.equity) } });
  } catch (error) {
    logger.error({ err: error }, 'Failed to reset paper account');
    return errorResponse(res, 500, 'A Paper számla visszaállítása sikertelen');
  }
});

/**
 * Immediate PAPER fill at the latest stored market price. Uses the same bookkeeping as the worker:
 * a buy atomically debits cash and opens a position with an OPEN trade; a sell closes the open
 * position of that token. It never invents a price.
 */
app.post('/api/v1/trades/simulate', requireAuth, async (req, res) => {
  try {
    const parsed = createTradeInput.safeParse(req.body);
    if (!parsed.success) {
      return errorResponse(res, 400, 'Invalid trade payload', parsed.error.issues);
    }

    if (env.TRADING_MODE !== 'PAPER') {
      return errorResponse(res, 403, 'Paper trading is only available when TRADING_MODE is PAPER.');
    }

    const { symbol, side, amount } = parsed.data;
    const userId = req.user!.id;
    const account = await ensurePaperAccountForUser(userId);
    const token = await prisma.token.findFirst({
      where: { symbol: { equals: symbol, mode: 'insensitive' } },
      include: { tokenMetrics: { orderBy: { timestamp: 'desc' }, take: 1 } },
      orderBy: { updatedAt: 'desc' },
    });
    const metric = token?.tokenMetrics[0];
    const marketPrice = toNumber(metric?.priceUsd);
    if (!token || !metric || marketPrice === null || marketPrice <= 0 || Date.now() - metric.timestamp.getTime() > env.MARKET_DATA_STALE_AFTER_MS) {
      return errorResponse(res, 409, 'Nincs friss piaci ár ehhez a tokenhez');
    }

    if (side === 'sell') {
      const open = await prisma.position.findFirst({ where: { userId, tokenId: token.id, status: 'OPEN', mode: 'PAPER' } });
      if (!open) return errorResponse(res, 404, 'Nincs nyitott Paper pozíció ehhez a tokenhez');
      const closed = await prisma.$transaction((transaction) => closePaperPosition(transaction, { positionId: open.id, userId, exitPrice: marketPrice, exitReason: 'SIMULATED_SELL' }));
      if (!closed) return errorResponse(res, 409, 'A pozíció már nincs nyitva');
      await logAuditEvent('paper_trade_simulated', userId, { side, positionId: open.id, mode: 'PAPER' });
      return res.json({ ok: true, simulated: true, mode: 'PAPER', order: { id: closed.tradeId, symbol: token.symbol, side, amount, status: 'FILLED', message: 'Paper pozíció lezárva.' } });
    }

    const slippagePercent = 0.4;
    const executionPrice = marketPrice * (1 + slippagePercent / 100);
    const notionalUsd = amount;
    const feeUsd = paperFee(notionalUsd);
    const quantity = notionalUsd / executionPrice;
    const riskConfig = await prisma.riskConfig.findUnique({ where: { userId } });
    const stopLossPercent = toNumber(riskConfig?.stopLossPercent) ?? 0;
    const takeProfitPercent = toNumber(riskConfig?.takeProfitPercent) ?? 0;
    const trailingStopPercent = toNumber(riskConfig?.trailingStopPercent) ?? 0;

    const order = await prisma.$transaction(async (transaction) => {
      await debitPaperCash(transaction, account.id, notionalUsd, feeUsd);
      const created = await transaction.paperOrder.create({
        data: {
          paperAccountId: account.id,
          userId,
          tokenAddress: token.address,
          symbol: token.symbol,
          side: 'BUY',
          strategyName: 'SIMULATED_PAPER',
          status: 'FILLED',
          requestedNotionalUsd: new Prisma.Decimal(notionalUsd),
          filledNotionalUsd: new Prisma.Decimal(notionalUsd),
          quantity: new Prisma.Decimal(quantity),
          executionPriceUsd: new Prisma.Decimal(executionPrice),
          feeUsd: new Prisma.Decimal(feeUsd),
          slippageUsd: new Prisma.Decimal((notionalUsd * slippagePercent) / 100),
          partialFillRatio: new Prisma.Decimal(1),
          metadata: { source: 'paper_route', correlationId: req.correlationId },
        },
      });
      await transaction.paperFill.create({
        data: { paperOrderId: created.id, tokenAddress: token.address, symbol: token.symbol, quantity: new Prisma.Decimal(quantity), priceUsd: new Prisma.Decimal(executionPrice), notionalUsd: new Prisma.Decimal(notionalUsd), feeUsd: new Prisma.Decimal(feeUsd), slippageUsd: new Prisma.Decimal((notionalUsd * slippagePercent) / 100) },
      });
      const position = await transaction.position.create({
        data: {
          userId,
          tokenId: token.id,
          side: 'BUY',
          quantity: new Prisma.Decimal(quantity),
          avgEntryPrice: new Prisma.Decimal(executionPrice),
          currentPrice: new Prisma.Decimal(marketPrice),
          stopLossPrice: stopLossPercent > 0 ? new Prisma.Decimal(marketPrice * (1 - stopLossPercent / 100)) : null,
          takeProfitPrice: takeProfitPercent > 0 ? new Prisma.Decimal(marketPrice * (1 + takeProfitPercent / 100)) : null,
          trailingStopPercent: trailingStopPercent > 0 ? new Prisma.Decimal(Math.min(0.9999, trailingStopPercent / 100)) : null,
          highestPrice: new Prisma.Decimal(marketPrice),
          lowestPrice: new Prisma.Decimal(marketPrice),
          unrealizedPnl: new Prisma.Decimal(0),
          realizedPnl: new Prisma.Decimal(0),
          mode: 'PAPER',
        },
      });
      await transaction.trade.create({
        data: { userId, tokenId: token.id, positionId: position.id, side: 'BUY', tokenAddress: token.address, symbol: token.symbol, strategyName: 'SIMULATED_PAPER', entry: new Prisma.Decimal(executionPrice), size: new Prisma.Decimal(notionalUsd), quantity: new Prisma.Decimal(quantity), fees: new Prisma.Decimal(feeUsd), slippage: new Prisma.Decimal((notionalUsd * slippagePercent) / 100), entryAt: new Date(), mode: 'PAPER', status: 'OPEN' },
      });
      await recomputePaperAccount(transaction, userId);
      return created;
    });

    await logAuditEvent('paper_trade_simulated', userId, { orderId: order.id, side, mode: 'PAPER' });
    monitoring.record('TRADE_OPENED', { symbol, side, amount, mode: 'PAPER' }, req.correlationId);
    void safeNotify('TRADE_OPENED', { symbol, side, amount, mode: 'PAPER' }, req.correlationId);

    return res.json({ ok: true, simulated: true, mode: 'PAPER', order: { id: order.id, symbol: token.symbol, side, amount, status: 'FILLED', message: 'Paper vétel végrehajtva.' } });
  } catch (error) {
    if (error instanceof InsufficientPaperCashError) return errorResponse(res, 409, 'Nincs elég paper egyenleg');
    logger.error({ err: error }, 'Failed to simulate paper trade');
    return errorResponse(res, 500, 'Unable to simulate paper trade');
  }
});

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  logger.error({ err }, 'Unhandled API error');
  return errorResponse(res, 500, 'Internal server error');
});

export { app };
