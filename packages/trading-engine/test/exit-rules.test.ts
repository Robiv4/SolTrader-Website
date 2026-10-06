import { describe, expect, it } from 'vitest';

import { evaluateLongExit, type LongExitState, protectionLevels } from '../src/exit-rules.js';
import { estimateExitSlippagePercent, estimatePriceImpactPercent, simulatedBuyFill, simulatedSellFill } from '../src/paper-fills.js';

const at = new Date('2026-09-28T10:00:00Z');

function state(overrides: Partial<LongExitState> = {}): LongExitState {
  return {
    entryPrice: 100,
    stopLossPrice: null,
    takeProfitPrice: null,
    trailingDistance: 0.08,
    trailingActivation: 0.15,
    breakEvenActivation: null,
    roundTripCostFraction: 0.006,
    highestPrice: 100,
    lowestPrice: 100,
    trailingActive: false,
    trailingActivatedAt: null,
    trailingActivationPrice: null,
    trailingTriggerPrice: null,
    breakEvenAppliedAt: null,
    ...overrides,
  };
}

/** Feeds a price path through the rules the way the worker does (state persisted between snapshots). */
function run(path: number[], initial: LongExitState = state()) {
  let current = initial;
  let exit: ReturnType<typeof evaluateLongExit> | null = null;
  for (const price of path) {
    const evaluation = evaluateLongExit(current, price, at);
    current = evaluation.state;
    if (evaluation.exitReason) {
      exit = evaluation;
      break;
    }
  }
  return { state: current, exit };
}

describe('trailing stop with activation (entry 100, activation 15%, distance 8%)', () => {
  it('A: stays inactive below the activation level', () => {
    const { state: result, exit } = run([100, 105, 110, 114]);
    expect(result.trailingActive).toBe(false);
    expect(result.trailingTriggerPrice).toBeNull();
    expect(exit).toBeNull();
  });

  it('B: activates at +15% with highest 115 and trigger 105.8', () => {
    const { state: result, exit } = run([100, 115]);
    expect(result.trailingActive).toBe(true);
    expect(result.trailingActivationPrice).toBe(115);
    expect(result.highestPrice).toBe(115);
    expect(result.trailingTriggerPrice).toBeCloseTo(105.8, 10);
    expect(exit).toBeNull();
  });

  it('C: follows a new high: highest 120, trigger 110.4', () => {
    const { state: result } = run([100, 115, 120]);
    expect(result.highestPrice).toBe(120);
    expect(result.trailingTriggerPrice).toBeCloseTo(110.4, 10);
  });

  it('D: 112 stays above the 110.4 trigger, so no exit', () => {
    const { exit, state: result } = run([100, 115, 120, 112]);
    expect(exit).toBeNull();
    expect(result.trailingTriggerPrice).toBeCloseTo(110.4, 10);
  });

  it('E: 110 crosses the 110.4 trigger and exits as TRAILING_STOP', () => {
    const { exit } = run([100, 115, 120, 110]);
    expect(exit?.exitReason).toBe('TRAILING_STOP');
    expect(exit?.triggerLevel).toBeCloseTo(110.4, 10);
  });

  it('F: after 120 -> 115 -> 125 the peak becomes 125 and the trigger rises to 115', () => {
    const afterDip = run([100, 115, 120, 115]);
    expect(afterDip.exit).toBeNull();
    expect(afterDip.state.highestPrice).toBe(120);
    const { state: result, exit } = run([125], afterDip.state);
    expect(exit).toBeNull();
    expect(result.highestPrice).toBe(125);
    expect(result.trailingTriggerPrice).toBeCloseTo(115, 10);
  });

  it('never closes a trade below entry through trailing when activation is above the round-trip cost', () => {
    const { exit } = run([100, 99, 96, 94, 90]);
    expect(exit).toBeNull();
  });

  it('legacy (no activation): armed from entry, so a plain 5% dip closes the trade at a loss', () => {
    const { exit } = run([100, 95], state({ trailingActivation: null, trailingDistance: 0.05 }));
    expect(exit?.exitReason).toBe('TRAILING_STOP');
    expect(exit?.state.trailingActivationPrice).toBe(100);
  });

  it('keeps trailing armed across a restart (state reloaded from the database)', () => {
    const armed = run([100, 116]).state;
    const reloaded = { ...armed, trailingActivatedAt: new Date(armed.trailingActivatedAt!.toISOString()) };
    const { state: result } = run([113], reloaded);
    expect(result.trailingActive).toBe(true);
    expect(result.trailingTriggerPrice).toBeCloseTo(116 * 0.92, 10);
  });
});

describe('invariants', () => {
  it('highest price and trailing trigger never decrease on any path', () => {
    let seed = 42;
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    for (let trial = 0; trial < 200; trial += 1) {
      let current = state({ trailingActivation: trial % 3 === 0 ? null : 0.1, breakEvenActivation: trial % 2 ? 0.05 : null });
      let price = 100;
      for (let step = 0; step < 60; step += 1) {
        price = Math.max(0.01, price * (1 + (random() - 0.5) * 0.2));
        const next = evaluateLongExit(current, price, at).state;
        expect(next.highestPrice).toBeGreaterThanOrEqual(current.highestPrice);
        expect(next.trailingTriggerPrice ?? 0).toBeGreaterThanOrEqual(current.trailingTriggerPrice ?? 0);
        expect(next.stopLossPrice ?? 0).toBeGreaterThanOrEqual(current.stopLossPrice ?? 0);
        if (current.trailingActive) expect(next.trailingActive).toBe(true);
        current = next;
      }
    }
  });
});

describe('stop loss and take profit boundaries (entry 100, SL 20%, TP 25%)', () => {
  const levels = protectionLevels(100, 20, 25);
  const base = state({ stopLossPrice: levels.stopLossPrice, takeProfitPrice: levels.takeProfitPrice, trailingDistance: null });

  it('derives SL 80 and TP 125 from the entry fill', () => {
    expect(levels.stopLossPrice).toBeCloseTo(80, 10);
    expect(levels.takeProfitPrice).toBeCloseTo(125, 10);
  });

  it.each([
    [79, 'STOP_LOSS'],
    [80, 'STOP_LOSS'],
    [81, null],
    [124, null],
    [125, 'TAKE_PROFIT'],
    [126, 'TAKE_PROFIT'],
  ])('price %s -> %s (inclusive boundaries)', (price, expected) => {
    expect(evaluateLongExit(base, price, at).exitReason).toBe(expected);
  });

  it('names the stop that sets the effective protective stop; a breached stop wins over take profit', () => {
    // An (artificial) state where every condition holds at once: the trailing stop (120) is the tightest stop.
    const all = state({ stopLossPrice: 110, takeProfitPrice: 90, trailingActive: true, trailingTriggerPrice: 120, highestPrice: 130 });
    const evaluation = evaluateLongExit(all, 100, at);
    expect(evaluation.exitReason).toBe('TRAILING_STOP');
    expect(evaluation.triggerLevel).toBe(120);
    expect(evaluation.conditions).toEqual(expect.arrayContaining(['STOP_LOSS', 'TRAILING_STOP', 'TAKE_PROFIT']));
    // Fixed stop above the trailing stop: the fixed stop is the effective one.
    expect(evaluateLongExit({ ...all, stopLossPrice: 125 }, 100, at).exitReason).toBe('STOP_LOSS');
    // Equal levels stay with the fixed stop.
    expect(evaluateLongExit({ ...all, stopLossPrice: 120 }, 100, at).exitReason).toBe('STOP_LOSS');
    // No stop breached: take profit.
    expect(evaluateLongExit({ ...all, stopLossPrice: 50, trailingActive: false, trailingDistance: null, trailingTriggerPrice: null }, 100, at).exitReason).toBe('TAKE_PROFIT');
  });

  it('break-even raises the stop to entry + round-trip cost once +10% is reached, never lowering it', () => {
    const withBreakEven = state({ stopLossPrice: 80, takeProfitPrice: 200, trailingDistance: null, breakEvenActivation: 0.1 });
    const armed = run([100, 111], withBreakEven);
    expect(armed.state.stopLossPrice).toBeCloseTo(100.6, 10);
    expect(run([100.5], armed.state).exit?.exitReason).toBe('BREAK_EVEN_STOP');
  });
});

describe('fill model direction', () => {
  it('a BUY fills above and a SELL fills below the reference price', () => {
    expect(simulatedBuyFill(1, 1)).toBeCloseTo(1.01, 12);
    expect(simulatedSellFill(1, 1)).toBeCloseTo(0.99, 12);
  });

  it('exit slippage grows with size relative to liquidity and falls back to 0.1% without liquidity', () => {
    expect(estimateExitSlippagePercent(1, 100, null)).toBe(0.1);
    expect(estimateExitSlippagePercent(1, 100, 1_000_000)).toBeCloseTo(estimatePriceImpactPercent(100, 1_000_000), 12);
    expect(estimateExitSlippagePercent(1, 10_000, 100_000)).toBeGreaterThan(estimateExitSlippagePercent(1, 100, 100_000));
  });
});
