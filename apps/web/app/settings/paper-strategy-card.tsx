'use client';
/* eslint-disable @typescript-eslint/no-explicit-any */

import Link from 'next/link';
import { useEffect, useState } from 'react';

import { apiRequest, date, fmt, Status, useApi } from '../components';

const BLOCKER_LABELS: Record<string, string> = {
  ADMIN_REQUIRED: 'Az ML PAPER mód bekapcsolása adminisztrátori jogosultságot igényel.',
  NO_PAPER_APPROVED_MODEL: 'Nincs PAPER-jóváhagyott modell (Machine Learning → Modellek → PAPER jóváhagyás).',
  PAPER_MODE_REQUIRED: 'Csak PAPER kereskedési módban (LIVE kikapcsolva) használható.',
  SERVER_NOT_PAPER: 'A szerver nem PAPER módban fut.',
};

const pct = (value: number | null | undefined, digits = 3) => (value == null ? '—' : fmt(value, digits));

/** "Aktív PAPER stratégia": DEFAULT (rule-based) or an admin-approved ML model. PAPER only; LIVE is never reachable. */
export function PaperStrategyCard() {
  const { data, error, loading, refresh } = useApi<{ data: any }>('/api/settings/ml-paper');
  const settings = data?.data;
  const [mode, setMode] = useState<'DEFAULT' | 'ML'>('DEFAULT');
  const [modelVersion, setModelVersion] = useState<string>('');
  const [threshold, setThreshold] = useState(0.7);
  const [windowSeconds, setWindowSeconds] = useState(10);
  const [message, setMessage] = useState<{ text: string; tone: 'info' | 'error' | 'success' } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!settings) return;
    setMode(settings.strategyMode);
    setModelVersion(
      (settings.approvedModels ?? []).some(
        (model: { version: string }) => model.version === settings.modelVersion
      )
        ? settings.modelVersion
        : settings.approvedModels?.[0]?.version ?? ''
    );
    setThreshold(settings.buyThreshold);
    setWindowSeconds(settings.decisionWindowSeconds);
  }, [settings]);

  if (loading && !settings) return <p className="sfield-help">Betöltés…</p>;
  if (error && !settings) return <p className="settings-error">{error}</p>;
  if (!settings) return null;

  const model = (settings.approvedModels ?? []).find((item: any) => item.version === modelVersion) ?? (settings.selectedModel?.version === modelVersion ? settings.selectedModel : null);
  const active = settings.strategyMode === 'ML';
  const thresholdValid = threshold >= settings.limits.thresholdMin && threshold <= settings.limits.thresholdMax;
  const health = settings.health?.model;

  const save = async (body: Record<string, unknown>, done: string) => {
    setBusy(true);
    setMessage({ text: 'Mentés…', tone: 'info' });
    try {
      // Enabling ML / changing the model asks for the e-mailed confirmation code (handled by apiRequest).
      await apiRequest('/api/settings/ml-paper', { method: 'PUT', body: JSON.stringify(body) });
      setMessage({ text: done, tone: 'success' });
      refresh();
    } catch (saveError) {
      setMessage({ text: saveError instanceof Error ? saveError.message : 'A mentés sikertelen', tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  return <div className="paper-strategy">
    <div className="status-list">
      <div className="status-row"><span>Aktív PAPER stratégia</span><Status tone={active ? 'info' : 'positive'}>{active ? `ML-MODELL · ${settings.modelVersion}` : 'ALAPSTRATÉGIA'}</Status></div>
      {active ? <div className="status-row"><span>Kereskedési mód</span><Status tone="info">ML BELÉPÉS + SZABÁLYALAPÚ KILÉPÉS</Status></div> : null}
      {active ? <div className="status-row"><span>Modell állapota</span>{settings.selectedModel?.usable ? <Status tone={health?.status === 'LOADED' ? 'positive' : 'warning'}>{health?.status === 'LOADED' ? 'BETÖLTVE' : health ? 'NEM ELÉRHETŐ' : 'NINCS JELENTÉS'}</Status> : <Status tone="danger">VISSZAVONVA – NINCS ML BELÉPÉS</Status>}</div> : null}
      {active && health?.error ? <p className="settings-warning">Modellhiba: {health.error}. Amíg fennáll, az ML nem nyit pozíciót, és nem vált át automatikusan az alapstratégiára.</p> : null}
      {active && settings.selectedModel && !settings.selectedModel.usable ? <p className="settings-warning">A kiválasztott modell PAPER-jóváhagyását visszavonták. Új ML belépés nem történik; válts modellt vagy térj vissza az alapstratégiára.</p> : null}
      <div className="status-row"><span>Utolsó sikeres ML-előrejelzés</span><span>{settings.lastPrediction ? `${date(settings.lastPrediction.decidedAt)} · ${pct(settings.lastPrediction.probability)} (${settings.lastPrediction.mlDecision})` : '—'}</span></div>
      <div className="status-row"><span>ML döntések (24 óra)</span><span>BUY {settings.decisions24h?.ML_BUY ?? 0} · SKIP {settings.decisions24h?.ML_SKIP ?? 0} · hiba {settings.decisions24h?.ML_ERROR ?? 0}</span></div>
    </div>

    <fieldset className="strategy-choice">
      <legend className="sfield-label">Stratégia kiválasztása</legend>
      <label className={`choice${mode === 'DEFAULT' ? ' selected' : ''}`}><input type="radio" name="paper-strategy" checked={mode === 'DEFAULT'} onChange={() => setMode('DEFAULT')} /><span><strong>Alapstratégia</strong><small>A jelenlegi szabályalapú New Launch BUY / WATCH / REJECT logika. Az ML a háttérben SHADOW módban gyűjt és előrejelez.</small></span></label>
      <label className={`choice${mode === 'ML' ? ' selected' : ''}`}><input type="radio" name="paper-strategy" checked={mode === 'ML'} onChange={() => setMode('ML')} /><span><strong>ML-modell</strong><small>ML belépés + szabályalapú kilépés. A vételi döntést kizárólag egy admin által PAPER-re jóváhagyott modell hozza (az alapstratégia BUY / WATCH / REJECT döntése, pontszám-küszöbei, időablaka, minőségi szűrője és közösségi szűrője nem vétózhatja meg). A kötelező biztonsági, kockázati és likviditási szabályok, a limitek és az Exit Engine változatlanul érvényesek. ML-alapú eladás nincs.</small></span></label>
    </fieldset>

    {mode === 'ML' ? <>
      {!settings.canEnable && !active ? settings.enableBlockers.map((reason: string) => <p key={reason} className="settings-warning">{BLOCKER_LABELS[reason] ?? reason}</p>) : null}
      <div className="sgrid sgrid-spaced">
        <label className="sfield"><span className="sfield-label">Modellverzió</span>
          <select value={modelVersion} onChange={(event) => setModelVersion(event.target.value)} disabled={(settings.approvedModels ?? []).length === 0}>
            {(settings.approvedModels ?? []).length === 0 ? <option value="">Nincs PAPER-jóváhagyott modell</option> : null}
            {(settings.approvedModels ?? []).map((item: any) => <option key={item.version} value={item.version}>{item.version} ({item.algorithm}, {item.snapshotKind ?? '?'})</option>)}
          </select>
        </label>
        <label className="sfield"><span className="sfield-label">ML BUY küszöb ({settings.limits.thresholdMin.toFixed(2)}–{settings.limits.thresholdMax.toFixed(2)})</span>
          <input type="number" min={settings.limits.thresholdMin} max={settings.limits.thresholdMax} step={0.01} value={threshold} onChange={(event) => setThreshold(Number(event.target.value))} aria-invalid={!thresholdValid} />
          <span className={thresholdValid ? 'sfield-help' : 'sfield-error'}>{thresholdValid ? 'ML BUY, ha a kalibrált valószínűség ≥ küszöb. Magasabb küszöb = kevesebb, szigorúbb belépés.' : 'A küszöb a megengedett tartományon kívül esik.'}</span>
        </label>
        <label className="sfield"><span className="sfield-label">Belépési ablak a döntés után (mp)</span>
          <input type="number" min={2} max={settings.limits.windowMaxSeconds} step={1} value={windowSeconds} onChange={(event) => setWindowSeconds(Math.round(Number(event.target.value)))} />
          <span className="sfield-help">Az ML BUY ennyi ideig várhat a kötelező biztonsági feltételekre (pl. eladhatóság igazolása), utána lejár.</span>
        </label>
      </div>
      {model ? <div className="status-list sgrid-spaced">
        <div className="status-row"><span>Állapot / készültség</span><span><Status tone="info">{model.status}</Status> <Status tone={model.readiness === 'SHADOW_READY' ? 'positive' : 'warning'}>{model.readiness}</Status></span></div>
        <div className="status-row"><span>Döntési pont (snapshot)</span><span>{model.snapshotKind ?? '—'} – a modell csak ennél az időpontnál dönt, a belépés ezután történhet</span></div>
        <div className="status-row"><span>Teszt ROC-AUC / PR-AUC</span><span>{pct(model.metrics.testRocAuc)} / {pct(model.metrics.testPrAuc)}</span></div>
        <div className="status-row"><span>Teszt precision / recall / Brier</span><span>{pct(model.metrics.testPrecision)} / {pct(model.metrics.testRecall)} / {pct(model.metrics.testBrier)}</span></div>
        <div className="status-row"><span>Walk-forward AUC szórás</span><span>{pct(model.metrics.walkForwardAucStd)}{model.metrics.overfittingRisk ? ' · túlilleszkedés kockázat' : ''}</span></div>
        <div className="status-row"><span>PAPER-jóváhagyás</span><span>{model.paperApprovedAt ? `${date(model.paperApprovedAt)} · ${model.paperApprovedBy ?? ''}` : '—'}</span></div>
      </div> : null}
    </> : null}

    {message ? <p className={`settings-message ${message.tone}`} role="status">{message.text}</p> : null}
    <div className="card-toolbar sgrid-spaced">
      <p className="sfield-help">Csak PAPER: ezzel a funkcióval LIVE kereskedés semmilyen módon nem kapcsolható be. A kilépéseket mindkét módban a közös Exit Engine kezeli; modellhiba esetén is. Részletes összehasonlítás: <Link className="table-link" href="/machine-learning">Machine Learning → PAPER stratégiák</Link>.</p>
      <div className="header-actions">
        {active ? <button type="button" className="secondary-button" disabled={busy} onClick={() => void save({ strategyMode: 'DEFAULT' }, 'Visszaváltva az alapstratégiára. Az ML SHADOW adatgyűjtés tovább fut.')}>Visszaváltás az alapstratégiára</button> : null}
        {mode === 'ML' ? <button type="button" className="primary-button" disabled={busy || !modelVersion || !thresholdValid || (!active && !settings.canEnable)} onClick={() => void save({ strategyMode: 'ML', modelVersion, buyThreshold: threshold, decisionWindowSeconds: windowSeconds }, active ? 'ML PAPER beállítások elmentve.' : 'ML PAPER stratégia bekapcsolva.')}>{active ? 'ML beállítások mentése' : 'ML PAPER engedélyezése'}</button> : null}
        {mode === 'DEFAULT' && !active ? <span className="sfield-help">Az alapstratégia aktív.</span> : null}
      </div>
    </div>
  </div>;
}
