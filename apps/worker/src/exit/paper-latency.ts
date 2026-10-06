/**
 * Simulated PAPER execution latency between the exit decision and the fill.
 *
 * NONE (default) keeps the previous behaviour: the fill is computed right after the trigger from the triggering
 * observation. The other modes wait before filling, and the fill uses the market state at that later moment
 * (never a price received after it).
 *
 * EMPIRICAL samples from a measured distribution (P50 / P75 / P95, e.g. from future LIVE measurements); with no
 * percentiles configured it behaves like NONE and reports itself as unconfigured instead of inventing values.
 */
export type PaperLatencyMode = 'NONE' | 'FIXED' | 'RANGE' | 'EMPIRICAL';

export interface PaperLatencyConfig {
  mode: PaperLatencyMode;
  fixedMs?: number | null;
  minMs?: number | null;
  maxMs?: number | null;
  p50Ms?: number | null;
  p75Ms?: number | null;
  p95Ms?: number | null;
}

export const DEFAULT_PAPER_LATENCY: PaperLatencyConfig = { mode: 'NONE' };

const clean = (value: number | null | undefined) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null);

/** True when the configuration can produce a latency (EMPIRICAL needs at least P50 and P95). */
export function paperLatencyConfigured(config: PaperLatencyConfig) {
  if (config.mode === 'FIXED') return clean(config.fixedMs) !== null;
  if (config.mode === 'RANGE') return clean(config.minMs) !== null && clean(config.maxMs) !== null;
  if (config.mode === 'EMPIRICAL') return clean(config.p50Ms) !== null && clean(config.p95Ms) !== null;
  return false;
}

/** One latency sample in milliseconds (0 for NONE or an unusable configuration). */
export function samplePaperLatencyMs(config: PaperLatencyConfig, random: () => number = Math.random): number {
  if (!paperLatencyConfigured(config)) return 0;
  if (config.mode === 'FIXED') return clean(config.fixedMs)!;
  if (config.mode === 'RANGE') {
    const min = clean(config.minMs)!;
    const max = Math.max(min, clean(config.maxMs)!);
    return min + (max - min) * random();
  }
  // EMPIRICAL: piecewise-linear inverse CDF through the measured percentiles.
  const p50 = clean(config.p50Ms)!;
  const p95 = Math.max(p50, clean(config.p95Ms)!);
  const p75 = Math.min(p95, Math.max(p50, clean(config.p75Ms) ?? (p50 + p95) / 2));
  const min = Math.min(p50, clean(config.minMs) ?? p50 / 2);
  const max = Math.max(p95, clean(config.maxMs) ?? p95 * 1.25);
  const points: Array<[number, number]> = [[0, min], [0.5, p50], [0.75, p75], [0.95, p95], [1, max]];
  const u = Math.min(1, Math.max(0, random()));
  for (let index = 1; index < points.length; index += 1) {
    const [q1, v1] = points[index];
    const [q0, v0] = points[index - 1];
    if (u <= q1) return v0 + (v1 - v0) * (q1 === q0 ? 0 : (u - q0) / (q1 - q0));
  }
  return max;
}
