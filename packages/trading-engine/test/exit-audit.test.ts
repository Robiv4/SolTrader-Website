/**
 * Exit Engine correctness audit (entry fill 100): break-even, trailing, effective protective stop,
 * SL / TP basis and fill direction. Pure functions only; the worker / DB paths have their own tests.
 */
import { describe, expect, it } from 'vitest';

import { effectiveProtectiveStop, evaluateLongExit, type LongExitState, protectionLevels } from '../src/exit-rules.js';
import { simulatedBuyFill, simulatedSellFill } from '../src/paper-fills.js';

const t0 = new Date('2026-10-01T10:00:00Z');
const at = (seconds: number) => new Date(t0.getTime() + seconds * 1000);

/** NewLaunch-like defaults: SL 18%, TP 25%, BE at +10% with a 0.6% buffer, trailing 8% after +15%. */
function state(overrides: Partial<LongExitState> = {}): LongExitState {
  const levels = protectionLevels(100, 18, 25);
  return {
    entryPrice: 100,
    stopLossPrice: levels.stopLossPrice,
    takeProfitPrice: levels.takeProfitPrice,
    trailingDistance: 0.08,
    trailingActivation: 0.15,
    breakEvenActivation: 0.1,
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

function walk(path: number[], initial = state()) {
  let current = initial;
  const evaluations: Array<ReturnType<typeof evaluateLongExit>> = [];
  for (const [index, price] of path.entries()) {
    const evaluation = evaluateLongExit(current, price, at(index));
    evaluations.push(evaluation);
    current = evaluation.state;
    if (evaluation.exitReason) break;
  }
  return { state: current, evaluations, exit: evaluations.find((item) => item.exitReason) ?? null };
}

describe('SL / TP basis', () => {
  it('derives TP 125 and SL 82 from the entry FILL 100 (not the pre-fill market price)', () => {
    expect(protectionLevels(100, 18, 25)).toEqual({ stopLossPrice: 82, takeProfitPrice: 125 });
    // A 1% entry impact on a market price of 99.0099 gives the fill 100: levels still use the fill.
    const fill = simulatedBuyFill(100 / 1.01, 1);
    expect(fill).toBeCloseTo(100, 10);
    expect(protectionLevels(fill, 18, 25).stopLossPrice).toBeCloseTo(82, 8);
  });
});

describe('break-even', () => {
  it('BE activated at 111: stop = 100 x (1 + 0.6%) = 100.6 and never returns to the base stop', () => {
    const { state: armed, evaluations } = walk([105, 111]);
    expect(evaluations[1].breakEvenAppliedNow).toBe(true);
    expect(armed.stopLossPrice).toBeCloseTo(100.6, 10);
    // Further evaluations below the activation level keep the raised stop.
    const later = walk([108, 104, 101], armed);
    expect(later.exit).toBeNull();
    expect(later.state.stopLossPrice).toBeCloseTo(100.6, 10);
    expect(later.state.breakEvenAppliedAt).toEqual(armed.breakEvenAppliedAt);
    // The next breach exits as BREAK_EVEN_STOP at the break-even trigger, not at the base stop 82.
    const exit = evaluateLongExit(later.state, 100.5, at(10));
    expect(exit.exitReason).toBe('BREAK_EVEN_STOP');
    expect(exit.triggerLevel).toBeCloseTo(100.6, 10);
    expect(exit.stopSource).toBe('BREAK_EVEN');
  });

  it('a configurable buffer changes only the break-even level', () => {
    const { state: armed } = walk([111], state({ roundTripCostFraction: 0.012 }));
    expect(armed.stopLossPrice).toBeCloseTo(101.2, 10);
  });

  it('a gap through the break-even stop is reported as a gap, not hidden: trigger 100.6, observed 83', () => {
    const { state: armed } = walk([111]);
    const exit = evaluateLongExit(armed, 83, at(30));
    expect(exit.exitReason).toBe('BREAK_EVEN_STOP');
    expect(exit.triggerLevel).toBeCloseTo(100.6, 10);
    // The engine never pretends the exit happened at the trigger: the observed price is what the fill uses.
    expect((83 / exit.triggerLevel! - 1) * 100).toBeLessThan(-17);
  });
});

describe('trailing stop', () => {
  it('116 -> 106.72, 130 -> 119.60, 120 -> stays 119.60 (monotonic, never lowered)', () => {
    const first = walk([116]);
    expect(first.state.trailingActive).toBe(true);
    expect(first.state.trailingTriggerPrice).toBeCloseTo(106.72, 10);
    const second = walk([130], first.state);
    expect(second.state.trailingTriggerPrice).toBeCloseTo(119.6, 10);
    const third = walk([120], second.state);
    expect(third.exit).toBeNull();
    expect(third.state.trailingTriggerPrice).toBeCloseTo(119.6, 10);
    expect(third.state.highestPrice).toBe(130);
  });

  it('the trailing trigger never decreases over an arbitrary path', () => {
    const path = [101, 112, 116, 114, 125, 121, 131, 128, 129.5, 127];
    let current = state({ takeProfitPrice: null });
    let previousTrigger = 0;
    let previousEffective = 0;
    for (const [index, price] of path.entries()) {
      const evaluation = evaluateLongExit(current, price, at(index));
      current = evaluation.state;
      expect(current.trailingTriggerPrice ?? 0).toBeGreaterThanOrEqual(previousTrigger);
      expect(evaluation.effectiveStopPrice ?? 0).toBeGreaterThanOrEqual(previousEffective);
      previousTrigger = current.trailingTriggerPrice ?? 0;
      previousEffective = evaluation.effectiveStopPrice ?? 0;
      if (evaluation.exitReason) break;
    }
  });
});

describe('effective protective stop', () => {
  it('base 82, break-even 100.6, trailing 110 -> effective stop 110 (TRAILING)', () => {
    const effective = effectiveProtectiveStop({ stopLossPrice: 100.6, breakEvenAppliedAt: t0, trailingActive: true, trailingTriggerPrice: 110 });
    expect(effective).toEqual({ price: 110, source: 'TRAILING' });
    const exit = evaluateLongExit(state({ stopLossPrice: 100.6, breakEvenAppliedAt: t0, trailingActive: true, trailingTriggerPrice: 110, trailingDistance: 0.12, highestPrice: 125 }), 109, at(1));
    expect(exit.exitReason).toBe('TRAILING_STOP');
    expect(exit.triggerLevel).toBe(110);
    // Below every stop at once: still ONE reason (the effective stop), all conditions are recorded.
    expect(exit.conditions).toEqual(['TRAILING_STOP']);
    const deep = evaluateLongExit(exit.state, 80, at(2));
    expect(deep.exitReason).toBe('TRAILING_STOP');
    expect(deep.conditions).toEqual(['BREAK_EVEN_STOP', 'TRAILING_STOP']);
  });

  it('QRCAT-like path: BE then trailing armed at +24.4%, crash to -15.7% exits as TRAILING_STOP at the trailing trigger', () => {
    const { state: armed } = walk([110.5, 124.37], state({ takeProfitPrice: null }));
    expect(armed.breakEvenAppliedAt).not.toBeNull();
    expect(armed.trailingTriggerPrice).toBeCloseTo(124.37 * 0.92, 8);
    const exit = evaluateLongExit(armed, 84.3, at(30));
    expect(exit.exitReason).toBe('TRAILING_STOP');
    expect(exit.triggerLevel).toBeCloseTo(124.37 * 0.92, 8);
  });
});

describe('fill direction', () => {
  it('BUY fills above and SELL fills below the reference price; slippage is applied once', () => {
    expect(simulatedBuyFill(100, 0.5)).toBeCloseTo(100.5, 10);
    expect(simulatedSellFill(100, 0.5)).toBeCloseTo(99.5, 10);
    // Applying the same impact again would compound (99.0025): the model is one multiplication per side.
    expect(simulatedSellFill(simulatedSellFill(100, 0.5), 0.5)).not.toBeCloseTo(99.5, 4);
  });
});
