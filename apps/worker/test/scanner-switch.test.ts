/* eslint-disable @typescript-eslint/no-explicit-any -- minimal Prisma stubs */
import type { PrismaClient } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { PaperExecutionCoordinator } from '../src/paper-execution.js';
import { StrategyRunner } from '../src/strategy-runner.js';

const decimal = (value: number) => new Prisma.Decimal(value);
const signal = (id: string, tokenId: string, metadata: Record<string, unknown>) => ({
  id, userId: 'user-1', tokenId, strategyName: 'Momentum', score: decimal(90), riskScore: decimal(10), metadata,
  recommendedStop: null, recommendedTarget: null, createdAt: new Date(), reasons: [], token: { address: tokenId.toUpperCase(), symbol: tokenId },
});

describe('token scanner switch', () => {
  it('scanner off: Strategy / AI signals are not executed, NewLaunch and manual PAPER signals still are candidates', async () => {
    const prisma = {
      botConfig: { findMany: async () => [{ userId: 'user-1', tradingMode: 'PAPER', isScannerEnabled: false, maxPositionSize: null, maxDailyLoss: null, user: { riskConfigs: [] } }] },
      signal: { findMany: async () => [
        signal('s1', 'strategy-token', {}),
        signal('s2', 'ai-token', { decisionSource: 'AI' }),
        signal('s3', 'launch-token', { decisionSource: 'NEW_LAUNCH' }),
        signal('s4', 'manual-token', { executionSource: 'MANUAL_PAPER' }),
      ] },
    } as unknown as PrismaClient;
    const coordinator = new PaperExecutionCoordinator({
      prisma, provider: {} as any, publishEvent: async () => undefined, logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    });
    const considered: string[] = [];
    (coordinator as any).processUserCandidates = async (_user: unknown, candidates: Array<{ id: string }>) => { considered.push(...candidates.map((item) => item.id)); };
    (coordinator as any).processCandidate = async (candidate: { id: string }) => { considered.push(candidate.id); return 'SKIPPED'; };
    const summary = await coordinator.runCycle({ aborted: false }).catch(() => null);
    expect(summary?.users).toBe(1);
    expect(summary?.candidates).toBe(2);
  });

  it('scanner off for everyone: the strategy cycle does no work', async () => {
    let assessmentQueries = 0;
    const runner = new StrategyRunner({
      prisma: { botConfig: { findMany: async () => [] }, riskAssessment: { findMany: async () => { assessmentQueries += 1; return []; } } } as never,
      provider: {} as never,
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      registry: { setHealth: () => undefined } as never,
      lookbackMs: 60_000,
      historyWindow: 10,
      staleAfterMs: 120_000,
    } as never);
    const summary = await runner.runCycle({ aborted: false });
    expect(summary.candidates).toBe(0);
    expect(assessmentQueries).toBe(0);
  });
});
