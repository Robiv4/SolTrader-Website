'use client';
/* eslint-disable @typescript-eslint/no-explicit-any */

import Link from 'next/link';

import { DataTable, date, EmptyState, ErrorState, fmt, LoadingState, Metric, Panel, Status, useApi } from '../components';
import { launchReasons } from '../locales/position-labels';

const pct = (value: number | null | undefined) => (value == null ? '—' : `${(value * 100).toFixed(1)}%`);
const usd = (value: number | null | undefined) => (value == null ? '—' : `${fmt(value, 2)} USDC`);
const score = (value: number | null | undefined) => (value == null ? 'nincs adat' : fmt(value, 0));
const PROVIDER_TONE: Record<string, string> = { ACTIVE: 'positive', NOT_CONFIGURED: 'neutral', DISABLED: 'neutral', DEGRADED: 'warning', RATE_LIMITED: 'warning' };
const PROVIDER_TEXT: Record<string, string> = { ACTIVE: 'AKTÍV', NOT_CONFIGURED: 'NINCS BEÁLLÍTVA', DISABLED: 'KIKAPCSOLVA', DEGRADED: 'HIBÁS / VISSZALÉPVE', RATE_LIMITED: 'KORLÁTOZVA (429)' };
const QUALITY_TONE: Record<string, string> = { GOOD: 'positive', WEAK: 'warning', NO_DATA: 'neutral', STALE: 'warning', UNRELIABLE_IDENTITY: 'danger' };
const QUALITY_TEXT: Record<string, string> = { GOOD: 'JÓ', WEAK: 'GYENGE', NO_DATA: 'NINCS ADAT', STALE: 'ELAVULT', UNRELIABLE_IDENTITY: 'BIZONYTALAN AZONOSÍTÁS' };
const REASON_TEXT: Record<string, string> = {
  NO_MAX_HOLD: 'nincs max. tartási idő (kikapcsolva a pozíció nyitásakor)', MAX_HOLD_OVERDUE_WAITING_FOR_REAL_QUOTE: 'max. tartási idő lejárt, valós árra vár',
  MARKET_DATA_STALE_RECENTLY: 'elavult piaci adat (utolsó 10 perc)', NO_PRICE_UPDATE_10M: '10 perce nincs árfrissítés',
};

function Comparison({ title, stats }: { title: string; stats: any }) {
  return <Panel title={title} description={`${(stats?.models ?? []).length} modell · ${stats?.sufficientSample ? '' : 'kis minta (< 30 lezárt trade): nem von le következtetést'}`}>
    <div className="metric-grid">
      <Metric label="ML döntés / ML BUY" value={`${fmt(stats?.decisions ?? 0, 0)} / ${fmt(stats?.mlBuy ?? 0, 0)}`} />
      <Metric label="Lezárt trade" value={fmt(stats?.trades ?? 0, 0)} />
      <Metric label="Találati arány" value={pct(stats?.winRate)} />
      <Metric label="Nettó P&L" value={usd(stats?.netPnl)} />
      <Metric label="Profit Factor" value={stats?.profitFactor == null ? '—' : fmt(stats.profitFactor, 2)} />
      <Metric label="STOP_LOSS arány" value={pct(stats?.stopLossRate)} />
    </div>
  </Panel>;
}

const METADATA_FAILURE_TEXT: Record<string, string> = {
  MISSING_URI: 'nincs URI', REJECTED_URL: 'biztonsági okból elutasított URL', DNS: 'DNS-hiba', PRIVATE_ADDRESS: 'privát cím (SSRF-védelem)', HTTP: 'HTTP-hiba', RATE_LIMITED: 'HTTP 429',
  TIMEOUT: 'időtúllépés', NETWORK: 'hálózati hiba', TOO_LARGE: 'túl nagy', JSON: 'JSON-hiba', REDIRECT_REJECTED: 'elutasított átirányítás',
};
const VIA_TEXT: Record<string, string> = { PUMP_FUN_METADATA: 'Pump.fun metadata', DEXSCREENER: 'DEX Screener', TELEGRAM_SEARCH: 'Telegram-keresés' };

/** Telegram + metadata discovery health (worker, credential-free) and the Telegram share of the Community ML snapshots. */
function TelegramPanel({ data }: { data: any }) {
  if (!data) return <Panel title="Telegram Intelligence"><LoadingState /></Panel>;
  const t = data.telegram;
  const d = t?.details ?? {};
  const m = data.metadata;
  const failed: Record<string, number> = m?.failed ?? {};
  return <Panel title="Telegram Intelligence és metadata-felderítés" description="MONITOR_ONLY: csak adatgyűjtés és Community feature-ök; kereskedési döntést nem változtat. Titkot, sessiont, telefonszámot és nyers üzenetet nem tartalmaz.">
    {!data.available ? <EmptyState message="Nincs friss social állapotjelentés a workertől." /> : <>
      <div className="metric-grid">
        <Metric label="Telegram állapot" value={t ? t.state : 'nincs'} note={t?.lastError ?? undefined} />
        <Metric label="Keresések / találatos" value={`${fmt(d.globalSearches ?? 0, 0)} / ${fmt(d.searchesWithHits ?? 0, 0)}`} note={`elfogadott találat: ${fmt(d.searchHits ?? 0, 0)}`} />
        <Metric label="Elutasított találat" value={fmt(Object.values(d.searchHitsRejected ?? {}).reduce((sum: number, value: any) => sum + Number(value), 0), 0)} note={Object.entries(d.searchHitsRejected ?? {}).filter(([, value]) => Number(value) > 0).map(([key, value]) => `${key}: ${value}`).join(' · ') || undefined} />
        <Metric label="Ellenőrzött forrás" value={fmt(d.verifiedSources ?? 0, 0)} note={Object.entries(d.accessibleByVia ?? {}).map(([key, value]) => `${VIA_TEXT[key] ?? key}: ${value}`).join(' · ')} />
        <Metric label="Aktívan figyelt csoport / csatorna" value={`${fmt(d.activeGroups ?? 0, 0)} / ${fmt(d.activeChannels ?? 0, 0)}`} />
        <Metric label="Friss / régi (kihagyott) üzenet" value={`${fmt(d.freshMessages ?? 0, 0)} / ${fmt(d.historicalMessagesSkipped ?? 0, 0)}`} note={d.lastFreshMessageAt ? `utolsó friss: ${date(d.lastFreshMessageAt)}` : 'még nincs friss üzenet'} />
        <Metric label="Tokenek Telegram-forrással" value={`${fmt(data.coverage?.withSource ?? 0, 0)} / ${fmt(data.coverage?.monitoredTokens ?? 0, 0)}`} note={`friss (5 p): ${fmt(data.coverage?.fresh ?? 0, 0)} · hivatalos link: ${fmt(data.coverage?.withOfficialLink ?? 0, 0)} · DEX link: ${fmt(data.coverage?.withDexScreenerLink ?? 0, 0)}`} />
        <Metric label="Community ML snapshot social adattal (24 ó)" value={pct(data.mlSnapshots24h?.share)} note={`${fmt(data.mlSnapshots24h?.withSocialData ?? 0, 0)} / ${fmt(data.mlSnapshots24h?.total ?? 0, 0)} · élő: ${fmt(data.mlLive?.withTelegram ?? 0, 0)} / ${fmt(data.mlLive?.snapshots ?? 0, 0)}`} />
      </div>
      {m ? <>
        <h4 className="section-title">Token metadata</h4>
        <div className="metric-grid">
          <Metric label="Metadata URI-val" value={fmt(m.withUri ?? 0, 0)} note={`hiányzó URI: ${fmt(m.missingUri ?? 0, 0)}`} />
          <Metric label="Sikeres feloldás" value={fmt(m.resolved ?? 0, 0)} note={`újrapróbálás: ${fmt(m.retries ?? 0, 0)} · sorban: ${fmt(m.retryQueue ?? 0, 0)}`} />
          <Metric label="Telegram-link a metadatában" value={fmt(m.withTelegramLink ?? 0, 0)} note={Object.entries(m.telegramLinkRejected ?? {}).map(([key, value]) => `elutasítva ${key}: ${value}`).join(' · ') || undefined} />
          <Metric label="DEX Screener Telegram-link" value={fmt(data.externalTelegramLinks?.accepted ?? 0, 0)} note={Object.entries(data.externalTelegramLinks?.rejected ?? {}).map(([key, value]) => `elutasítva ${key}: ${value}`).join(' · ') || undefined} />
        </div>
        <DataTable headers={['Hibaosztály', 'Darab']}>
          {Object.entries(failed).filter(([, value]) => Number(value) > 0).map(([key, value]) => <tr key={key}><td>{METADATA_FAILURE_TEXT[key] ?? key}</td><td>{fmt(Number(value), 0)}</td></tr>)}
        </DataTable>
      </> : null}
      {(data.coverage?.tokens ?? []).length ? <DataTable headers={['Token', 'Lefedés kezdete', 'Üzenet (memóriában)', 'Utolsó üzenet']}>
        {data.coverage.tokens.map((row: any) => <tr key={row.mint}><td>{row.symbol ?? '—'}<small className="sfield-help" style={{ display: 'block' }}>{row.mint.slice(0, 6)}…{row.mint.slice(-4)}</small></td><td>{date(row.coverageStart)}</td><td>{fmt(row.messages, 0)}</td><td>{row.lastMessageAt ? date(row.lastMessageAt) : '—'}</td></tr>)}
      </DataTable> : null}
    </>}
  </Panel>;
}

/** Community Intelligence + Community ML PAPER model: provider status, decisions with the community data of that moment, hourly funnel, comparison, stuck positions. */
export function CommunityTab() {
  const dashboard = useApi<{ data: any }>('/api/community/ml-dashboard?hours=24');
  const health = useApi<{ data: any }>('/api/community/health');
  const stuck = useApi<{ data: any }>('/api/positions/stuck-diagnostics');
  const telegram = useApi<{ data: any }>('/api/community/telegram-health');
  if (dashboard.loading && !dashboard.data) return <LoadingState />;
  if (dashboard.error) return <ErrorState message={dashboard.error} />;
  const d = dashboard.data?.data;
  if (!d) return <EmptyState message="Nincs adat." />;
  const providers: any[] = health.data?.data?.health?.providers ?? [];
  const s = stuck.data?.data;
  const hourly: any[] = d.hourly ?? [];
  const totals = hourly.reduce((acc, row) => ({ processed: acc.processed + row.processed, mlBuy: acc.mlBuy + row.mlBuy, safetyBlocked: acc.safetyBlocked + row.safetyBlocked, executionRejected: acc.executionRejected + row.executionRejected, executed: acc.executed + row.executed, wins: acc.wins + row.wins, losses: acc.losses + row.losses, netPnl: acc.netPnl + row.netPnl }), { processed: 0, mlBuy: 0, safetyBlocked: 0, executionRejected: 0, executed: 0, wins: 0, losses: 0, netPnl: 0 });
  const peak = hourly.reduce((max, row) => Math.max(max, row.mlBuy), 0);
  return <>
    <p className="sfield-help"><strong>Community Intelligence (MONITOR_ONLY).</strong> A Telegram / DEX Screener / on-chain (Helius stream) / opcionális LunarCrush adatok csak a <em>{d.featureVersions.community}</em> modellek bemenetei. A Community Score nem helyettesíti a kötelező honeypot-, eladhatósági, csalás-, likviditási, árhatás- és kockázati ellenőrzéseket, és egy szolgáltató kiesése nem állítja le a workert vagy az Exit Engine-t. A v3 modell ({d.featureVersions.baseline}) változatlan.</p>

    <Panel title="Adatforrások" description="A worker 5 másodpercenként frissíti; kulcsot és titkos adatot nem tartalmaz.">
      {providers.length === 0 ? <EmptyState message="Nincs friss állapotjelentés a workertől (nem fut, vagy a Community Intelligence ki van kapcsolva)." /> : <DataTable headers={['Forrás', 'Állapot', 'Kérés / siker / hiba', '429', 'Lefedettség', 'Késleltetés p50 / p95', 'Utolsó hiba']}>
        {providers.map((row) => <tr key={row.source}>
          <td>{row.source}</td>
          <td><Status tone={PROVIDER_TONE[row.state] ?? 'neutral'}>{PROVIDER_TEXT[row.state] ?? row.state}</Status></td>
          <td>{fmt(row.requests, 0)} / {fmt(row.successes, 0)} / {fmt(row.errors, 0)}</td>
          <td>{fmt(row.rateLimitEvents, 0)}</td>
          <td>{row.coverage ? `${fmt(row.coverage.covered ?? 0, 0)} / ${fmt(row.coverage.monitored ?? 0, 0)}` : '—'}</td>
          <td>{row.latencyP50Ms == null ? '—' : `${fmt(row.latencyP50Ms, 0)} / ${fmt(row.latencyP95Ms, 0)} ms`}</td>
          <td>{row.lastError ?? '—'}</td>
        </tr>)}
      </DataTable>}
      <p className="sfield-help">Telegram: a meglévő Social Intelligence integrációból. X: opcionális, hivatalos API nélkül nem gyűjt. LunarCrush: csak API-kulccsal, és csak ha a válasz a mint-címet tartalmazza.</p>
    </Panel>

    <TelegramPanel data={telegram.data?.data} />

    <Panel title="Community modellek" description="Csak a meglévő kapukon át választható: SHADOW_READY, minimális SHADOW-predikciószám, artifact-checksum, dataset-kompatibilitás és külön admin jóváhagyás.">
      {(d.communityModels ?? []).length === 0 ? <EmptyState message="Még nincs betanított Community modell. Ehhez valós, időhelyes community snapshotok és lezárt kimenetek kellenek (pnpm ml:dataset --feature-version ML-FEATURES-COMMUNITY-v1)." /> : <DataTable wide headers={['Modell', 'Állapot', 'Készenlét', 'Dataset', 'Tanítás', 'Community lefedettség', 'SHADOW predikció', 'PAPER jóváhagyás']}>
        {d.communityModels.map((row: any) => <tr key={row.version}>
          <td>{row.version}<small className="sfield-help" style={{ display: 'block' }}>{row.featureVersion}</small></td>
          <td>{row.status}</td>
          <td>{row.readiness}</td>
          <td>{row.datasetVersion}<small className="sfield-help" style={{ display: 'block' }}>{row.datasetRows == null ? '—' : `${fmt(row.datasetRows, 0)} sor`}</small></td>
          <td>{date(row.trainedAt)}</td>
          <td>{row.communityCoverage ? Object.entries(row.communityCoverage).map(([key, value]) => <small key={key} className="sfield-help" style={{ display: 'block' }}>{key}: {typeof value === 'number' ? fmt(value, value < 1 ? 3 : 0) : String(value)}</small>) : '—'}</td>
          <td>{fmt(row.shadowPredictions, 0)}</td>
          <td><Status tone={row.paperApproved ? 'positive' : 'neutral'}>{row.paperApproved ? 'JÓVÁHAGYVA' : 'NINCS'}</Status></td>
        </tr>)}
      </DataTable>}
    </Panel>

    <h3 className="section-title">Community modell vs. v3 modell (utolsó {d.hours} óra, lezárt PAPER tradek)</h3>
    <div className="dash-grid-2">
      <Comparison title={`Community (${d.featureVersions.community})`} stats={d.comparison?.community} />
      <Comparison title={`v3 / alap ML (${d.featureVersions.baseline})`} stats={d.comparison?.baseline} />
    </div>

    <Panel title="Óránkénti tölcsér (utolsó 24 óra)" description={`Jelkapacitás: legtöbb ML BUY egy órában: ${fmt(peak, 0)} (a végrehajtott tradektől külön mérve). A 100 PAPER trade / óra hosszú távú cél; a biztonsági, likviditási, méret-, napi veszteség-, kitettség- és pozíciólimitek nem lazulnak érte.`}>
      <div className="metric-grid">
        <Metric label="Feldolgozott döntés" value={fmt(totals.processed, 0)} />
        <Metric label="ML BUY" value={fmt(totals.mlBuy, 0)} />
        <Metric label="Biztonság tiltotta" value={fmt(totals.safetyBlocked, 0)} />
        <Metric label="Végrehajtás elutasítva" value={fmt(totals.executionRejected, 0)} />
        <Metric label="Végrehajtva" value={fmt(totals.executed, 0)} />
        <Metric label="Nyerő / vesztes" value={`${fmt(totals.wins, 0)} / ${fmt(totals.losses, 0)}`} note={usd(totals.netPnl)} />
      </div>
      <DataTable headers={['Óra', 'Feldolgozott', 'ML BUY', 'Biztonság tiltotta', 'Elutasítva', 'Végrehajtva', 'Nyerő', 'Vesztes', 'Nettó']}>
        {hourly.filter((row) => row.processed || row.wins || row.losses).reverse().map((row) => <tr key={row.hourStart}>
          <td>{date(row.hourStart)}</td><td>{fmt(row.processed, 0)}</td><td>{fmt(row.mlBuy, 0)}</td><td>{fmt(row.safetyBlocked, 0)}</td><td>{fmt(row.executionRejected, 0)}</td><td>{fmt(row.executed, 0)}</td><td>{fmt(row.wins, 0)}</td><td>{fmt(row.losses, 0)}</td><td>{usd(row.netPnl)}</td>
        </tr>)}
      </DataTable>
    </Panel>

    <Panel title="Tokenenkénti döntések a döntéskor ismert community adatokkal" description={`A döntés időpontjában vagy előtte tárolt legutolsó community snapshot (későbbi adat soha). Community adattal lefedett döntések: ${pct(d.communityCoverageOfDecisions)}.`}>
      {(d.tokens ?? []).length === 0 ? <EmptyState message="Az utolsó 24 órában nem volt ML PAPER döntés." /> : <DataTable wide headers={['Idő', 'Token', 'Community score / minőség', 'Momentum / spam', 'On-chain vevők (5p) / koncentráció', 'ML valószínűség / küszöb', 'Döntés', 'Biztonsági tiltók', 'Végrehajtás', 'Pozíció / nettó P&L', 'Kilépési ok']}>
        {d.tokens.map((row: any) => <tr key={row.id}>
          <td>{date(row.decidedAt)}<small className="sfield-help" style={{ display: 'block' }}>{row.modelVersion}</small></td>
          <td>{row.symbol ?? '—'}<small className="sfield-help" style={{ display: 'block' }}>{row.mint.slice(0, 6)}…{row.mint.slice(-4)}</small></td>
          <td>{row.community ? <>{score(row.community.communityScore)} <Status tone={QUALITY_TONE[row.community.quality] ?? 'neutral'}>{QUALITY_TEXT[row.community.quality] ?? row.community.quality}</Status>{row.community.paidPromotion ? <small className="sfield-help" style={{ display: 'block' }}>fizetett promóció</small> : null}</> : 'nincs snapshot'}</td>
          <td>{row.community ? `${score(row.community.socialMomentum)} / ${score(row.community.spamScore)}` : '—'}</td>
          <td>{row.community ? `${row.community.onchainBuyers5m ?? '—'} / ${row.community.buyerConcentration == null ? '—' : fmt(row.community.buyerConcentration, 2)}` : '—'}</td>
          <td>{row.probability == null ? '—' : `${row.probability.toFixed(3)} / ${row.threshold?.toFixed(2)}`}</td>
          <td><Status tone={row.mlDecision === 'ML_BUY' ? 'positive' : row.mlDecision === 'ML_ERROR' ? 'danger' : 'neutral'}>{row.mlDecision}</Status></td>
          <td>{row.safetyBlockers.length ? launchReasons(row.safetyBlockers).join(', ') : '—'}</td>
          <td>{row.outcome}{row.executionReason ? <small className="sfield-help" style={{ display: 'block' }}>{row.executionReason}</small> : null}</td>
          <td>{row.positionStatus ?? '—'}{row.netPnl != null ? <small className={row.netPnl >= 0 ? 'positive-value' : 'negative-value'} style={{ display: 'block' }}>{usd(row.netPnl)}</small> : null}</td>
          <td>{row.exitReason ?? '—'}</td>
        </tr>)}
      </DataTable>}
    </Panel>

    <Panel title="Beragadt pozíciók diagnosztikája" description="Csak diagnosztika: semmit nem zár le és nem módosít. A max. tartási idő a bekapcsolása után nyitott pozíciókra vonatkozik (Beállítások → New Launch).">
      {!s ? <LoadingState /> : <>
        <div className="metric-grid">
          <Metric label="Max. tartási idő" value={s.settings.maxHoldEnabled ? `${fmt(s.settings.maxHoldMinutes, 0)} perc` : 'kikapcsolva'} />
          <Metric label="Nyitott New Launch pozíció" value={`${fmt(s.openNewLaunchPositions, 0)} / ${s.settings.maxConcurrentPositions ?? '—'}`} note={s.positionLimitReached ? 'a pozíciólimit betelt: új belépés nincs' : undefined} />
          <Metric label="Beragadt (> 2 óra)" value={fmt(s.stuckPositions, 0)} />
          <Metric label="Max. hold néma tokenen / valós árra vár" value={s.exitMonitor ? `${fmt(s.exitMonitor.maxHoldOnSilentCurve ?? 0, 0)} / ${fmt(s.exitMonitor.maxHoldWaitingForQuote ?? 0, 0)}` : '—'} />
        </div>
        {s.positions.length === 0 ? <EmptyState message="Nincs nyitott PAPER pozíció." /> : <DataTable wide headers={['Token', 'Stratégia', 'Nyitva', 'Max. tartás vége', 'Utolsó frissítés', 'Utolsó esemény', 'Ok']}>
          {s.positions.map((row: any) => <tr key={row.id}>
            <td><Link className="table-link" href={`/positions/${row.id}`}>{row.symbol}</Link></td>
            <td>{row.entryStrategy ?? '—'}<small className="sfield-help" style={{ display: 'block' }}>{row.exitPolicy ?? 'globális'}</small></td>
            <td>{fmt(row.ageMinutes / 60, 1)} óra</td>
            <td>{row.maxHoldUntil ? date(row.maxHoldUntil) : 'nincs max. tartási idő'}</td>
            <td>{fmt(row.lastUpdateAgeSeconds, 0)} mp</td>
            <td>{row.lastEvent ? `${row.lastEvent.type} · ${date(row.lastEvent.at)}` : '—'}</td>
            <td>{row.stuck ? <Status tone="warning">BERAGADT</Status> : null}{row.reasons.map((reason: string) => <small key={reason} className="sfield-help" style={{ display: 'block' }}>{REASON_TEXT[reason] ?? reason}</small>)}</td>
          </tr>)}
        </DataTable>}
      </>}
    </Panel>
  </>;
}
