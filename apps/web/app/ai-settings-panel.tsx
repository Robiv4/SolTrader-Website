'use client';

import { useCallback, useEffect, useState } from 'react';

import { apiRequest, fmt, Panel, Status } from './components';

export type AiSettings = {
  aiAnalysisEnabled: boolean;
  aiMinimumConfidence: number;
  aiRecheckSeconds: number;
  aiMaxAnalysesPerMinute: number;
  aiAllowHighRisk: boolean;
  aiAllowVeryHighRisk: boolean;
  aiDynamicExitSuggestionsEnabled: boolean;
  aiDecisionTtlSeconds: number;
  aiUseExitParameters: boolean;
  decisionMode: 'AI' | 'STRATEGY';
  provider: { name: string | null; model: string | null; status: 'CONNECTED' | 'UNAVAILABLE' | 'NOT_CONFIGURED'; promptVersion: string };
  usageToday: { analyses: number; cacheHits: number; apiCalls: number; failed: number; invalid: number; averageLatencyMs: number | null; inputTokens: number | null; outputTokens: number | null };
};

export const AI_MODE_EVENT = 'soltrader:ai-mode';

const PROVIDER_STATUS: Record<AiSettings['provider']['status'], { label: string; tone: string }> = {
  CONNECTED: { label: 'Csatlakozva', tone: 'positive' },
  UNAVAILABLE: { label: 'AI szolgáltató nem elérhető', tone: 'negative' },
  NOT_CONFIGURED: { label: 'Nincs konfigurálva', tone: 'warning' },
};

/** Notice shown on strategy settings while AI mode decides automatic entries (settings stay editable). */
export function AiModeStrategyNotice({ aiMode }: { aiMode: boolean }) {
  if (!aiMode) return null;
  return <p className="annotation risk-policy-warning ai-mode-notice">Az AI mód aktív: ezek a stratégiák most nem futnak és nem adnak jelzést – csak az AI dolgozik. A beállításaik megmaradnak, és a Stratégia módra visszaváltva ugyanígy működnek tovább.</p>;
}

/** "AI token elemzés" settings: decision mode switch, provider status (no secrets), limits and usage. */
export function AiSettingsPanel({ onModeChange }: { onModeChange?: (aiMode: boolean) => void }) {
  const [settings, setSettings] = useState<AiSettings | null>(null);
  const [message, setMessage] = useState<{ text: string; tone: 'success' | 'error' } | null>(null);
  const [saving, setSaving] = useState(false);

  const apply = useCallback((next: AiSettings) => {
    setSettings(next);
    onModeChange?.(next.aiAnalysisEnabled);
    globalThis.dispatchEvent(new globalThis.CustomEvent(AI_MODE_EVENT, { detail: next.aiAnalysisEnabled }));
  }, [onModeChange]);

  useEffect(() => {
    apiRequest<{ data: AiSettings }>('/api/settings/ai').then((response) => apply(response.data)).catch((error: Error) => setMessage({ text: error.message, tone: 'error' }));
  }, [apply]);

  const save = async (patch: Partial<AiSettings>) => {
    setSaving(true);
    setMessage(null);
    try {
      const response = await apiRequest<{ data: AiSettings }>('/api/settings/ai', { method: 'PUT', body: JSON.stringify(patch) });
      apply(response.data);
      setMessage({ text: patch.aiAnalysisEnabled === undefined ? 'Az AI-beállítások elmentve.' : patch.aiAnalysisEnabled ? 'AI mód bekapcsolva – az automatikus belépési döntést mostantól az AI hozza.' : 'Stratégia mód visszaállítva – az automatikus belépéseket újra a stratégiák adják.', tone: 'success' });
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : 'Mentés sikertelen', tone: 'error' });
    } finally {
      setSaving(false);
    }
  };

  if (!settings) return <Panel title="AI token elemzés" className="full-width-panel"><p className="annotation">{message?.text ?? 'Betöltés…'}</p></Panel>;
  const provider = PROVIDER_STATUS[settings.provider.status];
  const aiMode = settings.aiAnalysisEnabled;
  const number = (key: keyof AiSettings, label: string, min: number, max: number, step = 1) => (
    <label>{label}<input type="number" min={min} max={max} step={step} value={Number(settings[key])} onChange={(event) => setSettings({ ...settings, [key]: Math.min(max, Math.max(min, Math.round(Number(event.target.value) || min))) })} /></label>
  );
  const toggle = (key: keyof AiSettings, label: string) => (
    <label className="toggle-row"><input type="checkbox" checked={Boolean(settings[key])} onChange={(event) => setSettings({ ...settings, [key]: event.target.checked })} /> {label}</label>
  );

  return (
    <Panel title="AI token elemzés" className="full-width-panel">
      <div className={`decision-mode-banner ${aiMode ? 'ai' : 'strategy'}`}>
        <span>AKTÍV DÖNTÉSI MÓD</span>
        <strong>{aiMode ? 'AI' : 'Stratégia'}</strong>
        {aiMode ? <small>AI MÓD AKTÍV – csak az AI dolgozik. A Momentum, Breakout, Pullback stratégiák és az összetett jelzés nem futnak és nem adnak jelzést.</small> : <small>Az automatikus belépéseket a stratégiák és az összetett jelzés adják. AI-kérés nem történik.</small>}
      </div>

      <label className="toggle-row ai-main-toggle">
        <input type="checkbox" checked={aiMode} disabled={saving || (!aiMode && settings.provider.status !== 'CONNECTED')} onChange={(event) => void save({ aiAnalysisEnabled: event.target.checked })} />
        AI-alapú token elemzés és belépési döntés
      </label>
      <p className="annotation">Bekapcsolva kizárólag az AI Token Analyzer dolgozik: ő hozza az automatikus belépési döntést, a hagyományos stratégiák és az összetett jelzés ilyenkor nem futnak. A biztonsági és kockázati ellenőrzések továbbra is minden esetben érvényesek. A módváltás a nyitott pozíciókat nem érinti; azokat továbbra is a determinisztikus Stop Loss / Take Profit / trailing kezeli.</p>
      {settings.provider.status === 'NOT_CONFIGURED' ? <p className="annotation risk-policy-warning">Az AI szolgáltató nincs konfigurálva. Állíts be érvényes szerveroldali AI API-kulcsot.</p> : null}
      {settings.provider.status === 'UNAVAILABLE' ? <p className="annotation risk-policy-warning">Az AI szolgáltató nem elérhető. AI módban ilyenkor nincs automatikus vétel, és a stratégiák sem veszik át a döntést.</p> : null}

      <div className="ai-status-grid">
        <div><span>AI szolgáltató</span><strong>{settings.provider.name ?? '—'}</strong></div>
        <div><span>Modell</span><strong>{settings.provider.model ?? '—'}</strong></div>
        <div><span>Állapot</span><strong><Status tone={provider.tone}>{provider.label}</Status></strong></div>
        <div><span>Prompt verzió</span><strong>{settings.provider.promptVersion}</strong></div>
        <div><span>AI elemzések ma</span><strong>{settings.usageToday.analyses}</strong></div>
        <div><span>Cache-ből</span><strong>{settings.usageToday.cacheHits}</strong></div>
        <div><span>API hívások</span><strong>{settings.usageToday.apiCalls}</strong></div>
        <div><span>Sikertelen</span><strong>{settings.usageToday.failed + settings.usageToday.invalid}</strong></div>
        <div><span>Átlagos válaszidő</span><strong>{settings.usageToday.averageLatencyMs == null ? '—' : `${fmt(settings.usageToday.averageLatencyMs / 1000, 1)} s`}</strong></div>
        <div><span>Tokenek (be/ki)</span><strong>{settings.usageToday.inputTokens == null ? '—' : `${settings.usageToday.inputTokens} / ${settings.usageToday.outputTokens ?? 0}`}</strong></div>
      </div>

      <div className="field-grid">
        {number('aiMinimumConfidence', 'Minimum AI bizalom', 50, 100)}
        {number('aiRecheckSeconds', 'Újraelemzés (másodperc)', 15, 900, 5)}
        {number('aiMaxAnalysesPerMinute', 'Max. AI elemzés / perc', 1, 120)}
        {number('aiDecisionTtlSeconds', 'AI döntés érvényessége / kihagyás várakozás (mp)', 30, 3600, 10)}
        {toggle('aiAllowHighRisk', 'HIGH kockázatú tokenek elemzése / vétele')}
        {toggle('aiAllowVeryHighRisk', 'VERY HIGH kockázatú tokenek elemzése / vétele')}
        {toggle('aiUseExitParameters', 'AI kilépési paraméterek használata (SL/TP/trailing)')}
        {toggle('aiDynamicExitSuggestionsEnabled', 'Dinamikus AI kilépési javaslatok (csak megjelenítés)')}
      </div>
      <p className="annotation">A minimum bizalom alatti AI „VÉTEL” megfigyelésként kerül mentésre. Az AI javasolhat kisebb pozícióméretet, de a kockázatkezelés által engedélyezett maximumnál soha nem vehet többet. A kockázati kapcsolók a kemény tiltásokat (eladhatatlanság, honeypot, érvénytelen pool, elavult adat, kritikus likviditás) nem írják felül. Az AI bizalom az AI elemzési pontszáma, nem a nyereség valószínűsége – az Elemzések oldalon mérhető, mennyire megbízható.</p>
      <div className="row-inline" style={{ marginTop: 8 }}>
        {message ? <Status tone={message.tone === 'success' ? 'positive' : 'negative'}>{message.text}</Status> : <span />}
        <button type="button" className="secondary-button" disabled={saving} onClick={() => {
          const { aiMinimumConfidence, aiRecheckSeconds, aiMaxAnalysesPerMinute, aiDecisionTtlSeconds, aiAllowHighRisk, aiAllowVeryHighRisk, aiUseExitParameters, aiDynamicExitSuggestionsEnabled } = settings;
          void save({ aiMinimumConfidence, aiRecheckSeconds, aiMaxAnalysesPerMinute, aiDecisionTtlSeconds, aiAllowHighRisk, aiAllowVeryHighRisk, aiUseExitParameters, aiDynamicExitSuggestionsEnabled });
        }}>AI-beállítások mentése</button>
      </div>
    </Panel>
  );
}

/** Current decision mode for other views (listens to changes made in the AI settings panel). */
export function useAiMode() {
  const [aiMode, setAiMode] = useState(false);
  useEffect(() => {
    apiRequest<{ data: { aiAnalysisEnabled: boolean } }>('/api/settings/ai').then((response) => setAiMode(response.data.aiAnalysisEnabled)).catch(() => undefined);
    const listener = (event: globalThis.Event) => setAiMode(Boolean((event as globalThis.CustomEvent<boolean>).detail));
    globalThis.addEventListener(AI_MODE_EVENT, listener);
    return () => globalThis.removeEventListener(AI_MODE_EVENT, listener);
  }, []);
  return aiMode;
}
