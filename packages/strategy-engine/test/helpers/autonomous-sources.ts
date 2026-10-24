/**
 * Deterministic SYNTHETIC Autonomous ML dataset sources (tests / memory stress only; no performance meaning).
 * Covers the row paths of the builder: valid replay sources with full 60-minute outcome paths (1 s points, the real
 * bucket layout), invalid snapshots, start mismatches, invalid / short paths, live ENTRY / POSITION rows with and
 * without paths / positions, market regimes and equal timestamps (row id tie-break).
 */
import { buildCommunityFeatureSnapshot, newOutcomePath, recordPathPoint, type LaunchSecurity, type LiveSource, type OutcomePathState, type ReplaySource } from '../../src/index.js';

const security: LaunchSecurity = { sellability: 'VERIFIED', mintAuthorityRevoked: true, freezeAuthorityRevoked: true, tokenProgram: 'spl-token', extensions: [], hardBlockReasons: [], warnings: [] };
export const SYNTHETIC_T0 = Date.parse('2026-09-01T00:00:00Z');

function rng(seed: number) {
  let state = seed % 2147483647 || 1;
  return () => (state = (state * 16807) % 2147483647) / 2147483647;
}

export function syntheticPath(at: number, seed: number, options: { seconds?: number; stepSeconds?: number; end?: boolean } = {}): OutcomePathState {
  const random = rng(seed + 17);
  const up = random() < 0.5;
  const path = newOutcomePath(at, 0.00001, 30_000);
  const seconds = options.seconds ?? 3_600;
  const step = options.stepSeconds ?? 1;
  let price = 0.00001;
  for (let s = step; s < seconds; s += step) {
    price *= 1 + (up ? 0.0004 : -0.0004) + (random() - 0.5) * 0.004;
    recordPathPoint(path, at + s * 1_000, price, 30_000 * (0.8 + random() * 0.4));
  }
  if (options.end !== false) {
    path.endedAt = at + seconds * 1_000 + 1;
    path.endReason = 'HORIZON_REACHED';
  }
  return path;
}

export function syntheticSnapshot(id: string, mint: string, at: number, seed: number) {
  const random = rng(seed);
  const good = random() < 0.5;
  const observations = Array.from({ length: 10 }, (_, i) => ({
    takenAt: at - 27_000 + i * 3_000, priceUsd: 0.00001 * (1 + (good ? 0.01 : -0.003) * i), liquidityUsd: 30_000, buyCount: good ? 20 + 9 * i : 4 + i, sellCount: 2 + i,
    volumeUsd: 100 + 50 * i * random(), buyVolumeUsd: 80 + 30 * i, sellVolumeUsd: 20 + 10 * i, uniqueBuyers: good ? 8 + 3 * i : 2 + (i > 5 ? 1 : 0), uniqueSellers: 1 + i,
  }));
  const snapshot = buildCommunityFeatureSnapshot({
    snapshotAt: at, source: 'PUMP_FUN', detectedAt: at - 30_000, createdAt: at - 31_000, firstTradeAt: at - 29_000,
    state: { mint, detectedAt: at - 30_000, createdAt: at - 31_000, observations, largestBuyerShare: good ? 0.08 : 0.4, buysPerBuyer: good ? 1.3 : 2.5, creatorSoldRatio: good ? 0 : 0.2, largestHolderSupplyShare: 0.04, priceImpactPercent: 1, observedSellers: 3 },
    security, securityObservedAt: at - 5_000, riskScore: 40, riskObservedAt: at, social: null, referenceImpactPct: 1, community: null,
  });
  return { ...snapshot, id };
}

/** Replay source i (every 13th invalid / mismatched / broken, some short paths -> exclusions). */
export function syntheticReplaySource(i: number, options: { stepSeconds?: number } = {}): ReplaySource {
  const at = SYNTHETIC_T0 + i * 45_000;
  const mint = `SYN${Math.floor(i / 2)}`; // two sources per mint: group_id shared across sources (and across pages)
  const snapshot = syntheticSnapshot(`snap-${String(i).padStart(7, '0')}`, mint, at, i + 1);
  if (i % 13 === 5) return { snapshot: { ...snapshot, validForTraining: false }, mint, path: syntheticPath(at, i, { ...options, seconds: 60 }) };
  if (i % 13 === 7) return { snapshot, mint, path: syntheticPath(at + 1_000, i, { ...options, seconds: 60 }) };
  if (i % 13 === 9) return { snapshot, mint, path: {} as OutcomePathState };
  return { snapshot, mint, path: syntheticPath(at, i, { ...options, seconds: i % 13 === 11 ? 700 : 3_600 }) };
}

/** Live source i (ENTRY / POSITION, regimes, ties on `at`, missing paths / positions). */
export function syntheticLiveSource(i: number, replayPath: (mint: string, at: number) => OutcomePathState | null): LiveSource {
  const at = SYNTHETIC_T0 + Math.floor(i / 2) * 30_000 + 5_000; // pairs share a timestamp -> row id tie-break
  const mint = `SYN${i % 40}`;
  const kind = i % 3 === 0 ? 'POSITION' : 'ENTRY';
  const regimes = ['HOT', 'NORMAL', 'COLD', null];
  return {
    id: `live-${String(i).padStart(7, '0')}`, kind, mint, at, validForTraining: i % 17 !== 3,
    features: { decisionKind: kind, marketRegime: regimes[i % 4], ret1mPct: (i % 7) - 3, uniqueBuyers: i % 11, holdSeconds: kind === 'POSITION' ? 30 + (i % 5) * 10 : null, source: 'PUMP_FUN', note: i % 19 === 0 ? 'with, "quote"\nline' : null },
    path: i % 23 === 4 ? null : replayPath(mint, at),
    position: kind === 'POSITION' ? (i % 9 === 0 ? null : { quantity: 1_000 + i, entryFillPrice: 0.00001 }) : undefined,
  };
}
