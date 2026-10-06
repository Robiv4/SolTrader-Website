import { describe, expect, it } from 'vitest';

import { countsTowardsSkip, type TrackerRedis, UnbuyableTokenTracker } from '../src/unbuyable-tracker.js';

function fakeRedis() {
  const store = new Map<string, string>();
  const redis: TrackerRedis = {
    get: async (key) => store.get(key) ?? null,
    set: async (key, value) => { store.set(key, value); return 'OK'; },
    del: async (key) => { for (const item of Array.isArray(key) ? key : [key]) store.delete(item); return 1; },
    mGet: async (keys) => keys.map((key) => store.get(key) ?? null),
  };
  return { redis, store };
}

function setup(afterMinutes: number, forMinutes = 60) {
  let now = Date.parse('2026-09-27T12:00:00Z');
  const { redis, store } = fakeRedis();
  const prisma = { botConfig: { findUnique: async () => ({ skipUnbuyableAfterMinutes: afterMinutes, skipUnbuyableForMinutes: forMinutes }) } } as never;
  const tracker = new UnbuyableTokenTracker(redis, prisma, () => now);
  return { tracker, store, advance: (minutes: number) => { now += minutes * 60_000; } };
}

describe('unbuyable token tracker', () => {
  it('skips a token that stays blocked for the configured minutes', async () => {
    const { tracker, advance } = setup(5, 30);
    expect(await tracker.recordFailure('user', 'TOKEN', ['LIQUIDITY_BELOW_ABSOLUTE_MINIMUM'])).toBeNull();
    advance(3);
    expect(await tracker.recordFailure('user', 'TOKEN', ['LIQUIDITY_BELOW_ABSOLUTE_MINIMUM'])).toBeNull();
    expect(await tracker.isSkipped('user', 'TOKEN')).toBe(false);
    advance(2);
    const skip = await tracker.recordFailure('user', 'TOKEN', ['LIQUIDITY_BELOW_ABSOLUTE_MINIMUM']);
    expect(skip).not.toBeNull();
    expect(Date.parse(skip!.until) - Date.parse(skip!.since)).toBe(30 * 60_000);
    expect(await tracker.isSkipped('user', 'TOKEN')).toBe(true);
    expect([...await tracker.usersSkipping(['user', 'other'], 'TOKEN')]).toEqual(['user']);
  });

  it('never skips because of account-level limits', async () => {
    expect(countsTowardsSkip(['MAX_CONCURRENT_POSITIONS'])).toBe(false);
    expect(countsTowardsSkip(['POSITION_LIMIT_OR_CASH_EXHAUSTED', 'SLIPPAGE_LIMIT_EXCEEDED'])).toBe(true);
    const { tracker, advance } = setup(5);
    await tracker.recordFailure('user', 'TOKEN', ['MAX_CONCURRENT_POSITIONS']);
    advance(10);
    expect(await tracker.recordFailure('user', 'TOKEN', ['MAX_CONCURRENT_POSITIONS'])).toBeNull();
    expect(await tracker.isSkipped('user', 'TOKEN')).toBe(false);
  });

  it('resets the streak after a successful buy and when disabled never skips', async () => {
    const { tracker, advance } = setup(5);
    await tracker.recordFailure('user', 'TOKEN', ['SLIPPAGE_LIMIT_EXCEEDED']);
    advance(4);
    await tracker.recordSuccess('user', 'TOKEN');
    advance(2);
    expect(await tracker.recordFailure('user', 'TOKEN', ['SLIPPAGE_LIMIT_EXCEEDED'])).toBeNull();

    const disabled = setup(0);
    await disabled.tracker.recordFailure('user', 'TOKEN', ['HARD_BLOCKED']);
    disabled.advance(120);
    expect(await disabled.tracker.recordFailure('user', 'TOKEN', ['HARD_BLOCKED'])).toBeNull();
  });

  it('starts a new streak when failures stop for longer than the window', async () => {
    const { tracker, advance } = setup(5);
    await tracker.recordFailure('user', 'TOKEN', ['HARD_BLOCKED']);
    advance(30);
    // 30 minutes of silence breaks the streak, so this failure starts it again instead of skipping.
    expect(await tracker.recordFailure('user', 'TOKEN', ['HARD_BLOCKED'])).toBeNull();
    advance(5);
    expect(await tracker.recordFailure('user', 'TOKEN', ['HARD_BLOCKED'])).not.toBeNull();
  });
});
