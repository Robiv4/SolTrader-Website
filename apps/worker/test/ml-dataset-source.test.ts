import { buildMlDataset, ML_FEATURE_VERSION, ML_LABEL_VERSION, type MlDatasetSourceRow, type MlFeatures } from '@soltrader/strategy-engine';
import { describe, expect, it } from 'vitest';

import {
  chunk, indexPaperTrades, loadAllPages, loadPaperTradesInBatches, matchPaperTrade, paperProvenance, PAPER_TRADE_ENTRY_TOLERANCE_MS,
  TRADE_MINT_BATCH_SIZE, type PaperTradeRow,
} from '../src/ml/dataset-source.js';

const POSTGRES_MAX_BIND_PARAMETERS = 32_767;
const T0 = Date.UTC(2026, 9, 1);

/** The pre-fix matching rule, kept verbatim as the reference. */
function referenceMatch(trades: PaperTradeRow[], mint: string, snapshotAt: number) {
  return trades.filter((item) => item.tokenAddress === mint && item.entryAt && item.entryAt.getTime() >= snapshotAt - 60_000).sort((a, b) => a.entryAt!.getTime() - b.entryAt!.getTime())[0];
}

function trade(mint: string, entryOffsetMs: number | null, netPnl: number | null, exitOffsetMs: number | null = 600_000, entryStrategy: string | null = 'DEFAULT'): PaperTradeRow {
  return { tokenAddress: mint, netPnl, entryAt: entryOffsetMs === null ? null : new Date(T0 + entryOffsetMs), exitAt: exitOffsetMs === null ? null : new Date(T0 + exitOffsetMs), entryStrategy };
}

describe('PAPER trade lookup in batches (bind-parameter limit)', () => {
  it('queries 40 000+ distinct mints in batches of at most 1000, each mint exactly once', async () => {
    const mints = Array.from({ length: 40_123 }, (_, index) => `Mint${index.toString().padStart(6, '0')}`);
    // Duplicates (several snapshots per mint) must not be sent twice.
    const input = [...mints, ...mints.slice(0, 500)];
    const seen: string[] = [];
    let calls = 0;
    const trades = await loadPaperTradesInBatches(input, async (batch) => {
      calls += 1;
      // Simulated PostgreSQL: the IN list + the 2 other filters must fit into one prepared statement.
      if (batch.length + 2 > POSTGRES_MAX_BIND_PARAMETERS) throw new Error('too many bind variables in prepared statement');
      expect(batch.length).toBeLessThanOrEqual(TRADE_MINT_BATCH_SIZE);
      seen.push(...batch);
      return batch.filter((_, index) => index % 100 === 0).map((mint) => trade(mint, 1_000, 1));
    });
    expect(calls).toBe(Math.ceil(mints.length / TRADE_MINT_BATCH_SIZE));
    expect(seen).toHaveLength(mints.length);
    expect(new Set(seen).size).toBe(mints.length);
    expect(trades.length).toBeGreaterThan(400);
    // The old single query would have exceeded the limit.
    expect(mints.length + 2).toBeGreaterThan(POSTGRES_MAX_BIND_PARAMETERS);
  });

  it('makes no query without mints', async () => {
    let calls = 0;
    expect(await loadPaperTradesInBatches([], async () => { calls += 1; return []; })).toEqual([]);
    expect(calls).toBe(0);
  });

  it('chunks exactly', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(() => chunk([1], 0)).toThrow();
  });
});

describe('Map-indexed PAPER trade matching (unchanged rule)', () => {
  it('matches the earliest trade opened at most 60 s before the snapshot (or later)', () => {
    const trades = [
      trade('A', -120_000, 5), // too early
      trade('A', -PAPER_TRADE_ENTRY_TOLERANCE_MS, 7), // exactly at the tolerance: included
      trade('A', 30_000, 9),
      trade('A', null, 11), // no entry time: never matched
      trade('B', 10_000, -3),
    ];
    const index = indexPaperTrades(trades);
    expect(matchPaperTrade(index, 'A', T0)?.netPnl).toBe(7);
    expect(matchPaperTrade(index, 'A', T0 + 1)?.netPnl).toBe(9);
    expect(matchPaperTrade(index, 'A', T0 + 100_000)).toBeUndefined();
    expect(matchPaperTrade(index, 'B', T0)?.netPnl).toBe(-3);
    expect(matchPaperTrade(index, 'C', T0)).toBeUndefined();
  });

  it('is identical to the previous filter/sort implementation on random data, including entry-time ties', () => {
    let seed = 12345;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    const mints = Array.from({ length: 60 }, (_, index) => `M${index}`);
    const trades: PaperTradeRow[] = Array.from({ length: 900 }, (_, index) => trade(
      mints[Math.floor(random() * mints.length)],
      random() < 0.05 ? null : Math.floor(random() * 40) * 30_000 - 300_000, // coarse grid -> many ties
      index, // unique P&L identifies the chosen trade
    ));
    const index = indexPaperTrades(trades);
    for (let probe = 0; probe < 3_000; probe += 1) {
      const mint = mints[Math.floor(random() * mints.length)];
      const snapshotAt = T0 + Math.floor(random() * 1_500_000) - 400_000;
      expect(matchPaperTrade(index, mint, snapshotAt)).toBe(referenceMatch(trades, mint, snapshotAt));
    }
  });

  it('scales to tens of thousands of snapshots and mints', () => {
    const count = 45_000;
    const trades = Array.from({ length: count }, (_, index) => trade(`Mint${index}`, (index % 7) * 20_000, index % 3 ? 1 : -1));
    const started = Date.now();
    const index = indexPaperTrades(trades);
    let matched = 0;
    for (let snapshot = 0; snapshot < count; snapshot += 1) if (matchPaperTrade(index, `Mint${snapshot}`, T0)) matched += 1;
    expect(matched).toBe(count);
    // The old O(snapshots x trades) scan would take minutes here; the index is effectively linear.
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('maps provenance like before (null for unbought candidates, DEFAULT when the strategy is unknown)', () => {
    expect(paperProvenance(undefined)).toEqual({ paperNetPnl: null, paperExitAt: null, paperEntryStrategy: null });
    expect(paperProvenance(trade('A', 0, 1.25, 900_000, null))).toEqual({ paperNetPnl: 1.25, paperExitAt: T0 + 900_000, paperEntryStrategy: 'DEFAULT' });
    expect(paperProvenance({ ...trade('A', 0, null), netPnl: { toString: () => '-0.5' } })).toMatchObject({ paperNetPnl: -0.5 });
    expect(paperProvenance(trade('A', 0, null, null, 'ML'))).toEqual({ paperNetPnl: null, paperExitAt: null, paperEntryStrategy: 'ML' });
  });
});

describe('paperNetPositive dataset with batched + indexed trades', () => {
  function sourceRow(id: number, mint: string, snapshotOffsetMs: number, provenance: ReturnType<typeof paperProvenance>): MlDatasetSourceRow {
    return {
      snapshotId: `s${id}`, candidateId: `c${id}`, mint, source: 'PUMP_FUN', kind: 'AGE_30S', snapshotAt: T0 + snapshotOffsetMs, featureVersion: ML_FEATURE_VERSION,
      features: {} as MlFeatures, validForTraining: true, invalidReasons: [], dataQuality: 90, decision: 'BUY',
      outcome: { labelVersion: ML_LABEL_VERSION, quality: 'COMPLETE', pathLabels: { plus20BeforeMinus10: true } } as unknown as MlDatasetSourceRow['outcome'],
      ...provenance,
    };
  }

  it('labels bought candidates by their real net P&L and excludes the rest', async () => {
    const trades = await loadPaperTradesInBatches(['WIN', 'LOSS', 'OPEN', 'NONE', 'EARLY'], async (batch) => [
      trade('WIN', 5_000, 2.5, 900_000, 'ML'),
      trade('LOSS', 4_000, -1, 800_000),
      trade('EARLY', -600_000, 4), // opened long before the snapshot: not this candidate's trade
    ].filter((item) => batch.includes(item.tokenAddress)), 2);
    const index = indexPaperTrades(trades);
    const snapshots = [['WIN', 0], ['LOSS', 0], ['OPEN', 0], ['NONE', 0], ['EARLY', 0]] as const;
    const rows = snapshots.map(([mint, offset], id) => sourceRow(id, mint, offset, paperProvenance(matchPaperTrade(index, mint, T0 + offset))));
    const built = buildMlDataset(rows, { version: 'T', featureVersion: ML_FEATURE_VERSION, labelVersion: ML_LABEL_VERSION, target: 'paperNetPositive', snapshotKind: 'AGE_30S', minDataQuality: 50 });
    expect(built.rows).toBe(2);
    expect(built.manifest.positives).toBe(1);
    expect(built.manifest.excluded).toMatchObject({ NO_CLOSED_PAPER_TRADE: 3 });
    expect(built.manifest.paperTradesByStrategy).toEqual({ ML: 1, DEFAULT: 1 });
    const lines = built.csv.trim().split('\n').slice(1).map((line) => line.split(','));
    // label_end_ms = trade exit; label = net P&L > 0; paper_net_pnl carried.
    expect(lines.map((cells) => [cells[2], cells[6], cells[8], cells[9]])).toEqual([['WIN', String(T0 + 900_000), '1', '2.5'], ['LOSS', String(T0 + 800_000), '0', '-1']]);
  });

  it('classification targets keep carrying the PAPER P&L provenance (CSV + manifest)', () => {
    const index = indexPaperTrades([trade('WIN', 5_000, 2.5)]);
    const rows = ['WIN', 'NONE'].map((mint, id) => sourceRow(id, mint, 0, paperProvenance(matchPaperTrade(index, mint, T0))));
    const built = buildMlDataset(rows, { version: 'T', featureVersion: ML_FEATURE_VERSION, labelVersion: ML_LABEL_VERSION, target: 'plus20BeforeMinus10_30m', snapshotKind: 'AGE_30S', minDataQuality: 50 });
    expect(built.rows).toBe(2);
    expect(built.manifest.paperTrades).toBe(1);
    const lines = built.csv.trim().split('\n').slice(1).map((line) => line.split(','));
    expect(lines.map((cells) => cells[9])).toEqual(['2.5', '']);
  });
});

describe('snapshot paging', () => {
  it('loads every row once across pages via the id cursor', async () => {
    const all = Array.from({ length: 41_234 }, (_, index) => ({ id: `id${index.toString().padStart(6, '0')}` }));
    const cursors: Array<string | null> = [];
    const loaded = await loadAllPages(async (cursor, take) => {
      cursors.push(cursor);
      const start = cursor ? all.findIndex((row) => row.id === cursor) + 1 : 0;
      return all.slice(start, start + take);
    }, 5_000);
    expect(loaded).toEqual(all);
    expect(cursors).toHaveLength(9);
    expect(cursors[0]).toBeNull();
  });
});
