import type { Prisma, PrismaClient } from '@prisma/client';
import {
  calculateHolderConcentrationPercent,
  RPC_PRIORITY,
  RpcAllProvidersFailedError,
  RpcRateLimitError,
  RpcTimeoutError,
  RpcUnavailableError,
  type SolanaMintInfo,
  type SolanaRpcManager,
  type TokenHolder,
} from '@soltrader/blockchain';
import {
  ProviderRequestError,
  type MarketDataCache,
  type MarketDataRepository,
  type TokenDataProvider,
  type TokenMarketSnapshot,
} from '@soltrader/market-data';
import { createCorrelationId, type MonitoringRegistry } from '@soltrader/monitoring';
import { enforceRiskGate } from '@soltrader/risk-engine';
import { buildTokenCandidate, evaluateCandidate, filterCandidateForUser, toRiskEngineConfig } from '@soltrader/token-discovery';

import { loadActiveUserScanSettings, loadMonitoringCapacity } from './scan-config.js';
import { type RotationStatus, TokenRotation } from './token-rotation.js';
import type { TradingLoopLogger } from './trading-loop.js';
import type { SkipRecord, UnbuyableTokenTracker } from './unbuyable-tracker.js';

export interface TokenScannerDependencies {
  prisma: PrismaClient;
  provider: TokenDataProvider;
  /** Shared RPC manager (dedup / cache / batching / priority / failover). */
  rpc?: SolanaRpcManager;
  cache: MarketDataCache;
  repository: MarketDataRepository;
  logger: TradingLoopLogger;
  registry: MonitoringRegistry;
  cacheTtlSeconds: number;
  staleAfterMs: number;
  discoveryLimit: number;
  publishEvent?: (type: 'token_update' | 'risk_update' | 'signal_update' | 'decision_update', payload: Record<string, unknown>) => Promise<void>;
  /** Skips tokens that stayed blocked/unbuyable for the user's configured time. */
  tracker?: UnbuyableTokenTracker;
  onTokenSkipped?: (userId: string, tokenAddress: string, record: SkipRecord) => Promise<void>;
}

export interface ScanCycleSummary {
  discovered: number;
  evaluated: number;
  accepted: number;
  errors: number;
  /** Discovered tokens left out because every scanning user currently skips them. */
  skipped: number;
  /** Size of the rotating candidate pool and how many of its tokens are active / resting / not yet scanned. */
  pool?: Record<string, number>;
}

/** Normalised on-chain enrichment result: what was read, what is UNKNOWN, and why. */
export interface OnchainEnrichment {
  status: 'COMPLETE' | 'PARTIAL' | 'UNAVAILABLE';
  authority: 'AVAILABLE' | 'UNKNOWN';
  holders: 'AVAILABLE' | 'UNKNOWN';
  quality: 'HIGH' | 'MEDIUM' | 'LOW' | 'INSUFFICIENT';
  errors: string[];
  fetchedAt: string;
}

/** Upper bound of tokens requested from the discovery feeds per refresh. */
const DISCOVERY_FETCH_LIMIT = 300;
/**
 * Time budget of one scan pass. The trading loop runs its stages one after another, so an unbounded scan
 * would delay position protection; unfinished tokens simply come first in the next cycle.
 */
const SCAN_TIME_BUDGET_MS = 12_000;

export class TokenScanner {
  private readonly rotation = new TokenRotation();
  private seeded = false;

  constructor(private readonly deps: TokenScannerDependencies) {}

  async runCycle(signal: globalThis.AbortSignal): Promise<ScanCycleSummary> {
    const correlationId = createCorrelationId();
    const summary: ScanCycleSummary = { discovered: 0, evaluated: 0, accepted: 0, errors: 0, skipped: 0 };
    const { logger, registry, provider, prisma } = this.deps;

    // Nobody has the token scanner on: no discovery request, no market-data traffic at all.
    const userSettings = await loadActiveUserScanSettings(prisma);
    if (userSettings.length === 0) {
      logger.info({ correlationId }, 'Token scanner is off for every user; cycle skipped');
      return summary;
    }

    let discovered;
    try {
      discovered = await provider.discoverTokens(DISCOVERY_FETCH_LIMIT);
      registry.setHealth('MARKET DATA', 'HEALTHY');
    } catch (error) {
      summary.errors += 1;
      logger.error({ err: error, correlationId }, 'Token discovery request failed');
      registry.setHealth('MARKET DATA', 'DOWN', { message: error instanceof Error ? error.message : String(error) });
      return summary;
    }
    summary.discovered = discovered.length;

    // Rotating pool: new tokens join from the feeds, due tokens are scanned, rejected ones rest and make room.
    const capacity = await loadMonitoringCapacity(prisma);
    if (!this.seeded) {
      await this.seedFromRecentAssessments();
      this.seeded = true;
    }
    this.rotation.addDiscovered(discovered.map((token) => token.address), capacity);
    const deadline = Date.now() + SCAN_TIME_BUDGET_MS;
    let processed = 0;
    // Skipped tokens do not use up a scan slot: the next due token takes their place.
    for (const address of this.rotation.due(this.rotation.size)) {
      if (signal.aborted || processed >= this.deps.discoveryLimit || Date.now() > deadline) break;
      const skipping = this.deps.tracker ? await this.deps.tracker.usersSkipping(userSettings.map((settings) => settings.userId), address) : new Set<string>();
      const activeSettings = userSettings.filter((settings) => !skipping.has(settings.userId));
      if (activeSettings.length === 0) {
        summary.skipped += 1;
        this.rotation.record(address, 'SKIPPED');
        continue;
      }
      processed += 1;
      try {
        this.rotation.record(address, await this.processCandidate(address, activeSettings, summary, correlationId, signal));
      } catch (error) {
        summary.errors += 1;
        this.rotation.record(address, 'NO_DATA');
        this.logProviderError(address, error, correlationId);
      }
    }
    summary.pool = { ...this.rotation.stats(), capacity };

    logger.info({ ...summary, correlationId }, 'Token discovery cycle complete');
    return summary;
  }

  /** Tokens the risk engine accepted/watched recently stay in rotation across worker restarts. */
  private async seedFromRecentAssessments() {
    const recent = await this.deps.prisma.riskAssessment.findMany({
      where: { decision: { in: ['ACCEPT', 'WATCH'] }, hardBlocked: false, createdAt: { gte: new Date(Date.now() - 30 * 60_000) } },
      distinct: ['tokenId'],
      select: { token: { select: { address: true } } },
    }).catch(() => []);
    this.rotation.seedActive(recent.map((row) => row.token.address));
  }

  private async processCandidate(
    address: string,
    userSettings: Awaited<ReturnType<typeof loadActiveUserScanSettings>>,
    summary: ScanCycleSummary,
    correlationId: string,
    signal?: globalThis.AbortSignal,
  ): Promise<RotationStatus> {
    const { logger } = this.deps;
    const { snapshot, fresh } = await this.getSnapshot(address);
    if (!snapshot) {
      logger.warn({ address, correlationId }, 'No market snapshot available for candidate token');
      for (const settings of userSettings) await this.trackFailure(settings.userId, address, ['MARKET_DATA_UNAVAILABLE']);
      await Promise.all(userSettings.map((settings) => this.deps.prisma.auditLog.create({
        data: {
          userId: settings.userId,
          action: 'HARD_BLOCK_TRIGGERED',
          details: {
            correlationId,
            tokenAddress: address,
            hardBlocked: true,
            hardBlockReasons: ['MARKET_DATA_UNAVAILABLE'],
            riskPolicy: settings.riskPolicy,
          } as unknown as Prisma.InputJsonValue,
        },
      })));
      return 'NO_DATA';
    }
    // Every freshly fetched snapshot becomes one timestamped observation for the feature engine.
    if (fresh) await this.deps.repository.save(snapshot);
    const ageMs = Date.now() - snapshot.timestamp.getTime();

    const { mintInfo, holders, holderConcentrationPercent, onchain } = await this.enrichOnChainData(address, correlationId, signal);
    const candidate = {
      ...buildTokenCandidate({ snapshot, mintInfo, holders, holderConcentrationPercent, authorityStatusKnown: onchain.authority === 'AVAILABLE', holderDataAvailable: onchain.holders === 'AVAILABLE' }),
      marketDataAvailable: true,
      marketDataStale: ageMs > this.deps.staleAfterMs,
      executionPriceAvailable: typeof snapshot.priceUsd === 'number' && Number.isFinite(snapshot.priceUsd) && snapshot.priceUsd > 0,
      tokenDataValid: snapshot.metadata.address === address && Boolean(snapshot.metadata.symbol?.trim()),
    };
    summary.evaluated += 1;

    // The token's rotation status is the best outcome across the scanning users.
    const order: RotationStatus[] = ['ACCEPT', 'WATCH', 'REJECTED', 'BLOCKED'];
    let best: RotationStatus = 'REJECTED';
    for (const settings of userSettings) {
      if (!filterCandidateForUser(candidate, settings)) continue;
      const discovery = evaluateCandidate(candidate, { risk: toRiskEngineConfig(settings) });
      await this.persistAssessment(address, settings.userId, discovery, correlationId);
      if (discovery.accepted) {
        summary.accepted += 1;
      }
      const status: RotationStatus = discovery.risk.hardBlocked ? 'BLOCKED' : discovery.risk.decision === 'ACCEPT' ? 'ACCEPT' : discovery.risk.decision === 'WATCH' ? 'WATCH' : 'REJECTED';
      if (order.indexOf(status) < order.indexOf(best)) best = status;
    }
    return best;
  }

  private async trackFailure(userId: string, address: string, reasons: string[]) {
    if (!this.deps.tracker) return;
    try {
      const record = await this.deps.tracker.recordFailure(userId, address, reasons);
      if (record) await this.deps.onTokenSkipped?.(userId, address, record);
    } catch (error) {
      this.deps.logger.warn({ err: error, address, userId }, 'Unbuyable-token tracking failed');
    }
  }

  private async getSnapshot(address: string): Promise<{ snapshot: TokenMarketSnapshot | null; fresh: boolean }> {
    const cacheKey = address.toLowerCase();
    const cached = await this.deps.cache.get(cacheKey);
    if (cached) return { snapshot: cached, fresh: false };

    const snapshot = await this.deps.provider.getTokenMetrics(address);
    if (snapshot) await this.deps.cache.set(cacheKey, snapshot, this.deps.cacheTtlSeconds);
    return { snapshot, fresh: Boolean(snapshot) };
  }

  /**
   * On-chain enrichment through the shared RPC manager (P4, dropped when the scan is aborted). Mint info and holders are
   * independent: a holder failure never discards successfully read authorities (PARTIAL). Anything that could not be
   * read is UNKNOWN - the candidate carries explicit flags, so an RPC outage can never look like "safe".
   */
  private async enrichOnChainData(
    address: string,
    correlationId: string,
    signal?: globalThis.AbortSignal,
  ): Promise<{ mintInfo?: SolanaMintInfo; holders?: TokenHolder[]; holderConcentrationPercent?: number; onchain: OnchainEnrichment }> {
    const startedAt = Date.now();
    if (!this.deps.rpc) {
      return { onchain: { status: 'UNAVAILABLE', authority: 'UNKNOWN', holders: 'UNKNOWN', quality: 'INSUFFICIENT', errors: ['RPC_NOT_CONFIGURED'], fetchedAt: new Date(startedAt).toISOString() } };
    }
    const options = { caller: 'TokenScanner', priority: RPC_PRIORITY.ENRICHMENT, subject: address, correlationId, isRelevant: () => !signal?.aborted };
    const [mintResult, holderResult] = await Promise.allSettled([
      this.deps.rpc.getMintAccount(address, options),
      this.deps.rpc.getTokenLargestAccounts(address, options, 10),
    ]);
    const errors: string[] = [];
    const describe = (result: PromiseRejectedResult) => (result.reason instanceof Error ? result.reason.message : String(result.reason)).slice(0, 300);
    const mintInfo = mintResult.status === 'fulfilled' && mintResult.value ? mintResult.value : undefined;
    if (mintResult.status === 'rejected') errors.push(`mint: ${describe(mintResult)}`);
    else if (!mintResult.value) errors.push('mint: account not found');
    const holders = holderResult.status === 'fulfilled' ? holderResult.value : undefined;
    if (holderResult.status === 'rejected') errors.push(`holders: ${describe(holderResult)}`);
    const authority = mintInfo ? 'AVAILABLE' as const : 'UNKNOWN' as const;
    const holderState = mintInfo && holders ? 'AVAILABLE' as const : 'UNKNOWN' as const;
    const status = authority === 'AVAILABLE' && holderState === 'AVAILABLE' ? 'COMPLETE' as const : authority === 'AVAILABLE' || holderState === 'AVAILABLE' ? 'PARTIAL' as const : 'UNAVAILABLE' as const;
    const onchain: OnchainEnrichment = {
      status, authority, holders: holderState, errors, fetchedAt: new Date().toISOString(),
      // Authorities are required (security); holders only refine the risk score.
      quality: status === 'COMPLETE' ? 'HIGH' : authority === 'AVAILABLE' ? 'MEDIUM' : 'INSUFFICIENT',
    };
    if (authority === 'UNKNOWN') {
      if (mintResult.status === 'rejected' && mintResult.reason instanceof RpcAllProvidersFailedError) this.deps.rpc.reportSecurityDataUnavailable('TokenScanner');
      this.deps.logger.warn({ address, correlationId, status, errors }, 'On-chain security data unavailable: authorities UNKNOWN, no automatic entry (WATCH)');
    }
    return {
      mintInfo, holders, onchain,
      holderConcentrationPercent: mintInfo && holders ? calculateHolderConcentrationPercent(holders, mintInfo) : undefined,
    };
  }

  private logProviderError(address: string, error: unknown, correlationId: string) {
    if (error instanceof RpcAllProvidersFailedError) {
      this.deps.logger.warn({ address, correlationId, message: error.message }, 'Solana RPC request failed');
      return;
    }
    const { logger } = this.deps;
    if (error instanceof ProviderRequestError) {
      logger.warn({ address, correlationId, retryable: error.retryable, message: error.message }, 'Market data provider request failed');
    } else if (error instanceof RpcTimeoutError || error instanceof RpcRateLimitError || error instanceof RpcUnavailableError) {
      logger.warn({ address, correlationId, message: error.message }, 'Solana RPC request failed');
    } else {
      logger.error({ address, correlationId, err: error }, 'Unexpected error while scanning token');
    }
  }

  /** Persists the structured risk assessment, audits rejections, and only then allows a signal to be raised. */
  private async persistAssessment(address: string, userId: string, discovery: ReturnType<typeof evaluateCandidate>, correlationId: string) {
    const token = await this.deps.prisma.token.findUnique({ where: { address } });
    if (!token) return;

    const { risk } = discovery;
    await this.deps.prisma.riskAssessment.create({
      data: {
        tokenId: token.id,
        userId,
        riskScore: risk.riskScore,
        decision: risk.decision,
        classification: risk.classification,
        hardBlocked: risk.hardBlocked,
        hardBlockReasons: risk.hardBlockReasons as unknown as Prisma.InputJsonValue,
        riskPolicy: risk.riskPolicy,
        positionMultiplier: risk.positionMultiplier,
        factors: risk.factors as unknown as Prisma.InputJsonValue,
        rejectionReasons: risk.rejectionReasons as unknown as Prisma.InputJsonValue,
        warnings: risk.warnings as unknown as Prisma.InputJsonValue,
        source: risk.source,
      },
    });
    await this.deps.publishEvent?.('token_update', {
      userId,
      token: address,
      riskScore: risk.riskScore,
      riskClassification: risk.classification,
      hardBlocked: risk.hardBlocked,
      warnings: risk.warnings,
    });

    this.deps.logger.info({
      address,
      correlationId,
      riskScore: risk.riskScore,
      riskClassification: risk.classification,
      hardBlocked: risk.hardBlocked,
      hardBlockReasons: risk.hardBlockReasons,
      warnings: risk.warnings,
      riskPolicy: risk.riskPolicy,
      positionMultiplier: risk.positionMultiplier,
      finalDecision: risk.hardBlocked ? 'BLOCKED' : 'STRATEGY_EVALUATION',
    }, 'RISK_ASSESSED');

    if (risk.hardBlocked) {
      await this.trackFailure(userId, address, risk.hardBlockReasons.length ? [...risk.hardBlockReasons] : ['HARD_BLOCKED']);
      await this.deps.publishEvent?.('decision_update', { userId, token: address, decision: 'BLOCKED', hardBlockReasons: risk.hardBlockReasons });
      await this.deps.prisma.auditLog.create({
        data: {
          userId,
          action: 'HARD_BLOCK_TRIGGERED',
          details: {
            correlationId,
            tokenAddress: address,
            riskScore: risk.riskScore,
            riskClassification: risk.classification,
            hardBlocked: risk.hardBlocked,
            hardBlockReasons: risk.hardBlockReasons,
            warnings: risk.warnings,
            riskPolicy: risk.riskPolicy,
            positionMultiplier: risk.positionMultiplier,
            finalDecision: 'BLOCKED',
          } as unknown as Prisma.InputJsonValue,
        },
      });
      return;
    }

    // Infrastructure / data-quality block (required security data UNKNOWN): WATCH, re-evaluated on the next scan.
    if (risk.dataQualityBlockReasons?.length) {
      await this.deps.publishEvent?.('decision_update', { userId, token: address, decision: 'WATCH', reasons: risk.dataQualityBlockReasons, infrastructureBlock: true });
      return;
    }

    try {
      // Non-bypassable gate: strategies never see a signal unless the risk engine allowed it through.
      enforceRiskGate(risk);
    } catch (error) {
      this.deps.logger.error({ address, correlationId, err: error }, 'Risk gate blocked signal creation unexpectedly');
      return;
    }

    const recentDiscoverySignal = await this.deps.prisma.signal.findFirst({
      where: { tokenId: token.id, userId, signalType: 'DISCOVERY', createdAt: { gte: new Date(Date.now() - this.deps.staleAfterMs) } },
      select: { id: true },
    });
    if (recentDiscoverySignal) return;

    await this.deps.publishEvent?.('decision_update', { userId, token: address, decision: 'ANALYZING', riskScore: risk.riskScore, riskClassification: risk.classification });
  }
}
