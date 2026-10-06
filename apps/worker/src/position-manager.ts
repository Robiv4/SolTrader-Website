import type { RealtimeEventType } from '@soltrader/shared';
import { advancePathMetric, estimateExitSlippagePercent, evaluateLongExit, initPathMetric, PAPER_FEE_BPS, type CapacityClass, type CapacityConfig, type LongExitState, type PathMetricState } from '@soltrader/trading-engine';

export type PositionSide = 'BUY' | 'SELL';

export interface PositionRecord {
  id: string;
  userId: string;
  token: string;
  symbol: string;
  side: PositionSide;
  quantity: number;
  avgEntryPrice: number;
  currentPrice: number;
  stopLoss?: number | null;
  takeProfit?: number | null;
  trailingStop?: number | null;
  highestPrice?: number | null;
  lowestPrice?: number | null;
  unrealizedPnl?: number | null;
  realizedPnl?: number | null;
  status: 'OPEN' | 'CLOSED';
  exitReason?: string | null;
  strategy?: string | null;
  signalId?: string | null;
  openedAt?: Date | string | null;
  closedAt?: Date | string | null;
  updatedAt?: Date | string | null;
  /** Owner's configured stop-loss distance in percent, used when the position has no explicit stop price. */
  stopLossPercent?: number | null;
  /** Owner's configured take-profit distance in percent, used when the position has no explicit target price. */
  takeProfitPercent?: number | null;
  /** Trailing activation gain as a fraction (0.15 = +15%); null = armed from entry (legacy positions). */
  trailingActivation?: number | null;
  trailingActive?: boolean;
  trailingActivatedAt?: Date | string | null;
  trailingActivationPrice?: number | null;
  trailingTriggerPrice?: number | null;
  /** Break-even activation gain as a fraction; null = disabled. */
  breakEvenActivation?: number | null;
  breakEvenAppliedAt?: Date | string | null;
  /** Modelled exit slippage for the close (percent); set by the manager when it closes. */
  exitSlippagePercent?: number | null;
  /** "Why did this close" facts for the trade record. */
  exitDiagnostics?: Record<string, unknown>;
  /** Pool liquidity at entry. */
  entryLiquidityUsd?: number | null;
  /** Owner setting: close when liquidity fell this many percent below the entry liquidity (null = off). */
  liquidityOutflowExitPercent?: number | null;
  /** Lifecycle events produced by this evaluation (persisted by the store for the timeline/chart). */
  positionEvents?: Array<{ type: string; price: number; details?: Record<string, unknown> }>;
  /** Exit policy snapshotted at entry ('NEW_LAUNCH' = NewLaunch exit settings). */
  exitPolicy?: string | null;
  /** Optional time-based exit (snapshotted at entry). */
  maxHoldUntil?: Date | string | null;
  /** Real price-path metrics (MFE / MAE / milestones) so far; advanced on every observed price. */
  pathMetric?: PathMetricState | null;
  /** Break-even cost buffer snapshotted at entry (fraction above the entry fill); null = the two PAPER fees. */
  breakEvenCostBuffer?: number | null;
  /** First touches of exit levels observed so far (in memory; also persisted as *_TOUCHED position events). */
  exitTouches?: ExitTouches;
  /** Entry fee already paid (USDC); subtracted from the open P&L. */
  entryFee?: number | null;
  /** Exit capacity tracking after entry (diagnostic): thresholds and class snapshotted at entry, current class. */
  capacity?: { config: CapacityConfig | null; classAtEntry: CapacityClass | null; current: CapacityClass | null; routeStatus: string | null } | null;
}

/** First touch of an exit level (TP touched is not TP filled). */
export type ExitTouches = Partial<Record<'TAKE_PROFIT' | 'STOP_LOSS' | 'BREAK_EVEN_STOP' | 'TRAILING_STOP', { at: string; price: number; level: number; marketDataAt: string | null; slot: number | null }>>;

/** Documented, deterministic exit priority (see docs/EXIT_ENGINE.md). */
export const EXIT_PRECEDENCE = 'EFFECTIVE_STOP(TRAILING|BREAK_EVEN|STOP_LOSS)>TAKE_PROFIT>LIQUIDITY_SAFETY>MAX_HOLD_TIME';

/** A market observation with its provenance (for latency / ordering diagnostics). */
export interface NormalizedQuote {
  price: number;
  liquidityUsd: number | null;
  /** Time the market state refers to (provider / trade time). */
  timestamp: number | null;
  /** Provider event time (e.g. on-chain block time) when known. */
  sourceTimestamp: number | null;
  /** When this process received the event. */
  receivedAt: number | null;
  slot: number | null;
  eventId: string | null;
  source: string | null;
}

export function normalizeQuote(raw: MarketQuote | undefined, toNumber: (value: unknown) => number = (value) => Number(value) || 0): NormalizedQuote {
  const time = (value: Date | number | null | undefined) => (value === null || value === undefined ? null : new Date(value).getTime());
  if (raw !== null && raw !== undefined && typeof raw === 'object') {
    return { price: toNumber(raw.price), liquidityUsd: raw.liquidityUsd ?? null, timestamp: time(raw.timestamp), sourceTimestamp: time(raw.sourceTimestamp), receivedAt: time(raw.receivedAt), slot: raw.slot ?? null, eventId: raw.eventId ?? null, source: raw.source ?? null };
  }
  return { price: toNumber(raw), liquidityUsd: null, timestamp: null, sourceTimestamp: null, receivedAt: null, slot: null, eventId: null, source: null };
}

export interface PositionEvaluation {
  updated: Partial<PositionRecord>;
  exitReason: string | null;
  triggerLevel: number | null;
  exitContext: Record<string, unknown>;
  pnl: number;
  liquidityUsd: number | null;
  evaluationStartedAt: number;
  evaluationCompletedAt: number;
  /** High-resolution (monotonic) duration of the evaluation. */
  evaluationDurationMs: number;
  markEvents: Array<{ type: RealtimeEventType; payload: Record<string, unknown> }>;
  closeEvents: Array<{ type: RealtimeEventType; payload: Record<string, unknown> }>;
  quote: NormalizedQuote;
}

/** Liquidity drop (vs entry) that is recorded once as a timeline warning. */
const LIQUIDITY_WARNING_PERCENT = 25;

/** Market snapshot entry: a bare price, or a price with the pool liquidity (exit slippage) and its timestamp. */
export type MarketQuote = number | string | {
  price: number;
  liquidityUsd?: number | null;
  timestamp?: Date | number | null;
  sourceTimestamp?: Date | number | null;
  receivedAt?: Date | number | null;
  slot?: number | null;
  eventId?: string | null;
  source?: string | null;
};

export interface ReconcileOptions {
  /** Only these positions are evaluated (e.g. the fast NewLaunch exit loop). */
  positionFilter?: (position: PositionRecord) => boolean;
  /** Skip the per-owner exposure / daily-loss risk events (fast loop: they are produced by the main monitor). */
  skipRiskChecks?: boolean;
}

/** Quotes older than this are flagged EXIT_DATA_STALE in the exit diagnostics (never silently treated as fresh). */
export const DEFAULT_EXIT_MARKET_DATA_MAX_AGE_MS = 15_000;

export interface PositionManagerConfig {
  exitMarketDataMaxAgeMs?: number;
  accountEquityUsd?: number;
  maxExposurePercent?: number;
  dailyLossLimitPercent?: number;
  defaultTrailingStopPercent?: number;
  defaultStopLossPercent?: number;
  defaultTakeProfitPercent?: number;
}

export interface PositionManagerStore {
  getOpenPositions(filter?: { exitPolicy?: string }): Promise<PositionRecord[]>;
  updatePosition(id: string, updates: Partial<PositionRecord>): Promise<void>;
  closePosition(id: string, updates: Partial<PositionRecord>): Promise<void>;
  publishEvent(type: RealtimeEventType, payload: Record<string, unknown>): Promise<void>;
  /** Current equity of the position owner; falls back to `accountEquityUsd` when not provided. */
  getAccountEquity?(userId: string): Promise<number | null>;
  /** Called once per owner after a reconcile so account equity reflects the new marks. */
  refreshAccount?(userId: string): Promise<void>;
}

export class PositionManager {
  private readonly config: Required<PositionManagerConfig>;
  private readonly liquidityWarned = new Set<string>();
  private readonly staleFlagged = new Set<string>();
  /**
   * Serialises evaluations: the main monitor and the fast NewLaunch exit loop share this instance, and two
   * evaluations of the same position must never interleave (lost updates of highest price / trailing state).
   * The close itself is additionally idempotent in the database (conditional OPEN -> CLOSED).
   */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly store: PositionManagerStore, config: PositionManagerConfig = {}) {
    this.config = {
      exitMarketDataMaxAgeMs: config.exitMarketDataMaxAgeMs ?? DEFAULT_EXIT_MARKET_DATA_MAX_AGE_MS,
      accountEquityUsd: config.accountEquityUsd ?? 1_000,
      maxExposurePercent: config.maxExposurePercent ?? 25,
      dailyLossLimitPercent: config.dailyLossLimitPercent ?? 5,
      // No trailing unless the position (i.e. the owner's settings at entry) asks for it.
      defaultTrailingStopPercent: config.defaultTrailingStopPercent ?? 0,
      defaultStopLossPercent: config.defaultStopLossPercent ?? 2,
      defaultTakeProfitPercent: config.defaultTakeProfitPercent ?? 4,
    };
  }

  private toNumber(value: unknown) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
    return 0;
  }

  private isBuy(position: PositionRecord) {
    return position.side === 'BUY';
  }

  private getValue(position: PositionRecord) {
    return position.quantity * position.currentPrice;
  }

  private getExposure(positions: PositionRecord[]) {
    return positions.reduce((total, position) => total + this.getValue(position), 0);
  }

  private getKey(position: PositionRecord) {
    return position.token.toUpperCase();
  }

  private quote(marketSnapshot: Record<string, MarketQuote>, position: PositionRecord): NormalizedQuote {
    const raw = marketSnapshot[this.getKey(position)] ?? marketSnapshot[position.token];
    return normalizeQuote(raw, (value) => this.toNumber(value));
  }

  /** Evaluations are queued so they never overlap (see `queue`). */
  reconcileMarket(marketSnapshot: Record<string, MarketQuote>, at = new Date(), options: ReconcileOptions = {}): Promise<PositionRecord[]> {
    const run = this.queue.then(() => this.reconcileUnsafe(marketSnapshot, at, options));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async reconcileUnsafe(marketSnapshot: Record<string, MarketQuote>, at: Date, options: ReconcileOptions) {
    const loaded = await this.store.getOpenPositions();
    const positions = options.positionFilter ? loaded.filter(options.positionFilter) : loaded;
    if (positions.length === 0) return [];

    const events: Array<{ type: RealtimeEventType; payload: Record<string, unknown> }> = [];
    const closed: PositionRecord[] = [];
    const now = new Date(at);

    // Risk limits are evaluated per owner against that owner's own equity, never across all users.
    const positionsByUser = new Map<string, PositionRecord[]>();
    for (const position of positions) {
      const group = positionsByUser.get(position.userId) ?? [];
      group.push(position);
      positionsByUser.set(position.userId, group);
    }
    for (const [userId, userPositions] of options.skipRiskChecks ? [] : positionsByUser) {
      const storedEquity = this.store.getAccountEquity ? await this.store.getAccountEquity(userId) : null;
      const equity = storedEquity !== null && storedEquity > 0 ? storedEquity : this.config.accountEquityUsd;
      const totalExposure = this.getExposure(userPositions);
      const exposurePercent = totalExposure / equity * 100;
      if (totalExposure > 0 && exposurePercent > this.config.maxExposurePercent) {
        events.push({ type: 'risk_update', payload: { userId, code: 'MAX_EXPOSURE', totalExposure, exposurePercent, limitPercent: this.config.maxExposurePercent, positions: userPositions.map((position) => ({ id: position.id, token: position.token, value: this.getValue(position) })) } });
      }
      const openLoss = userPositions.reduce((loss, position) => loss + Math.max(0, -this.getUnrealizedPnl(position)), 0);
      const dailyLossPercent = openLoss / equity * 100;
      if (openLoss > 0 && dailyLossPercent > this.config.dailyLossLimitPercent) {
        events.push({ type: 'risk_update', payload: { userId, code: 'DAILY_LOSS_LIMIT', dailyLoss: openLoss, dailyLossPercent, limitPercent: this.config.dailyLossLimitPercent } });
      }
    }

    for (const position of positions) {
      const quote = this.quote(marketSnapshot, position);
      // Without a fresh market price no exit decision is made: acting on a stale mark could trigger
      // (or miss) a stop at a price that no longer exists.
      if (!(quote.price > 0)) continue;
      const evaluation = this.evaluatePosition(position, quote, now);
      if (evaluation.exitReason) {
        await this.closeEvaluated(position, evaluation, quote, { requestedAt: Date.now() });
        events.push(...evaluation.closeEvents);
        closed.push({ ...position, ...evaluation.updated, exitReason: evaluation.exitReason, status: 'CLOSED', realizedPnl: evaluation.pnl, closedAt: now });
        continue;
      }
      await this.store.updatePosition(position.id, evaluation.updated);
      events.push(...evaluation.markEvents);
    }

    if (this.store.refreshAccount) {
      for (const userId of positionsByUser.keys()) await this.store.refreshAccount(userId);
    }
    for (const event of events) {
      await this.store.publishEvent(event.type, event.payload);
    }
    return closed;
  }

  /**
   * The authoritative per-position exit evaluation (no I/O): runs the Exit Engine on one observed price and
   * returns the new protective state, lifecycle events, first touches of exit levels and the exit decision.
   * Used by the periodic reconcile AND the event-driven hot monitor, so the formulas exist exactly once.
   */
  evaluatePosition(position: PositionRecord, quote: NormalizedQuote, now: Date): PositionEvaluation {
    const evaluationStartedAt = Date.now();
    const evaluationStartedHr = globalThis.performance.now();
    const currentPrice = quote.price;
    const liquidityUsd = quote.liquidityUsd;
    const quoteAt = quote.timestamp;
    const updated: Partial<PositionRecord> = { userId: position.userId, currentPrice, updatedAt: now };

    // Missing stop/target levels are derived from the ENTRY fill price (not the moving current price),
    // otherwise they would trail the market and never trigger.
    const entry = position.avgEntryPrice;
    const stopLossPercent = (position.stopLossPercent ?? this.config.defaultStopLossPercent) / 100;
    const takeProfitPercent = (position.takeProfitPercent ?? this.config.defaultTakeProfitPercent) / 100;
    const trailingDistance = position.trailingStop ?? (this.config.defaultTrailingStopPercent > 0 ? this.config.defaultTrailingStopPercent / 100 : null);

    let exitReason: string | null = null;
    let triggerLevel: number | null = null;
    let exitContext: Record<string, unknown> = {};
    const touches: ExitTouches = { ...(position.exitTouches ?? {}) };
    const eventMeta = { marketPrice: currentPrice, marketDataAt: quoteAt !== null ? new Date(quoteAt).toISOString() : null, receivedAt: quote.receivedAt !== null ? new Date(quote.receivedAt).toISOString() : null, slot: quote.slot, eventId: quote.eventId, source: quote.source };
    if (this.isBuy(position)) {
      const previous: LongExitState = {
        entryPrice: entry,
        stopLossPrice: position.stopLoss ?? entry * (1 - stopLossPercent),
        takeProfitPrice: position.takeProfit ?? entry * (1 + takeProfitPercent),
        trailingDistance,
        trailingActivation: position.trailingActivation ?? null,
        breakEvenActivation: position.breakEvenActivation ?? null,
        // Break-even stop = entry FILL * (1 + buffer); default buffer = the two PAPER fees (2 x 0.30%).
        roundTripCostFraction: position.breakEvenCostBuffer ?? 2 * PAPER_FEE_BPS / 10_000,
        highestPrice: position.highestPrice ?? currentPrice,
        lowestPrice: position.lowestPrice ?? currentPrice,
        trailingActive: position.trailingActive ?? false,
        trailingActivatedAt: position.trailingActivatedAt ? new Date(position.trailingActivatedAt) : null,
        trailingActivationPrice: position.trailingActivationPrice ?? null,
        trailingTriggerPrice: position.trailingTriggerPrice ?? null,
        breakEvenAppliedAt: position.breakEvenAppliedAt ? new Date(position.breakEvenAppliedAt) : null,
      };
      const evaluation = evaluateLongExit(previous, currentPrice, now);
      const state = evaluation.state;
      // Real lifecycle events of this evaluation (the Exit Engine is the only source of these facts).
      const positionEvents: NonNullable<PositionRecord['positionEvents']> = [];
      if (evaluation.breakEvenAppliedNow) positionEvents.push({ type: 'BREAK_EVEN_APPLIED', price: currentPrice, details: { stopLossPrice: state.stopLossPrice } });
      if (evaluation.trailingArmedNow) positionEvents.push({ type: 'TRAILING_ACTIVATED', price: currentPrice, details: { activationPrice: state.trailingActivationPrice, triggerPrice: state.trailingTriggerPrice, highestPrice: state.highestPrice } });
      else if (previous.trailingTriggerPrice && state.trailingTriggerPrice && state.trailingTriggerPrice >= previous.trailingTriggerPrice * 1.01) {
        positionEvents.push({ type: 'TRAILING_MOVED', price: currentPrice, details: { from: previous.trailingTriggerPrice, to: state.trailingTriggerPrice, highestPrice: state.highestPrice } });
      }
      // First touch of an exit level (immutable audit facts; touching is not the same as being filled).
      if (state.takeProfitPrice && currentPrice >= state.takeProfitPrice && !touches.TAKE_PROFIT) {
        touches.TAKE_PROFIT = { at: now.toISOString(), price: currentPrice, level: state.takeProfitPrice, marketDataAt: eventMeta.marketDataAt, slot: quote.slot };
        positionEvents.push({ type: 'TAKE_PROFIT_TOUCHED', price: currentPrice, details: { level: state.takeProfitPrice, ...eventMeta } });
      }
      if (evaluation.effectiveStopPrice !== null && currentPrice <= evaluation.effectiveStopPrice && evaluation.stopSource) {
        const touchKey = evaluation.stopSource === 'TRAILING' ? 'TRAILING_STOP' : evaluation.stopSource === 'BREAK_EVEN' ? 'BREAK_EVEN_STOP' : 'STOP_LOSS';
        if (!touches[touchKey]) {
          touches[touchKey] = { at: now.toISOString(), price: currentPrice, level: evaluation.effectiveStopPrice, marketDataAt: eventMeta.marketDataAt, slot: quote.slot };
          positionEvents.push({ type: `${touchKey}_TOUCHED`, price: currentPrice, details: { level: evaluation.effectiveStopPrice, ...eventMeta } });
        }
      }
      const quoteAgeMs = quoteAt !== null ? Math.max(0, now.getTime() - quoteAt) : null;
      const stale = quoteAgeMs !== null && quoteAgeMs > this.config.exitMarketDataMaxAgeMs;
      if (stale && !this.staleFlagged.has(position.id)) {
        this.staleFlagged.add(position.id);
        positionEvents.push({ type: 'MARKET_DATA_STALE', price: currentPrice, details: { quoteAgeMs, maxAgeMs: this.config.exitMarketDataMaxAgeMs } });
      } else if (!stale) this.staleFlagged.delete(position.id);
      exitContext = {
        effectiveStopBefore: previous.trailingActive && previous.trailingTriggerPrice ? Math.max(previous.stopLossPrice ?? 0, previous.trailingTriggerPrice) : previous.stopLossPrice,
        effectiveStopPrice: evaluation.effectiveStopPrice,
        protectiveLevelAtTrigger: evaluation.effectiveStopPrice,
        stopSource: evaluation.stopSource,
        conditionsTriggered: evaluation.conditions,
        marketDataAt: eventMeta.marketDataAt,
        marketDataAgeMs: quoteAgeMs,
        exitDataStale: stale,
        marketEventReceivedAt: eventMeta.receivedAt,
        marketEventSlot: quote.slot,
        marketEventId: quote.eventId,
        marketEventSource: quote.source,
        breakEvenStopPrice: state.breakEvenAppliedAt ? entry * (1 + (position.breakEvenCostBuffer ?? 2 * PAPER_FEE_BPS / 10_000)) : null,
        breakEvenCostBufferPercent: (position.breakEvenCostBuffer ?? 2 * PAPER_FEE_BPS / 10_000) * 100,
      };
      if (liquidityUsd && position.entryLiquidityUsd && liquidityUsd <= position.entryLiquidityUsd * (1 - LIQUIDITY_WARNING_PERCENT / 100) && !this.liquidityWarned.has(position.id)) {
        this.liquidityWarned.add(position.id);
        positionEvents.push({ type: 'LIQUIDITY_WARNING', price: currentPrice, details: { liquidityUsd, entryLiquidityUsd: position.entryLiquidityUsd } });
      }
      updated.positionEvents = positionEvents;
      Object.assign(updated, {
        highestPrice: state.highestPrice,
        lowestPrice: state.lowestPrice,
        stopLoss: state.stopLossPrice,
        takeProfit: state.takeProfitPrice,
        trailingStop: trailingDistance,
        trailingActive: state.trailingActive,
        trailingActivatedAt: state.trailingActivatedAt,
        trailingActivationPrice: state.trailingActivationPrice,
        trailingTriggerPrice: state.trailingTriggerPrice,
        breakEvenAppliedAt: state.breakEvenAppliedAt,
        exitTouches: touches,
      });
      exitReason = evaluation.exitReason;
      triggerLevel = evaluation.triggerLevel;
      // Analytics only (never an entry input): real observed path, from the entry fill onward.
      const openedAt = position.openedAt ? new Date(position.openedAt).getTime() : now.getTime();
      const metricBase = position.pathMetric ?? initPathMetric(entry, openedAt, position.quantity, position.entryLiquidityUsd ?? null);
      updated.pathMetric = advancePathMetric(metricBase, currentPrice, now.getTime(), liquidityUsd);
      // Optional safety exit, evaluated after SL/TP/trailing: the pool's liquidity collapsed since entry.
      const outflowPercent = position.liquidityOutflowExitPercent;
      if (!exitReason && outflowPercent && outflowPercent > 0 && liquidityUsd && position.entryLiquidityUsd && position.entryLiquidityUsd > 0) {
        const floor = position.entryLiquidityUsd * (1 - outflowPercent / 100);
        if (liquidityUsd <= floor) {
          // Same safety mechanism; NewLaunch positions record it as LIQUIDITY_SAFETY.
          exitReason = position.exitPolicy === 'NEW_LAUNCH' ? 'LIQUIDITY_SAFETY' : 'LIQUIDITY_OUTFLOW';
          triggerLevel = floor;
        }
      }
      // Liquidity collapse that coincides with a price stop is recorded (the price stop keeps precedence).
      if (outflowPercent && outflowPercent > 0 && liquidityUsd && position.entryLiquidityUsd && liquidityUsd <= position.entryLiquidityUsd * (1 - outflowPercent / 100)) {
        (exitContext.conditionsTriggered as string[] | undefined)?.push('LIQUIDITY_SAFETY');
      }
      // Optional time-based exit, evaluated last (snapshotted per position at entry).
      if (!exitReason && position.maxHoldUntil && now.getTime() >= new Date(position.maxHoldUntil).getTime()) {
        exitReason = 'MAX_HOLD_TIME';
        triggerLevel = null;
      }
    } else {
      const highestPrice = Math.max(position.highestPrice ?? currentPrice, currentPrice);
      const lowestPrice = Math.min(position.lowestPrice ?? currentPrice, currentPrice);
      const stopLoss = position.stopLoss ?? entry * (1 + stopLossPercent);
      const takeProfit = position.takeProfit ?? entry * (1 - takeProfitPercent);
      Object.assign(updated, { highestPrice, lowestPrice, stopLoss, takeProfit, trailingStop: trailingDistance });
      const trailingThreshold = trailingDistance ? lowestPrice * (1 + trailingDistance) : Number.POSITIVE_INFINITY;
      if (currentPrice >= stopLoss) exitReason = 'STOP_LOSS';
      else if (currentPrice <= takeProfit) exitReason = 'TAKE_PROFIT';
      else if (currentPrice >= trailingThreshold) exitReason = 'TRAILING_STOP';
    }

    const pnl = this.getUnrealizedPnl({ ...position, currentPrice });
    updated.unrealizedPnl = pnl;
    updated.realizedPnl = position.realizedPnl ?? 0;
    const evaluationCompletedAt = Date.now();
    const evaluationDurationMs = globalThis.performance.now() - evaluationStartedHr;

    const markEvents: PositionEvaluation['markEvents'] = [
      { type: 'position_update', payload: { userId: position.userId, id: position.id, token: position.token, currentPrice, unrealizedPnl: pnl, highestPrice: updated.highestPrice, lowestPrice: updated.lowestPrice, stopLoss: updated.stopLoss, takeProfit: updated.takeProfit, trailingStop: updated.trailingStop, trailingActive: updated.trailingActive ?? false, trailingTriggerPrice: updated.trailingTriggerPrice ?? null, status: 'OPEN' } },
      { type: 'pnl_update', payload: { userId: position.userId, id: position.id, token: position.token, unrealizedPnl: pnl, realizedPnl: position.realizedPnl ?? 0 } },
    ];
    const closePayload = { userId: position.userId, id: position.id, token: position.token, symbol: position.symbol, side: position.side, exitReason, closedAt: now, realizedPnl: pnl, currentPrice, status: 'CLOSED' as const };
    const closeEvents: PositionEvaluation['closeEvents'] = exitReason ? [
      { type: 'position_update', payload: closePayload },
      { type: 'trade_update', payload: closePayload },
      { type: 'pnl_update', payload: { userId: position.userId, id: position.id, token: position.token, realizedPnl: pnl, unrealizedPnl: 0, closedAt: now } },
    ] : [];
    return { updated, exitReason, triggerLevel, exitContext, pnl, liquidityUsd, evaluationStartedAt, evaluationCompletedAt, evaluationDurationMs, markEvents, closeEvents, quote };
  }

  /**
   * Books an exit decided by `evaluatePosition`. Trigger and fill are recorded separately: the stop triggers at
   * `exitTriggerPrice` (the level); `marketPriceAtTrigger` is the observed price that triggered it; the PAPER sell
   * fills from `fillQuote` (the market at the simulated execution time, never a later price) minus the modelled
   * exit impact, applied exactly once in closePaperPosition. The close itself is idempotent (OPEN -> CLOSED).
   */
  async closeEvaluated(position: PositionRecord, evaluation: PositionEvaluation, fillQuote: NormalizedQuote, timing: { requestedAt: number; startedAt?: number; simulatedLatencyMs?: number; latencyMode?: string }) {
    const triggeredAt = new Date(evaluation.updated.updatedAt ?? Date.now());
    const triggerLevel = evaluation.triggerLevel;
    const marketPriceAtTrigger = evaluation.quote.price;
    const fillReference = fillQuote.price > 0 ? fillQuote.price : marketPriceAtTrigger;
    const fillLiquidity = fillQuote.price > 0 ? fillQuote.liquidityUsd : evaluation.liquidityUsd;
    // Size-vs-liquidity impact of THIS sell, applied once (in closePaperPosition).
    const exitSlippagePercent = estimateExitSlippagePercent(fillReference, position.quantity, fillLiquidity);
    const touches = (evaluation.updated.exitTouches ?? {}) as ExitTouches;
    const tpTouch = touches.TAKE_PROFIT ?? null;
    const startedAt = timing.startedAt ?? timing.requestedAt;
    const exitDiagnostics = {
      triggerLevel,
      exitTriggerPrice: triggerLevel,
      exitTriggerAt: triggeredAt.toISOString(),
      marketPriceAtTrigger,
      // The market price the simulated sell executes against (at the execution time; without latency simulation it IS the trigger observation).
      requestedExitPrice: fillReference,
      requestedExitPriceObservedAt: fillQuote.receivedAt !== null ? new Date(fillQuote.receivedAt).toISOString() : null,
      observedPrice: marketPriceAtTrigger,
      exitPriceImpactPercent: exitSlippagePercent,
      liquidityUsd: evaluation.liquidityUsd,
      liquidityAtTrigger: evaluation.liquidityUsd,
      liquidityAtFill: fillLiquidity,
      entryLiquidityUsd: position.entryLiquidityUsd ?? null,
      liquidityChangePercent: evaluation.liquidityUsd && position.entryLiquidityUsd ? (evaluation.liquidityUsd / position.entryLiquidityUsd - 1) * 100 : null,
      evaluationStartedAt: new Date(evaluation.evaluationStartedAt).toISOString(),
      evaluationLatencyMs: evaluation.evaluationCompletedAt - evaluation.evaluationStartedAt,
      exitEvaluationDurationMs: evaluation.evaluationDurationMs,
      triggerGapPercent: triggerLevel ? (marketPriceAtTrigger / triggerLevel - 1) * 100 : null,
      precedence: EXIT_PRECEDENCE,
      exitTouches: touches,
      takeProfitFirstTouchedAt: tpTouch?.at ?? null,
      takeProfitFirstTouchPrice: tpTouch?.price ?? null,
      takeProfitTriggeredAt: evaluation.exitReason === 'TAKE_PROFIT' ? triggeredAt.toISOString() : null,
      takeProfitTriggerPrice: evaluation.exitReason === 'TAKE_PROFIT' ? triggerLevel : null,
      takeProfitExitRequestedAt: evaluation.exitReason === 'TAKE_PROFIT' ? new Date(timing.requestedAt).toISOString() : null,
      paperExecutionLatencyMode: timing.latencyMode ?? 'NONE',
      paperExecutionSimulatedLatencyMs: timing.simulatedLatencyMs ?? 0,
      latencyTimestamps: {
        marketEventSourceTimestamp: evaluation.quote.sourceTimestamp !== null ? new Date(evaluation.quote.sourceTimestamp).toISOString() : null,
        marketEventReceivedAt: evaluation.quote.receivedAt !== null ? new Date(evaluation.quote.receivedAt).toISOString() : null,
        exitEvaluationStartedAt: new Date(evaluation.evaluationStartedAt).toISOString(),
        exitEvaluationCompletedAt: new Date(evaluation.evaluationCompletedAt).toISOString(),
        exitTriggeredAt: new Date(evaluation.evaluationCompletedAt).toISOString(),
        exitExecutionRequestedAt: new Date(timing.requestedAt).toISOString(),
        exitExecutionStartedAt: new Date(startedAt).toISOString(),
      },
      ...evaluation.exitContext,
    };
    await this.store.closePosition(position.id, { ...evaluation.updated, userId: position.userId, realizedPnl: evaluation.pnl, currentPrice: fillReference, exitReason: evaluation.exitReason, exitSlippagePercent, exitDiagnostics, status: 'CLOSED', closedAt: new Date(startedAt), updatedAt: triggeredAt });
  }

  async closeAll(reason: string, marketSnapshot: Record<string, MarketQuote> = {}, at = new Date()) {
    const positions = await this.store.getOpenPositions();
    const closed: PositionRecord[] = [];
    for (const position of positions) {
      const snapshotPrice = this.quote(marketSnapshot, position).price;
      const currentPrice = snapshotPrice > 0 ? snapshotPrice : position.currentPrice;
      const realizedPnl = this.getUnrealizedPnl({ ...position, currentPrice });
      const payload = { userId: position.userId, id: position.id, token: position.token, symbol: position.symbol, side: position.side, exitReason: reason, closedAt: at, realizedPnl, currentPrice, status: 'CLOSED' as const };
      await this.store.closePosition(position.id, { userId: position.userId, currentPrice, unrealizedPnl: 0, realizedPnl, exitReason: reason, status: 'CLOSED', closedAt: at, updatedAt: at });
      await this.store.publishEvent('position_update', payload);
      await this.store.publishEvent('trade_update', payload);
      await this.store.publishEvent('pnl_update', { userId: position.userId, id: position.id, token: position.token, realizedPnl, unrealizedPnl: 0, closedAt: at });
      closed.push({ ...position, currentPrice, unrealizedPnl: 0, realizedPnl, exitReason: reason, status: 'CLOSED', closedAt: at, updatedAt: at });
    }
    return closed;
  }

  /**
   * Open P&L = mark-to-market change since the entry FILL minus the entry fee already paid. This keeps
   * equity - initial balance == realized + unrealized (cash already reflects the fee). Exit costs (exit fee and
   * exit impact) are not incurred yet; the API shows them separately as "if closed now".
   */
  private getUnrealizedPnl(position: PositionRecord) {
    const price = Number.isFinite(position.currentPrice) ? position.currentPrice : position.avgEntryPrice;
    const delta = price - position.avgEntryPrice;
    const gross = this.isBuy(position) ? delta * position.quantity : -delta * position.quantity;
    return gross - (position.entryFee ?? 0);
  }
}
