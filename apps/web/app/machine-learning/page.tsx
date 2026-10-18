'use client';
/* eslint-disable @typescript-eslint/no-explicit-any */

import { useState } from 'react';

import { TokenLabel } from '../avatars';
import { apiRequest, DataTable, EmptyState, ErrorState, fmt, LoadingState, Metric, PageHeader, Panel, Status, useApi } from '../components';

import { CommunityTab } from './community-tab';
import { PaperTab } from './paper-tab';

const TABS = [['overview', 'Áttekintés'], ['paper', 'PAPER stratégiák'], ['community', 'Community ML'], ['dataset', 'Dataset'], ['models', 'Modellek'], ['predictions', 'Shadow predikciók'], ['analysis', 'Elemzés'], ['drift', 'Drift'], ['system', 'Rendszer']] as const;
type Tab = (typeof TABS)[number][0];

const pct = (value: number | null | undefined, digits = 1) => (value == null ? '—' : `${(value * 100).toFixed(digits)}%`);
const num = (value: number | null | undefined, digits = 2) => (value == null ? '—' : fmt(value, digits));
const READINESS: Record<string, { tone: string; text: string }> = {
  INSUFFICIENT_DATA: { tone: 'danger', text: 'KEVÉS ADAT' }, RESEARCH_ONLY: { tone: 'warning', text: 'CSAK KUTATÁS' }, SHADOW_READY: { tone: 'positive', text: 'SHADOW-RA KÉSZ' },
  EVALUATE_VALIDATION: { tone: 'neutral', text: 'VALIDÁCIÓ ALAPJÁN' }, PAPER_EXPERIMENT_ELIGIBLE: { tone: 'positive', text: 'PAPER KÍSÉRLETRE ALKALMAS' },
};
const STATUS_TONE: Record<string, string> = { TRAINED: 'neutral', VALIDATED: 'warning', SHADOW: 'positive', RETIRED: 'neutral' };

function OutcomeTable({ rows, first }: { rows: any[] | undefined; first: string }) {
  if (!rows?.length) return <EmptyState message="Még nincs adat." />;
  return <DataTable wide headers={[first, 'Jelöltek', 'Kimenettel', 'Cél elérési arány', 'Átl. MFE (30p)', 'Átl. MAE (30p)', 'Átl. hozam (30p)']}>
    {rows.map((row) => <tr key={row.key}>
      <td><strong>{row.key}</strong></td>
      <td>{row.candidates}</td>
      <td>{row.withOutcome}{row.smallSample && row.withOutcome > 0 ? <span className="sample-note"> · kis minta</span> : null}</td>
      <td>{pct(row.targetRate)}</td>
      <td>{row.avgMfe30 == null ? '—' : `${fmt(row.avgMfe30, 1)}%`}</td>
      <td>{row.avgMae30 == null ? '—' : `${fmt(row.avgMae30, 1)}%`}</td>
      <td>{row.avgReturn30 == null ? '—' : `${fmt(row.avgReturn30, 1)}%`}</td>
    </tr>)}
  </DataTable>;
}

function Overview({ data }: { data: any }) {
  const worker = data.worker ?? {};
  const shadow = (data.models ?? []).find((model: any) => model.status === 'SHADOW');
  return <>
    <Panel title="Machine Learning – SHADOW mód" description="Helyi, statisztikai ML (nem LLM / nem AI Trader). A SHADOW előrejelzés csak rögzít, a kereskedésre NINCS hatása. ML PAPER belépés csak külön jóváhagyott modellel és kifejezetten kiválasztott ML stratégiával történhet (alapból kikapcsolt). Biztonság, kockázat, eladhatóság és kilépési kapacitás mindig felülírja.">
      <div className="metric-grid">
        <Metric label="ML mód" value={<Status tone="positive">{data.mode ?? 'SHADOW'}</Status>} note="ENFORCE_PAPER ebben a kiadásban nem elérhető" />
        <Metric label="Aktuális shadow modell" value={shadow?.version ?? 'nincs'} note={shadow ? (READINESS[shadow.readiness]?.text ?? shadow.readiness) : 'Modellt csak kifejezett admin művelet tesz SHADOW-ba'} />
        <Metric label="Jelöltek (24 óra, AGE_30S)" value={data.candidatesLast24h ?? 0} note={`Összes pillanatkép: ${Object.values(data.snapshotsByKind ?? {}).reduce((a: number, b: any) => a + Number(b), 0)}`} />
        <Metric label="Tanításra alkalmas arány" value={pct(data.validForTrainingRate)} note={`Átl. adatminőség: ${num(data.averageDataQuality, 0)}`} />
        <Metric label="Kimenetek" value={`${data.outcomes?.COMPLETE ?? 0} teljes`} note={`követés alatt ${data.outcomes?.TRACKING ?? 0} · részleges ${data.outcomes?.PARTIAL ?? 0} · elégtelen ${data.outcomes?.INSUFFICIENT ?? 0}`} />
        <Metric label="Predikciók" value={data.predictions ?? 0} note={worker.inferenceLatencyMs?.p50 != null ? `P50 ${num(worker.inferenceLatencyMs.p50, 3)} ms · P95 ${num(worker.inferenceLatencyMs.p95, 3)} ms` : 'nincs betöltött modell'} />
        <Metric label="Döntések a mintában" value={Object.entries(data.decisions ?? {}).map(([k, v]) => `${k} ${v}`).join(' · ') || '—'} note="BUY + WATCH + REJECT együtt (kiválasztási torzítás ellen)" />
        <Metric label="Források" value={Object.entries(data.sources ?? {}).map(([k, v]) => `${k} ${v}`).join(' · ') || '—'} />
        <Metric label="Utolsó tanítás" value={data.models?.[0]?.trainedAt ? new Date(data.models[0].trainedAt).toLocaleString('hu-HU') : 'még nem volt'} />
      </div>
      <p className="sfield-help">Az első mérföldkő a szivárgásmentes, jó minőségű adatgyűjtés – nem egy nyereséges modell. Az eredmények HISTORICAL / SHADOW / PAPER RESEARCH jellegűek, nem jövőbeli hozamot jeleznek.</p>
    </Panel>
    <Panel title="Parancsok" description="A tanítás csak kifejezett paranccsal indul (nincs rejtett újratanítás).">
      <ul className="analysis-list">{(data.commands ?? []).map((command: string) => <li key={command}><code>{command}</code></li>)}</ul>
    </Panel>
  </>;
}

function Datasets({ data }: { data: any }) {
  if (!data.datasets?.length) return <EmptyState message="Még nincs dataset. Elegendő lezárt kimenet után: pnpm ml:dataset" />;
  return <Panel title="Dataset verziók" description="Változtathatatlan, hash-elt verziók (ugyanabból a bemenetből ugyanaz az eredmény).">
    <DataTable wide headers={['Verzió', 'Cél', 'Sorok', 'Pozitív', 'Készültség', 'Időszak', 'Döntések', 'Források', 'Kizárva']}>
      {data.datasets.map((item: any) => <tr key={item.version}>
        <td><strong>{item.version}</strong><small className="sfield-help" style={{ display: 'block' }}>{new Date(item.createdAt).toLocaleString('hu-HU')} · {item.createdBy}</small></td>
        <td>{item.target}</td><td>{item.rowCount}</td><td>{item.positives ?? '—'}</td>
        <td><Status tone={READINESS[item.readiness]?.tone ?? 'neutral'}>{READINESS[item.readiness]?.text ?? item.readiness}</Status></td>
        <td>{item.startTime ? `${new Date(item.startTime).toLocaleDateString('hu-HU')} – ${new Date(item.endTime).toLocaleDateString('hu-HU')}` : '—'}</td>
        <td>{Object.entries(item.decisions ?? {}).map(([k, v]) => `${k} ${v}`).join(' · ')}</td>
        <td>{Object.entries(item.sourcesDist ?? {}).map(([k, v]) => `${k} ${v}`).join(' · ')}</td>
        <td>{Object.entries(item.excluded ?? {}).map(([k, v]) => `${k} ${v}`).join(' · ') || '—'}</td>
      </tr>)}
    </DataTable>
  </Panel>;
}

function ModelDetail({ model }: { model: any }) {
  const m = model.metrics?.metrics ?? {};
  const row = (name: string, metrics: any) => <tr key={name}><td><strong>{name}</strong></td><td>{metrics?.n ?? '—'}</td><td>{pct(metrics?.positiveRate)}</td><td>{num(metrics?.rocAuc, 3)}</td><td>{num(metrics?.prAuc, 3)}</td><td>{num(metrics?.precision, 3)}</td><td>{num(metrics?.recall, 3)}</td><td>{num(metrics?.f1, 3)}</td><td>{num(metrics?.brier, 4)}</td></tr>;
  return <>
    <DataTable wide headers={['Szakasz', 'Sorok', 'Alapráta', 'ROC-AUC', 'PR-AUC', 'Precision', 'Recall', 'F1', 'Brier']}>
      {row('Tanító', m.train)}{row('Validációs', m.validation)}{row('Teszt (érintetlen)', m.test)}
    </DataTable>
    {model.metrics?.overfittingRisk ? <p className="settings-warning">OVERFITTING_RISK – a teljesítmény mintán kívül jelentősen romlik.</p> : null}
    <DataTable wide headers={['Walk-forward fold', 'Tanító sorok', 'Teszt sorok', 'Purge', 'ROC-AUC', 'PR-AUC', 'Top jellemzők']}>
      {(model.metrics?.walkForward ?? []).map((fold: any) => <tr key={fold.fold}><td>{fold.fold}</td><td>{fold.trainRows ?? '—'}</td><td>{fold.testRows ?? '—'}</td><td>{fold.purged ?? '—'}</td><td>{num(fold.metrics?.rocAuc, 3)}</td><td>{num(fold.metrics?.prAuc, 3)}</td><td>{fold.topFeatures?.join(', ') ?? fold.skipped}</td></tr>)}
    </DataTable>
    <DataTable wide headers={['ML küszöb', 'Lefedettség', 'Kiválasztott', 'Precision', 'Alapráta', 'PAPER trade-ek', 'Nyertes-megtartás', 'Vesztes-kiszűrés', 'PF', 'Várható érték', 'Max. visszaesés']}>
      {(m.thresholdCurveTest ?? []).map((item: any) => <tr key={item.threshold}><td>{item.threshold}</td><td>{pct(item.coverage)}</td><td>{item.selected}</td><td>{pct(item.precision)}</td><td>{pct(item.baseRate)}</td><td>{item.paper?.trades}</td><td>{pct(item.paper?.winnerRetention)}</td><td>{pct(item.paper?.loserRejection)}</td><td>{num(item.paper?.profitFactor)}</td><td>{num(item.paper?.expectancy)}</td><td>{num(item.paper?.maxDrawdown)}</td></tr>)}
    </DataTable>
    <p className="sfield-help">Kalibráció: {model.metrics?.calibration ? `Platt (validációs adaton), a=${num(model.metrics.calibration.a, 3)}, b=${num(model.metrics.calibration.b, 3)} – a pontszám így közelít valószínűséghez` : 'nincs – az „ML pontszám” NEM nyerési valószínűség'}. Telegram ablation (teszt ROC-AUC Telegram nélkül / vele): {num(model.metrics?.socialAblation?.testRocAucWithoutSocial, 3)} / {num(model.metrics?.socialAblation?.testRocAucWithSocial, 3)}.</p>
    <DataTable headers={['Jellemző', 'Fontosság']}>{(model.metrics?.featureImportance ?? []).slice(0, 12).map((item: any) => <tr key={item.feature}><td>{item.feature}</td><td>{num(item.importance, 4)}</td></tr>)}</DataTable>
    <p className="sfield-help">A jellemző-fontosság nem ok-okozat.</p>
  </>;
}

function Models({ data, onChanged }: { data: any; onChanged: () => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const change = async (version: string, status: string) => {
    try {
      await apiRequest(`/api/ml/models/${version}/status`, { method: 'POST', body: JSON.stringify({ status }) });
      setMessage(`${version} → ${status}`);
      onChanged();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Nem sikerült');
    }
  };
  /** Separate, revocable PAPER approval (admin + e-mail). The blockers are shown first; nothing is approved automatically. */
  const approvePaper = async (version: string) => {
    try {
      const check = await apiRequest<{ data: { blockers: string[] } }>(`/api/ml/models/${version}/paper-approval`);
      if (check.data.blockers.length) {
        setMessage(`${version} nem hagyható jóvá PAPER kereskedésre: ${check.data.blockers.join(', ')}`);
        return;
      }
      if (!globalThis.confirm(`${version} jóváhagyása ML PAPER belépésekre.

Csak PAPER (LIVE soha). A jóváhagyás önmagában nem kapcsol be semmit: a felhasználónak külön, adminisztrátori megerősítéssel kell az ML stratégiát választania. Folytatod?`)) return;
      await apiRequest(`/api/ml/models/${version}/paper-approval`, { method: 'POST', body: '{}' });
      setMessage(`${version}: PAPER-jóváhagyva.`);
      onChanged();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Nem sikerült');
    }
  };
  const revokePaper = async (version: string) => {
    if (!globalThis.confirm(`${version} PAPER-jóváhagyásának visszavonása?

Az ezt a modellt használó ML stratégia azonnal leáll (nem nyit új pozíciót, és nem vált át automatikusan az alapstratégiára). A nyitott pozíciók kilépés-figyelése zavartalan.`)) return;
    try {
      await apiRequest(`/api/ml/models/${version}/paper-approval`, { method: 'DELETE' });
      setMessage(`${version}: PAPER-jóváhagyás visszavonva.`);
      onChanged();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Nem sikerült');
    }
  };
  if (!data.models?.length) return <EmptyState message="Még nincs tanított modell. Előbb dataset (pnpm ml:dataset), majd tanítás (pnpm ml:train)." />;
  return <Panel title="Modellek" description="Állapotok: TRAINED → VALIDATED → SHADOW (csak admin, e-mailes kóddal). A PAPER-jóváhagyás külön, visszavonható lépés: csak SHADOW_READY, SHADOW-ban tesztelt modellre, admin + e-mailes megerősítéssel. Nincs automatikus előléptetés vagy modellcsere.">
    {message ? <p className="sfield-help" role="status">{message}</p> : null}
    <DataTable wide headers={['Verzió', 'Algoritmus', 'Állapot', 'Készültség', 'Teszt ROC-AUC', 'Teszt PR-AUC', 'Overfitting', 'PAPER', 'Művelet']}>
      {data.models.map((model: any) => <tr key={model.version}>
        <td><button type="button" className="text-button" onClick={() => setOpen(open === model.version ? null : model.version)}><strong>{model.version}</strong></button><small className="sfield-help" style={{ display: 'block' }}>{model.datasetVersion} · {model.target}{model.featureVersion ? ` · ${model.featureVersion}` : ''}</small></td>
        <td>{model.algorithm === 'logistic_regression' ? 'Logisztikus regresszió (baseline)' : 'LightGBM'}</td>
        <td><Status tone={STATUS_TONE[model.status] ?? 'neutral'}>{model.status}</Status></td>
        <td><Status tone={READINESS[model.readiness]?.tone ?? 'neutral'}>{READINESS[model.readiness]?.text ?? model.readiness}</Status></td>
        <td>{num(model.metrics?.metrics?.test?.rocAuc, 3)}</td>
        <td>{num(model.metrics?.metrics?.test?.prAuc, 3)}</td>
        <td>{model.metrics?.overfittingRisk ? <Status tone="danger">RISK</Status> : '—'}</td>
        <td>{model.paperApproved ? <Status tone="positive">JÓVÁHAGYVA</Status> : <Status tone="neutral">NEM</Status>}</td>
        <td>
          {!model.paperApproved && (model.status === 'SHADOW' || model.status === 'VALIDATED') ? <button type="button" className="secondary-button small" onClick={() => void approvePaper(model.version)}>PAPER jóváhagyás</button> : null}
          {model.paperApproved ? <button type="button" className="secondary-button small" onClick={() => void revokePaper(model.version)}>PAPER visszavonás</button> : null}
          {model.status === 'TRAINED' ? <button type="button" className="secondary-button small" onClick={() => void change(model.version, 'VALIDATED')}>Validáltnak jelöl</button> : null}
          {model.status === 'VALIDATED' ? <button type="button" className="secondary-button small" onClick={() => void change(model.version, 'SHADOW')}>SHADOW-ba</button> : null}
          {model.status !== 'RETIRED' ? <button type="button" className="secondary-button small" onClick={() => void change(model.version, 'RETIRED')}>Visszavon</button> : null}
        </td>
      </tr>)}
    </DataTable>
    {open ? <ModelDetail model={data.models.find((model: any) => model.version === open)} /> : null}
  </Panel>;
}

function Predictions() {
  const { data, error, loading } = useApi<{ data: any }>('/api/ml/predictions?limit=80');
  if (loading && !data) return <LoadingState />;
  if (error) return <ErrorState message={error} />;
  const rows = data?.data?.rows ?? [];
  return <Panel title="Shadow predikciók (legutóbbi jelöltek, AGE_30S)" description={`Modell: ${data?.data?.modelVersion ?? 'nincs SHADOW modell – csak a pillanatképek és kimenetek gyűlnek'}. A predikció nem befolyásolja a kereskedést.`}>
    {!rows.length ? <EmptyState message="Még nincs ML pillanatkép (a worker gyűjti futás közben)." /> : <DataTable wide headers={['Token', 'Forrás', 'SolTrader döntés', 'Launch Score', 'Risk', 'ML pontszám', 'ML osztály', 'Cél (+20 a -10 előtt, 30p)', 'MFE / MAE (30p)', 'Ok']}>
      {rows.map((row: any) => <tr key={row.id}>
        <td><TokenLabel address={row.mint} symbol={row.symbol ?? row.mint.slice(0, 6)} /></td>
        <td>{row.source}</td>
        <td><Status tone={row.decision === 'BUY' ? 'positive' : row.decision === 'WATCH' ? 'warning' : 'neutral'}>{row.decision}</Status></td>
        <td>{num(row.launchScore, 0)}</td><td>{num(row.riskScore, 0)}</td>
        <td>{row.mlEntryScore ?? '—'}</td><td>{row.predictedClass ?? '—'}</td>
        <td>{row.label === 'true' ? 'IGEN' : row.label === 'false' ? 'NEM' : row.outcomeStatus === 'TRACKING' ? 'követés…' : 'ismeretlen'}</td>
        <td>{row.mfe30 == null ? '—' : `${fmt(row.mfe30, 1)}% / ${fmt(row.mae30, 1)}%`}</td>
        <td><small>{Array.isArray(row.reasons) ? row.reasons.slice(0, 2).join(', ') : '—'}</small></td>
      </tr>)}
    </DataTable>}
  </Panel>;
}

function Analysis() {
  const { data, error, loading } = useApi<{ data: any }>('/api/ml/analytics');
  if (loading && !data) return <LoadingState />;
  if (error) return <ErrorState message={error} />;
  const a = data?.data ?? {};
  return <>
    <Panel title="Döntés szerint (14 nap)" description={`${a.label} · ${a.sample?.candidates ?? 0} jelölt, ${a.sample?.labelled ?? 0} lezárt kimenettel. Kis mintából nem vonunk le következtetést.`}><OutcomeTable rows={a.byDecision} first="SolTrader döntés" /></Panel>
    <Panel title="SolTrader × ML" description={a.modelVersion ? `Modell: ${a.modelVersion}` : 'Nincs SHADOW modell – a mátrix üres.'}><OutcomeTable rows={a.matrix} first="Csoport" /></Panel>
    <section className="panel-grid">
      <Panel title="Launch Score × ML"><OutcomeTable rows={a.launchScoreByMl} first="Csoport" /></Panel>
      <Panel title="Belépési életkor × ML"><OutcomeTable rows={a.entryAgeByMl} first="Csoport" /></Panel>
    </section>
    <section className="panel-grid">
      <Panel title="Telegram × ML"><OutcomeTable rows={a.socialByMl} first="Csoport" /></Panel>
      <Panel title="Forrás szerint"><OutcomeTable rows={a.bySource} first="Forrás" /></Panel>
    </section>
    <Panel title="Kihagyott lehetőségek (REJECT/WATCH, magas ML, MFE ≥ 50%)" description="Nem bizonyítja, hogy a belépés biztonságos lett volna – az elutasítás oka is látszik.">
      {!a.missedOpportunities?.length ? <EmptyState message="Nincs ilyen eset (vagy még nincs modell)." /> : <DataTable headers={['Token', 'Döntés', 'ML', 'MFE 30p', 'Ok']}>{a.missedOpportunities.map((row: any) => <tr key={row.id}><td><TokenLabel address={row.mint} symbol={row.mint.slice(0, 6)} /></td><td>{row.decision}</td><td>{row.mlEntryScore}</td><td>{fmt(row.mfe30, 1)}%</td><td><small>{Array.isArray(row.reasons) ? row.reasons.join(', ') : '—'}</small></td></tr>)}</DataTable>}
    </Panel>
    <Panel title="Rossz belépések (BUY, alacsony ML, MAE ≤ -30%)" description="Csak kutatás.">
      {!a.badEntries?.length ? <EmptyState message="Nincs ilyen eset (vagy még nincs modell)." /> : <DataTable headers={['Token', 'ML', 'MAE 30p']}>{a.badEntries.map((row: any) => <tr key={row.id}><td><TokenLabel address={row.mint} symbol={row.mint.slice(0, 6)} /></td><td>{row.mlEntryScore}</td><td>{fmt(row.mae30, 1)}%</td></tr>)}</DataTable>}
    </Panel>
  </>;
}

function Drift() {
  const { data, error, loading } = useApi<{ data: any }>('/api/ml/analytics');
  if (loading && !data) return <LoadingState />;
  if (error) return <ErrorState message={error} />;
  const a = data?.data ?? {};
  return <Panel title="Drift" description="Az utolsó 24 óra jellemző-eloszlása a SHADOW modell tanító időszakához képest; teljesítmény a lezárt kimeneteken. Nincs automatikus újratanítás.">
    {a.alerts?.length ? <p className="settings-warning">{a.alerts.join(' · ')}</p> : <p className="sfield-help">Nincs drift-riasztás.</p>}
    <p className="sfield-help">Teljesítmény: friss ROC-AUC {num(a.performance?.recentAuc, 3)} (n={a.performance?.labelled ?? 0}) vs. validációs {num(a.performance?.validationAuc, 3)}.</p>
    {!a.drift?.length ? <EmptyState message="Nincs SHADOW modell, amihez viszonyítani lehetne." /> : <DataTable headers={['Jellemző', 'Tanító medián', 'Friss medián', 'Relatív változás', 'Hiány-arány változás', '']}>
      {a.drift.map((item: any) => <tr key={item.feature}><td>{item.feature}</td><td>{num(item.trainingMedian)}</td><td>{num(item.recentMedian)}</td><td>{pct(item.relativeChange, 0)}</td><td>{pct(item.missingShift, 0)}</td><td>{item.flagged ? <Status tone="warning">DRIFT</Status> : '—'}</td></tr>)}
    </DataTable>}
  </Panel>;
}

function System({ data }: { data: any }) {
  const w = data.worker;
  if (!w) return <EmptyState message="Nincs friss ml:health a workertől (nem fut, vagy ML_MODE=OFF)." />;
  return <Panel title="ML rendszer (worker)" description={`Frissítve ${new Date(w.at).toLocaleTimeString('hu-HU')} · ${w.featureVersion} · ${w.labelVersion}`}>
    <div className="metric-grid">
      <Metric label="Jelöltek (látott / alkalmas / nem alkalmas)" value={`${w.candidatesSeen} / ${w.candidatesEligible} / ${w.candidatesIneligible}`} />
      <Metric label="Pillanatképek / kihagyott pont" value={`${w.snapshotsCreated} / ${w.snapshotsMissedPoint}`} note={`Szivárgás-sértés: ${w.leakageViolations}`} />
      <Metric label="Követett kimenetek" value={w.trackedPaths} note={`indítva ${w.trackingStarted} · kész ${w.trackingCompleted} · eldobva (keret) ${w.trackingDropped}`} />
      <Metric label="Stream-kiesések" value={w.streamGaps} note={w.streamGapOpen ? 'jelenleg nincs stream' : 'stream rendben'} />
      <Metric label="Extra RPC / piaci adat kérés" value={`${data.additionalRpcRequests ?? w.additionalRpcRequests} / ${w.additionalMarketDataRequests}`} note="A kimenetek a meglévő pump.fun trade-streamből jönnek" />
      <Metric label="Írási sor / hibák / eldobott" value={`${w.writeQueueDepth} / ${w.writeFailures} / ${w.writesDropped}`} />
      <Metric label="Modell" value={w.model?.status ?? '—'} note={w.model?.version ?? w.model?.error ?? ''} />
      <Metric label="Pillanatkép számítás P50 / P95" value={w.snapshotLatencyMs?.p50 == null ? '—' : `${num(w.snapshotLatencyMs.p50, 3)} / ${num(w.snapshotLatencyMs.p95, 3)} ms`} />
    </div>
  </Panel>;
}

export default function MachineLearningPage() {
  const [tab, setTab] = useState<Tab>('overview');
  const { data, error, loading, refresh } = useApi<{ data: any }>('/api/ml/overview');
  return <div className="page-stack">
    <PageHeader eyebrow="Stratégiák" title="Machine Learning" subtitle="Szivárgásmentes adatgyűjtés minden jelöltről, offline tanítás, SHADOW predikció – kereskedési hatás nélkül." />
    <div className="segmented tab-bar" role="tablist" aria-label="Machine Learning nézetek">{TABS.map(([id, label]) => <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? 'selected' : ''} onClick={() => setTab(id)}>{label}</button>)}</div>
    {loading && !data ? <LoadingState /> : error ? <ErrorState message={error} /> : <>
      {tab === 'overview' ? <Overview data={data?.data ?? {}} /> : null}
      {tab === 'paper' ? <PaperTab /> : null}
      {tab === 'community' ? <CommunityTab /> : null}
      {tab === 'dataset' ? <Datasets data={data?.data ?? {}} /> : null}
      {tab === 'models' ? <Models data={data?.data ?? {}} onChanged={refresh} /> : null}
      {tab === 'predictions' ? <Predictions /> : null}
      {tab === 'analysis' ? <Analysis /> : null}
      {tab === 'drift' ? <Drift /> : null}
      {tab === 'system' ? <System data={data?.data ?? {}} /> : null}
    </>}
  </div>;
}
