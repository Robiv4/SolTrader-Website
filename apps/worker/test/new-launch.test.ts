import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { LaunchTracker } from '../src/launch/launch-tracker.js';
import { base58, decodePumpFunEvent, type LaunchEvent } from '../src/launch/providers.js';

const disc = (name: string) => createHash('sha256').update(`event:${name}`).digest().subarray(0, 8);
const key = (fill: number) => Buffer.alloc(32, fill);
const u64 = (value: number) => {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(BigInt(Math.round(value)));
  return buffer;
};
const i64 = (value: number) => {
  const buffer = Buffer.alloc(8);
  buffer.writeBigInt64LE(BigInt(Math.round(value)));
  return buffer;
};
const str = (value: string) => {
  const text = Buffer.from(value, 'utf8');
  const length = Buffer.alloc(4);
  length.writeUInt32LE(text.length);
  return Buffer.concat([length, text]);
};

function launch(mint: string, overrides: Partial<LaunchEvent> = {}): LaunchEvent {
  return { source: 'PUMP_FUN', mint, detectedAt: Date.now(), createdAt: Date.now(), bondingCurve: 'curve', poolAddress: null, quoteMint: null, creator: 'CREATOR', name: 'Test', symbol: 'TST', ...overrides };
}

const trade = (mint: string, wallet: string, isBuy: boolean, solAmount: number, tokenAmount: number) => ({
  mint, wallet, isBuy, solAmount, tokenAmount, timestamp: Date.now(), virtualSolReserves: 32, virtualTokenReserves: 1_000_000_000, realSolReserves: 2.5,
});

describe('pump.fun event decoder', () => {
  it('decodes a CreateEvent (name, symbol, mint, curve, creator, on-chain time)', () => {
    const ts = Math.floor(Date.UTC(2026, 8, 29) / 1000);
    const data = Buffer.concat([disc('CreateEvent'), str('Moon Dog'), str('MDOG'), str('https://x/meta.json'), key(1), key(2), key(3), key(4), i64(ts)]).toString('base64');
    expect(decodePumpFunEvent(data)).toMatchObject({ type: 'create', name: 'Moon Dog', symbol: 'MDOG', mint: base58(key(1)), bondingCurve: base58(key(2)), user: base58(key(3)), creator: base58(key(4)), timestamp: ts * 1000 });
  });

  it('decodes a TradeEvent with real amounts and reserves', () => {
    const data = Buffer.concat([disc('TradeEvent'), key(7), u64(1.5e9), u64(42_000_000 * 1e6), Buffer.from([1]), key(8), i64(1_790_000_000), u64(31.5e9), u64(1_020_000_000 * 1e6), u64(1.5e9)]).toString('base64');
    expect(decodePumpFunEvent(data)).toMatchObject({ type: 'trade', mint: base58(key(7)), isBuy: true, solAmount: 1.5, tokenAmount: 42_000_000, wallet: base58(key(8)), virtualSolReserves: 31.5, virtualTokenReserves: 1_020_000_000, realSolReserves: 1.5 });
  });

  it('ignores unknown events and truncated data', () => {
    expect(decodePumpFunEvent(Buffer.concat([Buffer.alloc(8, 9), key(1)]).toString('base64'))).toBeNull();
    expect(decodePumpFunEvent('AAA=')).toBeNull();
    expect(decodePumpFunEvent(Buffer.concat([disc('TradeEvent'), Buffer.alloc(5)]).toString('base64'))).toBeNull();
  });
});

describe('LaunchTracker', () => {
  it('deduplicates launches by mint', () => {
    const tracker = new LaunchTracker(10 * 60_000);
    expect(tracker.add(launch('MINT_A'))).toBe(true);
    expect(tracker.add(launch('MINT_A'))).toBe(false);
    expect(tracker.launches.size).toBe(1);
  });

  it('counts unique buyers by wallet (not transactions); creator sells do not prove sellability', () => {
    const tracker = new LaunchTracker(10 * 60_000);
    tracker.setSolPrice(150);
    tracker.add(launch('MINT_B'));
    for (let i = 0; i < 20; i += 1) tracker.onTrade(trade('MINT_B', 'WHALE', true, 0.1, 1_000_000));
    tracker.onTrade(trade('MINT_B', 'ALICE', true, 0.2, 2_000_000));
    tracker.onTrade(trade('MINT_B', 'BOB', true, 0.2, 2_000_000));
    tracker.onTrade(trade('MINT_B', 'CREATOR', true, 1, 10_000_000));
    tracker.onTrade(trade('MINT_B', 'CREATOR', false, 0.9, 8_000_000));
    tracker.observe(Date.now());
    const state = tracker.state('MINT_B', 50)!;
    const observation = state.observations.at(-1)!;
    expect(observation.buyCount).toBe(23);
    expect(observation.uniqueBuyers).toBe(4);
    expect(state.buysPerBuyer).toBeCloseTo(23 / 4, 5);
    expect(state.observedSellers).toBe(0);
    expect(state.creatorSoldRatio).toBeCloseTo(0.8, 5);
    tracker.onTrade(trade('MINT_B', 'ALICE', false, 0.1, 1_000_000));
    expect(tracker.state('MINT_B', 50)!.observedSellers).toBe(1);
    expect(observation.priceUsd).toBeCloseTo((32 / 1_000_000_000) * 150, 12);
    expect(state.priceImpactPercent).toBeGreaterThan(0);
  });

  it('pool sources without wallets keep unique buyers unknown and never split volume 50/50', () => {
    const tracker = new LaunchTracker(10 * 60_000);
    tracker.add(launch('POOL_C', { source: 'RAYDIUM' }));
    tracker.setExternal('POOL_C', { priceUsd: 0.01, liquidityUsd: 40_000, buyCount: 30, sellCount: 10, volumeUsd: 9_000, at: Date.now() });
    tracker.observe(Date.now());
    const observation = tracker.state('POOL_C', 50)!.observations.at(-1)!;
    expect(observation.uniqueBuyers).toBeNull();
    expect(observation.buyVolumeUsd).toBeNull();
    expect(observation.volumeUsd).toBe(9_000);
  });

  it('quote returns only real prices from the trade stream', () => {
    const tracker = new LaunchTracker(10 * 60_000);
    tracker.add(launch('MINT_D'));
    expect(tracker.quote('MINT_D')).toBeNull();
    tracker.setSolPrice(150);
    tracker.onTrade(trade('MINT_D', 'ALICE', true, 0.5, 5_000_000));
    const quote = tracker.quote('MINT_D')!;
    expect(quote.priceUsd).toBeCloseTo((32 / 1_000_000_000) * 150, 12);
    expect(quote.liquidityUsd).toBeCloseTo(2.5 * 150 * 2, 5);
  });
});
