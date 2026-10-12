/**
 * Source loading for `pnpm ml:dataset` that scales to many thousands of snapshots / mints.
 *
 * PostgreSQL allows at most 32 767 bind parameters per prepared statement, so every `IN (...)` list is split into
 * batches. The PAPER trade provenance (realised net P&L of a candidate a strategy actually bought) is matched with a
 * per-mint index instead of scanning all trades for every snapshot. The matching rule is unchanged:
 * the earliest CLOSED NEW_LAUNCH trade of the mint whose entry is at most 60 s before the snapshot (or later).
 */

/** Maximum mints per `tokenAddress IN (...)` query (far below the 32 767 bind-parameter limit). */
export const TRADE_MINT_BATCH_SIZE = 1_000;
/** A trade opened up to this long before the snapshot still belongs to it (unchanged matching window). */
export const PAPER_TRADE_ENTRY_TOLERANCE_MS = 60_000;

export interface PaperTradeRow {
  tokenAddress: string;
  netPnl: { toString(): string } | number | null;
  entryAt: Date | null;
  exitAt: Date | null;
  entryStrategy: string | null;
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (!(size > 0)) throw new Error('chunk size must be positive');
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
  return out;
}

/** Trades of the given mints, queried in batches of at most `batchSize` mints (sequentially: one connection). */
export async function loadPaperTradesInBatches<T extends PaperTradeRow>(mints: readonly string[], fetchBatch: (batch: string[]) => Promise<T[]>, batchSize = TRADE_MINT_BATCH_SIZE): Promise<T[]> {
  const unique = [...new Set(mints)];
  const out: T[] = [];
  for (const batch of chunk(unique, batchSize)) out.push(...await fetchBatch(batch));
  return out;
}

export type PaperTradeIndex<T extends PaperTradeRow> = Map<string, Array<T & { entryAt: Date }>>;

/**
 * mint -> trades with an entry time, ascending by entry time. The sort is stable, so trades with equal entry times keep
 * the database order exactly like the previous `filter().sort()[0]`.
 */
export function indexPaperTrades<T extends PaperTradeRow>(trades: readonly T[]): PaperTradeIndex<T> {
  const index: PaperTradeIndex<T> = new Map();
  for (const trade of trades) {
    if (!trade.entryAt) continue;
    const list = index.get(trade.tokenAddress);
    if (list) list.push(trade as T & { entryAt: Date });
    else index.set(trade.tokenAddress, [trade as T & { entryAt: Date }]);
  }
  for (const list of index.values()) list.sort((a, b) => a.entryAt.getTime() - b.entryAt.getTime());
  return index;
}

/** Earliest trade of the mint with entryAt >= snapshotAt - 60 s (binary search on the sorted list), or undefined. */
export function matchPaperTrade<T extends PaperTradeRow>(index: PaperTradeIndex<T>, mint: string, snapshotAtMs: number): (T & { entryAt: Date }) | undefined {
  const list = index.get(mint);
  if (!list?.length) return undefined;
  const threshold = snapshotAtMs - PAPER_TRADE_ENTRY_TOLERANCE_MS;
  let low = 0;
  let high = list.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (list[middle].entryAt.getTime() >= threshold) high = middle;
    else low = middle + 1;
  }
  return list[low];
}

/** Dataset provenance fields of a matched trade (null when the candidate was not bought / the trade is not closed). */
export function paperProvenance(trade: PaperTradeRow | undefined) {
  return {
    paperNetPnl: trade?.netPnl !== undefined && trade.netPnl !== null ? Number(trade.netPnl) : null,
    paperExitAt: trade?.exitAt ? trade.exitAt.getTime() : null,
    paperEntryStrategy: trade ? trade.entryStrategy ?? 'DEFAULT' : null,
  };
}

/**
 * Loads all rows of an ordered query page by page (keyset pagination on the unique `id`, after the caller's ordering),
 * so related-record includes never exceed the bind-parameter limit and memory stays predictable.
 */
export async function loadAllPages<T extends { id: string }>(fetchPage: (cursor: string | null, take: number) => Promise<T[]>, pageSize = 5_000): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | null = null;
  for (;;) {
    const page = await fetchPage(cursor, pageSize);
    out.push(...page);
    if (page.length < pageSize) return out;
    cursor = page[page.length - 1].id;
  }
}
