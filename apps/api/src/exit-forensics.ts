/**
 * Exit forensics: reconstructs, from STORED data only, why and how a position exited.
 *
 * Authoritative entry basis for every exit calculation (worker, Exit Engine, paper execution, analytics,
 * frontend): `positionEntryPrice` = Position.avgEntryPrice = the simulated entry FILL (market price plus the
 * modelled entry impact). Stop loss, take profit, break-even and trailing levels are all derived from it.
 *
 * Nothing is interpolated: price-path facts come from the live-tracked path metric and the stored price points
 * (TokenMetric / LaunchSnapshot). Missing evidence is reported as null / INSUFFICIENT_DATA, never guessed.
 */
import { computeExitLatency, PAPER_FEE_BPS, priceDeteriorationPercent, type ExitLatencyComponents, type ExitLatencyTimestamps } from '@soltrader/trading-engine';

type Json = Record<string, unknown>;
const record = (value: unknown): Json => (value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {});
const num = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'object' && value !== null && 'toNumber' in value ? (value as { toNumber(): number }).toNumber() : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : typeof value === 'string' ? value : null);

/** Documented anomaly thresholds (diagnostics only; they never block trading). */
export const EXIT_ANOMALY_THRESHOLDS = {
  /** BREAK_EVEN exit whose NET return is below this (percent) is BREAK_EVEN_LARGE_NEGATIVE_EXIT. */
  breakEvenLargeNegativeReturnPercent: -3,
  /** Observed exit price this far (percent) beyond the trigger level is a LARGE_TRIGGER_FILL_GAP. */
  largeTriggerGapPercent: 5,
  /** Gap between the last observation before the exit and the exit observation above this is HIGH_EXIT_LATENCY. */
  highEvaluationGapMs: 10_000,
  /** Trigger -> paper fill above this is HIGH_EXIT_LATENCY. */
  highExecutionLatencyMs: 2_000,
  /** Liquidity change since entry at or below this (percent) at the exit is LIQUIDITY_COLLAPSE_EXIT. */
  liquidityCollapsePercent: -50,
  /** Tolerance (percentage points) when checking realised gross return against MFE / MAE. */
  pathConsistencyTolerancePp: 1,
  /** Market event -> exit decision above this is SLOW_DETECTION. */
  slowDetectionMs: 1_000,
  /** Trigger -> paper fill above this is SLOW_EXECUTION. */
  slowExecutionMs: 2_000,
  /** Modelled exit price impact above this (percent) is HIGH_PRICE_IMPACT. */
  highPriceImpactPercent: 2,
  /** Market move between the trigger observation and the fill reference worse than this (percent) is HIGH_SLIPPAGE. */
  highSlippagePercent: -3,
  /** A TAKE_PROFIT fill this far below the TP level (percent) means the touch was not captured. */
  tpCaptureTolerancePercent: 3,
};

export type ExitQuality = 'GOOD_EXIT' | 'NORMAL_MARKET_GIVEBACK' | 'SLOW_DETECTION' | 'SLOW_EXECUTION' | 'HIGH_SLIPPAGE' | 'HIGH_PRICE_IMPACT' | 'LIQUIDITY_COLLAPSE' | 'STALE_MARKET_DATA' | 'MISSED_TP_TOUCH' | 'EXIT_ENGINE_ANOMALY' | 'INSUFFICIENT_DATA';


export type StopSource = 'BASE_STOP_LOSS' | 'BREAK_EVEN' | 'TRAILING';
export type PrimaryCause = 'ENTRY_QUALITY' | 'EXIT_POLICY' | 'EXECUTION_QUALITY' | 'LIQUIDITY_COLLAPSE' | 'IMPLEMENTATION_ANOMALY' | 'MARKET_MOVE' | 'INSUFFICIENT_DATA';

export interface ForensicsInput {
  position: {
    id: string; openedAt: Date; closedAt: Date | null; avgEntryPrice: unknown; entryMarketPrice: unknown; quantity: unknown; stopLossPrice: unknown; takeProfitPrice: unknown;
    trailingStopPercent: unknown; trailingActivationPercent: unknown; trailingActive: boolean; trailingActivatedAt: Date | null; trailingActivationPrice: unknown; trailingTriggerPrice: unknown;
    breakEvenActivationPercent: unknown; breakEvenAppliedAt: Date | null; breakEvenCostBuffer?: unknown; highestPrice: unknown; lowestPrice: unknown; entryLiquidityUsd: unknown; exitReason: string | null; configVersion?: string | null;
  };
  trade: { entry: unknown; exit: unknown; exitMarketPrice: unknown; size: unknown; fees: unknown; slippage: unknown; exitSlippage: unknown; pnl: unknown; netPnl: unknown; exitReason: string | null; exitDiagnostics: unknown; configSnapshot: unknown; entryAt: Date | null; exitAt: Date | null } | null;
  events: Array<{ type: string; at: Date; price: unknown; details: unknown }>;
  pathMetric: { mfePercent: unknown; maePercent: unknown; timeToMfeMs: number | null; timeToMaeMs: number | null; milestones: unknown; sampleCount: number; maxPriceAfterEntry: unknown; minPriceAfterEntry: unknown; source: string } | null;
  /** Stored price points between entry and exit (+ liquidity where stored). */
  series: Array<{ t: number; price: number; liquidityUsd?: number | null }>;
}

/** Effective stop source of an exit: recorded by the engine, or derived from the stored position state (legacy exits). */
export function effectiveStopSource(input: ForensicsInput): StopSource | null {
  const diagnostics = record(input.trade?.exitDiagnostics);
  // Only stop exits have a stop source; a TAKE_PROFIT / LIQUIDITY_SAFETY / MAX_HOLD exit also records the current
  // protective stop in its diagnostics, which must not turn it into a stop exit.
  const reason = input.trade?.exitReason ?? input.position.exitReason;
  if (reason !== 'STOP_LOSS' && reason !== 'BREAK_EVEN_STOP' && reason !== 'TRAILING_STOP') return null;
  if (diagnostics.stopSource === 'TRAILING' || diagnostics.stopSource === 'BREAK_EVEN' || diagnostics.stopSource === 'BASE_STOP_LOSS') return diagnostics.stopSource;
  const stop = num(input.position.stopLossPrice);
  const trailing = input.position.trailingActive ? num(input.position.trailingTriggerPrice) : null;
  if (trailing !== null && (stop === null || trailing > stop)) return 'TRAILING';
  return input.position.breakEvenAppliedAt ? 'BREAK_EVEN' : 'BASE_STOP_LOSS';
}

export function buildExitForensics(input: ForensicsInput) {
  const p = input.position;
  const t = input.trade;
  const diagnostics = record(t?.exitDiagnostics);
  const snapshot = record(t?.configSnapshot);
  const launch = record(snapshot.launch);
  const exitConfig = record(record(snapshot.newLaunch).exitConfig);
  const entry = num(p.avgEntryPrice);
  const quantity = num(p.quantity) ?? 0;
  const size = num(t?.size);
  const pct = (price: number | null) => (price !== null && entry ? (price / entry - 1) * 100 : null);
  const entryAt = p.openedAt.getTime();
  const exitAt = (t?.exitAt ?? p.closedAt)?.getTime() ?? null;

  // Break-even buffer: snapshotted on the position (fraction), else recorded at the exit (percent), else the two PAPER fees.
  const bufferFromDiagnostics = num(diagnostics.breakEvenCostBufferPercent);
  const buffer = num(p.breakEvenCostBuffer) ?? (bufferFromDiagnostics !== null ? bufferFromDiagnostics / 100 : 2 * PAPER_FEE_BPS / 10_000);
  const breakEvenActivation = num(p.breakEvenActivationPercent);
  const trailingDistance = num(p.trailingStopPercent);
  const trailingActivation = num(p.trailingActivationPercent);
  const baseStopPercent = num(exitConfig.stopLossPercent) ?? num(snapshot.stopLossPercent);
  const baseStopPrice = entry && baseStopPercent !== null ? entry * (1 - baseStopPercent / 100) : null;
  const expectedBreakEvenStop = entry && breakEvenActivation ? entry * (1 + buffer) : null;
  const highest = num(p.highestPrice);
  const expectedTrailingStop = p.trailingActive && highest && trailingDistance ? highest * (1 - trailingDistance) : null;
  const actualTrailingStop = p.trailingActive ? num(p.trailingTriggerPrice) : null;
  const stopSource = effectiveStopSource(input);
  const effectiveStop = Math.max(num(p.stopLossPrice) ?? 0, actualTrailingStop ?? 0) || null;

  const triggerPrice = num(diagnostics.exitTriggerPrice) ?? num(diagnostics.triggerLevel);
  const requestedExitPrice = num(diagnostics.requestedExitPrice) ?? num(t?.exitMarketPrice);
  const fillPrice = num(t?.exit);
  const triggerGapPercent = triggerPrice && requestedExitPrice ? (requestedExitPrice / triggerPrice - 1) * 100 : null;
  const exitSlippagePercent = requestedExitPrice && fillPrice ? (1 - fillPrice / requestedExitPrice) * 100 : null;

  // Costs: fees are charged once on entry and once on exit; slippage is embedded in the two fill prices.
  const totalFees = num(t?.fees);
  const entryFee = size !== null ? size * PAPER_FEE_BPS / 10_000 : null;
  const exitFee = totalFees !== null && entryFee !== null ? totalFees - entryFee : null;
  const exitSlippageUsd = num(t?.exitSlippage);
  const totalSlippage = num(t?.slippage);
  const entrySlippageUsd = totalSlippage !== null && exitSlippageUsd !== null ? totalSlippage - exitSlippageUsd : null;
  const grossReturnPercent = entry && fillPrice ? (fillPrice / entry - 1) * 100 : null;
  const netPnl = num(t?.netPnl);
  const netReturnPercent = netPnl !== null && size ? netPnl / size * 100 : null;
  const mfe = num(input.pathMetric?.mfePercent);
  const mae = num(input.pathMetric?.maePercent);

  // Observation cadence before the exit: the gap between the last stored price before the exit and the exit itself.
  const before = exitAt !== null ? input.series.filter((point) => point.t < exitAt - 500).sort((a, b) => a.t - b.t) : [];
  const lastBefore = before.at(-1) ?? null;
  const evaluationGapMs = lastBefore && exitAt !== null ? exitAt - lastBefore.t : null;
  const mfeAt = input.pathMetric?.timeToMfeMs !== null && input.pathMetric?.timeToMfeMs !== undefined ? entryAt + input.pathMetric.timeToMfeMs : null;
  const nearest = (at: number | null) => (at === null ? null : input.series.filter((point) => point.liquidityUsd !== null && point.liquidityUsd !== undefined).sort((a, b) => Math.abs(a.t - at) - Math.abs(b.t - at))[0] ?? null);
  const liquidityAtMfe = nearest(mfeAt);
  const liquidityAtEntry = num(p.entryLiquidityUsd);
  const liquidityAtTrigger = num(diagnostics.liquidityAtTrigger) ?? num(diagnostics.liquidityUsd);
  const liquidityChangePercent = liquidityAtEntry && liquidityAtTrigger ? (liquidityAtTrigger / liquidityAtEntry - 1) * 100 : null;

  const anomalies: string[] = [];
  const recordedReason = t?.exitReason ?? p.exitReason;
  const effectiveReason = stopSource === 'TRAILING' ? 'TRAILING_STOP' : stopSource === 'BREAK_EVEN' ? 'BREAK_EVEN_STOP' : stopSource === 'BASE_STOP_LOSS' ? 'STOP_LOSS' : recordedReason;
  if (stopSource === 'BREAK_EVEN' && netReturnPercent !== null && netReturnPercent < EXIT_ANOMALY_THRESHOLDS.breakEvenLargeNegativeReturnPercent) anomalies.push('BREAK_EVEN_LARGE_NEGATIVE_EXIT');
  if (stopSource === 'TRAILING' && requestedExitPrice && actualTrailingStop && requestedExitPrice < actualTrailingStop * (1 - EXIT_ANOMALY_THRESHOLDS.largeTriggerGapPercent / 100)) anomalies.push('TRAILING_EXIT_BELOW_EXPECTED');
  if (triggerGapPercent !== null && Math.abs(triggerGapPercent) > EXIT_ANOMALY_THRESHOLDS.largeTriggerGapPercent && recordedReason !== 'TAKE_PROFIT') anomalies.push('LARGE_TRIGGER_FILL_GAP');
  if (diagnostics.exitDataStale === true) anomalies.push('EXIT_DATA_STALE');
  const executionLatencyMs = num(diagnostics.exitExecutionLatencyMs);
  if ((evaluationGapMs !== null && evaluationGapMs > EXIT_ANOMALY_THRESHOLDS.highEvaluationGapMs) || (executionLatencyMs !== null && executionLatencyMs > EXIT_ANOMALY_THRESHOLDS.highExecutionLatencyMs)) anomalies.push('HIGH_EXIT_LATENCY');
  if (liquidityChangePercent !== null && liquidityChangePercent <= EXIT_ANOMALY_THRESHOLDS.liquidityCollapsePercent) anomalies.push('LIQUIDITY_COLLAPSE_EXIT');
  if (recordedReason && effectiveReason && recordedReason !== effectiveReason) anomalies.push('MISLABELED_EXIT_REASON');
  // Path consistency: realised gross return (fill basis) must lie within the observed MAE..MFE band (+ tolerance).
  const tol = EXIT_ANOMALY_THRESHOLDS.pathConsistencyTolerancePp;
  if (grossReturnPercent !== null && mfe !== null && grossReturnPercent > mfe + tol) anomalies.push('MFE_BELOW_REALIZED_RETURN');
  if (grossReturnPercent !== null && mae !== null && exitSlippagePercent !== null && grossReturnPercent < mae - exitSlippagePercent - tol) anomalies.push('MAE_ABOVE_REALIZED_RETURN');

  const samples = input.pathMetric?.sampleCount ?? input.series.length;
  let primaryCause: PrimaryCause;
  if (anomalies.includes('MFE_BELOW_REALIZED_RETURN') || anomalies.includes('MAE_ABOVE_REALIZED_RETURN')) primaryCause = 'IMPLEMENTATION_ANOMALY';
  else if (samples < 3 && mfe === null) primaryCause = 'INSUFFICIENT_DATA';
  else if (anomalies.includes('LIQUIDITY_COLLAPSE_EXIT')) primaryCause = 'LIQUIDITY_COLLAPSE';
  else if (anomalies.includes('LARGE_TRIGGER_FILL_GAP') && anomalies.includes('HIGH_EXIT_LATENCY')) primaryCause = 'EXECUTION_QUALITY';
  else if (mfe !== null && mfe < 3 && (netPnl ?? 0) <= 0) primaryCause = 'ENTRY_QUALITY';
  else if (mfe !== null && mfe >= 10 && (netPnl ?? 0) <= 0) primaryCause = 'EXIT_POLICY';
  else primaryCause = 'MARKET_MOVE';

  // Chronological lifecycle from stored timestamps only.
  const milestones = Object.entries(record(input.pathMetric?.milestones)).map(([key, after]) => ({ type: `MILESTONE_${key}`, at: new Date(entryAt + Number(after)).toISOString(), price: null as number | null, details: { level: key } }));
  const events = input.events.map((event) => ({ type: event.type, at: event.at.toISOString(), price: num(event.price), details: record(event.details) }));
  const exitEvents = diagnostics.exitTriggerAt ? [
    { type: 'EXIT_TRIGGERED', at: String(diagnostics.exitTriggerAt), price: triggerPrice, details: { reason: effectiveReason, observedPrice: requestedExitPrice, conditions: diagnostics.conditionsTriggered ?? null } },
    ...(diagnostics.paperSellRequestedAt ? [{ type: 'PAPER_SELL_REQUESTED', at: String(diagnostics.paperSellRequestedAt), price: requestedExitPrice, details: {} }] : []),
  ] : [];
  const lifecycle = [...events, ...milestones, ...exitEvents].sort((a, b) => a.at.localeCompare(b.at));

  // ---- Exit speed: measured timestamps (exits closed by the instrumented engine; older exits stay null) ----
  const stamps = record(diagnostics.latencyTimestamps) as ExitLatencyTimestamps;
  const hasLatency = Object.keys(stamps).length > 0;
  const latency: ExitLatencyComponents | null = hasLatency ? computeExitLatency(stamps, num(diagnostics.exitEvaluationDurationMs)) : null;
  const touches = record(diagnostics.exitTouches) as Record<string, { at?: string; price?: number; level?: number } | undefined>;
  const eventTouches = input.events.filter((event) => event.type.endsWith('_TOUCHED'));
  const touchOf = (key: string) => {
    const stored = touches[key];
    if (stored?.at) return { at: stored.at, price: num(stored.price), level: num(stored.level), source: 'EXIT_ENGINE' as const };
    const event = eventTouches.find((item) => item.type === `${key}_TOUCHED`);
    return event ? { at: event.at.toISOString(), price: num(event.price), level: num(record(event.details).level), source: 'EXIT_ENGINE' as const } : null;
  };
  const tpLevel = num(p.takeProfitPrice);
  const tpTouch = touchOf('TAKE_PROFIT');
  // Older exits have no touch record; the observed path (MFE) can still show that TP was reached.
  const tpReachedByPath = !tpTouch && tpLevel && entry && mfe !== null ? mfe >= (tpLevel / entry - 1) * 100 : false;
  const marketPriceAtTrigger = num(diagnostics.marketPriceAtTrigger) ?? requestedExitPrice;
  const triggerToFillDeteriorationPercent = num(diagnostics.triggerToFillPriceDeteriorationPercent) ?? (hasLatency ? priceDeteriorationPercent(marketPriceAtTrigger, fillPrice) : null);
  const tpTouchToFillDeteriorationPercent = num(diagnostics.tpTouchToFillDeteriorationPercent) ?? (tpTouch?.price ? priceDeteriorationPercent(tpTouch.price, fillPrice) : null);
  const requestedVsTrigger = marketPriceAtTrigger && requestedExitPrice ? priceDeteriorationPercent(marketPriceAtTrigger, requestedExitPrice) : null;
  if (hasLatency) {
    // Millisecond timeline of the instrumented exit path (the generic EXIT_TRIGGERED / PAPER_SELL_REQUESTED stay too).
    const timeline: Array<[string, string | null | undefined, number | null]> = [
      ['MARKET_EVENT_RECEIVED', stamps.marketEventReceivedAt, marketPriceAtTrigger],
      ['EXIT_EVALUATED', stamps.exitEvaluationCompletedAt, null],
      ['EXECUTION_REQUESTED', stamps.exitExecutionRequestedAt, null],
      ['EXECUTION_STARTED', stamps.exitExecutionStartedAt, requestedExitPrice],
      ['PAPER_FILL', stamps.exitFillAt, fillPrice],
    ];
    for (const [type, at, price] of timeline) if (at) lifecycle.push({ type, at, price, details: {} });
    lifecycle.sort((a, b) => a.at.localeCompare(b.at));
  }
  const exitSpeed = {
    instrumented: hasLatency,
    latency,
    timestamps: hasLatency ? stamps : null,
    paperExecutionLatencyMode: typeof diagnostics.paperExecutionLatencyMode === 'string' ? diagnostics.paperExecutionLatencyMode : null,
    paperExecutionSimulatedLatencyMs: num(diagnostics.paperExecutionSimulatedLatencyMs),
    marketEventSource: typeof diagnostics.marketEventSource === 'string' ? diagnostics.marketEventSource : null,
    marketEventSlot: num(diagnostics.marketEventSlot),
    marketPriceAtTrigger,
    requestedExitPrice,
    simulatedFillPrice: fillPrice,
    protectiveLevelAtTrigger: num(diagnostics.protectiveLevelAtTrigger) ?? num(diagnostics.effectiveStopPrice),
    triggerToFillDeteriorationPercent,
    tpTouchToFillDeteriorationPercent,
    takeProfit: {
      level: tpLevel,
      levelPercent: pct(tpLevel),
      firstTouchedAt: tpTouch?.at ?? null,
      firstTouchPrice: tpTouch?.price ?? null,
      reachedByPathOnly: tpReachedByPath,
      triggeredAt: recordedReason === 'TAKE_PROFIT' ? (typeof diagnostics.exitTriggerAt === 'string' ? diagnostics.exitTriggerAt : null) : null,
      fillPrice: recordedReason === 'TAKE_PROFIT' ? fillPrice : null,
    },
    touches: { TAKE_PROFIT: tpTouch, STOP_LOSS: touchOf('STOP_LOSS'), BREAK_EVEN_STOP: touchOf('BREAK_EVEN_STOP'), TRAILING_STOP: touchOf('TRAILING_STOP') },
    liquidityAtFill: num(diagnostics.liquidityAtFill) ?? liquidityAtTrigger,
  };

  // ---- Exit quality (evidence only; INSUFFICIENT_DATA instead of a forced class) ----
  const quality: ExitQuality[] = [];
  const thresholds = EXIT_ANOMALY_THRESHOLDS;
  if (anomalies.includes('MFE_BELOW_REALIZED_RETURN') || anomalies.includes('MAE_ABOVE_REALIZED_RETURN') || anomalies.includes('MISLABELED_EXIT_REASON')) quality.push('EXIT_ENGINE_ANOMALY');
  if (anomalies.includes('LIQUIDITY_COLLAPSE_EXIT')) quality.push('LIQUIDITY_COLLAPSE');
  if (diagnostics.exitDataStale === true) quality.push('STALE_MARKET_DATA');
  const detectionMs = latency?.receiveToEvaluationLatencyMs ?? null;
  if ((detectionMs !== null && detectionMs > thresholds.slowDetectionMs) || (!hasLatency && evaluationGapMs !== null && evaluationGapMs > thresholds.highEvaluationGapMs)) quality.push('SLOW_DETECTION');
  if (latency?.triggerToFillLatencyMs != null && latency.triggerToFillLatencyMs > thresholds.slowExecutionMs) quality.push('SLOW_EXECUTION');
  if (requestedVsTrigger !== null && requestedVsTrigger < thresholds.highSlippagePercent) quality.push('HIGH_SLIPPAGE');
  const impact = num(diagnostics.exitPriceImpactPercent) ?? exitSlippagePercent;
  if (impact !== null && impact > thresholds.highPriceImpactPercent) quality.push('HIGH_PRICE_IMPACT');
  const tpReached = Boolean(tpTouch) || tpReachedByPath;
  if (tpReached && tpLevel && fillPrice && fillPrice < tpLevel * (1 - thresholds.tpCaptureTolerancePercent / 100)) quality.push('MISSED_TP_TOUCH');
  if (!quality.length) {
    if (samples < 3 && mfe === null && !hasLatency) quality.push('INSUFFICIENT_DATA');
    else if (recordedReason === 'TAKE_PROFIT' || ((netPnl ?? 0) > 0 && (triggerGapPercent === null || Math.abs(triggerGapPercent) <= thresholds.largeTriggerGapPercent))) quality.push('GOOD_EXIT');
    // A stop that filled near (or a gap beyond) its level without a bot-side cause: the market moved.
    else if (triggerGapPercent !== null) quality.push('NORMAL_MARKET_GIVEBACK');
    else quality.push('INSUFFICIENT_DATA');
  }

  return {
    positionEntryPrice: entry,
    entryBasis: 'SIMULATED_ENTRY_FILL',
    entryMarketPrice: num(p.entryMarketPrice),
    entrySlippagePercent: num(launch.fillSlippagePercent) ?? (entry && num(p.entryMarketPrice) ? (entry / num(p.entryMarketPrice)! - 1) * 100 : null),
    quantity,
    positionSize: size,
    configVersion: p.configVersion ?? record(snapshot.newLaunch).configVersion ?? null,
    exitConfig: Object.keys(exitConfig).length ? exitConfig : null,
    stopLoss: { configuredPercent: baseStopPercent, basePrice: baseStopPrice, storedStopPrice: num(p.stopLossPrice) },
    takeProfit: { price: num(p.takeProfitPrice), percentFromEntry: pct(num(p.takeProfitPrice)) },
    breakEven: {
      enabled: breakEvenActivation !== null && breakEvenActivation > 0,
      activationPercent: breakEvenActivation !== null ? breakEvenActivation * 100 : null,
      activationPrice: entry && breakEvenActivation ? entry * (1 + breakEvenActivation) : null,
      activatedAt: iso(p.breakEvenAppliedAt),
      activated: Boolean(p.breakEvenAppliedAt),
      costBufferPercent: buffer * 100,
      formula: `entryFill × (1 + ${(buffer * 100).toFixed(2)}%)`,
      expectedStopPrice: expectedBreakEvenStop,
      effectiveStopBeforeActivation: baseStopPrice,
      effectiveStopAfterActivation: p.breakEvenAppliedAt ? num(p.stopLossPrice) : null,
    },
    trailing: {
      enabled: trailingDistance !== null && trailingDistance > 0,
      activationPercent: trailingActivation !== null ? trailingActivation * 100 : null,
      distancePercent: trailingDistance !== null ? trailingDistance * 100 : null,
      activated: p.trailingActive,
      activatedAt: iso(p.trailingActivatedAt),
      highestPriceAtActivation: num(p.trailingActivationPrice),
      expectedStopPrice: expectedTrailingStop,
      actualStopPrice: actualTrailingStop,
      matchesFormula: expectedTrailingStop !== null && actualTrailingStop !== null ? Math.abs(actualTrailingStop / expectedTrailingStop - 1) < 1e-6 : null,
    },
    highestPrice: highest,
    lowestPrice: num(p.lowestPrice),
    effectiveStop: { price: effectiveStop, source: stopSource, percentFromEntry: pct(effectiveStop) },
    exit: {
      recordedReason,
      effectiveReason,
      triggerPrice,
      triggerAt: iso(diagnostics.exitTriggerAt) ?? iso(t?.exitAt),
      requestedExitPrice,
      fillPrice,
      triggerGapPercent,
      exitSlippagePercent,
      exitPriceImpactPercent: num(diagnostics.exitPriceImpactPercent) ?? num(diagnostics.exitSlippagePercent),
      conditionsTriggered: diagnostics.conditionsTriggered ?? null,
      marketDataAgeMs: num(diagnostics.marketDataAgeMs),
      exitDataStale: diagnostics.exitDataStale === true ? true : diagnostics.exitDataStale === false ? false : null,
      evaluationGapMs,
      exitExecutionLatencyMs: executionLatencyMs,
    },
    returns: {
      mfePercent: mfe,
      maePercent: mae,
      grossReturnPercent,
      netReturnPercent,
      givebackPercentagePoints: mfe !== null && netReturnPercent !== null ? mfe - netReturnPercent : null,
      captureRatio: mfe !== null && mfe > 0 && netReturnPercent !== null && netReturnPercent > 0 ? netReturnPercent / mfe : null,
    },
    costs: { entryFee, exitFee, totalFees, entrySlippageUsd, exitSlippageUsd, grossPnl: num(t?.pnl), netPnl },
    liquidity: { atEntry: liquidityAtEntry, atMfe: liquidityAtMfe?.liquidityUsd ?? null, atTrigger: liquidityAtTrigger, atFill: liquidityAtTrigger, changePercent: liquidityChangePercent },
    pathSamples: samples,
    pathDataQuality: samples >= 3 ? 'OK' : 'INSUFFICIENT_PRICE_PATH_DATA',
    anomalies,
    primaryCause,
    lifecycle,
    exitSpeed,
    exitQuality: quality,
  };
}
