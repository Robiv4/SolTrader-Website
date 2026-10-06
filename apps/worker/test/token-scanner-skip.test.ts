import { describe, expect, it } from 'vitest';

import { TokenScanner } from '../src/token-scanner.js';
import type { UnbuyableTokenTracker } from '../src/unbuyable-tracker.js';

describe('token scanner skipping', () => {
  it('replaces skipped tokens with the next discovered ones', async () => {
    const discovered = ['A', 'B', 'C', 'D', 'E', 'F'].map((address) => ({ address, chainId: 'solana', discoveredAt: new Date(), source: 'test' }));
    let requestedLimit = 0;
    const prisma = {
      botConfig: { findMany: async () => [{ userId: 'user', minLiquidityUsd: null, minVolumeUsd: null, maxTokenAgeHours: 168, maxMonitoredTokens: 50, user: { riskConfigs: [] } }] },
      riskAssessment: { findMany: async () => [] },
    };
    const tracker = {
      usersSkipping: async (_userIds: string[], address: string) => new Set(address === 'A' || address === 'B' ? ['user'] : []),
    } as unknown as UnbuyableTokenTracker;
    const scanner = new TokenScanner({
      prisma: prisma as never,
      provider: { discoverTokens: async (limit: number) => { requestedLimit = limit; return discovered; } } as never,
      cache: {} as never,
      repository: {} as never,
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      registry: { setHealth: () => undefined } as never,
      cacheTtlSeconds: 30,
      staleAfterMs: 120_000,
      discoveryLimit: 3,
      tracker,
    });
    const evaluated: string[] = [];
    (scanner as unknown as { processCandidate: (address: string) => Promise<string> }).processCandidate = async (address) => { evaluated.push(address); return 'REJECTED'; };

    const summary = await scanner.runCycle(new globalThis.AbortController().signal);

    expect(requestedLimit).toBe(300);
    expect(evaluated).toEqual(['C', 'D', 'E']);
    expect(summary.skipped).toBe(2);
  });

  it('makes no discovery request at all when nobody has the token scanner on', async () => {
    let discoveryCalls = 0;
    const scanner = new TokenScanner({
      prisma: { botConfig: { findMany: async () => [] }, riskAssessment: { findMany: async () => [] } } as never,
      provider: { discoverTokens: async () => { discoveryCalls += 1; return []; } } as never,
      cache: {} as never,
      repository: {} as never,
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      registry: { setHealth: () => undefined } as never,
      cacheTtlSeconds: 30,
      staleAfterMs: 120_000,
      discoveryLimit: 3,
      tracker: { usersSkipping: async () => new Set() } as never,
    });
    const summary = await scanner.runCycle(new globalThis.AbortController().signal);
    expect(discoveryCalls).toBe(0);
    expect(summary.discovered).toBe(0);
  });
});
