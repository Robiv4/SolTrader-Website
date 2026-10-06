'use client';
/* eslint-disable @typescript-eslint/no-explicit-any */
import { Activity, Database, Radio, Server, Wifi } from 'lucide-react';

import { BotMasterControls } from '../bot-controls';
import { DataTable, ErrorState, LoadingState, PageHeader, Panel, Status, useApi } from '../components';
import { LiveSafetyControls } from '../live-safety-controls';
import { StatList } from '../ui-cards';

const COMPONENT_ICONS: Record<string, typeof Server> = { API: Server, DATABASE: Database, POSTGRES: Database, REDIS: Radio, WORKER: Activity, RPC: Wifi, SOLANA_RPC: Wifi };

function stateInfo(state: string | undefined) {
	if (state === 'HEALTHY') return { tone: 'positive', text: 'MŰKÖDIK' };
	if (state === 'DOWN') return { tone: 'danger', text: 'NEM ELÉRHETŐ' };
	if (state === 'NOT_CONFIGURED') return { tone: 'neutral', text: 'NINCS BEÁLLÍTVA' };
	return { tone: 'warning', text: state ?? 'ISMERETLEN' };
}

const HEALTH_LABELS: Record<string, { tone: string; text: string }> = {
	CONNECTED: { tone: 'positive', text: 'STREAM CSATLAKOZVA' },
	DEGRADED: { tone: 'warning', text: 'STREAM GYENGE' },
	STALE: { tone: 'warning', text: 'STREAM ELAVULT' },
	DISCONNECTED: { tone: 'danger', text: 'STREAM NINCS' },
	FALLBACK_POLLING: { tone: 'warning', text: 'TARTALÉK LEKÉRDEZÉS' },
};
const msText = (value: number | null | undefined) => (value == null ? '—' : value < 1 ? `${(value * 1000).toFixed(0)} µs` : value < 1000 ? `${value.toFixed(value < 10 ? 2 : 0)} ms` : `${(value / 1000).toFixed(1)} mp`);
const pctl = (summary: any) => (summary?.p50 == null ? '—' : `${msText(summary.p50)} / ${msText(summary.p95)} / ${msText(summary.p99)}`);

const RPC_STATUS: Record<string, { tone: string; text: string }> = {
	HEALTHY: { tone: 'positive', text: 'EGÉSZSÉGES' }, DEGRADED: { tone: 'warning', text: 'GYENGE' }, RATE_LIMITED: { tone: 'warning', text: 'KORLÁTOZVA (429)' },
	FORBIDDEN: { tone: 'danger', text: 'TILTVA (403 / KONFIGURÁCIÓ)' }, TIMEOUT: { tone: 'danger', text: 'IDŐTÚLLÉPÉS' }, UNHEALTHY: { tone: 'danger', text: 'NEM EGÉSZSÉGES' }, DISABLED: { tone: 'neutral', text: 'KIKAPCSOLVA' },
};
const ROLE_LABEL: Record<string, string> = { primary: 'Elsődleges', secondary: 'Másodlagos', fallback: 'Tartalék' };
const pctText = (value: number | null | undefined, digits = 1) => (value == null ? '—' : `${value.toFixed(digits)}%`);
const secText = (ms: number) => (ms >= 60_000 ? `${Math.ceil(ms / 60_000)} p` : `${Math.ceil(ms / 1000)} mp`);

/** Solana RPC manager: providers, circuit breakers, queue, cache / dedup / batching savings, per-method and per-caller load. */
function RpcPanel({ rpc }: { rpc: any }) {
	if (!rpc) return <Panel title="Solana RPC" description="Központi RPC kezelő"><p className="sfield-help">Nincs friss adat a workertől (nem fut, vagy nincs RPC beállítva).</p></Panel>;
	const saved = rpc.savedRequests ?? {};
	return <Panel title="Solana RPC" description={`Központi kezelő · frissítve ${new Date(rpc.at).toLocaleTimeString('hu-HU')} · ${rpc.requestsPerMinute} hálózati / ${rpc.logicalRequestsPerMinute} logikai kérés / perc`}>
		{rpc.alerts?.length ? <div className="settings-warning">{rpc.alerts.map((alert: any) => <div key={alert.code}><strong>{alert.code}</strong> – {alert.detail}</div>)}</div> : null}
		<div className="health-grid">{(rpc.providers ?? []).map((provider: any) => {
			const status = RPC_STATUS[provider.status] ?? { tone: 'neutral', text: provider.status };
			return <div className={`health-card ${status.tone}`} key={provider.role}>
				<div className="health-card-text">
					<strong>{ROLE_LABEL[provider.role] ?? provider.role} · {provider.host}</strong>
					<Status tone={status.tone}>{status.text}</Status>
					<small>Circuit: {provider.circuit} · egészség: {provider.healthScore} · siker: {pctText(provider.successRatePct)} · {provider.requestsPerMinute} kérés/perc</small>
					<small>Késleltetés P50 / P95: {msText(provider.latencyP50Ms)} / {msText(provider.latencyP95Ms)} · 429: {provider.rateLimited} ({pctText(provider.rateLimitRatePct)}) · 403: {provider.forbidden} · időtúllépés: {provider.timeouts}</small>
					{provider.cooldownRemainingMs > 0 ? <small>Visszatartva még: {secText(provider.cooldownRemainingMs)}</small> : null}
					{provider.methodCooldowns?.length ? <small>Metódus-korlát: {provider.methodCooldowns.map((item: any) => `${item.method} (${secText(item.remainingMs)})`).join(', ')}</small> : null}
					{provider.unsupportedMethods?.length ? <small>Nem támogatott itt: {provider.unsupportedMethods.join(', ')}</small> : null}
					{provider.forbiddenReason ? <small>Ok: {provider.forbiddenReason}</small> : null}
					<small>Utolsó sikeres kérés: {provider.lastSuccessAt ? new Date(provider.lastSuccessAt).toLocaleTimeString('hu-HU') : '—'}{provider.lastError ? ` · utolsó hiba: ${provider.lastErrorKind}` : ''}</small>
				</div>
			</div>;
		})}</div>
		<StatList items={[
			['Sor mélysége / aktív / max. sor', `${rpc.queueDepth} / ${rpc.activeRequests} / ${rpc.totals?.maxQueueDepth ?? 0}`],
			['Várakozás a sorban P50 / P95 / P99', pctl(rpc.queueWaitMs)],
			['Logikai kérés P50 / P95 / P99', pctl(rpc.logicalLatencyMs)],
			['Cache találati arány', pctText(rpc.cacheHitRatePct)],
			['Megspórolt kérés (cache / összevonás / batch)', `${saved.cache ?? 0} / ${saved.dedup ?? 0} / ${saved.batching ?? 0}`],
			['Batch-elt fiókolvasások / batch-ek', `${rpc.totals?.batchedRequests ?? 0} / ${rpc.totals?.batches ?? 0}`],
			['Failover / 429 / időtúllépés arány', `${pctText(rpc.failoverRatePct)} / ${pctText(rpc.rateLimitRatePct)} / ${pctText(rpc.timeoutRatePct)}`],
			['Eldobott (lejárt / túlterhelés)', `${rpc.totals?.droppedExpired ?? 0} / ${rpc.totals?.droppedOverload ?? 0}`],
			['Biztonsági adat nem elérhető (nincs automatikus vétel)', rpc.totals?.securityDataUnavailable ?? 0],
		]} />
		<DataTable wide headers={['Metódus', 'Hálózati kérés', 'Arány', 'P50', 'P95', '429', 'Időtúllépés', 'Cache találat', 'Összevonva', 'Batch-elve', 'Adatosztály']}>
			{(rpc.methods ?? []).map((row: any) => <tr key={row.method}>
				<td><strong>{row.method}</strong></td><td>{row.network} <small>({row.logical} logikai)</small></td><td>{pctText(row.sharePct)}</td>
				<td>{msText(row.p50Ms)}</td><td>{msText(row.p95Ms)}</td><td>{row.rateLimited}</td><td>{row.timeouts}</td><td>{row.cacheHits}</td><td>{row.dedupHits}</td><td>{row.batched}</td><td>{row.dataClass}</td>
			</tr>)}
		</DataTable>
		<DataTable wide headers={['Hívó modul', 'Logikai', 'Hálózati', '429', 'Hiba', 'Eldobva', 'Tokenek', 'Hálózati kérés / token']}>
			{(rpc.callers ?? []).map((row: any) => <tr key={row.caller}>
				<td><strong>{row.caller}</strong></td><td>{row.logical}</td><td>{row.network}</td><td>{row.rateLimited}</td><td>{row.failures}</td><td>{row.dropped}</td><td>{row.subjects}</td>
				<td>{row.networkPerSubject == null ? '—' : row.networkPerSubject.toFixed(2)}</td>
			</tr>)}
		</DataTable>
	</Panel>;
}

/** Event-driven NewLaunch exit monitor health (published by the worker every 2 s). */
function ExitMonitorPanel({ monitor }: { monitor: any }) {
	if (!monitor) return <Panel title="Új token exit monitor" description="Eseményvezérelt kilépés-figyelés (PAPER)"><p className="sfield-help">Nincs friss adat a workertől (nem fut, vagy a monitor ki van kapcsolva: NEW_LAUNCH_EXIT_LOOP_MS=0).</p></Panel>;
	const health = HEALTH_LABELS[monitor.health] ?? { tone: 'neutral', text: monitor.health };
	return <Panel title="Új token exit monitor" description={`Eseményvezérelt kilépés-figyelés · frissítve ${new Date(monitor.at).toLocaleTimeString('hu-HU')} · PAPER késleltetés mód: ${monitor.paperLatencyMode}`} action={<Status tone={health.tone}>{health.text}</Status>}>
		<StatList items={[
			['Aktív feliratkozások (token)', monitor.activeSubscriptions],
			['Figyelt nyitott pozíciók', monitor.openHotPositions],
			['Tartalék lekérdezésen lévő pozíciók', monitor.fallbackPollingPositions],
			['Események / mp', Number(monitor.eventsPerSecond ?? 0).toFixed(1)],
			['Utolsó esemény kora', msText(monitor.lastEventAgeMs)],
			['Kiértékelések / mp', Number(monitor.evaluationsPerSecond ?? 0).toFixed(1)],
			['Kiértékelés P50 / P95 / P99', pctl(monitor.evaluationDurationMs)],
			['Esemény fogadás → döntés P50 / P95 / P99', pctl(monitor.receiveToDecisionMs)],
			['Trigger → kitöltés P50 / P95 / P99', pctl(monitor.triggerToFillMs)],
			['Sor / max. sorhossz', `${monitor.queueDepth} / ${monitor.maxQueueDepth}`],
			['Összevont (coalesced) események', monitor.coalescedEvents],
			['Sorrenden kívüli események', monitor.outOfOrderEvents],
			['Kiszűrt ismétlődő események', monitor.duplicateEventsSkipped],
			['Megakadályozott dupla kilépés', monitor.duplicateExitsPrevented],
			['Kilépések (trigger / kitöltve)', `${monitor.exitsTriggered} / ${monitor.exitsFilled}`],
			['Tartalék lekérdezések', monitor.pollRequests],
			['Mentési / zárási hibák', `${monitor.persistErrors} / ${monitor.closeErrors}`],
		]} />
		{monitor.capacity ? <>
			<strong className="analysis-subtitle" style={{ marginTop: 16 }}>Kilépési kapacitás (belépési méretezés)</strong>
			<StatList items={[
				['Kapacitás-kiértékelések', monitor.capacity.evaluations],
				['Kiértékelés P50 / P95 / P99', pctl(monitor.capacity.latencyMs)],
				['Ismeretlen (UNKNOWN) kapacitás', monitor.capacity.unknown],
				['Csökkentett volna / tiltott volna', `${monitor.capacity.wouldReduce} / ${monitor.capacity.wouldReject}`],
				['Átl. javasolt csökkentés', monitor.capacity.averageRecommendedReductionPercent == null ? '—' : `${Number(monitor.capacity.averageRecommendedReductionPercent).toFixed(0)}%`],
				['Alkalmazott csökkentés / elutasítás (ENFORCE)', `${monitor.capacity.enforcedReductions} / ${monitor.capacity.enforcedRejections}`],
				['Kapacitás-romlás / útvonal-vesztés belépés után', `${monitor.capacity.deteriorationsAfterEntry} / ${monitor.capacity.routeLosses}`],
			]} />
		</> : null}
	</Panel>;
}

const PROVIDER_STATE: Record<string, { tone: string; text: string }> = {
	ACTIVE: { tone: 'positive', text: 'AKTÍV' }, NOT_CONFIGURED: { tone: 'neutral', text: 'NINCS BEÁLLÍTVA' }, RATE_LIMITED: { tone: 'warning', text: 'KORLÁTOZVA' },
	DEGRADED: { tone: 'warning', text: 'GYENGE' }, UNAVAILABLE: { tone: 'danger', text: 'NEM ELÉRHETŐ' }, DISABLED: { tone: 'neutral', text: 'KIKAPCSOLVA' },
	CONNECTED: { tone: 'positive', text: 'KAPCSOLÓDVA' }, CONNECTING: { tone: 'warning', text: 'KAPCSOLÓDIK' }, DISCONNECTED: { tone: 'danger', text: 'NINCS KAPCSOLAT' },
};
const ENGINE_STATE: Record<string, string> = { HEALTHY: 'egészséges', PARTIAL: 'részleges', DEGRADED: 'gyenge', NO_PROVIDER: 'nincs aktív forrás' };
const timeText = (value: string | null | undefined) => (value ? new Date(value).toLocaleTimeString('hu-HU') : '—');

/** Telegram MTProto provider details (counts / times only; never credentials). */
function TelegramDetails({ provider, social }: { provider: any; social: any }) {
	const d = provider.details ?? {};
	const m = social.messages?.TELEGRAM ?? {};
	const coverage = social.telegramCoverage ?? {};
	return <StatList items={[
		['Kapcsolódva óta / utolsó üzenet / utolsó szinkron', `${timeText(d.connectedSince)} / ${timeText(d.lastMessageAt)} / ${timeText(d.lastSyncAt)}`],
		['Figyelt források / tokenek forrással', `${d.sourcesMonitored ?? 0} / ${d.matchedTokens ?? 0} (nem elérhető: ${d.sourcesNoAccess ?? 0}, limit miatt kihagyva: ${d.sourcesSkippedCap ?? 0})`],
		['Események / perc', d.eventsPerMinute ?? 0],
		['Üzenetek fogadva / hozzárendelve / duplikált / kétértelmű', `${m.received ?? 0} / ${m.processed ?? 0} / ${m.duplicates ?? 0} / ${m.ambiguous ?? 0}`],
		['Csatorna-bejelentések (nem közösségi aktivitás)', d.announcementsSkipped ?? 0],
		['Rate limit (FLOOD_WAIT)', d.rateLimitedUntil ? `korlátozva eddig: ${timeText(d.rateLimitedUntil)} (${d.lastFloodWaitSeconds} mp)` : `nincs · összesen ${provider.rateLimitEvents}`],
		['Újracsatlakozások', d.reconnects ?? 0],
		['Feldolgozási késleltetés P50 / P95', d.processingLatencyMs?.p50 == null ? '—' : `${msText(d.processingLatencyMs.p50)} / ${msText(d.processingLatencyMs.p95)}`],
		['Frissesség (stage ≥ 2 tokenek)', `${coverage.fresh ?? 0} friss / ${coverage.withSource ?? 0} forrással / ${coverage.monitoredTokens ?? 0} figyelt`],
		['Hozzáférés', `MTProto: ${d.mtprotoConfigured ? 'beállítva' : 'nincs'} · bot inbox: ${d.botInboxConfigured ? 'beállítva' : 'nincs'}`],
	]} />;
}

/** Social Intelligence providers: health, requests, rate limits, cache, latency (no secrets, no fake pricing). */
function SocialHealthPanel({ social }: { social: any }) {
	if (!social) return <Panel title="Közösségi intelligencia" description="X / Telegram gyűjtés"><p className="sfield-help">Nincs friss adat a workertől (nem fut, vagy a gyűjtés ki van kapcsolva: SOCIAL_COLLECTION_ENABLED=false).</p></Panel>;
	const telegram = (social.providers ?? []).find((provider: any) => provider.source === 'TELEGRAM');
	return <Panel title="Közösségi intelligencia" description={`Telegram-first · ${social.mode ?? 'MONITOR_ONLY'} · AI ${social.aiEnabled ? 'BE' : 'KI'} · motor: ${ENGINE_STATE[social.engineStatus] ?? social.engineStatus ?? '—'} · frissítve ${new Date(social.at).toLocaleTimeString('hu-HU')} · ${social.tokensTracked} figyelt token`}>
		<div className="health-grid">{(social.providers ?? []).map((provider: any) => {
			const state = PROVIDER_STATE[provider.state] ?? { tone: 'neutral', text: provider.state };
			return <div className={`health-card ${state.tone}`} key={provider.source}>
				<div className="health-card-text">
					<strong>{provider.source === 'X' ? 'X (Twitter)' : 'Telegram'}</strong>
					<Status tone={state.tone}>{state.text}</Status>
					<small>Kérések: {provider.requests} · korlátozás: {provider.rateLimitEvents} · hibák: {provider.errors} · cache: {provider.cacheHits}</small>
					<small>Késleltetés P50 / P95: {provider.latencyP50Ms == null ? '—' : `${provider.latencyP50Ms} ms`} / {provider.latencyP95Ms == null ? '—' : `${provider.latencyP95Ms} ms`} · költség: a szolgáltató nem közli</small>
					{provider.lastError ? <small>Utolsó hiba: {provider.lastError}</small> : null}
				</div>
			</div>;
		})}</div>
		<StatList items={[
			['Szakaszok (1 metaadat / 2 alap / 3 mély)', `${social.stages?.stage1 ?? 0} / ${social.stages?.stage2 ?? 0} / ${social.stages?.stage3 ?? 0}`],
			['Metaadat feloldva / nem elérhető (sor)', `${social.metadataResolved} / ${social.metadataUnavailable} (${social.metadataQueue})`],
			['Tárolt pillanatképek', social.snapshotsPersisted],
			['Felmérés (döntéskor) P50 / P95 / P99', pctl(social.assessLatencyMs)],
			['Gyűjtési kör P50 / P95', social.collectionLatencyMs?.p50 == null ? '—' : `${msText(social.collectionLatencyMs.p50)} / ${msText(social.collectionLatencyMs.p95)}`],
			['Pillanatkép számítás P50 / P95', social.snapshotLatencyMs?.p50 == null ? '—' : `${msText(social.snapshotLatencyMs.p50)} / ${msText(social.snapshotLatencyMs.p95)}`],
		]} />
		{telegram?.enabled ? <TelegramDetails provider={telegram} social={social} /> : null}
	</Panel>;
}

export default function SystemPage() {
	const { data, error, loading } = useApi<{ data: any }>('/api/system/health');
	const header = <PageHeader eyebrow="Infrastruktúra" title="Rendszerállapot" subtitle="A szolgáltatások állapota, a bot vezérlése és az éles kereskedés biztonsági kapuja" />;
	if (loading && !data) return <>{header}<LoadingState /></>;
	if (error && !data) return <>{header}<ErrorState message={error} /><LiveSafetyControls /></>;

	const state = data?.data;
	const components = [{ component: 'API', state: state?.api?.toUpperCase() }, ...(state?.components ?? [])];
	const healthy = components.filter((item: any) => item.state === 'HEALTHY').length;
	// Components that are only needed for LIVE trading are not a problem in PAPER mode.
	const liveOnly = components.filter((item: any) => item.state === 'NOT_CONFIGURED').length;
	const allFine = healthy + liveOnly === components.length;
	return <>
		{header}
		<Panel title="Szolgáltatások" description={`${healthy} / ${components.length} komponens működik${liveOnly ? ` · ${liveOnly} csak éles (LIVE) kereskedéshez kell` : ''}`} action={<Status tone={allFine ? 'positive' : 'warning'}>{allFine ? 'MINDEN RENDBEN' : 'FIGYELMET IGÉNYEL'}</Status>}>
			<div className="health-grid">{components.map((item: any) => {
				const info = stateInfo(item.state);
				const Icon = COMPONENT_ICONS[String(item.component).toUpperCase()] ?? Server;
				return <div className={`health-card ${info.tone}`} key={item.component}>
					<span className="kpi-icon" aria-hidden="true"><Icon size={20} /></span>
					<div className="health-card-text">
						<strong>{item.component}</strong>
						<Status tone={info.tone}>{info.text}</Status>
						{item.state === 'NOT_CONFIGURED' ? <small>Csak éles (LIVE) kereskedéshez kell – a Paper kereskedést nem érinti.</small> : null}
						{item.latencyMs !== undefined ? <small>Válaszidő: {item.latencyMs} ms</small> : null}
					</div>
				</div>;
			})}</div>
		</Panel>
		<ExitMonitorPanel monitor={state?.exitMonitor ?? null} />
		<RpcPanel rpc={state?.rpc ?? null} />
		<SocialHealthPanel social={state?.social ?? null} />
		<BotMasterControls />
		<Panel title="Futási állapot" description="A szerveroldali kereskedési beállítások">
			<StatList items={[
				['Kereskedési mód', state?.mode ?? '—'],
				['Éles kereskedés a szerveren', state?.serverLiveTradingEnabled ? <Status tone="danger">ENGEDÉLYEZVE</Status> : <Status tone="positive">KIKAPCSOLVA</Status>],
			]} />
			<p className="sfield-help" style={{ marginTop: 12 }}>A fiókszintű LIVE aktiválás különálló, és a biztonsági kapu teljesüléséig blokkolva marad.</p>
		</Panel>
		<LiveSafetyControls />
	</>;
}
