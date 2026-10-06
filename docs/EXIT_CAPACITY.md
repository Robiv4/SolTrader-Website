# Exit capacity and dynamic position sizing (NewLaunch, PAPER)

The question asked before every NewLaunch BUY:

> If this entire planned position had to be sold immediately, could it realistically be exited with acceptable price impact?

It measures **executability**, never the token's direction. It is separate from the Launch Score and from the AI confidence.

Code:

- `packages/trading-engine/src/exit-capacity.ts` — pure functions.
- `apps/worker/src/exit/entry-capacity.ts` — entry glue and metrics.
- `apps/api/src/capacity-analytics.ts` — analytics.

## Models (`basis`, always reported)

| Basis | Source | Shown as |
| --- | --- | --- |
| `POOL_MODEL` | Constant-product math on the live pump.fun bonding-curve reserves from the trade stream (virtual SOL / virtual token). The real SOL reserve bounds the full-exit payout (`POOL_RESERVE`). | Model, 0.1% precision. |
| `LIQUIDITY_ESTIMATE` | Same formula as the PAPER fill model: `0.1 + 100·x/(L/2 + x)`. | Estimate, "~", rounded to 0.5%. |
| `EXECUTABLE_QUOTE` / `ROUTE_SIMULATION` | Reserved; no PAPER quote / route provider is wired yet. | — |
| `INSUFFICIENT_DATA` | No usable data. | Classification `UNKNOWN`, never treated as safe. |

The full-exit test sells **100%** of the planned position in one go into the *current* pool state; the price lift of our own buy is not assumed to last.

- Round-trip impact = `1 − (1 − sell) / (1 + buy)`.
- Round-trip cost adds both PAPER fees (2 × 0.30%).

## Max safe position, score, class

`maxSafePosition` is the largest size, floored to `positionSizeStep`, that stays within all limits:

- entry impact;
- full-exit impact;
- round-trip impact;
- liquidity utilization;
- the pool reserve.

Impacts grow monotonically with size, so it is found by binary search.

`exitCapacityScore` (0–100):

- 70% from the full-exit impact versus its limit, 30% from liquidity utilization;
- multiplied by 0.9 for estimates;
- capped at 49 when sellability is not verified.

The class follows from the score: EXCELLENT ≥85, GOOD ≥70, MODERATE ≥50, POOR ≥25, otherwise UNSAFE.

- No sell route → UNSAFE.
- Missing or stale data → UNKNOWN.

## Sizing (can only reduce)

```text
final = min(existing risk-approved size (all limits + risk multiplier), maxSafePosition)
```

- If `final < minimumExecutablePosition`, the trade is `TOO_SMALL_TO_TRADE`.
- An UNSAFE pool (no route, failed sellability) or UNKNOWN capacity is blocked.

The capacity limit is applied **after** the risk multiplier, as an absolute ceiling. So it never raises a size above any other limit.

Modes:

| Mode | Effect |
| --- | --- |
| `MONITOR_ONLY` (default) | The executed size is unchanged. The NL-v2 sample stays comparable. |
| `ENFORCE_PAPER` | The recommendation is applied: the size is reduced or the trade rejected (`EXIT_CAPACITY_*`). |

Switching to `ENFORCE_PAPER` creates a new configuration version. The thresholds are versioned only while enforced.

## Recorded data

Each trade stores `configSnapshot.launch.exitCapacity`, which is immutable:

- the result at entry;
- `liquidityAtEntry`, `routeAtEntry`, `curveAtEntry`;
- the capacity curve for 25 / 50 / 100 / 200 / 500 / 1000 USDC;
- `sizing`: original requested, risk approved, liquidity / exit-capacity recommendation, final recommended, actual executed, mode, decision, reasons, and the MONITOR_ONLY difference.

After entry, the hot exit monitor evaluates the capacity of the current position value on every market event. It records two kinds of event:

- `EXIT_CAPACITY_DETERIORATED`, when the class drops;
- `SELL_ROUTE_LOST` / `SELL_ROUTE_CHANGED`, when the curve migrates.

This is **diagnostic only**: the existing Liquidity Safety exit stays the single liquidity-based exit rule. Each exit also stores `exitDiagnostics.exitCapacityAtTrigger`.

## Analytics

**Analytics → NewLaunch → Likviditás / Kapacitás**:

- an entry-snapshot summary;
- the capital-scalability replay at 25 to 1000 USDC per trade, unconstrained and capacity-limited;
- capacity vs outcome;
- partial-exit simulation (100% vs 2×50% vs 4×25%, chronological, no lookahead);
- the max safe position per trade.

The replay uses the stored entry and exit liquidity with the PAPER liquidity model. The market path is held fixed, which is **optimistic for large sizes**. Its calibration at the actual size is shown alongside.

Past P&L is never multiplied by capital, and trades are never rewritten.

## Known model limits

- The PAPER exit fill model uses the liquidity estimate. For a bonding curve this is based on the *real* SOL reserve and is more pessimistic than the curve's virtual reserves.
  - The capacity engine uses the curve (`POOL_MODEL`) and records both.
  - Changing the fill model would change the NL-v2 P&L basis, so it belongs in a new config version.
- The on-chain pump.fun fee (about 1%) is not modelled. The PAPER fee is 0.30% per side.
