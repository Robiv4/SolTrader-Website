'use client';
/* eslint-disable @typescript-eslint/no-explicit-any */

import Link from 'next/link';
import { useState } from 'react';

import { apiRequest, DataTable, date, EmptyState, ErrorState, fmt, LoadingState, Metric, PageHeader, Panel, Status, useApi } from '../components';

import { isJobActive, JOB_STATUS_TEXT, SUITABILITY_TEXT, tradingBanner } from './ml-view';
import { TrainingModal, TrainingProgress, usePolling } from './training';

const TABS = [['overview', 'Áttekintés'], ['models', 'Modellek'], ['results', 'Eredmények']] as const;
type Tab = (typeof TABS)[number][0];

const usd = (value: number | null | undefined) => (value == null ? '—' : `${fmt(value, 2)} USDC`);
const pct = (value: number | null | undefined) => (value == null ? '—' : `${(value * 100).toFixed(1)}%`);
const num = (value: number | null | undefined, digits = 2) => (value == null ? '—' : fmt(value, digits));

function Banner({ settings }: { settings: any }) {
  const banner = tradingBanner(settings?.tradingState, { mlOnly: Boolean(settings?.mlOnly), strategyMode: settings?.strategyMode, workerLoaded: settings?.autonomous?.workerReport?.loaded, workerError: settings?.autonomous?.workerReport?.error });
  return <div className={`ml-banner ${banner.tone}`} role="status"><strong>{banner.title}</strong><span className="sfield-help">{banner.text}</span></div>;
}

function Overview({ settings, readiness, overview, results, jobs, onTrain }: { settings: any; readiness: any; overview: any; results: any; jobs: any[]; onTrain: () => void }) {
  const worker = overview?.worker;
  const streamAge = worker?.lastStreamEventAt ? (Date.now() - Date.parse(worker.lastStreamEventAt)) / 1000 : null;
  const latestJob = jobs[0];
  const activeVersion = settings?.tradingState?.entryStrategy === 'ML_AUTONOMOUS' ? settings?.autonomousBundleVersion : settings?.strategyMode === 'ML' && settings?.modelVersion ? settings.modelVersion : null;
  return <>
    <Banner settings={settings} />
    <div className="metric-grid">
      <Metric label="Adatgyűjtés" value={worker ? (streamAge !== null && streamAge < 60 ? 'Fut' : 'Nincs friss adat') : 'Nincs jelentés'} note={worker ? `utolsó esemény: ${worker.lastStreamEventAt ? date(worker.lastStreamEventAt) : '—'}` : 'a worker nem jelentett állapotot'} />
      <Metric label="Aktív kereskedési ML modell" value={activeVersion ?? 'Nincs kiválasztott modell'} note={!activeVersion && !settings?.mlOnly && settings?.strategyMode === 'DEFAULT' ? 'a régi DEFAULT stratégia aktív (ML-only mód kikapcsolva)' : undefined} />
      <Metric label="PAPER kereskedés" value={settings?.tradingState?.mayOpenEntries ? 'Aktív' : 'Nincs új belépés'} note={settings?.tradingPaused ? 'szüneteltetve' : undefined} />
      <Metric label="Megfigyelt tokenek (24 óra)" value={num(overview?.candidatesLast24h, 0)} note={`ML snapshot (AGE_30S): ${num(overview?.snapshotsByKind?.AGE_30S, 0)}`} />
      <Metric label="Tanításra alkalmas minták" value={readiness ? `≤ ${fmt(readiness.estimate.entryRowsUpperBound, 0)} / ≤ ${fmt(readiness.estimate.positionRowsUpperBound, 0)}` : '—'} note="belépés / pozíció (felső becslés)" />
      <Metric label="Adatminőség" value={overview?.validForTrainingRate != null ? pct(overview.validForTrainingRate) : '—'} note={`átlag: ${num(overview?.averageDataQuality, 0)} · Telegram lefedettség ${pct(readiness?.communityCoverage?.share)}`} />
      <Metric label="Legutóbbi dataset" value={readiness?.lastDataset?.version ?? 'Még nincs'} note={readiness?.lastDataset ? `${fmt(readiness.lastDataset.rows, 0)} sor · ${date(readiness.lastDataset.createdAt)}` : undefined} />
      <Metric label="Következő modell tanítása" value={readiness ? (readiness.canTrain ? 'Elegendő adat' : 'Nincs elég adat') : '—'} note={readiness?.missing?.[0]} />
      <Metric label="Aktuális modell PAPER eredménye" value={usd(results?.stats?.netPnl)} note={results?.stats ? `${fmt(results.stats.trades ?? 0, 0)} lezárt trade · PF ${num(results.stats.profitFactor)}` : 'nincs lezárt trade'} />
      <Metric label="Háttérben futó tanítás" value={latestJob && isJobActive(latestJob.status) ? JOB_STATUS_TEXT[latestJob.status]?.text ?? latestJob.status : 'Nincs'} note={latestJob ? `utolsó: ${JOB_STATUS_TEXT[latestJob.status]?.text ?? latestJob.status} · ${date(latestJob.requestedAt)}` : undefined} />
    </div>
    {readiness && !readiness.canTrain ? <p className="settings-warning">Nincs elég tanítóadat a következő modellhez: {readiness.missing.join(' ')}</p> : null}
    <div className="ml-toolbar"><span className="sfield-help">Új modell: az adatok előkészítése, tanítás, kiértékelés és mentés a háttérben fut.</span><button type="button" className="primary-button big-action" onClick={onTrain}>+ Új ML modell tanítása</button></div>
  </>;
}

function ModelReport({ version, isAdmin, onChanged }: { version: string; isAdmin: boolean; onChanged: () => void }) {
  const { data, loading, refresh } = useApi<{ data: any }>(`/api/ml/autonomous/models/${version}`);
  const [message, setMessage] = useState<{ text: string; tone: string } | null>(null);
  const m = data?.data;
  if (loading && !m) return <LoadingState />;
  if (!m) return <EmptyState message="A riport nem tölthető be." />;
  const entry = m.metrics?.entry ?? {};
  const suitability = SUITABILITY_TEXT[m.suitability?.code] ?? { text: m.suitability?.code, tone: 'neutral', help: '' };
  const act = async (path: string, method: string, done: string) => {
    setMessage({ text: 'Folyamatban…', tone: 'info' });
    try {
      await apiRequest(path, { method, body: '{}' });
      setMessage({ text: done, tone: 'success' });
      refresh();
      onChanged();
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : 'Sikertelen', tone: 'error' });
    }
  };
  const bt = (stats: any) => (stats ? `${fmt(stats.trades ?? 0, 0)} trade · ${usd(stats.netPnl)} · PF ${num(stats.profitFactor)} · max DD ${usd(stats.maxDrawdown)}` : '—');
  return <Panel title={`Riport – ${m.version}`} description={`${m.algorithm} · dataset ${m.datasetVersion} · ${date(m.createdAt)}`}>
    <div className="status-list">
      <div className="status-row"><span>Kereskedési alkalmasság</span><Status tone={suitability.tone}>{suitability.text}</Status></div>
      <p className="sfield-help">{suitability.help}</p>
      <div className="status-row"><span>Modell ellenőrzése</span><span>{m.status === 'SHADOW' ? `${fmt(m.check.shadowDecisions, 0)} / ${fmt(m.check.required, 0)} ellenőrzési döntés` : m.paperApproved ? 'befejezve, jóváhagyva' : 'nem indult'}</span></div>
      <div className="status-row"><span>Teszt (modell döntései)</span><span>{bt(entry.backtest?.policy)}</span></div>
      <div className="status-row"><span>Összehasonlítás: mind megvéve / véletlen</span><span>{usd(entry.backtest?.buyAll?.netPnl)} / {usd(entry.backtest?.randomSameCount?.netPnl)}</span></div>
      <div className="status-row"><span>Likviditási stressz (árhatás ×2 / ×3)</span><span>{usd(entry.liquidityStress?.impactX2?.netPnl)} / {usd(entry.liquidityStress?.impactX3?.netPnl)}</span></div>
      <div className="status-row"><span>Walk-forward</span><span>{(entry.walkForward ?? []).length ? `${entry.walkForward.filter((fold: any) => fold.netPnl > 0).length} / ${entry.walkForward.length} pozitív időszak` : '—'}</span></div>
      <div className="status-row"><span>Túlilleszkedés</span><span>{entry.overfitting ? `train ${num(entry.overfitting.trainSpearman)} / test ${num(entry.overfitting.testSpearman)}${entry.overfitting.risk ? ' · kockázat' : ''}` : '—'}</span></div>
      <div className="status-row"><span>Kilépési modell értéke a tesztben</span><span>{num(m.metrics?.exit?.test?.policyValuePct)} százalékpont (mindig tartás: {num(m.metrics?.exit?.test?.alwaysHoldValuePct)})</span></div>
      <div className="status-row"><span>Tanító sorok (train / validáció / teszt)</span><span>{num(entry.rows?.train, 0)} / {num(entry.rows?.validation, 0)} / {num(entry.rows?.test, 0)}</span></div>
      <div className="status-row"><span>Checksum</span><span><small className="sfield-help">{m.artifactHash}</small></span></div>
    </div>
    {Object.keys(entry.regimes ?? {}).length ? <DataTable headers={['Piaci rezsim', 'Sor', 'Trade', 'Nettó', 'PF']}>{Object.entries(entry.regimes).map(([regime, stats]: [string, any]) => <tr key={regime}><td>{regime}</td><td>{fmt(stats.rows ?? 0, 0)}</td><td>{fmt(stats.trades ?? 0, 0)}</td><td>{usd(stats.netPnl)}</td><td>{num(stats.profitFactor)}</td></tr>)}</DataTable> : null}
    {message ? <p className={`settings-message ${message.tone}`} role="status">{message.text}</p> : null}
    {isAdmin ? <div className="card-toolbar">
      <span className="sfield-help">Aktiválás: Beállítások → Aktív kereskedési ML modell (külön megerősítéssel).</span>
      <div className="header-actions">
        {m.suitability?.code === 'NOT_CHECKED' ? <button type="button" className="primary-button" onClick={() => void act(`/api/ml/autonomous/models/${m.version}/check`, 'POST', 'Az ellenőrzés elindult: a modell döntéseket hoz végrehajtás nélkül.')}>Modell ellenőrzése</button> : null}
        {m.suitability?.code === 'CHECK_COMPLETE' ? <button type="button" className="primary-button" onClick={() => void act(`/api/ml/autonomous/bundles/${m.version}/paper-approval`, 'POST', 'Jóváhagyva PAPER kereskedésre (még nincs kiválasztva).')}>Jóváhagyás PAPER kereskedésre</button> : null}
        {m.paperApproved ? <button type="button" className="secondary-button" onClick={() => void act(`/api/ml/autonomous/bundles/${m.version}/paper-approval`, 'DELETE', 'Jóváhagyás visszavonva.')}>Jóváhagyás visszavonása</button> : null}
      </div>
    </div> : null}
  </Panel>;
}

function Models({ models, isAdmin, onTrain, openVersion, setOpenVersion, onChanged }: { models: any[]; isAdmin: boolean; onTrain: () => void; openVersion: string | null; setOpenVersion: (version: string | null) => void; onChanged: () => void }) {
  return <>
    <div className="ml-toolbar"><span className="sfield-help">Minden elkészült modell megmarad; a korábbi modellek és datasetek nem törlődnek.</span><button type="button" className="primary-button big-action" onClick={onTrain}>+ Új ML modell tanítása</button></div>
    <Panel title="Modellek">
      {models.length === 0 ? <EmptyState message="Még nincs Autonomous ML modell. Indíts egy tanítást a „+ Új ML modell tanítása” gombbal." /> : <DataTable wide headers={['Verzió', 'Létrehozva', 'Dataset', 'Train / test', 'Nettó szimulált eredmény', 'PF', 'Max. DD', 'Adatminőség', 'Kereskedési alkalmasság', 'Státusz', '']}>
        {models.map((model) => {
          const suitability = SUITABILITY_TEXT[model.suitability.code] ?? { text: model.suitability.code, tone: 'neutral' };
          return <tr key={model.version}>
            <td><strong>{model.version}</strong>{model.name ? <small className="sfield-help" style={{ display: 'block' }}>{model.name}</small> : null}<small className="sfield-help" style={{ display: 'block' }}>{model.algorithm}</small></td>
            <td>{date(model.createdAt)}</td><td>{model.datasetVersion}</td>
            <td>{num(model.train.rows, 0)} / {num(model.test.rows, 0)} sor<small className="sfield-help" style={{ display: 'block' }}>rangkorreláció {num(model.train.spearman)} / {num(model.test.spearman)}</small></td>
            <td className={(model.test.netPnl ?? 0) >= 0 ? 'positive-value' : 'negative-value'}>{usd(model.test.netPnl)}<small className="sfield-help" style={{ display: 'block' }}>{num(model.test.trades, 0)} teszt-trade</small></td>
            <td>{num(model.test.profitFactor)}</td><td>{usd(model.test.maxDrawdown)}</td>
            <td>{num(model.dataQuality.rows, 0)} sor</td>
            <td><Status tone={suitability.tone}>{suitability.text}</Status></td>
            <td><Status tone={model.active ? 'positive' : 'neutral'}>{model.active ? 'AKTÍV' : 'inaktív'}</Status></td>
            <td><button type="button" className="link-button" onClick={() => setOpenVersion(openVersion === model.version ? null : model.version)}>{openVersion === model.version ? 'Riport bezárása' : 'Részletes riport'}</button></td>
          </tr>;
        })}
      </DataTable>}
    </Panel>
    {openVersion ? <ModelReport version={openVersion} isAdmin={isAdmin} onChanged={onChanged} /> : null}
  </>;
}

function PnlBars({ series }: { series: Array<{ period: string; pnl: number }> }) {
  if (!series.length) return <EmptyState message="Még nincs realizált P&L." />;
  const max = Math.max(...series.map((item) => Math.abs(item.pnl)), 0.01);
  return <div className="pnl-bars" role="img" aria-label="P&L időszakonként">
    {series.map((item) => <div key={item.period} className="pnl-bar" title={`${item.period}: ${fmt(item.pnl, 2)} USDC`}><span className={item.pnl >= 0 ? 'gain' : 'loss'} style={{ height: `${Math.max(2, Math.abs(item.pnl) / max * 100)}%` }} /></div>)}
  </div>;
}

function Results({ results, comparison }: { results: any; comparison: any }) {
  const [period, setPeriod] = useState<'daily' | 'weekly'>('daily');
  if (!results) return <LoadingState />;
  const stats = results.stats;
  return <>
    <Panel title={results.activeVersion ? `Aktív modell: ${results.activeVersion}` : 'Nincs aktív modell'} description="Autonomous ML külön virtuális PAPER számla; valódi pénz nincs.">
      {!results.account ? <EmptyState message="Még nincs Autonomous PAPER számla (az első modellkiválasztás után jön létre)." /> : <div className="metric-grid">
        <Metric label="Nettó PAPER profit" value={usd(stats?.netPnl)} />
        <Metric label="Profit factor" value={num(stats?.profitFactor)} />
        <Metric label="Találati arány" value={pct(stats?.winRate)} />
        <Metric label="Lezárt tradek" value={num(stats?.trades, 0)} note={stats?.sufficientSample ? undefined : 'kis minta (< 30)'} />
        <Metric label="Átlagos nettó trade eredmény" value={usd(stats?.expectancy)} />
        <Metric label="Maximum drawdown" value={usd(stats?.maxDrawdownUsd)} />
      </div>}
    </Panel>
    <Panel title="P&L" description="Realizált nettó eredmény a lezárt (és részben lezárt) pozíciókból, UTC szerint.">
      <div className="segmented" role="tablist">{(['daily', 'weekly'] as const).map((item) => <button key={item} type="button" role="tab" aria-selected={period === item} className={period === item ? 'selected' : ''} onClick={() => setPeriod(item)}>{item === 'daily' ? 'Napi' : 'Heti'}</button>)}</div>
      <PnlBars series={results[period] ?? []} />
    </Panel>
    <Panel title="Döntések (7 nap)">
      <div className="metric-grid">{['BUY', 'WAIT', 'SKIP', 'HOLD', 'PARTIAL_SELL', 'SELL', 'PROTECTION_SELL', 'ERROR'].map((action) => <Metric key={action} label={action} value={fmt(results.decisions?.[action] ?? 0, 0)} />)}</div>
    </Panel>
    <Panel title="Nyitott és lezárt pozíciók">
      {(results.positions ?? []).length === 0 ? <EmptyState message="Nincs pozíció." /> : <DataTable wide headers={['Token', 'Modell', 'Állapot', 'Belépés', 'Realizált P&L', 'Kilépési ok', 'Nyitva / zárva']}>
        {results.positions.map((row: any) => <tr key={row.id}>
          <td>{row.symbol ?? '—'}<small className="sfield-help" style={{ display: 'block' }}>{row.mint.slice(0, 6)}…{row.mint.slice(-4)}</small></td><td>{row.bundleVersion}</td>
          <td><Status tone={row.status === 'OPEN' ? 'info' : 'neutral'}>{row.status === 'OPEN' ? 'NYITOTT' : 'LEZÁRT'}</Status></td><td>{usd(row.entryNotionalUsd)}</td>
          <td className={(row.realizedPnlUsd ?? 0) >= 0 ? 'positive-value' : 'negative-value'}>{usd(row.realizedPnlUsd)}</td><td>{row.exitReason ?? '—'}</td><td>{date(row.openedAt)}{row.closedAt ? <small className="sfield-help" style={{ display: 'block' }}>{date(row.closedAt)}</small> : null}</td>
        </tr>)}
      </DataTable>}
    </Panel>
    <Panel title="Teljesítmény modellenként (élő PAPER)">
      <DataTable headers={['Modell', 'Lezárt trade', 'Nettó', 'PF', 'Találati arány', 'Max. DD']}>
        {(results.models ?? []).map((model: any) => <tr key={model.version}><td>{model.version}{model.active ? ' (aktív)' : ''}</td><td>{fmt(model.paper.trades, 0)}</td><td>{usd(model.paper.netPnl)}</td><td>{num(model.paper.profitFactor)}</td><td>{pct(model.paper.winRate)}</td><td>{usd(model.paper.maxDrawdownUsd)}</td></tr>)}
      </DataTable>
    </Panel>
    <Panel title="Stratégiák összehasonlítása (90 nap)" description="Mindegyik a saját számlájáról; a P&L nincs összekeverve.">
      <DataTable headers={['Stratégia', 'Trade', 'Nettó', 'PF', 'Találati arány']}>
        {Object.entries(comparison?.strategies ?? {}).map(([key, value]: [string, any]) => <tr key={key}><td>{({ DEFAULT: 'Régi DEFAULT', ML_V3: 'ML v3', ML_COMMUNITY: 'Community ML', ML_AUTONOMOUS: 'Autonomous ML' } as Record<string, string>)[key] ?? key}</td><td>{fmt(value.trades ?? 0, 0)}</td><td>{usd(value.netPnl)}</td><td>{num(value.profitFactor)}</td><td>{pct(value.winRate)}</td></tr>)}
      </DataTable>
    </Panel>
  </>;
}

export default function MachineLearningPage() {
  const [tab, setTab] = useState<Tab>('overview');
  const [training, setTraining] = useState(false);
  const [openVersion, setOpenVersion] = useState<string | null>(null);
  const me = useApi<{ data: { role: string } }>('/api/auth/me');
  const settings = useApi<{ data: any }>('/api/settings/ml-paper');
  const readiness = useApi<{ data: any }>('/api/ml/autonomous/dataset-readiness');
  const overview = useApi<{ data: any }>('/api/ml/overview');
  const models = useApi<{ data: any }>('/api/ml/autonomous/models');
  const results = useApi<{ data: any }>('/api/ml/autonomous/results');
  const comparison = useApi<{ data: any }>('/api/ml/autonomous/comparison?days=90');
  const jobsList = usePolling<{ data: any }>('/api/ml/autonomous/training-jobs', true, 10_000);
  const isAdmin = me.data?.data?.role === 'ADMIN';
  const jobs = jobsList.data?.data?.jobs ?? [];
  const runningJob = jobs.find((job: any) => isJobActive(job.status)) ?? null;
  const [watchJob, setWatchJob] = useState<string | null>(null);
  const shownJob = watchJob ?? runningJob?.id ?? null;
  if (settings.loading && !settings.data) return <div className="page-stack"><LoadingState /></div>;
  if (settings.error) return <div className="page-stack"><ErrorState message={settings.error} /></div>;
  const openModel = (version: string) => {
    models.refresh();
    setOpenVersion(version);
    setTab('models');
  };
  return <div className="page-stack">
    <PageHeader eyebrow="Stratégiák" title="Machine Learning" subtitle="Adatgyűjtés, modelltanítás és az ML PAPER kereskedés egy helyen." />
    <div className="ml-toolbar">
      <div className="segmented tab-bar" role="tablist" aria-label="Machine Learning nézetek">{TABS.map(([id, label]) => <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? 'selected' : ''} onClick={() => setTab(id)}>{label}</button>)}</div>
      <Link className="table-link" href="/machine-learning/diagnostics">Speciális diagnosztika →</Link>
    </div>
    {jobsList.data && !jobsList.data.data?.trainer?.available && runningJob ? <p className="settings-warning">A tanítás sorban áll, de az ml-trainer szolgáltatás nem jelentkezett. Amíg nem fut, a tanítás nem indul el.</p> : null}
    {shownJob ? <TrainingProgress jobId={shownJob} isAdmin={isAdmin} onOpenModel={openModel} /> : null}
    {tab === 'overview' ? <Overview settings={settings.data?.data} readiness={readiness.data?.data} overview={overview.data?.data} results={results.data?.data} jobs={jobs} onTrain={() => setTraining(true)} /> : null}
    {tab === 'models' ? (models.loading && !models.data ? <LoadingState /> : <Models models={models.data?.data?.models ?? []} isAdmin={isAdmin} onTrain={() => setTraining(true)} openVersion={openVersion} setOpenVersion={setOpenVersion} onChanged={() => { models.refresh(); settings.refresh(); }} />) : null}
    {tab === 'results' ? <Results results={results.data?.data} comparison={comparison.data?.data} /> : null}
    {training ? <TrainingModal isAdmin={isAdmin} onClose={() => setTraining(false)} onStarted={(id) => { setTraining(false); setWatchJob(id); jobsList.refresh(); readiness.refresh(); }} /> : null}
  </div>;
}
