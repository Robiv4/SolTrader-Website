import type { Prisma } from '@prisma/client';
import { computeMarketFeatures, type MarketObservation } from '@soltrader/strategy-engine';
import { DEFAULT_CAPACITY_CONFIG, describeExitLevels, estimateExitSlippagePercent, maxSafePosition, paperFee, type PersistedExitState } from '@soltrader/trading-engine';

import { prisma } from './database.js';
import { buildExitForensics } from './exit-forensics.js';

type Decimalish = Prisma.Decimal | number | string | null | undefined;
export function num(value: Decimalish): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === 'number' ? value : Number(value.toString());
  return Number.isFinite(parsed) ? parsed : null;
}

type PositionWithRelations = NonNullable<Awaited<ReturnType<typeof loadPosition>>>;

async function loadPosition(userId: string, positionId: string) {
  return prisma.position.findFirst({
    where: { id: positionId, userId },
    include: { token: true, trades: { orderBy: { createdAt: 'asc' } }, events: { orderBy: { at: 'asc' } }, pathMetric: true },
  });
}

export function persistedExitState(position: { avgEntryPrice: Decimalish; stopLossPrice: Decimalish; takeProfitPrice: Decimalish; trailingStopPercent: Decimalish; trailingActivationPercent: Decimalish; trailingActive: boolean; trailingActivatedAt: Date | null; trailingActivationPrice: Decimalish; trailingTriggerPrice: Decimalish; breakEvenActivationPercent: Decimalish; breakEvenAppliedAt: Date | null; highestPrice: Decimalish; lowestPrice: Decimalish }): PersistedExitState {
  return {
    entryPrice: num(position.avgEntryPrice) ?? 0,
    stopLossPrice: num(position.stopLossPrice),
    takeProfitPrice: num(position.takeProfitPrice),
    trailingDistance: num(position.trailingStopPercent),
    trailingActivation: num(position.trailingActivationPercent),
    trailingActive: position.trailingActive,
    trailingActivatedAt: position.trailingActivatedAt,
    trailingActivationPrice: num(position.trailingActivationPrice),
    trailingTriggerPrice: num(position.trailingTriggerPrice),
    breakEvenActivation: num(position.breakEvenActivationPercent),
    breakEvenAppliedAt: position.breakEvenAppliedAt,
    highestPrice: num(position.highestPrice),
    lowestPrice: num(position.lowestPrice),
  };
}

/** Decision source label of a position (from its entry trade; legacy trades are STRATEGY / MANUAL_PAPER). */
export function positionDecisionSource(trade: { decisionSource: string; strategyName: string | null } | undefined) {
  if (!trade) return 'STRATEGY';
  if (trade.strategyName === 'MANUAL_PAPER') return 'MANUAL_PAPER';
  return trade.decisionSource;
}

async function marketCard(position: PositionWithRelations) {
  const since = new Date(Date.now() - 65 * 60_000);
  const [metrics, candidate] = await Promise.all([
    prisma.tokenMetric.findMany({ where: { tokenId: position.tokenId, timestamp: { gte: since } }, orderBy: { timestamp: 'asc' } }),
    prisma.launchCandidate.findUnique({ where: { mint: position.token.address }, include: { snapshots: { orderBy: { takenAt: 'desc' }, take: 1 } } }),
  ]);
  const observations: MarketObservation[] = metrics.map((row) => ({
    timestamp: row.timestamp, priceUsd: num(row.priceUsd), liquidityUsd: num(row.liquidityUsd), volume5m: num(row.volume5m), volume1h: num(row.volume1h),
    buyCount5m: row.buyCount5m, sellCount5m: row.sellCount5m, buyCount1h: row.buyCount1h, sellCount1h: row.sellCount1h,
    priceChange5m: num(row.priceChange5m), priceChange1h: num(row.priceChange1h), priceChange24h: num(row.priceChange24h),
  }));
  const latest = metrics.at(-1) ?? null;
  const features = observations.length ? computeMarketFeatures(observations, new Date(), { staleAfterMs: 10 * 60_000 }) : null;
  const launchSnapshot = candidate?.snapshots[0] ?? null;
  const tokenAgeSeconds = candidate ? Math.round((Date.now() - (candidate.createdAt ?? candidate.detectedAt).getTime()) / 1000) : latest?.tokenAgeSeconds ?? null;
  return {
    priceUsd: num(position.currentPrice),
    marketCapUsd: num(latest?.marketCap) ?? num(launchSnapshot?.marketCapUsd),
    fdvUsd: num(latest?.fdv),
    liquidityUsd: num(latest?.liquidityUsd) ?? num(launchSnapshot?.liquidityUsd),
    volume5m: num(latest?.volume5m),
    volume1h: num(latest?.volume1h),
    priceChange1m: features?.priceChange1m ?? null,
    priceChange5m: features?.priceChange5m ?? null,
    priceChange15m: features?.priceChange15m ?? null,
    priceChange1h: features?.priceChange1h ?? null,
    buys5m: latest?.buyCount5m ?? launchSnapshot?.buyCount ?? null,
    sells5m: latest?.sellCount5m ?? launchSnapshot?.sellCount ?? null,
    buySellRatio: features?.buySellCountRatio ?? null,
    transactions5m: features?.transactions5m ?? (launchSnapshot ? (launchSnapshot.buyCount ?? 0) + (launchSnapshot.sellCount ?? 0) : null),
    tokenAgeSeconds,
    updatedAt: latest?.timestamp ?? launchSnapshot?.takenAt ?? position.updatedAt,
    source: launchSnapshot && (!latest || launchSnapshot.takenAt > latest.timestamp) ? 'LAUNCH_STREAM' : latest ? 'MARKET_DATA' : 'POSITION_MARK',
  };
}

async function securityCard(position: PositionWithRelations, userId: string) {
  const [risk, candidate] = await Promise.all([
    prisma.riskAssessment.findFirst({ where: { tokenId: position.tokenId, OR: [{ userId }, { userId: null }] }, orderBy: { createdAt: 'desc' } }),
    prisma.launchCandidate.findUnique({ where: { mint: position.token.address }, select: { security: true } }),
  ]);
  const launchSecurity = (candidate?.security ?? null) as { sellability?: string; mintAuthorityRevoked?: boolean | null; freezeAuthorityRevoked?: boolean | null; tokenProgram?: string | null; extensions?: string[] | null } | null;
  const entry = position.trades[0];
  const launch = ((entry?.configSnapshot ?? null) as { launch?: Record<string, unknown> } | null)?.launch ?? null;
  const warnings = Array.isArray(risk?.warnings) ? (risk!.warnings as string[]) : [];
  const factors = (risk?.factors ?? {}) as Record<string, number>;
  // Unknown stays unknown: nothing is shown as safe without a real check.
  const sellability = launchSecurity?.sellability ?? (launch ? 'VERIFIED' : warnings.includes('SELLABILITY_NOT_VERIFIED') ? 'NOT_VERIFIED' : 'UNKNOWN');
  return {
    sellability,
    mintAuthority: launchSecurity?.mintAuthorityRevoked === true ? 'REVOKED' : launchSecurity?.mintAuthorityRevoked === false ? 'ACTIVE' : warnings.includes('MINT_AUTHORITY_ACTIVE') ? 'ACTIVE' : typeof factors.mintAuthorityRisk === 'number' && factors.mintAuthorityRisk === 0 ? 'REVOKED' : 'UNKNOWN',
    freezeAuthority: launchSecurity?.freezeAuthorityRevoked === true ? 'REVOKED' : launchSecurity?.freezeAuthorityRevoked === false ? 'ACTIVE' : warnings.includes('FREEZE_AUTHORITY_ACTIVE') ? 'ACTIVE' : typeof factors.freezeAuthorityRisk === 'number' && factors.freezeAuthorityRisk === 0 ? 'REVOKED' : 'UNKNOWN',
    tokenStandard: launchSecurity?.tokenProgram ?? null,
    extensions: launchSecurity?.extensions ?? null,
    holderConcentrationRisk: typeof factors.holderDistributionRisk === 'number' ? factors.holderDistributionRisk : null,
    topHolderConcentrationRisk: typeof factors.topHolderConcentrationRisk === 'number' ? factors.topHolderConcentrationRisk : null,
    liquidityRisk: typeof factors.liquidityRisk === 'number' ? factors.liquidityRisk : null,
    riskScore: num(risk?.riskScore) ?? num(entry?.riskScore),
    riskClassification: risk?.classification ?? entry?.riskClassification ?? null,
    hardBlocked: risk?.hardBlocked ?? false,
    hardBlockReasons: Array.isArray(risk?.hardBlockReasons) ? risk!.hardBlockReasons : [],
    warnings,
    assessedAt: risk?.createdAt ?? null,
  };
}

async function decisionCard(position: PositionWithRelations) {
  const entry = position.trades[0];
  const source = positionDecisionSource(entry);
  const snapshot = (entry?.configSnapshot ?? null) as Record<string, unknown> | null;
  if (source === 'AI' && entry?.aiAnalysisId) {
    const ai = await prisma.aiAnalysis.findFirst({ where: { id: entry.aiAnalysisId, userId: position.userId } });
    return {
      source,
      ai: ai ? {
        provider: ai.provider, model: ai.model, promptVersion: ai.promptVersion, rawDecision: ai.rawDecision, effectiveDecision: ai.effectiveDecision,
        confidence: num(ai.confidence), entryQuality: num(ai.entryQuality), marketStrength: num(ai.marketStrength), timingQuality: num(ai.timingQuality),
        reasons: ai.reasons, warnings: ai.warnings, analyzedAt: ai.createdAt,
      } : null,
    };
  }
  if (source === 'NEW_LAUNCH') return { source, launch: snapshot?.launch ?? null };
  const signal = entry?.signalId ? await prisma.signal.findFirst({ where: { id: entry.signalId, userId: position.userId }, select: { strategyName: true, score: true, reasons: true } }) : null;
  const context = (snapshot?.signalContext ?? null) as Record<string, unknown> | null;
  return {
    source,
    strategy: {
      primaryStrategy: entry?.strategyName ?? signal?.strategyName ?? null,
      strategyScore: num(entry?.signalScore) ?? num(signal?.score),
      compositeScore: context?.compositeScore ?? null,
      confirmations: context?.confirmedModules ?? null,
      reasons: signal?.reasons ?? context?.reasons ?? null,
      warnings: context?.warnings ?? null,
    },
  };
}

/**
 * Execution capacity: the immutable entry snapshot (exit capacity + shadow sizing), post-entry capacity events and the
 * capacity at the exit trigger. Positions opened before the capacity engine only get a LIQUIDITY_ESTIMATE of the safe
 * size from the stored entry liquidity (marked as an estimate).
 */
const record = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {});
const anyNum = (value: unknown) => num(value as Decimalish);

function executionCapacityCard(position: { entryLiquidityUsd: unknown; avgEntryPrice: unknown; events: Array<{ type: string; at: Date; price: unknown; details: unknown }> }, trade: { configSnapshot: unknown; exitDiagnostics: unknown; size: unknown } | null) {
  const snapshot = record(record(record(trade?.configSnapshot).launch).exitCapacity);
  const events = position.events.filter((event) => ['EXIT_CAPACITY_DETERIORATED', 'SELL_ROUTE_LOST', 'SELL_ROUTE_CHANGED'].includes(event.type)).map((event) => ({ type: event.type, at: event.at.toISOString(), price: anyNum(event.price), details: record(event.details) }));
  const atTrigger = record(record(trade?.exitDiagnostics).exitCapacityAtTrigger);
  const liquidity = anyNum(position.entryLiquidityUsd);
  const estimate = !Object.keys(snapshot).length && liquidity ? maxSafePosition({ priceUsd: anyNum(position.avgEntryPrice), liquidityUsd: liquidity }, DEFAULT_CAPACITY_CONFIG) : null;
  return {
    hasEntrySnapshot: Object.keys(snapshot).length > 0,
    atEntry: Object.keys(snapshot).length ? snapshot.atEntry ?? null : null,
    sizing: Object.keys(snapshot).length ? snapshot.sizing ?? null : null,
    capacityCurve: snapshot.capacityCurve ?? null,
    routeAtEntry: snapshot.routeAtEntry ?? null,
    liquidityAtEntry: anyNum(snapshot.liquidityAtEntry) ?? liquidity,
    actualSize: anyNum(trade?.size),
    legacyEstimate: estimate ? { maxSafePosition: estimate.size, bindingConstraint: estimate.binding, basis: 'LIQUIDITY_ESTIMATE', config: DEFAULT_CAPACITY_CONFIG } : null,
    events,
    atTrigger: Object.keys(atTrigger).length ? atTrigger : null,
  };
}

/** Entry-time settings (snapshot) vs the levels the position carries now (never the current user settings). */
function configurationCard(position: PositionWithRelations) {
  const snapshot = (position.trades[0]?.configSnapshot ?? null) as Record<string, unknown> | null;
  const entry = num(position.avgEntryPrice) ?? 0;
  const pct = (price: Decimalish) => (num(price) !== null && entry > 0 ? (num(price)! / entry - 1) * 100 : null);
  return {
    atEntry: snapshot ? {
      stopLossPercent: snapshot.stopLossPercent ?? null,
      takeProfitPercent: snapshot.takeProfitPercent ?? null,
      trailingActivationPercent: snapshot.trailingActivationPercent ?? null,
      trailingStopPercent: snapshot.trailingStopPercent ?? null,
      breakEvenActivationPercent: snapshot.breakEvenActivationPercent ?? null,
      riskMultiplier: snapshot.riskMultiplier ?? null,
      minSignalScore: snapshot.minSignalScore ?? null,
      maxPositionPercent: snapshot.maxPositionPercent ?? null,
      riskPolicy: snapshot.riskPolicy ?? null,
      capturedAt: snapshot.capturedAt ?? null,
    } : null,
    currentPosition: {
      stopLossPercent: pct(position.stopLossPrice),
      takeProfitPercent: pct(position.takeProfitPrice),
      trailingActivationPercent: num(position.trailingActivationPercent) !== null ? num(position.trailingActivationPercent)! * 100 : null,
      trailingStopPercent: num(position.trailingStopPercent) !== null ? num(position.trailingStopPercent)! * 100 : null,
      breakEvenActivationPercent: num(position.breakEvenActivationPercent) !== null ? num(position.breakEvenActivationPercent)! * 100 : null,
    },
  };
}

function timeline(position: PositionWithRelations) {
  const events = position.events.map((event) => ({ type: event.type, at: event.at, price: num(event.price), details: event.details }));
  const entry = position.trades[0];
  // Positions opened before events were recorded: only the facts stored on the trade (entry / exit).
  if (!events.some((event) => event.type === 'ENTRY') && entry?.entryAt) events.unshift({ type: 'ENTRY', at: entry.entryAt, price: num(entry.entry), details: { decisionSource: positionDecisionSource(entry), recordedFrom: 'TRADE' } as Prisma.JsonValue });
  if (!events.some((event) => event.type === 'EXIT') && entry?.exitAt) events.push({ type: 'EXIT', at: entry.exitAt, price: num(entry.exit), details: { exitReason: entry.exitReason, recordedFrom: 'TRADE' } as Prisma.JsonValue });
  return events.sort((a, b) => a.at.getTime() - b.at.getTime());
}

export async function buildPositionDetail(userId: string, positionId: string) {
  const position = await loadPosition(userId, positionId);
  if (!position) return null;
  const entry = position.trades[0];
  const currentPrice = num(position.currentPrice);
  const quantity = num(position.quantity) ?? 0;
  const invested = num(entry?.size) ?? (num(position.avgEntryPrice) ?? 0) * quantity;
  const open = position.status === 'OPEN';
  const unrealized = open ? num(position.unrealizedPnl) : null;
  const realized = open ? null : num(entry?.netPnl) ?? num(position.realizedPnl);
  const [market, security, decision, series] = await Promise.all([
    marketCard(position), securityCard(position, userId), decisionCard(position),
    priceLiquiditySeries(position.tokenId, position.token.address, new Date(position.openedAt.getTime() - 5_000), new Date((position.closedAt ?? new Date()).getTime() + 5_000)),
  ]);
  // Exit diagnostics from stored data only (trigger vs fill, stops, costs, latency, liquidity, anomalies).
  const exitForensics = buildExitForensics({ position, trade: entry ?? null, events: position.events, pathMetric: position.pathMetric, series });
  return {
    id: position.id,
    status: position.status,
    mode: position.mode,
    token: { address: position.token.address, symbol: position.token.symbol, name: position.token.name },
    decisionSource: positionDecisionSource(entry),
    strategyName: entry?.strategyName ?? null,
    openedAt: position.openedAt,
    closedAt: position.closedAt,
    holdingMs: (position.closedAt ?? new Date()).getTime() - position.openedAt.getTime(),
    exitReason: position.exitReason,
    entryPrice: num(position.avgEntryPrice),
    entryMarketPrice: num(position.entryMarketPrice),
    currentPrice,
    exitPrice: num(entry?.exit),
    quantity,
    invested,
    currentValue: currentPrice !== null ? currentPrice * quantity : null,
    unrealizedPnl: unrealized,
    unrealizedPnlPercent: unrealized !== null && invested > 0 ? unrealized / invested * 100 : null,
    // Open P&L is net of the entry fee; closing now would also cost the exit fee + modelled exit impact.
    estimatedCloseNowPnl: (() => {
      if (!open || unrealized === null || currentPrice === null) return null;
      const impact = estimateExitSlippagePercent(currentPrice, quantity, num(position.pathMetric?.lastLiquidityUsd));
      const proceeds = currentPrice * quantity * (1 - impact / 100);
      return unrealized - (currentPrice * quantity - proceeds) - paperFee(proceeds);
    })(),
    realizedPnl: realized,
    realizedPnlPercent: realized !== null && invested > 0 ? realized / invested * 100 : null,
    grossPnl: num(entry?.pnl),
    fees: num(entry?.fees),
    slippage: num(entry?.slippage),
    maxFavorableExcursionPercent: num(position.highestPrice) && num(position.avgEntryPrice) ? (num(position.highestPrice)! / num(position.avgEntryPrice)! - 1) * 100 : null,
    maxAdverseExcursionPercent: num(position.lowestPrice) && num(position.avgEntryPrice) ? (num(position.lowestPrice)! / num(position.avgEntryPrice)! - 1) * 100 : null,
    exitLevels: describeExitLevels(persistedExitState(position), open ? currentPrice : num(entry?.exitMarketPrice) ?? currentPrice),
    configuration: configurationCard(position),
    exitForensics,
    executionCapacity: executionCapacityCard(position, entry ?? null),
    // NewLaunch positions: the exit policy snapshotted at entry (never rewritten by later settings changes).
    exitPolicy: position.exitPolicy,
    newLaunch: (() => {
      const snapshot = ((entry?.configSnapshot ?? null) as Record<string, unknown> | null)?.newLaunch as Record<string, unknown> | undefined;
      if (!snapshot && position.exitPolicy !== 'NEW_LAUNCH') return null;
      return {
        configVersion: snapshot?.configVersion ?? position.configVersion,
        exitConfig: snapshot?.exitConfig ?? null,
        qualityGate: snapshot?.qualityGate ?? null,
        maxHoldUntil: position.maxHoldUntil,
        liquidityExitPercent: num(position.liquidityExitPercent),
      };
    })(),
    liquidity: (() => {
      const atEntry = num(position.entryLiquidityUsd) ?? num(position.pathMetric?.liquidityAtEntry);
      const current = num(position.pathMetric?.lastLiquidityUsd) ?? market.liquidityUsd;
      return { atEntry, current, changePercent: atEntry && current ? (current / atEntry - 1) * 100 : null, minimum: num(position.pathMetric?.minLiquidityUsd) };
    })(),
    // Real observed price path (analytics only): MFE / MAE / first-reach milestones.
    path: position.pathMetric ? {
      source: position.pathMetric.source,
      maxPriceAfterEntry: num(position.pathMetric.maxPriceAfterEntry),
      minPriceAfterEntry: num(position.pathMetric.minPriceAfterEntry),
      mfePercent: num(position.pathMetric.mfePercent),
      mfeUsd: num(position.pathMetric.mfeUsd),
      timeToMfeMs: position.pathMetric.timeToMfeMs,
      maePercent: num(position.pathMetric.maePercent),
      maeUsd: num(position.pathMetric.maeUsd),
      timeToMaeMs: position.pathMetric.timeToMaeMs,
      milestones: position.pathMetric.milestones,
      sampleCount: position.pathMetric.sampleCount,
    } : null,
    decision,
    market,
    security,
    tradeId: entry?.id ?? null,
    timeline: timeline(position),
    updatedAt: position.updatedAt,
  };
}

export type ChartRange = '1m' | '5m' | '15m' | '30m' | '1h' | 'lifetime';
const RANGE_MS: Record<Exclude<ChartRange, 'lifetime'>, number> = { '1m': 60_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000, '1h': 3_600_000 };

/** Real stored price points (TokenMetric + launch snapshots), deduplicated and downsampled; no synthetic candles. */
export async function priceSeries(tokenId: string, address: string, from: Date, to: Date, maxPoints = 600) {
  const [metrics, candidate] = await Promise.all([
    prisma.tokenMetric.findMany({ where: { tokenId, timestamp: { gte: from, lte: to } }, orderBy: { timestamp: 'asc' }, select: { timestamp: true, priceUsd: true } }),
    prisma.launchCandidate.findUnique({ where: { mint: address }, select: { snapshots: { where: { takenAt: { gte: from, lte: to } }, orderBy: { takenAt: 'asc' }, select: { takenAt: true, priceUsd: true } } } }),
  ]);
  const byTime = new Map<number, number>();
  for (const row of metrics) { const price = num(row.priceUsd); if (price && price > 0) byTime.set(row.timestamp.getTime(), price); }
  for (const row of candidate?.snapshots ?? []) { const price = num(row.priceUsd); if (price && price > 0) byTime.set(row.takenAt.getTime(), price); }
  let points = [...byTime.entries()].sort((a, b) => a[0] - b[0]).map(([t, price]) => ({ t, price }));
  if (points.length > maxPoints) {
    const step = points.length / maxPoints;
    points = Array.from({ length: maxPoints }, (_, index) => points[Math.floor(index * step)]).concat(points.at(-1)!);
  }
  return points;
}

/** Time of the newest stored price sample before `before` (used to point an empty chart window at real data). */
export async function latestPriceSampleAt(tokenId: string, address: string, before: Date): Promise<number | null> {
  const [metric, candidate] = await Promise.all([
    tokenId ? prisma.tokenMetric.findFirst({ where: { tokenId, timestamp: { lte: before }, priceUsd: { gt: 0 } }, orderBy: { timestamp: 'desc' }, select: { timestamp: true } }) : null,
    prisma.launchCandidate.findUnique({ where: { mint: address }, select: { snapshots: { where: { takenAt: { lte: before }, priceUsd: { gt: 0 } }, orderBy: { takenAt: 'desc' }, take: 1, select: { takenAt: true } } } }),
  ]);
  const times = [metric?.timestamp.getTime(), candidate?.snapshots[0]?.takenAt.getTime()].filter((value): value is number => typeof value === 'number');
  return times.length ? Math.max(...times) : null;
}

/** Stored price + liquidity points (TokenMetric and launch snapshots), chronological; nothing interpolated. */
export async function priceLiquiditySeries(tokenId: string, address: string, from: Date, to: Date) {
  const [metrics, candidate] = await Promise.all([
    prisma.tokenMetric.findMany({ where: { tokenId, timestamp: { gte: from, lte: to } }, orderBy: { timestamp: 'asc' }, select: { timestamp: true, priceUsd: true, liquidityUsd: true } }),
    prisma.launchCandidate.findUnique({ where: { mint: address }, select: { snapshots: { where: { takenAt: { gte: from, lte: to } }, orderBy: { takenAt: 'asc' }, select: { takenAt: true, priceUsd: true, liquidityUsd: true } } } }),
  ]);
  const points = [
    ...metrics.map((row) => ({ t: row.timestamp.getTime(), price: num(row.priceUsd) ?? 0, liquidityUsd: num(row.liquidityUsd) })),
    ...(candidate?.snapshots ?? []).map((row) => ({ t: row.takenAt.getTime(), price: num(row.priceUsd) ?? 0, liquidityUsd: num(row.liquidityUsd) })),
  ].filter((point) => point.price > 0);
  return points.sort((a, b) => a.t - b.t);
}

export async function buildPositionChart(userId: string, positionId: string, range: ChartRange) {
  const position = await loadPosition(userId, positionId);
  if (!position) return null;
  const end = position.closedAt ?? new Date();
  const lifetimeFrom = new Date(position.openedAt.getTime() - 60_000);
  const from = range === 'lifetime' ? lifetimeFrom : new Date(end.getTime() - RANGE_MS[range]);
  const allPoints = await priceSeries(position.tokenId, position.token.address, lifetimeFrom, new Date(end.getTime() + 60_000), 2_000);
  const points = allPoints.filter((point) => point.t >= from.getTime());
  // Only offer timeframes the stored history can actually fill (at least 3 real points).
  const availableRanges = (['1m', '5m', '15m', '30m', '1h'] as const).filter((key) => allPoints.filter((point) => point.t >= end.getTime() - RANGE_MS[key]).length >= 3 && allPoints[0].t <= end.getTime() - RANGE_MS[key] * 0.5);
  const events = timeline(position);
  const levels = describeExitLevels(persistedExitState(position), num(position.currentPrice));
  // Trailing trigger history: every recorded activation / upward move of the trigger.
  const trailingSteps = events
    .filter((event) => event.type === 'TRAILING_ACTIVATED' || event.type === 'TRAILING_MOVED')
    .map((event) => ({ t: event.at.getTime(), price: Number((event.details as Record<string, unknown> | null)?.[event.type === 'TRAILING_ACTIVATED' ? 'triggerPrice' : 'to'] ?? 0) }))
    .filter((step) => step.price > 0);
  return {
    range,
    availableRanges: [...availableRanges, 'lifetime'],
    chartType: 'line' as const,
    points,
    from: from.getTime(),
    to: end.getTime(),
    levels: {
      entry: levels.entryPrice,
      // Once break-even is applied the stored stop IS the break-even stop: drawn as breakEvenStop, the base SL separately.
      stopLoss: position.breakEvenAppliedAt ? null : levels.stopLoss?.price ?? null,
      takeProfit: levels.takeProfit?.price ?? null,
      trailingStop: levels.trailing.status === 'ACTIVE' ? levels.trailing.triggerPrice : null,
      breakEvenActivation: levels.breakEven.enabled ? levels.breakEven.activationPrice : null,
      trailingActivation: levels.trailing.enabled ? levels.trailing.activationLevelPrice : null,
      current: position.status === 'OPEN' ? num(position.currentPrice) : null,
      exit: position.status === 'CLOSED' ? num(position.trades[0]?.exit) : null,
      // Base stop from the entry configuration, the raised break-even stop, and the exit trigger vs. actual fill.
      baseStopLoss: (() => {
        const snapshot = (position.trades[0]?.configSnapshot ?? null) as { newLaunch?: { exitConfig?: { stopLossPercent?: number } }; stopLossPercent?: number } | null;
        const percent = num(snapshot?.newLaunch?.exitConfig?.stopLossPercent ?? snapshot?.stopLossPercent);
        const entryFill = num(position.avgEntryPrice);
        return position.breakEvenAppliedAt && percent !== null && entryFill ? entryFill * (1 - percent / 100) : null;
      })(),
      breakEvenStop: position.breakEvenAppliedAt ? num(position.stopLossPrice) : null,
      exitTrigger: position.status === 'CLOSED' ? num(((position.trades[0]?.exitDiagnostics as Record<string, unknown> | null)?.exitTriggerPrice ?? (position.trades[0]?.exitDiagnostics as Record<string, unknown> | null)?.triggerLevel ?? null) as number | null) : null,
      exitObserved: position.status === 'CLOSED' ? num(position.trades[0]?.exitMarketPrice) : null,
    },
    trailingSteps,
    markers: events.map((event) => ({ t: event.at.getTime(), type: event.type, price: event.price, exitReason: (event.details as Record<string, unknown> | null)?.exitReason ?? null })),
  };
}

export async function buildTokenChart(address: string, from: Date, to: Date) {
  const [token, candidate] = await Promise.all([
    prisma.token.findUnique({ where: { address }, select: { id: true } }),
    prisma.launchCandidate.findUnique({ where: { mint: address }, select: { id: true } }),
  ]);
  // Watched launches have no Token row; their price history lives in launch snapshots.
  if (!token && !candidate) return null;
  return { chartType: 'line' as const, points: await priceSeries(token?.id ?? '', address, from, to), from: from.getTime(), to: to.getTime() };
}
