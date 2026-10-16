'use client';

import { ArrowDown, ArrowUp } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';

import { TokenAvatar } from '../avatars';
import { apiRequest, EmptyState, ErrorState, fmt, PageHeader, useApi } from '../components';
import { useRealtimeEvents } from '../hooks/useRealtimeEvents';
import { exitReasonLabel } from '../locales/hu';
import { decisionBadge } from '../locales/position-labels';
import { holdingTime, trailingSummary } from '../position-format';
import { FilterBar, formatSignedPercent, formatTokenPrice, Segmented, shortAddress, SkeletonRows, StatusBadge } from '../ui/primitives';

type Numeric = number | string | null | undefined;

interface ExitSummary { stopLossPercent?: number | null; takeProfitPercent?: number | null; trailingStatus?: string; trailingTriggerPrice?: number | null; trailingActivationPercent?: number | null }

interface PositionRow {
  id: string;
  status: 'OPEN' | 'CLOSED' | string;
  symbol: string | null;
  tokenAddress: string;
  decisionSource: string | null;
  strategyName: string | null;
  avgEntryPrice: Numeric;
  currentPrice: Numeric;
  invested: Numeric;
  unrealizedPnl: Numeric;
  realizedPnl: Numeric;
  estimatedCloseNowPnl?: Numeric;
  riskClassification: string | null;
  riskScore: Numeric;
  exitSummary?: ExitSummary | null;
  exitReason?: string | null;
  openedAt: string;
  closedAt?: string | null;
}

type View = 'OPEN' | 'CLOSED';
type Outcome = 'ALL' | 'WIN' | 'LOSS';
type SortKey = 'opened' | 'closed' | 'pnl' | 'pnlPct' | 'invested' | 'hold';

const num = (value: Numeric) => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const signedUsd = (value: number | null) => (value === null ? '—' : `${value > 0 ? '+' : ''}${fmt(value)} USDC`);
const pnlClass = (value: number | null) => (value === null || value === 0 ? '' : value > 0 ? 'up' : 'down');

function pnlOf(row: PositionRow) {
  return row.status === 'OPEN' ? num(row.unrealizedPnl) : num(row.realizedPnl);
}
function pnlPercentOf(row: PositionRow) {
  const pnl = pnlOf(row);
  const invested = num(row.invested);
  return pnl !== null && invested ? pnl / invested * 100 : null;
}

const SORT_LABELS: Record<SortKey, string> = { opened: 'Nyitva', closed: 'Lezárva', pnl: 'P&L', pnlPct: 'P&L %', invested: 'Méret', hold: 'Tartás' };

function sortValue(row: PositionRow, key: SortKey): number | null {
  switch (key) {
    case 'opened': return Date.parse(row.openedAt);
    case 'closed': return row.closedAt ? Date.parse(row.closedAt) : null;
    case 'pnl': return pnlOf(row);
    case 'pnlPct': return pnlPercentOf(row);
    case 'invested': return num(row.invested);
    case 'hold': return (row.closedAt ? Date.parse(row.closedAt) : Date.now()) - Date.parse(row.openedAt);
  }
}

export default function PositionsPage() {
  const router = useRouter();
  const { data, error, loading, refresh } = useApi<{ data: PositionRow[] }>('/api/positions');
  const { lastEvent } = useRealtimeEvents(['position_update']);
  const [view, setView] = useState<View>('OPEN');
  const [outcome, setOutcome] = useState<Outcome>('ALL');
  const [source, setSource] = useState('ALL');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'opened', desc: true });
  const [message, setMessage] = useState('');

  useEffect(() => { if (lastEvent) refresh(); }, [lastEvent, refresh]);
  useEffect(() => {
    const timer = globalThis.setInterval(() => { if (globalThis.document.visibilityState === 'visible') refresh(); }, 10_000);
    return () => globalThis.clearInterval(timer);
  }, [refresh]);
  // Each view has its natural default order.
  useEffect(() => setSort(view === 'OPEN' ? { key: 'opened', desc: true } : { key: 'closed', desc: true }), [view]);

  const all = useMemo(() => data?.data ?? [], [data]);
  const open = useMemo(() => all.filter((row) => row.status === 'OPEN'), [all]);
  const closed = useMemo(() => all.filter((row) => row.status === 'CLOSED'), [all]);
  const base = view === 'OPEN' ? open : closed;
  const sources = useMemo(() => [...new Set(all.map((row) => row.decisionSource ?? 'STRATEGY'))].sort(), [all]);

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return base.filter((row) => {
      const pnl = pnlOf(row);
      return (outcome === 'ALL' || (outcome === 'WIN' ? (pnl ?? 0) > 0 : (pnl ?? 0) < 0))
        && (source === 'ALL' || (row.decisionSource ?? 'STRATEGY') === source)
        && (!needle || row.tokenAddress.toLowerCase().includes(needle) || (row.symbol ?? '').toLowerCase().includes(needle));
    }).sort((a, b) => {
      const av = sortValue(a, sort.key);
      const bv = sortValue(b, sort.key);
      if (av === null && bv === null) return 0;
      if (av === null) return 1;
      if (bv === null) return -1;
      return sort.desc ? bv - av : av - bv;
    });
  }, [base, query, outcome, source, sort]);

  const invested = open.reduce((sum, row) => sum + (num(row.invested) ?? 0), 0);
  const unrealized = open.reduce((sum, row) => sum + (num(row.unrealizedPnl) ?? 0), 0);
  const today = new Date().toDateString();
  const closedToday = closed.filter((row) => row.closedAt && new Date(row.closedAt).toDateString() === today);
  const realizedToday = closedToday.reduce((sum, row) => sum + (num(row.realizedPnl) ?? 0), 0);
  const winsToday = closedToday.filter((row) => (num(row.realizedPnl) ?? 0) > 0).length;

  const close = async (row: PositionRow) => {
    if (!globalThis.confirm(`Biztosan lezárod a(z) ${row.symbol ?? 'token'} pozíciót a jelenlegi áron?`)) return;
    setMessage('Pozíció lezárása…');
    try {
      await apiRequest(`/api/positions/${row.id}/close`, { method: 'POST', body: JSON.stringify({ reason: 'manual-close' }) });
      setMessage('A pozíció lezárva.');
      refresh();
    } catch (closeError) {
      setMessage(closeError instanceof Error ? closeError.message : 'A pozíció lezárása sikertelen');
    }
  };

  const toggleSort = (key: SortKey) => setSort((current) => (current.key === key ? { key, desc: !current.desc } : { key, desc: true }));
  const sortHeader = (key: SortKey) => <th scope="col" aria-sort={sort.key === key ? (sort.desc ? 'descending' : 'ascending') : 'none'}>
    <button type="button" className={`th-sort${sort.key === key ? ' active' : ''}`} onClick={() => toggleSort(key)}>
      {SORT_LABELS[key]}{sort.key === key ? (sort.desc ? <ArrowDown size={12} aria-hidden="true" /> : <ArrowUp size={12} aria-hidden="true" />) : null}
    </button>
  </th>;
  const tokenCell = (row: PositionRow) => <Link className="nl-token" href={`/positions/${row.id}`} onClick={(event) => event.stopPropagation()} title={row.tokenAddress}>
    <TokenAvatar address={row.tokenAddress} symbol={row.symbol ?? row.tokenAddress} size={26} />
    <span className="nl-token-text"><strong>{row.symbol ?? shortAddress(row.tokenAddress)}</strong><small>{decisionBadge(row.decisionSource, row.strategyName)} · {shortAddress(row.tokenAddress)}</small></span>
  </Link>;

  const header = <PageHeader eyebrow="Kereskedés" title="Pozíciók" subtitle="Nyitott és lezárt pozíciók – kattints egy sorra a grafikonhoz és a kilépési szintekhez" />;
  if (loading && !data) return <>{header}<section className="tcard"><SkeletonRows rows={6} columns={6} /></section></>;
  if (error && !data) return <>{header}<ErrorState message={error} /></>;

  return <>
    {header}
    <section className="nl-stats" aria-label="Pozíció összefoglaló">
      <div><span>Nyitott pozíciók</span><strong>{open.length}</strong></div>
      <div><span>Befektetve</span><strong>{fmt(invested)} USDC</strong></div>
      <div><span>Nem realizált P&amp;L</span><strong className={pnlClass(open.length ? unrealized : null)}>{open.length ? signedUsd(unrealized) : '—'}</strong></div>
      <div><span>Ma lezárva</span><strong>{closedToday.length}</strong></div>
      <div><span>Mai realizált</span><strong className={pnlClass(closedToday.length ? realizedToday : null)}>{closedToday.length ? signedUsd(realizedToday) : '—'}</strong></div>
      <div><span>Mai nyerő / vesztes</span><strong>{winsToday} / {closedToday.length - winsToday}</strong></div>
    </section>

    {message ? <p className="notice notice-info" role="status"><span>{message}</span></p> : null}

    <section className="tcard nl-card">
      <FilterBar<Outcome> query={query} onQuery={setQuery} placeholder="Keresés ticker vagy mint alapján"
        chips={[{ id: 'ALL', label: 'Mind', count: base.length }, { id: 'WIN', label: 'Nyerő' }, { id: 'LOSS', label: 'Vesztes' }]} activeChip={outcome} onChip={setOutcome}>
        <Segmented<View> label="Nézet" value={view} onChange={setView} options={[{ id: 'OPEN', label: `Nyitott (${open.length})` }, { id: 'CLOSED', label: `Lezárt (${closed.length})` }]} />
        {sources.length > 1 ? <Segmented label="Forrás" value={source} onChange={setSource} options={[{ id: 'ALL', label: 'Minden forrás' }, ...sources.map((id) => ({ id, label: decisionBadge(id, null) }))]} /> : null}
      </FilterBar>

      {rows.length === 0 ? <EmptyState message={base.length ? 'Nincs a szűrésnek megfelelő pozíció.' : view === 'OPEN' ? 'Nincs nyitott pozíció. A memecoin pozíciókat a stop loss / profitcél gyakran perceken belül lezárja – a Lezárt nézetben látod őket.' : 'Még nincs lezárt pozíció.'} /> : <>
        <div className="nl-table-wrap">
          <table className="nl-table">
            <thead><tr>
              <th scope="col">Token</th>
              <th scope="col" className="num">Belépés</th>
              <th scope="col" className="num">{view === 'OPEN' ? 'Most' : 'Kilépés'}</th>
              {sortHeader('invested')}
              {sortHeader('pnl')}
              {view === 'OPEN' ? <><th scope="col" className="num">SL / TP</th><th scope="col">Követő stop</th></> : <th scope="col">Kilépés oka</th>}
              {sortHeader('hold')}
              {view === 'CLOSED' ? sortHeader('closed') : null}
              {view === 'OPEN' ? <th scope="col"><span className="sr-only">Művelet</span></th> : null}
            </tr></thead>
            <tbody>{rows.map((row) => {
              const pnl = pnlOf(row);
              const pct = pnlPercentOf(row);
              return <tr key={row.id} onClick={() => router.push(`/positions/${row.id}`)}>
                <td>{tokenCell(row)}</td>
                <td className="num mono">{formatTokenPrice(num(row.avgEntryPrice))}</td>
                <td className="num mono">{formatTokenPrice(num(row.currentPrice))}</td>
                <td className="num">{fmt(num(row.invested) ?? 0)} USDC</td>
                <td className={`num ${pnlClass(pnl)}`} title={view === 'OPEN' && num(row.estimatedCloseNowPnl) !== null ? `Most zárva kb. ${signedUsd(num(row.estimatedCloseNowPnl))}` : undefined}><span className="pnl-cell"><b>{signedUsd(pnl)}</b><small>{formatSignedPercent(pct, 1)}</small></span></td>
                {view === 'OPEN'
                  ? <><td className="num"><span className="down">{formatSignedPercent(row.exitSummary?.stopLossPercent ?? null, 0)}</span> / <span className="up">{formatSignedPercent(row.exitSummary?.takeProfitPercent ?? null, 0)}</span></td><td>{trailingSummary(row.exitSummary)}</td></>
                  : <td>{exitReasonLabel(row.exitReason)}</td>}
                <td className="num">{holdingTime(row.openedAt, row.closedAt)}</td>
                {view === 'CLOSED' ? <td className="num muted">{row.closedAt ? new Date(row.closedAt).toLocaleString('hu-HU', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'}</td> : null}
                {view === 'OPEN' ? <td><button className="danger-button small" type="button" onClick={(event) => { event.stopPropagation(); void close(row); }}>Zárás</button></td> : null}
              </tr>;
            })}</tbody>
          </table>
        </div>

        <div className="nl-cards">
          {rows.map((row) => {
            const pnl = pnlOf(row);
            return <button type="button" key={row.id} className="nl-mobile" onClick={() => router.push(`/positions/${row.id}`)}>
              <span className="nl-mobile-head">
                <span className="nl-token"><TokenAvatar address={row.tokenAddress} symbol={row.symbol ?? row.tokenAddress} size={26} /><span className="nl-token-text"><strong>{row.symbol ?? shortAddress(row.tokenAddress)}</strong><small>{decisionBadge(row.decisionSource, row.strategyName)} · {holdingTime(row.openedAt, row.closedAt)}</small></span></span>
                <StatusBadge tone={pnl === null || pnl === 0 ? 'neutral' : pnl > 0 ? 'positive' : 'negative'}>{formatSignedPercent(pnlPercentOf(row), 1)}</StatusBadge>
              </span>
              <span className="nl-mobile-grid">
                <span><small>Belépés</small><b className="mono">{formatTokenPrice(num(row.avgEntryPrice))}</b></span>
                <span><small>{view === 'OPEN' ? 'Most' : 'Kilépés'}</small><b className="mono">{formatTokenPrice(num(row.currentPrice))}</b></span>
                <span><small>P&amp;L</small><b className={pnlClass(pnl)}>{signedUsd(pnl)}</b></span>
                <span><small>{view === 'OPEN' ? 'Követő stop' : 'Kilépés oka'}</small><b>{view === 'OPEN' ? trailingSummary(row.exitSummary) : exitReasonLabel(row.exitReason)}</b></span>
              </span>
            </button>;
          })}
        </div>
        <small className="muted nl-foot">{rows.length} / {base.length} pozíció{view === 'OPEN' ? ' · élő árfolyammal frissül; a zárás a jelenlegi áron, megerősítés után történik.' : ''}</small>
      </>}
    </section>
  </>;
}
