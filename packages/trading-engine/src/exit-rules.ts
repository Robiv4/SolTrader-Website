/**
 * Exit rules of an open LONG PAPER position, evaluated once per market snapshot.
 *
 * Documented semantics (all prices are market/reference prices; the entry price is the simulated FILL):
 *  - Stop loss:    triggers when price <= stopLossPrice   (entryFill * (1 - SL%)).
 *  - Take profit:  triggers when price >= takeProfitPrice (entryFill * (1 + TP%)); closes 100% of the position.
 *  - Trailing:     arms once the highest price since entry reached entryFill * (1 + activation%)
 *                  (activation 0/null = armed from entry: legacy behaviour). While armed the trigger is
 *                  highest * (1 - distance%) and triggers when price <= trigger.
 *  - Break-even:   optional; once highest >= entryFill * (1 + breakEven%), the stop is raised to the
 *                  net break-even price (entry fill plus round-trip fees). Never lowered.
 *  - Effective protective stop (LONG) = MAX(stop loss (raised to break-even when applied), trailing trigger when
 *    armed). The exit reason names the component that SET the effective stop: TRAILING_STOP, BREAK_EVEN_STOP or
 *    STOP_LOSS — so a price gap through several stops at once is attributed to the strongest stop.
 *  - Precedence when several conditions hold on the same snapshot: protective stop (effective), TAKE_PROFIT.
 *    Every condition that held is reported in `conditions` (diagnostics only).
 *  - Break-even stop = entryFill * (1 + roundTripCostFraction): entry FILL plus the configured cost buffer
 *    (default: the two PAPER fees, 2 x 0.30%). Never lowers an existing stop.
 *  - Invariants: highest never decreases, the trailing trigger never decreases, the stop never decreases,
 *    the effective stop never decreases, and once armed the trailing stays armed (persisted on the position).
 *  - Fill policy: a trigger is detected on the current snapshot and filled from THAT snapshot's price
 *    (minus modelled exit slippage), never at the theoretical trigger level. Gaps between snapshots are
 *    therefore realised as they would be with a market order.
 */

export type ExitReason = 'STOP_LOSS' | 'BREAK_EVEN_STOP' | 'TAKE_PROFIT' | 'TRAILING_STOP';

/** Which protective component sets the effective stop. */
export type StopSource = 'BASE_STOP_LOSS' | 'BREAK_EVEN' | 'TRAILING';

export interface LongExitState {
  entryPrice: number;
  stopLossPrice: number | null;
  takeProfitPrice: number | null;
  /** Trailing distance as a fraction (0.08 = 8%); null/0 disables trailing. */
  trailingDistance: number | null;
  /** Activation gain as a fraction (0.15 = +15%); null/0 = armed from entry. */
  trailingActivation: number | null;
  /** Break-even activation gain as a fraction; null/0 = disabled. */
  breakEvenActivation: number | null;
  /** Round-trip cost fraction used for the break-even stop (fees). */
  roundTripCostFraction: number;
  highestPrice: number;
  lowestPrice: number;
  trailingActive: boolean;
  trailingActivatedAt: Date | null;
  trailingActivationPrice: number | null;
  trailingTriggerPrice: number | null;
  breakEvenAppliedAt: Date | null;
}

export interface LongExitEvaluation {
  state: LongExitState;
  exitReason: ExitReason | null;
  /** The level that was crossed (for diagnostics); the fill uses the snapshot price. */
  triggerLevel: number | null;
  /** True when trailing armed on this snapshot. */
  trailingArmedNow: boolean;
  /** True when the break-even stop was applied on this snapshot. */
  breakEvenAppliedNow: boolean;
  /** Strongest protective stop after this evaluation (MAX of stop loss / break-even and the armed trailing trigger). */
  effectiveStopPrice: number | null;
  stopSource: StopSource | null;
  /** Every exit condition that held on this snapshot (diagnostics; the reason follows the documented precedence). */
  conditions: ExitReason[];
}

/** The strongest protective stop of a LONG position and the component that sets it. */
export function effectiveProtectiveStop(state: Pick<LongExitState, 'stopLossPrice' | 'trailingActive' | 'trailingTriggerPrice' | 'breakEvenAppliedAt'>): { price: number | null; source: StopSource | null } {
  const base = positive(state.stopLossPrice) ? state.stopLossPrice : null;
  const trailing = state.trailingActive && positive(state.trailingTriggerPrice) ? state.trailingTriggerPrice : null;
  // The trailing stop only sets the effective stop when it is strictly tighter (a tie stays with the fixed stop).
  if (trailing !== null && (base === null || trailing > base)) return { price: trailing, source: 'TRAILING' };
  if (base !== null) return { price: base, source: state.breakEvenAppliedAt ? 'BREAK_EVEN' : 'BASE_STOP_LOSS' };
  return { price: null, source: null };
}

function positive(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

export function evaluateLongExit(previous: LongExitState, price: number, at: Date): LongExitEvaluation {
  if (!positive(price)) throw new Error('evaluateLongExit requires a positive market price');
  const state: LongExitState = { ...previous };
  state.highestPrice = Math.max(positive(previous.highestPrice) ? previous.highestPrice : price, price);
  state.lowestPrice = Math.min(positive(previous.lowestPrice) ? previous.lowestPrice : price, price);

  let breakEvenAppliedNow = false;
  if (positive(state.breakEvenActivation) && !state.breakEvenAppliedAt && state.highestPrice >= state.entryPrice * (1 + state.breakEvenActivation)) {
    const breakEvenPrice = state.entryPrice * (1 + Math.max(0, state.roundTripCostFraction));
    state.stopLossPrice = Math.max(state.stopLossPrice ?? 0, breakEvenPrice);
    state.breakEvenAppliedAt = at;
    breakEvenAppliedNow = true;
  }

  let trailingArmedNow = false;
  if (positive(state.trailingDistance)) {
    if (!state.trailingActive) {
      const activationLevel = state.entryPrice * (1 + (positive(state.trailingActivation) ? state.trailingActivation : 0));
      if (!positive(state.trailingActivation) || state.highestPrice >= activationLevel) {
        state.trailingActive = true;
        state.trailingActivatedAt = at;
        state.trailingActivationPrice = positive(state.trailingActivation) ? state.highestPrice : state.entryPrice;
        trailingArmedNow = true;
      }
    }
    if (state.trailingActive) {
      const candidate = state.highestPrice * (1 - state.trailingDistance);
      state.trailingTriggerPrice = Math.max(state.trailingTriggerPrice ?? 0, candidate);
    }
  }

  const effective = effectiveProtectiveStop(state);
  const conditions: ExitReason[] = [];
  if (positive(state.stopLossPrice) && price <= state.stopLossPrice) conditions.push(state.breakEvenAppliedAt ? 'BREAK_EVEN_STOP' : 'STOP_LOSS');
  if (state.trailingActive && positive(state.trailingTriggerPrice) && price <= state.trailingTriggerPrice) conditions.push('TRAILING_STOP');
  if (positive(state.takeProfitPrice) && price >= state.takeProfitPrice) conditions.push('TAKE_PROFIT');

  let exitReason: ExitReason | null = null;
  let triggerLevel: number | null = null;
  if (effective.price !== null && price <= effective.price) {
    exitReason = effective.source === 'TRAILING' ? 'TRAILING_STOP' : effective.source === 'BREAK_EVEN' ? 'BREAK_EVEN_STOP' : 'STOP_LOSS';
    triggerLevel = effective.price;
  } else if (positive(state.takeProfitPrice) && price >= state.takeProfitPrice) {
    exitReason = 'TAKE_PROFIT';
    triggerLevel = state.takeProfitPrice;
  }
  return { state, exitReason, triggerLevel, trailingArmedNow, breakEvenAppliedNow, effectiveStopPrice: effective.price, stopSource: effective.source, conditions };
}

/** Protection levels for a new LONG position, derived from the simulated entry FILL price. */
export function protectionLevels(entryFillPrice: number, stopLossPercent: number | null, takeProfitPercent: number | null) {
  return {
    stopLossPrice: positive(stopLossPercent) ? entryFillPrice * (1 - stopLossPercent / 100) : null,
    takeProfitPrice: positive(takeProfitPercent) ? entryFillPrice * (1 + takeProfitPercent / 100) : null,
  };
}
