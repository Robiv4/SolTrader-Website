import { prisma } from './database.js';

type Decimalish = { toNumber(): number } | number | string | null | undefined;
const num = (value: Decimalish) => {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === 'object' ? value.toNumber() : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/**
 * Launch facts of a freshly detected token (NewLaunch discovery): candidate, latest observation and the
 * user's latest decision. Many launches never get a `Token` row (they are only watched), so the token
 * detail page uses this as its data source for them. Returns null when the mint was never detected.
 */
export async function loadLaunchInfo(userId: string, mint: string) {
  const candidate = await prisma.launchCandidate.findUnique({
    where: { mint },
    include: {
      snapshots: { orderBy: { takenAt: 'desc' }, take: 1 },
      decisions: { where: { userId }, orderBy: { decisionAt: 'desc' }, take: 1 },
    },
  }).catch(() => null);
  if (!candidate) return null;
  const snapshot = candidate.snapshots[0] ?? null;
  const decision = candidate.decisions[0] ?? null;
  const start = candidate.createdAt ?? candidate.detectedAt;
  return {
    source: candidate.source,
    status: candidate.status,
    name: candidate.name,
    symbol: candidate.symbol,
    poolAddress: candidate.poolAddress,
    bondingCurve: candidate.bondingCurve,
    creator: candidate.creator,
    detectedAt: candidate.detectedAt,
    createdAt: candidate.createdAt,
    ageSeconds: Math.max(0, Math.round((Date.now() - start.getTime()) / 1000)),
    detectedPriceUsd: num(candidate.detectedPriceUsd),
    security: candidate.security ?? null,
    snapshot: snapshot ? {
      takenAt: snapshot.takenAt,
      priceUsd: num(snapshot.priceUsd),
      liquidityUsd: num(snapshot.liquidityUsd),
      volumeUsd: num(snapshot.volumeUsd),
      marketCapUsd: num(snapshot.marketCapUsd),
      buyCount: snapshot.buyCount,
      sellCount: snapshot.sellCount,
      uniqueBuyers: snapshot.uniqueBuyers,
      uniqueSellers: snapshot.uniqueSellers,
      largestBuyerShare: num(snapshot.largestBuyerShare),
      bondingProgress: num(snapshot.bondingProgress),
      dataQuality: snapshot.dataQuality,
    } : null,
    decision: decision ? {
      decision: decision.decision,
      status: decision.status,
      score: decision.score,
      launchMomentumScore: decision.launchMomentumScore,
      exhaustionScore: decision.exhaustionScore,
      liquidityScore: decision.liquidityScore,
      buyerQualityScore: decision.buyerQualityScore,
      buyPressureScore: decision.buyPressureScore,
      securityScore: decision.securityScore,
      dataQuality: decision.dataQuality,
      riskScore: num(decision.riskScore),
      riskClassification: decision.riskClassification,
      reasons: decision.reasons,
      warnings: decision.warnings,
      decisionAt: decision.decisionAt,
    } : null,
  };
}

export type LaunchInfo = NonNullable<Awaited<ReturnType<typeof loadLaunchInfo>>>;
