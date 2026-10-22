'use client';
/* eslint-disable @typescript-eslint/no-explicit-any */

import { useEffect, useState } from 'react';

import { apiRequest, date, DataTable, EmptyState, fmt, LoadingState, Metric, Panel, Status, useApi } from '../components';

import { isJobActive, JOB_STATUS_TEXT, stepsDone, TRAINING_STEPS, trainingStepStates } from './ml-view';

const STEP_ICON: Record<string, string> = { done: '✓', active: '●', pending: '○', failed: '✕', skipped: '–' };
const pct = (value: number | null | undefined) => (value == null ? '—' : `${(value * 100).toFixed(1)}%`);

/** Polls a URL while `active` (the job keeps running in the background when the browser is closed). */
export function usePolling<T>(url: string, active: boolean, intervalMs = 3_000) {
  const result = useApi<T>(url);
  useEffect(() => {
    if (!active) return undefined;
    const timer = globalThis.setInterval(() => result.refresh(), intervalMs);
    return () => globalThis.clearInterval(timer);
  }, [active, intervalMs, result.refresh]);
  return result;
}

/** "Új ML modell létrehozása": what the training will use, what is missing; Indítás creates a server-side job. */
export function TrainingModal({ isAdmin, onClose, onStarted }: { isAdmin: boolean; onClose: () => void; onStarted: (jobId: string) => void }) {
  const readiness = useApi<{ data: any }>('/api/ml/autonomous/dataset-readiness');
  const [name, setName] = useState('');
  const [dataset, setDataset] = useState('');
  const [message, setMessage] = useState<{ text: string; tone: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const r = readiness.data?.data;
  const start = async () => {
    setBusy(true);
    setMessage({ text: 'Tanítás indítása…', tone: 'info' });
    try {
      const body: Record<string, string> = {};
      if (name.trim()) body.name = name.trim();
      if (dataset) body.datasetVersion = dataset;
      const response = await apiRequest<{ data: { id: string } }>('/api/ml/autonomous/training-jobs', { method: 'POST', body: JSON.stringify(body) });
      onStarted(response.data.id);
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : 'Az indítás sikertelen', tone: 'error' });
    } finally {
      setBusy(false);
    }
  };
  return <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="training-title">
    <div className="confirm-modal training-modal">
      <h2 id="training-title">Új ML modell létrehozása</h2>
      <p className="sfield-help">A SolTrader a háttérben előkészíti a datasetet, betanítja és kiértékeli az Autonomous ML modellcsomagot, majd elmenti a modellek közé. A modell nem lesz automatikusan aktív: kereskedésre csak ellenőrzés, jóváhagyás és külön kiválasztás után használható. A böngésző bezárható, a tanítás folytatódik.</p>
      {readiness.loading && !r ? <LoadingState /> : !r ? <p className="settings-error">Az adatállapot nem tölthető be.</p> : <>
        <div className="sgrid sgrid-spaced">
          <label className="sfield"><span className="sfield-label">Modell neve (opcionális)</span>
            <input type="text" maxLength={60} value={name} onChange={(event) => setName(event.target.value)} placeholder="pl. Community Autonomous ML v2" />
            <span className="sfield-help">A verziót a rendszer generálja (ML-AUTO-&lt;dataset&gt;-s42).</span>
          </label>
          <label className="sfield"><span className="sfield-label">Dataset</span>
            <select value={dataset} onChange={(event) => setDataset(event.target.value)}>
              <option value="">Új dataset a jelenlegi adatokból (ajánlott)</option>
              {(r.datasets ?? []).map((item: any) => <option key={item.version} value={item.version}>{item.version} · {fmt(item.rowCount, 0)} sor · {date(item.createdAt)}</option>)}
            </select>
          </label>
        </div>
        <div className="metric-grid">
          <Metric label="Befejezett 60 perces árfolyampálya" value={fmt(r.completedPaths, 0)} note={r.period?.from ? `${date(r.period.from)} – ${date(r.period.to)}` : 'nincs adat'} />
          <Metric label="Várható belépési / pozíció minta" value={`≤ ${fmt(r.estimate.entryRowsUpperBound, 0)} / ≤ ${fmt(r.estimate.positionRowsUpperBound, 0)}`} note="felső becslés; a pontos szám a dataset elkészítésekor derül ki" />
          <Metric label="Élő döntési snapshot (belépés / pozíció)" value={`${fmt(r.liveSnapshots.entry, 0)} / ${fmt(r.liveSnapshots.position, 0)}`} />
          <Metric label="Utolsó dataset pozitív / negatív esetei" value={r.lastDataset ? `${fmt(r.lastDataset.positive ?? 0, 0)} / ${fmt(r.lastDataset.negative ?? 0, 0)}` : '—'} note={r.lastDataset ? r.lastDataset.version : 'még nem készült dataset'} />
          <Metric label="Telegram / Community lefedettség (7 nap)" value={pct(r.communityCoverage.share)} note={`${fmt(r.communityCoverage.withSocialData, 0)} / ${fmt(r.communityCoverage.snapshots7d, 0)} snapshot`} />
          <Metric label="Erőforrás" value="1 CPU-szál, alacsony prioritás" note={r.resources.lastTrainingMinutes != null ? `előző tanítás: ${fmt(r.resources.lastTrainingMinutes, 0)} perc (mért)` : 'még nincs mért tanítási idő'} />
        </div>
        {r.missing.length ? <div className="settings-warning"><strong>Nincs elegendő tanítóadat:</strong><ul className="analysis-list">{r.missing.map((item: string) => <li key={item}>{item}</li>)}</ul>A tanítás elindítható, de adat hiányában „Nincs elég tanítóadat” hibával fog leállni, modell nem készül.</div> : null}
        {r.warnings.length ? <ul className="analysis-list">{r.warnings.map((item: string) => <li key={item} className="sfield-help">⚠ {item}</li>)}</ul> : null}
      </>}
      {message ? <p className={`settings-message ${message.tone}`} role="status">{message.text}</p> : null}
      <div className="card-toolbar sgrid-spaced">
        {!isAdmin ? <span className="sfield-help">Tanítást csak adminisztrátor indíthat.</span> : <span className="sfield-help">Alapbeállításokkal fut (LightGBM, időrendi validáció, stressztesztek).</span>}
        <div className="header-actions">
          <button type="button" className="secondary-button" onClick={onClose}>Mégse</button>
          <button type="button" className="primary-button" disabled={!isAdmin || busy || !r} onClick={() => void start()}>Indítás</button>
        </div>
      </div>
    </div>
  </div>;
}

/** Live progress of one job (real reported steps, last update, error, safe log, open the finished model). */
export function TrainingProgress({ jobId, isAdmin, onOpenModel }: { jobId: string; isAdmin: boolean; onOpenModel: (version: string) => void }) {
  const [active, setActive] = useState(true);
  const { data, refresh } = usePolling<{ data: any }>(`/api/ml/autonomous/training-jobs/${jobId}`, active);
  const job = data?.data;
  useEffect(() => {
    if (job && !isJobActive(job.status)) setActive(false);
  }, [job]);
  const [showLog, setShowLog] = useState(false);
  if (!job) return <LoadingState />;
  const status = JOB_STATUS_TEXT[job.status] ?? { text: job.status, tone: 'neutral' };
  const steps = trainingStepStates(job);
  const cancel = async () => {
    await apiRequest(`/api/ml/autonomous/training-jobs/${job.id}/cancel`, { method: 'POST', body: '{}' }).catch(() => undefined);
    refresh();
  };
  return <Panel title={job.name || job.bundleVersion || 'Autonomous ML tanítás'} description={`Indította: ${job.requestedBy} · ${date(job.requestedAt)}`}>
    <div className="status-list">
      <div className="status-row"><span>Állapot</span><Status tone={status.tone}>{status.text}{job.cancelRequested && isJobActive(job.status) ? ' (megszakítás kérve)' : ''}</Status></div>
      <div className="status-row"><span>Lépések</span><span>{stepsDone(job)} / {TRAINING_STEPS.length} kész</span></div>
      <div className="status-row"><span>Utolsó frissítés</span><span>{date(job.heartbeatAt ?? job.updatedAt)}</span></div>
      {job.datasetVersion ? <div className="status-row"><span>Dataset</span><span>{job.datasetVersion}</span></div> : null}
    </div>
    <ol className="training-steps">
      {steps.map((step) => <li key={step.key} className={`training-step ${step.state}`}><span aria-hidden="true">{STEP_ICON[step.state]}</span> {step.label}</li>)}
    </ol>
    {job.error ? <p className="settings-warning">{job.error}</p> : null}
    {job.status === 'COMPLETED' && job.bundleVersion ? <p className="settings-message success">Elkészült: <strong>{job.bundleVersion}</strong> ({job.readiness}). A modell nem aktív; az alkalmasságot a Modellek fülön látod.</p> : null}
    <div className="card-toolbar">
      <button type="button" className="link-button" onClick={() => setShowLog(!showLog)}>{showLog ? 'Napló elrejtése' : 'Részletes napló'}</button>
      <div className="header-actions">
        {job.status === 'COMPLETED' && job.bundleVersion ? <button type="button" className="primary-button" onClick={() => onOpenModel(job.bundleVersion)}>Elkészült modell megnyitása</button> : null}
        {isAdmin && isJobActive(job.status) && !job.cancelRequested ? <button type="button" className="secondary-button" onClick={() => void cancel()}>Megszakítás</button> : null}
      </div>
    </div>
    {showLog ? <DataTable headers={['Idő', 'Lépés', 'Üzenet']}>{(job.log ?? []).map((entry: any, index: number) => <tr key={`${entry.at}-${index}`}><td>{date(entry.at)}</td><td>{entry.stage}</td><td>{entry.message}</td></tr>)}</DataTable> : null}
  </Panel>;
}

/** All training jobs with their logs (Speciális diagnosztika). */
export function TrainingLogs() {
  const { data, loading } = useApi<{ data: any }>('/api/ml/autonomous/training-jobs');
  const [open, setOpen] = useState<string | null>(null);
  if (loading && !data) return <LoadingState />;
  const jobs = data?.data?.jobs ?? [];
  return <Panel title="Tanítási naplók" description={data?.data?.trainer?.available ? `ml-trainer szolgáltatás fut (jelentés: ${date(data.data.trainer.at)})` : 'Az ml-trainer szolgáltatás nem jelentkezett (nem fut?)'}>
    {jobs.length === 0 ? <EmptyState message="Még nem indult tanítás." /> : <DataTable wide headers={['Indítva', 'Név', 'Állapot', 'Dataset', 'Modell', 'Hiba']}>
      {jobs.map((job: any) => <tr key={job.id} onClick={() => setOpen(open === job.id ? null : job.id)} className="clickable-row">
        <td>{date(job.requestedAt)}<small className="sfield-help" style={{ display: 'block' }}>{job.requestedBy}</small></td><td>{job.name ?? '—'}</td>
        <td><Status tone={JOB_STATUS_TEXT[job.status]?.tone ?? 'neutral'}>{JOB_STATUS_TEXT[job.status]?.text ?? job.status}</Status></td><td>{job.datasetVersion ?? '—'}</td><td>{job.bundleVersion ?? '—'}</td><td>{job.error ?? '—'}</td>
      </tr>)}
    </DataTable>}
    {open ? <TrainingProgress jobId={open} isAdmin={false} onOpenModel={() => undefined} /> : null}
  </Panel>;
}
