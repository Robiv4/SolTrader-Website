import { DEFAULT_NEW_LAUNCH_SETTINGS, evaluateNewLaunch, evaluateQualityGate, newLaunchExitConfig, normalizeQualityGate, resolveNewLaunchSettings } from '@soltrader/strategy-engine';
import { describe, expect, it } from 'vitest';

import { PositionManager, type PositionManagerStore, type PositionRecord } from '../src/position-manager.js';

function store(initial: PositionRecord[]) {
  const positions = [...initial];
  const value: PositionManagerStore = {
    async getOpenPositions() { return positions.filter((row) => row.status === 'OPEN'); },
    async updatePosition(id, updates) { Object.assign(positions.find((row) => row.id === id)!, updates); },
    async closePosition(id, updates) { Object.assign(positions.find((row) => row.id === id)!, updates, { status: 'CLOSED' }); },
    async publishEvent() { return undefined; },
  };
  return { value, positions };
}

const T0 = Date.UTC(2026, 8, 30, 10);
const launchPosition = (overrides: Partial<PositionRecord> = {}): PositionRecord => ({
  id: 'nl-1', userId: 'u1', token: 'MINT', symbol: 'NL', side: 'BUY', quantity: 10, avgEntryPrice: 100, currentPrice: 100,
  stopLoss: 80, takeProfit: 125, trailingStop: 0.08, trailingActivation: 0.15, breakEvenActivation: 0.1, highestPrice: 100, lowestPrice: 100,
  status: 'OPEN', exitPolicy: 'NEW_LAUNCH', openedAt: new Date(T0), entryLiquidityUsd: 20_000, liquidityOutflowExitPercent: 50, ...overrides,
});

describe('NewLaunch exit settings', () => {
  it('are separate from the strategy exit settings and snapshot-able', () => {
    const settings = resolveNewLaunchSettings({ stopLossPercent: 20, takeProfitPercent: 25, trailingActivationPercent: 15, trailingDistancePercent: 8, breakEvenActivationPercent: 10 });
    const exit = newLaunchExitConfig(settings);
    expect(exit).toMatchObject({ stopLossPercent: 20, takeProfitPercent: 25, breakEvenEnabled: true, breakEvenActivationPercent: 10, trailingEnabled: true, trailingActivationPercent: 15, trailingDistancePercent: 8, liquiditySafetyEnabled: true, liquidityDropExitPercent: 50 });
    // Trailing does not arm from entry by default; disabled features snapshot as null.
    expect(DEFAULT_NEW_LAUNCH_SETTINGS.trailingActivationPercent).toBeGreaterThan(0);
    expect(newLaunchExitConfig({ ...settings, trailingEnabled: false, maxHoldEnabled: false }).trailingDistancePercent).toBeNull();
    expect(newLaunchExitConfig({ ...settings, maxHoldEnabled: false }).maxHoldMinutes).toBeNull();
    expect(DEFAULT_NEW_LAUNCH_SETTINGS.tieredTakeProfitEnabled).toBe(false);
  });
});

describe('Exit Engine: NewLaunch liquidity safety and max hold time', () => {
  it('closes with LIQUIDITY_SAFETY when liquidity fell below the snapshotted threshold', async () => {
    const { value, positions } = store([launchPosition()]);
    await new PositionManager(value).reconcileMarket({ MINT: { price: 101, liquidityUsd: 9_000 } }, new Date(T0 + 30_000));
    expect(positions[0]).toMatchObject({ status: 'CLOSED', exitReason: 'LIQUIDITY_SAFETY' });
  });

  it('closes with MAX_HOLD_TIME only after the snapshotted deadline', async () => {
    const { value, positions } = store([launchPosition({ maxHoldUntil: new Date(T0 + 60_000) })]);
    const manager = new PositionManager(value);
    await manager.reconcileMarket({ MINT: { price: 102, liquidityUsd: 20_000 } }, new Date(T0 + 30_000));
    expect(positions[0].status).toBe('OPEN');
    await manager.reconcileMarket({ MINT: { price: 102, liquidityUsd: 20_000 } }, new Date(T0 + 61_000));
    expect(positions[0]).toMatchObject({ status: 'CLOSED', exitReason: 'MAX_HOLD_TIME' });
  });

  it('tracks the real path (MFE / MAE / milestones) on every evaluation', async () => {
    const { value, positions } = store([launchPosition({ trailingStop: null, breakEvenActivation: null, liquidityOutflowExitPercent: null })]);
    const manager = new PositionManager(value);
    for (const [offset, price] of [[1_000, 95], [2_000, 110], [3_000, 120], [4_000, 108]] as const) await manager.reconcileMarket({ MINT: price }, new Date(T0 + offset));
    const metric = positions[0].pathMetric!;
    expect(metric.maxPrice).toBe(120);
    expect(metric.minPrice).toBe(95);
    expect(metric.milestones['+20']).toBe(3_000);
    expect(metric.milestones['-5']).toBe(1_000);
  });

  it('the trailing stop never moves downward and never arms before activation', async () => {
    const { value, positions } = store([launchPosition({ breakEvenActivation: null, liquidityOutflowExitPercent: null })]);
    const manager = new PositionManager(value);
    const triggers: number[] = [];
    for (const [offset, price] of [[1_000, 110], [2_000, 118], [3_000, 124], [4_000, 119], [5_000, 122]] as const) {
      await manager.reconcileMarket({ MINT: price }, new Date(T0 + offset));
      if (offset === 1_000) expect(positions[0].trailingActive).toBe(false);
      if (positions[0].trailingTriggerPrice) triggers.push(positions[0].trailingTriggerPrice);
    }
    for (let i = 1; i < triggers.length; i += 1) expect(triggers[i]).toBeGreaterThanOrEqual(triggers[i - 1]);
    expect(triggers.at(-1)).toBeCloseTo(124 * 0.92, 8);
  });
});

describe('NewLaunch quality gate', () => {
  const failing = { launchScore: 72, uniqueBuyers: 8, liquidityUsd: 12_000, buySellRatio: 1.2, exhaustionScore: 55, priceImpactPercent: 2.5, holderConcentrationPercent: 10, devAllocationPercent: 2, dataQuality: 90 };
  const passing = { launchScore: 88, uniqueBuyers: 40, liquidityUsd: 45_000, buySellRatio: 2.4, exhaustionScore: 25, priceImpactPercent: 0.8, holderConcentrationPercent: 8, devAllocationPercent: 1, dataQuality: 95 };

  it('MONITOR_ONLY records wouldPass=false but never blocks the PAPER entry', () => {
    const result = evaluateQualityGate(failing, normalizeQualityGate({ mode: 'MONITOR_ONLY' }));
    expect(result).toMatchObject({ evaluated: true, wouldPass: false, blocksEntry: false });
    expect(result.reasons).toEqual(expect.arrayContaining(['LAUNCH_SCORE_BELOW_GATE', 'UNIQUE_BUYERS_BELOW_GATE', 'LIQUIDITY_BELOW_GATE', 'EXHAUSTION_ABOVE_GATE', 'PRICE_IMPACT_ABOVE_GATE']));
  });

  it('ENFORCE_PAPER blocks a failing candidate; unknown inputs fail instead of passing', () => {
    expect(evaluateQualityGate(failing, normalizeQualityGate({ mode: 'ENFORCE_PAPER' })).blocksEntry).toBe(true);
    const unknown = evaluateQualityGate({ ...passing, devAllocationPercent: null }, normalizeQualityGate({ mode: 'ENFORCE_PAPER' }));
    expect(unknown.reasons).toEqual(['DEV_ALLOCATION_UNKNOWN']);
    expect(unknown.blocksEntry).toBe(true);
    expect(evaluateQualityGate(passing, normalizeQualityGate({ mode: 'ENFORCE_PAPER' }))).toMatchObject({ wouldPass: true, blocksEntry: false });
    expect(evaluateQualityGate(failing, normalizeQualityGate({ mode: 'OFF' }))).toMatchObject({ evaluated: false, blocksEntry: false });
    // Migration default: MONITOR_ONLY.
    expect(normalizeQualityGate(null).mode).toBe('MONITOR_ONLY');
  });

  it('cannot turn a hard security rejection into a BUY: sellability FAILED with Launch Score 95 is REJECT', () => {
    const now = T0;
    const observations = Array.from({ length: 12 }, (_, i) => ({ takenAt: now - (11 - i) * 2_000, priceUsd: 0.00001 * (1 + i * 0.02), liquidityUsd: 60_000, buyCount: 20 + i * 8, sellCount: 2 + i, volumeUsd: 3_000 + i * 900, buyVolumeUsd: 2_600 + i * 800, sellVolumeUsd: 400 + i * 100, uniqueBuyers: 15 + i * 4, uniqueSellers: 2 + i }));
    const result = evaluateNewLaunch({ mint: 'M', detectedAt: now - 24_000, createdAt: now - 26_000, observations, largestBuyerShare: 0.08, buysPerBuyer: 1.2, creatorSoldRatio: 0, largestHolderSupplyShare: 0.03, priceImpactPercent: 0.5, observedSellers: 5 },
      { sellability: 'FAILED', mintAuthorityRevoked: true, freezeAuthorityRevoked: true, tokenProgram: 'spl-token', extensions: [], hardBlockReasons: [], warnings: [] },
      { riskScore: 20, classification: 'LOW', hardBlockReasons: [] }, { ...DEFAULT_NEW_LAUNCH_SETTINGS, enabled: true }, now);
    expect(result.decision).toBe('REJECT');
    // The gate is only evaluated for BUY decisions, so a passing gate can never override this.
    expect(evaluateQualityGate(passing, normalizeQualityGate({ mode: 'ENFORCE_PAPER' })).wouldPass).toBe(true);
  });
});
