/**
 * Autonomous ML PAPER engine (strategy ML_AUTONOMOUS). Separate from the DEFAULT / ML PAPER path: own decision points,
 * own snapshots, own virtual PAPER ledger. PAPER only; LIVE is unreachable (no wallet, no order router here).
 *
 * Every tick (after the New Launch tick):
 *  1. Collection (independent of users / bundles): ENTRY decision snapshots of token candidates at fixed points after
 *     detection (15 s, 30 s, 1 / 2 / 5 min), re-evaluations every minute (while an account waits) and on large market
 *     moves / liquidity drops, plus POSITION snapshots of open autonomous positions. Bounded by a per-minute budget.
 *  2. Entries: for every user whose selected Autonomous bundle is authorised (shared contract), the bundle decides
 *     BUY / WAIT / SKIP and proposes a size; the mandatory protection (token fraud / honeypot / liquidity / impact /
 *     risk + account limits) may block or reduce it. One position per token and account; one decision per decision
 *     point (unique idempotency key), so restarts and repeated ticks never double an order.
 *  3. Positions (every 10 s and on market moves): technical fail-safes first (hard max loss, liquidity collapse, sell
 *     route lost, technical max hold), then the position's OWN bundle decides HOLD / PARTIAL_SELL / SELL. Bundle
 *     unavailable -> fail-safes only. Without a fresh real price nothing is sold (no invented price).
 *  4. SHADOW: the newest SHADOW-status bundle decides on the same entry snapshots without executing (evaluation data
 *     for the approval gate).
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { Prisma, type PrismaClient } from '@prisma/client';
import {
  buildAutonomousSnapshot, decideEntry, decideExit, DEFAULT_AUTONOMOUS_PROTECTION, entryProtection, exitProtection, ML_AUTONOMOUS_FEATURE_VERSION, ML_AUTONOMOUS_STRATEGY,
  ML_COMMUNITY_FEATURE_VERSION, ML_MIN_LIQUIDITY_SUGGESTED_USD, resolveEntryAuthority, validateBundle,
  type AutonomousBundle, type AutonomousPositionState, type AutonomousProtectionConfig, type AutonomousSnapshotInput, type CommunitySnapshotResult, type EntryAuthority, type LaunchSecurity,
  type LaunchState, type MarketSample, type MlFeatureSnapshotResult, type MlFeatures,
} from '@soltrader/strategy-engine';

import { buildLaunchMlSnapshotFor, ML_REFERENCE_ORDER_USD } from '../ml/launch-snapshot.js';

import { ensureAccount, LedgerError, openPosition, sellPosition } from './ledger.js';

export const AUTONOMOUS_ENTRY_POINTS_MS = [15_000, 30_000, 60_000, 120_000, 300_000] as const;
const POINT_NAMES: Record<number, string> = { 15_000: 'AGE_15S', 30_000: 'AGE_30S', 60_000: 'AGE_60S', 120_000: 'AGE_120S', 300_000: 'AGE_300S' };
const POINT_TOLERANCE_MS = 10_000;
const CANDIDATE_WINDOW_MS = 600_000;
const REEVALUATE_MS = 60_000;
const POSITION_INTERVAL_MS = 10_000;
const POSITION_SNAPSHOT_MS = 30_000;
const HOLD_RECORD_MS = 60_000;
const CONTEXT_REFRESH_MS = 10_000;
const MARKET_MOVE_PCT = 15;
const LIQUIDITY_DROP_PCT = 20;
const MAX_TRACKED = 3_000;

export interface AutonomousLaunchAccessor {
  launches(): Iterable<{ mint: string; source: string; symbol: string | null; detectedAt: number; createdAt: number | null; firstTradeAt: number | null; migrated: boolean; trades: number }>;
  state(mint: string, referenceOrderUsd: number): LaunchState | null;
  security(mint: string): { security: LaunchSecurity; completedAt: number | null } | null;
  samples(mint: string): MarketSample[];
  quote(mint: string, now: number): { price: number; liquidityUsd: number | null; at: number; migrated: boolean } | null;
  tokenSafety(mint: string, now: number, minLiquidityUsd: number): { blockers: string[]; riskScore: number | null; riskObservedAt: number | null };
  candidateId(mint: string): Promise<string | null>;
}

export interface AutonomousEngineDeps {
  prisma: PrismaClient;
  logger: { info(payload: unknown, message?: string): void; warn(payload: unknown, message?: string): void };
  accessor: () => AutonomousLaunchAccessor | null;
  community?: { assess(mint: string, social: null, at: number): CommunitySnapshotResult | null; onchainAt?(mint: string, at: number): { at: number; newBuyerShare1m: number | null; buyers1m: number | null } | null };
  repoRoot: string;
  serverTradingMode: () => string;
  /** Virtual starting balance of a new Autonomous PAPER account (USD). */
  initialBalanceUsd?: number;
  maxSnapshotsPerMinute?: number;
  /** Mandatory ML minimum liquidity (USD) for autonomous entries. */
  minLiquidityUsd?: number;
  readBundle?: (artifactPath: string) => Promise<Buffer>;
  now?: () => number;
}

interface AccountContext {
  userId: string;
  accountId: string;
  authority: EntryAuthority;
  bundleVersion: string | null;
  protection: AutonomousProtectionConfig;
  tradingMode: string | null;
  liveEnabled: boolean;
  emergencyStop: boolean;
  cashUsd: number;
  dayRealizedUsd: number;
  boughtMints: Set<string>;
}

interface CandidateMemory { taken: Set<string>; lastAt: number; lastPrice: number | null; lastLiquidity: number | null; waiting: Set<string> }

type OpenPositionRow = Awaited<ReturnType<PrismaClient['mlAutonomousPosition']['findMany']>>[number];

const num = (value: unknown) => (value === null || value === undefined ? null : Number(value));
const hash = (features: MlFeatures) => createHash('sha256').update(JSON.stringify(features)).digest('hex');
const dec = (value: number | null, digits = 6) => (value === null || !Number.isFinite(value) ? null : new Prisma.Decimal(value.toFixed(digits)));

export class AutonomousEngine {
  private readonly candidates = new Map<string, CandidateMemory>();
  private readonly bundles = new Map<string, { bundle: AutonomousBundle | null; error: string | null }>();
  private bundleRows = new Map<string, { version: string; paperApproved: boolean; status: string; featureVersion: string; artifactPath: string; artifactHash: string }>();
  private accounts: AccountContext[] = [];
  private shadowVersion: string | null = null;
  private contextAt = 0;
  private ticking = false;
  private snapshotWindow = { start: 0, used: 0 };
  private readonly positionMemory = new Map<string, { lastEvalAt: number; lastPrice: number | null; lastLiquidity: number | null; lastSnapshotAt: number; lastHoldRecordAt: number; waitLoggedAt: number }>();
  readonly metrics = {
    entrySnapshots: 0, positionSnapshots: 0, snapshotsSkippedBudget: 0, entryDecisions: 0, buys: 0, buysBlocked: 0, sells: 0, partialSells: 0, protectionSells: 0,
    shadowDecisions: 0, errors: 0, waitingForQuote: 0, duplicatePrevented: 0, bundleLoadFailures: 0,
  };

  constructor(private readonly deps: AutonomousEngineDeps) {}

  private now() {
    return this.deps.now?.() ?? Date.now();
  }

  async tick(now = this.now()) {
    if (this.ticking) return;
    this.ticking = true;
    try {
      if (now - this.contextAt >= CONTEXT_REFRESH_MS) await this.refreshContext(now);
      const accessor = this.deps.accessor();
      if (!accessor) return;
      const regime = this.regime(accessor, now);
      await this.evaluatePositions(accessor, regime, now);
      await this.evaluateCandidates(accessor, regime, now);
      this.housekeeping(now, accessor);
    } catch (error) {
      this.metrics.errors += 1;
      this.deps.logger.warn({ err: error instanceof Error ? error.message.slice(0, 200) : String(error) }, 'Autonomous ML tick failed (existing trading unaffected)');
    } finally {
      this.ticking = false;
    }
  }

  // ------------------------------------------------------------------ context (users, bundles, accounts)

  private async refreshContext(now: number) {
    this.contextAt = now;
    const prisma = this.deps.prisma;
    const settings = await prisma.mlPaperSettings.findMany({ where: { strategyMode: ML_AUTONOMOUS_STRATEGY } });
    const versions = new Set(settings.map((row) => row.autonomousBundleVersion).filter((version): version is string => Boolean(version)));
    const open = await prisma.mlAutonomousPosition.findMany({ where: { status: 'OPEN' }, select: { bundleVersion: true } });
    for (const row of open) versions.add(row.bundleVersion);
    const shadow = await prisma.mlAutonomousModelBundle.findFirst({ where: { status: 'SHADOW' }, orderBy: { trainedAt: 'desc' } });
    if (shadow) versions.add(shadow.version);
    const rows = versions.size ? await prisma.mlAutonomousModelBundle.findMany({ where: { version: { in: [...versions] } } }) : [];
    this.bundleRows = new Map(rows.map((row) => [row.version, row]));
    this.shadowVersion = shadow?.version ?? null;
    for (const row of rows) if (!this.bundles.has(row.version)) await this.loadBundle(row);
    const accounts: AccountContext[] = [];
    const dayStart = new Date(new Date(now).setUTCHours(0, 0, 0, 0));
    for (const row of settings) {
      const bot = await prisma.botConfig.findUnique({ where: { userId: row.userId }, select: { tradingMode: true, isEmergencyStop: true, isLiveEnabled: true } });
      const bundleRow = row.autonomousBundleVersion ? this.bundleRows.get(row.autonomousBundleVersion) ?? null : null;
      const authority = resolveEntryAuthority({
        mlOnly: true, settings: { strategyMode: row.strategyMode, modelVersion: row.modelVersion, autonomousBundleVersion: row.autonomousBundleVersion, tradingPaused: row.tradingPaused },
        model: null, bundle: bundleRow, emergencyStop: Boolean(bot?.isEmergencyStop), tradingMode: bot?.tradingMode ?? null, liveEnabled: Boolean(bot?.isLiveEnabled) || this.deps.serverTradingMode() !== 'PAPER',
      });
      const account = await ensureAccount(prisma, row.userId, this.deps.initialBalanceUsd ?? 1_000);
      const risk = await prisma.riskConfig.findUnique({ where: { userId: row.userId } }).catch(() => null);
      // The stricter of the autonomous defaults and the user's risk limits applies.
      const protection: AutonomousProtectionConfig = {
        ...DEFAULT_AUTONOMOUS_PROTECTION,
        maxPositionPctOfEquity: Math.min(DEFAULT_AUTONOMOUS_PROTECTION.maxPositionPctOfEquity, num(risk?.maxPositionPercent) ?? Number.POSITIVE_INFINITY),
        maxExposurePctOfEquity: Math.min(DEFAULT_AUTONOMOUS_PROTECTION.maxExposurePctOfEquity, num(risk?.maxTotalExposurePercent) ?? Number.POSITIVE_INFINITY),
        dailyLossLimitPct: Math.min(DEFAULT_AUTONOMOUS_PROTECTION.dailyLossLimitPct, num(risk?.dailyLossLimitPercent) ?? Number.POSITIVE_INFINITY),
        maxOpenPositions: Math.min(DEFAULT_AUTONOMOUS_PROTECTION.maxOpenPositions, risk?.maxConcurrentPositions ?? Number.POSITIVE_INFINITY),
      };
      const realized = await prisma.mlAutonomousFill.aggregate({ where: { accountId: account.id, side: 'SELL', at: { gte: dayStart } }, _sum: { realizedPnlUsd: true } });
      const bought = await prisma.mlAutonomousPosition.findMany({ where: { accountId: account.id }, select: { mint: true } });
      accounts.push({
        userId: row.userId, accountId: account.id, authority, bundleVersion: row.autonomousBundleVersion, protection, tradingMode: bot?.tradingMode ?? null,
        liveEnabled: Boolean(bot?.isLiveEnabled) || this.deps.serverTradingMode() !== 'PAPER', emergencyStop: Boolean(bot?.isEmergencyStop), cashUsd: Number(account.cashBalance),
        dayRealizedUsd: num(realized._sum.realizedPnlUsd) ?? 0, boughtMints: new Set(bought.map((item) => item.mint)),
      });
    }
    this.accounts = accounts;
  }

  /** Loads and verifies a bundle once per version (path inside ml/autonomous-models, sha256, schema / policy validation). */
  private async loadBundle(row: { version: string; artifactPath: string; artifactHash: string }) {
    try {
      const root = path.resolve(this.deps.repoRoot, 'ml', 'autonomous-models');
      const file = path.resolve(this.deps.repoRoot, row.artifactPath);
      if (!file.startsWith(root + path.sep)) throw new Error('Bundle path outside ml/autonomous-models');
      const content = this.deps.readBundle ? await this.deps.readBundle(row.artifactPath) : await readFile(file);
      if (createHash('sha256').update(content).digest('hex') !== row.artifactHash) throw new Error('Bundle hash mismatch (corrupt or modified file)');
      const bundle = validateBundle(JSON.parse(content.toString('utf8')));
      if (bundle.bundleVersion !== row.version) throw new Error('Bundle version mismatch');
      this.bundles.set(row.version, { bundle, error: null });
    } catch (error) {
      this.metrics.bundleLoadFailures += 1;
      const message = error instanceof Error ? error.message.slice(0, 200) : String(error);
      this.bundles.set(row.version, { bundle: null, error: message });
      this.deps.logger.warn({ bundleVersion: row.version, err: message }, 'Autonomous bundle unavailable: no entries, open positions on fail-safe protection');
    }
  }

  /** Usable bundle for trading decisions (registry: approved, not retired; file verified). */
  private tradingBundle(version: string | null) {
    if (!version) return null;
    const row = this.bundleRows.get(version);
    if (!row || !row.paperApproved || row.status === 'RETIRED' || row.featureVersion !== ML_AUTONOMOUS_FEATURE_VERSION) return null;
    return this.bundles.get(version)?.bundle ?? null;
  }

  // ------------------------------------------------------------------ market regime

  private regime(accessor: AutonomousLaunchAccessor, now: number): AutonomousSnapshotInput['regime'] {
    const launches = [...accessor.launches()];
    const recent = launches.filter((launch) => now - launch.detectedAt <= 600_000);
    const returns: number[] = [];
    for (const launch of launches) {
      const age = now - launch.detectedAt;
      if (age < 180_000 || age > 600_000) continue;
      const samples = accessor.samples(launch.mint).filter((sample) => sample.t <= now && sample.price !== null && sample.price > 0);
      if (samples.length >= 2) returns.push((samples[samples.length - 1].price! / samples[0].price! - 1) * 100);
    }
    returns.sort((a, b) => a - b);
    return {
      at: now,
      launchRate10m: launches.length ? recent.length / 10 : null,
      medianLaunchReturnPct: returns.length >= 5 ? returns[Math.floor(returns.length / 2)] : null,
      positiveLaunchShare: returns.length >= 5 ? returns.filter((value) => value > 0).length / returns.length : null,
    };
  }

  // ------------------------------------------------------------------ snapshots

  private snapshotBudget(now: number) {
    if (now - this.snapshotWindow.start >= 60_000) this.snapshotWindow = { start: now, used: 0 };
    if (this.snapshotWindow.used >= (this.deps.maxSnapshotsPerMinute ?? 120)) {
      this.metrics.snapshotsSkippedBudget += 1;
      return false;
    }
    this.snapshotWindow.used += 1;
    return true;
  }

  private async persistSnapshot(kind: 'ENTRY' | 'POSITION', mint: string, trigger: string, result: ReturnType<typeof buildAutonomousSnapshot>, extra: { candidateId?: string | null; positionId?: string | null }) {
    const row = await this.deps.prisma.mlAutonomousDecisionSnapshot.create({
      data: {
        kind, mint, trigger, candidateId: extra.candidateId ?? null, positionId: extra.positionId ?? null, at: new Date(result.at), featureVersion: result.featureVersion,
        features: result.features as Prisma.InputJsonValue, observedAt: result.observedAt as Prisma.InputJsonValue, featureHash: hash(result.features), dataQuality: result.dataQuality,
        lateDataExcluded: result.lateDataExcluded as Prisma.InputJsonValue, validForTraining: result.validForTraining, invalidReasons: result.invalidReasons as Prisma.InputJsonValue,
        referencePriceUsd: dec(result.referencePriceUsd, 18), referenceLiquidityUsd: dec(result.referenceLiquidityUsd, 8),
      },
      select: { id: true },
    });
    if (kind === 'ENTRY') this.metrics.entrySnapshots += 1;
    else this.metrics.positionSnapshots += 1;
    return row.id;
  }

  /** Entry context (ML-FEATURES-COMMUNITY-v1) at `now` from the same builder as the ML snapshots; null = not eligible. */
  private entryBase(accessor: AutonomousLaunchAccessor, launch: { mint: string; source: string; detectedAt: number; createdAt: number | null; firstTradeAt: number | null }, now: number) {
    const safety = accessor.tokenSafety(launch.mint, now, this.deps.minLiquidityUsd ?? ML_MIN_LIQUIDITY_SUGGESTED_USD);
    let community: CommunitySnapshotResult | null = null;
    try {
      community = this.deps.community?.assess(launch.mint, null, now) ?? null;
    } catch {
      community = null;
    }
    const { snapshot, eligible } = buildLaunchMlSnapshotFor(ML_COMMUNITY_FEATURE_VERSION, {
      at: now, launch, state: accessor.state(launch.mint, ML_REFERENCE_ORDER_USD), security: accessor.security(launch.mint), riskScore: safety.riskScore, riskObservedAt: safety.riskObservedAt, social: null, community,
    });
    return eligible ? { base: snapshot, safety } : null;
  }

  private dueTrigger(launch: { mint: string; detectedAt: number }, now: number, quote: { price: number; liquidityUsd: number | null } | null) {
    let memory = this.candidates.get(launch.mint);
    if (!memory) {
      if (this.candidates.size >= MAX_TRACKED) return null;
      memory = { taken: new Set(), lastAt: 0, lastPrice: null, lastLiquidity: null, waiting: new Set() };
      this.candidates.set(launch.mint, memory);
    }
    const age = now - launch.detectedAt;
    for (const point of AUTONOMOUS_ENTRY_POINTS_MS) {
      const name = POINT_NAMES[point];
      if (memory.taken.has(name) || age < point) continue;
      memory.taken.add(name);
      if (age <= point + POINT_TOLERANCE_MS) return name;
    }
    if (!memory.lastAt || now - memory.lastAt < 15_000) return null;
    if (quote && memory.lastPrice && Math.abs(quote.price / memory.lastPrice - 1) * 100 >= MARKET_MOVE_PCT) return 'MARKET_MOVE';
    if (quote?.liquidityUsd && memory.lastLiquidity && quote.liquidityUsd <= memory.lastLiquidity * (1 - LIQUIDITY_DROP_PCT / 100)) return 'LIQUIDITY_DROP';
    if (memory.waiting.size && now - memory.lastAt >= REEVALUATE_MS) return 'REEVALUATION';
    return null;
  }

  // ------------------------------------------------------------------ entries

  private async evaluateCandidates(accessor: AutonomousLaunchAccessor, regime: AutonomousSnapshotInput['regime'], now: number) {
    for (const launch of accessor.launches()) {
      if (now - launch.detectedAt > CANDIDATE_WINDOW_MS || launch.trades < 2) continue;
      const quote = accessor.quote(launch.mint, now);
      const trigger = this.dueTrigger(launch, now, quote);
      if (!trigger) continue;
      if (!this.snapshotBudget(now)) continue;
      const entry = this.entryBase(accessor, launch, now);
      if (!entry) continue;
      const memory = this.candidates.get(launch.mint)!;
      memory.lastAt = now;
      memory.lastPrice = quote?.price ?? memory.lastPrice;
      memory.lastLiquidity = quote?.liquidityUsd ?? memory.lastLiquidity;
      const common: AutonomousSnapshotInput = {
        kind: 'ENTRY', at: now, base: entry.base, samples: accessor.samples(launch.mint), quote: quote ? { price: quote.price, liquidityUsd: quote.liquidityUsd, at: quote.at } : null,
        onchain: this.deps.community?.onchainAt?.(launch.mint, now) ?? null, regime, referenceOrderUsd: ML_REFERENCE_ORDER_USD,
      };
      const collected = buildAutonomousSnapshot(common);
      const candidateId = await accessor.candidateId(launch.mint).catch(() => null);
      const snapshotId = await this.persistSnapshot('ENTRY', launch.mint, trigger, collected, { candidateId });
      const triggerKey = trigger === 'REEVALUATION' || trigger === 'MARKET_MOVE' || trigger === 'LIQUIDITY_DROP' ? `${trigger}:${Math.floor(now / 60_000)}` : trigger;
      for (const account of this.accounts) await this.entryFor(account, launch, entry, common, snapshotId, triggerKey, now, quote);
      await this.shadowEntry(launch.mint, collected, snapshotId, triggerKey, now, quote?.liquidityUsd ?? null);
    }
  }

  private async openPositionsOf(accountId: string) {
    return this.deps.prisma.mlAutonomousPosition.findMany({ where: { accountId, status: 'OPEN' } });
  }

  private async entryFor(account: AccountContext, launch: { mint: string; symbol: string | null }, entry: NonNullable<ReturnType<AutonomousEngine['entryBase']>>, common: AutonomousSnapshotInput, snapshotId: string, triggerKey: string, now: number, quote: { price: number; liquidityUsd: number | null; at: number } | null) {
    if (!account.authority.mayOpenEntries || account.authority.entryStrategy !== ML_AUTONOMOUS_STRATEGY) return;
    if (account.boughtMints.has(launch.mint)) return;
    const bundle = this.tradingBundle(account.authority.authorizedModelVersion);
    const memory = this.candidates.get(launch.mint)!;
    const open = await this.openPositionsOf(account.accountId);
    // Exposure at current prices (entry price only when no quote exists for a token).
    const accessor = this.deps.accessor();
    const exposureUsd = open.reduce((sum, position) => sum + Number(position.quantity) * (accessor?.quote(position.mint, now)?.price ?? Number(position.entryMarketPrice)), 0);
    const equityUsd = account.cashUsd + exposureUsd;
    const portfolio = { at: now, exposurePct: equityUsd > 0 ? exposureUsd / equityUsd * 100 : null, openPositions: open.length, dayPnlPct: equityUsd > 0 ? account.dayRealizedUsd / equityUsd * 100 : null };
    const features = buildAutonomousSnapshot({ ...common, portfolio }).features;
    const key = `${account.accountId}:${launch.mint}:ENTRY:${triggerKey}`;
    const base = { mode: 'PAPER', userId: account.userId, accountId: account.accountId, bundleVersion: account.authority.authorizedModelVersion!, snapshotId, mint: launch.mint, kind: 'ENTRY', featureHash: hash(features), decidedAt: new Date(now), idempotencyKey: key };
    if (!bundle) {
      await this.recordDecision({ ...base, action: 'ERROR', executionStatus: 'ERROR', executionReason: this.bundles.get(account.authority.authorizedModelVersion!)?.error ?? 'BUNDLE_UNAVAILABLE' });
      return;
    }
    const decision = decideEntry(bundle, features, { equityUsd, liquidityUsd: quote?.liquidityUsd ?? null });
    this.metrics.entryDecisions += 1;
    if (decision.action === 'WAIT') memory.waiting.add(account.accountId);
    else memory.waiting.delete(account.accountId);
    if (decision.action !== 'BUY') {
      await this.recordDecision({ ...base, action: decision.action, outputs: decision.outputs, executionStatus: decision.action === 'ERROR' ? 'ERROR' : 'NO_ACTION', executionReason: decision.reasons.join(',') || null });
      return;
    }
    const dayStartEquity = equityUsd - account.dayRealizedUsd;
    const guard = entryProtection({
      tradingMode: account.tradingMode, liveEnabled: account.liveEnabled, emergencyStop: account.emergencyStop, quoteAgeMs: quote ? now - quote.at : null, liquidityUsd: quote?.liquidityUsd ?? null,
      requestedSizeUsd: decision.suggestedSizeUsd ?? 0, equityUsd, cashUsd: account.cashUsd, exposureUsd, dayPnlUsd: account.dayRealizedUsd, dayStartEquityUsd: dayStartEquity, openPositions: open.length,
      alreadyHolding: open.some((position) => position.mint === launch.mint), tokenBlockers: entry.safety.blockers,
    }, account.protection);
    const recorded = await this.recordDecision({ ...base, action: 'BUY', outputs: decision.outputs, suggestedSizeUsd: dec(decision.suggestedSizeUsd), executionStatus: guard.allowed ? 'PENDING' : 'SAFETY_BLOCKED', safetyBlockers: guard.blockers, executionReason: guard.allowed ? null : guard.blockers.join(',') });
    if (!recorded) return;
    if (!guard.allowed) {
      this.metrics.buysBlocked += 1;
      return;
    }
    try {
      const opened = await openPosition(this.deps.prisma, {
        accountId: account.accountId, userId: account.userId, mint: launch.mint, symbol: launch.symbol, bundleVersion: base.bundleVersion, sizeUsd: guard.sizeUsd, marketPrice: quote!.price,
        liquidityUsd: quote!.liquidityUsd, entryContext: entry.base, entrySnapshotId: snapshotId, decisionId: recorded.id, at: new Date(now),
      });
      account.boughtMints.add(launch.mint);
      account.cashUsd -= guard.sizeUsd + opened.fee;
      this.metrics.buys += 1;
      await this.deps.prisma.mlAutonomousDecision.update({ where: { id: recorded.id }, data: { executionStatus: 'EXECUTED', executedSizeUsd: dec(guard.sizeUsd), positionId: opened.position.id } });
    } catch (error) {
      const reason = error instanceof LedgerError ? error.code : error instanceof Error ? error.message.slice(0, 120) : 'EXECUTION_FAILED';
      if (error instanceof LedgerError && error.code === 'ALREADY_OPEN') account.boughtMints.add(launch.mint);
      await this.deps.prisma.mlAutonomousDecision.update({ where: { id: recorded.id }, data: { executionStatus: 'REJECTED', executionReason: reason } }).catch(() => undefined);
    }
  }

  private async shadowEntry(mint: string, collected: ReturnType<typeof buildAutonomousSnapshot>, snapshotId: string, triggerKey: string, now: number, liquidityUsd: number | null) {
    const version = this.shadowVersion;
    const bundle = version ? this.bundles.get(version)?.bundle ?? null : null;
    if (!version || !bundle) return;
    const decision = decideEntry(bundle, collected.features, { equityUsd: this.deps.initialBalanceUsd ?? 1_000, liquidityUsd });
    const recorded = await this.recordDecision({
      mode: 'SHADOW', userId: null, accountId: null, bundleVersion: version, snapshotId, mint, kind: 'ENTRY', action: decision.action, outputs: decision.outputs, suggestedSizeUsd: dec(decision.suggestedSizeUsd),
      featureHash: hash(collected.features), decidedAt: new Date(now), executionStatus: 'SHADOW', executionReason: decision.reasons.join(',') || null, idempotencyKey: `SHADOW:${version}:${mint}:ENTRY:${triggerKey}`,
    });
    if (recorded) this.metrics.shadowDecisions += 1;
  }

  /** One decision per idempotency key; a repeat (restart / duplicate tick) returns null and is never executed. */
  private async recordDecision(data: { mode: string; userId: string | null; accountId: string | null; bundleVersion: string; snapshotId: string | null; mint: string; kind: string; action: string; outputs?: unknown; suggestedSizeUsd?: Prisma.Decimal | null; executedSizeUsd?: Prisma.Decimal | null; featureHash: string; decidedAt: Date; executionStatus: string; executionReason?: string | null; safetyBlockers?: string[]; positionId?: string | null; idempotencyKey: string }) {
    try {
      return await this.deps.prisma.mlAutonomousDecision.create({
        data: { ...data, outputs: data.outputs === undefined || data.outputs === null ? Prisma.JsonNull : data.outputs as Prisma.InputJsonValue, safetyBlockers: data.safetyBlockers ? data.safetyBlockers as Prisma.InputJsonValue : Prisma.JsonNull },
        select: { id: true },
      });
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002') {
        this.metrics.duplicatePrevented += 1;
        return null;
      }
      throw error;
    }
  }

  // ------------------------------------------------------------------ positions

  private async evaluatePositions(accessor: AutonomousLaunchAccessor, regime: AutonomousSnapshotInput['regime'], now: number) {
    const positions = await this.deps.prisma.mlAutonomousPosition.findMany({ where: { status: 'OPEN' } });
    for (const position of positions) {
      try {
        await this.evaluatePosition(accessor, regime, position, now);
      } catch (error) {
        this.metrics.errors += 1;
        this.deps.logger.warn({ positionId: position.id, err: error instanceof Error ? error.message.slice(0, 200) : String(error) }, 'Autonomous position evaluation failed');
      }
    }
  }

  private async evaluatePosition(accessor: AutonomousLaunchAccessor, regime: AutonomousSnapshotInput['regime'], position: OpenPositionRow, now: number) {
    let memory = this.positionMemory.get(position.id);
    if (!memory) {
      memory = { lastEvalAt: 0, lastPrice: null, lastLiquidity: null, lastSnapshotAt: 0, lastHoldRecordAt: 0, waitLoggedAt: 0 };
      this.positionMemory.set(position.id, memory);
    }
    const quote = accessor.quote(position.mint, now);
    const moved = quote && memory.lastPrice ? Math.abs(quote.price / memory.lastPrice - 1) * 100 >= MARKET_MOVE_PCT / 1.5 : false;
    const drained = quote?.liquidityUsd && memory.lastLiquidity ? quote.liquidityUsd <= memory.lastLiquidity * (1 - LIQUIDITY_DROP_PCT / 100) : false;
    if (now - memory.lastEvalAt < POSITION_INTERVAL_MS && !moved && !drained) return;
    const trigger = drained ? 'LIQUIDITY_DROP' : moved ? 'MARKET_MOVE' : 'POSITION_PERIODIC';
    memory.lastEvalAt = now;
    if (quote) {
      memory.lastPrice = quote.price;
      memory.lastLiquidity = quote.liquidityUsd;
    }
    const highest = Math.max(Number(position.highestPrice), quote?.price ?? 0);
    const lowest = Math.min(Number(position.lowestPrice), quote?.price ?? Number.POSITIVE_INFINITY);
    await this.deps.prisma.mlAutonomousPosition.update({ where: { id: position.id }, data: { highestPrice: dec(highest, 18)!, lowestPrice: dec(lowest, 18)!, lastEvaluatedAt: new Date(now) } });
    const state: AutonomousPositionState = {
      openedAt: position.openedAt.getTime(), entryFillPrice: Number(position.entryFillPrice), entryMarketPrice: Number(position.entryMarketPrice), entryNotionalUsd: Number(position.entryNotionalUsd),
      entryImpactPct: Number(position.entryImpactPct), highestPrice: highest, lowestPrice: lowest, quantity: Number(position.quantity), partiallySold: position.partiallySold,
    };
    const account = this.accounts.find((item) => item.accountId === position.accountId);
    const base = position.entryContext as unknown as MlFeatureSnapshotResult | null;
    const snapshot = base ? buildAutonomousSnapshot({
      kind: 'POSITION', at: now, base, samples: accessor.samples(position.mint), quote: quote ? { price: quote.price, liquidityUsd: quote.liquidityUsd, at: quote.at } : null,
      // Portfolio state is not part of POSITION rows (replayed training rows cannot know it): missing, never zero.
      onchain: this.deps.community?.onchainAt?.(position.mint, now) ?? null, regime, position: state, portfolio: null,
    }) : null;
    let snapshotId: string | null = null;
    if (snapshot && now - memory.lastSnapshotAt >= POSITION_SNAPSHOT_MS && this.snapshotBudget(now)) {
      memory.lastSnapshotAt = now;
      snapshotId = await this.persistSnapshot('POSITION', position.mint, trigger, snapshot, { positionId: position.id });
    }
    const netIfSold = snapshot ? snapshot.features.unrealizedNetPct as number | null : null;
    const quoteAgeMs = quote ? now - quote.at : null;
    const protection = exitProtection({
      netIfSoldPct: netIfSold, liquidityUsd: quote?.liquidityUsd ?? null, entryLiquidityUsd: num(position.entryLiquidityUsd), holdMs: now - position.openedAt.getTime(), quoteAgeMs,
      // Migrated off the curve without any price source = no executable sell route (forced exit waits for a real quote).
      sellRouteAvailable: quote !== null || ![...accessor.launches()].find((launch) => launch.mint === position.mint)?.migrated,
    }, account?.protection ?? DEFAULT_AUTONOMOUS_PROTECTION);
    const decisionBase = { mode: 'PAPER', userId: position.userId, accountId: position.accountId, bundleVersion: position.bundleVersion, snapshotId, mint: position.mint, kind: 'POSITION', featureHash: snapshot ? hash(snapshot.features) : '', decidedAt: new Date(now), positionId: position.id };
    const minute = Math.floor(now / 60_000);
    if (protection.reason) {
      if (protection.waitForQuote) return this.waitForQuote(memory, position.id, protection.reason, now);
      const recorded = await this.recordDecision({ ...decisionBase, action: 'PROTECTION_SELL', executionStatus: 'PENDING', executionReason: protection.reason, idempotencyKey: `${position.accountId}:${position.mint}:POSITION:PROTECTION:${position.id}:${minute}` });
      if (recorded) await this.executeSell(position, 1, quote!, protection.reason, recorded.id, now, true);
      return;
    }
    // The position's own bundle decides; unavailable -> fail-safe protection only (never DEFAULT exit rules).
    const bundle = this.tradingBundle(position.bundleVersion);
    if (!bundle || !snapshot) return;
    const decision = decideExit(bundle, snapshot.features, { partiallySold: position.partiallySold });
    if (decision.action === 'HOLD' || decision.action === 'ERROR') {
      if (now - memory.lastHoldRecordAt < HOLD_RECORD_MS && decision.action === 'HOLD') return;
      memory.lastHoldRecordAt = now;
      await this.recordDecision({ ...decisionBase, action: decision.action, outputs: decision.outputs, executionStatus: decision.action === 'ERROR' ? 'ERROR' : 'NO_ACTION', executionReason: decision.reasons.join(',') || null, idempotencyKey: `${position.accountId}:${position.mint}:POSITION:${decision.action}:${position.id}:${minute}` });
      return;
    }
    if (quoteAgeMs === null || quoteAgeMs > (account?.protection ?? DEFAULT_AUTONOMOUS_PROTECTION).maxQuoteAgeMs) return this.waitForQuote(memory, position.id, `MODEL_${decision.action}`, now);
    const recorded = await this.recordDecision({ ...decisionBase, action: decision.action, outputs: decision.outputs, executionStatus: 'PENDING', executionReason: decision.reasons.join(',') || null, idempotencyKey: `${position.accountId}:${position.mint}:POSITION:${decision.action}:${position.id}:${Number(position.quantity).toPrecision(8)}:${minute}` });
    if (recorded) await this.executeSell(position, decision.sellFraction, quote!, decision.action === 'SELL' ? 'MODEL_SELL' : 'MODEL_PARTIAL_SELL', recorded.id, now, false);
  }

  private waitForQuote(memory: { waitLoggedAt: number }, positionId: string, reason: string, now: number) {
    this.metrics.waitingForQuote += 1;
    if (now - memory.waitLoggedAt >= 60_000) {
      memory.waitLoggedAt = now;
      this.deps.logger.warn({ positionId, reason }, 'Autonomous exit due but no fresh real price: waiting (never an invented sell price)');
    }
  }

  private async executeSell(position: OpenPositionRow, fraction: number, quote: { price: number; liquidityUsd: number | null }, reason: string, decisionId: string, now: number, protection: boolean) {
    try {
      const sold = await sellPosition(this.deps.prisma, { positionId: position.id, fraction, marketPrice: quote.price, liquidityUsd: quote.liquidityUsd, reason, decisionId, at: new Date(now) });
      if (protection) this.metrics.protectionSells += 1;
      else if (sold.closed) this.metrics.sells += 1;
      else this.metrics.partialSells += 1;
      const account = this.accounts.find((item) => item.accountId === position.accountId);
      if (account) {
        account.cashUsd += sold.proceeds - sold.fee;
        account.dayRealizedUsd += sold.realized;
      }
      await this.deps.prisma.mlAutonomousDecision.update({ where: { id: decisionId }, data: { executionStatus: 'EXECUTED', executedSizeUsd: dec(sold.proceeds) } });
    } catch (error) {
      const code = error instanceof LedgerError ? error.code : error instanceof Error ? error.message.slice(0, 120) : 'SELL_FAILED';
      await this.deps.prisma.mlAutonomousDecision.update({ where: { id: decisionId }, data: { executionStatus: 'REJECTED', executionReason: code } }).catch(() => undefined);
    }
  }

  private housekeeping(now: number, accessor: AutonomousLaunchAccessor) {
    const tracked = new Set([...accessor.launches()].map((launch) => launch.mint));
    for (const [mint, memory] of this.candidates) if (!tracked.has(mint) || now - memory.lastAt > 2 * CANDIDATE_WINDOW_MS) this.candidates.delete(mint);
  }

  /** Credential-free health for Redis (ml:autonomous:health). */
  health() {
    return {
      at: new Date(this.now()).toISOString(), mode: 'PAPER', accounts: this.accounts.map((account) => ({ accountId: account.accountId, state: account.authority.state, bundleVersion: account.bundleVersion, reasons: account.authority.reasons })),
      shadowBundle: this.shadowVersion, bundles: [...this.bundles.entries()].map(([version, entry]) => ({ version, loaded: Boolean(entry.bundle), error: entry.error })),
      trackedCandidates: this.candidates.size, metrics: this.metrics,
    };
  }
}
