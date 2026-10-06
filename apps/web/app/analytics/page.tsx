'use client';
/* eslint-disable @typescript-eslint/no-explicit-any */
import { Coins, ListChecks, Scale, Sigma, Target, TrendingDown, TrendingUp, Waves } from 'lucide-react';
import { useState } from 'react';

import { DataTable, EmptyState, ErrorState, LoadingState, Metric, PageHeader, Panel, Stacked, useApi, fmt } from '../components';
import { exitReasonLabel } from '../locales/hu';
import { MODULE_LABELS_HU } from '../locales/strategy-labels';
import { NewLaunchAnalytics } from '../new-launch-analytics';

function minutes(ms: number | null | undefined) {
	if (!ms) return '—';
	const value = ms / 60_000;
	return value < 60 ? `${fmt(value, 1)} perc` : `${fmt(value / 60, 1)} óra`;
}
const moduleLabel = (name: string) => name.split(' + ').map((part) => MODULE_LABELS_HU[part] ?? part).join(' + ');
const sourceLabel = (name: string) => (name === 'AUTOMATIC' ? 'Automatikus' : name === 'MANUAL_PAPER' ? 'Manuális Paper' : name);

type Point = { at: string | null; equity: number };

function HistoryPlot({ title, points, tone = 'default' }: { title: string; points: Point[]; tone?: string }) {
  if (points.length < 2) return <div className="chart-empty"><span>Még nincs adat</span><small>A lezárt kereskedések után itt jelenik meg.</small></div>;
  const values = points.map((point) => point.equity);
  const min = Math.min(0, ...values);
  const max = Math.max(0, ...values);
  const span = max - min || 1;
  const coordinates = points.map((point, index) => ({
    x: 4 + (index / (points.length - 1)) * 92,
    y: 90 - ((point.equity - min) / span) * 76,
    point,
  }));
	return <div className={`analytics-plot ${tone}`} role="img" aria-label={`${title}, ${points.length} recorded data points`}>
		<svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><line x1="4" x2="96" y1="14" y2="14" /><line x1="4" x2="96" y1="52" y2="52" /><line x1="4" x2="96" y1="90" y2="90" /><polyline className={tone} points={coordinates.map(({ x, y }) => `${x},${y}`).join(' ')} />{coordinates.map(({ x, y, point }, index) => <circle key={`${point.at}-${index}`} cx={x} cy={y} r="1.4"><title>{`${point.at ? new Date(point.at).toLocaleString() : 'Start'} · ${fmt(point.equity)}`}</title></circle>)}</svg>
    <div className="plot-axis"><span>{points[0]?.at ? new Date(points[0].at).toLocaleDateString() : 'Start'}</span><span>{points.at(-1)?.at ? new Date(points.at(-1)!.at!).toLocaleDateString() : 'Now'}</span></div>
  </div>;
}

const LAUNCH_EXIT_LABELS: Record<string, string> = { STOP_LOSS: 'Stop Loss', TAKE_PROFIT: 'Take Profit', TRAILING_STOP: 'Követő stop', BREAK_EVEN: 'Break-even stop', LIQUIDITY_SAFETY: 'Likviditás-biztonsági kilépés', MANUAL: 'Kézi zárás', OTHER: 'Egyéb' };

export default function AnalyticsPage() {
	const [range, setRange] = useState('30d');
	const [source, setSource] = useState('ALL');
	const { data, error, loading } = useApi<{ data: any }>(`/api/analytics?range=${range}${source === 'ALL' ? '' : `&decisionSource=${source}`}`);
	const backtests = useApi<{ data: any[] }>('/api/backtests');
	if ((loading && !data) || (backtests.loading && !backtests.data)) return <><PageHeader eyebrow="Teljesítmény" title="Elemzések" /><LoadingState /></>;
	if (error || backtests.error) return <><PageHeader eyebrow="Teljesítmény" title="Elemzések" /><ErrorState message={error ?? backtests.error ?? 'Unable to load analytics'} /></>;
	const value = data?.data;
	const historicalRuns = backtests.data?.data ?? [];
	const rows = (items: any[] | undefined, label: (name: string) => string = (name) => name) => items?.map((row, index) => <tr key={`${row.name}-${index}`}><td>{label(row.name)}</td><td>{row.trades}{row.trades < 20 ? <span className="sample-note"> · kis minta</span> : null}</td><td className={row.netPnl >= 0 ? 'positive-value' : 'negative-value'}>{fmt(row.netPnl)}</td><td>{fmt(row.winRate, 0)}%</td><td>{row.profitFactor == null ? '—' : fmt(row.profitFactor)}</td><td><Stacked top={fmt(row.expectancy)} bottom={`${fmt(row.averageReturnPercent)}%${row.maxDrawdown != null ? ` · DD ${fmt(row.maxDrawdown)}` : ''}`} /></td><td>{minutes(row.averageTradeDurationMs)}</td><td><Stacked top={`díj ${fmt(row.fees)}`} bottom={`csúszás ${fmt(row.slippage)}`} /></td></tr>);
	const groupHeaders = (first: string) => [first, 'Db', 'Nettó P&L', 'Nyerési arány', 'Profit faktor', 'Várható érték', 'Átl. tartás', 'Költségek'];
	const group = (title: string, items: any[] | undefined, first: string, label?: (name: string) => string, note?: string) => <Panel title={title} description={note}>{items?.length ? <DataTable headers={groupHeaders(first)}>{rows(items, label)}</DataTable> : <EmptyState message="Nincs adat ebben az időszakban." />}</Panel>;
	const trailing = value?.trailingDiagnostics;
	const equityPoints: Point[] = value?.equityCurve ?? [];
	let peak = 0;
	const drawdownPoints = equityPoints.map((point) => { peak = Math.max(peak, point.equity); return { at: point.at, equity: peak - point.equity }; });
	return <>
		<PageHeader eyebrow="Teljesítmény" title="Elemzések" subtitle="A lezárt kereskedések eredményei és kockázati mutatói" action={<div className="segmented" role="group" aria-label="Időszak">{[['today', 'Ma'], ['7d', '7 nap'], ['30d', '30 nap'], ['all', 'Mind']].map(([key, text]) => <button key={key} type="button" className={range === key ? 'selected' : ''} aria-pressed={range === key} onClick={() => setRange(key)}>{text}</button>)}</div>} />
		<section className="metric-grid analytics-metrics"><Metric icon={<TrendingUp size={20} />} label="Összes P&L" value={fmt(value?.totalPnl)} tone={typeof value?.totalPnl === 'number' ? value.totalPnl >= 0 ? 'positive' : 'negative' : ''} /><Metric icon={<Target size={20} />} label="Nyerési arány" value={`${fmt(value?.winRate)}%`} /><Metric icon={<Scale size={20} />} label="Profit faktor" value={fmt(value?.profitFactor)} note="nyereség / veszteség arány" /><Metric icon={<Sigma size={20} />} label="Várható érték / kereskedés" value={fmt(value?.expectancy)} note="USDC, átlagos nettó eredmény" /><Metric icon={<TrendingDown size={20} />} label="Max. visszaesés" value={`$${fmt(value?.maxDrawdown)} · ${fmt(value?.maxDrawdownPercent)}%`} tone="warning" /><Metric icon={<ListChecks size={20} />} label="Kereskedések" value={fmt(value?.totalTrades, 0)} note="lezárt, a választott időszakban" /><Metric icon={<Coins size={20} />} label="Díjak" value={fmt(value?.totalFees)} note="a nettó eredményben már benne" /><Metric icon={<Waves size={20} />} label="Csúszás" value={fmt(value?.totalSlippage)} note="a végrehajtási árakban benne" /></section>
		<p className="annotation">Minden mutató a lezárt kereskedések végső nettó P&L-jéből számol (nyitott pozíciók nélkül). A díjak és a csúszás tájékoztató adatok: a díjak egyszer vannak levonva, a csúszás a végrehajtási árakban van, ezért egyik sincs még egyszer levonva. A max. visszaesés a realizált egyenleggörbe csúcs–mélypont különbsége dollárban és a csúcshoz viszonyított százalékban.</p>
		<section className="analytics-chart-grid"><Panel title="Kumulált P&L" description="A lezárt kereskedések nettó eredményének összege"><HistoryPlot title="Kumulált P&L" points={equityPoints} /><p className="plot-footnote">{equityPoints.length ? `${equityPoints.length - 1} lezárt kereskedés` : 'Ebben az időszakban nincs lezárt kereskedés.'}</p></Panel><Panel title="Visszaesés" description="Az egyenleggörbe csúcstól mért esése"><HistoryPlot title="Visszaesés" points={drawdownPoints} tone="drawdown" /><p className="plot-footnote">A csúcsérték és az azt követő mélypont közti különbség.</p></Panel></section>
		<div className="segmented" role="group" aria-label="Döntési mód" style={{ marginBottom: 12 }}>{[['ALL', 'Összes'], ['STRATEGY', 'Stratégia'], ['AI', 'AI'], ['NEW_LAUNCH', 'Új token'], ['MANUAL_PAPER', 'Manuális']].map(([key, text]) => <button key={key} type="button" className={source === key ? 'selected' : ''} aria-pressed={source === key} onClick={() => setSource(key)}>Döntési mód: {text}</button>)}</div>
		<Panel title="Döntési források: AI vs. Stratégia vs. Új token">
			<p className="annotation">A döntési forrásokat külön mérjük, sosem egy közös, magyarázatlan számban. Az AI bizalom az AI elemzési pontszáma, nem a nyereség valószínűsége – az alábbi bontás mutatja meg, mennyire kalibrált.</p>
			{value?.decisionSourcePerformance?.length ? <DataTable headers={['Döntési mód', 'Db', 'Nettó P&L', 'Nyerési arány', 'Profit faktor', 'Várható érték', 'Átl. tartás', 'Költségek']}>{rows(value.decisionSourcePerformance, (name: string) => (name === 'AI' ? 'AI' : name === 'MANUAL_PAPER' ? 'Manuális' : name === 'NEW_LAUNCH' ? 'Új token' : 'Stratégia'))}</DataTable> : <EmptyState message="Nincs adat ebben az időszakban." />}
			{value?.decisionSourcePerformance?.length ? <p className="annotation">{value.decisionSourcePerformance.map((row: any) => `${row.name === 'AI' ? 'AI' : row.name === 'MANUAL_PAPER' ? 'Manuális' : row.name === 'NEW_LAUNCH' ? 'Új token' : 'Stratégia'}: átl. nyerő ${fmt(row.averageWin)}, átl. vesztes ${fmt(row.averageLoss)}, max. visszaesés ${row.maxDrawdown == null ? '— (kevés adat)' : fmt(row.maxDrawdown)}, díj ${fmt(row.fees)}, csúszás ${fmt(row.slippage)}`).join(' · ')}</p> : null}
		</Panel>
		{source === 'NEW_LAUNCH' ? <NewLaunchAnalytics /> : <>
		<Panel title="Új token / Sniper teljesítmény" description="Részletes elemzés (belépés, kilépés, MFE/MAE, optimalizáló): válaszd a „Döntési mód: Új token” nézetet." action={<button type="button" className="secondary-button" onClick={() => setSource('NEW_LAUNCH')}>Részletes elemzés →</button>}>
			{value?.newLaunch?.summary?.trades ? <>
				<DataTable headers={['Mutató', 'Érték']}>
					<tr><td>Kereskedések</td><td>{value.newLaunch.summary.trades}{value.newLaunch.summary.trades < 20 ? ' · kis minta' : ''}</td></tr>
					<tr><td>Nyerési arány</td><td>{fmt(value.newLaunch.summary.winRate, 0)}%</td></tr>
					<tr><td>Nettó P&L</td><td className={value.newLaunch.summary.netPnl >= 0 ? 'positive-value' : 'negative-value'}>{fmt(value.newLaunch.summary.netPnl)}</td></tr>
					<tr><td>Profit faktor / várható érték</td><td>{value.newLaunch.summary.profitFactor == null ? '—' : fmt(value.newLaunch.summary.profitFactor)} / {fmt(value.newLaunch.summary.expectancy)}</td></tr>
					<tr><td>Max. visszaesés</td><td>{fmt(value.newLaunch.summary.maxDrawdown)}</td></tr>
					<tr><td>Átl. tartás</td><td>{minutes(value.newLaunch.summary.averageTradeDurationMs)}</td></tr>
					<tr><td>Átl. életkor belépéskor / Launch Score / likviditás</td><td>{value.newLaunch.summary.averageEntryAgeSeconds == null ? '—' : `${fmt(value.newLaunch.summary.averageEntryAgeSeconds, 0)} mp`} / {value.newLaunch.summary.averageLaunchScore == null ? '—' : fmt(value.newLaunch.summary.averageLaunchScore, 0)} / {value.newLaunch.summary.averageEntryLiquidityUsd == null ? '—' : `$${fmt(value.newLaunch.summary.averageEntryLiquidityUsd, 0)}`}</td></tr>
					<tr><td>Díjak / csúszás</td><td>{fmt(value.newLaunch.summary.fees)} / {fmt(value.newLaunch.summary.slippage)}</td></tr>
				</DataTable>
			</> : <EmptyState message="Még nincs lezárt Új token kereskedés ebben az időszakban." />}
		</Panel>
		{value?.newLaunch?.summary?.trades ? <>
			{group('Új token: Launch Score szerint', value.newLaunch.byLaunchScore, 'Launch Score')}
			{group('Új token: életkor belépéskor', value.newLaunch.byEntryAge, 'Életkor')}
			{group('Új token: likviditás belépéskor', value.newLaunch.byEntryLiquidity, 'Likviditás')}
			{group('Új token: kilépés oka szerint', value.newLaunch.byExitReason, 'Kilépés oka', (name: string) => LAUNCH_EXIT_LABELS[name] ?? name)}
		</> : null}
		</>}
		{group('AI bizalom szerint (AI kereskedések)', value?.aiConfidencePerformance, 'AI bizalom', undefined, 'Magasabb bizalom nem jelent automatikusan nagyobb nyerési esélyt – ezt a tényleges PAPER eredmények mutatják meg.')}
		<Panel title="AI döntések">
			{value?.aiDecisionFunnel ? <DataTable headers={['Mutató', 'Érték']}>
				<tr><td>VÉTEL / MEGFIGYELÉS / KIHAGYÁS</td><td>{value.aiDecisionFunnel.buy} / {value.aiDecisionFunnel.watch} / {value.aiDecisionFunnel.skip}</td></tr>
				<tr><td>Sikertelen / érvénytelen elemzés</td><td>{value.aiDecisionFunnel.failed}</td></tr>
				<tr><td>MEGFIGYELÉS → VÉTEL</td><td>{value.aiDecisionFunnel.watchToBuy}</td></tr>
				<tr><td>MEGFIGYELÉS → KIHAGYÁS</td><td>{value.aiDecisionFunnel.watchToSkip}</td></tr>
				<tr><td>Átl. idő MEGFIGYELÉS → VÉTEL</td><td>{value.aiDecisionFunnel.averageWatchToBuyMs == null ? '—' : minutes(value.aiDecisionFunnel.averageWatchToBuyMs)}</td></tr>
			</DataTable> : <EmptyState message="Nincs AI döntés ebben az időszakban." />}
		</Panel>
		{group('Automatikus vs. Manuális Paper', value?.executionSourcePerformance, 'Forrás', sourceLabel)}
		<Panel title="Követő stop (trailing) diagnosztika">{trailing?.trailingExits ? <>
			<DataTable headers={['Mutató', 'Érték']}>
				<tr><td>Trailing kilépések</td><td>{trailing.trailingExits} (nyerő {trailing.profitable}, vesztes {trailing.losing})</td></tr>
				<tr><td>Átlagos nettó P&L</td><td>{fmt(trailing.averageNetPnl)}</td></tr>
				<tr><td>Átl. max. kedvező kitérés (MFE)</td><td>{fmt(trailing.averageMaxFavorableExcursionPercent)}%</td></tr>
				<tr><td>Átl. max. kedvezőtlen kitérés (MAE)</td><td>{fmt(trailing.averageMaxAdverseExcursionPercent)}%</td></tr>
				<tr><td>Átl. nyereség az aktiváláskor</td><td>{trailing.averageGainAtActivationPercent == null ? '—' : `${fmt(trailing.averageGainAtActivationPercent)}%`}</td></tr>
				<tr><td>Átl. távolság a csúcstól a kitöltésig</td><td>{fmt(trailing.averagePeakToFillPercent)}%</td></tr>
				<tr><td>Nettó nullszint alatt aktiválódott</td><td className={trailing.activatedBelowNetBreakEven ? 'negative-value' : ''}>{trailing.activatedBelowNetBreakEven} / {trailing.trailingExits}</td></tr>
				<tr><td>A csúcs sem érte el a nettó nullszintet</td><td>{trailing.peakNeverAboveNetBreakEven} / {trailing.trailingExits}</td></tr>
			</DataTable>
			{trailing.flagged ? <p className="annotation risk-policy-warning">Figyelem: a követő stop a nettó nullszint (+{fmt(trailing.netBreakEvenGainPercent, 1)}%) alatt aktiválódott – ilyenkor második, szorosabb Stop Lossként működik, nem nyereségvédelemként. Állíts be „Trailing aktiválás %”-ot a Beállításokban.</p> : null}
		</> : <EmptyState message="Nincs trailing kilépés ebben az időszakban." />}</Panel>
		<Panel title="Jelzés-kísérletek (haladó stratégiák)">
			<p className="annotation">Ezek a bontások azt mérik, hogy az egyes megerősítések és kombinációk valóban javítják-e a PAPER eredményt. {value?.signalContextTrades ?? 0} lezárt kereskedésnél van rögzített jelzéselemzés (a korábbiaknál nincs, azokat nem becsüljük utólag). 20 kereskedés alatt az eredmény kis minta – nem szabad belőle „legjobb” stratégiát kinevezni.</p>
		</Panel>
		{group('Elsődleges stratégia szerint', value?.primaryStrategyPerformance, 'Elsődleges stratégia', moduleLabel)}
		{group('Megerősítés szerint', value?.confirmationPerformance, 'Megerősítést tartalmaz', moduleLabel, 'Egy kereskedés több sorban is szerepelhet (minden megerősítésénél).')}
		{group('Jelzéskombinációk (pontos)', value?.combinationPerformance?.exact, 'Kombináció', moduleLabel)}
		{group('Jelzéspárok', value?.combinationPerformance?.pairs, 'Pár', moduleLabel, 'Minden kereskedés, amelyben mindkét megerősítés szerepelt.')}
		{group('Összetett pontszám szerint', value?.compositeScorePerformance, 'Összetett pontszám', undefined, 'Magasabb összetett pontszám együtt jár-e jobb PAPER eredménnyel?')}
		{group('Pump kifáradás a belépéskor', value?.exhaustionScorePerformance, 'Kifáradás', undefined, 'Előre jelzi-e a magas kifáradás a rossz belépéseket?')}
		{group('Kilépési okok', value?.exitReasonDistribution, 'Kilépési ok', (name) => exitReasonLabel(name))}
		{group('Stratégiák teljesítménye (automatikus)', value?.automaticStrategyPerformance, 'Stratégia', undefined, 'A manuális Paper vételek nélkül, hogy ne torzítsák a stratégiák eredményét.')}
		{group('Jelzési pontszám szerint (automatikus)', value?.signalScorePerformance, 'Pontszám', undefined, 'A belépéskori jelzési pontszám szerint; így mérhető, hogy az alacsony pontszámú jelzések rosszabbul teljesítenek-e.')}
		{group('Kockázati besorolás szerint', value?.riskClassificationPerformance, 'Besorolás')}
		{group('Tartási idő szerint', value?.holdingDurationPerformance, 'Tartási idő')}
		{group('Pozícióméret szerint', value?.positionSizePerformance, 'Méret')}
		<section className="panel-grid">{group('AI-megerősítés szerint', value?.aiConfirmationPerformance, 'AI megerősítve')}{group('Tokenek teljesítménye', value?.tokenPerformance, 'Token')}</section>
		<section className="panel-grid"><Panel title="Legutóbbi jelzések">{value?.recentSignals?.length ? <DataTable headers={['Jelzés', 'Időpont']}>{value.recentSignals.map((row: any, index: number) => <tr key={row.id ?? index}><td>{row.signalType ?? row.id}</td><td>{row.createdAt ? new Date(row.createdAt).toLocaleString() : '—'}</td></tr>)}</DataTable> : <EmptyState message="Nincs friss jelzés." />}</Panel></section>
		<Panel title="Historikus szimulációk (backtest)"><p className="annotation">Csak historikus szimuláció – nem garantál jövőbeli nyereséget.</p>{historicalRuns.length ? <DataTable headers={['Stratégia', 'Időszak', 'Hozam', 'Visszaesés', 'Db', 'Nyerési arány']}>{historicalRuns.map((run: any) => <tr key={run.id}><td>{run.strategyName ?? run.name}</td><td>{new Date(run.startDate).toLocaleDateString()} – {new Date(run.endDate).toLocaleDateString()}</td><td>{fmt(run.returnPercent)}%</td><td>{fmt(run.maxDrawdown)}%</td><td>{run.tradeCount}</td><td>{fmt(run.winRate)}%</td></tr>)}</DataTable> : <EmptyState message="Még nem futott historikus szimuláció." />}</Panel>
	</>;
}
