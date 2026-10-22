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

/** ML-only operating states (shared contract, see strategy-contract.ts). */
const STATE_LABELS: Record<string, { text: string; tone: string; help: string }> = {
  DATA_COLLECTION: { text: 'ADATGYŰJTÉS', tone: 'neutral', help: 'Nincs kiválasztott kereskedési modell: a rendszer csak adatot gyűjt, új pozíciót nem nyit.' },
  MODEL_TRAINING: { text: 'MODELL TANUL', tone: 'info', help: 'A háttérben új modell tanul; az adatgyűjtés fut, kereskedési modell nincs kiválasztva.' },
  ML_PAPER_ACTIVE: { text: 'ML PAPER AKTÍV', tone: 'positive', help: 'A kiválasztott, jóváhagyott modell önállóan dönt a PAPER belépésekről; a kötelező biztonsági ellenőrzések mindig érvényesek.' },
  TRADING_PAUSED: { text: 'KERESKEDÉS SZÜNETEL', tone: 'warning', help: 'Nincs új belépés. Az adatgyűjtés és a nyitott pozíciók kilépésvédelme folytatódik.' },
  MODEL_UNAVAILABLE: { text: 'MODELL NEM ELÉRHETŐ', tone: 'danger', help: 'A kiválasztott modell nem használható (visszavonva, kivezetve vagy hiányzik): új pozíció nem nyílik, alapstratégiára nincs visszaváltás.' },
};

/** "Aktív PAPER stratégia": DEFAULT (rule-based) or an admin-approved ML model. PAPER only; LIVE is never reachable. */
export function PaperStrategyCard() {
  const { data, error, loading, refresh } = useApi<{ data: any }>('/api/settings/ml-paper');
  const settings = data?.data;
  const [mode, setMode] = useState<'DEFAULT' | 'ML'>('DEFAULT');
  const [modelVersion, setModelVersion] = useState<string>('');
  const [threshold, setThreshold] = useState(0.7);
  const [windowSeconds, setWindowSeconds] = useState(10);
  /** ML PAPER minimum liquidity input ('' = not set: the DEFAULT minimum applies). */
  const [minLiquidity, setMinLiquidity] = useState<string>('');
  const [message, setMessage] = useState<{ text: string; tone: 'info' | 'error' | 'success' } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!settings) return;
    setMode(settings.mlOnly ? 'ML' : settings.strategyMode);
    setModelVersion(
      (settings.approvedModels ?? []).some(
        (model: { version: string }) => model.version === settings.modelVersion
      )
        ? settings.modelVersion
        : settings.approvedModels?.[0]?.version ?? ''
    );
    setThreshold(settings.buyThreshold);
    setWindowSeconds(settings.decisionWindowSeconds);
    setMinLiquidity(settings.minLiquidity?.savedUsd == null ? '' : String(settings.minLiquidity.savedUsd));
  }, [settings]);

  if (loading && !settings) return <p className="sfield-help">Betöltés…</p>;
  if (error && !settings) return <p className="settings-error">{error}</p>;
  if (!settings) return null;

  const model = (settings.approvedModels ?? []).find((item: any) => item.version === modelVersion) ?? (settings.selectedModel?.version === modelVersion ? settings.selectedModel : null);
  const mlOnly = Boolean(settings.mlOnly);
  const active = settings.strategyMode === 'ML' && (!mlOnly || Boolean(settings.modelVersion));
  const state = settings.tradingState ? STATE_LABELS[settings.tradingState.state] ?? { text: settings.tradingState.state, tone: 'neutral', help: '' } : null;
  const thresholdValid = threshold >= settings.limits.thresholdMin && threshold <= settings.limits.thresholdMax;
  const health = settings.health?.model;
  const liquidity = settings.minLiquidity ?? { savedUsd: null, effectiveUsd: null, defaultStrategyUsd: null, suggestedUsd: 3000, floorUsd: 1250, maxUsd: 1_000_000 };
  const minLiquidityValue = minLiquidity.trim() === '' ? null : Number(minLiquidity);
  const minLiquidityValid = minLiquidityValue === null || (Number.isFinite(minLiquidityValue) && minLiquidityValue >= liquidity.floorUsd && minLiquidityValue <= liquidity.maxUsd);
  const usdText = (value: number | null | undefined) => (value == null ? '—' : `${fmt(value, 0)} USD`);

  const save = async (body: Record<string, unknown>, done: string, path = '/api/settings/ml-paper', method = 'PUT') => {
    setBusy(true);
    setMessage({ text: 'Mentés…', tone: 'info' });
    try {
      // Enabling ML / changing the model asks for the e-mailed confirmation code (handled by apiRequest).
      await apiRequest(path, { method, body: JSON.stringify(body) });
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
      {mlOnly && state ? <div className="status-row"><span>Működési állapot</span><Status tone={state.tone}>{state.text}</Status></div> : null}
      {mlOnly && state ? <p className="sfield-help">{state.help}{settings.tradingState?.reasons?.length ? ` (${settings.tradingState.reasons.join(', ')})` : ''}</p> : null}
      {mlOnly && settings.tradingState?.training ? <p className="sfield-help">Tanítás folyamatban: {settings.tradingState.training.dataset} · {date(settings.tradingState.training.startedAt)} – az aktív modellt nem módosítja.</p> : null}
      <div className="status-row"><span>Aktív PAPER stratégia</span><Status tone={active ? 'info' : 'positive'}>{active ? `ML-MODELL · ${settings.modelVersion}` : mlOnly ? 'NINCS KERESKEDÉSI MODELL' : 'ALAPSTRATÉGIA'}</Status></div>
      {active ? <div className="status-row"><span>Kereskedési mód</span><Status tone="info">ML BELÉPÉS + SZABÁLYALAPÚ KILÉPÉS</Status></div> : null}
      {active ? <div className="status-row"><span>ML minimális likviditás</span><span>{usdText(liquidity.effectiveUsd)}{liquidity.savedUsd == null ? ' (az alapstratégia minimuma – nincs külön ML érték mentve)' : ''}</span></div> : null}
      {active ? <div className="status-row"><span>Modell állapota</span>{settings.selectedModel?.usable ? <Status tone={health?.status === 'LOADED' ? 'positive' : 'warning'}>{health?.status === 'LOADED' ? 'BETÖLTVE' : health ? 'NEM ELÉRHETŐ' : 'NINCS JELENTÉS'}</Status> : <Status tone="danger">VISSZAVONVA – NINCS ML BELÉPÉS</Status>}</div> : null}
      {active && health?.error ? <p className="settings-warning">Modellhiba: {health.error}. Amíg fennáll, az ML nem nyit pozíciót, és nem vált át automatikusan az alapstratégiára.</p> : null}
      {active && settings.selectedModel && !settings.selectedModel.usable ? <p className="settings-warning">A kiválasztott modell PAPER-jóváhagyását visszavonták. Új ML belépés nem történik; válts modellt vagy térj vissza az alapstratégiára.</p> : null}
      <div className="status-row"><span>Utolsó sikeres ML-előrejelzés</span><span>{settings.lastPrediction ? `${date(settings.lastPrediction.decidedAt)} · ${pct(settings.lastPrediction.probability)} (${settings.lastPrediction.mlDecision})` : '—'}</span></div>
      <div className="status-row"><span>ML döntések (24 óra)</span><span>BUY {settings.decisions24h?.ML_BUY ?? 0} · SKIP {settings.decisions24h?.ML_SKIP ?? 0} · hiba {settings.decisions24h?.ML_ERROR ?? 0}</span></div>
    </div>

    {mlOnly ? <p className="sfield-help"><strong>ML-only:</strong> egyetlen kereskedési döntéshozó a kiválasztott, PAPER-jóváhagyott ML modell. Modell nélkül nincs új belépés; a tanítás és az adatgyűjtés a háttérben folytatódik, és új modell betanítása nem cseréli le a kiválasztottat.</p> : <fieldset className="strategy-choice">
      <legend className="sfield-label">Stratégia kiválasztása</legend>
      <label className={`choice${mode === 'DEFAULT' ? ' selected' : ''}`}><input type="radio" name="paper-strategy" checked={mode === 'DEFAULT'} onChange={() => setMode('DEFAULT')} /><span><strong>Alapstratégia</strong><small>A jelenlegi szabályalapú New Launch BUY / WATCH / REJECT logika. Az ML a háttérben SHADOW módban gyűjt és előrejelez.</small></span></label>
      <label className={`choice${mode === 'ML' ? ' selected' : ''}`}><input type="radio" name="paper-strategy" checked={mode === 'ML'} onChange={() => setMode('ML')} /><span><strong>ML-modell</strong><small>ML belépés + szabályalapú kilépés. A vételi döntést kizárólag egy admin által PAPER-re jóváhagyott modell hozza (az alapstratégia BUY / WATCH / REJECT döntése, pontszám-küszöbei, időablaka, minőségi szűrője és közösségi szűrője nem vétózhatja meg). A csalás- és honeypotvédelem (eladhatóság, honeypot-jelek, mint / freeze authority, Token-2022 korlátozások, rug-pull és likviditásvesztés) mindig kötelező és nem kapcsolható ki; ugyanígy a piaci / végrehajtási feltételek, a kockázati és számlalimitek és az Exit Engine. ML-alapú eladás nincs.</small></span></label>
    </fieldset>}

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
        <label className="sfield"><span className="sfield-label">ML PAPER – Minimális likviditás (USD)</span>
          <input type="number" min={liquidity.floorUsd} max={liquidity.maxUsd} step={100} value={minLiquidity} placeholder={`nincs megadva – az alapstratégia minimuma (${usdText(liquidity.defaultStrategyUsd)}) érvényes`} onChange={(event) => setMinLiquidity(event.target.value)} aria-invalid={!minLiquidityValid} />
          <span className={minLiquidityValid ? 'sfield-help' : 'sfield-error'}>{minLiquidityValid
            ? <>Csak az ML belépésekre vonatkozik; az alapstratégia minimuma ({usdText(liquidity.defaultStrategyUsd)}) változatlan. Most érvényes: <strong>{usdText(liquidity.effectiveUsd)}</strong>. Legalább {usdText(liquidity.floorUsd)} (végrehajtási alsó határ). Alacsonyabb likviditásnál nő az árhatás: a max. árhatás, a pozícióméret-, kitettség- és exit-capacity korlát, valamint a csalás- és honeypotvédelem változatlanul érvényes.</>
            : `${usdText(liquidity.floorUsd)} és ${usdText(liquidity.maxUsd)} közötti érték adható meg (vagy hagyd üresen).`}</span>
          {settings.minLiquidity?.savedUsd == null ? <button type="button" className="link-button" onClick={() => setMinLiquidity(String(liquidity.suggestedUsd))}>Javasolt kísérleti érték: {usdText(liquidity.suggestedUsd)} (mentés után érvényes)</button> : null}
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
        {active && !mlOnly ? <button type="button" className="secondary-button" disabled={busy} onClick={() => void save({ strategyMode: 'DEFAULT' }, 'Visszaváltva az alapstratégiára. Az ML SHADOW adatgyűjtés tovább fut.')}>Visszaváltás az alapstratégiára</button> : null}
        {mlOnly && active ? <button type="button" className="secondary-button" disabled={busy} onClick={() => void save({}, 'A modell leválasztva: csak adatgyűjtés, új belépés nincs. A nyitott pozíciók kilépésvédelme fut.', '/api/settings/ml-paper/clear-model', 'POST')}>Modell leválasztása (csak adatgyűjtés)</button> : null}
        {mlOnly ? <button type="button" className="secondary-button" disabled={busy} onClick={() => void save({ paused: !settings.tradingPaused }, settings.tradingPaused ? 'Kereskedés folytatva (a modell kapuk továbbra is érvényesek).' : 'Kereskedés szüneteltetve: új belépés nincs, a kilépésvédelem és az adatgyűjtés fut.', '/api/settings/ml-paper/pause', 'POST')}>{settings.tradingPaused ? 'Kereskedés folytatása' : 'Kereskedés szüneteltetése'}</button> : null}
        {mode === 'ML' ? <button type="button" className="primary-button" disabled={busy || !modelVersion || !thresholdValid || !minLiquidityValid || (!active && !settings.canEnable)} onClick={() => void save({ strategyMode: 'ML', modelVersion, buyThreshold: threshold, decisionWindowSeconds: windowSeconds, minLiquidityUsd: minLiquidityValue }, active ? 'ML PAPER beállítások elmentve.' : 'ML PAPER stratégia bekapcsolva.')}>{active ? 'ML beállítások mentése' : 'ML PAPER engedélyezése'}</button> : null}
        {mode === 'DEFAULT' && !active && !mlOnly ? <span className="sfield-help">Az alapstratégia aktív.</span> : null}
      </div>
    </div>
  </div>;
}
