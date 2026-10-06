'use client';

import { useCallback, useEffect, useState } from 'react';

import { AiModeStrategyNotice } from './ai-settings-panel';
import { apiRequest, Panel, Status } from './components';
import { MODULE_LABELS_HU, MODULE_PARAMETER_LABELS } from './locales/strategy-labels';

type ModuleSettings = { enabled: boolean; weight: number; minScore: number; [key: string]: number | boolean };
type AdvancedSettings = {
  compositeEnabled: boolean;
  minimumConfirmations: number;
  minimumCompositeScore: number;
  penalizeUnavailable: boolean;
  exhaustionEnabled: boolean;
  exhaustionWarningThreshold: number;
  exhaustionStrongWarningThreshold: number;
  exhaustionBlockThreshold: number;
  exhaustionPolicy: 'BLOCK' | 'WARN_ONLY';
  exhaustionPenaltyWeight: number;
  liquidityOutflowExitEnabled: boolean;
  liquidityOutflowExitPercent: number;
  modules: Record<string, ModuleSettings>;
  requiredHistoryMinutes: Record<string, number>;
  persisted: boolean;
};

const POSITIVE_MODULES = ['Momentum', 'MomentumAcceleration', 'VolumeSpike', 'BuyPressure', 'ConfirmedBreakout', 'LiquidityInflow', 'RelativeStrength', 'PullbackContinuation'];

/** "Haladó stratégiák": per-user module switches, weights, thresholds and the composite/exhaustion policy (PostgreSQL). */
export function AdvancedStrategiesPanel({ aiMode = false }: { aiMode?: boolean }) {
  const [settings, setSettings] = useState<AdvancedSettings | null>(null);
  const [message, setMessage] = useState<{ text: string; tone: 'success' | 'error' } | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const response = await apiRequest<{ data: AdvancedSettings }>('/api/settings/advanced-strategies');
    setSettings(response.data);
  }, []);

  useEffect(() => { void load().catch((error: Error) => setMessage({ text: error.message, tone: 'error' })); }, [load]);

  if (!settings) return <Panel title="Haladó stratégiák" className="full-width-panel"><p className="annotation">{message?.text ?? 'Betöltés…'}</p></Panel>;

  const update = (patch: Partial<AdvancedSettings>) => setSettings({ ...settings, ...patch });
  const updateModule = (name: string, patch: Partial<ModuleSettings>) => setSettings({ ...settings, modules: { ...settings.modules, [name]: { ...settings.modules[name], ...patch } as ModuleSettings } });
  const numberInput = (value: number, onChange: (next: number) => void, props: { min?: number; max?: number; step?: number } = {}) => (
    <input type="number" min={props.min ?? 0} max={props.max} step={props.step ?? 1} value={value} onChange={(event) => onChange(event.target.value === '' ? 0 : Number(event.target.value))} />
  );

  const save = async () => {
    setSaving(true);
    setMessage(null);
    try {
      // Read-only fields (defaults, required history) are ignored by the API.
      const response = await apiRequest<{ data: AdvancedSettings }>('/api/settings/advanced-strategies', { method: 'PUT', body: JSON.stringify(settings) });
      setSettings(response.data);
      setMessage({ text: 'A haladó stratégia-beállítások elmentve. A worker a következő ciklustól ezekkel számol.', tone: 'success' });
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : 'Mentés sikertelen', tone: 'error' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Panel title="Haladó stratégiák" className={`full-width-panel ${aiMode ? 'ai-mode-dimmed' : ''}`}>
      <AiModeStrategyNotice aiMode={aiMode} />
      <p className="annotation">Rövid távú memecoin-jelzések PAPER kísérletezéshez. A modulok csak elemeznek – vételt kizárólag a meglévő kockázatkezelés és PAPER végrehajtás indíthat. Az alapértékek kísérleti kiindulópontok, nem garantálnak nyereséget. Amíg egy modulhoz nincs elég ártörténet, „Adatgyűjtés folyamatban” állapotban van, és nem számít bele a jelzésbe.</p>

      <div className="advanced-section">
        <h3>Összetett jelzés</h3>
        <div className="field-grid">
          <label className="toggle-row"><input type="checkbox" checked={settings.compositeEnabled} onChange={(event) => update({ compositeEnabled: event.target.checked })} /> Összetett jelzés vételi jelzést adhat</label>
          <label>Minimális megerősítések száma{numberInput(settings.minimumConfirmations, (value) => update({ minimumConfirmations: value }), { min: 1, max: 8 })}</label>
          <label>Minimális összetett pontszám{numberInput(settings.minimumCompositeScore, (value) => update({ minimumCompositeScore: value }), { max: 100 })}</label>
          <label className="toggle-row"><input type="checkbox" checked={settings.penalizeUnavailable} onChange={(event) => update({ penalizeUnavailable: event.target.checked })} /> Nem elérhető modul 0 pontként számít</label>
        </div>
        <p className="annotation">Kikapcsolva az elemzés látszik a token részleteinél, de az összetett jelzés nem ad vételi jelzést. Bekapcsolva is csak akkor ad, ha legalább ennyi engedélyezett modul megerősít, a pontszám eléri a küszöböt, és nincs kifáradás-tiltás vagy kritikus likviditás-kiáramlás. A kockázati besorolás, a pozícióméret-szorzó és a kemény tiltások ettől függetlenül érvényesek.</p>
      </div>

      <div className="strategy-grid">
        {POSITIVE_MODULES.map((name) => {
          const module = settings.modules[name];
          if (!module) return null;
          const extra = Object.entries(module).filter(([key]) => !['enabled', 'weight', 'minScore'].includes(key));
          return (
            <div key={name} className="strategy-card">
              <div className="row-inline">
                <strong>{MODULE_LABELS_HU[name] ?? name}</strong>
                <label className="toggle-row"><input type="checkbox" checked={module.enabled} onChange={(event) => updateModule(name, { enabled: event.target.checked })} /> Engedélyezve</label>
              </div>
              <div className="field-grid">
                <label>Súly{numberInput(module.weight, (value) => updateModule(name, { weight: value }), { max: 10, step: 0.1 })}</label>
                <label>Minimum pontszám{numberInput(module.minScore, (value) => updateModule(name, { minScore: value }), { max: 100 })}</label>
                {extra.map(([key, value]) => typeof value === 'boolean'
                  ? <label key={key} className="toggle-row"><input type="checkbox" checked={value} onChange={(event) => updateModule(name, { [key]: event.target.checked })} /> {MODULE_PARAMETER_LABELS[key] ?? key}</label>
                  : <label key={key}>{MODULE_PARAMETER_LABELS[key] ?? key}{numberInput(value, (next) => updateModule(name, { [key]: next }), { step: key.endsWith('Ratio') ? 0.1 : 1 })}</label>)}
              </div>
              <small className="annotation" style={{ margin: 0 }}>Szükséges ártörténet: {settings.requiredHistoryMinutes[name] ?? 0} perc</small>
            </div>
          );
        })}
      </div>

      <div className="advanced-section">
        <h3>Pump kifáradás-szűrő</h3>
        <div className="field-grid">
          <label className="toggle-row"><input type="checkbox" checked={settings.exhaustionEnabled} onChange={(event) => update({ exhaustionEnabled: event.target.checked })} /> Engedélyezve</label>
          <label>Figyelmeztetési küszöb{numberInput(settings.exhaustionWarningThreshold, (value) => update({ exhaustionWarningThreshold: value }), { max: 100 })}</label>
          <label>Erős figyelmeztetés küszöb{numberInput(settings.exhaustionStrongWarningThreshold, (value) => update({ exhaustionStrongWarningThreshold: value }), { max: 100 })}</label>
          <label>Tiltási küszöb{numberInput(settings.exhaustionBlockThreshold, (value) => update({ exhaustionBlockThreshold: value }), { max: 100 })}</label>
          <label>Szabály<select value={settings.exhaustionPolicy} onChange={(event) => update({ exhaustionPolicy: event.target.value as 'BLOCK' | 'WARN_ONLY' })}><option value="BLOCK">Tiltás a küszöb fölött</option><option value="WARN_ONLY">Csak figyelmeztetés + pontlevonás</option></select></label>
          <label>Pontlevonás szorzója{numberInput(settings.exhaustionPenaltyWeight, (value) => update({ exhaustionPenaltyWeight: value }), { max: 5, step: 0.1 })}</label>
          <label>Rendkívüli emelkedés (%){numberInput(Number(settings.modules.PumpExhaustion?.extremeMovePercent ?? 100), (value) => updateModule('PumpExhaustion', { extremeMovePercent: value }), { min: 1 })}</label>
        </div>
        <p className="annotation">0–100 közötti védekező pontszám (100 = erős jele, hogy a mozgás kifulladt). A figyelmeztetési küszöb fölött a pontszám × szorzó levonásra kerül az összetett jelzésből. „Tiltás” szabálynál a tiltási küszöb fölött semmilyen stratégia (a meglévő Momentum/Breakout sem) nyithat automatikusan pozíciót; a kézi PAPER vétel ettől függetlenül működik.</p>
      </div>

      <div className="advanced-section">
        <h3>Likviditás-kiáramlás</h3>
        <div className="field-grid">
          <label className="toggle-row"><input type="checkbox" checked={settings.liquidityOutflowExitEnabled} onChange={(event) => update({ liquidityOutflowExitEnabled: event.target.checked })} /> Nyitott pozíció zárása likviditás-összeomláskor</label>
          <label>Zárás, ha a likviditás ennyivel a belépéskori alá esik (%){numberInput(settings.liquidityOutflowExitPercent, (value) => update({ liquidityOutflowExitPercent: value }), { min: 1, max: 99 })}</label>
        </div>
        <p className="annotation">Kritikus likviditás-kiáramlásnál (Likviditás-beáramlás modul) új automatikus belépés nem történik. A nyitott pozíciók automatikus zárása alapból kikapcsolt.</p>
      </div>

      <div className="row-inline" style={{ marginTop: 12 }}>
        {message ? <Status tone={message.tone === 'success' ? 'positive' : 'negative'}>{message.text}</Status> : <span className="annotation" style={{ margin: 0 }}>{settings.persisted ? 'Mentett beállítások.' : 'Alapértékek (még nincs mentve).'}</span>}
        <button type="button" className="primary-button" disabled={saving} onClick={() => void save()}>{saving ? 'Mentés…' : 'Haladó stratégiák mentése'}</button>
      </div>
    </Panel>
  );
}
