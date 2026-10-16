/**
 * The liquidity comparison query against the development database (throw-away rows only): the decision-time liquidity
 * comes from the newest launch snapshot at or before the decision (a later snapshot is ignored: no look-ahead), and the
 * SHADOW outcome is joined through the decision's feature snapshot.
 */
import { randomUUID } from 'node:crypto';

import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, describe, expect, it } from 'vitest';

import { loadLiquidityAnalysisRows } from '../src/ml-liquidity-analysis.js';

const prisma = new PrismaClient();
const run = randomUUID().slice(0, 8);
const ids = { user: '', candidate: '' };

afterAll(async () => {
  await prisma.mlPaperDecision.deleteMany({ where: { userId: ids.user } });
  if (ids.candidate) await prisma.launchCandidate.delete({ where: { id: ids.candidate } }).catch(() => undefined);
  if (ids.user) await prisma.user.delete({ where: { id: ids.user } });
  await prisma.$disconnect();
});

describe('loadLiquidityAnalysisRows', () => {
  it('uses the last snapshot before the decision and joins the SHADOW outcome', async () => {
    const decidedAt = new Date(Date.now() - 60_000);
    const user = await prisma.user.create({ data: { email: `liq-analysis-${run}@soltrader.test` } });
    ids.user = user.id;
    const mint = `LIQ${run}${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    const candidate = await prisma.launchCandidate.create({ data: { mint, source: 'PUMP_FUN', detectedAt: new Date(decidedAt.getTime() - 30_000) } });
    ids.candidate = candidate.id;
    await prisma.launchSnapshot.createMany({ data: [
      { candidateId: candidate.id, takenAt: new Date(decidedAt.getTime() - 6_000), liquidityUsd: new Prisma.Decimal(4_200), dataQuality: 80 },
      // After the decision: must never be used (look-ahead).
      { candidateId: candidate.id, takenAt: new Date(decidedAt.getTime() + 6_000), liquidityUsd: new Prisma.Decimal(90_000), dataQuality: 80 },
    ] });
    const snapshot = await prisma.mlFeatureSnapshot.create({ data: {
      candidateId: candidate.id, mint, source: 'PUMP_FUN', kind: 'AGE_30S', snapshotAt: decidedAt, detectedAt: candidate.detectedAt, featureVersion: 'ML-FEATURES-v1',
      features: {}, observedAt: {}, dataQuality: 80, validForTraining: true, invalidReasons: [], decision: 'WATCH', decisionContext: {},
    } });
    await prisma.mlCandidateOutcome.create({ data: {
      snapshotId: snapshot.id, mint, labelVersion: 'ML-LABELS-v1', status: 'COMPLETE', entryPriceUsd: new Prisma.Decimal(0.00001), path: {}, validHorizons: {},
      result: { pathLabels: { plus20BeforeMinus10: true }, horizons: { 1800: { returnPct: 31.5 } } },
    } });
    await prisma.mlPaperDecision.create({ data: {
      userId: user.id, candidateId: candidate.id, mint, modelVersion: 'TEST', featureVersion: 'ML-FEATURES-v1', snapshotKind: 'AGE_30S', snapshotAt: decidedAt, detectedAt: candidate.detectedAt,
      features: {}, featureHash: 'x', dataQuality: 80, probability: new Prisma.Decimal(0.8), threshold: new Prisma.Decimal(0.3), mlDecision: 'ML_BUY', outcome: 'EXPIRED', decidedAt,
      safetyBlockers: ['LIQUIDITY_BELOW_MINIMUM'],
    } });
    const rows = await loadLiquidityAnalysisRows(prisma, user.id, new Date(decidedAt.getTime() - 3_600_000));
    expect(rows).toEqual([{ liquidityUsd: 4_200, liquiditySource: 'SNAPSHOT', blockers: ['LIQUIDITY_BELOW_MINIMUM'], outcome: 'EXPIRED', label: true, return30mPct: 31.5 }]);
  });
});
