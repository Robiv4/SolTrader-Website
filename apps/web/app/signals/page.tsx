'use client';
/* eslint-disable @typescript-eslint/no-explicit-any */
import { Ban, CheckCircle2, Radar, Sparkles } from 'lucide-react';
import { useState } from 'react';

import { TokenAvatar } from '../avatars';
import { date, EmptyState, ErrorState, fmt, LoadingState, ModeBadge, PageHeader, Panel, Status, useApi } from '../components';
import { describeReasons, label } from '../locales/hu';
import { Kpi } from '../ui-cards';

function numeric(value: any) {
	if (value == null) return null;
	const parsed = typeof value?.toNumber === 'function' ? value.toNumber() : Number(value);
	return Number.isFinite(parsed) ? parsed : null;
}

function asList(value: unknown): string[] {
	if (Array.isArray(value)) return value.map((item) => typeof item === 'string' ? item : JSON.stringify(item));
	return typeof value === 'string' && value ? [value] : [];
}

export default function SignalsPage() {
	const { data, error, loading } = useApi<{ data: any[] }>('/api/signals');
	const [direction, setDirection] = useState('ALL');
	if (loading && !data) return <><PageHeader eyebrow="Felfedezés" title="Jelzések" /><LoadingState /></>;
	if (error && !data) return <><PageHeader eyebrow="Felfedezés" title="Jelzések" /><ErrorState message={error} /></>;
	const rows = data?.data ?? [];
	const visibleRows = rows.filter((row) => direction === 'ALL' || row.direction === direction);
	const todayCount = rows.filter((row: any) => row.createdAt && new Date(row.createdAt).toDateString() === new Date().toDateString()).length;
	const executedCount = rows.filter((row: any) => row.outcome?.status === 'EXECUTED').length;
	const rejectedCount = rows.filter((row: any) => row.outcome?.status === 'REJECTED' || row.outcome?.status === 'BLOCKED').length;
	return <>
		<PageHeader eyebrow="Felfedezés" title="Jelzések" subtitle="Stratégiák által létrehozott lehetőségek és indoklásuk" />
		<section className="kpi-grid" aria-label="Jelzés összefoglaló">
			<Kpi icon={<Radar size={20} />} label="Jelzések" value={<>{rows.length} <small>db</small></>} note="a legutóbbi jelzések listája" />
			<Kpi icon={<Sparkles size={20} />} label="Ma" value={<>{todayCount} <small>db</small></>} note="ma létrehozott jelzés" />
			<Kpi icon={<CheckCircle2 size={20} />} label="Megvéve" value={<span className="positive-value">{executedCount}</span>} note="vétellé vált jelzés" />
			<Kpi icon={<Ban size={20} />} label="Elutasítva / blokkolva" value={rejectedCount} note="a kockázati vagy számlaszabályok miatt" />
		</section>
		<Panel title="Jelzésfolyam" className="signal-feed-panel" description="Minden kártyán látszik a bot döntése és a „Miért ez a jelzés?” indoklás.">
			<div className="filter-field"><span className="filter-field-label">Irány</span><div className="segmented" role="group" aria-label="Jelzések szűrése irány szerint">{['ALL', 'BUY', 'SELL', 'WATCH'].map((item) => <button type="button" key={item} className={direction === item ? 'selected' : ''} aria-pressed={direction === item} onClick={() => setDirection(item)}>{item === 'ALL' ? 'Mind' : label(item)}</button>)}</div></div>
			{visibleRows.length === 0 ? <EmptyState message={rows.length ? 'Nincs ilyen irányú jelzés.' : 'Még nincs jelzés. Kapcsolj be stratégiát, és indítsd el a botot.'} /> : <div className="signal-grid">{visibleRows.map((row: any) => {
				const score = numeric(row.score);
				const risk = numeric(row.riskScore);
				const reasons = [...asList(row.reasons), ...asList(row.entryConditions)];
				const directionName = row.direction ?? row.signalType ?? 'UNSPECIFIED';
				const manual = row.signalType === 'MANUAL_PAPER';
				const outcome: string | undefined = row.outcome?.status;
				// The badge reflects the worker's decision once there is one; a BUY that was rejected is not shown as BUY.
				const badge = outcome === 'EXECUTED' ? { tone: 'positive', text: 'Megvéve' }
					: outcome === 'REJECTED' ? { tone: 'danger', text: 'Elutasítva' }
						: outcome === 'BLOCKED' ? { tone: 'danger', text: 'Blokkolva' }
							: outcome === 'PROPOSED' ? { tone: 'warning', text: 'Jóváhagyásra vár' }
								: manual ? { tone: 'warning', text: 'Feldolgozás alatt' }
									: { tone: directionName === 'BUY' ? 'info' : directionName === 'SELL' ? 'danger' : 'warning', text: label(directionName, 'Nincs irány') };
				return <article className="signal-card" key={row.id}>
					<div className="signal-card-top"><div><span className="signal-symbol token-label"><TokenAvatar address={row.tokenAddress} symbol={row.symbol} size={22} />{row.symbol ?? row.tokenAddress ?? row.tokenId ?? 'Ismeretlen token'}</span><small>{manual ? 'Kézi Paper vétel' : row.strategyName ?? row.signalType ?? 'Stratégiajelzés'}{!manual && directionName === 'BUY' && outcome && outcome !== 'PENDING' ? ' · vételi jelzés' : ''}</small></div><Status tone={badge.tone}>{badge.text}</Status></div>
					{(outcome === 'REJECTED' || outcome === 'BLOCKED') && <p className="signal-outcome">Ok: {describeReasons(row.outcome?.reasons ?? [])}</p>}
					<div className="signal-measures"><div><span>Jelzési pontszám</span><strong>{score === null ? 'N/A' : `${fmt(score, 0)} / 100`}</strong></div><div><span>Kockázati pontszám</span><strong>{risk === null ? 'N/A' : `${fmt(risk, 0)} / 100`}</strong></div></div>
					<div className="signal-card-meta"><ModeBadge mode={row.mode} /><time>{date(row.createdAt)}</time></div>
					{(row.recommendedStop != null || row.recommendedTarget != null) && <div className="signal-levels">{row.recommendedStop != null && <span>Stop {fmt(numeric(row.recommendedStop), 6)}</span>}{row.recommendedTarget != null && <span>Profitcél {fmt(numeric(row.recommendedTarget), 6)}</span>}</div>}
					{reasons.length > 0 && <details className="signal-reasons"><summary>Miért ez a jelzés?</summary><ul>{reasons.map((reason, index) => <li key={`${index}-${reason}`}>{reason}</li>)}</ul>{asList(row.invalidationConditions).length > 0 && <><strong>Érvénytelenítési feltétel</strong><ul>{asList(row.invalidationConditions).map((reason, index) => <li key={`${index}-${reason}`}>{reason}</li>)}</ul></>}</details>}
				</article>;
			})}</div>}
		</Panel>
	</>;
}
