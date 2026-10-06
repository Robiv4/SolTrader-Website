/**
 * Exit latency profiler: splits the time between a market event and the paper fill into its components, for
 * every exit reason (STOP_LOSS, TAKE_PROFIT, BREAK_EVEN_STOP, TRAILING_STOP, LIQUIDITY_SAFETY, MAX_HOLD_TIME, ...).
 *
 * Wall-clock timestamps (ISO strings) are persisted for auditability; a missing timestamp yields null for every
 * component that needs it - nothing is estimated.
 */

export interface ExitLatencyTimestamps {
  /** Provider / on-chain time of the market event (block time); often only second precision or unknown. */
  marketEventSourceTimestamp?: string | null;
  /** When this process received the market event. */
  marketEventReceivedAt?: string | null;
  exitEvaluationStartedAt?: string | null;
  exitEvaluationCompletedAt?: string | null;
  exitTriggeredAt?: string | null;
  exitExecutionRequestedAt?: string | null;
  exitExecutionStartedAt?: string | null;
  exitFillAt?: string | null;
  positionClosedAt?: string | null;
}

export interface ExitLatencyComponents {
  sourceToReceiveLatencyMs: number | null;
  receiveToEvaluationLatencyMs: number | null;
  exitEvaluationDurationMs: number | null;
  evaluationToTriggerLatencyMs: number | null;
  triggerToExecutionRequestLatencyMs: number | null;
  executionRequestToStartLatencyMs: number | null;
  executionStartToFillLatencyMs: number | null;
  triggerToFillLatencyMs: number | null;
  marketEventToFillLatencyMs: number | null;
}

const ms = (value: string | null | undefined) => {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const diff = (from: number | null, to: number | null) => (from !== null && to !== null ? to - from : null);

/** Latency components from stored timestamps (null when either side is unknown). */
export function computeExitLatency(timestamps: ExitLatencyTimestamps | null | undefined, highResolutionEvaluationMs: number | null = null): ExitLatencyComponents {
  const t = timestamps ?? {};
  const source = ms(t.marketEventSourceTimestamp);
  const received = ms(t.marketEventReceivedAt);
  const evalStart = ms(t.exitEvaluationStartedAt);
  const evalEnd = ms(t.exitEvaluationCompletedAt);
  const triggered = ms(t.exitTriggeredAt);
  const requested = ms(t.exitExecutionRequestedAt);
  const started = ms(t.exitExecutionStartedAt);
  const filled = ms(t.exitFillAt);
  return {
    sourceToReceiveLatencyMs: diff(source, received),
    receiveToEvaluationLatencyMs: diff(received, evalStart),
    // The monotonic (performance.now) duration is preferred over millisecond wall clock differences.
    exitEvaluationDurationMs: highResolutionEvaluationMs ?? diff(evalStart, evalEnd),
    evaluationToTriggerLatencyMs: diff(evalEnd, triggered),
    triggerToExecutionRequestLatencyMs: diff(triggered, requested),
    executionRequestToStartLatencyMs: diff(requested, started),
    executionStartToFillLatencyMs: diff(started, filled),
    triggerToFillLatencyMs: diff(triggered, filled),
    marketEventToFillLatencyMs: diff(received, filled),
  };
}

/** LONG: how much worse (negative) the fill was than a reference price, in percent. */
export function priceDeteriorationPercent(referencePrice: number | null | undefined, fillPrice: number | null | undefined) {
  if (!referencePrice || !fillPrice || referencePrice <= 0 || fillPrice <= 0) return null;
  return (fillPrice / referencePrice - 1) * 100;
}

/** Bounded rolling sample for runtime percentiles (P50 / P95 / P99) without unbounded memory. */
export class RollingPercentiles {
  private readonly values: number[] = [];
  private next = 0;
  count = 0;

  constructor(private readonly capacity = 2_000) {}

  add(value: number) {
    if (!Number.isFinite(value)) return;
    if (this.values.length < this.capacity) this.values.push(value);
    else this.values[this.next] = value;
    this.next = (this.next + 1) % this.capacity;
    this.count += 1;
  }

  percentile(q: number) {
    if (!this.values.length) return null;
    const sorted = [...this.values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q))];
  }

  summary() {
    return { count: this.count, p50: this.percentile(0.5), p95: this.percentile(0.95), p99: this.percentile(0.99), max: this.values.length ? Math.max(...this.values) : null };
  }
}
