'use client';
/* eslint-disable @typescript-eslint/no-explicit-any */

import Link from 'next/link';
import { useEffect, useState } from 'react';

import { apiRequest, date, fmt, Status, useApi } from '../components';
import { tradingBanner } from '../machine-learning/ml-view';

const NO_MODEL = '';

/**
 * "Aktív kereskedési ML modell": no model (data collection only) or one of the PAPER-approved Autonomous ML models.
 * Activation / switching asks for the e-mail confirmation (server side) and is audited; no DEFAULT selector here.
 * Open positions keep their model and stay protected by the mandatory protection when the model changes.
 */
export function ActiveModelCard() {
  const { data, error, loading, refresh } = useApi<{ data: any }>('/api/settings/ml-paper');
  const settings = data?.data;
  const autonomous = settings?.autonomous;
  const current = settings?.strategyMode === 'ML_AUTONOMOUS' ? settings.autonomousBundleVersion ?? NO_MODEL : NO_MODEL;
  const [choice, setChoice] = useState<string>(NO_MODEL);
  const [message, setMessage] = useState<{ text: string; tone: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    if (settings) setChoice(current);
  }, [settings, current]);
  if (loading && !settings) return <p className="sfield-help">Betöltés…</p>;
  if (error && !settings) return <p className="settings-error">{error}</p>;
  if (!settings) return null;

  const banner = tradingBanner(settings.tradingState, { mlOnly: Boolean(settings.mlOnly), strategyMode: settings.strategyMode, workerLoaded: autonomous?.workerReport?.loaded, workerError: autonomous?.workerReport?.error });
  const limits = autonomous?.riskLimits;
  const legacyMl = settings.strategyMode === 'ML';
  const send = async (path: string, method: string, body: Record<string, unknown>, done: string) => {
    setBusy(true);
    setMessage({ text: 'Mentés…', tone: 'info' });
    try {
      // Activation / switching: the e-mailed confirmation code is requested by apiRequest when the server asks for it.
      await apiRequest(path, { method, body: JSON.stringify(body) });
      setMessage({ text: done, tone: 'success' });
      setConfirming(false);
      refresh();
    } catch (saveError) {
      setMessage({ text: saveError instanceof Error ? saveError.message : 'A mentés sikertelen', tone: 'error' });
    } finally {
      setBusy(false);
    }
  };
  const apply = () => (choice === NO_MODEL
    ? send('/api/settings/ml-paper/clear-model', 'POST', {}, 'Nincs aktív modell: a rendszer csak adatot gyűjt. A nyitott pozíciók védelme folytatódik.')
    : send('/api/settings/ml-paper', 'PUT', { strategyMode: 'ML_AUTONOMOUS', autonomousBundleVersion: choice }, `Aktív modell: ${choice}. Az új belépésekre vonatkozik; a nyitott pozíciók az eredeti modelljükhöz kötve maradnak.`));

  return <div className="paper-strategy">
    <div className={`ml-banner ${banner.tone}`} role="status"><strong>{banner.title}</strong><span className="sfield-help">{banner.text}</span></div>
    <div className="status-list">
      <div className="status-row"><span>Aktív modell verziója</span><span>{current || (legacyMl && settings.modelVersion ? `${settings.modelVersion} (korábbi ML PAPER modell)` : !settings.mlOnly && settings.strategyMode === 'DEFAULT' ? 'Nincs ML modell – a régi DEFAULT stratégia aktív (ML-only mód kikapcsolva)' : 'Nincs modell – csak adatgyűjtés')}</span></div>
      <div className="status-row"><span>PAPER kereskedés</span><Status tone={settings.tradingState?.mayOpenEntries ? 'positive' : 'neutral'}>{settings.tradingState?.mayOpenEntries ? 'ÚJ BELÉPÉSEK ENGEDÉLYEZVE' : 'NINCS ÚJ BELÉPÉS'}</Status></div>
      <div className="status-row"><span>Modell betöltöttsége</span><span>{!current ? '—' : autonomous?.workerReport == null ? 'Nincs friss jelentés a workertől' : autonomous.workerReport.loaded === true ? 'Betöltve (checksum ellenőrizve)' : autonomous.workerReport.loaded === false ? `Nem tölthető be: ${autonomous.workerReport.error ?? 'ismeretlen hiba'}` : 'Még nem töltötte be a worker'}</span></div>
      {limits ? <div className="status-row"><span>Kockázati korlátok</span><span>pozíció ≤ {fmt(limits.maxPositionPctOfEquity, 1)}% · kitettség ≤ {fmt(limits.maxExposurePctOfEquity, 1)}% · napi veszteség ≤ {fmt(limits.dailyLossLimitPct, 1)}% · ≤ {fmt(limits.maxOpenPositions, 0)} nyitott · árhatás ≤ {fmt(limits.maxImpactPct, 1)}% · kemény veszteségkorlát {fmt(limits.hardMaxLossPct, 0)}%</span></div> : null}
    </div>

    <label className="sfield sgrid-spaced"><span className="sfield-label">Aktív kereskedési ML modell</span>
      <select value={choice} onChange={(event) => { setChoice(event.target.value); setConfirming(false); }} disabled={busy}>
        <option value={NO_MODEL}>Nincs modell – csak adatgyűjtés</option>
        {(autonomous?.approvedModels ?? []).map((model: any) => <option key={model.version} value={model.version}>{model.version} · {model.datasetVersion} · {date(model.trainedAt)}</option>)}
      </select>
      <span className="sfield-help">{(autonomous?.approvedModels ?? []).length ? 'Csak jóváhagyott (ellenőrzött) Autonomous ML modellek választhatók.' : 'Még nincs jóváhagyott modell. Tanítás és ellenőrzés: '}{(autonomous?.approvedModels ?? []).length ? null : <Link className="table-link" href="/machine-learning">Machine Learning</Link>}</span>
    </label>

    {confirming ? <div className="settings-warning">
      <strong>Megerősítés:</strong> {choice === NO_MODEL ? 'Az aktív modell kikapcsolása után nincs új belépés; a nyitott pozíciókat a kötelező védelem kezeli.' : `A(z) ${choice} modell önállóan dönt a PAPER belépésekről és kilépésekről a külön Autonomous PAPER számlán. A váltás e-mailes megerősítést kér és auditnaplóba kerül.`}
      <div className="header-actions sgrid-spaced">
        <button type="button" className="secondary-button" onClick={() => setConfirming(false)} disabled={busy}>Mégse</button>
        <button type="button" className="primary-button" onClick={() => void apply()} disabled={busy}>Megerősítem</button>
      </div>
    </div> : null}

    {message ? <p className={`settings-message ${message.tone}`} role="status">{message.text}</p> : null}
    <div className="card-toolbar sgrid-spaced">
      <p className="sfield-help">Csak PAPER: LIVE kereskedés ezzel nem kapcsolható be. Modellhiba vagy -váltás esetén sincs visszaváltás a régi DEFAULT stratégiára.</p>
      <div className="header-actions">
        <button type="button" className="secondary-button" disabled={busy} onClick={() => void send('/api/settings/ml-paper/pause', 'POST', { paused: !settings.tradingPaused }, settings.tradingPaused ? 'Új belépések engedélyezve (a modell kapuk továbbra is érvényesek).' : 'Új belépések szüneteltetve: a kilépésvédelem és az adatgyűjtés fut.')}>{settings.tradingPaused ? 'Új belépések engedélyezése' : 'Új belépések szüneteltetése'}</button>
        <button type="button" className="primary-button" disabled={busy || choice === current} onClick={() => setConfirming(true)}>Mentés</button>
      </div>
    </div>
  </div>;
}
