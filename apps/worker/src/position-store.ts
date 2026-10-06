import { Prisma, type PrismaClient } from '@prisma/client';
import { closePaperPosition, recomputePaperAccount, summarizePathMetric, type CapacityClass, type CapacityConfig, type PathMetricState } from '@soltrader/trading-engine';

import type { PositionManagerStore, PositionRecord } from './position-manager.js';

export interface PrismaPositionStoreOptions {
  publishEvent: PositionManagerStore['publishEvent'];
  publishLog?: (entry: { userId: string; action: string; details: Record<string, unknown> }) => Promise<void>;
  /** Restricts the store to one user's positions (deterministic simulations / tests). */
  userId?: string;
}

/**
 * Prisma-backed store of the PAPER position manager: loads open positions with their persisted
 * protection/trailing state, persists every evaluated mark, and books exits exactly once.
 */
export function createPrismaPositionStore(prisma: PrismaClient, options: PrismaPositionStoreOptions): PositionManagerStore {
  const publishLog = options.publishLog ?? (async () => undefined);
  /** Persists the lifecycle events produced by the Exit Engine for this evaluation. */
  const recordEvents = async (positionId: string, updates: Partial<PositionRecord>, client: Pick<PrismaClient, 'positionEvent'> = prisma) => {
    if (!updates.userId || !updates.positionEvents?.length) return;
    await client.positionEvent.createMany({ data: updates.positionEvents.map((event) => ({ positionId, userId: updates.userId!, type: event.type, at: updates.updatedAt ? new Date(updates.updatedAt) : new Date(), price: new Prisma.Decimal(event.price), details: (event.details ?? {}) as Prisma.InputJsonValue })) });
  };
  /** Upserts the position's real price-path metrics (MFE / MAE / milestones). */
  const savePathMetric = async (positionId: string, updates: Partial<PositionRecord>, client: Pick<PrismaClient, 'positionPathMetric'> = prisma) => {
    const state = updates.pathMetric;
    if (!state || !updates.userId || !client.positionPathMetric) return;
    const summary = summarizePathMetric(state);
    const decimal = (value: number | null) => (value === null || !Number.isFinite(value) ? null : new Prisma.Decimal(value));
    const data = {
      maxPriceAfterEntry: decimal(summary.maxPriceAfterEntry),
      minPriceAfterEntry: decimal(summary.minPriceAfterEntry),
      mfePercent: decimal(summary.mfePercent),
      mfeUsd: decimal(summary.mfeUsd),
      timeToMfeMs: summary.timeToMfeMs,
      maePercent: decimal(summary.maePercent),
      maeUsd: decimal(summary.maeUsd),
      timeToMaeMs: summary.timeToMaeMs,
      milestones: summary.milestones as Prisma.InputJsonValue,
      lastLiquidityUsd: decimal(state.lastLiquidity),
      minLiquidityUsd: decimal(state.minLiquidity),
      sampleCount: state.sampleCount,
      lastPriceAt: state.lastPriceAt ? new Date(state.lastPriceAt) : null,
    };
    await client.positionPathMetric.upsert({
      where: { positionId },
      update: data,
      create: {
        ...data, positionId, userId: updates.userId, decisionSource: updates.exitPolicy === 'NEW_LAUNCH' ? 'NEW_LAUNCH' : null,
        entryPrice: new Prisma.Decimal(state.entryPrice), entryAt: new Date(state.entryAt), quantity: new Prisma.Decimal(state.quantity),
        liquidityAtEntry: decimal(state.liquidityAtEntry), source: 'LIVE_TRACKING',
      },
    });
  };
  const loadPathMetric = (row: { entryPrice: Prisma.Decimal; entryAt: Date; quantity: Prisma.Decimal; maxPriceAfterEntry: Prisma.Decimal | null; minPriceAfterEntry: Prisma.Decimal | null; mfePercent: Prisma.Decimal | null; maePercent: Prisma.Decimal | null; timeToMfeMs: number | null; timeToMaeMs: number | null; milestones: Prisma.JsonValue; liquidityAtEntry: Prisma.Decimal | null; lastLiquidityUsd: Prisma.Decimal | null; minLiquidityUsd: Prisma.Decimal | null; sampleCount: number; lastPriceAt: Date | null } | null): PathMetricState | null => (row ? {
    entryPrice: Number(row.entryPrice),
    entryAt: row.entryAt.getTime(),
    quantity: Number(row.quantity),
    maxPrice: row.maxPriceAfterEntry !== null ? Number(row.maxPriceAfterEntry) : null,
    minPrice: row.minPriceAfterEntry !== null ? Number(row.minPriceAfterEntry) : null,
    timeToMaxMs: row.timeToMfeMs,
    timeToMinMs: row.timeToMaeMs,
    milestones: (row.milestones && typeof row.milestones === 'object' ? row.milestones : {}) as Record<string, number>,
    liquidityAtEntry: row.liquidityAtEntry !== null ? Number(row.liquidityAtEntry) : null,
    lastLiquidity: row.lastLiquidityUsd !== null ? Number(row.lastLiquidityUsd) : null,
    minLiquidity: row.minLiquidityUsd !== null ? Number(row.minLiquidityUsd) : null,
    sampleCount: row.sampleCount,
    lastPriceAt: row.lastPriceAt ? row.lastPriceAt.getTime() : null,
  } : null);
  return {
    async getOpenPositions(filter) {
      const positions = await prisma.position.findMany({
        where: { status: 'OPEN', mode: 'PAPER', ...(options.userId ? { userId: options.userId } : {}), ...(filter?.exitPolicy ? { exitPolicy: filter.exitPolicy } : {}) },
        include: { token: true, pathMetric: true, trades: { where: { status: 'OPEN' }, take: 1, select: { configSnapshot: true, fees: true } }, user: { include: { riskConfigs: { select: { stopLossPercent: true, takeProfitPercent: true } }, advancedStrategyConfig: { select: { liquidityOutflowExitEnabled: true, liquidityOutflowExitPercent: true } } } } },
        orderBy: { openedAt: 'desc' },
      });

      return positions.map((position) => ({
        id: position.id,
        userId: position.userId,
        token: position.token.address,
        symbol: position.token.symbol,
        side: position.side === 'BUY' ? 'BUY' : 'SELL',
        quantity: Number(position.quantity),
        avgEntryPrice: Number(position.avgEntryPrice),
        currentPrice: Number(position.currentPrice ?? position.avgEntryPrice),
        stopLoss: position.stopLossPrice ? Number(position.stopLossPrice) : null,
        takeProfit: position.takeProfitPrice ? Number(position.takeProfitPrice) : null,
        trailingStop: position.trailingStopPercent ? Number(position.trailingStopPercent) : null,
        highestPrice: position.highestPrice ? Number(position.highestPrice) : Number(position.currentPrice ?? position.avgEntryPrice),
        lowestPrice: position.lowestPrice ? Number(position.lowestPrice) : Number(position.currentPrice ?? position.avgEntryPrice),
        unrealizedPnl: position.unrealizedPnl ? Number(position.unrealizedPnl) : 0,
        realizedPnl: position.realizedPnl ? Number(position.realizedPnl) : 0,
        status: 'OPEN',
        exitReason: position.exitReason ?? null,
        strategy: position.strategyId ? 'position-manager' : null,
        signalId: position.signalId ?? null,
        openedAt: position.openedAt,
        closedAt: position.closedAt,
        stopLossPercent: position.user.riskConfigs[0]?.stopLossPercent != null ? Number(position.user.riskConfigs[0].stopLossPercent) : null,
        takeProfitPercent: position.user.riskConfigs[0]?.takeProfitPercent != null ? Number(position.user.riskConfigs[0].takeProfitPercent) : null,
        // Trailing/break-even state is persisted per position, so a worker restart continues where it was.
        trailingActivation: position.trailingActivationPercent !== null ? Number(position.trailingActivationPercent) : null,
        trailingActive: position.trailingActive,
        trailingActivatedAt: position.trailingActivatedAt,
        trailingActivationPrice: position.trailingActivationPrice !== null ? Number(position.trailingActivationPrice) : null,
        trailingTriggerPrice: position.trailingTriggerPrice !== null ? Number(position.trailingTriggerPrice) : null,
        breakEvenActivation: position.breakEvenActivationPercent !== null ? Number(position.breakEvenActivationPercent) : null,
        breakEvenAppliedAt: position.breakEvenAppliedAt,
        entryLiquidityUsd: position.entryLiquidityUsd !== null ? Number(position.entryLiquidityUsd) : null,
        // The threshold snapshotted at entry (NewLaunch) wins over the owner's current global setting.
        liquidityOutflowExitPercent: position.liquidityExitPercent !== null
          ? Number(position.liquidityExitPercent)
          : position.exitPolicy === 'NEW_LAUNCH' ? null : position.user.advancedStrategyConfig?.liquidityOutflowExitEnabled ? Number(position.user.advancedStrategyConfig.liquidityOutflowExitPercent) : null,
        exitPolicy: position.exitPolicy,
        breakEvenCostBuffer: position.breakEvenCostBuffer !== null ? Number(position.breakEvenCostBuffer) : null,
        maxHoldUntil: position.maxHoldUntil,
        pathMetric: loadPathMetric(position.pathMetric),
        // Entry fee of the open trade (cash already paid): part of the open P&L.
        entryFee: position.trades[0]?.fees != null ? Number(position.trades[0].fees) : null,
        // Exit capacity snapshotted at entry (NewLaunch): thresholds and class, for post-entry deterioration tracking.
        capacity: (() => {
          const snapshot = (position.trades[0]?.configSnapshot ?? null) as { launch?: { exitCapacity?: { config?: CapacityConfig; atEntry?: { classification?: CapacityClass } } | null } } | null;
          const entry = snapshot?.launch?.exitCapacity;
          return entry ? { config: entry.config ?? null, classAtEntry: entry.atEntry?.classification ?? null, current: entry.atEntry?.classification ?? null, routeStatus: null } : null;
        })(),
      }));
    },
    async getAccountEquity(userId) {
      const account = await prisma.paperAccount.findUnique({ where: { userId }, select: { equity: true } });
      return account ? Number(account.equity) : null;
    },
    async refreshAccount(userId) {
      await recomputePaperAccount(prisma, userId);
    },
    async updatePosition(id, updates) {
      if (!updates.userId) throw new Error('Position owner is required for updates');
      // Conditional on OPEN so a concurrent close (manual, emergency) is never overwritten by a mark update.
      await prisma.position.updateMany({
        where: { id, userId: updates.userId, status: 'OPEN' },
        data: {
          currentPrice: updates.currentPrice !== undefined && updates.currentPrice !== null ? new Prisma.Decimal(updates.currentPrice) : undefined,
          unrealizedPnl: updates.unrealizedPnl !== undefined && updates.unrealizedPnl !== null ? new Prisma.Decimal(updates.unrealizedPnl) : undefined,
          highestPrice: updates.highestPrice !== undefined && updates.highestPrice !== null ? new Prisma.Decimal(updates.highestPrice) : undefined,
          lowestPrice: updates.lowestPrice !== undefined && updates.lowestPrice !== null ? new Prisma.Decimal(updates.lowestPrice) : undefined,
          stopLossPrice: updates.stopLoss !== undefined && updates.stopLoss !== null ? new Prisma.Decimal(updates.stopLoss) : undefined,
          takeProfitPrice: updates.takeProfit !== undefined && updates.takeProfit !== null ? new Prisma.Decimal(updates.takeProfit) : undefined,
          trailingStopPercent: updates.trailingStop !== undefined && updates.trailingStop !== null ? new Prisma.Decimal(updates.trailingStop) : undefined,
          trailingActive: updates.trailingActive,
          trailingActivatedAt: updates.trailingActivatedAt ? new Date(updates.trailingActivatedAt) : undefined,
          trailingActivationPrice: updates.trailingActivationPrice !== undefined && updates.trailingActivationPrice !== null ? new Prisma.Decimal(updates.trailingActivationPrice) : undefined,
          trailingTriggerPrice: updates.trailingTriggerPrice !== undefined && updates.trailingTriggerPrice !== null ? new Prisma.Decimal(updates.trailingTriggerPrice) : undefined,
          breakEvenAppliedAt: updates.breakEvenAppliedAt ? new Date(updates.breakEvenAppliedAt) : undefined,
          updatedAt: updates.updatedAt ?? new Date(),
        },
      });
      await recordEvents(id, updates);
      await savePathMetric(id, updates).catch(() => undefined);
    },
    async closePosition(id, updates) {
      if (!updates.userId) throw new Error('Position owner is required for closure');
      const userId = updates.userId;
      let exitDetails: Record<string, unknown> | undefined;
      await prisma.$transaction(async (transaction) => {
        const exitReason = updates.exitReason ?? 'POSITION_EXIT';
        // Persist the final evaluated state (peak, trailing trigger, activation) before the close reads it.
        await transaction.position.updateMany({
          where: { id, userId, status: 'OPEN' },
          data: {
            highestPrice: updates.highestPrice != null ? new Prisma.Decimal(updates.highestPrice) : undefined,
            lowestPrice: updates.lowestPrice != null ? new Prisma.Decimal(updates.lowestPrice) : undefined,
            stopLossPrice: updates.stopLoss != null ? new Prisma.Decimal(updates.stopLoss) : undefined,
            trailingActive: updates.trailingActive,
            trailingActivatedAt: updates.trailingActivatedAt ? new Date(updates.trailingActivatedAt) : undefined,
            trailingActivationPrice: updates.trailingActivationPrice != null ? new Prisma.Decimal(updates.trailingActivationPrice) : undefined,
            trailingTriggerPrice: updates.trailingTriggerPrice != null ? new Prisma.Decimal(updates.trailingTriggerPrice) : undefined,
            breakEvenAppliedAt: updates.breakEvenAppliedAt ? new Date(updates.breakEvenAppliedAt) : undefined,
          },
        });
        const result = await closePaperPosition(transaction, {
          positionId: id,
          userId,
          exitPrice: updates.currentPrice ?? null,
          exitSlippagePercent: updates.exitSlippagePercent ?? null,
          // Paper sell request/fill timing: trigger (evaluation) -> sell requested -> fill created in this transaction.
          diagnostics: (() => {
            const fillAt = Date.now();
            const stamps = (updates.exitDiagnostics?.latencyTimestamps ?? {}) as Record<string, string | null | undefined>;
            const requestedAt = stamps.exitExecutionRequestedAt ? Date.parse(stamps.exitExecutionRequestedAt) : fillAt;
            const triggerAt = typeof updates.exitDiagnostics?.exitTriggerAt === 'string' ? new Date(updates.exitDiagnostics.exitTriggerAt).getTime() : null;
            // exitExecutionLatencyMs = trigger -> paper fill (includes any simulated PAPER execution latency).
            return { ...updates.exitDiagnostics, paperSellRequestedAt: new Date(requestedAt).toISOString(), paperFillAt: new Date(fillAt).toISOString(), exitExecutionLatencyMs: triggerAt !== null ? fillAt - triggerAt : null };
          })(),
          exitReason,
          closedAt: updates.closedAt ? new Date(updates.closedAt) : new Date(),
        });
        if (!result) return;
        await recordEvents(id, updates, transaction);
        await savePathMetric(id, updates, transaction);
        await transaction.positionEvent.create({ data: { positionId: id, userId, type: 'EXIT', at: updates.closedAt ? new Date(updates.closedAt) : new Date(), price: new Prisma.Decimal(result.exitPrice), details: { exitReason, exitMarketPrice: result.exitMarketPrice, netPnl: result.netPnl, grossPnl: result.grossPnl } as Prisma.InputJsonValue } });
        await transaction.auditLog.create({ data: { userId, action: 'PAPER_EXIT_EXECUTED', details: { positionId: id, tradeId: result.tradeId, exitMarketPrice: result.exitMarketPrice, exitPrice: result.exitPrice, exitSlippage: result.exitSlippage, exitReason, grossPnl: result.grossPnl, netPnl: result.netPnl } } });
        exitDetails = { positionId: id, exitMarketPrice: result.exitMarketPrice, exitPrice: result.exitPrice, exitReason, netPnl: result.netPnl };
      });
      if (exitDetails) await publishLog({ userId, action: 'PAPER_EXIT_EXECUTED', details: exitDetails }).catch(() => undefined);
    },
    publishEvent: options.publishEvent,
  };
}
