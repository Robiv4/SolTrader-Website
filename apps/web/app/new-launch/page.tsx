'use client';

import { ArrowDown, ArrowUp } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';

import { TokenAvatar } from '../avatars';
import { EmptyState, ErrorState, fmt, PageHeader, useApi } from '../components';
import { useRealtimeEvents } from '../hooks/useRealtimeEvents';
import { launchReasons, PROVIDER_STATUS_LABELS } from '../locales/position-labels';
import { FilterBar, formatAge, formatCompactUsd, formatTokenPrice, Segmented, shortAddress, SkeletonRows, StatusBadge, type Tone } from '../ui/primitives';

interface LaunchRow {
  mint: string;
  source: string;
  symbol: string | null;
  name: string | null;
  detectedAt: string;
  ageSeconds: number | null;
  priceUsd: number | null;
  liquidityUsd: number | null;
  volumeUsd: number | null;
  buyCount: number | null;
  sellCount: number | null;
  uniqueBuyers: number | null;
  migrated?: boolean;
  decision: 'BUY' | 'WATCH' | 'REJECT' | null;
  score: number | null;
  riskScore: number | null;
  riskClassification: string | null;
  reasons: unknown;
  positionId: string | null;
}

interface Provider { source: string; label: string; status: string; events?: number; lastEventAt?: string | null; detail?: string | null }

interface NewLaunchData {
  enabled: boolean;
  updatedAt: string | null;
  providers: Provider[];
  stats: { detectedToday: number; watching: number; eligible: number; rejected: number; paperPositions: number; averageDetectionLatencyMs: number | null };
  launches: LaunchRow[];
}

type DecisionFilter = 'ALL' | 'BUY' | 'WATCH' | 'REJECT' | 'POSITION' | 'NEW';
type SortKey = 'age' | 'liquidity' | 'volume' | 'score' | 'risk' | 'txs';

const SOURCE_LABELS: Record<string, string> = { PUMP_FUN: 'Pump.fun', RAYDIUM: 'Raydium', METEORA: 'Meteora' };
const DECISION_INFO: Record<string, { text: string; tone: Tone }> = { BUY: { text: 'VÉTEL', tone: 'positive' }, WATCH: { text: 'FIGYELÉS', tone: 'warning' }, REJECT: { text: 'ELUTASÍTVA', tone: 'negative' } };
/** Launches younger than this are highlighted as fresh. */
const FRESH_SECONDS = 60;
/** Fallback refresh when no realtime event arrives (the worker republishes the live list every few seconds). */
const POLL_MS = 5_000;

const SORT_LABELS: Record<SortKey, string> = { age: 'Életkor', liquidity: 'Likviditás', volume: 'Forgalom', score: 'Score', risk: 'Kockázat', txs: 'Tranzakciók' };

function sortValue(row: LaunchRow, key: SortKey): number | null {
  switch (key) {
    case 'age': return row.ageSeconds;
    case 'liquidity': return row.liquidityUsd;
    case 'volume': return row.volumeUsd;
    case 'score': return row.score;
    case 'risk': return row.riskScore;
    case 'txs': return row.buyCount === null && row.sellCount === null ? null : (row.buyCount ?? 0) + (row.sellCount ?? 0);
  }
}

function decisionBadge(row: LaunchRow) {
  if (row.positionId) return <StatusBadge tone="info">POZÍCIÓ</StatusBadge>;
  if (row.decision) return <StatusBadge tone={DECISION_INFO[row.decision].tone}>{DECISION_INFO[row.decision].text}</StatusBadge>;
  return <StatusBadge>ÚJ</StatusBadge>;
}

function matchesFilter(row: LaunchRow, filter: DecisionFilter) {
  if (filter === 'ALL') return true;
  if (filter === 'POSITION') return Boolean(row.positionId);
  if (filter === 'NEW') return !row.decision;
  return row.decision === filter;
}

function riskTone(value: number | null): string {
  if (value === null) return '';
  return value >= 70 ? 'down' : value <= 40 ? 'up' : '';
}

export default function NewLaunchPage() {
  const router = useRouter();
  const { data, error, loading, refresh } = useApi<{ data: NewLaunchData }>('/api/new-launch');
  const { lastEvent, connectionState } = useRealtimeEvents(['launch_update']);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<DecisionFilter>('ALL');
  const [source, setSource] = useState<string>('ALL');
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'age', desc: false });
  const [showProviders, setShowProviders] = useState(false);

  useEffect(() => { if (lastEvent) refresh(); }, [lastEvent, refresh]);
  useEffect(() => {
    const timer = globalThis.setInterval(() => { if (globalThis.document.visibilityState === 'visible') refresh(); }, POLL_MS);
    return () => globalThis.clearInterval(timer);
  }, [refresh]);

  const d = data?.data;
  const launches = useMemo(() => d?.launches ?? [], [d]);
  const sources = useMemo(() => [...new Set(launches.map((row) => row.source))].sort(), [launches]);
  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = launches.filter((row) => matchesFilter(row, filter)
      && (source === 'ALL' || row.source === source)
      && (!needle || row.mint.toLowerCase().includes(needle) || (row.symbol ?? '').toLowerCase().includes(needle) || (row.name ?? '').toLowerCase().includes(needle)));
    return filtered.sort((a, b) => {
      const av = sortValue(a, sort.key);
      const bv = sortValue(b, sort.key);
      if (av === null && bv === null) return 0;
      if (av === null) return 1; // unknown values always last
      if (bv === null) return -1;
      return sort.desc ? bv - av : av - bv;
    });
  }, [launches, query, filter, source, sort]);

  const counts = useMemo(() => {
    const result: Record<DecisionFilter, number> = { ALL: launches.length, BUY: 0, WATCH: 0, REJECT: 0, POSITION: 0, NEW: 0 };
    for (const row of launches) {
      if (row.positionId) result.POSITION += 1;
      if (row.decision) result[row.decision] += 1; else result.NEW += 1;
    }
    return result;
  }, [launches]);

  const open = (row: LaunchRow) => router.push(`/tokens/${row.mint}`);
  const toggleSort = (key: SortKey) => setSort((current) => current.key === key ? { key, desc: !current.desc } : { key, desc: key !== 'age' && key !== 'risk' });
  const sortHeader = (key: SortKey, text = SORT_LABELS[key]) => <th scope="col" aria-sort={sort.key === key ? (sort.desc ? 'descending' : 'ascending') : 'none'}>
    <button type="button" className={`th-sort${sort.key === key ? ' active' : ''}`} onClick={() => toggleSort(key)}>
      {text}{sort.key === key ? (sort.desc ? <ArrowDown size={12} aria-hidden="true" /> : <ArrowUp size={12} aria-hidden="true" />) : null}
    </button>
  </th>;

  const stats = d?.stats;
  const live = connectionState === 'OPEN';
  const updatedSeconds = d?.updatedAt ? Math.max(0, Math.round((Date.now() - Date.parse(d.updatedAt)) / 1000)) : null;
  const stale = updatedSeconds === null || updatedSeconds > 30;
  const header = <PageHeader eyebrow="Kereskedés" title="Új tokenek" subtitle="Frissen indult Solana tokenek valós idejű észlelése és PAPER döntései" action={<StatusBadge tone="warning">CSAK PAPER</StatusBadge>} />;

  if (loading && !d) return <>{header}<section className="tcard"><SkeletonRows rows={8} columns={6} /></section></>;
  if (error && !d) return <>{header}<ErrorState message={error} /></>;

  return <>
    {header}
    {d && !d.enabled ? <p className="notice notice-warning"><span>Az Új token stratégia ki van kapcsolva: a figyelés fut, de PAPER vétel nem történik. Bekapcsolás: <Link href="/settings#new-launch">Beállítások</Link>.</span></p> : null}

    <section className="nl-stats" aria-label="Mai összesítő">
      <div><span>Ma észlelt</span><strong>{fmt(stats?.detectedToday ?? 0, 0)}</strong></div>
      <div><span>Vételre alkalmas</span><strong className={stats?.eligible ? 'up' : ''}>{fmt(stats?.eligible ?? 0, 0)}</strong></div>
      <div><span>Figyelés</span><strong>{fmt(stats?.watching ?? 0, 0)}</strong></div>
      <div><span>Elutasítva</span><strong>{fmt(stats?.rejected ?? 0, 0)}</strong></div>
      <div><span>Nyitott PAPER</span><strong>{fmt(stats?.paperPositions ?? 0, 0)}</strong></div>
      <div><span>Átl. észlelési késés</span><strong>{stats?.averageDetectionLatencyMs == null ? '—' : `${fmt(stats.averageDetectionLatencyMs / 1000, 1)} mp`}</strong></div>
      <div className="nl-live">
        <StatusBadge tone={stale ? 'warning' : live ? 'positive' : 'info'} dot>{stale ? 'Nem friss' : live ? 'Élő' : 'Frissítés 5 mp-enként'}</StatusBadge>
        <button type="button" className="link-button" onClick={() => setShowProviders((value) => !value)} aria-expanded={showProviders}>Források ({d?.providers.length ?? 0})</button>
      </div>
    </section>

    {showProviders ? <section className="tcard nl-providers" aria-label="Forrás szolgáltatók">
      {(d?.providers ?? []).length === 0 ? <small className="muted">A worker még nem jelentett szolgáltató-állapotot (fut a worker?).</small> : null}
      {(d?.providers ?? []).map((provider) => {
        const status = PROVIDER_STATUS_LABELS[provider.status] ?? { label: provider.status, tone: 'neutral' };
        return <div key={provider.source} className="nl-provider">
          <strong>{provider.label}</strong>
          <StatusBadge tone={status.tone as Tone}>{status.label}</StatusBadge>
          <small className="muted">{provider.events ? `${fmt(provider.events, 0)} esemény` : ''}{provider.lastEventAt ? ` · utolsó: ${new Date(provider.lastEventAt).toLocaleTimeString('hu-HU')}` : ''}{provider.detail ? ` · ${provider.detail}` : ''}</small>
        </div>;
      })}
      <small className="muted">Lista frissítve: {d?.updatedAt ? new Date(d.updatedAt).toLocaleTimeString('hu-HU') : '—'}</small>
    </section> : null}

    <section className="tcard nl-card">
      <FilterBar<DecisionFilter> query={query} onQuery={setQuery} placeholder="Keresés név, ticker vagy mint alapján"
        chips={[
          { id: 'ALL', label: 'Mind', count: counts.ALL },
          { id: 'BUY', label: 'Vétel', count: counts.BUY },
          { id: 'WATCH', label: 'Figyelés', count: counts.WATCH },
          { id: 'REJECT', label: 'Elutasítva', count: counts.REJECT },
          { id: 'POSITION', label: 'Pozíció', count: counts.POSITION },
          { id: 'NEW', label: 'Értékelés nélkül', count: counts.NEW },
        ]} activeChip={filter} onChip={setFilter}>
        {sources.length > 1 ? <Segmented label="Forrás" value={source} onChange={setSource} options={[{ id: 'ALL', label: 'Minden forrás' }, ...sources.map((id) => ({ id, label: SOURCE_LABELS[id] ?? id }))]} /> : null}
      </FilterBar>

      {rows.length === 0 ? <EmptyState message={launches.length === 0 ? 'Jelenleg nincs megfigyelt launch. A lista a worker futásakor néhány másodpercenként frissül.' : 'Nincs a szűrésnek megfelelő token.'} /> : <>
        <div className="nl-table-wrap">
          <table className="nl-table">
            <thead><tr>
              <th scope="col">Token</th>
              <th scope="col" className="num">Ár</th>
              {sortHeader('age')}
              {sortHeader('liquidity')}
              {sortHeader('volume')}
              {sortHeader('txs', 'Vétel / eladás')}
              {sortHeader('score')}
              {sortHeader('risk')}
              <th scope="col">Döntés</th>
            </tr></thead>
            <tbody>{rows.map((row) => {
              const fresh = row.ageSeconds !== null && row.ageSeconds < FRESH_SECONDS;
              const reasons = launchReasons(row.reasons).slice(0, 2).join(', ');
              return <tr key={row.mint} className={fresh ? 'fresh' : undefined} onClick={() => open(row)}>
                <td>
                  <Link className="nl-token" href={`/tokens/${row.mint}`} onClick={(event) => event.stopPropagation()} title={`${row.name ?? ''} ${row.mint}`.trim()}>
                    <TokenAvatar address={row.mint} symbol={row.symbol ?? row.mint} size={26} />
                    <span className="nl-token-text">
                      <strong>{row.symbol ?? shortAddress(row.mint)}</strong>
                      <small>{SOURCE_LABELS[row.source] ?? row.source}{row.migrated ? ' · migrált' : ''} · {shortAddress(row.mint)}</small>
                    </span>
                    {fresh ? <span className="nl-fresh">ÚJ</span> : null}
                  </Link>
                </td>
                <td className="num mono">{formatTokenPrice(row.priceUsd)}</td>
                <td className="num">{formatAge(row.ageSeconds)}</td>
                <td className="num">{formatCompactUsd(row.liquidityUsd)}</td>
                <td className="num">{formatCompactUsd(row.volumeUsd)}</td>
                <td className="num"><span className="up">{row.buyCount ?? '—'}</span> / <span className="down">{row.sellCount ?? '—'}</span></td>
                <td className="num">{row.score ?? '—'}</td>
                <td className={`num ${riskTone(row.riskScore)}`} title={row.riskClassification ?? undefined}>{row.riskScore === null ? '—' : fmt(row.riskScore, 0)}</td>
                <td title={reasons || undefined}>{decisionBadge(row)}</td>
              </tr>;
            })}</tbody>
          </table>
        </div>

        <div className="nl-cards">
          {rows.map((row) => {
            const fresh = row.ageSeconds !== null && row.ageSeconds < FRESH_SECONDS;
            return <button type="button" key={row.mint} className={`nl-mobile${fresh ? ' fresh' : ''}`} onClick={() => open(row)}>
              <span className="nl-mobile-head">
                <span className="nl-token"><TokenAvatar address={row.mint} symbol={row.symbol ?? row.mint} size={26} /><span className="nl-token-text"><strong>{row.symbol ?? shortAddress(row.mint)}</strong><small>{SOURCE_LABELS[row.source] ?? row.source} · {formatAge(row.ageSeconds)}</small></span></span>
                {decisionBadge(row)}
              </span>
              <span className="nl-mobile-grid">
                <span><small>Ár</small><b className="mono">{formatTokenPrice(row.priceUsd)}</b></span>
                <span><small>Likviditás</small><b>{formatCompactUsd(row.liquidityUsd)}</b></span>
                <span><small>Forgalom</small><b>{formatCompactUsd(row.volumeUsd)}</b></span>
                <span><small>Score / kockázat</small><b>{row.score ?? '—'} / <span className={riskTone(row.riskScore)}>{row.riskScore === null ? '—' : fmt(row.riskScore, 0)}</span></b></span>
              </span>
            </button>;
          })}
        </div>
        <small className="muted nl-foot">{rows.length} / {launches.length} token · Ismeretlen eladhatóság soha nem számít biztonságosnak (FIGYELÉS). Minden vétel szimulált (PAPER).</small>
      </>}
    </section>
  </>;
}
