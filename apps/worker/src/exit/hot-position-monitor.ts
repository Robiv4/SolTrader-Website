/**
 * Event-driven NewLaunch position monitor (PAPER).
 *
 *   market event (trade stream / snapshot / fallback poll)
 *     -> ordering + dedup checks
 *     -> in-memory hot position state
 *     -> PositionManager.evaluatePosition (the single authoritative Exit Engine path, no I/O)
 *     -> exit trigger (per-position lock) -> PAPER execution (optional simulated latency) -> idempotent DB close
 *
 * Persistence of protective state is asynchronous and coalesced per position (critical transitions immediately,
 * marks / MFE throttled); the database stays the durable source and is re-read on start / resync, so a restart
 * continues from the persisted highest price, break-even and trailing state. Polling is kept as a fallback when
 * the stream is not healthy or a token has no stream (watchdog). The close is a conditional OPEN -> CLOSED update,
 * so even two workers observing the same trigger can only produce one fill.
 */
import { CAPACITY_RANK, classifyCapacity, DEFAULT_CAPACITY_CONFIG, exitCapacityScore, impactAtSize, RollingPercentiles, type CurveState } from '@soltrader/trading-engine';

import type { NormalizedQuote, PositionEvaluation, PositionManager, PositionRecord } from '../position-manager.js';

import { capacityMetrics } from './entry-capacity.js';
import { DEFAULT_PAPER_LATENCY, samplePaperLatencyMs, type PaperLatencyConfig } from './paper-latency.js';

export interface MarketEvent {
  mint: string;
  price: number;
  liquidityUsd: number | null;
  /** Time the market state refers to (stream: receive time of the trade; snapshot / poll: provider time). */
  marketTimestamp: number;
  /** Provider / on-chain time when known (block time has second precision). */
  sourceTimestamp: number | null;
  receivedAt: number;
  slot: number | null;
  eventId: string | null;
  source: string;
  /** Live pool reserves (bonding curve) for the exit capacity pool model. */
  curve?: CurveState | null;
  /** The bonding curve migrated (the curve sell route no longer exists). */
  migrated?: boolean;
}

export type StreamHealth = 'CONNECTED' | 'DEGRADED' | 'STALE' | 'DISCONNECTED' | 'FALLBACK_POLLING';

export interface StreamStatus {
  state: string;
  lastEventAt: number | null;
}

export interface HotMonitorLogger {
  info(payload: unknown, message?: string): void;
  warn(payload: unknown, message?: string): void;
  error(payload: unknown, message?: string): void;
  debug?(payload: unknown, message?: string): void;
}

export interface HotPositionMonitorDeps {
  manager: Pick<PositionManager, 'evaluatePosition' | 'closeEvaluated'>;
  /** Open NEW_LAUNCH positions with their persisted protective state (database). */
  loadOpenPositions(): Promise<PositionRecord[]>;
  /** Persists non-final state (conditional on OPEN). */
  persist(id: string, updates: Partial<PositionRecord>): Promise<void>;
  publishEvent?(type: string, payload: Record<string, unknown>): Promise<void>;
  afterClose?(userId: string): Promise<void>;
  /** Recomputes the owner's paper account (equity / open P&L) after marks were persisted (throttled per user). */
  refreshAccount?(userId: string): Promise<void>;
  /** Health of the primary market stream. */
  streamStatus(): StreamStatus;
  /** Latest in-memory market state of a token from the stream (no I/O); null when the token has none. */
  latestStreamEvent(mint: string): MarketEvent | null;
  /** Fallback quote (REST / market-data provider); null when unavailable. */
  pollQuote(mint: string): Promise<MarketEvent | null>;
  /** Exits are only evaluated while the bot runs (RUNNING / PAUSED). */
  isActive(): boolean;
  onObserved?(mint: string, event: MarketEvent): void;
  logger: HotMonitorLogger;
  now?(): number;
  sleep?(ms: number): Promise<void>;
  random?(): number;
}

export interface HotPositionMonitorConfig {
  /** Stream with no event for this long is STALE (fallback polling starts). */
  streamStaleMs: number;
  /** A token covered by the stream but silent for this long is also polled (e.g. migrated / unsupported pool). */
  tokenSilenceFallbackMs: number;
  /** Fallback polling interval per token (respects provider limits: one request in flight per token). */
  fallbackPollMs: number;
  watchdogMs: number;
  /** Re-reads open positions (new entries, external closes). */
  resyncMs: number;
  /** Non-critical state (marks, highest price, MFE) is written at most this often per position. */
  persistThrottleMs: number;
  paperLatency: PaperLatencyConfig;
}

export const DEFAULT_HOT_MONITOR_CONFIG: HotPositionMonitorConfig = {
  streamStaleMs: 5_000,
  tokenSilenceFallbackMs: 30_000,
  fallbackPollMs: 2_000,
  watchdogMs: 1_000,
  resyncMs: 2_000,
  persistThrottleMs: 1_000,
  paperLatency: DEFAULT_PAPER_LATENCY,
};

interface HotPosition {
  record: PositionRecord;
  pending: MarketEvent[];
  processing: boolean;
  exiting: boolean;
  lastMarketTimestamp: number | null;
  lastSlot: number | null;
  lastEventKey: string | null;
  lastEvaluatedAt: number;
  lastStreamEventAt: number | null;
  polling: boolean;
  lastPollAt: number;
  fallbackActive: boolean;
  /** A due max hold waiting for a real quote was logged once. */
  maxHoldWaitLogged?: boolean;
  persistPending: Partial<PositionRecord> | null;
  persistTimer: ReturnType<typeof globalThis.setTimeout> | null;
  persisting: Promise<void> | null;
}

/** Keeps exit-relevant extremes when a burst has to be coalesced: chronological high, low and latest. */
export function coalesceEvents(events: MarketEvent[]): { kept: MarketEvent[]; dropped: number } {
  if (events.length <= 3) return { kept: events, dropped: 0 };
  let high = 0;
  let low = 0;
  events.forEach((event, index) => {
    if (event.price > events[high].price) high = index;
    if (event.price < events[low].price) low = index;
  });
  const indexes = [...new Set([high, low, events.length - 1])].sort((a, b) => a - b);
  return { kept: indexes.map((index) => events[index]), dropped: events.length - indexes.length };
}

const MAX_PENDING_PER_POSITION = 256;

export class HotPositionMonitor {
  private readonly config: HotPositionMonitorConfig;
  private readonly positions = new Map<string, HotPosition>();
  private readonly byMint = new Map<string, Set<string>>();
  private readonly lastMintEvent = new Map<string, MarketEvent>();
  /** Short per-token history (chronological by receive time) for choosing the fill-time market state. */
  private readonly mintHistory = new Map<string, MarketEvent[]>();
  private readonly lastMintSlot = new Map<string, number>();
  private watchdogTimer: ReturnType<typeof globalThis.setInterval> | null = null;
  private resyncTimer: ReturnType<typeof globalThis.setInterval> | null = null;
  private resyncing: Promise<void> | null = null;
  private health: StreamHealth = 'DISCONNECTED';
  private readonly metrics = {
    /** Max hold evaluated on the current curve state of a silent token (stream healthy). */
    maxHoldOnSilentCurve: 0,
    /** Max hold due without any current price (migrated / pool token): waiting for a real quote. */
    maxHoldWaitingForQuote: 0,
    eventsReceived: 0,
    evaluations: 0,
    exitsTriggered: 0,
    exitsFilled: 0,
    duplicateExitsPrevented: 0,
    duplicateEventsSkipped: 0,
    outOfOrderEvents: 0,
    coalescedEvents: 0,
    maxQueueDepth: 0,
    pollRequests: 0,
    persistErrors: 0,
    closeErrors: 0,
    lastEventAt: null as number | null,
  };
  private readonly eventTimes: number[] = [];
  private readonly evaluationTimes: number[] = [];
  private readonly evaluationDuration = new RollingPercentiles();
  private readonly receiveToDecision = new RollingPercentiles();
  private readonly triggerToFill = new RollingPercentiles();

  constructor(private readonly deps: HotPositionMonitorDeps, config: Partial<HotPositionMonitorConfig> = {}) {
    this.config = { ...DEFAULT_HOT_MONITOR_CONFIG, ...config };
  }

  private now() {
    return this.deps.now?.() ?? Date.now();
  }

  async start() {
    await this.resync();
    this.watchdogTimer = globalThis.setInterval(() => void this.watchdog(), this.config.watchdogMs);
    this.resyncTimer = globalThis.setInterval(() => void this.resync(), this.config.resyncMs);
  }

  /** Stops timers and flushes pending (coalesced) state so a restart continues from it. */
  async stop() {
    if (this.watchdogTimer) globalThis.clearInterval(this.watchdogTimer);
    if (this.resyncTimer) globalThis.clearInterval(this.resyncTimer);
    this.watchdogTimer = null;
    this.resyncTimer = null;
    await Promise.all([...this.positions.values()].map((position) => this.flush(position, true)));
  }

  /** Loads open positions; keeps the newer (in-memory) protective state and merges monotonic values. */
  resync(): Promise<void> {
    if (this.resyncing) return this.resyncing;
    this.resyncing = (async () => {
      try {
        const rows = await this.deps.loadOpenPositions();
        const seen = new Set<string>();
        for (const row of rows) {
          seen.add(row.id);
          const existing = this.positions.get(row.id);
          if (!existing) {
            this.add(row);
            continue;
          }
          // Another writer (e.g. a second worker) may have moved protective state further: never loosen it.
          const record = existing.record;
          record.highestPrice = Math.max(record.highestPrice ?? 0, row.highestPrice ?? 0) || record.highestPrice;
          if (row.trailingTriggerPrice && (!record.trailingTriggerPrice || row.trailingTriggerPrice > record.trailingTriggerPrice)) record.trailingTriggerPrice = row.trailingTriggerPrice;
          if (row.trailingActive && !record.trailingActive) Object.assign(record, { trailingActive: true, trailingActivatedAt: row.trailingActivatedAt, trailingActivationPrice: row.trailingActivationPrice });
          if (row.breakEvenAppliedAt && !record.breakEvenAppliedAt) record.breakEvenAppliedAt = row.breakEvenAppliedAt;
          if (row.stopLoss && (!record.stopLoss || row.stopLoss > record.stopLoss)) record.stopLoss = row.stopLoss;
        }
        for (const [id, position] of this.positions) if (!seen.has(id) && !position.exiting) this.remove(id);
      } catch (error) {
        this.deps.logger.warn({ err: error instanceof Error ? error.message : String(error) }, 'Hot position resync failed (state kept)');
      } finally {
        this.resyncing = null;
      }
    })();
    return this.resyncing;
  }

  private add(record: PositionRecord) {
    this.positions.set(record.id, {
      record: { ...record }, pending: [], processing: false, exiting: false, lastMarketTimestamp: null, lastSlot: null, lastEventKey: null,
      lastEvaluatedAt: 0, lastStreamEventAt: null, polling: false, lastPollAt: 0, fallbackActive: false, persistPending: null, persistTimer: null, persisting: null,
    });
    const set = this.byMint.get(record.token) ?? new Set<string>();
    set.add(record.id);
    this.byMint.set(record.token, set);
    // No immediate evaluation: a bonding-curve price only changes on a trade, so the next stream event (or the
    // watchdog's fallback poll for silent / unstreamed tokens) evaluates it with genuinely current data.
  }

  private remove(id: string) {
    const position = this.positions.get(id);
    if (!position) return;
    if (position.persistTimer) globalThis.clearTimeout(position.persistTimer);
    this.positions.delete(id);
    const set = this.byMint.get(position.record.token);
    set?.delete(id);
    if (set && set.size === 0) {
      this.byMint.delete(position.record.token);
      this.mintHistory.delete(position.record.token);
      this.lastMintEvent.delete(position.record.token);
      this.lastMintSlot.delete(position.record.token);
    }
  }

  /** Entry point of every market event (stream, snapshot or fallback poll). Synchronous decision path. */
  onMarketEvent(event: MarketEvent) {
    if (!(event.price > 0)) return;
    this.metrics.eventsReceived += 1;
    this.metrics.lastEventAt = event.receivedAt;
    this.eventTimes.push(event.receivedAt);
    // Only tokens with an open hot position are tracked here (the stream carries every launch).
    const ids = this.byMint.get(event.mint);
    if (!ids) return;
    // Out-of-order protection per token: an older slot never replaces newer market state.
    const lastSlot = this.lastMintSlot.get(event.mint);
    if (event.slot !== null && lastSlot !== undefined && event.slot < lastSlot) {
      this.metrics.outOfOrderEvents += 1;
      this.deps.logger.debug?.({ mint: event.mint, slot: event.slot, lastSlot }, 'OUT_OF_ORDER_MARKET_EVENT');
      return;
    }
    if (event.slot !== null) this.lastMintSlot.set(event.mint, event.slot);
    const previous = this.lastMintEvent.get(event.mint);
    if (!previous || event.marketTimestamp >= previous.marketTimestamp) this.lastMintEvent.set(event.mint, event);
    const history = this.mintHistory.get(event.mint) ?? [];
    history.push(event);
    if (history.length > 64) history.shift();
    this.mintHistory.set(event.mint, history);
    if (!this.deps.isActive()) return;
    for (const id of ids) {
      const position = this.positions.get(id);
      if (!position || position.exiting) continue;
      if (event.source !== 'POLL' && event.source !== 'WATCHDOG') position.lastStreamEventAt = event.receivedAt;
      this.enqueue(position, event);
    }
  }

  private enqueue(position: HotPosition, event: MarketEvent) {
    position.pending.push(event);
    if (position.pending.length > MAX_PENDING_PER_POSITION) {
      const { kept, dropped } = coalesceEvents(position.pending);
      position.pending = kept;
      this.metrics.coalescedEvents += dropped;
    }
    this.metrics.maxQueueDepth = Math.max(this.metrics.maxQueueDepth, position.pending.length);
    if (!position.processing) this.process(position);
  }

  /** Processes queued events in order; synchronous unless an exit is being executed. */
  private process(position: HotPosition) {
    position.processing = true;
    try {
      while (position.pending.length && !position.exiting) {
        const batch = position.pending.splice(0);
        const { kept, dropped } = coalesceEvents(batch);
        this.metrics.coalescedEvents += dropped;
        for (const event of kept) {
          if (this.evaluate(position, event)) break;
        }
      }
    } finally {
      position.processing = false;
    }
  }

  /** Returns true when the event triggered an exit. */
  private evaluate(position: HotPosition, event: MarketEvent): boolean {
    if (position.lastMarketTimestamp !== null && event.marketTimestamp < position.lastMarketTimestamp) {
      this.metrics.outOfOrderEvents += 1;
      return false;
    }
    if (position.lastSlot !== null && event.slot !== null && event.slot < position.lastSlot) {
      this.metrics.outOfOrderEvents += 1;
      return false;
    }
    const key = `${event.price}:${event.marketTimestamp}:${event.liquidityUsd ?? ''}`;
    const timeDue = position.record.maxHoldUntil && this.now() >= new Date(position.record.maxHoldUntil).getTime();
    if (key === position.lastEventKey && !timeDue) {
      this.metrics.duplicateEventsSkipped += 1;
      return false;
    }
    position.lastEventKey = key;
    position.lastMarketTimestamp = event.marketTimestamp;
    if (event.slot !== null) position.lastSlot = event.slot;

    const quote: NormalizedQuote = { price: event.price, liquidityUsd: event.liquidityUsd, timestamp: event.marketTimestamp, sourceTimestamp: event.sourceTimestamp, receivedAt: event.receivedAt, slot: event.slot, eventId: event.eventId, source: event.source };
    const evaluation = this.deps.manager.evaluatePosition(position.record, quote, new Date(this.now()));
    this.metrics.evaluations += 1;
    this.evaluationTimes.push(this.now());
    this.evaluationDuration.add(evaluation.evaluationDurationMs);
    if (event.source !== 'POLL' && event.source !== 'WATCHDOG') this.receiveToDecision.add(Math.max(0, evaluation.evaluationCompletedAt - event.receivedAt));
    position.lastEvaluatedAt = this.now();
    this.deps.onObserved?.(event.mint, event);

    // Exit capacity of the CURRENT position value (diagnostic; evaluated after the exit decision, never delaying it).
    const capacity = this.trackCapacity(position, event);
    if (capacity.events.length) evaluation.updated.positionEvents = [...(evaluation.updated.positionEvents ?? []), ...capacity.events];
    const { positionEvents, ...state } = evaluation.updated;
    if (evaluation.exitReason) {
      evaluation.exitContext = { ...evaluation.exitContext, exitCapacityAtTrigger: capacity.atTrigger };
      void this.trigger(position, evaluation);
      return true;
    }
    const before = position.record;
    const critical = Boolean(positionEvents?.length) || state.stopLoss !== before.stopLoss || state.trailingTriggerPrice !== before.trailingTriggerPrice
      || state.trailingActive !== before.trailingActive || Boolean(state.breakEvenAppliedAt) !== Boolean(before.breakEvenAppliedAt);
    Object.assign(position.record, state);
    this.schedulePersist(position, { ...state, positionEvents }, critical);
    return false;
  }

  /**
   * Current full-exit capacity of the position (pool model on live curve reserves, else liquidity estimate). Records
   * class deteriorations (GOOD -> MODERATE -> POOR -> UNSAFE) and loss / change of the sell route. Diagnostic only:
   * the existing Liquidity Safety exit stays the only liquidity-based exit rule.
   */
  private trackCapacity(position: HotPosition, event: MarketEvent) {
    const record = position.record;
    const config = record.capacity?.config ?? DEFAULT_CAPACITY_CONFIG;
    const market = { priceUsd: event.price, liquidityUsd: event.liquidityUsd, curve: event.curve ?? null };
    const point = impactAtSize(market, record.quantity * event.price);
    const routeLost = Boolean(event.migrated) && !event.curve && !event.liquidityUsd;
    const score = routeLost ? 0 : exitCapacityScore(point, point.basis, config);
    const current = routeLost ? 'UNSAFE' : classifyCapacity(score);
    const routeStatus = routeLost ? 'NO_SELL_ROUTE' : event.curve ? 'BONDING_CURVE' : event.migrated ? 'MIGRATED_POOL' : event.liquidityUsd ? 'POOL' : 'UNKNOWN';
    const events: NonNullable<PositionRecord['positionEvents']> = [];
    const state = record.capacity ?? { config: null, classAtEntry: null, current: null, routeStatus: null };
    if (state.current && current !== 'UNKNOWN' && CAPACITY_RANK[current] < CAPACITY_RANK[state.current]) {
      events.push({ type: 'EXIT_CAPACITY_DETERIORATED', price: event.price, details: { from: state.current, to: current, classAtEntry: state.classAtEntry, sellImpactPct: point.sellImpactPct, liquidityUsd: event.liquidityUsd, basis: point.basis, positionValueUsd: record.quantity * event.price } });
      capacityMetrics.deteriorations += 1;
    }
    if (state.routeStatus !== routeStatus && (routeStatus === 'NO_SELL_ROUTE' || (state.routeStatus === 'BONDING_CURVE' && routeStatus === 'MIGRATED_POOL'))) {
      events.push({ type: routeStatus === 'NO_SELL_ROUTE' ? 'SELL_ROUTE_LOST' : 'SELL_ROUTE_CHANGED', price: event.price, details: { from: state.routeStatus, to: routeStatus, liquidityUsd: event.liquidityUsd } });
      if (routeStatus === 'NO_SELL_ROUTE') {
        capacityMetrics.routeLosses += 1;
        this.deps.logger.warn({ positionId: record.id, mint: record.token }, 'Sell route lost (curve migrated, no pool data)');
      }
    }
    record.capacity = { ...state, current: current === 'UNKNOWN' ? state.current : current, routeStatus };
    return { events, atTrigger: { classification: current, exitCapacityScore: score, estimatedExitImpactPct: point.sellImpactPct, basis: point.basis, routeStatus, liquidityUsd: event.liquidityUsd, positionValueUsd: record.quantity * event.price } };
  }

  /** Exit trigger: per-position lock, immediate execution request, analytics afterwards. */
  private async trigger(position: HotPosition, evaluation: PositionEvaluation) {
    if (position.exiting) {
      this.metrics.duplicateExitsPrevented += 1;
      this.deps.logger.info({ positionId: position.record.id }, 'Duplicate exit prevented');
      return;
    }
    position.exiting = true;
    this.metrics.exitsTriggered += 1;
    const requestedAt = this.now();
    if (position.persistTimer) globalThis.clearTimeout(position.persistTimer);
    position.persistTimer = null;
    // Lifecycle events not yet written go with the close (same transaction).
    const carried = position.persistPending?.positionEvents ?? [];
    position.persistPending = null;
    const updated = { ...evaluation.updated, positionEvents: [...carried, ...(evaluation.updated.positionEvents ?? [])] };
    const latencyMs = samplePaperLatencyMs(this.config.paperLatency, this.deps.random);
    try {
      if (latencyMs > 0) await (this.deps.sleep ?? ((ms: number) => new Promise((resolve) => globalThis.setTimeout(resolve, ms))))(latencyMs);
      const startedAt = this.now();
      // Fill reference: the newest market state RECEIVED by the simulated execution time (no lookahead).
      const history = this.mintHistory.get(position.record.token) ?? [];
      const fillEvent = [...history].reverse().find((event) => event.receivedAt <= startedAt && event.marketTimestamp >= (evaluation.quote.timestamp ?? 0)) ?? null;
      const fillQuote: NormalizedQuote = fillEvent
        ? { price: fillEvent.price, liquidityUsd: fillEvent.liquidityUsd, timestamp: fillEvent.marketTimestamp, sourceTimestamp: fillEvent.sourceTimestamp, receivedAt: fillEvent.receivedAt, slot: fillEvent.slot, eventId: fillEvent.eventId, source: fillEvent.source }
        : evaluation.quote;
      this.deps.logger.info({ positionId: position.record.id, mint: position.record.token, exitReason: evaluation.exitReason, triggerLevel: evaluation.triggerLevel, marketPrice: evaluation.quote.price, simulatedLatencyMs: latencyMs }, 'Exit triggered');
      await this.deps.manager.closeEvaluated(position.record, { ...evaluation, updated }, fillQuote, { requestedAt, startedAt, simulatedLatencyMs: latencyMs, latencyMode: this.config.paperLatency.mode });
      this.metrics.exitsFilled += 1;
      this.triggerToFill.add(this.now() - evaluation.evaluationCompletedAt);
      this.deps.logger.info({ positionId: position.record.id, exitReason: evaluation.exitReason, fillReference: fillQuote.price, triggerToFillMs: this.now() - evaluation.evaluationCompletedAt }, 'Exit filled');
      this.remove(position.record.id);
      // Notifications / account refresh never delay the fill.
      void (async () => {
        for (const event of evaluation.closeEvents) await this.deps.publishEvent?.(event.type, event.payload).catch(() => undefined);
        await this.deps.afterClose?.(position.record.userId).catch(() => undefined);
      })();
    } catch (error) {
      // Protection continues: the lock is released and the next event re-evaluates (the DB close is idempotent).
      this.metrics.closeErrors += 1;
      position.exiting = false;
      this.deps.logger.error({ err: error instanceof Error ? error.message : String(error), positionId: position.record.id }, 'Exit execution failed; will retry on the next market event');
    }
  }

  private schedulePersist(position: HotPosition, updates: Partial<PositionRecord>, critical: boolean) {
    const pending = position.persistPending ?? {};
    position.persistPending = { ...pending, ...updates, userId: position.record.userId, positionEvents: [...(pending.positionEvents ?? []), ...(updates.positionEvents ?? [])] };
    if (critical) {
      void this.flush(position);
      return;
    }
    if (!position.persistTimer) position.persistTimer = globalThis.setTimeout(() => void this.flush(position), this.config.persistThrottleMs);
  }

  /** Writes the coalesced state; one write in flight per position, failures are retried (never block decisions). */
  private async flush(position: HotPosition, final = false): Promise<void> {
    if (position.persistTimer) globalThis.clearTimeout(position.persistTimer);
    position.persistTimer = null;
    while (position.persisting) await position.persisting;
    const payload = position.persistPending;
    if (!payload || position.exiting) return;
    position.persistPending = null;
    position.persisting = this.deps.persist(position.record.id, payload)
      .then(() => this.afterMarkPersisted(position, payload))
      .catch((error: unknown) => {
        this.metrics.persistErrors += 1;
        const later = position.persistPending ?? {};
        position.persistPending = { ...payload, ...later, positionEvents: [...(payload.positionEvents ?? []), ...(later.positionEvents ?? [])] };
        this.deps.logger.warn({ err: error instanceof Error ? error.message : String(error), positionId: position.record.id }, 'Hot state persistence failed; retrying');
        if (!position.persistTimer && !final) position.persistTimer = globalThis.setTimeout(() => void this.flush(position), this.config.persistThrottleMs);
      })
      .finally(() => {
        position.persisting = null;
      });
    await position.persisting;
  }

  private readonly accountRefreshAt = new Map<string, number>();

  /**
   * After a mark is stored: live position / P&L events for the UI and a throttled account recomputation, so the
   * dashboard / account open P&L follows the event-driven marks (never on the decision path).
   */
  private afterMarkPersisted(position: HotPosition, payload: Partial<PositionRecord>) {
    const record = position.record;
    if (payload.currentPrice != null) {
      const update = { userId: record.userId, id: record.id, token: record.token, currentPrice: payload.currentPrice, unrealizedPnl: payload.unrealizedPnl ?? null, highestPrice: record.highestPrice ?? null, lowestPrice: record.lowestPrice ?? null, stopLoss: record.stopLoss ?? null, takeProfit: record.takeProfit ?? null, trailingActive: record.trailingActive ?? false, trailingTriggerPrice: record.trailingTriggerPrice ?? null, status: 'OPEN' };
      void this.deps.publishEvent?.('position_update', update).catch(() => undefined);
      void this.deps.publishEvent?.('pnl_update', { userId: record.userId, id: record.id, token: record.token, unrealizedPnl: payload.unrealizedPnl ?? null, realizedPnl: 0 }).catch(() => undefined);
    }
    const now = this.now();
    if (this.deps.refreshAccount && now - (this.accountRefreshAt.get(record.userId) ?? 0) >= 5_000) {
      this.accountRefreshAt.set(record.userId, now);
      void this.deps.refreshAccount(record.userId).catch(() => undefined);
    }
  }

  /** Stream health, per-token fallback polling and time-based re-evaluation (max hold). */
  async watchdog() {
    const now = this.now();
    const status = this.deps.streamStatus();
    const age = status.lastEventAt !== null ? now - status.lastEventAt : null;
    let next: StreamHealth = status.state === 'ACTIVE' ? (age !== null && age <= this.config.streamStaleMs ? 'CONNECTED' : 'STALE') : status.state === 'DEGRADED' ? 'DEGRADED' : 'DISCONNECTED';
    const pollingNeeded: HotPosition[] = [];
    for (const position of this.positions.values()) {
      if (position.exiting) continue;
      const mint = position.record.token;
      const streamed = this.deps.latestStreamEvent(mint);
      const silentFor = position.lastStreamEventAt !== null ? now - position.lastStreamEventAt : Number.POSITIVE_INFINITY;
      const covered = next === 'CONNECTED' && streamed !== null && silentFor <= this.config.tokenSilenceFallbackMs;
      if (!covered) {
        const maxHoldDue = Boolean(position.record.maxHoldUntil) && now >= new Date(position.record.maxHoldUntil!).getTime();
        // A silent bonding-curve token: with the stream itself healthy, no event means no trade, so the last streamed
        // curve state IS the current price (the price only moves on trades). A due max hold is evaluated on it instead of
        // waiting for a market-data poll that a fresh launch usually cannot answer (positions stuck past their max hold).
        if (maxHoldDue && next === 'CONNECTED' && streamed !== null && streamed.curve && !streamed.migrated && this.deps.isActive()) {
          this.metrics.maxHoldOnSilentCurve += 1;
          this.enqueue(position, { ...streamed, marketTimestamp: now, source: 'WATCHDOG' });
          continue;
        }
        if (maxHoldDue && !position.maxHoldWaitLogged) {
          // Never an invented exit price: a migrated / pool token without a fresh quote waits for the next real quote.
          position.maxHoldWaitLogged = true;
          this.metrics.maxHoldWaitingForQuote += 1;
          this.deps.logger.warn({ positionId: position.record.id, mint, streamHealth: next, silentForMs: Number.isFinite(silentFor) ? silentFor : null }, 'Max hold due but no current price: waiting for a real quote');
        }
        pollingNeeded.push(position);
        continue;
      }
      position.fallbackActive = false;
      // Time-based exits need an evaluation even when nothing trades: the curve state is current while the stream is live.
      if (position.record.maxHoldUntil && now >= new Date(position.record.maxHoldUntil).getTime() && this.deps.isActive()) {
        this.enqueue(position, { ...streamed, marketTimestamp: now, source: 'WATCHDOG' });
      }
    }
    if (pollingNeeded.length && next !== 'CONNECTED') next = 'FALLBACK_POLLING';
    if (next !== this.health) {
      const level = next === 'CONNECTED' ? 'info' : 'warn';
      this.deps.logger[level]({ from: this.health, to: next, lastEventAgeMs: age }, next === 'FALLBACK_POLLING' ? 'Exit monitor: fallback polling activated' : 'Exit monitor stream health changed');
      this.health = next;
    }
    if (!this.deps.isActive()) return;
    await Promise.all(pollingNeeded.map((position) => this.poll(position, now)));
  }

  private async poll(position: HotPosition, now: number) {
    if (position.polling || now - position.lastPollAt < this.config.fallbackPollMs) return;
    position.polling = true;
    position.lastPollAt = now;
    position.fallbackActive = true;
    this.metrics.pollRequests += 1;
    try {
      const event = await this.deps.pollQuote(position.record.token);
      if (event) this.onMarketEvent({ ...event, source: 'POLL' });
    } catch (error) {
      this.deps.logger.warn({ err: error instanceof Error ? error.message : String(error), mint: position.record.token }, 'Fallback poll failed');
    } finally {
      position.polling = false;
    }
  }

  private perSecond(times: number[], windowMs = 10_000) {
    const cutoff = this.now() - windowMs;
    while (times.length && times[0] < cutoff) times.shift();
    return times.length / (windowMs / 1000);
  }

  /** Diagnostics for the System page. */
  snapshot() {
    const mints = [...this.byMint.keys()];
    return {
      at: new Date(this.now()).toISOString(),
      health: this.health,
      activeSubscriptions: mints.length,
      openHotPositions: this.positions.size,
      fallbackPollingPositions: [...this.positions.values()].filter((position) => position.fallbackActive).length,
      eventsPerSecond: this.perSecond(this.eventTimes),
      evaluationsPerSecond: this.perSecond(this.evaluationTimes),
      lastEventAgeMs: this.metrics.lastEventAt !== null ? this.now() - this.metrics.lastEventAt : null,
      queueDepth: [...this.positions.values()].reduce((total, position) => total + position.pending.length, 0),
      ...this.metrics,
      evaluationDurationMs: this.evaluationDuration.summary(),
      receiveToDecisionMs: this.receiveToDecision.summary(),
      triggerToFillMs: this.triggerToFill.summary(),
      paperLatencyMode: this.config.paperLatency.mode,
    };
  }

  /** Test / diagnostics helper. */
  hotState(id: string) {
    return this.positions.get(id)?.record ?? null;
  }
}
