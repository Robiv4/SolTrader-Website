/**
 * The single feature-snapshot builder for New Launch candidates, used by BOTH the SHADOW collection and the ML PAPER
 * decision: same inputs at the same moment -> identical features (train / serve consistency, no second code path).
 */
import {
  buildCommunityFeatureSnapshot, buildMlFeatureSnapshot, ML_COMMUNITY_FEATURE_VERSION, type CommunitySnapshotResult, type LaunchSecurity, type LaunchState, type MlFeatureSnapshotResult,
  type SocialSnapshotResult,
} from '@soltrader/strategy-engine';

/** Reference order for impact / state features. */
export const ML_REFERENCE_ORDER_USD = 20;

export interface LaunchSnapshotInput {
  at: number;
  launch: { source: string; detectedAt: number; createdAt: number | null; firstTradeAt: number | null };
  /** Tracker state at the reference order size (observations after `at` are cut by the builder). */
  state: LaunchState | null;
  security: { security: LaunchSecurity; completedAt: number | null } | null;
  riskScore: number | null;
  /** When the risk score was computed (the evaluation moment). */
  riskObservedAt: number | null;
  social: SocialSnapshotResult | null;
}

export function buildLaunchMlSnapshot(input: LaunchSnapshotInput): { snapshot: MlFeatureSnapshotResult; eligible: boolean } {
  const snapshot = buildMlFeatureSnapshot({
    snapshotAt: input.at, source: input.launch.source, detectedAt: input.launch.detectedAt, createdAt: input.launch.createdAt, firstTradeAt: input.launch.firstTradeAt,
    state: input.state, security: input.security?.security ?? null, securityObservedAt: input.security?.completedAt ?? null,
    riskScore: input.riskScore, riskObservedAt: input.riskObservedAt, social: input.social,
    referenceImpactPct: input.state?.priceImpactPercent ?? null,
  });
  // ML eligibility (separate from trading eligibility): a real price and at least two trades at the snapshot moment.
  const last = input.state?.observations.filter((observation) => observation.takenAt <= input.at).at(-1);
  const eligible = snapshot.referencePriceUsd !== null && (last?.buyCount ?? 0) + (last?.sellCount ?? 0) >= 2;
  return { snapshot, eligible };
}

/**
 * Same snapshot in the requested feature version: ML-FEATURES-v1 (unchanged builder) or ML-FEATURES-COMMUNITY-v1
 * (v1 + COMMUNITY group from a community snapshot computed at `at`; a later one is excluded by the builder).
 */
export function buildLaunchMlSnapshotFor(featureVersion: string, input: LaunchSnapshotInput & { community: CommunitySnapshotResult | null }): { snapshot: MlFeatureSnapshotResult; eligible: boolean } {
  const base = buildLaunchMlSnapshot(input);
  if (featureVersion !== ML_COMMUNITY_FEATURE_VERSION) return base;
  const snapshot = buildCommunityFeatureSnapshot({
    snapshotAt: input.at, source: input.launch.source, detectedAt: input.launch.detectedAt, createdAt: input.launch.createdAt, firstTradeAt: input.launch.firstTradeAt,
    state: input.state, security: input.security?.security ?? null, securityObservedAt: input.security?.completedAt ?? null,
    riskScore: input.riskScore, riskObservedAt: input.riskObservedAt, social: input.social,
    referenceImpactPct: input.state?.priceImpactPercent ?? null, community: input.community,
  });
  return { snapshot, eligible: base.eligible };
}
