'use client';
/* eslint-disable @typescript-eslint/no-explicit-any */
import { Coins, ListChecks, Target, TrendingUp } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { TokenLabel } from '../avatars';
import { DataTable, date, EmptyState, ErrorState, fmt, formatPrice, LoadingState, ModeBadge, PageHeader, Panel, Stacked, useApi } from '../components';
import { exitReasonLabel } from '../locales/hu';
import { decisionBadge } from '../locales/position-labels';
import { Kpi } from '../ui-cards';

function numeric(value: any) {
	if (value == null) return null;
	const parsed = typeof value?.toNumber === 'function' ? value.toNumber() : Number(value);
	return Number.isFinite(parsed) ? parsed : null;
}

const FILTER_LABELS: Record<string, string> = { ALL: 'Mind', TODAY: 'Ma', WIN: 'Nyerő', LOSS: 'Veszteséges', STRATEGY: 'Stratégia', AI: 'AI', NEW_LAUNCH: 'Új token', MANUAL_PAPER: 'Manuális', BUY: 'Vétel', SELL: 'Eladás', '7D': '7 nap', '30D': '30 nap' };
const signedUsd = (value: number) => `${value > 0 ? '+' : ''}${fmt(value)} USDC`;

export default function TradesPage() {
	const router = useRouter();
	const { data, error, loading } = useApi<{ data: any[] }>('/api/trades');
	const [side, setSide] = useState('ALL');
	const [outcome, setOutcome] = useState('ALL');
	const [period, setPeriod] = useState('ALL');
	const [source, setSource] = useState('ALL');
	const header = <PageHeader eyebrow="Végrehajtási előzmények" title="Kereskedések" subtitle="A fiókod végrehajtott és nyitott PAPER megbízásai – kattints egy sorra a részletekért" />;
	if (loading && !data) return <>{header}<LoadingState /></>;
	if (error && !data) return <>{header}<ErrorState message={error} /></>;
	const rows = data?.data ?? [];
	const cutoff = period === 'TODAY' ? new Date().setHours(0, 0, 0, 0) : period === '7D' ? Date.now() - 7 * 86400000 : period === '30D' ? Date.now() - 30 * 86400000 : 0;
	const visibleRows = rows.filter((row: any) => {
		const pnl = numeric(row.netPnl);
		const timestamp = new Date(row.entryAt ?? row.createdAt).getTime();
		return (source === 'ALL' || (row.decisionSource ?? 'STRATEGY') === source) && (side === 'ALL' || row.side === side) && (outcome === 'ALL' || (outcome === 'WIN' && pnl !== null && pnl > 0) || (outcome === 'LOSS' && pnl !== null && pnl < 0)) && (!cutoff || timestamp >= cutoff);
	});
	const closed = visibleRows.filter((row: any) => numeric(row.netPnl) !== null);
	const netPnl = closed.reduce((sum: number, row: any) => sum + (numeric(row.netPnl) ?? 0), 0);
	const wins = closed.filter((row: any) => (numeric(row.netPnl) ?? 0) > 0).length;
	const costs = visibleRows.reduce((sum: number, row: any) => sum + (numeric(row.fees) ?? 0) + (numeric(row.slippage) ?? 0), 0);
	const filters = (label: string, values: string[], value: string, onChange: (next: string) => void) => <div className="filter-field">
		<span className="filter-field-label">{label}</span>
		<div className="segmented" role="group" aria-label={label}>{values.map((item) => <button type="button" key={item} className={value === item ? 'selected' : ''} aria-pressed={value === item} onClick={() => onChange(item)}>{FILTER_LABELS[item] ?? item}</button>)}</div>
	</div>;

	return <>
		{header}
		<section className="kpi-grid" aria-label="Kereskedési összefoglaló (a szűrőknek megfelelően)">
			<Kpi icon={<ListChecks size={20} />} label="Kereskedések" value={<>{visibleRows.length} <small>db</small></>} note={`${closed.length} lezárt · ${visibleRows.length - closed.length} nyitott`} />
			<Kpi icon={<TrendingUp size={20} />} label="Nettó P&L" value={<span className={netPnl > 0 ? 'positive-value' : netPnl < 0 ? 'negative-value' : ''}>{closed.length ? signedUsd(netPnl) : '—'}</span>} note="lezárt kereskedések, díjak után" />
			<Kpi icon={<Target size={20} />} label="Nyerési arány" value={closed.length ? <>{fmt(wins / closed.length * 100, 0)}<small>%</small></> : '—'} note={closed.length ? `${wins} nyerő · ${closed.length - wins} vesztes` : 'még nincs lezárt kereskedés'} />
			<Kpi icon={<Coins size={20} />} label="Költségek" value={<>{fmt(costs)} <small>USDC</small></>} note="díjak + csúszás (a nettóban benne)" />
		</section>

		<Panel title="Kereskedési előzmények" description="A fenti számok a kiválasztott szűrőkre vonatkoznak.">
			<div className="filter-bar">
				{filters('Döntési forrás', ['ALL', 'STRATEGY', 'AI', 'NEW_LAUNCH', 'MANUAL_PAPER'], source, setSource)}
				{filters('Időszak', ['ALL', 'TODAY', '7D', '30D'], period, setPeriod)}
				{filters('Eredmény', ['ALL', 'WIN', 'LOSS'], outcome, setOutcome)}
				{filters('Irány', ['ALL', 'BUY', 'SELL'], side, setSide)}
			</div>
			{visibleRows.length === 0 ? <EmptyState message={rows.length ? 'Nincs a szűrőknek megfelelő kereskedés.' : 'Még nincs kereskedés.'} /> : <DataTable wide headers={['Időpont', 'Token', 'Belépés → kilépés', 'Érték', 'Költségek', 'Nettó P&L', 'Kilépés oka', 'Állapot']}>
				{visibleRows.map((row: any) => {
					const pnl = numeric(row.netPnl);
					return <tr key={row.id} className="clickable-row" onClick={() => router.push(`/trades/${row.id}`)}>
						<td>{date(row.entryAt ?? row.createdAt)}</td>
						<td><Stacked top={<Link className="row-link" href={`/trades/${row.id}`} onClick={(event) => event.stopPropagation()}><TokenLabel address={row.tokenAddress} symbol={row.symbol ?? row.tokenAddress ?? '—'} /></Link>} bottom={<span className={`source-badge source-${String(row.decisionSource ?? 'strategy').toLowerCase()}`}>{row.strategyName === 'MANUAL_PAPER' ? 'KÉZI' : decisionBadge(row.decisionSource, row.strategyName)}</span>} /></td>
						<td><Stacked top={formatPrice(numeric(row.entry))} bottom={row.exit == null ? 'nyitott' : `→ ${formatPrice(numeric(row.exit))}`} /></td>
						<td><Stacked top={`${fmt(numeric(row.size))} USDC`} bottom={`${fmt(numeric(row.quantity), 0)} db`} /></td>
						<td><Stacked top={`díj ${fmt(numeric(row.fees))}`} bottom={`csúszás ${fmt(numeric(row.slippage))}`} /></td>
						<td className={pnl === null ? '' : pnl >= 0 ? 'positive-value' : 'negative-value'}>{pnl === null ? '—' : signedUsd(pnl)}</td>
						<td>{exitReasonLabel(row.exitReason)}</td>
						<td><Stacked top={row.status === 'OPEN' ? 'Nyitott' : row.status === 'CLOSED' ? 'Lezárt' : row.status} bottom={<ModeBadge mode={row.mode} />} /></td>
					</tr>;
				})}
			</DataTable>}
		</Panel>
	</>;
}
