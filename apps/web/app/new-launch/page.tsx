'use client';
/* eslint-disable @typescript-eslint/no-explicit-any */
import { Ban, CheckCircle2, Eye, Layers, Radar, Timer } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import { TokenAvatar } from '../avatars';
import { DataTable, date, EmptyState, ErrorState, fmt, formatPrice, LoadingState, Metric, PageHeader, Panel, Stacked, Status, useApi } from '../components';
import { useRealtimeEvents } from '../hooks/useRealtimeEvents';
import { launchReasons, PROVIDER_STATUS_LABELS } from '../locales/position-labels';

const SOURCE_LABELS: Record<string, string> = { PUMP_FUN: 'Pump.fun', RAYDIUM: 'Raydium', METEORA: 'Meteora' };
const DECISION_TONE: Record<string, string> = { BUY: 'positive', WATCH: 'warning', REJECT: 'negative' };
const DECISION_LABEL: Record<string, string> = { BUY: 'VÉTEL', WATCH: 'FIGYELÉS', REJECT: 'ELUTASÍTVA' };

function age(seconds: number | null | undefined) {
  if (seconds == null) return '—';
  if (seconds < 60) return `${seconds} mp`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} p ${seconds % 60} mp`;
  return `${Math.floor(seconds / 3600)} ó ${Math.floor((seconds % 3600) / 60)} p`;
}

const usd = (value: number | null | undefined) => (value == null ? '—' : `$${fmt(value, 0)}`);

/** Compact social / on-chain confirmation labels (MONITOR_ONLY observation, not a trade signal). */
const SOCIAL_CONFIRMATION_SHORT: Record<string, string> = {
  STRONG_CONFIRMATION: 'erős megerősítés', MODERATE_CONFIRMATION: 'mérsékelt megerősítés', SOCIAL_LEADING: 'közösségi vezet', ONCHAIN_LEADING: 'on-chain vezet',
  DIVERGENCE: 'eltérés', SOCIAL_ONLY_HYPE: 'csak közösségi hype', WEAK_ACTIVITY: 'gyenge aktivitás', UNKNOWN: 'ismeretlen',
};

export default function NewLaunchPage() {
  const router = useRouter();
  const { data, error, loading, refresh } = useApi<{ data: any }>('/api/new-launch');
  const { lastEvent } = useRealtimeEvents(['launch_update']);
  const [filter, setFilter] = useState<'ALL' | 'BUY' | 'WATCH' | 'REJECT'>('ALL');
  useEffect(() => { if (lastEvent) refresh(); }, [lastEvent, refresh]);
  const header = <PageHeader eyebrow="Piacok" title="Új tokenek / Sniper" subtitle="Frissen indult Solana tokenek valós idejű észlelése, megfigyelése és PAPER döntései" action={<Status tone="warning">CSAK PAPER</Status>} />;
  if (loading && !data) return <>{header}<LoadingState /></>;
  if (error && !data) return <>{header}<ErrorState message={error} /></>;
  const d = data?.data;
  const launches: any[] = d?.launches ?? [];
  const rows = filter === 'ALL' ? launches : launches.filter((row) => row.decision === filter);
  const open = (row: any) => router.push(row.positionId ? `/positions/${row.positionId}` : `/tokens/${row.mint}`);
  const stats = d?.stats ?? {};

  return <>
    {header}
    {!d?.enabled ? <p className="inline-message">Az Új token / Sniper stratégia ki van kapcsolva. A figyelés fut, de vétel nem történik — kapcsold be a <Link href="/settings#new-launch">Beállításokban</Link>.</p> : null}
    <section className="metric-grid">
      <Metric icon={<Radar size={20} />} label="Ma észlelt" value={fmt(stats.detectedToday ?? 0, 0)} note="új launch a forrásokból" />
      <Metric icon={<Eye size={20} />} label="Figyelés alatt" value={fmt(stats.watching ?? 0, 0)} note="feltételre vár" />
      <Metric icon={<CheckCircle2 size={20} />} label="Vételre alkalmas" value={fmt(stats.eligible ?? 0, 0)} tone={stats.eligible ? 'positive-value' : ''} note="minden feltétel teljesült" />
      <Metric icon={<Ban size={20} />} label="Elutasítva" value={fmt(stats.rejected ?? 0, 0)} note="biztonsági vagy launch ok" />
      <Metric icon={<Layers size={20} />} label="Nyitott PAPER pozíció" value={fmt(stats.paperPositions ?? 0, 0)} note="Új token forrásból" />
      <Metric icon={<Timer size={20} />} label="Átlagos észlelési késés" value={stats.averageDetectionLatencyMs == null ? '—' : `${fmt(stats.averageDetectionLatencyMs / 1000, 1)} mp`} note="létrehozás → észlelés" />
    </section>

    <Panel title="Forrás szolgáltatók" description="Csak a valóban bekötött források jelennek meg aktívként.">
      <div className="provider-list">
        {(d?.providers ?? []).length === 0 ? <span className="annotation" style={{ margin: 0 }}>A worker még nem jelentett szolgáltató-állapotot (fut a worker?).</span> : null}
        {(d?.providers ?? []).map((provider: any) => {
          const status = PROVIDER_STATUS_LABELS[provider.status] ?? { label: provider.status, tone: 'neutral' };
          return <div key={provider.source} className="provider-item">
            <strong>{provider.label}</strong>
            <Status tone={status.tone}>{status.label}</Status>
            <small>{provider.events ? `${fmt(provider.events, 0)} esemény` : ''}{provider.lastEventAt ? ` · utolsó: ${new Date(provider.lastEventAt).toLocaleTimeString('hu-HU')}` : ''}{provider.detail ? ` · ${provider.detail}` : ''}</small>
          </div>;
        })}
      </div>
      <p className="annotation">Frissítve: {d?.updatedAt ? date(d.updatedAt) : '—'}</p>
    </Panel>

    <Panel title="Észlelt launchok" description="Kattints egy sorra a token részleteihez (vagy a nyitott pozícióhoz).">
      <div className="segmented" role="group" aria-label="Döntés szűrő" style={{ marginBottom: 12 }}>
        {(['ALL', 'BUY', 'WATCH', 'REJECT'] as const).map((key) => <button key={key} type="button" className={filter === key ? 'selected' : ''} aria-pressed={filter === key} onClick={() => setFilter(key)}>{key === 'ALL' ? 'Mind' : DECISION_LABEL[key]}</button>)}
      </div>
      {rows.length === 0 ? <EmptyState message="Jelenleg nincs megfigyelt launch ebben a szűrőben." /> : <>
        <div className="launch-table">
          <DataTable wide headers={['Token', 'Forrás', 'Életkor', 'Ár', 'Likviditás', 'Forgalom', 'Vétel / eladás', 'Egyedi vevők', 'Launch Score', 'Közösségi', 'Kockázat', 'Döntés', 'Indok']}>{rows.map((row) => (
            <tr key={row.mint} className="clickable-row" onClick={() => open(row)}>
              <td><Link className="row-link" href={row.positionId ? `/positions/${row.positionId}` : `/tokens/${row.mint}`} onClick={(event) => event.stopPropagation()} title={row.mint}><Stacked top={<span className="token-label"><TokenAvatar address={row.mint} symbol={row.symbol} size={22} /><strong>{row.symbol ?? `${row.mint.slice(0, 6)}…`}</strong></span>} bottom={row.name ?? `${row.mint.slice(0, 4)}…${row.mint.slice(-4)}`} /></Link></td>
              <td>{SOURCE_LABELS[row.source] ?? row.source}{row.migrated ? ' · migrált' : ''}</td>
              <td>{age(row.ageSeconds)}</td>
              <td>{formatPrice(row.priceUsd)}</td>
              <td>{usd(row.liquidityUsd)}</td>
              <td>{usd(row.volumeUsd)}</td>
              <td>{row.buyCount ?? '—'} / {row.sellCount ?? '—'}</td>
              <td>{row.uniqueBuyers ?? 'Ismeretlen'}</td>
              <td>{row.score ?? '—'}</td>
              <td>{row.social && row.social.socialScore != null ? <Stacked top={<span title="Social Score · lendület · spam (megfigyelés, nem kereskedési jel)">{row.social.socialScore} · M{row.social.momentum ?? '—'} · S{row.social.spam ?? '—'}</span>} bottom={SOCIAL_CONFIRMATION_SHORT[row.social.confirmation] ?? row.social.confirmation} /> : <span className="sfield-help">—</span>}</td>
              <td>{row.riskScore == null ? '—' : <Stacked top={fmt(row.riskScore, 0)} bottom={row.riskClassification} />}</td>
              <td>{row.positionId ? <Status tone="positive">POZÍCIÓ</Status> : row.decision ? <Status tone={DECISION_TONE[row.decision]}>{DECISION_LABEL[row.decision]}</Status> : <Status>ÚJ</Status>}</td>
              <td className="launch-reason">{launchReasons(row.reasons).slice(0, 2).join(', ') || '—'}</td>
            </tr>
          ))}</DataTable>
        </div>
        <div className="launch-cards">
          {rows.map((row) => (
            <button type="button" key={row.mint} className="launch-card" onClick={() => open(row)}>
              <div className="launch-card-head">
                <span className="token-label"><TokenAvatar address={row.mint} symbol={row.symbol} size={22} /><strong>{row.symbol ?? `${row.mint.slice(0, 6)}…`}</strong></span>
                {row.positionId ? <Status tone="positive">POZÍCIÓ</Status> : row.decision ? <Status tone={DECISION_TONE[row.decision]}>{DECISION_LABEL[row.decision]}</Status> : <Status>ÚJ</Status>}
              </div>
              <span>{SOURCE_LABELS[row.source] ?? row.source} · {age(row.ageSeconds)} · Score {row.score ?? '—'}</span>
              <span>Likv. {usd(row.liquidityUsd)} · Forg. {usd(row.volumeUsd)} · {row.buyCount ?? '—'}/{row.sellCount ?? '—'} tx · {row.uniqueBuyers ?? '?'} vevő</span>
              <small>{launchReasons(row.reasons).slice(0, 2).join(', ') || '—'}</small>
            </button>
          ))}
        </div>
      </>}
      <p className="annotation">Ismeretlen eladhatóság soha nem számít biztonságosnak: ilyenkor a döntés FIGYELÉS. Vakon vásárlás nincs; a kemény biztonsági tiltások nem kerülhetők meg.</p>
    </Panel>
  </>;
}
