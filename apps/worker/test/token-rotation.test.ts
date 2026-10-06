import { describe, expect, it } from 'vitest';

import { POOL_ENTRY_TTL_MS, RESCAN_AFTER_MS, TokenRotation } from '../src/token-rotation.js';
import { TokenScanner } from '../src/token-scanner.js';

const T0 = 1_000_000;

describe('token rotation', () => {
  it('scans new tokens first, then refreshes active ones; rejected tokens rest', () => {
    const rotation = new TokenRotation();
    rotation.addDiscovered(['A', 'B', 'C'], 50, T0);
    expect(rotation.due(10, T0)).toEqual(['A', 'B', 'C']);
    rotation.record('A', 'ACCEPT', T0);
    rotation.record('B', 'REJECTED', T0);
    rotation.record('C', 'WATCH', T0);
    rotation.addDiscovered(['D'], 50, T0 + 1_000);
    // D is new -> first; nothing else is due yet.
    expect(rotation.due(10, T0 + 1_000)).toEqual(['D']);
    // After 30 s the active tokens come back, the rejected one keeps resting.
    expect(rotation.due(10, T0 + RESCAN_AFTER_MS.ACCEPT)).toEqual(['D', 'A', 'C']);
    expect(rotation.due(10, T0 + RESCAN_AFTER_MS.REJECTED)).toContain('B');
  });

  it('newer discoveries are scanned before older unscanned ones', () => {
    const rotation = new TokenRotation();
    rotation.addDiscovered(['OLD'], 50, T0);
    rotation.addDiscovered(['NEW'], 50, T0 + 5_000);
    expect(rotation.due(1, T0 + 5_000)).toEqual(['NEW']);
  });

  it('respects the capacity: inactive tokens make room for new ones, active tokens are kept', () => {
    const rotation = new TokenRotation();
    rotation.addDiscovered(['A', 'B', 'C'], 3, T0);
    rotation.record('A', 'ACCEPT', T0);
    rotation.record('B', 'REJECTED', T0);
    rotation.record('C', 'BLOCKED', T0);
    rotation.addDiscovered(['D', 'E'], 3, T0 + 1_000);
    expect(rotation.size).toBe(3);
    const due = rotation.due(10, T0 + 1_000);
    expect(due).toEqual(['D', 'E']);
    expect(rotation.due(10, T0 + RESCAN_AFTER_MS.ACCEPT)).toContain('A');
  });

  it('shrinks when the capacity setting is lowered and drops tokens gone from the feeds', () => {
    const rotation = new TokenRotation();
    rotation.addDiscovered(['A', 'B', 'C', 'D'], 10, T0);
    for (const address of ['A', 'B', 'C', 'D']) rotation.record(address, 'REJECTED', T0);
    rotation.addDiscovered([], 2, T0 + 1);
    expect(rotation.size).toBe(2);
    rotation.addDiscovered([], 10, T0 + POOL_ENTRY_TTL_MS + 1);
    expect(rotation.size).toBe(0);
  });
});

describe('token scanner keeps rotating', () => {
  it('scans different tokens in consecutive cycles instead of the same list', async () => {
    const feed = Array.from({ length: 12 }, (_, index) => ({ address: `T${String(index).padStart(2, '0')}`, chainId: 'solana', discoveredAt: new Date(), source: 'test' }));
    const scanner = new TokenScanner({
      prisma: {
        botConfig: { findMany: async () => [{ userId: 'user', minLiquidityUsd: null, minVolumeUsd: null, maxTokenAgeHours: 168, maxMonitoredTokens: 100, user: { riskConfigs: [] } }] },
        riskAssessment: { findMany: async () => [] },
      } as never,
      provider: { discoverTokens: async () => feed } as never,
      cache: {} as never,
      repository: {} as never,
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      registry: { setHealth: () => undefined } as never,
      cacheTtlSeconds: 30,
      staleAfterMs: 120_000,
      discoveryLimit: 4,
    });
    const scanned: string[][] = [];
    let current: string[] = [];
    (scanner as unknown as { processCandidate: (address: string) => Promise<string> }).processCandidate = async (address) => { current.push(address); return 'REJECTED'; };
    for (let cycle = 0; cycle < 3; cycle += 1) {
      current = [];
      await scanner.runCycle(new globalThis.AbortController().signal);
      scanned.push(current);
    }
    expect(scanned.map((cycle) => cycle.length)).toEqual([4, 4, 4]);
    expect(new Set(scanned.flat()).size).toBe(12);
  });
});
