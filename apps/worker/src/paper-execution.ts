import { Prisma, type PrismaClient } from '@prisma/client';
import type { TokenDataProvider } from '@soltrader/market-data';
import {
  classifyRiskScore,
  decideFinalTrade,
  DEFAULT_RISK_POSITION_MULTIPLIERS,
  type FinalTradeDecision,
  type RiskClassification,
  type RiskPolicyName,
} from '@soltrader/risk-engine';
import type { RealtimeEventType } from '@soltrader/shared';
import { authorizeEntry, isSupportedFeatureVersion, mlRiskConviction, newLaunchEntryConfig, newLaunchExitConfig, resolveEntryAuthority } from '@soltrader/strategy-engine';
import {
  debitPaperCash,
  effectiveDailyLossLimit,
  estimatePriceImpactPercent,
  hashApprovalProposal,
  InsufficientPaperCashError,
  maxNotionalForSlippage,
  PAPER_FEE_BPS,
  paperFee,
  protectionLevels,
  recomputePaperAccount,
  simulatedBuyFill,
} from '@soltrader/trading-engine';

import { assessEntryCapacity } from './exit/entry-capacity.js';
import { resolveNewLaunchSettings } from './launch/settings.js';
import type { TradingLoopLogger } from './trading-loop.js';
import type { SkipRecord, UnbuyableTokenTracker } from './unbuyable-tracker.js';

interface ActiveUser {
  id: string;
  bot: {
    maxPositionSize: Prisma.Decimal | null;
    maxDailyLoss: Prisma.Decimal | null;
  };
  risk: {
    maxPositionPercent: Prisma.Decimal | null;
    maxTotalExposurePercent: Prisma.Decimal | null;
    maxConcurrentPositions: number | null;
    maxSlippagePercent: Prisma.Decimal | null;
    minSignalScore: Prisma.Decimal | null;
    dailyLossLimitPercent: Prisma.Decimal | null;
    cooldownSeconds: number | null;
    stopLossPercent: Prisma.Decimal | null;
    takeProfitPercent: Prisma.Decimal | null;
    trailingStopPercent: Prisma.Decimal | null;
    trailingActivationPercent: Prisma.Decimal | null;
    breakEvenActivationPercent: Prisma.Decimal | null;
    riskPolicy: RiskPolicyName;
    lowRiskMax: number;
    moderateRiskMax: number;
    highRiskMax: number;
    veryHighRiskMax: number;
    lowPositionMultiplier: Prisma.Decimal;
    moderatePositionMultiplier: Prisma.Decimal;
    highPositionMultiplier: Prisma.Decimal;
    veryHighPositionMultiplier: Prisma.Decimal;
    aiAnalysisEnabled: boolean;
    aiRequiredForHighRisk: boolean;
    aiRequiredForVeryHighRisk: boolean;
  } | null;
  tradingMode: string;
}

export type ExecutionDecisionSource = 'STRATEGY' | 'AI' | 'MANUAL_PAPER' | 'NEW_LAUNCH';

/**
 * Signal sources executed automatically. Only New Launch produces entries since the legacy token scanner,
 * strategy runner, AI trader and manual token-list buy were retired; older signals of other sources are ignored.
 */
export const DEFAULT_AUTOMATIC_SOURCES: ReadonlyArray<ExecutionDecisionSource> = ['NEW_LAUNCH'];

interface AbortSignalLike {
  readonly aborted: boolean;
}

interface CandidateSignal {
  id: string;
  userId: string;
  tokenId: string;
  tokenAddress: string;
  symbol: string;
  strategyName: string | null;
  score: number;
  riskScore: number;
  riskClassification: RiskClassification;
  riskPolicy: RiskPolicyName;
  hardBlocked: boolean;
  hardBlockReasons: string[];
  riskWarnings: string[];
  riskFactors: Record<string, number>;
  manualPaper: boolean;
  requestedAmount: number | null;
  recommendedStop: number | null;
  recommendedTarget: number | null;
  reasons: string[];
  createdAt: Date;
  /** Signal analysis at signal time (strategy results, composite, exhaustion); null for older signals. */
  analysis: Record<string, unknown> | null;
  primaryStrategy: string | null;
  exhaustionBlocked: boolean;
  criticalLiquidityOutflow: boolean;
  /** Which system made the entry decision (only NEW_LAUNCH in production, see DEFAULT_AUTOMATIC_SOURCES). */
  decisionSource: ExecutionDecisionSource;
  /** NewLaunch decision context (timing, scores) when decisionSource = NEW_LAUNCH. */
  launch: Record<string, unknown> | null;
  aiAnalysisId: string | null;
  /** New Launch entry strategy that created the signal (immutable origin of the trade). */
  entryStrategy: 'DEFAULT' | 'ML';
  /** ML PAPER decision context (entryStrategy = ML): decisionId, modelVersion, probability, threshold, snapshot. */
  ml: Record<string, unknown> | null;
}

export interface PaperExecutionSummary {
  users: number;
  candidates: number;
  executed: number;
  proposed: number;
  rejected: number;
  errors: number;
}

export interface PaperExecutionDependencies {
  prisma: PrismaClient;
  /**
   * ML_ONLY_ARCHITECTURE_ENABLED: only the user's selected, PAPER-approved model may open entries (DEFAULT signals and
   * signals of any other model are rejected here, even if they were created earlier). Exits are never affected.
   */
  mlOnly?: boolean;
  provider: TokenDataProvider;
  publishEvent: (type: RealtimeEventType, payload: Record<string, unknown>) => Promise<void>;
  /** Mirrors persisted audit decisions to the live log stream. */
  publishLog?: (entry: { userId: string; action: string; details: Record<string, unknown> }) => Promise<void>;
  logger: TradingLoopLogger;
  /** Counts blocked/rejected buys per token and skips tokens that stay unbuyable (automatic buys only). */
  tracker?: UnbuyableTokenTracker;
  onTokenSkipped?: (userId: string, tokenAddress: string, record: SkipRecord) => Promise<void>;
  concurrency?: number;
  lookbackMs?: number;
  maxEntriesPerCycle?: number;
  approvalTtlSeconds?: number;
  staleAfterMs?: number;
  /** Latest cached analysis for a token (used to record the market context of manual buys). */
  loadLatestAnalysis?: (userId: string, tokenAddress: string) => Promise<Record<string, unknown> | null>;
  /** Live launch quote (trade stream / pool) for NEW_LAUNCH entries, incl. the real price impact of the order. */
  getLaunchQuote?: (mint: string) => { priceUsd: number; liquidityUsd: number | null; timestamp: Date; impactPercentFor(usd: number): number | null; curve?: import('@soltrader/trading-engine').CurveState | null; migrated?: boolean; streaming?: boolean } | null;
  publishLaunchEvent?: (payload: Record<string, unknown>) => Promise<void>;
  /** Signal sources that may be executed (default: NEW_LAUNCH only). */
  automaticSources?: ReadonlyArray<ExecutionDecisionSource>;
}

function decisionSourceOf(meta: Record<string, unknown>): ExecutionDecisionSource {
  if (meta.executionSource === 'MANUAL_PAPER') return 'MANUAL_PAPER';
  if (meta.decisionSource === 'AI') return 'AI';
  if (meta.decisionSource === 'NEW_LAUNCH') return 'NEW_LAUNCH';
  return 'STRATEGY';
}

function number(value: unknown, fallback = 0) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value instanceof Prisma.Decimal) return value.toNumber();
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function riskClassification(value: unknown): value is RiskClassification {
  return value === 'LOW' || value === 'MODERATE' || value === 'HIGH' || value === 'VERY_HIGH' || value === 'EXTREME' || value === 'BLOCKED';
}

function riskPolicy(value: unknown): value is RiskPolicyName {
  return value === 'CONSERVATIVE' || value === 'BALANCED' || value === 'EXPLORATORY';
}

// The fill model (price impact, slippage direction) lives in @soltrader/trading-engine (paper-fills.ts).
export { estimatePriceImpactPercent, maxNotionalForSlippage };

/** Automatic entries smaller than this are dust (left-over exposure/cash) and are not opened. */
export const MIN_AUTOMATIC_ORDER_USD = 1;
/** Maximum age of the quote an entry is filled from. */
export const ENTRY_QUOTE_MAX_AGE_MS = 5_000;

export interface PositionSizingInput {
  manual: boolean;
  requestedAmount: number | null;
  /** Bot setting "Maximális pozícióméret" (USDC); 0 = not set. */
  configuredPositionSize: number;
  equity: number;
  maxPositionPercent: number;
  cashAvailable: number;
  remainingExposure: number;
  liquidityMaximum: number;
}

export interface PositionSizingPlan {
  /** Amount the user asked for (manual) or configured, or the percent-of-equity default. */
  target: number;
  size: number;
  /** True when the amount came from the user (manual amount or configured size) rather than the % default. */
  explicit: boolean;
  /** Hard limit that reduced an automatic entry. */
  limitedBy?: string;
  /** Why a manual entry cannot be executed with exactly the requested amount. */
  rejection?: string;
}

/**
 * Position size for one entry.
 *  - Manual buy: exactly the requested amount, or a rejection naming the limit it would break.
 *  - Automatic buy: the configured position size when set, otherwise maxPositionPercent of equity;
 *    reduced only as far as cash, total exposure and pool liquidity require.
 */
export function planPositionSize(input: PositionSizingInput): PositionSizingPlan {
  const configured = input.configuredPositionSize > 0 ? input.configuredPositionSize : null;
  const manualAmount = input.manual && input.requestedAmount !== null && input.requestedAmount > 0 ? input.requestedAmount : null;
  const target = manualAmount ?? configured ?? input.equity * input.maxPositionPercent / 100;
  const explicit = manualAmount !== null || configured !== null;
  const limits: Array<{ reason: string; value: number }> = [
    { reason: 'INSUFFICIENT_PAPER_CASH', value: input.cashAvailable },
    { reason: 'AMOUNT_ABOVE_EXPOSURE_LIMIT', value: input.remainingExposure },
    { reason: 'AMOUNT_ABOVE_LIQUIDITY_LIMIT', value: input.liquidityMaximum },
  ];
  if (manualAmount !== null && configured !== null) limits.push({ reason: 'AMOUNT_ABOVE_MAX_POSITION_SIZE', value: configured });

  if (manualAmount !== null) {
    const violated = limits.find((limit) => manualAmount > limit.value * (1 + 1e-9));
    return violated ? { target, size: 0, explicit, rejection: violated.reason } : { target, size: manualAmount, explicit };
  }
  const binding = limits.reduce<{ reason: string; value: number } | null>((lowest, limit) => (limit.value < target && (!lowest || limit.value < lowest.value) ? limit : lowest), null);
  return binding ? { target, size: Math.max(0, binding.value), explicit, limitedBy: binding.reason } : { target, size: target, explicit };
}

async function mapWithConcurrency<T>(items: T[], concurrency: number, task: (item: T) => Promise<void>) {
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor];
      cursor += 1;
      await task(item);
    }
  });
  await Promise.all(workers);
}

/** Audit actions that record the worker's final decision on a signal. */
const DECISION_AUDIT_ACTIONS = ['TRADE_APPROVED', 'TRADE_APPROVED_REDUCED_SIZE', 'TRADE_REJECTED', 'HARD_BLOCK_TRIGGERED', 'SEMI_AUTO_TRADE_PROPOSED'] as const;

export class PaperExecutionCoordinator {
  private readonly activeKeys = new Set<string>();
  /** Signals already decided in this process (signalId -> decision time), so each signal is decided and audited once. */
  private readonly decidedSignals = new Map<string, number>();
  private readonly concurrency: number;
  private readonly lookbackMs: number;
  private readonly maxEntriesPerCycle: number;
  private readonly approvalTtlSeconds: number;
  private readonly staleAfterMs: number;
  private readonly automaticSources: ReadonlySet<ExecutionDecisionSource>;

  constructor(private readonly deps: PaperExecutionDependencies) {
    this.automaticSources = new Set(deps.automaticSources ?? DEFAULT_AUTOMATIC_SOURCES);
    this.concurrency = deps.concurrency ?? 4;
    this.lookbackMs = deps.lookbackMs ?? 120_000;
    this.maxEntriesPerCycle = deps.maxEntriesPerCycle ?? 10;
    this.approvalTtlSeconds = deps.approvalTtlSeconds ?? 300;
    this.staleAfterMs = deps.staleAfterMs ?? 120_000;
  }

  async runCycle(signal: AbortSignalLike): Promise<PaperExecutionSummary> {
    const summary: PaperExecutionSummary = { users: 0, candidates: 0, executed: 0, proposed: 0, rejected: 0, errors: 0 };
    const users = (await this.deps.prisma.botConfig.findMany({
      where: { status: 'RUNNING', tradingMode: { in: ['PAPER', 'SEMI_AUTO'] }, isEmergencyStop: false },
      include: { user: { include: { riskConfigs: true } } },
    })).map((config) => ({
      id: config.userId,
      bot: { maxPositionSize: config.maxPositionSize, maxDailyLoss: config.maxDailyLoss },
      risk: config.user.riskConfigs[0] ?? null,
      tradingMode: config.tradingMode,
    } satisfies ActiveUser));
    summary.users = users.length;
    if (users.length === 0) return summary;

    const candidates = await this.deps.prisma.signal.findMany({
      where: {
        userId: { in: users.map((user) => user.id) },
        direction: 'BUY',
        mode: 'SCANNER',
        createdAt: { gte: new Date(Date.now() - this.lookbackMs) },
      },
      include: { token: true },
      orderBy: { createdAt: 'desc' },
    });
    const userById = new Map(users.map((user) => [user.id, user]));
    const latestByToken = new Set<string>();
    const uniqueCandidates: CandidateSignal[] = [];
    for (const signalRow of candidates) {
      if (!signalRow.userId) continue;
      const signalMeta = record(signalRow.metadata);
      if (!this.automaticSources.has(decisionSourceOf(signalMeta))) continue;
      const key = `${signalRow.userId}:${signalRow.tokenId}`;
      if (latestByToken.has(key)) continue;
      latestByToken.add(key);
      uniqueCandidates.push({
        id: signalRow.id,
        userId: signalRow.userId,
        tokenId: signalRow.tokenId,
        tokenAddress: signalRow.token.address,
        symbol: signalRow.token.symbol,
        strategyName: signalRow.strategyName,
        score: number(signalRow.score),
        riskScore: number(signalRow.riskScore),
        riskClassification: riskClassification(record(signalRow.metadata).riskClassification)
          ? record(signalRow.metadata).riskClassification as RiskClassification
          : classifyRiskScore(number(signalRow.riskScore)),
        riskPolicy: riskPolicy(record(signalRow.metadata).riskPolicy)
          ? record(signalRow.metadata).riskPolicy as RiskPolicyName
          : 'BALANCED',
        hardBlocked: record(signalRow.metadata).hardBlocked === true,
        hardBlockReasons: stringList(record(signalRow.metadata).hardBlockReasons),
        riskWarnings: stringList(record(signalRow.metadata).riskWarnings),
        riskFactors: Object.fromEntries(Object.entries(record(record(signalRow.metadata).riskFactors)).filter((entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1]))),
        manualPaper: record(signalRow.metadata).executionSource === 'MANUAL_PAPER',
        requestedAmount: number(record(signalRow.metadata).requestedAmount, 0) || null,
        recommendedStop: number(signalRow.recommendedStop, 0) || null,
        recommendedTarget: number(signalRow.recommendedTarget, 0) || null,
        reasons: Array.isArray(signalRow.reasons) ? signalRow.reasons.filter((reason): reason is string => typeof reason === 'string') : [],
        createdAt: signalRow.createdAt,
        analysis: Object.keys(record(record(signalRow.metadata).analysis)).length ? record(record(signalRow.metadata).analysis) : null,
        primaryStrategy: typeof record(signalRow.metadata).primaryStrategy === 'string' ? record(signalRow.metadata).primaryStrategy as string : signalRow.strategyName,
        exhaustionBlocked: record(signalRow.metadata).exhaustionBlocked === true,
        criticalLiquidityOutflow: record(signalRow.metadata).criticalLiquidityOutflow === true,
        decisionSource: decisionSourceOf(signalMeta),
        launch: record(signalRow.metadata).decisionSource === 'NEW_LAUNCH' ? record(record(signalRow.metadata).launch) : null,
        aiAnalysisId: typeof record(signalRow.metadata).aiAnalysisId === 'string' ? record(signalRow.metadata).aiAnalysisId as string : null,
        entryStrategy: signalMeta.entryStrategy === 'ML' ? 'ML' : 'DEFAULT',
        ml: signalMeta.entryStrategy === 'ML' ? record(signalMeta.ml) : null,
      });
      if (uniqueCandidates.length >= this.maxEntriesPerCycle) break;
    }
    summary.candidates = uniqueCandidates.length;

    // Users are processed in parallel, but one user's candidates run sequentially so position-count,
    // exposure and cash checks always see the previous entry of the same user.
    const candidatesByUser = new Map<string, CandidateSignal[]>();
    for (const candidate of uniqueCandidates) {
      const group = candidatesByUser.get(candidate.userId) ?? [];
      group.push(candidate);
      candidatesByUser.set(candidate.userId, group);
    }
    await mapWithConcurrency([...candidatesByUser.entries()], this.concurrency, async ([userId, userCandidates]) => {
      const user = userById.get(userId);
      if (!user) return;
      for (const candidate of userCandidates) {
        if (signal.aborted) return;
        try {
          const result = await this.executeCandidate(candidate, user);
          if (result === 'EXECUTED') summary.executed += 1;
          if (result === 'PROPOSED') summary.proposed += 1;
          if (result === 'REJECTED') summary.rejected += 1;
        } catch (error) {
          if (error instanceof InsufficientPaperCashError) {
            summary.rejected += 1;
            await this.rejectCandidate(candidate, 'POSITION_LIMIT_OR_CASH_EXHAUSTED', user.risk?.riskPolicy ?? candidate.riskPolicy).catch(() => undefined);
            continue;
          }
          summary.errors += 1;
          this.deps.logger.error({ err: error, signalId: candidate.id, userId: candidate.userId }, 'Paper execution candidate failed');
        }
      }
    });

    this.deps.logger.info({ ...summary }, 'Paper execution cycle complete');
    return summary;
  }

  private async executeCandidate(candidate: CandidateSignal, user: ActiveUser): Promise<'EXECUTED' | 'PROPOSED' | 'REJECTED' | 'SKIPPED'> {
    const key = `${candidate.userId}:${candidate.id}`;
    if (this.activeKeys.has(key) || this.decidedSignals.has(candidate.id)) return 'SKIPPED';
    // An explicit manual buy is always evaluated; automatic entries leave skipped tokens alone.
    if (!candidate.manualPaper && this.deps.tracker && await this.deps.tracker.isSkipped(candidate.userId, candidate.tokenAddress)) return 'SKIPPED';
    this.activeKeys.add(key);
    try {
      const existingOrder = await this.deps.prisma.paperOrder.findFirst({ where: { userId: candidate.userId, signalId: candidate.id } });
      if (existingOrder) return 'SKIPPED';
      const existingApproval = await this.deps.prisma.approvalRequest.findFirst({ where: { userId: candidate.userId, signalId: candidate.id, status: 'PENDING' } });
      if (existingApproval) return 'SKIPPED';
      // A manual Paper request is decided exactly once; its outcome is what the user is shown.
      if (candidate.manualPaper && this.deps.prisma.auditLog?.findFirst) {
        const decided = await this.deps.prisma.auditLog.findFirst({ where: { userId: candidate.userId, action: { in: [...DECISION_AUDIT_ACTIONS] }, details: { path: ['signalId'], equals: candidate.id } } });
        if (decided) return 'SKIPPED';
      }

      const minSignalScore = number(user.risk?.minSignalScore, 70);
      const provider = this.deps.provider as TokenDataProvider & { getFreshTokenMetrics?: (address: string, maxAgeMs: number) => Promise<Awaited<ReturnType<TokenDataProvider['getTokenMetrics']>>> };
      // NEW_LAUNCH tokens are usually not indexed by market data yet: use the live launch quote (trade stream).
      const launchQuote = candidate.decisionSource === 'NEW_LAUNCH' ? this.deps.getLaunchQuote?.(candidate.tokenAddress) ?? null : null;
      const market = launchQuote
        ? { priceUsd: launchQuote.priceUsd, liquidityUsd: launchQuote.liquidityUsd ?? undefined, timestamp: launchQuote.timestamp, volume24h: undefined as number | undefined, priceChange1h: undefined as number | undefined, priceChange24h: undefined as number | undefined }
        : await (provider.getFreshTokenMetrics
          ? provider.getFreshTokenMetrics(candidate.tokenAddress, ENTRY_QUOTE_MAX_AGE_MS)
          : provider.getTokenMetrics(candidate.tokenAddress)).catch(() => null);
      const price = number(market?.priceUsd);
      const liquidity = number(market?.liquidityUsd);
      const stale = !market?.timestamp || Date.now() - market.timestamp.getTime() > this.staleAfterMs;
      const hardBlockReasons = [...candidate.hardBlockReasons];
      if (candidate.hardBlocked) hardBlockReasons.push('HARD_BLOCKED_ASSESSED');
      if (!market) hardBlockReasons.push('MARKET_DATA_UNAVAILABLE');
      else if (stale) hardBlockReasons.push('MARKET_DATA_STALE');
      else if (!Number.isFinite(price) || price <= 0) hardBlockReasons.push('UNPRICED_EXECUTION');
      // Absolute execution floor for every entry (DEFAULT and ML alike); not a strategy preference, never lowered by a setting.
      else if (!Number.isFinite(liquidity) || liquidity < 1_250) hardBlockReasons.push('LIQUIDITY_BELOW_ABSOLUTE_MINIMUM');
      if (hardBlockReasons.length > 0) {
        await this.recordDecision(candidate, {
          decision: 'BLOCKED', reasons: [...new Set(hardBlockReasons)], warnings: candidate.riskWarnings,
          riskScore: candidate.riskScore, riskClassification: 'BLOCKED', signalScore: candidate.score,
          normalPositionSize: 0, riskAdjustedPositionSize: 0, positionMultiplier: 0,
        });
        return 'REJECTED';
      }
      if (!market) return 'REJECTED';

      // NewLaunch runs as its own PAPER experiment next to Strategy/AI mode; central limits still apply below.
      const newLaunch = candidate.decisionSource === 'NEW_LAUNCH'
        ? resolveNewLaunchSettings(this.deps.prisma.newLaunchConfig?.findUnique ? await this.deps.prisma.newLaunchConfig.findUnique({ where: { userId: candidate.userId } }) as unknown as Record<string, unknown> | null : null)
        : null;
      if (newLaunch) {
        const policy = user.risk?.riskPolicy ?? candidate.riskPolicy;
        if (!newLaunch.enabled) return this.rejectCandidate(candidate, 'NEW_LAUNCH_DISABLED', policy);
        if (user.tradingMode !== 'PAPER') return this.rejectCandidate(candidate, 'NEW_LAUNCH_PAPER_ONLY', policy);
        // Exactly one entry strategy may buy: the signal's strategy must still be the user's active one at execution.
        const strategy = this.deps.prisma.mlPaperSettings?.findUnique ? await this.deps.prisma.mlPaperSettings.findUnique({ where: { userId: candidate.userId } }) : null;
        if (this.deps.mlOnly) {
          // ML-only contract: one authorised model per user; no DEFAULT entries, no fallback, paused = no entries.
          const selectedVersion = strategy?.strategyMode === 'ML' ? strategy.modelVersion : null;
          const selectedModel = selectedVersion && this.deps.prisma.mlModelVersion?.findUnique ? await this.deps.prisma.mlModelVersion.findUnique({ where: { version: selectedVersion }, select: { version: true, paperApproved: true, status: true, featureVersion: true } }) : null;
          const authority = resolveEntryAuthority({
            mlOnly: true, settings: strategy ? { strategyMode: strategy.strategyMode, modelVersion: strategy.modelVersion, tradingPaused: (strategy as { tradingPaused?: boolean }).tradingPaused } : null,
            model: selectedModel, supportedFeatureVersion: isSupportedFeatureVersion, tradingMode: user.tradingMode,
          });
          const verdict = authorizeEntry(authority, { entryStrategy: candidate.entryStrategy, modelVersion: typeof candidate.ml?.modelVersion === 'string' ? candidate.ml.modelVersion : null });
          if (!verdict.allowed) return this.rejectCandidate(candidate, verdict.reason, policy);
        }
        const activeStrategy = strategy?.strategyMode === 'ML' ? 'ML' : 'DEFAULT';
        if (candidate.entryStrategy !== activeStrategy) return this.rejectCandidate(candidate, 'ENTRY_STRATEGY_NOT_ACTIVE', policy);
        if (candidate.entryStrategy === 'ML') {
          const version = typeof candidate.ml?.modelVersion === 'string' ? candidate.ml.modelVersion : '';
          if (!version || strategy?.modelVersion !== version) return this.rejectCandidate(candidate, 'ML_MODEL_NOT_SELECTED', policy);
          const model = this.deps.prisma.mlModelVersion?.findUnique ? await this.deps.prisma.mlModelVersion.findUnique({ where: { version }, select: { paperApproved: true, status: true } }) : null;
          if (!model?.paperApproved || model.status === 'RETIRED') return this.rejectCandidate(candidate, 'ML_MODEL_NOT_PAPER_APPROVED', policy);
        }
        if (candidate.riskScore > newLaunch.maxRiskScore) return this.rejectCandidate(candidate, 'RISK_SCORE_ABOVE_LAUNCH_MAXIMUM', policy);
        const tradedBefore = await this.deps.prisma.trade.findFirst({ where: { userId: candidate.userId, tokenId: candidate.tokenId, decisionSource: 'NEW_LAUNCH' }, select: { id: true } });
        if (tradedBefore) return this.rejectCandidate(candidate, 'NEW_LAUNCH_ALREADY_TRADED', policy);
        const openLaunches = await this.deps.prisma.trade.count({ where: { userId: candidate.userId, decisionSource: 'NEW_LAUNCH', status: 'OPEN' } });
        if (openLaunches >= newLaunch.maxConcurrentPositions) return this.rejectCandidate(candidate, 'NEW_LAUNCH_MAX_CONCURRENT_POSITIONS', policy);
        // Quality gate in ENFORCE_PAPER mode removes a DEFAULT entry; MONITOR_ONLY only records wouldPass. It is a DEFAULT
        // strategy preference: an ML entry (ML-only mode) is never vetoed by it (stored on the signal for comparison).
        const gate = (candidate.launch?.qualityGate ?? null) as { blocksEntry?: boolean } | null;
        if (candidate.entryStrategy === 'DEFAULT' && gate?.blocksEntry) return this.rejectCandidate(candidate, 'QUALITY_GATE_FAILED', policy);
      }
      // The retired AI trader can never open a position (its signals are not executed either).
      if (candidate.decisionSource === 'AI') return this.rejectCandidate(candidate, 'AI_TRADER_RETIRED', user.risk?.riskPolicy ?? candidate.riskPolicy);
      if (!candidate.manualPaper && candidate.exhaustionBlocked) return this.rejectCandidate(candidate, 'PUMP_EXHAUSTION_BLOCK', user.risk?.riskPolicy ?? candidate.riskPolicy);
      if (!candidate.manualPaper && candidate.criticalLiquidityOutflow) return this.rejectCandidate(candidate, 'LIQUIDITY_CRITICAL_OUTFLOW', user.risk?.riskPolicy ?? candidate.riskPolicy);

      const cooldownMs = Math.max(0, newLaunch ? newLaunch.cooldownSeconds : number(user.risk?.cooldownSeconds, 60)) * 1000;
      const recentTrade = await this.deps.prisma.trade.findFirst({ where: { userId: candidate.userId, tokenId: candidate.tokenId, createdAt: { gte: new Date(Date.now() - cooldownMs) } } });
      if (recentTrade) return this.rejectCandidate(candidate, 'COOLDOWN_ACTIVE', user.risk?.riskPolicy ?? candidate.riskPolicy);
      const existingPosition = await this.deps.prisma.position.findFirst({ where: { userId: candidate.userId, tokenId: candidate.tokenId, status: 'OPEN', mode: 'PAPER' } });
      if (existingPosition) return this.rejectCandidate(candidate, 'POSITION_ALREADY_OPEN', user.risk?.riskPolicy ?? candidate.riskPolicy);

      const account = await this.deps.prisma.paperAccount.findUnique({ where: { userId: candidate.userId } });
      if (!account) return this.rejectCandidate(candidate, 'PAPER_ACCOUNT_UNAVAILABLE', user.risk?.riskPolicy ?? candidate.riskPolicy);
      const [openPositions, openExposure] = await Promise.all([
        this.deps.prisma.position.count({ where: { userId: candidate.userId, status: 'OPEN', mode: 'PAPER' } }),
        this.deps.prisma.position.findMany({ where: { userId: candidate.userId, status: 'OPEN', mode: 'PAPER' }, select: { quantity: true, currentPrice: true, unrealizedPnl: true } }),
      ]);
      const maxPositions = user.risk?.maxConcurrentPositions ?? 3;
      if (openPositions >= maxPositions) return this.rejectCandidate(candidate, 'MAX_CONCURRENT_POSITIONS', user.risk?.riskPolicy ?? candidate.riskPolicy);

      const equity = Math.max(number(account.equity, number(account.cashBalance, 0)), 0);
      const currentExposure = openExposure.reduce((total, position) => total + number(position.quantity) * number(position.currentPrice), 0);
      const startOfDay = new Date();
      startOfDay.setUTCHours(0, 0, 0, 0);
      const closedToday = this.deps.prisma.trade.findMany
        ? await this.deps.prisma.trade.findMany({ where: { userId: candidate.userId, mode: 'PAPER', status: 'CLOSED', exitAt: { gte: startOfDay } }, select: { netPnl: true } })
        : [];
      const dailyNetPnl = closedToday.reduce((total, trade) => total + number(trade.netPnl), 0)
        + openExposure.reduce((total, position) => total + number(position.unrealizedPnl), 0);
      const dailyLoss = Math.max(0, -dailyNetPnl);
      // The USDC amount ("Maximális napi veszteség") takes precedence over the percent setting; 0/empty disables.
      const dailyLossLimit = effectiveDailyLossLimit(equity, user.risk?.dailyLossLimitPercent == null ? null : number(user.risk.dailyLossLimitPercent), user.bot.maxDailyLoss == null ? null : number(user.bot.maxDailyLoss));
      if (dailyLossLimit.limit !== null && dailyLoss > 0 && dailyLoss >= dailyLossLimit.limit) {
        return this.rejectCandidate(candidate, 'DAILY_LOSS_LIMIT', user.risk?.riskPolicy ?? candidate.riskPolicy);
      }
      // NewLaunch positions are deliberately small: their own max % (before the risk multiplier), no fixed USDC size.
      const maxPositionPercent = newLaunch ? newLaunch.maxPositionPercent : number(user.risk?.maxPositionPercent, 2);
      const maxExposurePercent = number(user.risk?.maxTotalExposurePercent, 25);
      const configuredPositionSize = newLaunch ? 0 : number(user.bot.maxPositionSize, 0);
      const remainingExposure = Math.max(0, equity * maxExposurePercent / 100 - currentExposure);
      const maxSlippage = number(user.risk?.maxSlippagePercent, 3);
      const sizing = planPositionSize({
        manual: candidate.manualPaper,
        requestedAmount: candidate.requestedAmount,
        configuredPositionSize,
        equity,
        maxPositionPercent,
        cashAvailable: number(account.cashBalance, 0) / (1 + PAPER_FEE_BPS / 10_000),
        remainingExposure,
        // Largest order whose estimated price impact stays within the user's slippage limit (curve impact is checked below for launches).
        liquidityMaximum: launchQuote ? Number.POSITIVE_INFINITY : maxNotionalForSlippage(liquidity, maxSlippage),
      });
      if (sizing.rejection) return this.rejectCandidate(candidate, sizing.rejection, user.risk?.riskPolicy ?? candidate.riskPolicy);
      const normalPositionSize = sizing.size;
      if (!Number.isFinite(normalPositionSize) || normalPositionSize <= 0) return this.rejectCandidate(candidate, 'POSITION_LIMIT_OR_CASH_EXHAUSTED', user.risk?.riskPolicy ?? candidate.riskPolicy);
      if (sizing.limitedBy) this.deps.logger.info({ tokenAddress: candidate.tokenAddress, target: sizing.target, size: normalPositionSize, limitedBy: sizing.limitedBy }, 'Automatic entry reduced to fit a hard limit');
      const estimatedSlippagePercent = launchQuote ? launchQuote.impactPercentFor(normalPositionSize) ?? Number.POSITIVE_INFINITY : estimatePriceImpactPercent(normalPositionSize, liquidity);
      if (newLaunch && estimatedSlippagePercent > newLaunch.maxPriceImpactPercent) return this.rejectCandidate(candidate, 'PRICE_IMPACT_TOO_HIGH', user.risk?.riskPolicy ?? candidate.riskPolicy);
      if (estimatedSlippagePercent > maxSlippage) return this.rejectCandidate(candidate, 'SLIPPAGE_LIMIT_EXCEEDED', user.risk?.riskPolicy ?? candidate.riskPolicy);
      const riskMultipliers = user.risk ? {
        LOW: Math.min(1, number(user.risk.lowPositionMultiplier, 1)),
        MODERATE: Math.min(1, number(user.risk.moderatePositionMultiplier, 0.75)),
        HIGH: Math.min(1, number(user.risk.highPositionMultiplier, 0.35)),
        VERY_HIGH: Math.min(1, number(user.risk.veryHighPositionMultiplier, 0.15)),
        EXTREME: 0,
        BLOCKED: 0,
      } : DEFAULT_RISK_POSITION_MULTIPLIERS;
      // A manual amount is bought as-is (classes with a zero multiplier, EXTREME/BLOCKED, still reject).
      // Automatic entries always scale the base size (configured USDC size or % of equity) by the risk
      // multiplier: HIGH 0.35 turns a 5% base into 1.75%.
      const multipliers = candidate.manualPaper
        ? Object.fromEntries(Object.entries(riskMultipliers).map(([key, value]) => [key, value > 0 ? 1 : 0])) as unknown as typeof riskMultipliers
        : riskMultipliers;

      // ML entries: the strategic conviction is the model probability vs. the approved threshold, not the DEFAULT Launch
      // Score (risk-policy conviction rules for HIGH / VERY_HIGH risk are applied to it unchanged).
      const mlConviction = newLaunch && candidate.entryStrategy === 'ML'
        ? mlRiskConviction(typeof candidate.ml?.probability === 'number' ? candidate.ml.probability : null, typeof candidate.ml?.threshold === 'number' ? candidate.ml.threshold : null)
        : null;
      const decision = decideFinalTrade({
        tradingMode: user.tradingMode as 'PAPER' | 'SEMI_AUTO' | 'LIVE' | 'SCANNER',
        classification: candidate.riskClassification,
        riskPolicy: user.risk?.riskPolicy ?? candidate.riskPolicy,
        hardBlocked: candidate.hardBlocked,
        hardBlockReasons: candidate.hardBlockReasons,
        riskScore: candidate.riskScore,
        signalScore: mlConviction ? mlConviction.signalScore : candidate.score,
        // NewLaunch has its own Launch Score threshold (the strategy/composite minimum does not apply to it); ML entries use
        // the approved ML threshold instead.
        minimumSignalScore: candidate.manualPaper ? 0 : mlConviction ? mlConviction.minimumSignalScore : newLaunch ? newLaunch.minScore : minSignalScore,
        normalPositionSize,
        positionMultipliers: multipliers,
        // AI decisions are made upstream (AI mode); the risk engine's old AI-confirmation hook stays off.
        aiAnalysisEnabled: false,
        aiRequiredForHighRisk: false,
        aiRequiredForVeryHighRisk: false,
        aiUnavailable: false,
        warnings: candidate.riskWarnings,
      });
      await this.recordDecision(candidate, decision, user.risk?.riskPolicy ?? candidate.riskPolicy);
      if (decision.decision !== 'APPROVED' && decision.decision !== 'APPROVED_REDUCED_SIZE') return 'REJECTED';
      let notional = decision.riskAdjustedPositionSize;
      if (!Number.isFinite(notional) || notional <= 0) return 'REJECTED';
      if (!candidate.manualPaper && notional < MIN_AUTOMATIC_ORDER_USD) return this.rejectCandidate(candidate, 'POSITION_BELOW_MINIMUM', user.risk?.riskPolicy ?? candidate.riskPolicy);

      // NewLaunch exit capacity: can the WHOLE position be sold again at an acceptable impact? Applied last, as a
      // min() with every other limit (it can only keep or reduce). MONITOR_ONLY keeps the NL-v2 size unchanged.
      let exitCapacitySnapshot: ReturnType<typeof assessEntryCapacity>['snapshot'] | null = null;
      if (newLaunch?.dynamicPositionSizingEnabled) {
        const streamLive = Boolean(launchQuote?.streaming);
        const assessed = assessEntryCapacity({
          settings: newLaunch, priceUsd: price, liquidityUsd: Number.isFinite(liquidity) && liquidity > 0 ? liquidity : null,
          curve: launchQuote?.curve ?? null, migrated: Boolean(launchQuote?.migrated),
          // A live trade stream keeps the curve state current; otherwise the quote age is the data age.
          dataAgeMs: streamLive ? 0 : market.timestamp ? Math.max(0, Date.now() - market.timestamp.getTime()) : null,
          originalRequestedSize: sizing.target, riskApprovedSize: notional,
        });
        exitCapacitySnapshot = assessed.snapshot;
        if (newLaunch.exitCapacityMode === 'ENFORCE_PAPER') {
          if (assessed.sizing.executedSize <= 0) return this.rejectCandidate(candidate, `EXIT_CAPACITY_${assessed.sizing.decision}`, user.risk?.riskPolicy ?? candidate.riskPolicy);
          notional = Math.min(notional, assessed.sizing.executedSize);
        }
      }

      // Launch fills use the real curve/pool impact of this order size at the current (not the detection) price.
      const slippagePercent = launchQuote ? launchQuote.impactPercentFor(notional) ?? estimatePriceImpactPercent(notional, liquidity) : estimatePriceImpactPercent(notional, liquidity);
      const executionPrice = simulatedBuyFill(price, slippagePercent);
      const fee = paperFee(notional);
      const quantity = notional / executionPrice;
      const entrySlippage = (executionPrice - price) * quantity;
      const now = new Date();
      // Protection levels are derived from the actual entry FILL (position economics) with the owner's
      // current settings. The signal's recommended levels are not used: they were computed from the
      // price at signal time, which can be minutes older than the fill.
      // NEW_LAUNCH -> NewLaunch exit strategy; other (legacy / test) sources -> global settings.
      const launchExit = newLaunch ? newLaunchExitConfig(newLaunch) : null;
      const stopLossPercent = launchExit ? launchExit.stopLossPercent : number(user.risk?.stopLossPercent, 0);
      const takeProfitPercent = launchExit ? launchExit.takeProfitPercent : number(user.risk?.takeProfitPercent, 0);
      const { stopLossPrice, takeProfitPrice } = protectionLevels(executionPrice, stopLossPercent, takeProfitPercent);
      const trailingDistancePercent = launchExit ? launchExit.trailingDistancePercent ?? 0 : number(user.risk?.trailingStopPercent, 0);
      const trailingActivationPercent = launchExit ? launchExit.trailingActivationPercent ?? 0 : number(user.risk?.trailingActivationPercent, 0);
      const trailingStopFraction = trailingDistancePercent > 0 ? Math.min(0.9999, trailingDistancePercent / 100) : null;
      const trailingActivationFraction = trailingActivationPercent > 0 ? trailingActivationPercent / 100 : null;
      const breakEvenPercent = launchExit ? launchExit.breakEvenActivationPercent ?? 0 : number(user.risk?.breakEvenActivationPercent, 0);
      const breakEvenActivationFraction = breakEvenPercent > 0 ? breakEvenPercent / 100 : null;
      const strategyConfig = candidate.strategyName && this.deps.prisma.strategy?.findFirst
        ? await this.deps.prisma.strategy.findFirst({ where: { name: { in: [candidate.strategyName, candidate.strategyName.replace(/Strategy$/, '')] } }, select: { config: true } }).catch(() => null)
        : null;
      // Settings in force for this trade, so later Settings changes cannot make the history ambiguous.
      const configSnapshot = {
        capturedAt: now.toISOString(),
        executionSource: candidate.manualPaper ? 'MANUAL_PAPER' : 'STRATEGY',
        tradingMode: user.tradingMode,
        minSignalScore,
        stopLossPercent: stopLossPercent || null,
        takeProfitPercent: takeProfitPercent || null,
        trailingStopPercent: trailingDistancePercent || null,
        trailingActivationPercent: trailingActivationFraction !== null ? trailingActivationFraction * 100 : null,
        breakEvenActivationPercent: breakEvenActivationFraction !== null ? breakEvenActivationFraction * 100 : null,
        maxPositionPercent,
        configuredPositionSize: configuredPositionSize || null,
        maxExposurePercent,
        maxConcurrentPositions: maxPositions,
        maxSlippagePercent: maxSlippage,
        cooldownSeconds: cooldownMs / 1000,
        riskPolicy: user.risk?.riskPolicy ?? candidate.riskPolicy,
        riskThresholds: user.risk ? { lowRiskMax: user.risk.lowRiskMax, moderateRiskMax: user.risk.moderateRiskMax, highRiskMax: user.risk.highRiskMax, veryHighRiskMax: user.risk.veryHighRiskMax } : null,
        riskMultiplier: decision.positionMultiplier,
        sizing: {
          accountEquity: equity,
          normalPositionSize,
          riskAdjustedPositionSize: notional,
          requestedAmount: candidate.requestedAmount,
          limitedBy: sizing.limitedBy ?? null,
        },
        entryMarket: {
          priceUsd: price,
          liquidityUsd: liquidity,
          volume24h: number(market.volume24h, 0) || null,
          priceChange1h: number(market.priceChange1h, Number.NaN),
          priceChange24h: number(market.priceChange24h, Number.NaN),
          quoteAgeMs: market.timestamp ? Date.now() - market.timestamp.getTime() : null,
          signalAgeMs: now.getTime() - candidate.createdAt.getTime(),
        },
        entrySlippagePercent: slippagePercent,
        strategyName: candidate.strategyName,
        strategyParameters: (strategyConfig?.config ?? null) as Prisma.InputJsonValue | null,
        signalScore: candidate.score,
        riskScore: candidate.riskScore,
        riskClassification: candidate.riskClassification,
        // The analysis that caused (or accompanied) this entry. A manual buy never changes these scores.
        signalContext: await this.signalContext(candidate),
        launch: candidate.launch ? { ...candidate.launch, orderCreatedAt: now.toISOString(), fillAt: now.toISOString(), requestedEntryPrice: price, simulatedFillPrice: executionPrice, fillSlippagePercent: slippagePercent, quoteAt: launchQuote?.timestamp.toISOString() ?? null, exitCapacity: exitCapacitySnapshot } : null,
        decisionSource: candidate.decisionSource,
        entryStrategy: newLaunch ? candidate.entryStrategy : null,
        ml: candidate.ml,
        newLaunch: newLaunch && launchExit ? {
          configVersion: newLaunch.configVersion,
          entryConfig: newLaunchEntryConfig(newLaunch),
          exitConfig: launchExit,
          qualityGate: candidate.launch?.qualityGate ?? null,
          qualityGateVersion: newLaunch.qualityGate.version,
          liquidityAtEntry: liquidity > 0 ? liquidity : null,
        } : null,
        ai: null,
      };
      // Last check right before the order: an emergency stop issued meanwhile blocks every new entry.
      const botNow = this.deps.prisma.botConfig.findUnique ? await this.deps.prisma.botConfig.findUnique({ where: { userId: candidate.userId }, select: { isEmergencyStop: true, status: true } }) : null;
      if (botNow && (botNow.isEmergencyStop || botNow.status !== 'RUNNING')) return this.rejectCandidate(candidate, 'EMERGENCY_STOP_ACTIVE', user.risk?.riskPolicy ?? candidate.riskPolicy);
      if (user.tradingMode === 'SEMI_AUTO') {
        // The integrity hash is computed from the row as persisted (after DECIMAL rounding), exactly
        // like the API does on approval, so float -> DECIMAL rounding can never break the check.
        const approval = await this.deps.prisma.$transaction(async (transaction) => {
          const created = await transaction.approvalRequest.create({ data: { userId: candidate.userId, signalId: candidate.id, tokenId: candidate.tokenId, status: 'PENDING', direction: 'BUY', signalScore: new Prisma.Decimal(candidate.score), riskScore: new Prisma.Decimal(candidate.riskScore), entryPrice: new Prisma.Decimal(executionPrice), positionSize: new Prisma.Decimal(quantity), stopLoss: stopLossPrice !== null ? new Prisma.Decimal(stopLossPrice) : null, takeProfit: takeProfitPrice !== null ? new Prisma.Decimal(takeProfitPrice) : null, trailingStop: new Prisma.Decimal(trailingStopFraction ?? 0), reasons: candidate.reasons as Prisma.InputJsonValue, proposedOrderHash: 'pending', expiresAt: new Date(now.getTime() + this.approvalTtlSeconds * 1000) } });
          return transaction.approvalRequest.update({ where: { id: created.id }, data: { proposedOrderHash: hashApprovalProposal(created) } });
        });
        const proposedOrderHash = approval.proposedOrderHash;
        await this.deps.prisma.auditLog.create({ data: { userId: candidate.userId, action: 'SEMI_AUTO_TRADE_PROPOSED', details: { approvalId: approval.id, signalId: candidate.id, proposedOrderHash } } });
        await this.deps.publishEvent('trade_update', { userId: candidate.userId, action: 'PROPOSED', approvalId: approval.id, signalId: candidate.id, token: candidate.tokenAddress, direction: 'BUY', entry: executionPrice, positionSize: quantity, expiresAt: approval.expiresAt });
        return 'PROPOSED';
      }
      const result = await this.deps.prisma.$transaction(async (transaction) => {
        // Atomic, conditional cash reservation: fails instead of overdrawing when cash moved meanwhile.
        await debitPaperCash(transaction, account.id, notional, fee);
        const order = await transaction.paperOrder.create({
          data: {
            paperAccountId: account.id,
            userId: candidate.userId,
            tokenAddress: candidate.tokenAddress,
            symbol: candidate.symbol,
            side: 'BUY',
            strategyName: candidate.strategyName,
            signalId: candidate.id,
            status: 'FILLED',
            requestedNotionalUsd: new Prisma.Decimal(notional),
            filledNotionalUsd: new Prisma.Decimal(notional),
            quantity: new Prisma.Decimal(quantity),
            executionPriceUsd: new Prisma.Decimal(executionPrice),
            feeUsd: new Prisma.Decimal(fee),
            slippageUsd: new Prisma.Decimal(entrySlippage),
            partialFillRatio: new Prisma.Decimal(1),
            signalScore: new Prisma.Decimal(candidate.score),
            riskScore: new Prisma.Decimal(candidate.riskScore),
            metadata: { idempotencyKey: key, source: 'worker-paper-loop', finalDecision: decision as unknown as Prisma.InputJsonValue },
          },
        });
        await transaction.paperFill.create({ data: { paperOrderId: order.id, tokenAddress: candidate.tokenAddress, symbol: candidate.symbol, quantity: new Prisma.Decimal(quantity), priceUsd: new Prisma.Decimal(executionPrice), notionalUsd: new Prisma.Decimal(notional), feeUsd: new Prisma.Decimal(fee), slippageUsd: new Prisma.Decimal(entrySlippage) } });
        const position = await transaction.position.create({
          data: {
            userId: candidate.userId,
            tokenId: candidate.tokenId,
            signalId: candidate.id,
            side: 'BUY',
            quantity: new Prisma.Decimal(quantity),
            avgEntryPrice: new Prisma.Decimal(executionPrice),
            currentPrice: new Prisma.Decimal(price),
            stopLossPrice: stopLossPrice !== null ? new Prisma.Decimal(stopLossPrice) : null,
            takeProfitPrice: takeProfitPrice !== null ? new Prisma.Decimal(takeProfitPrice) : null,
            trailingStopPercent: trailingStopFraction !== null ? new Prisma.Decimal(trailingStopFraction) : null,
            entryMarketPrice: new Prisma.Decimal(price),
            entryLiquidityUsd: liquidity > 0 ? new Prisma.Decimal(liquidity) : null,
            trailingActivationPercent: trailingActivationFraction !== null ? new Prisma.Decimal(trailingActivationFraction) : null,
            breakEvenActivationPercent: breakEvenActivationFraction !== null ? new Prisma.Decimal(breakEvenActivationFraction) : null,
            exitPolicy: launchExit ? 'NEW_LAUNCH' : null,
            breakEvenCostBuffer: launchExit?.breakEvenCostBufferPercent != null ? new Prisma.Decimal(launchExit.breakEvenCostBufferPercent / 100) : null,
            configVersion: newLaunch?.configVersion ?? null,
            entryStrategy: newLaunch ? candidate.entryStrategy : null,
            liquidityExitPercent: launchExit?.liquidityDropExitPercent != null ? new Prisma.Decimal(launchExit.liquidityDropExitPercent) : null,
            maxHoldUntil: launchExit?.maxHoldMinutes ? new Date(now.getTime() + launchExit.maxHoldMinutes * 60_000) : null,
            highestPrice: new Prisma.Decimal(price),
            lowestPrice: new Prisma.Decimal(price),
            unrealizedPnl: new Prisma.Decimal(0),
            realizedPnl: new Prisma.Decimal(0),
            mode: 'PAPER',
          },
        });
        const trade = await transaction.trade.create({ data: { userId: candidate.userId, tokenId: candidate.tokenId, strategyId: null, signalId: candidate.id, positionId: position.id, side: 'BUY', tokenAddress: candidate.tokenAddress, symbol: candidate.symbol, strategyName: candidate.strategyName, signalScore: new Prisma.Decimal(candidate.score), riskScore: new Prisma.Decimal(candidate.riskScore), riskClassification: candidate.riskClassification, riskPolicy: user.risk?.riskPolicy ?? candidate.riskPolicy, aiConfirmed: false, aiOpportunityScore: null, aiConfidence: null, entry: new Prisma.Decimal(executionPrice), size: new Prisma.Decimal(notional), quantity: new Prisma.Decimal(quantity), fees: new Prisma.Decimal(fee), slippage: new Prisma.Decimal(entrySlippage), entryMarketPrice: new Prisma.Decimal(price), stopLoss: stopLossPrice !== null ? new Prisma.Decimal(stopLossPrice) : null, takeProfit: takeProfitPrice !== null ? new Prisma.Decimal(takeProfitPrice) : null, trailingStop: trailingStopFraction !== null ? new Prisma.Decimal(trailingStopFraction) : null, configSnapshot: configSnapshot as unknown as Prisma.InputJsonValue, decisionSource: candidate.decisionSource, aiAnalysisId: null, entryStrategy: newLaunch ? candidate.entryStrategy : null, mlModelVersion: candidate.entryStrategy === 'ML' && typeof candidate.ml?.modelVersion === 'string' ? candidate.ml.modelVersion : null, mlPaperDecisionId: candidate.entryStrategy === 'ML' && typeof candidate.ml?.decisionId === 'string' ? candidate.ml.decisionId : null, mlMinLiquidityUsd: candidate.entryStrategy === 'ML' && typeof candidate.ml?.minLiquidityUsd === 'number' ? new Prisma.Decimal(candidate.ml.minLiquidityUsd.toFixed(2)) : null, entryAt: now, mode: 'PAPER', status: 'OPEN' } });
        await recomputePaperAccount(transaction, candidate.userId);
        await transaction.auditLog.create({ data: { userId: candidate.userId, action: decision.decision === 'APPROVED_REDUCED_SIZE' ? 'TRADE_APPROVED_REDUCED_SIZE' : 'TRADE_APPROVED', details: { signalId: candidate.id, orderId: order.id, positionId: position.id, tradeId: trade.id, idempotencyKey: key, riskScore: candidate.riskScore, riskClassification: candidate.riskClassification, hardBlocked: false, hardBlockReasons: [], warnings: candidate.riskWarnings, signalScore: candidate.score, aiOpportunityScore: null, aiConfidence: null, decisionSource: candidate.decisionSource, aiAnalysisId: null, riskPolicy: user.risk?.riskPolicy ?? candidate.riskPolicy, positionMultiplier: decision.positionMultiplier, normalPositionSize: decision.normalPositionSize, riskAdjustedPositionSize: decision.riskAdjustedPositionSize, finalDecision: decision.decision, decisionReasons: decision.reasons } } });
        // Real price-path tracking (MFE / MAE / milestones) starts at the entry fill.
        if (transaction.positionPathMetric?.create) {
          await transaction.positionPathMetric.create({ data: { positionId: position.id, userId: candidate.userId, decisionSource: candidate.decisionSource, configVersion: newLaunch?.configVersion ?? null, entryPrice: new Prisma.Decimal(executionPrice), entryAt: now, quantity: new Prisma.Decimal(quantity), milestones: {}, liquidityAtEntry: liquidity > 0 ? new Prisma.Decimal(liquidity) : null, source: 'LIVE_TRACKING' } });
        }
        if (transaction.positionEvent?.create) {
          await transaction.positionEvent.create({ data: { positionId: position.id, userId: candidate.userId, type: 'ENTRY', at: now, price: new Prisma.Decimal(executionPrice), details: { decisionSource: candidate.decisionSource, entryStrategy: newLaunch ? candidate.entryStrategy : null, marketPrice: price, notional, slippagePercent, strategy: candidate.strategyName } as Prisma.InputJsonValue } });
        }
        return { order, position, trade };
      });

      await this.deps.tracker?.recordSuccess(candidate.userId, candidate.tokenAddress).catch(() => undefined);
      await this.resolveMlDecision(candidate, { outcome: 'EXECUTED', positionId: result.position.id, tradeId: result.trade.id, executionReason: decision.decision });
      await this.deps.publishLog?.({ userId: candidate.userId, action: decision.decision === 'APPROVED_REDUCED_SIZE' ? 'TRADE_APPROVED_REDUCED_SIZE' : 'TRADE_APPROVED', details: { signalId: candidate.id, tokenAddress: candidate.tokenAddress, symbol: candidate.symbol, notional, executionPrice } }).catch(() => undefined);
      if (candidate.decisionSource === 'NEW_LAUNCH') await this.deps.publishLaunchEvent?.({ userId: candidate.userId, event: 'new_launch_position_opened', mint: candidate.tokenAddress, symbol: candidate.symbol, positionId: result.position.id }).catch(() => undefined);
      await this.deps.publishEvent('position_update', { userId: candidate.userId, action: 'OPENED', decisionSource: candidate.decisionSource, positionId: result.position.id, token: candidate.tokenAddress, symbol: candidate.symbol, price, quantity });
      await this.deps.publishEvent('trade_update', { userId: candidate.userId, action: 'OPENED', tradeId: result.trade.id, orderId: result.order.id, positionId: result.position.id, token: candidate.tokenAddress });
      await this.deps.publishEvent('pnl_update', { userId: candidate.userId, realizedPnl: 0, unrealizedPnl: 0 });
      return 'EXECUTED';
    } finally {
      this.activeKeys.delete(key);
    }
  }

  private async signalContext(candidate: CandidateSignal) {
    let analysis = candidate.analysis;
    let source = analysis ? 'SIGNAL' : null;
    if (!analysis && candidate.manualPaper && this.deps.loadLatestAnalysis) {
      analysis = await this.deps.loadLatestAnalysis(candidate.userId, candidate.tokenAddress).catch(() => null);
      source = analysis ? 'LATEST_ANALYSIS' : null;
    }
    if (!analysis) return null;
    return {
      source,
      primaryStrategy: candidate.manualPaper ? 'MANUAL_PAPER' : candidate.primaryStrategy ?? candidate.strategyName,
      ...analysis,
    };
  }

  /** Writes the actual execution result back to the ML PAPER decision (audit trail; never blocks execution). */
  private async resolveMlDecision(candidate: CandidateSignal, data: { outcome: 'EXECUTED' | 'EXECUTION_REJECTED'; executionReason: string; positionId?: string; tradeId?: string }) {
    const decisionId = candidate.entryStrategy === 'ML' && typeof candidate.ml?.decisionId === 'string' ? candidate.ml.decisionId : null;
    if (!decisionId || !this.deps.prisma.mlPaperDecision?.updateMany) return;
    await this.deps.prisma.mlPaperDecision.updateMany({ where: { id: decisionId }, data: { ...data, executionReason: data.executionReason.slice(0, 500), resolvedAt: new Date() } })
      .catch((error: unknown) => this.deps.logger.warn({ err: error instanceof Error ? error.message : String(error), decisionId }, 'ML PAPER decision result write failed'));
  }

  private async rejectCandidate(candidate: CandidateSignal, reason: string, policy: RiskPolicyName): Promise<'REJECTED'> {
    await this.recordDecision(candidate, {
      decision: 'REJECTED', reasons: [reason], warnings: candidate.riskWarnings,
      riskScore: candidate.riskScore, riskClassification: candidate.riskClassification,
      signalScore: candidate.score, normalPositionSize: 0, riskAdjustedPositionSize: 0, positionMultiplier: 0,
    }, policy);
    return 'REJECTED';
  }

  private markDecided(signalId: string) {
    const now = Date.now();
    this.decidedSignals.set(signalId, now);
    // Signals older than the look-back window are never candidates again, so they can be forgotten.
    for (const [id, decidedAt] of this.decidedSignals) {
      if (now - decidedAt > this.lookbackMs * 2) this.decidedSignals.delete(id);
    }
  }

  private async recordDecision(candidate: CandidateSignal, decision: FinalTradeDecision, policy = candidate.riskPolicy) {
    this.markDecided(candidate.id);
    const details = {
      signalId: candidate.id,
      executionSource: candidate.manualPaper ? 'MANUAL_PAPER' : 'STRATEGY',
      tokenAddress: candidate.tokenAddress,
      riskScore: decision.riskScore,
      riskClassification: decision.riskClassification,
      hardBlocked: decision.decision === 'BLOCKED',
      hardBlockReasons: decision.decision === 'BLOCKED' ? decision.reasons : [],
      warnings: decision.warnings,
      signalScore: decision.signalScore,
      aiOpportunityScore: decision.aiOpportunityScore ?? null,
      aiConfidence: decision.aiConfidence ?? null,
      riskPolicy: policy,
      positionMultiplier: decision.positionMultiplier,
      normalPositionSize: decision.normalPositionSize,
      riskAdjustedPositionSize: decision.riskAdjustedPositionSize,
      finalDecision: decision.decision,
      decisionReasons: decision.reasons,
    };
    const event = decision.decision === 'BLOCKED' ? 'HARD_BLOCK_TRIGGERED'
      : decision.decision === 'APPROVED_REDUCED_SIZE' ? 'TRADE_APPROVED_REDUCED_SIZE'
        : decision.decision === 'APPROVED' ? 'TRADE_APPROVED' : 'TRADE_REJECTED';
    const log = decision.decision === 'APPROVED' || decision.decision === 'APPROVED_REDUCED_SIZE'
      ? this.deps.logger.info
      : this.deps.logger.warn;
    log.call(this.deps.logger, details, event);
    if (decision.decision === 'APPROVED' || decision.decision === 'APPROVED_REDUCED_SIZE') return;
    await this.resolveMlDecision(candidate, { outcome: 'EXECUTION_REJECTED', executionReason: `${decision.decision}: ${decision.reasons.join(',')}` });
    if (this.deps.tracker) {
      try {
        const skip = await this.deps.tracker.recordFailure(candidate.userId, candidate.tokenAddress, decision.reasons);
        if (skip) await this.deps.onTokenSkipped?.(candidate.userId, candidate.tokenAddress, skip);
      } catch (error) {
        this.deps.logger.warn({ err: error, tokenAddress: candidate.tokenAddress }, 'Unbuyable-token tracking failed');
      }
    }
    await this.deps.prisma.auditLog?.create({
      data: { userId: candidate.userId, action: event, details: details as unknown as Prisma.InputJsonValue },
    });
    await this.deps.publishLog?.({ userId: candidate.userId, action: event, details }).catch(() => undefined);
  }
}
