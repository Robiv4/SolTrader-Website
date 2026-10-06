'use client';
/* eslint-disable @typescript-eslint/no-explicit-any */
import { Coins, History, Layers, TrendingUp } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';

import { TokenLabel } from '../avatars';
import { apiRequest, DataTable, date, EmptyState, ErrorState, fmt, formatPrice, LoadingState, PageHeader, Stacked, Status, useApi } from '../components';
import { useRealtimeEvents } from '../hooks/useRealtimeEvents';
import { exitReasonLabel } from '../locales/hu';
import { decisionBadge } from '../locales/position-labels';
import { holdingTime, signedPercent, trailingSummary } from '../position-format';
import { DashCard, Kpi } from '../ui-cards';

function numeric(value: any) {
  if (value == null) return null;
  const parsed = typeof value?.toNumber === 'function' ? value.toNumber() : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

const signedUsd = (value: number | null) => (value === null ? '—' : `${value > 0 ? '+' : ''}${fmt(value)} USDC`);
const toneOf = (value: number | null) => (value === null || value === 0 ? '' : value > 0 ? 'positive-value' : 'negative-value');

type ClosedFilter = 'ALL' | 'WIN' | 'LOSS';

export default function PositionsPage() {
  const router = useRouter();
  const { data, error, loading, refresh } = useApi<{ data: any[] }>('/api/positions');
  const { lastEvent } = useRealtimeEvents(['position_update']);
  useEffect(() => { if (lastEvent) refresh(); }, [lastEvent, refresh]);
  const [message, setMessage] = useState('');
  const [closedFilter, setClosedFilter] = useState<ClosedFilter>('ALL');
  const header = (action?: ReactNode) => <PageHeader eyebrow="Portfólió" title="Pozíciók" subtitle="Nyitott és lezárt PAPER pozíciók – kattints egy sorra a grafikonhoz és a kilépési szintekhez" action={action} />;
  if (loading && !data) return <>{header()}<LoadingState /></>;
  if (error && !data) return <>{header()}<ErrorState message={error} /></>;

  const all = data?.data ?? [];
  const rows = all.filter((row: any) => row.status === 'OPEN');
  const closedAll = all.filter((row: any) => row.status === 'CLOSED');
  const closedRows = closedAll
    .filter((row: any) => closedFilter === 'ALL' || (closedFilter === 'WIN' ? (numeric(row.realizedPnl) ?? 0) > 0 : (numeric(row.realizedPnl) ?? 0) < 0))
    .slice(0, 20);
  const invested = rows.reduce((sum: number, row: any) => sum + (numeric(row.invested) ?? 0), 0);
  const unrealized = rows.reduce((sum: number, row: any) => sum + (numeric(row.unrealizedPnl) ?? 0), 0);
  const today = new Date().toDateString();
  const closedToday = closedAll.filter((row: any) => row.closedAt && new Date(row.closedAt).toDateString() === today);
  const realizedToday = closedToday.reduce((sum: number, row: any) => sum + (numeric(row.realizedPnl) ?? 0), 0);
  const winsToday = closedToday.filter((row: any) => (numeric(row.realizedPnl) ?? 0) > 0).length;

  const close = async (id: string, symbol: string) => {
    if (!globalThis.confirm(`Biztosan lezárod a(z) ${symbol} PAPER pozíciót a jelenlegi áron?`)) return;
    setMessage('Pozíció lezárása…');
    try {
      await apiRequest(`/api/positions/${id}/close`, { method: 'POST', body: JSON.stringify({ reason: 'manual-close' }) });
      setMessage('A pozíció lezárva, az eredmény jóváírva a paper számlán.');
      refresh();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'A pozíció lezárása sikertelen');
    }
  };
  const open = (id: string) => router.push(`/positions/${id}`);
  const tokenCell = (row: any) => <Link className="row-link" href={`/positions/${row.id}`} onClick={(event) => event.stopPropagation()} title={row.tokenAddress}>
    <Stacked top={<TokenLabel address={row.tokenAddress} symbol={row.symbol ?? row.tokenAddress} />} bottom={<span className={`source-badge source-${String(row.decisionSource).toLowerCase()}`}>{decisionBadge(row.decisionSource, row.strategyName)}</span>} />
  </Link>;

  return <>
    {header(<Status tone={rows.length ? 'positive' : 'neutral'}>{rows.length} NYITOTT</Status>)}

    <section className="kpi-grid" aria-label="Pozíció összefoglaló">
      <Kpi icon={<Layers size={20} />} label="Nyitott pozíciók" value={<>{rows.length} <small>db</small></>} note="a max. egyidejű pozíciószám a Beállításokban állítható" />
      <Kpi icon={<Coins size={20} />} label="Befektetett összeg" value={<>{fmt(invested)} <small>USDC</small></>} note="a nyitott pozíciókban" />
      <Kpi icon={<TrendingUp size={20} />} label="Nem realizált P&L" value={<span className={toneOf(rows.length ? unrealized : null)}>{rows.length ? signedUsd(unrealized) : '—'}</span>} note={invested > 0 ? `${signedPercent(unrealized / invested * 100)} a befektetéshez képest` : 'nincs nyitott pozíció'} />
      <Kpi icon={<History size={20} />} label="Ma lezárva" value={<>{closedToday.length} <small>db</small></>} sub={closedToday.length ? <span className={toneOf(realizedToday)}>{signedUsd(realizedToday)}</span> : undefined} note={closedToday.length ? `${winsToday} nyerő · ${closedToday.length - winsToday} vesztes` : 'ma még nem zárult pozíció'} />
    </section>

    {message ? <p className="settings-message" role="status" aria-live="polite">{message}</p> : null}

    <DashCard title="Nyitott pozíciók" description="Élő árfolyammal frissül. A zárás a jelenlegi áron, megerősítés után történik.">
      {rows.length === 0 ? <EmptyState message="Nincs nyitott pozíció. A memecoin pozíciókat a stop loss / profitcél gyakran perceken belül lezárja – ezeket lent látod." /> : <DataTable wide headers={['Token', 'Belépés → most', 'P&L', 'Kockázat', 'Stop loss · Take profit', 'Követő stop', 'Tartás', '']}>{rows.map((row: any) => {
        const pnl = numeric(row.unrealizedPnl);
        const rowInvested = numeric(row.invested);
        const pnlPercent = pnl !== null && rowInvested ? pnl / rowInvested * 100 : null;
        return <tr key={row.id} className="clickable-row" onClick={() => open(row.id)}>
          <td>{tokenCell(row)}</td>
          <td><Stacked top={formatPrice(numeric(row.avgEntryPrice))} bottom={`→ ${formatPrice(numeric(row.currentPrice))}`} /></td>
          <td className={toneOf(pnl)} title="Nyitott P&L: árváltozás a belépési kitöltéshez képest, a belépési díjjal csökkentve. Zárásnál még a kilépési díj és a becsült árhatás jön le."><Stacked top={signedUsd(pnl)} bottom={<>{signedPercent(pnlPercent)}{numeric(row.estimatedCloseNowPnl) != null ? <span className="sfield-help"> · zárva ~{signedUsd(numeric(row.estimatedCloseNowPnl))}</span> : null}</>} /></td>
          <td>{row.riskClassification ? <Stacked top={row.riskClassification} bottom={row.riskScore == null ? '' : `${fmt(row.riskScore, 0)}/100`} /> : '—'}</td>
          <td><Stacked top={<span className="negative-value">SL {signedPercent(row.exitSummary?.stopLossPercent)}</span>} bottom={<span className="positive-value">TP {signedPercent(row.exitSummary?.takeProfitPercent)}</span>} /></td>
          <td>{trailingSummary(row.exitSummary)}</td>
          <td>{holdingTime(row.openedAt)}</td>
          <td><button className="position-close-button" type="button" onClick={(event) => { event.stopPropagation(); void close(row.id, row.symbol ?? 'token'); }}>Pozíció zárása</button></td>
        </tr>;
      })}</DataTable>}
    </DashCard>

    <DashCard title="Legutóbb lezárt pozíciók" description="Az utolsó 20 zárás; a sorra kattintva a teljes grafikon és az események is megnézhetők." className="dash-card-spaced"
      action={<div className="segmented" role="group" aria-label="Lezárt pozíciók szűrése">{([['ALL', 'Mind'], ['WIN', 'Nyerő'], ['LOSS', 'Vesztes']] as const).map(([key, text]) => <button key={key} type="button" className={closedFilter === key ? 'selected' : ''} aria-pressed={closedFilter === key} onClick={() => setClosedFilter(key)}>{text}</button>)}</div>}>
      {closedRows.length === 0 ? <EmptyState message={closedAll.length ? 'Ebben a szűrőben nincs lezárt pozíció.' : 'Még nincs lezárt pozíció.'} /> : <DataTable headers={['Token', 'Belépés → kilépés', 'Nettó P&L', 'Kilépés oka', 'Nyitva volt', 'Lezárva']}>{closedRows.map((row: any) => {
        const pnl = numeric(row.realizedPnl);
        return <tr key={row.id} className="clickable-row" onClick={() => open(row.id)}>
          <td>{tokenCell(row)}</td>
          <td><Stacked top={formatPrice(numeric(row.avgEntryPrice))} bottom={`→ ${formatPrice(numeric(row.currentPrice))}`} /></td>
          <td className={toneOf(pnl)}>{signedUsd(pnl)}</td>
          <td>{exitReasonLabel(row.exitReason)}</td>
          <td>{holdingTime(row.openedAt, row.closedAt)}</td>
          <td>{date(row.closedAt)}</td>
        </tr>;
      })}</DataTable>}
    </DashCard>
  </>;
}
