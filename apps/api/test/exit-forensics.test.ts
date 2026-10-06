import { describe, expect, it } from 'vitest';

import { buildExitForensics, type ForensicsInput } from '../src/exit-forensics.js';

const openedAt = new Date('2026-10-01T10:00:00Z');
const closedAt = new Date('2026-10-01T10:02:00Z');

/** Entry fill 100, quantity 1 (size 100 USDC), SL 18% from the snapshot, BE +10%, trailing 8% after +15%. */
function input(overrides: { position?: Partial<ForensicsInput['position']>; trade?: Partial<NonNullable<ForensicsInput['trade']>>; pathMetric?: ForensicsInput['pathMetric']; series?: ForensicsInput['series'] } = {}): ForensicsInput {
  return {
    position: {
      id: 'p1', openedAt, closedAt, avgEntryPrice: 100, entryMarketPrice: 99.5, quantity: 1, stopLossPrice: 82, takeProfitPrice: 125,
      trailingStopPercent: 0.08, trailingActivationPercent: 0.15, trailingActive: false, trailingActivatedAt: null, trailingActivationPrice: null, trailingTriggerPrice: null,
      breakEvenActivationPercent: 0.1, breakEvenAppliedAt: null, breakEvenCostBuffer: 0.006, highestPrice: 100, lowestPrice: 100, entryLiquidityUsd: 10_000, exitReason: 'STOP_LOSS',
      ...overrides.position,
    },
    trade: {
      entry: 100, exit: 99.5, exitMarketPrice: 100, size: 100, fees: 0.6, slippage: 1, exitSlippage: 0.5, pnl: -0.5, netPnl: -1.1, exitReason: 'STOP_LOSS',
      exitDiagnostics: {}, configSnapshot: { newLaunch: { exitConfig: { stopLossPercent: 18 } } }, entryAt: openedAt, exitAt: closedAt,
      ...overrides.trade,
    },
    events: [],
    pathMetric: overrides.pathMetric === undefined ? { mfePercent: 2, maePercent: -1, timeToMfeMs: 10_000, timeToMaeMs: 20_000, milestones: {}, sampleCount: 20, maxPriceAfterEntry: 102, minPriceAfterEntry: 99, source: 'LIVE' } : overrides.pathMetric,
    series: overrides.series ?? Array.from({ length: 24 }, (_, index) => ({ t: openedAt.getTime() + index * 5_000, price: 100, liquidityUsd: 10_000 })),
  };
}

describe('exit forensics (stored data only)', () => {
  it('trigger 100 -> fill 99.5 is explained by the modelled exit slippage (no gap anomaly)', () => {
    const result = buildExitForensics(input({ trade: { exitDiagnostics: { exitTriggerPrice: 100, requestedExitPrice: 100, stopSource: 'BASE_STOP_LOSS' } } }));
    expect(result.positionEntryPrice).toBe(100);
    expect(result.entryBasis).toBe('SIMULATED_ENTRY_FILL');
    expect(result.stopLoss.basePrice).toBeCloseTo(82, 10);
    expect(result.exit.triggerGapPercent).toBe(0);
    expect(result.exit.exitSlippagePercent).toBeCloseTo(0.5, 10);
    expect(result.anomalies).not.toContain('LARGE_TRIGGER_FILL_GAP');
    // Fees once per side: 0.30% of the 100 USDC entry, the rest is the exit fee.
    expect(result.costs.entryFee).toBeCloseTo(0.3, 10);
    expect(result.costs.exitFee).toBeCloseTo(0.3, 10);
  });

  it('trigger 100 -> observed 83 shows the gap and flags it', () => {
    const result = buildExitForensics(input({ trade: { exit: 82.5, exitMarketPrice: 83, exitDiagnostics: { exitTriggerPrice: 100, requestedExitPrice: 83, stopSource: 'BASE_STOP_LOSS' } } }));
    expect(result.exit.triggerGapPercent).toBeCloseTo(-17, 8);
    expect(result.anomalies).toContain('LARGE_TRIGGER_FILL_GAP');
  });

  it('QRCAT-like legacy exit: BE applied, trailing armed above it, recorded STOP_LOSS -> effective TRAILING_STOP and mislabel flagged', () => {
    const result = buildExitForensics(input({
      position: { stopLossPrice: 100.6, breakEvenAppliedAt: new Date('2026-10-01T10:00:30Z'), trailingActive: true, trailingActivatedAt: new Date('2026-10-01T10:00:44Z'), trailingActivationPrice: 124.37, trailingTriggerPrice: 124.37 * 0.92, highestPrice: 124.37 },
      trade: { exit: 83.84, exitMarketPrice: 84.3, netPnl: -16.7, exitDiagnostics: { triggerLevel: 100.6 } },
      pathMetric: { mfePercent: 24.37, maePercent: -15.7, timeToMfeMs: 44_000, timeToMaeMs: 70_000, milestones: {}, sampleCount: 8, maxPriceAfterEntry: 124.37, minPriceAfterEntry: 84.3, source: 'LIVE' },
    }));
    expect(result.effectiveStop.source).toBe('TRAILING');
    expect(result.effectiveStop.price).toBeCloseTo(114.4204, 4);
    expect(result.exit.recordedReason).toBe('STOP_LOSS');
    expect(result.exit.effectiveReason).toBe('TRAILING_STOP');
    expect(result.anomalies).toEqual(expect.arrayContaining(['MISLABELED_EXIT_REASON', 'TRAILING_EXIT_BELOW_EXPECTED']));
    expect(result.trailing.matchesFormula).toBe(true);
    expect(result.breakEven.expectedStopPrice).toBeCloseTo(100.6, 10);
  });

  it('a break-even exit far below the break-even stop is BREAK_EVEN_LARGE_NEGATIVE_EXIT', () => {
    const result = buildExitForensics(input({
      position: { stopLossPrice: 100.6, breakEvenAppliedAt: new Date('2026-10-01T10:00:30Z') },
      trade: { exit: 90, exitMarketPrice: 90.5, netPnl: -10.6, exitReason: 'BREAK_EVEN_STOP', exitDiagnostics: { exitTriggerPrice: 100.6, requestedExitPrice: 90.5, stopSource: 'BREAK_EVEN' } },
      pathMetric: { mfePercent: 11, maePercent: -9.5, timeToMfeMs: 30_000, timeToMaeMs: 110_000, milestones: {}, sampleCount: 20, maxPriceAfterEntry: 111, minPriceAfterEntry: 90.5, source: 'LIVE' },
    }));
    expect(result.anomalies).toContain('BREAK_EVEN_LARGE_NEGATIVE_EXIT');
    expect(result.exit.effectiveReason).toBe('BREAK_EVEN_STOP');
  });

  it('missing path data is reported as INSUFFICIENT_DATA, never guessed', () => {
    const result = buildExitForensics(input({ pathMetric: null, series: [] }));
    expect(result.pathDataQuality).toBe('INSUFFICIENT_PRICE_PATH_DATA');
    expect(result.primaryCause).toBe('INSUFFICIENT_DATA');
    expect(result.returns.mfePercent).toBeNull();
    expect(result.exit.evaluationGapMs).toBeNull();
  });

  it('a realised return above the observed MFE is an implementation anomaly', () => {
    const result = buildExitForensics(input({ trade: { exit: 120, exitMarketPrice: 120.5, netPnl: 19.4, exitReason: 'TAKE_PROFIT' } }));
    expect(result.anomalies).toContain('MFE_BELOW_REALIZED_RETURN');
    expect(result.primaryCause).toBe('IMPLEMENTATION_ANOMALY');
  });

  it('a stale quote and a long evaluation gap are surfaced', () => {
    const sparse = [{ t: openedAt.getTime(), price: 100, liquidityUsd: 10_000 }, { t: closedAt.getTime() - 26_000, price: 120, liquidityUsd: 9_000 }];
    const result = buildExitForensics(input({ series: sparse, trade: { exitDiagnostics: { exitTriggerPrice: 100, requestedExitPrice: 100, exitDataStale: true, marketDataAgeMs: 40_000 } } }));
    expect(result.exit.evaluationGapMs).toBe(26_000);
    expect(result.anomalies).toEqual(expect.arrayContaining(['EXIT_DATA_STALE', 'HIGH_EXIT_LATENCY']));
  });

  it('instrumented TP exit: latency components, touch vs fill deterioration and a GOOD_EXIT class', () => {
    const at = (ms: number) => new Date(Date.parse('2026-10-01T10:01:00.000Z') + ms).toISOString();
    const result = buildExitForensics(input({
      trade: {
        exit: 126.5, exitMarketPrice: 127, netPnl: 25.9, exitReason: 'TAKE_PROFIT',
        exitDiagnostics: {
          exitTriggerPrice: 125, marketPriceAtTrigger: 127, requestedExitPrice: 127, exitTouches: { TAKE_PROFIT: { at: at(0), price: 127, level: 125 } },
          takeProfitFirstTouchPrice: 127, exitEvaluationDurationMs: 0.02,
          latencyTimestamps: { marketEventReceivedAt: at(0), exitEvaluationStartedAt: at(1), exitEvaluationCompletedAt: at(1), exitTriggeredAt: at(1), exitExecutionRequestedAt: at(1), exitExecutionStartedAt: at(1), exitFillAt: at(12) },
        },
      },
      pathMetric: { mfePercent: 27, maePercent: -1, timeToMfeMs: 60_000, timeToMaeMs: 5_000, milestones: {}, sampleCount: 20, maxPriceAfterEntry: 127, minPriceAfterEntry: 99, source: 'LIVE' },
    }));
    expect(result.exitSpeed.instrumented).toBe(true);
    expect(result.exitSpeed.latency?.receiveToEvaluationLatencyMs).toBe(1);
    expect(result.exitSpeed.latency?.triggerToFillLatencyMs).toBe(11);
    expect(result.exitSpeed.latency?.exitEvaluationDurationMs).toBe(0.02);
    expect(result.exitSpeed.takeProfit.firstTouchPrice).toBe(127);
    expect(result.exitSpeed.tpTouchToFillDeteriorationPercent).toBeCloseTo((126.5 / 127 - 1) * 100, 8);
    expect(result.exitQuality).toEqual(['GOOD_EXIT']);
    expect(result.lifecycle.map((item) => item.type)).toEqual(expect.arrayContaining(['MARKET_EVENT_RECEIVED', 'EXIT_EVALUATED', 'PAPER_FILL']));
  });

  it('TP touched (+28%) but filled far below it after a slow execution: MISSED_TP_TOUCH + SLOW_EXECUTION + HIGH_SLIPPAGE', () => {
    const at = (ms: number) => new Date(Date.parse('2026-10-01T10:01:00.000Z') + ms).toISOString();
    const result = buildExitForensics(input({
      trade: {
        exit: 114.4, exitMarketPrice: 115, netPnl: 13.8, exitReason: 'TAKE_PROFIT',
        exitDiagnostics: {
          exitTriggerPrice: 125, marketPriceAtTrigger: 128, requestedExitPrice: 115, exitTouches: { TAKE_PROFIT: { at: at(0), price: 128, level: 125 } }, takeProfitFirstTouchPrice: 128,
          latencyTimestamps: { marketEventReceivedAt: at(0), exitEvaluationCompletedAt: at(1), exitTriggeredAt: at(1), exitExecutionRequestedAt: at(1), exitExecutionStartedAt: at(2_501), exitFillAt: at(2_510) },
        },
      },
      pathMetric: { mfePercent: 28, maePercent: -1, timeToMfeMs: 60_000, timeToMaeMs: 5_000, milestones: {}, sampleCount: 20, maxPriceAfterEntry: 128, minPriceAfterEntry: 99, source: 'LIVE' },
    }));
    expect(result.exitQuality).toEqual(expect.arrayContaining(['MISSED_TP_TOUCH', 'SLOW_EXECUTION', 'HIGH_SLIPPAGE']));
    expect(result.exitSpeed.tpTouchToFillDeteriorationPercent).toBeCloseTo((114.4 / 128 - 1) * 100, 8);
  });

  it('legacy exits have no latency (null, not estimated)', () => {
    const result = buildExitForensics(input());
    expect(result.exitSpeed.instrumented).toBe(false);
    expect(result.exitSpeed.latency).toBeNull();
  });

  it('a TAKE_PROFIT exit that recorded the current trailing stop source stays a TAKE_PROFIT (no mislabel)', () => {
    const result = buildExitForensics(input({
      position: { trailingActive: true, trailingTriggerPrice: 115, highestPrice: 125, exitReason: 'TAKE_PROFIT' },
      trade: { exit: 124.4, exitMarketPrice: 125, netPnl: 23.8, exitReason: 'TAKE_PROFIT', exitDiagnostics: { exitTriggerPrice: 125, stopSource: 'TRAILING' } },
      pathMetric: { mfePercent: 25.2, maePercent: -1, timeToMfeMs: 60_000, timeToMaeMs: 5_000, milestones: {}, sampleCount: 20, maxPriceAfterEntry: 125.2, minPriceAfterEntry: 99, source: 'LIVE' },
    }));
    expect(result.exit.effectiveReason).toBe('TAKE_PROFIT');
    expect(result.anomalies).not.toContain('MISLABELED_EXIT_REASON');
  });
});

