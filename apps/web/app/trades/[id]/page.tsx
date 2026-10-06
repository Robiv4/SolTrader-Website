'use client';
/* eslint-disable @typescript-eslint/no-explicit-any */
import Link from 'next/link';
import { useParams } from 'next/navigation';
import type { ReactNode } from 'react';

import { TokenAvatar } from '../../avatars';
import { DataTable, date, ErrorState, fmt, formatPrice, LoadingState, PageHeader, Panel, useApi } from '../../components';
import { exitReasonLabel } from '../../locales/hu';
import { MODULE_LABELS_HU } from '../../locales/strategy-labels';

const NOT_RECORDED = 'nincs rögzítve';

function price(value: number | null | undefined) {
	return value == null ? NOT_RECORDED : formatPrice(value);
}

function money(value: number | null | undefined, signed = false) {
	if (value == null) return NOT_RECORDED;
	return `${signed && value > 0 ? '+' : ''}${fmt(value)} USDC`;
}

function percent(value: number | null | undefined, digits = 2) {
	return value == null ? NOT_RECORDED : `${fmt(value, digits)}%`;
}

function duration(ms: number | null | undefined) {
	if (ms == null) return NOT_RECORDED;
	const minutes = ms / 60_000;
	return minutes < 60 ? `${fmt(minutes, 1)} perc` : `${fmt(minutes / 60, 1)} óra`;
}

function sourceLabel(value: string | null | undefined) {
	if (value === 'MANUAL_PAPER') return 'Manuális Paper';
	if (value === 'SEMI_AUTO_APPROVAL') return 'Félautomata (jóváhagyott)';
	return 'Automatikus stratégia';
}

function Rows({ items }: { items: Array<[string, ReactNode]> }) {
	return <DataTable headers={['Adat', 'Érték']}>{items.map(([label, value]) => <tr key={label}><td>{label}</td><td>{value}</td></tr>)}</DataTable>;
}

export default function TradeDetailsPage() {
	const params = useParams<{ id: string }>();
	const { data, error, loading } = useApi<{ data: any }>(`/api/trades/${params.id}`);
	const header = <PageHeader eyebrow="Kereskedés részletei" icon={data?.data ? <TokenAvatar address={data.data.tokenAddress} symbol={data.data.symbol} size={34} /> : undefined} title={data?.data?.symbol ?? 'Kereskedés'} subtitle="A pozíció teljes életútja: belépés, védelmi szintek, követő stop és kilépés" action={<div className="row-inline">{data?.data?.positionId ? <Link className="secondary-button" href={`/positions/${data.data.positionId}`}>Pozíció részletei (grafikon) →</Link> : null}<Link className="secondary-button" href="/trades">← Vissza a kereskedésekhez</Link></div>} />;
	if (loading && !data) return <>{header}<LoadingState /></>;
	if (error) return <>{header}<ErrorState message={error} /></>;
	const trade = data?.data;
	if (!trade) return <>{header}<ErrorState message="A kereskedés nem található." /></>;
	const snapshot = trade.configSnapshot ?? null;
	const net = trade.netPnl as number | null;
	return <>
		{header}
		{!trade.diagnosticsRecorded ? <p className="annotation risk-policy-warning">Ez a kereskedés a részletes diagnosztika bevezetése előtt nyílt: a belépési piaci ár, a kilépési csúszás, a trailing aktiválás és a beállítás-pillanatkép nem lett rögzítve, ezért ezek „{NOT_RECORDED}” jelzést kapnak (nem becsüljük utólag).</p> : null}
		<section className="panel-grid">
			<Panel title="Összegzés">
				<Rows items={[
					['Kilépési ok', trade.exitReason ? exitReasonLabel(trade.exitReason) : 'Nyitott'],
					['Stratégia', trade.strategyName === 'MANUAL_PAPER' ? 'Kézi' : String(trade.strategyName ?? '—').replace('Strategy', '')],
					['Végrehajtás forrása', sourceLabel(trade.executionSource)],
					['Jelzési pontszám', trade.signalScore == null ? NOT_RECORDED : fmt(trade.signalScore, 0)],
					['Kockázati pontszám', trade.riskScore == null ? NOT_RECORDED : `${fmt(trade.riskScore, 0)} (${trade.riskClassification ?? '—'})`],
					['Belépés időpontja', trade.entryAt ? date(trade.entryAt) : NOT_RECORDED],
					['Kilépés időpontja', trade.exitAt ? date(trade.exitAt) : '—'],
					['Tartási idő', duration(trade.holdingMs)],
				]} />
			</Panel>
			<Panel title="Eredmény">
				<Rows items={[
					['Pozícióméret', money(trade.size)],
					['Mennyiség', fmt(trade.quantity, 0)],
					['Bruttó P&L', money(trade.grossPnl, true)],
					['Díjak (belépés + kilépés)', money(trade.fees)],
					['Csúszás (a végrehajtási árakban)', `${money(trade.totalSlippageAmount)} · belépés ${money(trade.entrySlippageAmount)} · kilépés ${trade.exitSlippageAmount == null && trade.exitAt ? 'akkor még nem volt modellezve' : money(trade.exitSlippageAmount)}`],
					['Nettó P&L', <strong key="net" className={net == null ? '' : net >= 0 ? 'positive-value' : 'negative-value'}>{money(net, true)}</strong>],
					['Nettó hozam', percent(trade.returnPercent)],
				]} />
				<p className="annotation">Nettó P&L = Bruttó P&L − díjak. A csúszás már a belépési és kilépési végrehajtási árban szerepel, ezért nincs még egyszer levonva.</p>
			</Panel>
		</section>
		<section className="panel-grid">
			<Panel title="Árak">
				<Rows items={[
					['Belépési ár (piaci)', price(trade.entryMarketPrice)],
					['Végrehajtási belépési ár', `${price(trade.entryFillPrice)}${trade.entrySlippagePercent != null ? ` (+${fmt(trade.entrySlippagePercent)}%)` : ''}`],
					['Kilépési ár (piaci)', price(trade.exitMarketPrice)],
					['Végrehajtási kilépési ár', `${price(trade.exitFillPrice)}${trade.exitSlippagePercent != null ? ` (−${fmt(trade.exitSlippagePercent)}%)` : ''}`],
					['Elért legmagasabb ár', `${price(trade.highestPrice)}${trade.maxFavorableExcursionPercent != null ? ` (${fmt(trade.maxFavorableExcursionPercent)}%)` : ''}`],
					['Legalacsonyabb ár', `${price(trade.lowestPrice)}${trade.maxAdverseExcursionPercent != null ? ` (${fmt(trade.maxAdverseExcursionPercent)}%)` : ''}`],
					['Megfigyelt ár a triggerkor', price(trade.observedPrice)],
					['Átlépett szint', price(trade.triggerLevel)],
				]} />
				<p className="annotation">Kitöltési szabály: a kilépést az aktuális piaci pillanatképen észleljük, és annak az árából (mínusz a modellezett csúszás) töltjük ki – nem a trigger szintjén. Két árfrissítés közti nagy mozgás így a valóságnak megfelelően jelenik meg.</p>
			</Panel>
			<Panel title="Védelmi szintek és követő stop">
				<Rows items={[
					['Stop Loss', price(trade.stopLossPrice)],
					['Take Profit', price(trade.takeProfitPrice)],
					['Követő stop távolsága', trade.trailingStopPercent == null ? 'nincs követő stop' : percent(trade.trailingStopPercent)],
					['Trailing aktiválási szint', trade.trailingArmedFromEntry ? 'azonnal (a vételtől aktív)' : trade.trailingActivationPercent == null ? NOT_RECORDED : `+${fmt(trade.trailingActivationPercent)}%`],
					['Trailing aktiválva?', trade.trailingArmedFromEntry ? 'igen (a vételtől)' : trade.trailingActive == null ? NOT_RECORDED : trade.trailingActive ? 'igen' : 'nem'],
					['Aktiválás időpontja', trade.trailingActivatedAt ? date(trade.trailingActivatedAt) : trade.trailingArmedFromEntry ? 'a belépéskor' : '—'],
					['Ár az aktiváláskor', price(trade.trailingActivationPrice)],
					['Trailing trigger', price(trade.trailingTriggerPrice)],
					['Break-even aktiválás', trade.breakEvenActivationPercent == null ? 'kikapcsolva' : `+${fmt(trade.breakEvenActivationPercent)}%${trade.breakEvenAppliedAt ? ` · alkalmazva ${date(trade.breakEvenAppliedAt)}` : ''}`],
				]} />
			</Panel>
		</section>
		{snapshot?.ai ? <Panel title="AI döntés a belépéskor">
			<Rows items={[
				['Döntési mód', 'AI'],
				['AI döntés', `${snapshot.ai.rawDecision ?? '—'} → ${snapshot.ai.effectiveDecision ?? '—'}`],
				['AI bizalom', snapshot.ai.confidence == null ? '—' : `${Math.round(snapshot.ai.confidence)}/100 (minimum ${snapshot.ai.minimumConfidence})`],
				['Szolgáltató / modell', `${snapshot.ai.provider} / ${snapshot.ai.model}`],
				['Prompt verzió', snapshot.ai.promptVersion],
				['AI méretszorzó', snapshot.ai.recommendedPositionMultiplier ?? '—'],
				['AI kilépési paraméterek', snapshot.ai.usedExitParameters ? 'használva' : 'nem (a saját beállításaid érvényesek)'],
			]} />
		</Panel> : null}
		{snapshot?.signalContext ? <Panel title="Jelzés a belépéskor">
			<Rows items={[
				['Elsődleges stratégia', MODULE_LABELS_HU[snapshot.signalContext.primaryStrategy] ?? String(snapshot.signalContext.primaryStrategy ?? '—').replace('Strategy', '')],
				['Összetett jelzés', snapshot.signalContext.compositeScore == null ? '—' : `${snapshot.signalContext.compositeScore}/100`],
				['Megerősítések', (snapshot.signalContext.confirmedModules ?? []).length ? (snapshot.signalContext.confirmedModules as string[]).map((name) => MODULE_LABELS_HU[name] ?? name).join(', ') : 'nincs'],
				['Nem erősítette meg', (snapshot.signalContext.unconfirmedModules ?? []).map((name: string) => MODULE_LABELS_HU[name] ?? name).join(', ') || '—'],
				['Pump kifáradás', snapshot.signalContext.exhaustionScore == null ? 'nem elérhető' : `${snapshot.signalContext.exhaustionScore}/100`],
				['Elemzés forrása', snapshot.signalContext.source === 'LATEST_ANALYSIS' ? 'a legutóbbi elemzés (kézi vétel – a pontszámokat nem módosítja)' : 'a belépést kiváltó jelzés'],
			]} />
		</Panel> : null}
		<Panel title="Beállítások a belépéskor">
			{snapshot ? <Rows items={[
				['Min. jelzési pontszám', snapshot.minSignalScore ?? '—'],
				['Stop Loss / Take Profit', `${snapshot.stopLossPercent ?? '—'}% / ${snapshot.takeProfitPercent ?? '—'}%`],
				['Követő stop távolsága / aktiválás', `${snapshot.trailingStopPercent ?? '—'}% / ${snapshot.trailingActivationPercent == null ? 'azonnal' : `${snapshot.trailingActivationPercent}%`}`],
				['Max. pozíció % / beállított méret', `${snapshot.maxPositionPercent ?? '—'}% / ${snapshot.configuredPositionSize == null ? '—' : `${snapshot.configuredPositionSize} USDC`}`],
				['Kockázati szorzó', snapshot.riskMultiplier ?? '—'],
				['Egyenleg a belépéskor', snapshot.sizing?.accountEquity == null ? '—' : money(snapshot.sizing.accountEquity)],
				['Normál / kockázattal korrigált méret', snapshot.sizing ? `${money(snapshot.sizing.normalPositionSize)} / ${money(snapshot.sizing.riskAdjustedPositionSize)}` : '—'],
				['Méretkorlát oka', snapshot.sizing?.limitedBy ?? '—'],
				['Kockázati szabályzat', snapshot.riskPolicy ?? '—'],
				['Likviditás / 24h változás a belépéskor', snapshot.entryMarket ? `${money(snapshot.entryMarket.liquidityUsd)} / ${snapshot.entryMarket.priceChange24h == null ? '—' : `${fmt(snapshot.entryMarket.priceChange24h)}%`}` : '—'],
				['Jelzés kora a belépéskor', snapshot.entryMarket?.signalAgeMs == null ? '—' : `${fmt(snapshot.entryMarket.signalAgeMs / 1000, 0)} mp`],
			]} /> : <p className="annotation">Ehhez a kereskedéshez nincs rögzített beállítás-pillanatkép (a funkció bevezetése előtt nyílt).</p>}
		</Panel>
	</>;
}
