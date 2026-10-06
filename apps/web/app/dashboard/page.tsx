'use client';
/* eslint-disable @typescript-eslint/no-explicit-any */
import { ArrowRight, CalendarClock, Layers, Target, Wallet } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';

import { TokenLabel } from '../avatars';
import { BotMasterControls, BotStatusBadge } from '../bot-controls';
import { apiRequest, DataTable, date, EmptyState, ErrorState, fmt, formatPrice, LoadingState, ModeBadge, PageHeader, Stacked, Status, useApi } from '../components';
import { useBotStatus } from '../hooks/useBotStatus';
import { useRealtimeEvents } from '../hooks/useRealtimeEvents';
import { exitReasonLabel } from '../locales/hu';
import { LiveLogViewer } from '../realtime-view';
import { DashCard, Kpi } from '../ui-cards';

function numeric(value: unknown) {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function signed(value: unknown, suffix = '') {
  const number = numeric(value);
  if (number === null) return '—';
  return `${number > 0 ? '+' : ''}${fmt(number)}${suffix}`;
}

/** Time for today's entries, date + time otherwise. */
function shortTime(value: unknown) {
  if (!value) return '—';
  const at = new Date(String(value));
  const sameDay = at.toDateString() === new Date().toDateString();
  return sameDay ? at.toLocaleTimeString('hu-HU', { hour: '2-digit', minute: '2-digit' }) : at.toLocaleString('hu-HU', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function tone(value: unknown) {
  const number = numeric(value);
  if (number === null || number === 0) return '';
  return number > 0 ? 'positive' : 'negative';
}

export default function DashboardPage() {
  const router = useRouter();
  const [range, setRange] = useState('7d');
  const bot = useBotStatus();
  const account = useApi<{ data: any }>('/api/paper-account');
  const portfolio = useApi<{ data: any }>('/api/portfolio/snapshot?range=all');
  const analytics = useApi<{ data: any }>(`/api/analytics?range=${range}`);
  const settings = useApi<{ data: any }>('/api/settings');
  const positions = useApi<{ data: any[] }>('/api/positions');
  const trades = useApi<{ data: any[] }>('/api/trades');
  const signals = useApi<{ data: any[] }>('/api/signals');
  const approvals = useApi<{ data: any[] }>('/api/approvals');
  const { lastEvent } = useRealtimeEvents(['position_update', 'trade_update', 'pnl_update']);
  const [approvalMessage, setApprovalMessage] = useState('');
  useEffect(() => {
    if (!lastEvent) return;
    account.refresh();
    portfolio.refresh();
    analytics.refresh();
    positions.refresh();
    trades.refresh();
    approvals.refresh();
  }, [lastEvent, account.refresh, portfolio.refresh, analytics.refresh, positions.refresh, trades.refresh, approvals.refresh]);

  const header = (action?: ReactNode) => <PageHeader eyebrow="Kereskedési terminál" title="Irányítópult" subtitle="A paper számla, a bot és a piac egy helyen" action={action} />;
  const loading = !account.data || !portfolio.data || !settings.data || !positions.data || !trades.data;
  const error = account.error ?? portfolio.error ?? settings.error ?? positions.error ?? trades.error;
  if (error && loading) return <>{header()}<ErrorState message={error} /></>;
  if (loading) return <>{header()}<LoadingState /></>;

  const paper = account.data?.data ?? {};
  const snapshot = portfolio.data?.data ?? {};
  const analyticsData = analytics.data?.data;
  const mode = settings.data?.data?.tradingMode;
  const enabledStrategies = Object.entries(settings.data?.data?.strategies ?? {}).filter(([, value]: [string, any]) => value?.isEnabled).map(([name]) => name);
  const positionRows = (positions.data?.data ?? []).filter((row: any) => row.status === 'OPEN');
  const tradeRows = trades.data?.data ?? [];
  const signalRows = signals.data?.data ?? [];
  const approvalRows = approvals.data?.data ?? [];
  const initial = numeric(paper.initialBalance) ?? 0;
  const equity = numeric(snapshot.totalEquity) ?? numeric(paper.equity) ?? 0;
  const totalResult = equity - initial;
  const totalResultPercent = initial > 0 ? totalResult / initial * 100 : null;
  const signalsToday = signalRows.filter((signal: any) => signal.createdAt && new Date(signal.createdAt).toDateString() === new Date().toDateString()).length;

  const reviewApproval = async (id: string, action: 'approve' | 'reject') => {
    setApprovalMessage(action === 'approve' ? 'Jóváhagyás…' : 'Elutasítás…');
    try {
      await apiRequest(`/api/approvals/${id}/${action}`, { method: 'POST', body: '{}' });
      setApprovalMessage(action === 'approve' ? 'A javaslat végrehajtva.' : 'A javaslat elutasítva.');
      approvals.refresh();
      account.refresh();
      positions.refresh();
    } catch (reviewError) {
      setApprovalMessage(reviewError instanceof Error ? reviewError.message : 'A javaslat feldolgozása sikertelen');
    }
  };

  const winRate = numeric(analyticsData?.winRate);
  const rangeLabel = range === 'all' ? 'teljes időszak' : range === '30d' ? 'utolsó 30 nap' : 'utolsó 7 nap';

  return <>
    {header(<div className="header-actions">{mode ? <ModeBadge mode={mode} /> : <Status>MÓD ISMERETLEN</Status>}<BotStatusBadge status={bot.botState?.status} /></div>)}

    {snapshot.dailyLossLimitReached && <div className="alert-banner warning" role="alert">
      <strong>A napi veszteségkorlát elérve – a bot ma nem nyit új pozíciót.</strong>
      <span>Mai veszteség: {fmt(snapshot.dailyLoss)} USDC / korlát: {fmt(snapshot.dailyLossLimit)} USDC. A nyitott pozíciók védelme tovább fut; a korlát UTC éjfélkor nullázódik, vagy a <Link className="table-link" href="/settings#risk">Beállításokban</Link> módosíthatod.</span>
    </div>}

    <section className="kpi-grid" aria-label="Számla összefoglaló">
      <Kpi icon={<Wallet size={20} />} label="Paper számla értéke" value={<>{fmt(equity)} <small>USDC</small></>} tone="brand"
        sub={<span className={`${tone(totalResult)}-value`}>{signed(totalResult, ' USDC')}{totalResultPercent !== null ? ` (${signed(totalResultPercent, '%')})` : ''}</span>} note={`kezdőtőke: ${fmt(initial)} USDC`} />
      <Kpi icon={<CalendarClock size={20} />} label="Mai P&L" value={<span className={`${tone(snapshot.dailyPnl)}-value`}>{signed(snapshot.dailyPnl)} <small>USDC</small></span>} note={`realizált összesen: ${signed(snapshot.realizedPnl)} USDC`} />
      <Kpi icon={<Layers size={20} />} label="Nyitott pozíciók" value={<>{positionRows.length} <small>db</small></>} note={`érték: ${fmt(snapshot.openPositionValue)} USDC · nem realizált: ${signed(snapshot.unrealizedPnl)}`} />
      <Kpi icon={<Target size={20} />} label="Nyerési arány" value={winRate === null ? '—' : <>{fmt(winRate, 0)}<small>%</small></>} note={rangeLabel} />
    </section>

    <section className="dash-grid-main">
      <DashCard title="Eredménygörbe" description={`Kumulált nettó P&L – ${rangeLabel}`} action={<div className="segmented" role="group" aria-label="Időszak">{[['7d', '7 nap'], ['30d', '30 nap'], ['all', 'Mind']].map(([value, text]) => <button key={value} type="button" className={range === value ? 'selected' : ''} aria-pressed={range === value} onClick={() => setRange(value)}>{text}</button>)}</div>}>
        <div className="equity-headline"><span className={`${tone(analyticsData?.totalPnl)}-value`}>{signed(analyticsData?.totalPnl, ' USDC')}</span><small>{analyticsData ? `${fmt(analyticsData.totalTrades, 0)} lezárt kereskedés` : ''}</small></div>
        <EquityCurve points={analyticsData?.equityCurve ?? []} />
      </DashCard>
      <DashCard title="Bot összefoglaló" description="A kereskedő bot jelenlegi állapota">
        <dl className="dash-stat-list">
          <div><dt>Állapot</dt><dd><BotStatusBadge status={bot.botState?.status} /></dd></div>
          <div><dt>Aktív stratégiák</dt><dd>{enabledStrategies.length ? enabledStrategies.join(', ') : <Link className="table-link" href="/settings#strategies">Nincs – bekapcsolás</Link>}</dd></div>
          <div><dt>Szabad egyenleg</dt><dd>{fmt(snapshot.cash ?? paper.cashBalance)} USDC</dd></div>
          <div><dt>Kitettség</dt><dd>{fmt(snapshot.exposure)}%</dd></div>
          <div><dt>Visszaesés</dt><dd>{fmt(snapshot.drawdown)}%</dd></div>
          <div><dt>Mai jelzések</dt><dd>{signalsToday}</dd></div>
          <div><dt>Befizetett díjak</dt><dd>{fmt(snapshot.fees)} USDC</dd></div>
        </dl>
      </DashCard>
    </section>

    <BotMasterControls />

    {approvalRows.length > 0 && <DashCard title="Jóváhagyásra váró belépések" description="SEMI_AUTO mód: ezeket a vételeket neked kell jóváhagynod." className="attention-card">
      {approvalMessage && <p className="inline-message" role="status">{approvalMessage}</p>}
      <DataTable wide headers={['Token', 'Belépő ár · összeg', 'Stop · cél', 'Jelzés · kockázat', 'Lejár', '']}>{approvalRows.map((row: any) => <tr key={row.id}>
        <td><TokenLabel address={row.tokenAddress ?? row.token} symbol={row.symbol ?? row.token} /></td>
        <td><Stacked top={formatPrice(row.entryPrice)} bottom={`${fmt((numeric(row.entryPrice) ?? 0) * (numeric(row.positionSize) ?? 0))} USDC`} /></td>
        <td><Stacked top={`stop ${formatPrice(row.stopLoss)}`} bottom={`cél ${formatPrice(row.takeProfit)}`} /></td>
        <td><Stacked top={`jelzés ${fmt(row.signalScore, 0)}`} bottom={`kockázat ${fmt(row.riskScore, 0)}`} /></td>
        <td>{date(row.expiresAt)}</td>
        <td><div className="header-actions"><button className="primary-button small" type="button" onClick={() => reviewApproval(row.id, 'approve')}>Jóváhagyás</button><button className="secondary-button small" type="button" onClick={() => reviewApproval(row.id, 'reject')}>Elutasítás</button></div></td>
      </tr>)}</DataTable>
    </DashCard>}

    <section className="dash-grid-2">
      <DashCard title="Nyitott pozíciók" description="Kattints egy sorra a részletekért" action={<Link className="card-link" href="/positions">Összes <ArrowRight size={15} aria-hidden="true" /></Link>}>
        {positionRows.length === 0
          ? <EmptyState message="Nincs nyitott pozíció. A Tokenfigyelőben nyithatsz Paper vételt." />
          : <DataTable headers={['Token', 'Belépés → most', 'Érték', 'P&L']}>{positionRows.slice(0, 6).map((row: any) => {
            const value = (numeric(row.quantity) ?? 0) * (numeric(row.currentPrice) ?? numeric(row.avgEntryPrice) ?? 0);
            return <tr key={row.id} className="clickable-row" onClick={() => router.push(`/positions/${row.id}`)}>
              <td><Link className="row-link" href={`/positions/${row.id}`} onClick={(event) => event.stopPropagation()}><TokenLabel address={row.tokenAddress} symbol={row.symbol ?? row.tokenAddress} /></Link></td>
              <td><Stacked top={formatPrice(numeric(row.avgEntryPrice))} bottom={`→ ${formatPrice(numeric(row.currentPrice))}`} /></td>
              <td>{fmt(value)} USDC</td>
              <td className={`${tone(row.unrealizedPnl)}-value`}>{signed(row.unrealizedPnl)}</td>
            </tr>;
          })}</DataTable>}
      </DashCard>
      <DashCard title="Legutóbbi kereskedések" description="Az utolsó zárások és nyitások" action={<Link className="card-link" href="/trades">Összes <ArrowRight size={15} aria-hidden="true" /></Link>}>
        {tradeRows.length === 0
          ? <EmptyState message="Még nincs kereskedés." />
          : <DataTable headers={['Token', 'Érték', 'Nettó P&L', 'Kilépés']}>{tradeRows.slice(0, 6).map((row: any) => <tr key={row.id} className="clickable-row" onClick={() => router.push(`/trades/${row.id}`)}>
            <td><Stacked top={<Link className="row-link" href={`/trades/${row.id}`} onClick={(event) => event.stopPropagation()}><TokenLabel address={row.tokenAddress} symbol={row.symbol} /></Link>} bottom={row.status === 'OPEN' ? 'nyitott' : 'lezárt'} /></td>
            <td>{fmt(numeric(row.size))} USDC</td>
            <td className={`${tone(row.netPnl)}-value`}>{row.netPnl == null ? '—' : signed(row.netPnl)}</td>
            <td><Stacked top={exitReasonLabel(row.exitReason)} bottom={shortTime(row.exitAt ?? row.entryAt ?? row.createdAt)} /></td>
          </tr>)}</DataTable>}
      </DashCard>
    </section>

    <section className="dash-grid-2">
      <DashCard title="Legutóbbi jelzések" description="A stratégiák friss vételi jelzései" action={<Link className="card-link" href="/signals">Összes <ArrowRight size={15} aria-hidden="true" /></Link>}>
        {signalRows.length === 0
          ? <EmptyState message="Még nincs jelzés. Kapcsolj be stratégiát, és indítsd el a botot." />
          : <DataTable headers={['Token', 'Pontszám', 'Kockázat', 'Idő']}>{signalRows.slice(0, 6).map((row: any) => <tr key={row.id}>
            <td><Stacked top={<TokenLabel address={row.tokenAddress} symbol={row.symbol ?? row.tokenId} />} bottom={row.signalType === 'MANUAL_PAPER' ? 'Kézi vétel' : String(row.strategyName ?? '—').replace('Strategy', '')} /></td>
            <td>{fmt(numeric(row.score), 0)}</td>
            <td>{fmt(numeric(row.riskScore), 0)}</td>
            <td>{shortTime(row.createdAt)}</td>
          </tr>)}</DataTable>}
      </DashCard>
      <DashCard title="Élő tevékenység" description="A bot naplója valós időben"><LiveLogViewer limit={30} /></DashCard>
    </section>
  </>;
}

function EquityCurve({ points }: { points: Array<{ at: string | null; equity: number }> }) {
  if (points.length < 2) return <div className="chart-empty"><span>Még nincs eredménytörténet</span><small>A lezárt kereskedések után itt jelenik meg a görbe.</small></div>;
  const values = points.map((point) => point.equity);
  const min = Math.min(0, ...values);
  const max = Math.max(0, ...values);
  const span = max - min || 1;
  const coordinates = points.map((point, index) => ({ x: (index / (points.length - 1)) * 100, y: 92 - ((point.equity - min) / span) * 80, point }));
  const zeroY = 92 - ((0 - min) / span) * 80;
  const negative = points.at(-1)!.equity < 0;
  const line = coordinates.map(({ x, y }) => `${x},${y}`).join(' ');
  return <div className="equity-chart" role="img" aria-label={`Kumulált eredmény ${points.length} adatponttal`}>
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      <defs><linearGradient id="equity-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor={negative ? 'var(--negative)' : 'var(--positive)'} stopOpacity="0.28" /><stop offset="100%" stopColor={negative ? 'var(--negative)' : 'var(--positive)'} stopOpacity="0" /></linearGradient></defs>
      <line x1="0" x2="100" y1={zeroY} y2={zeroY} className="zero-line" />
      <polygon points={`0,${zeroY} ${line} 100,${zeroY}`} fill="url(#equity-fill)" />
      <polyline className={negative ? 'negative-curve' : ''} points={line} />
    </svg>
    <div className="chart-axis"><span>{points[0]?.at ? new Date(points[0].at).toLocaleDateString('hu-HU') : 'Kezdet'}</span><span>Kumulált P&amp;L</span><span>{points.at(-1)?.at ? new Date(points.at(-1)!.at!).toLocaleDateString('hu-HU') : 'Most'}</span></div>
  </div>;
}

