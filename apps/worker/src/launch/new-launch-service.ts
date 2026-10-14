import { Prisma, type PrismaClient } from '@prisma/client';
import type { TokenDataProvider } from '@soltrader/market-data';
import { assessRisk, type RiskFactorInput } from '@soltrader/risk-engine';
import { buyerTrendFromObservations, evaluateNewLaunch, mlEntrySafetyBlockers, socialBlocksEntry, evaluateQualityGate, socialSummary, type LaunchSecurity, type LaunchState, type NewLaunchStrategyResult, type QualityGateResult, type SocialSnapshotResult } from '@soltrader/strategy-engine';
import { toRiskEngineConfig } from '@soltrader/token-discovery';

import { buildLaunchMlSnapshot, ML_REFERENCE_ORDER_USD } from '../ml/launch-snapshot.js';
import { DEFAULT_ML_PAPER_CONFIG, type MlPaperEntryEngine, type MlPaperUserConfig, toMlPaperConfig } from '../ml/ml-paper-engine.js';
import type { MlShadowService } from '../ml/ml-shadow-service.js';
import { inRejectedSample, type SocialService } from '../social/social-service.js';
import type { TradingLoopLogger } from '../trading-loop.js';
import { loadActiveUserRiskSettings } from '../user-risk-settings.js';

import { LaunchTracker, type LaunchQuote, type TrackedLaunch } from './launch-tracker.js';
import { type LaunchEvent, type LaunchProviderStatus, type NewLaunchProvider, WSOL_MINT } from './providers.js';
import { resolveNewLaunchSettings, type ResolvedNewLaunchSettings } from './settings.js';
import type { TradeCandleAggregator } from './trade-candles.js';

export { resolveNewLaunchSettings };

export const NEW_LAUNCH_STRATEGY = 'NewLaunchStrategy';
/** Risk-engine hard blocks that the launch policy handles as "wait" while the launch window is open. */
const LAUNCH_WAITABLE_BLOCKS = new Set(['LIQUIDITY_BELOW_ABSOLUTE_MINIMUM', 'EXTREME_PRICE_IMPACT', 'MARKET_DATA_UNAVAILABLE']);
/** Reasons after which a candidate is not re-evaluated for that user. */
/** Latest ML prediction point (AGE_60S) + tolerance + max. decision window, with margin. */
const ML_EVALUATION_WINDOW_MS = 120_000;

/** DEFAULT optional filters as comparison flags next to an ML decision (never a veto in ML mode). */
function defaultFilterComparison(gate: QualityGateResult, user: UserContext, social: SocialSnapshotResult | null) {
  const flags: string[] = [];
  if (gate.blocksEntry) flags.push('COMPARE_QUALITY_GATE_WOULD_BLOCK');
  if (socialBlocksEntry({ decision: 'BUY', mode: user.settings.socialDecisionMode, shadowDecision: social?.shadowDecision })) flags.push('COMPARE_SOCIAL_WOULD_AVOID');
  return flags;
}

const STICKY_REASONS = new Set(['LAUNCH_WINDOW_EXPIRED', 'CREATOR_SELLING', 'LAUNCH_EXHAUSTED', 'CRITICAL_LIQUIDITY', 'RISK_SCORE_ABOVE_LAUNCH_MAXIMUM', 'LIQUIDITY_ABOVE_MAXIMUM']);

export interface NewLaunchStore {
  set(key: string, value: string, options?: { EX?: number }): Promise<unknown>;
  incrBy(key: string, amount: number): Promise<number>;
  expire(key: string, seconds: number): Promise<unknown>;
}

export interface NewLaunchServiceDependencies {
  prisma: PrismaClient;
  providers: NewLaunchProvider[];
  marketData: TokenDataProvider;
  /** Mint account lookup (authorities, token program, extensions). */
  getMintInfo?: (mint: string) => Promise<{ mintAuthority: string | null; freezeAuthority: string | null; tokenProgram?: string | null; extensions?: string[] } | null>;
  /** Reported when a security lookup failed on every RPC provider (RPC observability). */
  onSecurityDataUnavailable?: () => void;
  store: NewLaunchStore;
  logger: TradingLoopLogger;
  publish: (payload: Record<string, unknown>) => Promise<void>;
  /** Social Intelligence (optional; shadow features, never on the exit path, never awaited at decision time). */
  social?: Pick<SocialService, 'track' | 'assess' | 'latest'>;
  /**
   * Machine Learning SHADOW observer (learning pipeline). Receives copies of data only; every call is synchronous,
   * wrapped (failures isolated) and nothing is awaited: it cannot change or delay any trading decision.
   */
  ml?: Pick<MlShadowService, 'attach' | 'onTrade' | 'onComplete' | 'onEvaluation' | 'onTick' | 'onStreamDown' | 'onStreamUp'>;
  /**
   * ML PAPER entry engine (users who selected the ML strategy only). Replaces the strategic entry signal; every safety
   * rule stays mandatory. Fail-closed: any ML failure means no entry for that candidate (no fallback buy).
   */
  mlPaper?: Pick<MlPaperEntryEngine, 'step' | 'markSignaled' | 'resolved'>;
  /** Real-trade OHLCV for the charts (display only; synchronous, isolated, never affects trading). */
  candles?: Pick<TradeCandleAggregator, 'record'>;
  tickMs?: number;
  now?: () => number;
}

interface UserContext {
  userId: string;
  settings: ResolvedNewLaunchSettings;
  riskPolicy: string;
  riskConfig: ReturnType<typeof toRiskEngineConfig> | null;
  intendedOrderUsd: number | null;
  /** Entry strategy of this user: DEFAULT (rule-based) or ML (approved model). Exactly one of them can buy. */
  strategy: MlPaperUserConfig;
}

interface DecisionMemory {
  decision: string;
  status: string;
  reasonKey: string;
  sticky: boolean;
  signaled: boolean;
  decisionId: string | null;
}

interface SecurityMemory {
  security: LaunchSecurity;
  completedAt: number | null;
  nextCheckAt: number;
  failures?: number;
}


const dayKey = (now: number) => new Date(now).toISOString().slice(0, 10);

/**
 * New Launch / Sniper orchestration (PAPER only): providers -> tracker (2 s observations) -> security + risk ->
 * NewLaunchStrategy per user -> idempotent BUY signal. Orders are only created by the PAPER execution engine.
 */
export class NewLaunchService {
  readonly tracker: LaunchTracker;
  private timer: ReturnType<typeof globalThis.setInterval> | undefined;
  private ticking = false;
  private readonly decisions = new Map<string, DecisionMemory>();
  private readonly security = new Map<string, SecurityMemory>();
  private readonly candidateIds = new Map<string, string>();
  private readonly lastPersistedSnapshot = new Map<string, number>();
  private readonly lastExternalFetch = new Map<string, number>();
  private readonly persistedSecurity = new Map<string, string>();
  private userCache: { at: number; users: UserContext[] } | null = null;
  private solPriceAt = 0;
  private lastKeepAliveAt = 0;
  private lastCleanupAt = 0;

  private mlFailures = 0;

  constructor(private readonly deps: NewLaunchServiceDependencies) {
    // Tokens stay tracked a little longer than the longest possible launch window.
    this.tracker = new LaunchTracker(10 * 60_000);
    this.mlSafe(() => this.deps.ml?.attach({
      launches: () => [...this.tracker.launches.values()].map((launch) => ({
        mint: launch.mint, source: launch.source, detectedAt: launch.detectedAt, createdAt: launch.createdAt, firstTradeAt: launch.firstTradeAt,
        creator: launch.creator, hasStream: Boolean(launch.wallets), migrated: launch.migrated,
      })),
      state: (mint, referenceOrderUsd) => this.tracker.state(mint, referenceOrderUsd),
      impact: (mint, referenceOrderUsd) => this.tracker.state(mint, referenceOrderUsd)?.priceImpactPercent ?? null,
      security: (mint) => {
        const memory = this.security.get(mint);
        return memory ? { security: memory.security, completedAt: memory.completedAt } : null;
      },
      candidateId: async (mint) => {
        const launch = this.tracker.launches.get(mint);
        if (launch) return this.ensureCandidate(launch);
        const row = await this.deps.prisma.launchCandidate.findUnique({ where: { mint }, select: { id: true } });
        if (!row) throw new Error('Launch candidate not found');
        return row.id;
      },
    }));
  }

  /** ML hooks are best effort: an exception is counted and logged rarely, never propagated to trading. */
  private mlSafe(run: () => void) {
    if (!this.deps.ml) return;
    try {
      run();
    } catch (error) {
      this.mlFailures += 1;
      if (this.mlFailures % 100 === 1) this.deps.logger.warn({ err: error instanceof Error ? error.message : String(error), failures: this.mlFailures }, 'ML shadow hook failed (trading unaffected)');
    }
  }

  private now() {
    return this.deps.now?.() ?? Date.now();
  }

  start() {
    for (const provider of this.deps.providers) {
      try {
        provider.subscribe({
          onLaunch: (event) => void this.onLaunch(event),
          onTrade: (trade) => {
            this.tracker.onTrade(trade);
            this.mlSafe(() => this.deps.ml?.onTrade(trade, this.tracker.solPriceUsd));
            try {
              this.deps.candles?.record(trade, this.tracker.solPriceUsd);
            } catch {
              // chart data never affects trading
            }
          },
          onComplete: (mint) => {
            this.tracker.onComplete(mint);
            this.mlSafe(() => this.deps.ml?.onComplete(mint));
          },
          onStreamStatus: (state, at) => this.mlSafe(() => (state === 'DOWN' ? this.deps.ml?.onStreamDown(at) : this.deps.ml?.onStreamUp(at))),
        });
      } catch (error) {
        this.deps.logger.warn({ err: error instanceof Error ? error.message : String(error), source: provider.source }, 'New launch provider failed to start');
      }
    }
    this.timer = globalThis.setInterval(() => void this.tick(), this.deps.tickMs ?? 2_000);
  }

  stop() {
    if (this.timer) globalThis.clearInterval(this.timer);
    for (const provider of this.deps.providers) provider.unsubscribe();
  }

  providerStatuses(): LaunchProviderStatus[] {
    return this.deps.providers.map((provider) => provider.healthCheck());
  }

  /** Event-driven price feed (hot exit monitor). */
  onPriceEvent(listener: Parameters<LaunchTracker['onPriceEvent']>[0]) {
    return this.tracker.onPriceEvent(listener);
  }

  latestEvent(mint: string) {
    return this.tracker.latestEvent(mint);
  }

  /** Live quote for PAPER execution / position monitoring of launch tokens. */
  quote(mint: string, maxAgeMs?: number): LaunchQuote | null {
    return this.tracker.quote(mint, maxAgeMs);
  }

  async onLaunch(event: LaunchEvent) {
    if (!this.tracker.add(event)) return;
    const day = dayKey(this.now());
    await this.deps.store.incrBy(`newlaunch:stats:${day}:detected`, 1).catch(() => 0);
    if (event.createdAt) {
      const latency = Math.max(0, event.detectedAt - event.createdAt);
      await this.deps.store.incrBy(`newlaunch:stats:${day}:latencyMs`, Math.round(latency)).catch(() => 0);
      await this.deps.store.incrBy(`newlaunch:stats:${day}:latencyCount`, 1).catch(() => 0);
    }
    for (const key of ['detected', 'latencyMs', 'latencyCount']) await this.deps.store.expire(`newlaunch:stats:${day}:${key}`, 3 * 86_400).catch(() => undefined);
  }

  private async users(): Promise<UserContext[]> {
    const now = this.now();
    if (this.userCache && now - this.userCache.at < 10_000) return this.userCache.users;
    const configs = await this.deps.prisma.newLaunchConfig.findMany({ where: { enabled: true } }).catch(() => []);
    if (configs.length === 0) {
      this.userCache = { at: now, users: [] };
      return [];
    }
    const scanSettings = await loadActiveUserRiskSettings(this.deps.prisma).catch(() => []);
    // Strategy selection; unreadable -> treated as ML without a model (no entries at all), never as DEFAULT buying.
    let strategies: Map<string, MlPaperUserConfig> | null = null;
    try {
      const rows = await this.deps.prisma.mlPaperSettings.findMany({ where: { userId: { in: configs.map((config) => config.userId) } } });
      strategies = new Map((rows ?? []).map((row) => [row.userId, toMlPaperConfig(row)]));
    } catch (error) {
      this.deps.logger.warn({ err: error instanceof Error ? error.message : String(error) }, 'Strategy selection unreadable: New Launch entries paused this cycle');
    }
    const users: UserContext[] = [];
    for (const config of configs) {
      const scan = scanSettings.find((entry) => entry.userId === config.userId);
      // Only users whose bot runs in PAPER mode without emergency stop (the risk settings query applies that).
      const bot = await this.deps.prisma.botConfig.findUnique({ where: { userId: config.userId }, select: { tradingMode: true } });
      if (!scan || bot?.tradingMode !== 'PAPER') continue;
      const account = await this.deps.prisma.paperAccount.findUnique({ where: { userId: config.userId }, select: { equity: true } }).catch(() => null);
      const settings = resolveNewLaunchSettings(config as unknown as Record<string, unknown>);
      const strategy = strategies ? strategies.get(config.userId) ?? DEFAULT_ML_PAPER_CONFIG : { ...DEFAULT_ML_PAPER_CONFIG, mode: 'ML' as const };
      users.push({ userId: config.userId, settings, riskPolicy: scan.riskPolicy, riskConfig: toRiskEngineConfig(scan), intendedOrderUsd: account ? Number(account.equity) * settings.maxPositionPercent / 100 : null, strategy });
    }
    this.userCache = { at: now, users };
    return users;
  }

  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    const now = this.now();
    try {
      if (now - this.solPriceAt > 60_000) {
        const sol = await this.deps.marketData.getTokenMetrics(WSOL_MINT).catch(() => null);
        this.tracker.setSolPrice(sol?.priceUsd ?? null);
        this.solPriceAt = now;
      }
      await this.refreshKeepAlive(now);
      await this.refreshExternal(now);
      this.tracker.observe(now);
      const users = await this.users();
      for (const launch of this.tracker.launches.values()) {
        if (users.length === 0) break;
        // ML users are evaluated at least until their model's snapshot point + decision window has passed (independent of
        // the DEFAULT max. age setting).
        const maxWindow = Math.max(...users.map((user) => user.settings.maxAgeSeconds * 1000 + 30_000), users.some((user) => user.strategy.mode === 'ML') ? ML_EVALUATION_WINDOW_MS : 0);
        if (now - (launch.createdAt ?? launch.detectedAt) > maxWindow) continue;
        if (launch.buyCount + launch.sellCount === 0 && !launch.external) continue;
        await this.evaluateLaunch(launch, users, now).catch((error: unknown) => this.deps.logger.warn({ err: error instanceof Error ? error.message : String(error), mint: launch.mint }, 'New launch evaluation failed'));
      }
      await this.publishLive(now, users);
      // Learning pipeline (shadow): snapshots / outcome bookkeeping after all trading work of this tick.
      this.mlSafe(() => this.deps.ml?.onTick(now));
      if (now - this.lastCleanupAt > 10 * 60_000) await this.cleanup(now);
    } catch (error) {
      this.deps.logger.error({ err: error instanceof Error ? error.message : String(error) }, 'New launch tick failed');
    } finally {
      this.ticking = false;
    }
  }

  /** Open NEW_LAUNCH positions keep their tokens tracked (also re-created after a worker restart). */
  private async refreshKeepAlive(now: number) {
    if (now - this.lastKeepAliveAt < 10_000) return;
    this.lastKeepAliveAt = now;
    const open = await this.deps.prisma.trade.findMany({ where: { decisionSource: 'NEW_LAUNCH', status: 'OPEN' }, select: { tokenAddress: true } }).catch(() => []);
    const mints = new Set(open.map((trade) => trade.tokenAddress));
    for (const mint of mints) {
      const candidate = await this.deps.prisma.launchCandidate.findUnique({ where: { mint } }).catch(() => null);
      this.tracker.keep(mint, candidate ? { source: candidate.source as LaunchEvent['source'], detectedAt: candidate.detectedAt.getTime(), createdAt: candidate.createdAt?.getTime() ?? null, bondingCurve: candidate.bondingCurve, poolAddress: candidate.poolAddress, creator: candidate.creator, name: candidate.name, symbol: candidate.symbol } : {});
    }
    this.tracker.release(mints);
  }

  /** Sources without a trade stream (Raydium) get market-data snapshots every 6 s. */
  private async refreshExternal(now: number) {
    for (const launch of this.tracker.launches.values()) {
      if (launch.wallets) continue;
      if (now - (this.lastExternalFetch.get(launch.mint) ?? 0) < 6_000) continue;
      this.lastExternalFetch.set(launch.mint, now);
      const snapshot = await this.deps.marketData.getTokenMetrics(launch.mint).catch(() => null);
      if (!snapshot?.priceUsd) continue;
      this.tracker.setExternal(launch.mint, { priceUsd: snapshot.priceUsd, liquidityUsd: snapshot.liquidityUsd ?? null, buyCount: snapshot.buyCount5m ?? 0, sellCount: snapshot.sellCount5m ?? 0, volumeUsd: snapshot.volume5m ?? 0, at: now });
      if (!launch.symbol && snapshot.metadata.symbol) launch.symbol = snapshot.metadata.symbol;
    }
  }

  private async securityFor(launch: TrackedLaunch, minObservedSellers: number, now: number): Promise<SecurityMemory> {
    const state = this.tracker.state(launch.mint, null);
    const sellers = state?.observedSellers ?? null;
    let memory = this.security.get(launch.mint);
    if (!memory) {
      memory = { security: { sellability: 'NOT_VERIFIED', mintAuthorityRevoked: null, freezeAuthorityRevoked: null, tokenProgram: null, extensions: null, hardBlockReasons: [], warnings: [] }, completedAt: null, nextCheckAt: now };
      this.security.set(launch.mint, memory);
    }
    // Sellability is verified only by real, successful sells from wallets other than the creator.
    memory.security.sellability = sellers !== null && sellers >= Math.max(1, minObservedSellers) ? 'VERIFIED' : 'NOT_VERIFIED';
    if (memory.security.mintAuthorityRevoked === null && this.deps.getMintInfo && now >= memory.nextCheckAt) {
      try {
        const info = await this.deps.getMintInfo(launch.mint);
        if (info) {
          memory.security.mintAuthorityRevoked = info.mintAuthority === null;
          memory.security.freezeAuthorityRevoked = info.freezeAuthority === null;
          memory.security.tokenProgram = info.tokenProgram === 'spl-token-2022' ? 'spl-token-2022' : info.tokenProgram === 'spl-token' ? 'spl-token' : null;
          memory.security.extensions = info.extensions ?? [];
          memory.security.rpcUnavailable = false;
          memory.completedAt = now;
        } else {
          memory.nextCheckAt = now + 10_000;
        }
      } catch (error) {
        // The mint account can lag the create event on the RPC node: retry soon, log each mint's first failure only.
        if (memory.nextCheckAt <= now && !memory.failures) this.deps.logger.warn({ mint: launch.mint, err: error instanceof Error ? error.message : String(error) }, 'new_launch_mint_info_failed');
        memory.failures = (memory.failures ?? 0) + 1;
        memory.nextCheckAt = now + Math.min(10_000, 2_000 * memory.failures);
        // Every provider failed: the authorities stay UNKNOWN (never assumed revoked) -> WATCH with an explicit reason.
        if ((error as { name?: string })?.name === 'RpcAllProvidersFailedError') {
          memory.security.rpcUnavailable = true;
          this.deps.onSecurityDataUnavailable?.();
        }
      }
    }
    return memory;
  }

  private riskFor(launch: TrackedLaunch, result: { liquidityUsd: number | null; ageSeconds: number; volumeUsd: number; transactionCount: number; impact: number | null; largestHolder: number | null; largestBuyer: number | null; volatility: number | null; priceUsd: number | null }, security: LaunchSecurity, user: UserContext) {
    if (result.priceUsd === null || result.liquidityUsd === null) return { riskScore: null, classification: null, hardBlockReasons: [] as string[], positionMultiplier: 0, warnings: [] as string[], factors: {} };
    const input: RiskFactorInput = {
      address: launch.mint,
      liquidityUsd: result.liquidityUsd,
      // A bonding curve's liquidity is program-owned (nobody can pull it); for pools the LP ownership is unknown.
      liquidityConcentrationPercent: launch.wallets ? 0 : 50,
      tokenAgeSeconds: result.ageSeconds,
      poolAgeSeconds: result.ageSeconds,
      volume24h: result.volumeUsd,
      transactionCount: result.transactionCount,
      slippageEstimatePercent: result.impact ?? user.settings.maxPriceImpactPercent,
      holderConcentrationPercent: result.largestHolder !== null ? result.largestHolder * 100 : 50,
      topHolderConcentrationPercent: result.largestHolder !== null ? result.largestHolder * 100 : 50,
      authority: { mintAuthorityRevoked: security.mintAuthorityRevoked === true, freezeAuthorityRevoked: security.freezeAuthorityRevoked === true, metadataMutable: false },
      metadataAnomalyDetected: false,
      volatilityPercent: result.volatility ?? 0,
      abnormalTradingActivity: result.largestBuyer !== null && result.largestBuyer > 0.6,
      sellability: security.sellability === 'VERIFIED' ? { checked: true, canSell: true } : undefined,
      marketDataAvailable: true,
      marketDataStale: false,
      poolValid: true,
      executionRouteAvailable: true,
      executionPriceAvailable: result.priceUsd > 0,
      tokenDataValid: true,
    };
    const assessment = assessRisk(input, user.riskConfig ?? undefined);
    return {
      riskScore: assessment.riskScore,
      classification: assessment.classification,
      hardBlockReasons: assessment.hardBlockReasons.filter((reason) => !LAUNCH_WAITABLE_BLOCKS.has(reason)),
      positionMultiplier: assessment.positionMultiplier,
      warnings: assessment.warnings as string[],
      factors: assessment.factors as unknown as Record<string, number>,
    };
  }

  private async ensureCandidate(launch: TrackedLaunch) {
    const cached = this.candidateIds.get(launch.mint);
    if (cached) return cached;
    const row = await this.deps.prisma.launchCandidate.upsert({
      where: { mint: launch.mint },
      update: {},
      create: {
        mint: launch.mint, source: launch.source, poolAddress: launch.poolAddress, bondingCurve: launch.bondingCurve, quoteMint: launch.quoteMint,
        creator: launch.creator, name: launch.name, symbol: launch.symbol, detectedAt: new Date(launch.detectedAt),
        createdAt: launch.createdAt ? new Date(launch.createdAt) : null, firstTradableAt: launch.firstTradeAt ? new Date(launch.firstTradeAt) : null,
        detectedPriceUsd: launch.detectedPriceUsd !== null ? new Prisma.Decimal(launch.detectedPriceUsd) : null,
        initialLiquidityUsd: launch.observations[0]?.liquidityUsd != null ? new Prisma.Decimal(launch.observations[0].liquidityUsd) : null,
      },
      select: { id: true },
    });
    this.candidateIds.set(launch.mint, row.id);
    return row.id;
  }

  private async persistSnapshot(launch: TrackedLaunch, candidateId: string, dataQuality: number, now: number) {
    if (now - (this.lastPersistedSnapshot.get(launch.mint) ?? 0) < 6_000) return;
    const observation = launch.observations.at(-1);
    if (!observation) return;
    this.lastPersistedSnapshot.set(launch.mint, now);
    const state = this.tracker.state(launch.mint, null);
    const decimal = (value: number | null | undefined) => (value === null || value === undefined || !Number.isFinite(value) ? null : new Prisma.Decimal(value));
    await this.deps.prisma.launchSnapshot.create({
      data: {
        candidateId, takenAt: new Date(observation.takenAt), priceUsd: decimal(observation.priceUsd), liquidityUsd: decimal(observation.liquidityUsd),
        volumeUsd: decimal(observation.volumeUsd), buyCount: observation.buyCount, sellCount: observation.sellCount,
        buyVolumeUsd: decimal(observation.buyVolumeUsd), sellVolumeUsd: decimal(observation.sellVolumeUsd),
        uniqueBuyers: observation.uniqueBuyers, uniqueSellers: observation.uniqueSellers, largestBuyerShare: decimal(state?.largestBuyerShare),
        marketCapUsd: launch.wallets && observation.priceUsd ? decimal(observation.priceUsd * 1_000_000_000) : null, dataQuality,
      },
    });
  }

  private async evaluateLaunch(launch: TrackedLaunch, users: UserContext[], now: number) {
    let candidateId: string | null = null;
    for (const user of users) {
      const key = `${user.userId}:${launch.mint}`;
      const memory = this.decisions.get(key);
      const mlUser = user.strategy.mode === 'ML';
      // ML users: the rule-based memory must not stop the (single) ML decision for this candidate.
      if ((memory?.sticky || memory?.signaled) && (!mlUser || this.deps.mlPaper?.resolved(user.userId, launch.mint) !== false)) continue;
      const security = await this.securityFor(launch, user.settings.minObservedSellers, now);
      const state = this.tracker.state(launch.mint, user.intendedOrderUsd);
      if (!state) continue;
      const preliminary = evaluateNewLaunch(state, security.security, { riskScore: null, classification: null, hardBlockReasons: [] }, user.settings, now);
      const f = preliminary.features;
      const risk = this.riskFor(launch, { liquidityUsd: f.liquidityUsd, ageSeconds: f.ageSeconds, volumeUsd: f.volumeUsd, transactionCount: f.transactionCount, impact: f.estimatedPriceImpact, largestHolder: f.largestHolderSupplyShare, largestBuyer: f.largestBuyerShare, volatility: f.launchVolatility, priceUsd: f.priceUsd }, security.security, user);
      const result = evaluateNewLaunch(state, security.security, risk, user.settings, now);
      candidateId ??= await this.ensureCandidate(launch);
      // Persist the latest security facts (shown on the token/position pages; unknown stays null).
      const securityKey = JSON.stringify(security.security);
      if (this.persistedSecurity.get(launch.mint) !== securityKey) {
        this.persistedSecurity.set(launch.mint, securityKey);
        await this.deps.prisma.launchCandidate.update({ where: { id: candidateId }, data: { security: { ...security.security, checkedAt: security.completedAt ? new Date(security.completedAt).toISOString() : null } as unknown as Prisma.InputJsonValue } }).catch(() => undefined);
      }
      await this.persistSnapshot(launch, candidateId, result.dataQuality, now);
      // Social Intelligence: computed from already collected data (no provider request here). MONITOR_ONLY never changes the decision.
      const social = this.socialFor(launch, user, result, now);
      const socialEnforcedBlock = socialBlocksEntry({ decision: result.decision, mode: user.settings.socialDecisionMode, shadowDecision: social?.shadowDecision });
      // Quality gate: only for candidates the strategy decided to BUY (after hard security / risk), before execution.
      const gate = result.decision === 'BUY' ? this.qualityGateFor(result, state, user) : null;
      const reasonKey = `${result.decision}|${result.status}|${result.reasons.join(',')}|${gate ? `${gate.mode}:${gate.reasons.join(',')}` : ''}`;
      // Copy of the decision for the ML learning pipeline (read-only; the decision above is already final).
      this.mlSafe(() => this.deps.ml?.onEvaluation({ userId: user.userId, mint: launch.mint, at: now, decision: result.decision, status: result.status, reasons: result.reasons, score: result.score, riskScore: risk.riskScore, configVersion: user.settings.configVersion ?? null, social }));
      if (mlUser) {
        try {
          await this.mlPaperStep({ launch, user, result, risk, security, state, social, now, getCandidateId: async () => (candidateId ??= await this.ensureCandidate(launch)) });
        } catch (error) {
          // Fail-closed: an ML failure never opens anything and never touches exits.
          this.deps.logger.warn({ err: error instanceof Error ? error.message : String(error), mint: launch.mint, userId: user.userId }, 'ML PAPER step failed: no entry');
        }
      }
      if (memory && memory.reasonKey === reasonKey) continue;
      const decisionRow = await this.deps.prisma.launchDecision.create({
        data: {
          userId: user.userId, candidateId, mint: launch.mint, decision: result.decision, status: result.status, score: result.score,
          launchMomentumScore: result.launchMomentumScore, exhaustionScore: result.exhaustionScore, liquidityScore: result.liquidityScore,
          buyerQualityScore: result.buyerQualityScore, buyPressureScore: result.buyPressureScore, securityScore: result.securityScore,
          dataQuality: result.dataQuality, riskScore: risk.riskScore !== null ? new Prisma.Decimal(risk.riskScore) : null, riskClassification: risk.classification,
          reasons: result.reasons as Prisma.InputJsonValue, warnings: [...new Set([...result.warnings, ...risk.warnings])] as Prisma.InputJsonValue,
          features: result.features as unknown as Prisma.InputJsonValue, detectedAt: new Date(launch.detectedAt),
          securityCompletedAt: security.completedAt ? new Date(security.completedAt) : null,
          configVersion: user.settings.configVersion,
          qualityGateMode: gate?.mode ?? null,
          qualityGateWouldPass: gate?.wouldPass ?? null,
          qualityGateReasons: gate ? gate.reasons as Prisma.InputJsonValue : Prisma.JsonNull,
          socialSummary: social || user.settings.socialIntelligenceEnabled ? { ...socialSummary(social), mode: user.settings.socialDecisionMode, enforcedBlock: socialEnforcedBlock } as Prisma.InputJsonValue : Prisma.JsonNull,
        },
      });
      const sticky = result.status === 'BLOCKED' || result.status === 'EXPIRED' || result.reasons.some((reason) => STICKY_REASONS.has(reason));
      this.decisions.set(key, { decision: result.decision, status: result.status, reasonKey, sticky, signaled: false, decisionId: decisionRow.id });
      this.deps.logger.info({ event: 'new_launch_decision', userId: user.userId, mint: launch.mint, source: launch.source, decision: result.decision, status: result.status, score: result.score, reasons: result.reasons }, 'new_launch_decision');
      await this.deps.publish({ userId: user.userId, event: 'new_launch_decision', mint: launch.mint, symbol: launch.symbol, decision: result.decision, status: result.status, score: result.score, reasons: result.reasons });
      if (gate?.blocksEntry) {
        // ENFORCE_PAPER: the gate removes this entry; the reasons are stored on the decision row.
        this.deps.logger.info({ event: 'new_launch_quality_gate_blocked', userId: user.userId, mint: launch.mint, reasons: gate.reasons }, 'new_launch_quality_gate_blocked');
        continue;
      }
      if (socialEnforcedBlock) {
        // ENFORCE_PAPER only: social can remove an entry (AVOID), never add one or change its size.
        this.deps.logger.info({ event: 'new_launch_social_blocked', userId: user.userId, mint: launch.mint, warnings: social?.warnings }, 'new_launch_social_blocked');
        continue;
      }
      // ML strategy users never get a rule-based entry (one strategy buys, never both).
      if (!mlUser && result.decision === 'BUY' && risk.riskScore !== null && risk.classification) {
        const signalId = await this.createBuySignal(launch, user, result, risk, decisionRow.id, security.completedAt, now, state, security.security, gate, social);
        const current = this.decisions.get(key);
        if (current) current.signaled = Boolean(signalId);
      }
    }
  }

  /** Registers the launch for staged social collection and returns the current social assessment (synchronous). */
  private socialFor(launch: TrackedLaunch, user: UserContext, result: NewLaunchStrategyResult, now: number): SocialSnapshotResult | null {
    const service = this.deps.social;
    if (!service || !user.settings.socialIntelligenceEnabled || user.settings.socialDecisionMode === 'OFF') return null;
    // Stage 3 once a launch passed the basic security / liquidity / age checks; early rejects only via a ~10% sample.
    const early = result.status === 'BLOCKED' || result.reasons.some((reason) => ['LAUNCH_TOO_YOUNG', 'LAUNCH_WINDOW_EXPIRED', 'LIQUIDITY_BELOW_MINIMUM', 'CRITICAL_LIQUIDITY', 'CREATOR_SELLING'].includes(reason));
    const stage = !early ? 3 : inRejectedSample(launch.mint) ? 2 : 1;
    service.track({ mint: launch.mint, symbol: launch.symbol, name: launch.name, metadataUri: launch.metadataUri, stage });
    const f = result.features;
    return service.assess(launch.mint, {
      launchScore: result.score, launchMomentumScore: result.launchMomentumScore, exhaustionScore: result.exhaustionScore,
      buySellRatio: f.buySellRatio, uniqueBuyers: f.uniqueBuyers, buyerTrend: buyerTrendFromObservations(launch.observations, now),
      liquidityChangePercent: f.liquidityChange, priceVelocity: f.priceVelocity, priceExtensionPercent: f.priceChangeSinceDetection,
    }, now);
  }

  private qualityGateFor(result: NewLaunchStrategyResult, state: LaunchState, user: UserContext): QualityGateResult {
    const f = result.features;
    const percent = (share: number | null | undefined) => (share === null || share === undefined ? null : share * 100);
    return evaluateQualityGate({
      launchScore: result.score,
      uniqueBuyers: f.uniqueBuyers,
      liquidityUsd: f.liquidityUsd,
      buySellRatio: f.buySellRatio,
      exhaustionScore: result.exhaustionScore,
      priceImpactPercent: f.estimatedPriceImpact,
      holderConcentrationPercent: percent(f.largestHolderSupplyShare),
      devAllocationPercent: percent(state.creatorHoldingShare),
      dataQuality: result.dataQuality,
    }, user.settings.qualityGate);
  }

  /**
   * ML strategy: the single ML decision at the model's snapshot point, then (ML BUY only) the BUY signal once every
   * mandatory safety rule is green inside the decision window. The rule-based result is used for its safety facts only.
   */
  private async mlPaperStep(context: { launch: TrackedLaunch; user: UserContext; result: NewLaunchStrategyResult; risk: ReturnType<NewLaunchService['riskFor']>; security: SecurityMemory; state: LaunchState; social: SocialSnapshotResult | null; now: number; getCandidateId: () => Promise<string> }) {
    const engine = this.deps.mlPaper;
    const { launch, user, result, risk, security, state, social, now } = context;
    if (!engine) return;
    // Same builder and inputs as the SHADOW collection at this moment (the risk score and social assessment of this
    // evaluation, both computed at `now`): identical features in both pipelines.
    let built: ReturnType<typeof buildLaunchMlSnapshot> | null = null;
    const build = () => (built ??= buildLaunchMlSnapshot({ at: now, launch, state: this.tracker.state(launch.mint, ML_REFERENCE_ORDER_USD), security, riskScore: risk.riskScore, riskObservedAt: now, social }));
    const step = await engine.step({
      userId: user.userId, mint: launch.mint, detectedAt: launch.detectedAt, now, config: user.strategy,
      candidateId: context.getCandidateId,
      buildFeatures: () => build().snapshot,
      eligible: () => build().eligible,
      // Mandatory safety only: the DEFAULT strategy's decision, thresholds, timing window, quality gate and social AVOID
      // never veto an ML BUY (ML-only mode, see ML_IGNORED_DEFAULT_FILTERS).
      safetyBlockers: () => {
        const blockers = mlEntrySafetyBlockers({ result, security: security.security, riskScore: risk.riskScore, riskHardBlockReasons: risk.hardBlockReasons, settings: user.settings, detectedAt: launch.detectedAt, now });
        if (risk.classification === null) blockers.push('RISK_NOT_CLASSIFIED');
        return blockers;
      },
      // Comparison only (stored with the ML decision): what the DEFAULT strategy and its optional filters said at this moment.
      base: { decision: result.decision, reasons: [...result.reasons, ...defaultFilterComparison(this.qualityGateFor(result, state, user), user, social)] },
    });
    if (step.action !== 'SIGNAL') return;
    const candidateId = await context.getCandidateId();
    const decisionRow = await this.deps.prisma.launchDecision.findFirst({ where: { userId: user.userId, candidateId }, orderBy: { decisionAt: 'desc' }, select: { id: true } }).catch(() => null);
    // Stored for comparison only; PAPER execution never applies the DEFAULT quality gate to an ML entry.
    const gate = { ...this.qualityGateFor(result, state, user), appliesToEntry: false };
    const signalId = await this.createBuySignal(launch, user, result, risk, decisionRow?.id ?? null, security.completedAt, now, state, security.security, gate, social, {
      entryStrategy: 'ML', decisionId: step.decisionId, modelVersion: step.modelVersion, probability: step.probability, threshold: step.threshold,
      snapshotKind: step.snapshotKind, snapshotAt: new Date(step.snapshotAt).toISOString(), featureHash: step.featureHash,
    });
    await engine.markSignaled(user.userId, launch.mint, signalId, now);
    if (signalId) this.deps.logger.info({ event: 'ml_paper_buy_signal', userId: user.userId, mint: launch.mint, modelVersion: step.modelVersion, probability: step.probability, threshold: step.threshold }, 'ml_paper_buy_signal');
  }

  /** Idempotent: at most one NEW_LAUNCH BUY signal per user and mint (whichever strategy made it). */
  private async createBuySignal(launch: TrackedLaunch, user: UserContext, result: NewLaunchStrategyResult, risk: ReturnType<NewLaunchService['riskFor']>, decisionId: string | null, securityCompletedAt: number | null, now: number, state: LaunchState, security: LaunchSecurity, gate: QualityGateResult | null, social: SocialSnapshotResult | null = null, ml: Record<string, unknown> | null = null) {
    const token = await this.deps.prisma.token.upsert({
      where: { address: launch.mint },
      update: {},
      create: { address: launch.mint, symbol: launch.symbol || launch.mint.slice(0, 6), name: launch.name },
      select: { id: true },
    });
    const existing = await this.deps.prisma.signal.findFirst({ where: { userId: user.userId, tokenId: token.id, strategyName: NEW_LAUNCH_STRATEGY, direction: 'BUY' }, select: { id: true } });
    // An ML BUY never piggybacks on an older signal: it reports "not created" and stays unexecuted.
    if (existing) return ml ? null : existing.id;
    const strategy = await this.deps.prisma.strategy.upsert({ where: { name: NEW_LAUNCH_STRATEGY }, update: {}, create: { name: NEW_LAUNCH_STRATEGY, type: 'new-launch', mode: 'SCANNER', isEnabled: true } });
    const f = result.features;
    const signal = await this.deps.prisma.signal.create({
      data: {
        tokenId: token.id, userId: user.userId, strategyId: strategy.id, strategyName: NEW_LAUNCH_STRATEGY, direction: 'BUY',
        score: new Prisma.Decimal(result.score ?? 0), riskScore: new Prisma.Decimal(risk.riskScore ?? 0), signalType: 'NEW_LAUNCH', mode: 'SCANNER',
        reasons: result.reasons as Prisma.InputJsonValue, entryConditions: ['all launch conditions met', 'sellability verified', 'no hard block'] as Prisma.InputJsonValue, invalidationConditions: [] as Prisma.InputJsonValue,
        metadata: {
          decisionSource: 'NEW_LAUNCH', primaryStrategy: NEW_LAUNCH_STRATEGY,
          // Which strategy initiated the entry (immutable origin): DEFAULT rule-based or ML model.
          entryStrategy: ml ? 'ML' : 'DEFAULT', ml,
          riskClassification: risk.classification, hardBlocked: false, hardBlockReasons: [], riskPolicy: user.riskPolicy,
          riskPositionMultiplier: risk.positionMultiplier, riskWarnings: risk.warnings, riskFactors: risk.factors,
          exhaustionBlocked: false, criticalLiquidityOutflow: false,
          launch: {
            decisionId, source: launch.source, mint: launch.mint, bondingCurve: launch.bondingCurve, poolAddress: launch.poolAddress,
            detectedAt: new Date(launch.detectedAt).toISOString(), createdAt: launch.createdAt ? new Date(launch.createdAt).toISOString() : null,
            securityCompletedAt: securityCompletedAt ? new Date(securityCompletedAt).toISOString() : null, decisionAt: new Date(now).toISOString(),
            ageSeconds: f.ageSeconds, detectedPrice: launch.detectedPriceUsd, decisionPrice: f.priceUsd, liquidityUsd: f.liquidityUsd,
            score: result.score, launchMomentumScore: result.launchMomentumScore, exhaustionScore: result.exhaustionScore, liquidityScore: result.liquidityScore,
            buyerQualityScore: result.buyerQualityScore, buyPressureScore: result.buyPressureScore, securityScore: result.securityScore, dataQuality: result.dataQuality,
            uniqueBuyers: f.uniqueBuyers, transactionCount: f.transactionCount, buySellRatio: f.buySellRatio, priceImpactPercent: f.estimatedPriceImpact,
            reasons: result.reasons, warnings: result.warnings,
            configVersion: user.settings.configVersion,
            qualityGate: gate,
            // Immutable social entry snapshot (shadow features; NL-v2 decisions are unchanged in MONITOR_ONLY).
            social: social ? {
              ...socialSummary(social), mode: user.settings.socialDecisionMode, reasons: social.reasons, warnings: social.warnings, components: social.components,
              windows: { '1m': social.windows['1m'] ?? null, '5m': social.windows['5m'] ?? null, '15m': social.windows['15m'] ?? null },
              engagementTrend: social.engagementTrend, authorTrend: social.authorTrend, dataAgeMs: social.dataAgeMs, ambiguousMentions5m: social.ambiguousMentions5m,
            } : { available: false, shadowDecision: 'UNKNOWN', mode: user.settings.socialDecisionMode },
            // Timing of the pipeline (observation length is configured; the rest is infrastructure latency).
            observationStartedAt: launch.observations[0] ? new Date(launch.observations[0].takenAt).toISOString() : null,
            observationCompletedAt: new Date(Math.min(now, launch.detectedAt + user.settings.observationSeconds * 1000)).toISOString(),
            // Entry features exactly as known at decision time; null = not available (never 0 / SAFE by default).
            entryFeatures: {
              tokenAgeSeconds: f.ageSeconds,
              tradableAgeSeconds: launch.firstTradeAt ? Math.max(0, (now - launch.firstTradeAt) / 1000) : null,
              liquidityUsd: f.liquidityUsd,
              marketCapUsd: launch.wallets && f.priceUsd ? f.priceUsd * 1_000_000_000 : null,
              volumeUsd: f.volumeUsd,
              uniqueBuyers: f.uniqueBuyers,
              uniqueSellers: f.uniqueSellers,
              buyCount: launch.observations.at(-1)?.buyCount ?? null,
              sellCount: launch.observations.at(-1)?.sellCount ?? null,
              buySellRatio: f.buySellRatio,
              buyVolumeUsd: launch.observations.at(-1)?.buyVolumeUsd ?? null,
              sellVolumeUsd: launch.observations.at(-1)?.sellVolumeUsd ?? null,
              buyVolumeRatio: f.buyVolumeSellVolumeRatio,
              transactionRate: f.transactionRate,
              priceVelocity: f.priceVelocity,
              volumeVelocity: f.volumeVelocity,
              liquidityChangePercent: f.liquidityChange,
              priceImpactPercent: f.estimatedPriceImpact,
              devAllocationPercent: state.creatorHoldingShare === null || state.creatorHoldingShare === undefined ? null : state.creatorHoldingShare * 100,
              topHolderConcentrationPercent: f.largestHolderSupplyShare === null ? null : f.largestHolderSupplyShare * 100,
              top5ConcentrationPercent: null,
              top10ConcentrationPercent: null,
              largestBuyerShare: f.largestBuyerShare,
              repeatBuyerConcentration: f.buysPerBuyer,
              launchScore: result.score,
              launchMomentumScore: result.launchMomentumScore,
              exhaustionScore: result.exhaustionScore,
              dataQuality: result.dataQuality,
              riskScore: risk.riskScore,
              riskClassification: risk.classification,
              riskMultiplier: risk.positionMultiplier,
              security: { sellability: security.sellability, mintAuthorityRevoked: security.mintAuthorityRevoked, freezeAuthorityRevoked: security.freezeAuthorityRevoked, tokenProgram: security.tokenProgram, extensions: security.extensions },
            },
          },
        } as unknown as Prisma.InputJsonValue,
      },
    });
    if (decisionId) await this.deps.prisma.launchDecision.update({ where: { id: decisionId }, data: { signalId: signal.id } });
    this.deps.logger.info({ event: 'new_launch_buy_signal', userId: user.userId, mint: launch.mint, score: result.score }, 'new_launch_buy_signal');
    return signal.id;
  }

  /** Live monitor list + provider statuses for the dashboard (Redis, short TTL). */
  private async publishLive(now: number, users: UserContext[]) {
    const live = [...this.tracker.launches.values()]
      .filter((launch) => launch.observations.length > 0 && (launch.buyCount + launch.sellCount > 0 || launch.external))
      .sort((a, b) => b.detectedAt - a.detectedAt)
      .slice(0, 80)
      .map((launch) => {
        const observation = launch.observations.at(-1)!;
        return {
          mint: launch.mint, source: launch.source, symbol: launch.symbol, name: launch.name, detectedAt: new Date(launch.detectedAt).toISOString(),
          createdAt: launch.createdAt ? new Date(launch.createdAt).toISOString() : null, ageSeconds: Math.round((now - (launch.createdAt ?? launch.detectedAt)) / 1000),
          priceUsd: observation.priceUsd, liquidityUsd: observation.liquidityUsd, volumeUsd: observation.volumeUsd, buyCount: observation.buyCount,
          sellCount: observation.sellCount, uniqueBuyers: observation.uniqueBuyers, migrated: launch.migrated,
          social: this.deps.social?.latest(launch.mint) ?? null,
        };
      });
    await this.deps.store.set('newlaunch:live', JSON.stringify({ at: new Date(now).toISOString(), launches: live }), { EX: 30 }).catch(() => undefined);
    await this.deps.store.set('newlaunch:providers', JSON.stringify(this.providerStatuses()), { EX: 30 }).catch(() => undefined);
    for (const user of users) await this.deps.publish({ userId: user.userId, event: 'new_launch_updated', count: live.length });
  }

  private async cleanup(now: number) {
    this.lastCleanupAt = now;
    const cutoff = new Date(now - 3 * 86_400_000);
    await this.deps.prisma.launchSnapshot.deleteMany({ where: { takenAt: { lt: cutoff }, candidate: { decisions: { none: { decision: 'BUY' } } } } }).catch(() => undefined);
    for (const [key] of this.decisions) {
      const mint = key.split(':')[1];
      if (!this.tracker.launches.has(mint)) this.decisions.delete(key);
    }
    for (const mint of [...this.security.keys()]) if (!this.tracker.launches.has(mint)) this.security.delete(mint);
    for (const mint of [...this.candidateIds.keys()]) if (!this.tracker.launches.has(mint)) this.candidateIds.delete(mint);
  }
}
