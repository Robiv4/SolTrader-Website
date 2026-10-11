import type { Prisma } from '@prisma/client';

/**
 * Open PAPER positions protected by the cycle-based exit monitor. When the event-driven hot monitor owns the
 * NEW_LAUNCH positions they are left out here.
 *
 * `exitPolicy` is nullable (legacy / strategy positions have null). A plain `NOT: { exitPolicy: 'NEW_LAUNCH' }`
 * compiles to `NOT ("exitPolicy" = 'NEW_LAUNCH')`, which is NULL for those rows in SQL, so they silently lost
 * their SL / TP / trailing protection. The null case is therefore matched explicitly.
 */
export function cycleMonitoredPositionsWhere(hotMonitorOwnsNewLaunch: boolean): Prisma.PositionWhereInput {
  return {
    status: 'OPEN',
    mode: 'PAPER',
    ...(hotMonitorOwnsNewLaunch ? { OR: [{ exitPolicy: null }, { exitPolicy: { not: 'NEW_LAUNCH' } }] } : {}),
  };
}

/** Logs "no fresh price" at most once per token and interval (dead tokens would otherwise warn every cycle). */
export class ThrottledWarning {
  private readonly lastAt = new Map<string, number>();

  constructor(private readonly intervalMs: number) {}

  shouldLog(key: string, now: number) {
    const last = this.lastAt.get(key);
    if (last !== undefined && now - last < this.intervalMs) return false;
    this.lastAt.set(key, now);
    return true;
  }
}
