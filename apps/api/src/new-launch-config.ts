import { Prisma } from '@prisma/client';
import { newLaunchCapacityConfig, newLaunchEntryConfig, newLaunchExitConfig, normalizeQualityGate, resolveNewLaunchSettings, type QualityGateSettings, type ResolvedNewLaunchSettings } from '@soltrader/strategy-engine';

import { prisma } from './database.js';

/** Integer columns of NewLaunchConfig (everything else numeric is DECIMAL). */
const INT_KEYS = new Set(['minExitCapacityScore', 'minAgeSeconds', 'maxAgeSeconds', 'observationSeconds', 'cooldownSeconds', 'minTransactions', 'minUniqueBuyers', 'minScore', 'maxExhaustionScore', 'maxRiskScore', 'maxConcurrentPositions', 'minObservedSellers', 'maxHoldMinutes', 'minimumRecommendationSampleSize']);

export async function loadNewLaunchSettings(userId: string): Promise<{ row: Awaited<ReturnType<typeof prisma.newLaunchConfig.findUnique>>; settings: ResolvedNewLaunchSettings }> {
  const row = await prisma.newLaunchConfig.findUnique({ where: { userId } });
  return { row, settings: resolveNewLaunchSettings(row as unknown as Record<string, unknown> | null) };
}

function versionPayload(settings: ResolvedNewLaunchSettings) {
  return {
    entryConfig: { ...newLaunchEntryConfig(settings), capacity: newLaunchCapacityConfig(settings) } as unknown as Prisma.InputJsonValue,
    exitConfig: { ...newLaunchExitConfig(settings), tieredTakeProfitLevels: settings.tieredTakeProfitLevels } as unknown as Prisma.InputJsonValue,
    qualityGate: settings.qualityGate as unknown as Prisma.InputJsonValue,
  };
}

/** Fingerprint of everything that defines a configuration version (not the on/off switch or UI-only values). */
function fingerprint(settings: ResolvedNewLaunchSettings) {
  const { qualityGate, ...rest } = { ...newLaunchEntryConfig(settings), ...newLaunchExitConfig(settings), levels: settings.tieredTakeProfitLevels, qualityGate: { ...settings.qualityGate, version: 0 } };
  // Exit capacity only defines a configuration when it is enforced (MONITOR_ONLY never changes a trade).
  const capacity = settings.exitCapacityMode === 'ENFORCE_PAPER' && settings.dynamicPositionSizingEnabled ? newLaunchCapacityConfig(settings) : null;
  // Social signals only define a configuration when they can change decisions (e.g. a new NL-vN-SOCIAL experiment).
  const social = settings.socialIntelligenceEnabled && settings.socialDecisionMode === 'ENFORCE_PAPER' ? { socialDecisionMode: settings.socialDecisionMode } : null;
  return JSON.stringify({ rest, qualityGate, capacity, social });
}

function gateThresholdsChanged(previous: QualityGateSettings, next: QualityGateSettings) {
  const strip = (gate: QualityGateSettings) => JSON.stringify({ ...gate, mode: '', version: 0 });
  return strip(previous) !== strip(next);
}

/**
 * Applies a settings patch. When anything that defines a configuration changes, a NEW immutable version
 * (NL-vN, parent = previous) is created and becomes active. Existing positions keep their snapshotted
 * configuration; historic versions are never rewritten.
 */
export async function applyNewLaunchSettingsChange(userId: string, patch: Record<string, unknown>, meta: { createdFromRecommendationId?: string; note?: string } = {}) {
  const { row, settings: previous } = await loadNewLaunchSettings(userId);
  const data: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || key === 'qualityGate' || key === 'tieredTakeProfitLevels') continue;
    data[key] = typeof value === 'number' && !INT_KEYS.has(key) ? new Prisma.Decimal(value) : value;
  }
  let nextGate = previous.qualityGate;
  if (patch.qualityGate && typeof patch.qualityGate === 'object') {
    nextGate = normalizeQualityGate({ ...previous.qualityGate, ...(patch.qualityGate as Record<string, unknown>) });
    if (gateThresholdsChanged(previous.qualityGate, nextGate)) nextGate = { ...nextGate, version: previous.qualityGate.version + 1 };
    data.qualityGate = nextGate as unknown as Prisma.InputJsonValue;
  }
  if (Array.isArray(patch.tieredTakeProfitLevels)) data.tieredTakeProfitLevels = patch.tieredTakeProfitLevels as Prisma.InputJsonValue;

  const next = resolveNewLaunchSettings({ ...(row as unknown as Record<string, unknown> ?? {}), ...Object.fromEntries(Object.entries(data).map(([key, value]) => [key, value instanceof Prisma.Decimal ? value.toNumber() : value])), configVersion: previous.configVersion });
  const changed = fingerprint(previous) !== fingerprint(next);

  return prisma.$transaction(async (transaction) => {
    const versions = await transaction.newLaunchConfigVersion.findMany({ where: { userId }, select: { versionNumber: true, version: true }, orderBy: { versionNumber: 'desc' }, take: 1 });
    // The configuration in force so far is recorded as the first version before anything changes.
    if (!versions.length) {
      await transaction.newLaunchConfigVersion.create({ data: { userId, version: previous.configVersion, versionNumber: Number(previous.configVersion.replace(/\D/g, '')) || 1, ...versionPayload(previous), note: 'Kezdeti konfiguráció' } });
    }
    let configVersion = previous.configVersion;
    if (changed) {
      const latestNumber = Math.max(versions[0]?.versionNumber ?? 0, Number(previous.configVersion.replace(/\D/g, '')) || 1);
      configVersion = `NL-v${latestNumber + 1}`;
      await transaction.newLaunchConfigVersion.create({ data: { userId, version: configVersion, versionNumber: latestNumber + 1, ...versionPayload({ ...next, configVersion }), parentVersion: previous.configVersion, createdFromRecommendationId: meta.createdFromRecommendationId ?? null, note: meta.note ?? null } });
    }
    await transaction.newLaunchConfig.upsert({ where: { userId }, update: { ...data, configVersion }, create: { userId, ...data, configVersion } });
    return { changed, configVersion, previousVersion: previous.configVersion };
  });
}
