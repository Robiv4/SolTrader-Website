import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PAPER_TRADING_CONFIG,
  PaperTradingEngine,
  calculatePaperPositionSize,
  type PaperMarketData,
  type PaperSignal,
} from '../src/index.js';

const baseSignal: PaperSignal = {
  token: 'TOKEN',
  timestamp: new Date('2026-09-23T10:00:00.000Z'),
  strategy: 'MomentumStrategy',
  score: 90,
  riskScore: 10,
  recommendedAction: 'BUY',
  reasons: ['fixture signal'],
};

const baseMarket: PaperMarketData = {
  token: 'TOKEN',
  symbol: 'TKN',
  priceUsd: 100,
  liquidityUsd: 1_000_000,
  volatilityPercent: 10,
  slippageEstimatePercent: 1,
};

function config(overrides: Partial<typeof DEFAULT_PAPER_TRADING_CONFIG> = {}) {
  return { ...DEFAULT_PAPER_TRADING_CONFIG, ...overrides };
}

async function openPosition(engine: PaperTradingEngine, market = baseMarket, signal = baseSignal) {
  const order = await engine.createOrder(signal, market, new Date('2026-09-23T10:00:00.000Z'));
  expect(order.status).toBe('QUEUED');
  await engine.fillOrder(order.id, market, new Date('2026-09-23T10:01:00.000Z'));
  expect(engine.openPositions).toHaveLength(1);
  return engine.openPositions[0];
}

describe('paper execution lifecycle', () => {
  it('creates and fills a simulated order with fees, slippage, delay, and partial execution', async () => {
    const engine = new PaperTradingEngine(10_000, config({ executionDelayMs: 1_000, partialFillRatio: 0.5, priorityFeeUsd: 0.25 }));
    const order = await engine.createOrder(baseSignal, baseMarket, new Date('2026-09-23T10:00:00.000Z'));
    const pending = await engine.fillOrder(order.id, baseMarket, new Date('2026-09-23T10:00:00.500Z'));
    expect(pending.status).toBe('QUEUED');

    const filled = await engine.fillOrder(order.id, baseMarket, new Date('2026-09-23T10:01:00.000Z'));
    expect(filled.status).toBe('PARTIALLY_FILLED');
    expect(filled.feeUsd).toBeGreaterThan(0);
    expect(filled.slippageUsd).toBeGreaterThan(0);
    expect(filled.priorityFeeUsd).toBe(0.25);
  });

  it('sizes positions using equity, signal, risk, volatility, liquidity, and exposure', () => {
    const size = calculatePaperPositionSize({ accountEquityUsd: 10_000, currentExposureUsd: 0, signalScore: 100, riskScore: 0, volatilityPercent: 0, liquidityUsd: 1_000_000 }, config());
    expect(size).toBeGreaterThan(0);
    expect(size).toBeLessThanOrEqual(200);
  });

  it('enforces exposure and malformed-data limits', async () => {
    const engine = new PaperTradingEngine(10_000, config({ maxPositionPercent: 5, maxTotalExposurePercent: 5, maxRiskPerTradePercent: 100 }));
    const fullSignal = { ...baseSignal, score: 100, riskScore: 0 };
    const fullMarket = { ...baseMarket, volatilityPercent: 0 };
    await openPosition(engine, fullMarket, fullSignal);
    const exposureRejected = await engine.createOrder({ ...fullSignal, token: 'SECOND' }, { ...fullMarket, token: 'SECOND' });
    expect(exposureRejected.rejectionReason).toBe('EXPOSURE_LIMIT');

    const malformed = await engine.createOrder(baseSignal, { ...baseMarket, priceUsd: Number.NaN });
    expect(malformed.rejectionReason).toBe('MALFORMED_MARKET_DATA');
  });
});

describe('paper risk controls', () => {
  it('closes on stop loss and take profit', async () => {
    const stopEngine = new PaperTradingEngine(10_000, config({ cooldownMs: 0 }));
    const stopPosition = await openPosition(stopEngine);
    const stopped = await stopEngine.evaluateExits({ ...baseMarket, priceUsd: 97 }, new Date('2026-09-23T11:00:00.000Z'));
    expect(stopped[0]).toMatchObject({ exitReason: 'STOP_LOSS' });
    expect(stopEngine.closedPaperTrades[0].netPnlUsd).toBeLessThan(0);

    const takeEngine = new PaperTradingEngine(10_000, config({ cooldownMs: 0 }));
    await openPosition(takeEngine);
    const taken = await takeEngine.evaluateExits({ ...baseMarket, priceUsd: 107 }, new Date('2026-09-23T11:00:00.000Z'));
    expect(taken[0]).toMatchObject({ exitReason: 'TAKE_PROFIT' });
    expect(takeEngine.closedPaperTrades[0].netPnlUsd).toBeGreaterThan(0);
    expect(stopPosition.id).not.toBe(taken[0].id);
  });

  it('closes on a trailing stop after a new high', async () => {
    const engine = new PaperTradingEngine(10_000, config({ takeProfitPercent: 50, cooldownMs: 0 }));
    await openPosition(engine);
    expect(await engine.evaluateExits({ ...baseMarket, priceUsd: 102 })).toEqual([]);
    const closed = await engine.evaluateExits({ ...baseMarket, priceUsd: 99.5 });
    expect(closed[0].exitReason).toBe('TRAILING_STOP');
  });

  it('enforces cooldown after a close and daily loss after repeated losses', async () => {
    const cooldownEngine = new PaperTradingEngine(10_000, config({ cooldownMs: 86_400_000 }));
    await openPosition(cooldownEngine);
    await cooldownEngine.evaluateExits({ ...baseMarket, priceUsd: 97 });
    const cooldownRejected = await cooldownEngine.createOrder(baseSignal, baseMarket, new Date('2026-09-23T12:00:00.000Z'));
    expect(cooldownRejected.rejectionReason).toBe('COOLDOWN_ACTIVE');

    const lossEngine = new PaperTradingEngine(10_000, config({ maxPositionPercent: 100, maxTotalExposurePercent: 100, maxRiskPerTradePercent: 100, stopLossPercent: 10, cooldownMs: 0 }));
    await openPosition(lossEngine);
    const lossAt = new Date('2026-09-23T11:00:00.000Z');
    await lossEngine.evaluateExits({ ...baseMarket, priceUsd: 89 }, lossAt);
    const dailyLossRejected = await lossEngine.createOrder({ ...baseSignal, token: 'OTHER' }, { ...baseMarket, token: 'OTHER' }, lossAt);
    expect(dailyLossRejected.rejectionReason).toBe('DAILY_LOSS_LIMIT');
  });
});
