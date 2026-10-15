'use client';

import { ArrowDown, ArrowUp } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';

import { TokenAvatar } from '../avatars';
import { EmptyState, ErrorState, fmt, PageHeader, useApi } from '../components';
import { useRealtimeEvents } from '../hooks/useRealtimeEvents';
import { exitReasonLabel } from '../locales/hu';
import { decisionBadge } from '../locales/position-labels';
import { holdingTime } from '../position-format';
import { FilterBar, formatSignedPercent, formatTokenPrice, Segmented, shortAddress, SkeletonRows, StatusBadge } from '../ui/primitives';

type Numeric = number | string | null | undefined;

interface TradeRow {
  id: string;
  status: string;
  side: string | null;
  symbol?: string | null;
  tokenAddress: string | null;
  decisionSource: string | null;
  strategyName: string | null;
  /** ML entries: false = opened without token-security vetoes (experimental PAPER trade). */
  mlTokenSafetyChecks?: boolean | null;
  entry: Numeric;
  exit: Numeric;
  size: Numeric;
  quantity: Numeric;
  fees: Numeric;
  slippage: Numeric;
  netPnl: Numeric;
  exitReason: string | null;
  entryAt: string | null;
  exitAt: string | null;
  createdAt: string;
}

type Outcome = 'ALL' | 'WIN' | 'LOSS' | 'OPEN';
type Period = 'ALL' | 'TODAY' | '7D' | '30D';
type SortKey = 'time' | 'size' | 'pnl' | 'pnlPct' | 'costs' | 'hold';

const num = (value: Numeric) => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const signedUsd = (value: number | null) => (value === null ? '—' : `${value > 0 ? '+' : ''}${fmt(value)} USDC`);
const pnlClass = (value: number | null) => (value === null || value === 0 ? '' : value > 0 ? 'up' : 'down');
const timeOf = (row: TradeRow) => Date.parse(row.entryAt ?? row.createdAt);
const costsOf = (row: TradeRow) => (num(row.fees) ?? 0) + (num(row.slippage) ?? 0);
const pnlPercentOf = (row: TradeRow) => {
  const pnl = num(row.netPnl);
  const size = num(row.size);
  return pnl !== null && size ? pnl / size * 100 : null;
};
const sourceLabel = (row: TradeRow) => (row.strategyName === 'MANUAL_PAPER' ? 'Kézi' : decisionBadge(row.decisionSource, row.strategyName));

const SORT_LABELS: Record<SortKey, string> = { time: 'Időpont', size: 'Méret', pnl: 'Nettó P&L', pnlPct: 'P&L %', costs: 'Költség', hold: 'Tartás' };

function sortValue(row: TradeRow, key: SortKey): number | null {
  switch (key) {
    case 'time': return timeOf(row);
    case 'size': return num(row.size);
    case 'pnl': return num(row.netPnl);
    case 'pnlPct': return pnlPercentOf(row);
    case 'costs': return costsOf(row);
    case 'hold': return row.entryAt ? (row.exitAt ? Date.parse(row.exitAt) : Date.now()) - Date.parse(row.entryAt) : null;
  }
}

const PERIOD_MS: Record<Period, number> = { ALL: 0, TODAY: 0, '7D': 7 * 86_400_000, '30D': 30 * 86_400_000 };

export default function TradesPage() {
  const router = useRouter();
  const { data, error, loading, refresh } = useApi<{ data: TradeRow[] }>('/api/trades');
  const { lastEvent } = useRealtimeEvents(['trade_update']);
  const [query, setQuery] = useState('');
  const [outcome, setOutcome] = useState<Outcome>('ALL');
  const [period, setPeriod] = useState<Period>('ALL');
  const [source, setSource] = useState('ALL');
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'time', desc: true });

  useEffect(() => { if (lastEvent) refresh(); }, [lastEvent, refresh]);

  const all = useMemo(() => data?.data ?? [], [data]);
  const sources = useMemo(() => [...new Set(all.map((row) => row.decisionSource ?? 'STRATEGY'))].sort(), [all]);
  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const cutoff = period === 'TODAY' ? new Date().setHours(0, 0, 0, 0) : period === 'ALL' ? 0 : Date.now() - PERIOD_MS[period];
    return all.filter((row) => {
      const pnl = num(row.netPnl);
      return (source === 'ALL' || (row.decisionSource ?? 'STRATEGY') === source)
        && (outcome === 'ALL' || (outcome === 'OPEN' ? row.status === 'OPEN' : pnl !== null && (outcome === 'WIN' ? pnl > 0 : pnl < 0)))
        && (!cutoff || timeOf(row) >= cutoff)
        && (!needle || (row.tokenAddress ?? '').toLowerCase().includes(needle) || (row.symbol ?? '').toLowerCase().includes(needle));
    }).sort((a, b) => {
      const av = sortValue(a, sort.key);
      const bv = sortValue(b, sort.key);
      if (av === null && bv === null) return 0;
      if (av === null) return 1;
      if (bv === null) return -1;
      return sort.desc ? bv - av : av - bv;
    });
  }, [all, query, outcome, period, source, sort]);

  const closed = rows.filter((row) => num(row.netPnl) !== null);
  const netPnl = closed.reduce((sum, row) => sum + (num(row.netPnl) ?? 0), 0);
  const wins = closed.filter((row) => (num(row.netPnl) ?? 0) > 0).length;
  const costs = rows.reduce((sum, row) => sum + costsOf(row), 0);
  const volume = rows.reduce((sum, row) => sum + (num(row.size) ?? 0), 0);
  const best = closed.reduce<number | null>((max, row) => Math.max(max ?? Number.NEGATIVE_INFINITY, num(row.netPnl) ?? Number.NEGATIVE_INFINITY), null);

  const toggleSort = (key: SortKey) => setSort((current) => (current.key === key ? { key, desc: !current.desc } : { key, desc: true }));
  const sortHeader = (key: SortKey) => <th scope="col" aria-sort={sort.key === key ? (sort.desc ? 'descending' : 'ascending') : 'none'}>
    <button type="button" className={`th-sort${sort.key === key ? ' active' : ''}`} onClick={() => toggleSort(key)}>
      {SORT_LABELS[key]}{sort.key === key ? (sort.desc ? <ArrowDown size={12} aria-hidden="true" /> : <ArrowUp size={12} aria-hidden="true" />) : null}
    </button>
  </th>;
  const symbolOf = (row: TradeRow) => row.symbol ?? (row.tokenAddress ? shortAddress(row.tokenAddress) : '—');

  const header = <PageHeader eyebrow="Kereskedés" title="Kereskedési előzmények" subtitle="Végrehajtott és nyitott kereskedéseid – kattints egy sorra a részletekért" />;
  if (loading && !data) return <>{header}<section className="tcard"><SkeletonRows rows={8} columns={6} /></section></>;
  if (error && !data) return <>{header}<ErrorState message={error} /></>;

  return <>
    {header}
    <section className="nl-stats" aria-label="Kereskedési összefoglaló (a szűrőknek megfelelően)">
      <div><span>Kereskedések</span><strong>{rows.length}</strong></div>
      <div><span>Nettó P&amp;L</span><strong className={pnlClass(closed.length ? netPnl : null)}>{closed.length ? signedUsd(netPnl) : '—'}</strong></div>
      <div><span>Nyerési arány</span><strong>{closed.length ? `${fmt(wins / closed.length * 100, 0)}%` : '—'}</strong></div>
      <div><span>Nyerő / vesztes</span><strong>{wins} / {closed.length - wins}</strong></div>
      <div><span>Forgalom</span><strong>{fmt(volume)} USDC</strong></div>
      <div><span>Költségek</span><strong>{fmt(costs)} USDC</strong></div>
      <div><span>Legjobb</span><strong className={pnlClass(best)}>{best === null ? '—' : signedUsd(best)}</strong></div>
    </section>

    <section className="tcard nl-card">
      <FilterBar<Outcome> query={query} onQuery={setQuery} placeholder="Keresés ticker vagy mint alapján"
        chips={[{ id: 'ALL', label: 'Mind', count: all.length }, { id: 'WIN', label: 'Nyerő' }, { id: 'LOSS', label: 'Vesztes' }, { id: 'OPEN', label: 'Nyitott' }]} activeChip={outcome} onChip={setOutcome}>
        <Segmented<Period> label="Időszak" value={period} onChange={setPeriod} options={[{ id: 'ALL', label: 'Mind' }, { id: 'TODAY', label: 'Ma' }, { id: '7D', label: '7n' }, { id: '30D', label: '30n' }]} />
        {sources.length > 1 ? <Segmented label="Forrás" value={source} onChange={setSource} options={[{ id: 'ALL', label: 'Minden forrás' }, ...sources.map((id) => ({ id, label: decisionBadge(id, null) }))]} /> : null}
      </FilterBar>

      {rows.length === 0 ? <EmptyState message={all.length ? 'Nincs a szűrésnek megfelelő kereskedés.' : 'Még nincs kereskedés.'} /> : <>
        <div className="nl-table-wrap">
          <table className="nl-table">
            <thead><tr>
              {sortHeader('time')}
              <th scope="col">Token</th>
              <th scope="col" className="num">Belépés</th>
              <th scope="col" className="num">Kilépés</th>
              {sortHeader('size')}
              {sortHeader('costs')}
              {sortHeader('pnl')}
              {sortHeader('hold')}
              <th scope="col">Kilépés oka</th>
            </tr></thead>
            <tbody>{rows.map((row) => {
              const pnl = num(row.netPnl);
              const pct = pnlPercentOf(row);
              return <tr key={row.id} onClick={() => router.push(`/trades/${row.id}`)}>
                <td className="num muted">{new Date(timeOf(row)).toLocaleString('hu-HU', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</td>
                <td>
                  <Link className="nl-token" href={`/trades/${row.id}`} onClick={(event) => event.stopPropagation()} title={row.tokenAddress ?? undefined}>
                    <TokenAvatar address={row.tokenAddress ?? row.id} symbol={row.symbol ?? row.tokenAddress ?? '?'} size={26} />
                    <span className="nl-token-text"><strong>{symbolOf(row)}{row.mlTokenSafetyChecks === false ? <span className="exp-badge" title="Tokenbiztonsági ellenőrzések nélkül nyitott ML PAPER trade">KÍSÉRLETI</span> : null}</strong><small>{sourceLabel(row)}{row.tokenAddress ? ` · ${shortAddress(row.tokenAddress)}` : ''}</small></span>
                  </Link>
                </td>
                <td className="num mono">{formatTokenPrice(num(row.entry))}</td>
                <td className="num mono">{row.status === 'OPEN' ? <StatusBadge tone="info">NYITOTT</StatusBadge> : formatTokenPrice(num(row.exit))}</td>
                <td className="num">{fmt(num(row.size) ?? 0)} USDC</td>
                <td className="num muted" title={`díj ${fmt(num(row.fees) ?? 0)} · csúszás ${fmt(num(row.slippage) ?? 0)}`}>{fmt(costsOf(row))} USDC</td>
                <td className={`num ${pnlClass(pnl)}`}><span className="pnl-cell"><b>{signedUsd(pnl)}</b><small>{formatSignedPercent(pct, 1)}</small></span></td>
                <td className="num">{row.entryAt ? holdingTime(row.entryAt, row.exitAt) : '—'}</td>
                <td>{row.status === 'OPEN' ? '—' : exitReasonLabel(row.exitReason)}</td>
              </tr>;
            })}</tbody>
          </table>
        </div>

        <div className="nl-cards">
          {rows.map((row) => {
            const pnl = num(row.netPnl);
            return <button type="button" key={row.id} className="nl-mobile" onClick={() => router.push(`/trades/${row.id}`)}>
              <span className="nl-mobile-head">
                <span className="nl-token"><TokenAvatar address={row.tokenAddress ?? row.id} symbol={row.symbol ?? row.tokenAddress ?? '?'} size={26} /><span className="nl-token-text"><strong>{symbolOf(row)}{row.mlTokenSafetyChecks === false ? <span className="exp-badge" title="Tokenbiztonsági ellenőrzések nélkül nyitott ML PAPER trade">KÍSÉRLETI</span> : null}</strong><small>{sourceLabel(row)} · {new Date(timeOf(row)).toLocaleString('hu-HU', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</small></span></span>
                {row.status === 'OPEN' ? <StatusBadge tone="info">NYITOTT</StatusBadge> : <StatusBadge tone={pnl === null || pnl === 0 ? 'neutral' : pnl > 0 ? 'positive' : 'negative'}>{formatSignedPercent(pnlPercentOf(row), 1)}</StatusBadge>}
              </span>
              <span className="nl-mobile-grid">
                <span><small>Belépés → kilépés</small><b className="mono">{formatTokenPrice(num(row.entry))} → {row.status === 'OPEN' ? '…' : formatTokenPrice(num(row.exit))}</b></span>
                <span><small>Méret</small><b>{fmt(num(row.size) ?? 0)} USDC</b></span>
                <span><small>Nettó P&amp;L</small><b className={pnlClass(pnl)}>{signedUsd(pnl)}</b></span>
                <span><small>Kilépés oka</small><b>{row.status === 'OPEN' ? '—' : exitReasonLabel(row.exitReason)}</b></span>
              </span>
            </button>;
          })}
        </div>
        <small className="muted nl-foot">{rows.length} / {all.length} kereskedés · a számok a kiválasztott szűrőkre vonatkoznak; a nettó P&amp;L a díjakat és a csúszást már tartalmazza.</small>
      </>}
    </section>
  </>;
}
