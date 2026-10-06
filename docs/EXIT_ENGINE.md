# Exit Engine (LONG, PAPER)

The rules are implemented in `packages/trading-engine/src/exit-rules.ts`. The worker applies them in
`apps/worker/src/position-manager.ts`. Diagnostics are rebuilt from stored data in `apps/api/src/exit-forensics.ts`.

## Entry basis

`positionEntryPrice` = `Position.avgEntryPrice` = the **simulated entry fill**:

```text
market × (1 + entry impact%)
```

Every level below is derived from it. This holds for the worker, the analytics and the UI.

| Level | Formula | Example (fill 100) |
| --- | --- | --- |
| Base stop loss | `fill × (1 − SL%)` | SL 18% → 82 |
| Take profit | `fill × (1 + TP%)` | TP 25% → 125 |
| Break-even activation | `highest ≥ fill × (1 + BE%)` | BE 10% → 110 |
| Break-even stop | `fill × (1 + newLaunchBreakEvenCostBufferPercent)` | default 0.6% (= 2 × 0.30% PAPER fee) → 100.6 |
| Trailing activation | `highest ≥ fill × (1 + activation%)` | 15% → 115 |
| Trailing stop | `highest × (1 − distance%)` | 8%: 116 → 106.72, 130 → 119.60 |

The break-even buffer is snapshotted on the position at entry (`Position.breakEvenCostBuffer`).
Later settings changes never move an open position's stops.

## Effective protective stop

```text
effectiveStop = MAX(base SL or break-even stop, armed trailing stop)
```

- `highestPrice` is monotonic.
- The trailing stop is `MAX(previous, highest × (1 − d))`, so it never decreases.
- Once break-even is applied, the stored stop is raised to the break-even stop and never returns to the base stop.

## Exit priority (deterministic)

1. **Effective protective stop breached.** The reason names the component that set the effective stop:
   - `TRAILING_STOP` when the trailing stop is strictly above the fixed stop;
   - else `BREAK_EVEN_STOP` when break-even was applied;
   - else `STOP_LOSS`.
2. `TAKE_PROFIT`
3. `LIQUIDITY_SAFETY`: pool liquidity dropped by at least the configured % since entry.
4. `MAX_HOLD_TIME`

Every condition that held is recorded in `exitDiagnostics.conditionsTriggered`.

Before 2026-10-01 the reason was `STOP_LOSS` even when the trailing stop or break-even stop was the effective stop.
Those legacy trades are re-labelled in analytics: `effectiveReason` is shown, plus a `MISLABELED_EXIT_REASON` anomaly.

## Trigger vs fill

The stop *triggers* at `exitTriggerPrice`, the effective stop level. The PAPER sell then *fills* from the observed
snapshot price (`requestedExitPrice`) minus the modelled exit impact:

```text
simulatedExitFillPrice = requestedExitPrice × (1 − exitPriceImpact%)
```

A price that gaps through the stop is never filled at the stop. The gap is stored as `triggerGapPercent`.

Fees are charged once per side (`PAPER_FEE_BPS` = 30). Slippage is applied once, inside each fill price.

## Event-driven NewLaunch exit monitor

NewLaunch positions are owned by `apps/worker/src/exit/hot-position-monitor.ts`. The pipeline:

```text
pump.fun logsSubscribe (WebSocket, slot + signature)
  → LaunchTracker trade
  → normalized MarketEvent
  → HotPositionMonitor
  → PositionManager.evaluatePosition (no I/O)
  → exit trigger (per-position lock)
  → closeEvaluated
  → closePaperPosition (conditional OPEN → CLOSED)
```

- **No database read before the decision.** Hot state is loaded at start and re-read every 2 s. The re-read picks up new positions and external closes. Merges are monotonic: the highest price, the trailing stop and the stop are never loosened.
- **Asynchronous persistence.** Critical transitions are written immediately but never awaited by the decision path: break-even, trailing activated / moved, touches and other lifecycle events. Marks, the highest price and MFE are coalesced, at most one write per second per position. There is one write in flight per position, and a failed write is retried.
- **Ordering.** An event with an older slot or market timestamp is rejected and counted as `OUT_OF_ORDER_MARKET_EVENT`. Identical observations (stream and poll of the same state) are skipped. The highest price and the trailing stop are monotonic in the Exit Engine itself.
- **Backpressure.** Evaluation is synchronous on the event, so queues only build while an exit is executing. A queue of more than 256 events is coalesced to its chronological high, low and latest event. A TP touch or a stop breach is therefore never lost.
- **Watchdog** (every `NEW_LAUNCH_EXIT_LOOP_MS`, default 1000 ms). The stream state is:
  - `CONNECTED`, `DEGRADED`, `STALE` (no event for `NEW_LAUNCH_EXIT_STREAM_STALE_MS`) or `DISCONNECTED`;
  - `FALLBACK_POLLING` while positions are protected by market-data polling. Polling runs every `NEW_LAUNCH_EXIT_FALLBACK_POLL_MS` per token, with one request in flight.

  A token silent for 30 s, or without a stream, is also polled. The watchdog also evaluates time-based exits (max hold).
- **Duplicate exits.** The per-position in-memory lock and the conditional database close mean that two events, or two workers, produce one fill.
- **Diagnostics.** The worker publishes `newlaunch:exitmonitor` to Redis every 2 s. The System page shows it.
- **Main loop.** The main trading loop skips NewLaunch positions while the hot monitor runs. Setting `NEW_LAUNCH_EXIT_LOOP_MS=0` disables the monitor, and the main loop takes these positions back.
- **AI.** AI is never on the exit path.

## Trigger vs fill and PAPER execution latency

| Field | Meaning |
| --- | --- |
| `exitTriggerPrice` | The level: effective stop or TP. |
| `marketPriceAtTrigger` | The observed price that triggered the exit. |
| `requestedExitPrice` | The market price the simulated sell executes against, at the execution time. |
| `simulatedFillPrice` | `requestedExitPrice × (1 − exitPriceImpactPercent)`. The size-vs-liquidity impact is applied once, in `closePaperPosition`. |
| `triggerToFillPriceDeteriorationPercent` | Fill vs `marketPriceAtTrigger`. |
| `tpTouchToFillDeteriorationPercent` | Fill vs the first TP touch price. |

`PAPER_EXIT_LATENCY_MODE` sets the simulated execution latency:

- `NONE` (default): the fill is computed right after the trigger.
- `FIXED`, `RANGE`, `EMPIRICAL` (P50 / P75 / P95): wait, then fill from the newest market state received by that moment. A later price is never used (no lookahead).

`EMPIRICAL` without percentiles behaves like `NONE`.

## Touches

The first touch of each level is recorded as an immutable `*_TOUCHED` position event, with:

- the market price and the level;
- the market data time and the receive time;
- the slot.

It is also stored in `exitDiagnostics.exitTouches` and the `takeProfitFirstTouched*` fields.

A touch is not a fill: analytics separates "TP reached" from "TP captured".

## Timing

`exitDiagnostics.latencyTimestamps` holds wall-clock timestamps:

- `marketEventSourceTimestamp` (block time, second precision);
- `marketEventReceivedAt`;
- `exitEvaluationStartedAt` / `CompletedAt`;
- `exitTriggeredAt`;
- `exitExecutionRequestedAt`;
- `exitExecutionStartedAt`;
- `exitFillAt`;
- `positionClosedAt`.

`exitDiagnostics.latency` holds the derived components (`computeExitLatency`, null when a timestamp is missing). The evaluation duration uses `performance.now()`.

Benchmark: `npx tsx apps/worker/scripts/exit-latency-benchmark.ts`.

## Stale data

A quote older than `EXIT_MARKET_DATA_MAX_AGE_MS` (default 15000):

- records one `MARKET_DATA_STALE` position event;
- sets `exitDataStale = true` on an exit decided with it.

Stops still execute; the exit is flagged, not hidden.
