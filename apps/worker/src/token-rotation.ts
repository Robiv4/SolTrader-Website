/** Outcome of scanning one token, which decides when it is looked at again. */
export type RotationStatus = 'ACCEPT' | 'WATCH' | 'REJECTED' | 'BLOCKED' | 'NO_DATA' | 'SKIPPED';

/** How long a token rests after each outcome before it is scanned again. */
export const RESCAN_AFTER_MS: Record<RotationStatus, number> = {
  // Interesting tokens are refreshed continuously so the strategies get a steady snapshot history.
  ACCEPT: 30_000,
  WATCH: 30_000,
  NO_DATA: 5 * 60_000,
  REJECTED: 10 * 60_000,
  SKIPPED: 15 * 60_000,
  BLOCKED: 20 * 60_000,
};

/** A token that has not appeared in any discovery feed for this long leaves the pool (unless it is active). */
export const POOL_ENTRY_TTL_MS = 2 * 60 * 60_000;

interface PoolEntry {
  address: string;
  firstSeenAt: number;
  lastSeenAt: number;
  lastScannedAt: number | null;
  nextScanAt: number;
  status: RotationStatus | null;
}

const isActive = (entry: PoolEntry) => entry.status === 'ACCEPT' || entry.status === 'WATCH';

/**
 * Rotating candidate pool of the token scanner. Discovery feeds keep adding tokens; every cycle the scanner
 * takes the tokens that are due: active (ACCEPT/WATCH) ones are refreshed every 30 s, new ones are scanned as
 * soon as possible, and rejected/blocked ones rest for a while so their slot goes to other tokens. The pool is
 * capped by the users' "monitored tokens" setting; when it is full, inactive tokens make room for new ones.
 */
export class TokenRotation {
  private readonly pool = new Map<string, PoolEntry>();

  get size() {
    return this.pool.size;
  }

  /** Adds (or refreshes) discovered tokens and applies the capacity, evicting inactive tokens first. */
  addDiscovered(addresses: string[], capacity: number, now = Date.now()) {
    for (const address of addresses) {
      const existing = this.pool.get(address);
      if (existing) existing.lastSeenAt = now;
    }
    for (const [address, entry] of this.pool) {
      if (!isActive(entry) && now - entry.lastSeenAt > POOL_ENTRY_TTL_MS) this.pool.delete(address);
    }
    for (const address of addresses) {
      if (this.pool.has(address)) continue;
      if (this.pool.size >= capacity && !this.evictOne()) break;
      this.pool.set(address, { address, firstSeenAt: now, lastSeenAt: now, lastScannedAt: null, nextScanAt: now, status: null });
    }
    while (this.pool.size > capacity && this.evictOne()) { /* shrink after a lower capacity */ }
  }

  /** Keeps tokens the risk engine still accepts/watches in rotation (e.g. after a worker restart). */
  seedActive(addresses: string[], now = Date.now()) {
    for (const address of addresses) {
      if (this.pool.has(address)) continue;
      this.pool.set(address, { address, firstSeenAt: now, lastSeenAt: now, lastScannedAt: null, nextScanAt: now, status: 'WATCH' });
    }
  }

  /**
   * Tokens due for a scan, most useful first: never-scanned tokens (newest discovery first), then active tokens,
   * then everything else by how long it has waited.
   */
  due(limit: number, now = Date.now()) {
    const rank = (entry: PoolEntry) => (entry.lastScannedAt === null ? 0 : isActive(entry) ? 1 : 2);
    return [...this.pool.values()]
      .filter((entry) => entry.nextScanAt <= now)
      .sort((a, b) => rank(a) - rank(b)
        || (rank(a) === 0 ? b.firstSeenAt - a.firstSeenAt : (a.lastScannedAt ?? 0) - (b.lastScannedAt ?? 0))
        || a.address.localeCompare(b.address))
      .slice(0, Math.max(0, limit))
      .map((entry) => entry.address);
  }

  record(address: string, status: RotationStatus, now = Date.now()) {
    const entry = this.pool.get(address);
    if (!entry) return;
    entry.status = status;
    entry.lastScannedAt = now;
    entry.nextScanAt = now + RESCAN_AFTER_MS[status];
  }

  stats() {
    const counts: Record<string, number> = { total: this.pool.size, active: 0, resting: 0, new: 0 };
    const now = Date.now();
    for (const entry of this.pool.values()) {
      if (entry.lastScannedAt === null) counts.new += 1;
      else if (isActive(entry)) counts.active += 1;
      else if (entry.nextScanAt > now) counts.resting += 1;
    }
    return counts;
  }

  /** Removes the least useful inactive entry: the one gone longest from the feeds. Active tokens are kept. */
  private evictOne() {
    let victim: PoolEntry | null = null;
    for (const entry of this.pool.values()) {
      if (isActive(entry) || entry.lastScannedAt === null) continue;
      if (!victim || entry.lastSeenAt < victim.lastSeenAt) victim = entry;
    }
    if (!victim) return false;
    this.pool.delete(victim.address);
    return true;
  }
}
