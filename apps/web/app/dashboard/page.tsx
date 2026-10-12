'use client';
/* eslint-disable @typescript-eslint/no-explicit-any */
import { ArrowRight, Brain, CalendarClock, Layers, Target, Wallet } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';

import { TokenLabel } from '../avatars';
import { BotMasterControls, BotStatusBadge } from '../bot-controls';
import { apiRequest, DataTable, date, EmptyState, ErrorState, fmt, formatPrice, LoadingState, PageHeader, Stacked, useApi } from '../components';
import { useBotStatus } from '../hooks/useBotStatus';
import { useRealtimeEvents } from '../hooks/useRealtimeEvents';
import { exitReasonLabel } from '../locales/hu';
import { LiveLogViewer } from '../realtime-view';
import { formatAge, formatCompactUsd, formatTokenPrice, shortAddress, StatusBadge, type Tone } from '../ui/primitives';
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

interface DashboardOverview {
  worker: { alive: boolean; lastHeartbeatAt: string | null };
  newLaunch: { updatedAt: string | null; providers: Array<{ source: string; label: string; status: string }>; recent: Array<{ mint: string; symbol: string | null; name: string | null; source: string | null; ageSeconds: number | null; priceUsd: number | null; liquidityUsd: number | null; decision: 'BUY' | 'WATCH' | 'REJECT' | null; score: number | null }> };
  ml: { alive: boolean; mode: string | null; model: { status: string | null; version: string | null } | null; streamGapOpen: boolean; leakageViolations: number | null; decisionsToday: Partial<Record<'ML_BUY' | 'ML_SKIP' | 'ML_ERROR', number>>; snapshots24h: number };
}

const LAUNCH_DECISION: Record<string, { text: string; tone: Tone }> = { BUY: { text: 'VÉTEL', tone: 'positive' }, WATCH: { text: 'FIGYELÉS', tone: 'warning' }, REJECT: { text: 'ELUTASÍTVA', tone: 'negative' } };

function StatusRow({ label, tone: rowTone, text, detail }: { label: string; tone: Tone; text: string; detail?: ReactNode }) {
  return <div className="sys-row"><span className="sys-label">{label}</span><StatusBadge tone={rowTone} dot>{text}</StatusBadge>{detail ? <small className="muted">{detail}</small> : null}</div>;
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
  const overview = useApi<{ data: DashboardOverview }>('/api/dashboard/overview');
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
    overview.refresh();
  }, [lastEvent, overview.refresh, account.refresh, portfolio.refresh, analytics.refresh, positions.refresh, trades.refresh, approvals.refresh]);

  // Status card refresh (cheap Redis reads) while the tab is visible.
  useEffect(() => {
    const timer = globalThis.setInterval(() => { if (globalThis.document.visibilityState === 'visible') overview.refresh(); }, 15_000);
    return () => globalThis.clearInterval(timer);
  }, [overview.refresh]);

  const header = (action?: ReactNode) => <PageHeader eyebrow="Áttekintés" title="Dashboard" subtitle="Számla, bot, New Launch és ML egy helyen" action={action} />;
  const loading = !account.data || !portfolio.data || !settings.data || !positions.data || !trades.data;
  const error = account.error ?? portfolio.error ?? settings.error ?? positions.error ?? trades.error;
  if (error && loading) return <>{header()}<ErrorState message={error} /></>;
  if (loading) return <>{header()}<LoadingState /></>;

  const paper = account.data?.data ?? {};
  const snapshot = portfolio.data?.data ?? {};
  const analyticsData = analytics.data?.data;
  const newLaunch = settings.data?.data?.newLaunch as { enabled: boolean; configVersion: string } | undefined;
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
  const status = overview.data?.data ?? null;
  const strategy = settings.data?.data?.paperStrategy as { mode: 'DEFAULT' | 'ML'; modelVersion: string | null } | undefined;
  const mlCounts = status?.ml.decisionsToday ?? {};
  const providerIssues = (status?.newLaunch.providers ?? []).filter((provider) => provider.status !== 'ACTIVE');
  const warnings = [
    settings.data?.data?.isEmergencyStop ? 'Vészleállítás aktív – a bot nem nyit új pozíciót.' : null,
    snapshot.dailyLossLimitReached ? 'Napi veszteségkorlát elérve.' : null,
    status && !status.worker.alive ? 'A worker nem küld életjelet (30 mp) – a figyelés és a pozíciókezelés állhat.' : null,
    status && status.worker.alive && !status.ml.alive ? 'Az ML SHADOW szolgáltatás nem jelentett állapotot az utolsó percben.' : null,
    status?.ml.streamGapOpen ? 'Nyitott adatfolyam-kiesés az ML adatgyűjtésben.' : null,
    status?.ml.leakageViolations ? `ML szivárgás-ellenőrzés: ${status.ml.leakageViolations} sértés a worker indulása óta.` : null,
    strategy?.mode === 'ML' && (mlCounts.ML_ERROR ?? 0) > 0 ? `${mlCounts.ML_ERROR} ML hibás döntés ma – ellenőrizd a modellt.` : null,
    status?.worker.alive && providerIssues.length ? `Forrás nem aktív: ${providerIssues.map((provider) => provider.label).join(', ')}.` : null,
  ].filter((item): item is string => Boolean(item));
  const rangeLabel = range === 'all' ? 'teljes időszak' : range === '30d' ? 'utolsó 30 nap' : 'utolsó 7 nap';

  return <>
    {header()}

    {snapshot.dailyLossLimitReached && <div className="alert-banner warning" role="alert">
      <strong>A napi veszteségkorlát elérve – a bot ma nem nyit új pozíciót.</strong>
      <span>Mai veszteség: {fmt(snapshot.dailyLoss)} USDC / korlát: {fmt(snapshot.dailyLossLimit)} USDC. A nyitott pozíciók védelme tovább fut; a korlát UTC éjfélkor nullázódik, vagy a <Link className="table-link" href="/settings#risk">Beállításokban</Link> módosíthatod.</span>
    </div>}

    <section className="kpi-grid" aria-label="Számla összefoglaló">
      <Kpi icon={<Wallet size={20} />} label="Számla értéke" value={<>{fmt(equity)} <small>USDC</small></>} tone="brand"
        sub={<span className={`${tone(totalResult)}-value`}>{signed(totalResult, ' USDC')}{totalResultPercent !== null ? ` (${signed(totalResultPercent, '%')})` : ''}</span>} note={`kezdőtőke: ${fmt(initial)} USDC`} />
      <Kpi icon={<CalendarClock size={20} />} label="Mai P&L" value={<span className={`${tone(snapshot.dailyPnl)}-value`}>{signed(snapshot.dailyPnl)} <small>USDC</small></span>} note={`realizált összesen: ${signed(snapshot.realizedPnl)} USDC`} />
      <Kpi icon={<Layers size={20} />} label="Nyitott pozíciók" value={<>{positionRows.length} <small>db</small></>} note={`érték: ${fmt(snapshot.openPositionValue)} USDC · nem realizált: ${signed(snapshot.unrealizedPnl)}`} />
      <Kpi icon={<Brain size={20} />} label="Aktív stratégia" value={strategy?.mode === 'ML' ? 'ML-modell' : 'Alapstratégia'} note={strategy?.mode === 'ML' ? `modell: ${strategy.modelVersion ?? '—'}` : <Link className="table-link" href="/settings#bot">módosítás a Beállításokban</Link>} />
      <Kpi icon={<Target size={20} />} label="Nyerési arány" value={winRate === null ? '—' : <>{fmt(winRate, 0)}<small>%</small></>} note={rangeLabel} />
    </section>

    <section className="dash-grid-main">
      <DashCard title="Eredménygörbe" description={`Kumulált nettó P&L – ${rangeLabel}`} action={<div className="segmented" role="group" aria-label="Időszak">{[['7d', '7 nap'], ['30d', '30 nap'], ['all', 'Mind']].map(([value, text]) => <button key={value} type="button" className={range === value ? 'selected' : ''} aria-pressed={range === value} onClick={() => setRange(value)}>{text}</button>)}</div>}>
        <div className="equity-headline"><span className={`${tone(analyticsData?.totalPnl)}-value`}>{signed(analyticsData?.totalPnl, ' USDC')}</span><small>{analyticsData ? `${fmt(analyticsData.totalTrades, 0)} lezárt kereskedés` : ''}</small></div>
        <EquityCurve points={analyticsData?.equityCurve ?? []} />
      </DashCard>
      <DashCard title="Rendszerállapot" description="Bot, worker, New Launch és ML SHADOW" action={<Link className="card-link" href="/system">Részletek <ArrowRight size={15} aria-hidden="true" /></Link>}>
        <div className="sys-list">
          <div className="sys-row"><span className="sys-label">Bot</span><BotStatusBadge status={bot.botState?.status} /></div>
          <StatusRow label="Worker" tone={!status ? 'neutral' : status.worker.alive ? 'positive' : 'negative'} text={!status ? 'Ismeretlen' : status.worker.alive ? 'Fut' : 'Nem válaszol'} detail={status?.worker.lastHeartbeatAt ? `életjel ${new Date(status.worker.lastHeartbeatAt).toLocaleTimeString('hu-HU')}` : undefined} />
          <StatusRow label="New Launch" tone={newLaunch?.enabled ? (status?.worker.alive ? 'positive' : 'warning') : 'neutral'} text={newLaunch?.enabled ? 'Bekapcsolva' : 'Kikapcsolva'} detail={newLaunch?.enabled ? newLaunch.configVersion : <Link className="table-link" href="/settings#new-launch">bekapcsolás</Link>} />
          <StatusRow label="ML" tone={status?.ml.alive ? 'info' : 'neutral'} text={status?.ml.alive ? (status.ml.mode ?? 'SHADOW') : 'Nincs jelentés'} detail={status?.ml.model?.version ? `modell ${status.ml.model.version}` : undefined} />
          <div className="sys-row"><span className="sys-label">Szabad egyenleg</span><strong>{fmt(snapshot.cash ?? paper.cashBalance)} USDC</strong></div>
          <div className="sys-row"><span className="sys-label">Kitettség · visszaesés</span><strong>{fmt(snapshot.exposure)}% · {fmt(snapshot.drawdown)}%</strong></div>
          <div className="sys-row"><span className="sys-label">Mai jelzések · díjak</span><strong>{signalsToday} · {fmt(snapshot.fees)} USDC</strong></div>
        </div>
        {warnings.length ? <ul className="sys-warnings" aria-label="Kockázati figyelmeztetések">{warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul> : <p className="sys-ok">Nincs aktív figyelmeztetés.</p>}
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
          ? <EmptyState message="Nincs nyitott pozíció. A New Launch modul a feltételeknek megfelelő friss tokenekre nyit pozíciót." />
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
      <DashCard title="Legutóbbi launchok" description="A New Launch figyelés legfrissebb tokenjei" action={<Link className="card-link" href="/new-launch">Összes <ArrowRight size={15} aria-hidden="true" /></Link>}>
        {!status?.newLaunch.recent.length
          ? <EmptyState message={status?.worker.alive ? 'Jelenleg nincs megfigyelt launch.' : 'A launch-lista a worker futásakor frissül.'} />
          : <div className="dash-launches">{status.newLaunch.recent.map((launch) => <Link key={launch.mint} className="dash-launch" href={`/tokens/${launch.mint}`}>
            <TokenLabel address={launch.mint} symbol={launch.symbol ?? shortAddress(launch.mint)} />
            <span className="muted">{formatAge(launch.ageSeconds)}</span>
            <span className="mono">{formatTokenPrice(launch.priceUsd)}</span>
            <span>{formatCompactUsd(launch.liquidityUsd)}</span>
            {launch.decision ? <StatusBadge tone={LAUNCH_DECISION[launch.decision].tone}>{LAUNCH_DECISION[launch.decision].text}</StatusBadge> : <StatusBadge>ÚJ</StatusBadge>}
          </Link>)}</div>}
      </DashCard>
      <DashCard title="ML és adatgyűjtés" description="Mai ML döntések és a tanítóadat-gyűjtés" action={<Link className="card-link" href="/machine-learning">ML oldal <ArrowRight size={15} aria-hidden="true" /></Link>}>
        <div className="ml-counts">
          <div><span>ML BUY</span><strong className="up">{mlCounts.ML_BUY ?? 0}</strong></div>
          <div><span>ML SKIP</span><strong>{mlCounts.ML_SKIP ?? 0}</strong></div>
          <div><span>ML ERROR</span><strong className={(mlCounts.ML_ERROR ?? 0) > 0 ? 'down' : ''}>{mlCounts.ML_ERROR ?? 0}</strong></div>
          <div><span>Snapshot (24 ó)</span><strong>{status ? fmt(status.ml.snapshots24h, 0) : '—'}</strong></div>
        </div>
        <p className="muted dash-note">{strategy?.mode === 'ML' ? 'Az ML-modell dönt a belépésekről.' : 'Az alapstratégia aktív: ML döntés csak ML stratégia mellett születik, az adatgyűjtés ettől függetlenül fut.'}</p>
        <div className="diag-links"><Link href="/system">Rendszerállapot</Link><Link href="/logs">Naplók</Link><Link href="/machine-learning">ML diagnosztika</Link><Link href="/analytics">Analitika</Link></div>
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

