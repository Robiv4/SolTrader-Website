import { describe, expect, it } from 'vitest';

import { describeExitLevels, evaluateLongExit, type LongExitState, type PersistedExitState } from '../src/index.js';

const base: PersistedExitState = {
  entryPrice: 1, stopLossPrice: 0.8, takeProfitPrice: 1.5, trailingDistance: 0.08, trailingActivation: 0.15, trailingActive: false, trailingActivatedAt: null,
  trailingActivationPrice: null, trailingTriggerPrice: null, breakEvenActivation: 0.1, breakEvenAppliedAt: null, highestPrice: 1.05, lowestPrice: 0.97,
};

describe('describeExitLevels (read model of the persisted Exit Engine state)', () => {
  it('reports SL / TP from the stored prices with distances from the current price', () => {
    const view = describeExitLevels(base, 1.05);
    expect(view.stopLoss).toMatchObject({ price: 0.8 });
    expect(view.stopLoss!.percentFromEntry).toBeCloseTo(-20, 8);
    expect(view.takeProfit!.percentFromEntry).toBeCloseTo(50, 8);
    expect(view.takeProfit!.distancePercent).toBeCloseTo((1.5 / 1.05 - 1) * 100, 8);
    expect(view.breakEven).toMatchObject({ enabled: true, status: 'WAITING' });
    expect(view.breakEven.activationPrice).toBeCloseTo(1.1, 8);
    expect(view.trailing).toMatchObject({ enabled: true, status: 'WAITING', triggerPrice: null });
    expect(view.trailing.activationLevelPrice).toBeCloseTo(1.15, 8);
  });

  it('active trailing / break-even come from the stored state, never recomputed', () => {
    const activatedAt = new Date('2026-09-29T10:00:00Z');
    const view = describeExitLevels({ ...base, stopLossPrice: 1, breakEvenAppliedAt: activatedAt, trailingActive: true, trailingActivatedAt: activatedAt, trailingActivationPrice: 1.16, trailingTriggerPrice: 1.196, highestPrice: 1.3 }, 1.25);
    expect(view.breakEven.status).toBe('ACTIVE');
    expect(view.trailing).toMatchObject({ status: 'ACTIVE', triggerPrice: 1.196, activatedAt: activatedAt.toISOString() });
    expect(view.trailing.distanceToTriggerPercent).toBeCloseTo((1.196 / 1.25 - 1) * 100, 8);
  });

  it('no trailing configured -> OFF', () => {
    expect(describeExitLevels({ ...base, trailingDistance: null }, 1).trailing.status).toBe('OFF');
  });
});

describe('trailing stop monotonicity', () => {
  it('the trailing trigger never moves down while the price pulls back', () => {
    let state: LongExitState = {
      entryPrice: 1, stopLossPrice: 0.8, takeProfitPrice: null, trailingDistance: 0.08, trailingActivation: 0.15, breakEvenActivation: null, roundTripCostFraction: 0.004,
      highestPrice: 1, lowestPrice: 1, trailingActive: false, trailingActivatedAt: null, trailingActivationPrice: null, trailingTriggerPrice: null, breakEvenAppliedAt: null,
    };
    const triggers: number[] = [];
    let at = Date.UTC(2026, 8, 29, 10);
    for (const price of [1.1, 1.2, 1.3, 1.25, 1.22, 1.28, 1.35, 1.3]) {
      at += 2_000;
      const result = evaluateLongExit(state, price, new Date(at));
      expect(result.exitReason).toBeNull();
      state = result.state;
      if (state.trailingTriggerPrice !== null) triggers.push(state.trailingTriggerPrice);
    }
    expect(triggers.length).toBeGreaterThan(3);
    for (let i = 1; i < triggers.length; i += 1) expect(triggers[i]).toBeGreaterThanOrEqual(triggers[i - 1]);
    expect(triggers.at(-1)).toBeCloseTo(1.35 * 0.92, 8);
  });
});
