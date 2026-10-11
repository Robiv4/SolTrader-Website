import { describe, expect, it } from 'vitest';

import { CANDLE_KEY_PREFIX, TradeCandleAggregator, type CandleStore, type TradeCandle } from '../src/launch/trade-candles.js';

function memoryStore(failFirst = 0) {
  const data = new Map<string, Record<string, string>>();
  const ttl = new Map<string, number>();
  let failures = failFirst;
  const store: CandleStore = {
    async hSet(key, values) {
      if (failures > 0) {
        failures -= 1;
        throw new Error('redis down');
      }
      data.set(key, { ...(data.get(key) ?? {}), ...values });
    },
    async expire(key, seconds) {
      ttl.set(key, seconds);
    },
  };
  const candles = (mint: string) => Object.values(data.get(`${CANDLE_KEY_PREFIX}${mint}`) ?? {}).map((value) => JSON.parse(value) as TradeCandle).sort((a, b) => a.t - b.t);
  return { store, data, ttl, candles };
}

const BASE = 1_700_000_000_000;

describe('TradeCandleAggregator', () => {
  it('builds OHLCV from real trades: price = SOL / tokens * SOL-USD, volume in USD, per 5 s block-time bucket', async () => {
    const memory = memoryStore();
    const aggregator = new TradeCandleAggregator({ store: memory.store, now: () => BASE + 10_000 });
    aggregator.record({ mint: 'M', isBuy: true, solAmount: 1, tokenAmount: 1_000_000, timestamp: BASE }, 150);
    aggregator.record({ mint: 'M', isBuy: true, solAmount: 2, tokenAmount: 1_000_000, timestamp: BASE + 1_000 }, 150);
    aggregator.record({ mint: 'M', isBuy: false, solAmount: 0.5, tokenAmount: 1_000_000, timestamp: BASE + 2_000 }, 150);
    aggregator.record({ mint: 'M', isBuy: true, solAmount: 1, tokenAmount: 1_000_000, timestamp: BASE + 6_000 }, 150);
    await aggregator.flush();
    const [first, second] = memory.candles('M');
    const bucket = Math.floor(BASE / 5_000) * 5_000;
    expect(first).toEqual({ t: bucket, o: 0.00015, h: 0.0003, l: 0.000075, c: 0.000075, v: 525, n: 3, buys: 2, sells: 1 });
    expect(second.t).toBe(bucket + 5_000);
    expect(memory.ttl.get(`${CANDLE_KEY_PREFIX}M`)).toBe(6 * 3600);
  });

  it('never invents data: no SOL price or invalid amounts -> no candle; quiet buckets stay empty', async () => {
    const memory = memoryStore();
    const aggregator = new TradeCandleAggregator({ store: memory.store, now: () => BASE });
    aggregator.record({ mint: 'M', isBuy: true, solAmount: 1, tokenAmount: 1_000, timestamp: BASE }, null);
    aggregator.record({ mint: 'M', isBuy: true, solAmount: 0, tokenAmount: 1_000, timestamp: BASE }, 150);
    aggregator.record({ mint: 'M', isBuy: true, solAmount: 1, tokenAmount: Number.NaN, timestamp: BASE }, 150);
    await aggregator.flush();
    expect(memory.candles('M')).toEqual([]);
    expect(aggregator.snapshot()).toMatchObject({ trades: 0, skippedNoSolPrice: 1, skippedInvalid: 2 });

    aggregator.record({ mint: 'M', isBuy: true, solAmount: 1, tokenAmount: 1_000, timestamp: BASE }, 150);
    aggregator.record({ mint: 'M', isBuy: true, solAmount: 1, tokenAmount: 1_000, timestamp: BASE + 60_000 }, 150);
    await aggregator.flush();
    expect(memory.candles('M')).toHaveLength(2);
  });

  it('falls back to the arrival time for an implausible block time', async () => {
    const memory = memoryStore();
    const aggregator = new TradeCandleAggregator({ store: memory.store, now: () => BASE });
    aggregator.record({ mint: 'M', isBuy: true, solAmount: 1, tokenAmount: 1_000, timestamp: BASE - 3_600_000, receivedAt: BASE }, 150);
    await aggregator.flush();
    expect(memory.candles('M')[0].t).toBe(Math.floor(BASE / 5_000) * 5_000);
  });

  it('retries buckets of a failed flush and writes only changed buckets', async () => {
    const memory = memoryStore(1);
    const aggregator = new TradeCandleAggregator({ store: memory.store, now: () => BASE });
    aggregator.record({ mint: 'M', isBuy: true, solAmount: 1, tokenAmount: 1_000, timestamp: BASE }, 150);
    await aggregator.flush();
    expect(memory.candles('M')).toEqual([]);
    expect(aggregator.snapshot().flushFailures).toBe(1);
    await aggregator.flush();
    expect(memory.candles('M')).toHaveLength(1);
    const before = aggregator.snapshot().flushedBuckets;
    await aggregator.flush();
    expect(aggregator.snapshot().flushedBuckets).toBe(before);
  });

  it('bounds memory: old buckets are dropped and the least recently traded mint is evicted', async () => {
    let now = BASE;
    const memory = memoryStore();
    const aggregator = new TradeCandleAggregator({ store: memory.store, now: () => now, maxMints: 2, retentionMs: 60_000 });
    aggregator.record({ mint: 'A', isBuy: true, solAmount: 1, tokenAmount: 1_000, timestamp: now }, 150);
    now += 1_000;
    aggregator.record({ mint: 'B', isBuy: true, solAmount: 1, tokenAmount: 1_000, timestamp: now }, 150);
    now += 1_000;
    aggregator.record({ mint: 'C', isBuy: true, solAmount: 1, tokenAmount: 1_000, timestamp: now }, 150);
    expect(aggregator.snapshot().mints).toBe(2);
    await aggregator.flush();
    expect(memory.candles('A')).toEqual([]);
    now += 120_000;
    await aggregator.flush();
    expect(aggregator.snapshot().mints).toBe(0);
  });
});
