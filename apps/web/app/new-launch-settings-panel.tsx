'use client';
/* eslint-disable @typescript-eslint/no-explicit-any */

import { FlaskConical, Lock } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';

const SOCIAL_PROVIDER_STATE: Record<string, { tone: string; text: string }> = {
  CONNECTED: { tone: 'positive', text: 'KAPCSOLÓDVA' }, ACTIVE: { tone: 'positive', text: 'AKTÍV' }, CONNECTING: { tone: 'warning', text: 'KAPCSOLÓDIK' },
  RATE_LIMITED: { tone: 'warning', text: 'KORLÁTOZVA' }, DEGRADED: { tone: 'warning', text: 'GYENGE' }, DISCONNECTED: { tone: 'danger', text: 'NINCS KAPCSOLAT' },
  DISABLED: { tone: 'neutral', text: 'KI' }, NOT_CONFIGURED: { tone: 'neutral', text: 'NINCS BEÁLLÍTVA' },
};

/** Read-only provider states (server-side configuration; no credential is ever sent to the browser). */
function SocialProviderStatus() {
  const { data } = useApi<{ data: any }>('/api/social/status');
  const status = data?.data;
  const badge = (provider: any) => {
    if (!provider) return <Status tone="neutral">ISMERETLEN</Status>;
    const state = provider.enabled ? SOCIAL_PROVIDER_STATE[provider.state] ?? { tone: 'neutral', text: provider.state } : SOCIAL_PROVIDER_STATE.DISABLED;
    return <Status tone={state.tone}>{state.text}</Status>;
  };
  if (!status?.available) return <p className="sfield-help" style={{ marginTop: 14 }}>Szolgáltatói állapot: a worker még nem jelentett (nem fut, vagy a gyűjtés ki van kapcsolva).</p>;
  return <div className="sgrid" style={{ marginTop: 14 }}>
    <div className="sfield"><span className="sfield-label">Telegram</span><span>{status.telegram?.enabled ? <>BE · {badge(status.telegram)}</> : 'KI'}</span></div>
    <div className="sfield"><span className="sfield-label">Mód</span><span>CSAK MÉRÉS (MONITOR_ONLY)</span></div>
    <div className="sfield"><span className="sfield-label">AI közösségi elemzés (szerver)</span><span>{status.aiEnabled ? 'BE' : 'KI'}</span></div>
    <div className="sfield"><span className="sfield-label">X (Twitter)</span><span>{status.x?.enabled ? <>BE · {badge(status.x)}</> : 'KI'}</span></div>
  </div>;
}

import { apiRequest, date, fmt, Status, useApi } from './components';
import { PROVIDER_STATUS_LABELS } from './locales/position-labels';

type QualityGate = {
  mode: 'OFF' | 'MONITOR_ONLY' | 'ENFORCE_PAPER';
  version: number;
  minLaunchScore: number | null;
  minUniqueBuyers: number | null;
  minLiquidityUsd: number | null;
  minBuySellRatio: number | null;
  maxExhaustionScore: number | null;
  maxPriceImpactPercent: number | null;
  maxHolderConcentrationPercent: number | null;
  maxDevAllocationPercent: number | null;
  minDataQuality: number | null;
};

type NewLaunchSettings = {
  enabled: boolean;
  configVersion: string;
  minAgeSeconds: number;
  maxAgeSeconds: number;
  observationSeconds: number;
  cooldownSeconds: number;
  minTransactions: number;
  minUniqueBuyers: number;
  minBuySellRatio: number;
  minLaunchVolumeUsd: number;
  minScore: number;
  maxExhaustionScore: number;
  minLiquidityUsd: number;
  maxLiquidityUsd: number | null;
  maxPriceImpactPercent: number;
  liquidityOutflowWarningPercent: number;
  liquidityCriticalPercent: number;
  maxRiskScore: number;
  maxPositionPercent: number;
  maxConcurrentPositions: number;
  minObservedSellers: number;
  independentMode: boolean;
  stopLossPercent: number;
  takeProfitPercent: number;
  breakEvenEnabled: boolean;
  breakEvenActivationPercent: number;
  breakEvenCostBufferPercent: number;
  trailingEnabled: boolean;
  trailingActivationPercent: number;
  trailingDistancePercent: number;
  tieredTakeProfitEnabled: boolean;
  tieredTakeProfitLevels: Array<{ profitPercent: number; sellPercent: number }>;
  maxHoldEnabled: boolean;
  maxHoldMinutes: number;
  liquiditySafetyExitEnabled: boolean;
  liquidityDropExitPercent: number;
  minimumRecommendationSampleSize: number;
  dynamicPositionSizingEnabled: boolean;
  exitCapacityMode: 'MONITOR_ONLY' | 'ENFORCE_PAPER';
  maxEstimatedEntryImpactPct: number;
  maxEstimatedExitImpactPct: number;
  maxEstimatedRoundTripImpactPct: number;
  minExitCapacityScore: number;
  maxLiquidityUtilizationPct: number;
  minimumExecutablePosition: number;
  positionSizeStep: number;
  socialIntelligenceEnabled: boolean;
  socialDecisionMode: 'OFF' | 'MONITOR_ONLY' | 'ENFORCE_PAPER';
  aiSocialAnalysisEnabled: boolean;
  qualityGate: QualityGate;
  paperOnlyNotice?: string;
  exitNotice?: string;
  qualityGateNotice?: string;
  providers?: Array<{ source: string; label: string; status: string; detail: string | null }>;
  mandatorySecurity?: string[];
  versions?: Array<{ version: string; parentVersion: string | null; note: string | null; createdAt: string; createdFromRecommendationId: string | null }>;
};

const SECURITY_LABELS: Record<string, string> = {
  SELLABILITY_VERIFIED: 'Eladhatóság igazolása (valós, nem létrehozói eladások)',
  MINT_AUTHORITY_CHECK: 'Mint authority ellenőrzés',
  FREEZE_AUTHORITY_CHECK: 'Freeze authority ellenőrzés',
  TOKEN_EXTENSION_CHECK: 'Token-2022 kiterjesztések ellenőrzése',
  HOLDER_CONCENTRATION_CHECK: 'Holder koncentráció ellenőrzés',
  DEV_ALLOCATION_CHECK: 'Létrehozói eladás / allokáció figyelése',
  LIQUIDITY_VALIDATION: 'Likviditás validálás',
};

export const RECOMMENDATION_PARAMETER_LABELS: Record<string, string> = {
  minScore: 'Minimum Launch Score',
  minUniqueBuyers: 'Minimum egyedi vásárló',
  minLiquidityUsd: 'Minimum likviditás (USD)',
  minBuySellRatio: 'Minimum vétel/eladás arány',
  maxExhaustionScore: 'Maximum kifáradási pontszám',
  maxPriceImpactPercent: 'Maximum árhatás (%)',
  maxAgeSeconds: 'Maximum token életkor (mp)',
  maxRiskScore: 'Maximum kockázati pontszám',
  'qualityGate.minDataQuality': 'Minőségi szűrő: minimum adatminőség',
  'qualityGate.maxHolderConcentrationPercent': 'Minőségi szűrő: max. holder koncentráció (%)',
  'qualityGate.maxDevAllocationPercent': 'Minőségi szűrő: max. dev allokáció (%)',
};

const CONFIDENCE: Record<string, { label: string; tone: string }> = { LOW: { label: 'ALACSONY', tone: 'warning' }, MEDIUM: { label: 'KÖZEPES', tone: 'info' }, HIGH: { label: 'MAGAS', tone: 'positive' } };

const READ_ONLY_KEYS = new Set(['paperOnlyNotice', 'exitNotice', 'qualityGateNotice', 'providers', 'mandatorySecurity', 'persisted', 'paperOnly', 'useAiConfirmation', 'versions', 'pendingRecommendations', 'tieredTakeProfitSupported', 'configVersion']);

type NumericKey = { [K in keyof NewLaunchSettings]: NewLaunchSettings[K] extends number ? K : never }[keyof NewLaunchSettings] & string;

function Card({ title, description, children, footer, badge }: { title: string; description?: ReactNode; children: ReactNode; footer?: ReactNode; badge?: ReactNode }) {
  return <section className="scard">
    <header className="scard-head scard-head-row"><div><h3>{title}</h3>{description ? <p>{description}</p> : null}</div>{badge}</header>
    <div className="scard-body">{children}</div>
    {footer ? <footer className="scard-foot">{footer}</footer> : null}
  </section>;
}

function Toggle({ label, help, checked, onChange }: { label: string; help?: ReactNode; checked: boolean; onChange: (value: boolean) => void }) {
  return <label className="stoggle"><span className="stoggle-text"><span className="sfield-label">{label}</span>{help ? <span className="sfield-help">{help}</span> : null}</span><input type="checkbox" role="switch" className="switch" checked={checked} onChange={(event) => onChange(event.target.checked)} /></label>;
}

export function NewLaunchSettingsPanel({ tradingMode }: { tradingMode: string }) {
  const [draft, setDraft] = useState<NewLaunchSettings | null>(null);
  const [message, setMessage] = useState('');
  const [optimizer, setOptimizer] = useState<{ latestRun: any; recommendations: any[] } | null>(null);
  const load = async () => {
    try {
      const [settings, optimizerState] = await Promise.all([
        apiRequest<{ data: NewLaunchSettings }>('/api/settings/new-launch'),
        apiRequest<{ data: { latestRun: any; recommendations: any[] } }>('/api/new-launch/optimizer').catch(() => null),
      ]);
      setDraft(settings.data);
      if (optimizerState) setOptimizer(optimizerState.data);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Az Új token beállítások betöltése sikertelen');
    }
  };
  useEffect(() => { void load(); }, []);
  if (!draft) return <div id="new-launch" className="settings-span"><section className="scard"><div className="scard-body"><p className="sfield-help">{message || 'Betöltés…'}</p></div></section></div>;

  const field = (key: NumericKey, label: string, props: { min?: number; max?: number; step?: number; help?: string } = {}) => (
    <label className="sfield"><span className="sfield-label">{label}</span><input type="number" min={props.min} max={props.max} step={props.step ?? 1} value={draft[key] as number} onChange={(event) => setDraft({ ...draft, [key]: Number(event.target.value) })} />{props.help ? <span className="sfield-help">{props.help}</span> : null}</label>
  );
  const gateField = (key: Exclude<keyof QualityGate, 'mode' | 'version'>, label: string, step = 1) => (
    <label className="sfield"><span className="sfield-label">{label}</span><input type="number" min={0} step={step} placeholder="nincs feltétel" value={draft.qualityGate[key] ?? ''} onChange={(event) => setDraft({ ...draft, qualityGate: { ...draft.qualityGate, [key]: event.target.value === '' ? null : Number(event.target.value) } })} /></label>
  );
  const save = async () => {
    setMessage('Mentés…');
    const { mode, minLaunchScore, minUniqueBuyers, minLiquidityUsd, minBuySellRatio, maxExhaustionScore, maxPriceImpactPercent, maxHolderConcentrationPercent, maxDevAllocationPercent, minDataQuality } = draft.qualityGate;
    const body = { ...Object.fromEntries(Object.entries(draft).filter(([key]) => !READ_ONLY_KEYS.has(key))), qualityGate: { mode, minLaunchScore, minUniqueBuyers, minLiquidityUsd, minBuySellRatio, maxExhaustionScore, maxPriceImpactPercent, maxHolderConcentrationPercent, maxDevAllocationPercent, minDataQuality } };
    try {
      const response = await apiRequest<{ data: NewLaunchSettings }>('/api/settings/new-launch', { method: 'PUT', body: JSON.stringify(body) });
      setMessage(response.data.configVersion !== draft.configVersion ? `Elmentve – új konfiguráció-verzió: ${response.data.configVersion}. A már nyitott pozíciók a belépéskori beállításukkal futnak tovább.` : 'Elmentve.');
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'A mentés sikertelen');
    }
  };
  const runOptimizer = async () => {
    setMessage('Elemzés indítása… (a háttérben fut, néhány másodperc)');
    try {
      await apiRequest('/api/new-launch/optimizer/run', { method: 'POST', body: JSON.stringify({ version: 'current', sample: 'all' }) });
      for (let attempt = 0; attempt < 30; attempt += 1) {
        await new Promise((resolve) => globalThis.setTimeout(resolve, 2000));
        const state = await apiRequest<{ data: { latestRun: any; recommendations: any[] } }>('/api/new-launch/optimizer');
        setOptimizer(state.data);
        if (state.data.latestRun?.status !== 'RUNNING') break;
      }
      setMessage('Az elemzés elkészült.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Az elemzés indítása sikertelen');
    }
  };
  const accept = async (recommendation: any) => {
    const label = RECOMMENDATION_PARAMETER_LABELS[recommendation.parameter] ?? recommendation.parameter;
    if (!globalThis.confirm(`Új PAPER kísérlet létrehozása: ${label} ${fmt(recommendation.currentValue)} → ${fmt(recommendation.suggestedValue)}.\n\nEz új konfiguráció-verziót hoz létre (csak PAPER). A korábbi kereskedések és a nyitott pozíciók nem változnak. Folytatod?`)) return;
    try {
      const response = await apiRequest<{ data: { configVersion: string } }>(`/api/new-launch/recommendations/${recommendation.id}/accept`, { method: 'POST', body: '{}' });
      setMessage(`PAPER kísérlet létrehozva: ${response.data.configVersion}.`);
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'A kísérlet létrehozása sikertelen');
    }
  };
  const dismiss = async (id: string) => {
    await apiRequest(`/api/new-launch/recommendations/${id}/dismiss`, { method: 'POST', body: '{}' }).catch(() => undefined);
    await load();
  };
  const saveButton = <button type="button" className="primary-button" onClick={() => void save()}>Új token beállítások mentése</button>;
  const run = optimizer?.latestRun;
  const insufficient = run?.status === 'COMPLETED' && run?.result?.entry?.sufficientData === false;

  return <div id="new-launch" className="settings-span settings-stack">
    <Card title="Új token / Sniper" description={draft.paperOnlyNotice ?? 'Az Új token / Sniper stratégia jelenleg csak PAPER módban használható.'}
      badge={<div className="header-actions"><Status tone="warning">CSAK PAPER</Status><span className="version-badge" title="Aktív konfiguráció-verzió">{draft.configVersion}</span></div>} footer={saveButton}>
      {tradingMode !== 'PAPER' ? <p className="settings-warning">A kereskedési mód most {tradingMode}: az Új token / Sniper ebben a módban nem nyit pozíciót.</p> : null}
      <div className="stoggle-list">
        <Toggle label="Új token / Sniper stratégia" help="Friss launchok figyelése és PAPER vétele." checked={draft.enabled} onChange={(value) => setDraft({ ...draft, enabled: value })} />
        <Toggle label="Független működés" help="Az AI / Stratégia módtól függetlenül fut." checked={draft.independentMode} onChange={(value) => setDraft({ ...draft, independentMode: value })} />
      </div>
      <div className="sgrid" style={{ marginTop: 20 }}>
        {field('maxPositionPercent', 'Max. pozícióméret (egyenleg %)', { min: 0.1, max: 10, step: 0.1 })}
        {field('maxConcurrentPositions', 'Max. egyidejű Új token pozíció', { min: 1, max: 20 })}
        {field('cooldownSeconds', 'Várakozás két vétel között (mp)', { min: 0, max: 86400 })}
      </div>
      <div className="provider-list compact" style={{ marginTop: 16 }}>
        {(draft.providers ?? []).map((provider) => {
          const status = PROVIDER_STATUS_LABELS[provider.status] ?? { label: provider.status, tone: 'neutral' };
          return <span key={provider.source} className="provider-item"><strong>{provider.label}</strong><Status tone={status.tone}>{status.label}</Status></span>;
        })}
        {(draft.providers ?? []).length === 0 ? <span className="sfield-help">Szolgáltató-állapot: a worker még nem jelentett.</span> : null}
      </div>
    </Card>

    <Card title="Belépési feltételek" description="Launch időablak, aktivitás, likviditás és kockázat." footer={saveButton}>
      <div className="sgrid sgrid-3">
        {field('minAgeSeconds', 'Min. életkor vétel előtt (mp)', { min: 0, max: 600 })}
        {field('maxAgeSeconds', 'Max. életkor (mp)', { min: 10, max: 3600 })}
        {field('observationSeconds', 'Megfigyelési idő (mp)', { min: 2, max: 600 })}
        {field('minTransactions', 'Min. tranzakciószám', { min: 1, max: 10000 })}
        {field('minUniqueBuyers', 'Min. egyedi vásárló', { min: 1, max: 10000 })}
        {field('minBuySellRatio', 'Min. vétel/eladás arány', { min: 0.1, max: 100, step: 0.1 })}
        {field('minLaunchVolumeUsd', 'Min. launch forgalom (USD)', { min: 0, step: 100 })}
        {field('minScore', 'Min. Launch Score', { min: 0, max: 100 })}
        {field('maxExhaustionScore', 'Max. kifáradási pontszám', { min: 0, max: 100 })}
        {field('minLiquidityUsd', 'Min. likviditás (USD)', { min: 0, step: 500 })}
        <label className="sfield"><span className="sfield-label">Max. likviditás (USD)</span><input type="number" min={0} step={1000} placeholder="nincs felső határ" value={draft.maxLiquidityUsd ?? ''} onChange={(event) => setDraft({ ...draft, maxLiquidityUsd: event.target.value === '' ? null : Number(event.target.value) })} /></label>
        {field('maxPriceImpactPercent', 'Max. árhatás (%)', { min: 0.1, max: 50, step: 0.1 })}
        {field('liquidityCriticalPercent', 'Kritikus likviditás-csökkenés (%)', { min: 1, max: 99 })}
        {field('maxRiskScore', 'Max. kockázati pontszám', { min: 0, max: 100 })}
        {field('minObservedSellers', 'Eladhatósághoz szükséges független eladók', { min: 1, max: 50 })}
      </div>
      <ul className="locked-rules" style={{ marginTop: 20 }}>
        {(draft.mandatorySecurity ?? []).map((rule) => <li key={rule}><Lock size={15} aria-hidden="true" /> {SECURITY_LABELS[rule] ?? rule}</li>)}
      </ul>
      <p className="sfield-help" style={{ marginTop: 12 }}>Ismeretlen eladhatóság soha nem számít biztonságosnak; a kemény tiltások nem kerülhetők meg.</p>
    </Card>

    <Card title="KILÉPÉSI STRATÉGIA" description={draft.exitNotice ?? 'Ezek a beállítások csak az Új token / Sniper pozíciókra vonatkoznak.'} footer={saveButton}
      badge={<Status tone="info">CSAK ÚJ TOKEN</Status>}>
      <div className="sgrid">
        {field('stopLossPercent', 'Stop Loss (%)', { min: 1, max: 90, step: 0.5 })}
        {field('takeProfitPercent', 'Take Profit (%)', { min: 1, max: 1000, step: 0.5 })}
      </div>
      <div className="stoggle-list">
        <Toggle label="Break-even használata" help="Az aktiválási nyereség elérésekor a stop a nettó nullszintre emelkedik." checked={draft.breakEvenEnabled} onChange={(value) => setDraft({ ...draft, breakEvenEnabled: value })} />
        <Toggle label="Követő stop használata" help="Csak az aktiválási nyereség után kezd követni, és soha nem mozdul lefelé." checked={draft.trailingEnabled} onChange={(value) => setDraft({ ...draft, trailingEnabled: value })} />
        <Toggle label="Többlépcsős profitkivét" help="Előkészítve – a részleges eladás még nincs megvalósítva, ezért jelenleg nem hajtódik végre." checked={draft.tieredTakeProfitEnabled} onChange={(value) => setDraft({ ...draft, tieredTakeProfitEnabled: value })} />
        <Toggle label="Maximum tartási idő" help="Ennyi perc után a pozíció MAX_HOLD_TIME okkal zár." checked={draft.maxHoldEnabled} onChange={(value) => setDraft({ ...draft, maxHoldEnabled: value })} />
        <Toggle label="Likviditás-védelmi kilépés" help="Zárás, ha a likviditás a belépéskorihoz képest ennyivel csökkent (LIQUIDITY_SAFETY)." checked={draft.liquiditySafetyExitEnabled} onChange={(value) => setDraft({ ...draft, liquiditySafetyExitEnabled: value })} />
      </div>
      <div className="sgrid sgrid-3" style={{ marginTop: 20 }}>
        {draft.breakEvenEnabled ? field('breakEvenActivationPercent', 'Break-even aktiválás (%)', { min: 0.5, max: 500, step: 0.5 }) : null}
        {draft.breakEvenEnabled ? field('breakEvenCostBufferPercent', 'Break-even költségpuffer (%)', { min: 0, max: 10, step: 0.1, help: `Break-even stop = belépési fill × (1 + ${draft.breakEvenCostBufferPercent}%). 0,6% = a két PAPER díj.` }) : null}
        {draft.trailingEnabled ? field('trailingActivationPercent', 'Követő stop aktiválás (%)', { min: 0, max: 500, step: 0.5, help: '0 = azonnal a vételtől (csak ha kifejezetten ezt akarod)' }) : null}
        {draft.trailingEnabled ? field('trailingDistancePercent', 'Követő stop távolság (%)', { min: 0.5, max: 90, step: 0.5 }) : null}
        {draft.maxHoldEnabled ? field('maxHoldMinutes', 'Maximum tartási idő (perc)', { min: 1, max: 10080 }) : null}
        {draft.liquiditySafetyExitEnabled ? field('liquidityDropExitPercent', 'Likviditásesés kilépési küszöb (%)', { min: 1, max: 99 }) : null}
      </div>
      <p className="sfield-help" style={{ marginTop: 14 }}>A belépéskor érvényes kilépési beállítás a pozícióhoz rögzül: a későbbi módosítás nem írja át a nyitott pozíciókat. Az alapértékek kísérleti PAPER értékek, nem garantáltan optimálisak.</p>
    </Card>

    <Card title="BELÉPÉSI MINŐSÉGI SZŰRŐ" description={draft.qualityGateNotice ?? 'MONITOR_ONLY módban a szűrő nem tiltja a PAPER belépést, csak méri, mit szűrt volna ki.'} footer={saveButton}
      badge={<span className="version-badge" title="Szűrő verzió">szűrő v{draft.qualityGate.version}</span>}>
      <div className="sgrid">
        <label className="sfield"><span className="sfield-label">Mód</span>
          <select value={draft.qualityGate.mode} onChange={(event) => setDraft({ ...draft, qualityGate: { ...draft.qualityGate, mode: event.target.value as QualityGate['mode'] } })}>
            <option value="OFF">Kikapcsolva (OFF)</option>
            <option value="MONITOR_ONLY">Csak mérés (MONITOR_ONLY)</option>
            <option value="ENFORCE_PAPER">Szűrés PAPER módban (ENFORCE_PAPER)</option>
          </select>
          <span className="sfield-help">{draft.qualityGate.mode === 'ENFORCE_PAPER' ? 'A szűrőn elbukó jelöltekre nem nyílik PAPER pozíció.' : draft.qualityGate.mode === 'MONITOR_ONLY' ? 'Nem tilt, csak rögzíti, hogy átment volna-e.' : 'Nem értékelődik.'}</span>
        </label>
      </div>
      <div className="sgrid sgrid-3" style={{ marginTop: 20 }}>
        {gateField('minLaunchScore', 'Minimum Launch Score')}
        {gateField('minUniqueBuyers', 'Minimum egyedi vásárló')}
        {gateField('minLiquidityUsd', 'Minimum likviditás (USD)', 500)}
        {gateField('minBuySellRatio', 'Minimum Buy/Sell arány', 0.1)}
        {gateField('maxExhaustionScore', 'Maximum Exhaustion Score')}
        {gateField('maxPriceImpactPercent', 'Maximum price impact (%)', 0.1)}
        {gateField('maxHolderConcentrationPercent', 'Maximum holder concentration (%)', 0.5)}
        {gateField('maxDevAllocationPercent', 'Maximum dev allocation (%)', 0.5)}
        {gateField('minDataQuality', 'Minimum data quality')}
      </div>
      <p className="sfield-help" style={{ marginTop: 14 }}>A szűrő a kemény biztonsági és kockázati ellenőrzés UTÁN fut, így egy biztonsági tiltást soha nem fordíthat vételre. Ismeretlen érték esetén a feltétel nem teljesül.</p>
    </Card>

    <Card title="DINAMIKUS POZÍCIÓMÉRET / KILÉPÉSI KAPACITÁS" description="Minden Új token vétel előtt: ha a teljes pozíciót azonnal el kellene adni, elfogadható árhatással kijutnánk-e? A méretet csak csökkentheti, soha nem növelheti. Végrehajthatóságot mér, nem a token irányát." footer={saveButton}>
      <div className="sgrid">
        <label className="stoggle"><span className="stoggle-text"><span className="sfield-label">Kilépési kapacitás számítása</span><span className="sfield-help">Minden belépésnél kiszámolja és rögzíti a biztonságos méretet.</span></span><input type="checkbox" role="switch" className="switch" checked={draft.dynamicPositionSizingEnabled} onChange={(event) => setDraft({ ...draft, dynamicPositionSizingEnabled: event.target.checked })} /></label>
        <label className="sfield"><span className="sfield-label">Mód</span>
          <select value={draft.exitCapacityMode} onChange={(event) => setDraft({ ...draft, exitCapacityMode: event.target.value as NewLaunchSettings['exitCapacityMode'] })}>
            <option value="MONITOR_ONLY">Csak mérés (MONITOR_ONLY)</option>
            <option value="ENFORCE_PAPER">Alkalmazás PAPER módban (ENFORCE_PAPER)</option>
          </select>
          <span className="sfield-help">{draft.exitCapacityMode === 'ENFORCE_PAPER' ? 'A javasolt méret alkalmazódik (csökkentés / elutasítás). Átkapcsoláskor új konfiguráció-verzió jön létre.' : 'A tényleges méret nem változik; csak rögzíti, mit javasolt volna (az NL-v2 minta összehasonlítható marad).'}</span>
        </label>
      </div>
      <div className="sgrid sgrid-3" style={{ marginTop: 20 }}>
        {field('maxEstimatedEntryImpactPct', 'Max. becsült belépési árhatás (%)', { min: 0.1, max: 50, step: 0.1 })}
        {field('maxEstimatedExitImpactPct', 'Max. becsült teljes kilépési árhatás (%)', { min: 0.1, max: 50, step: 0.1 })}
        {field('maxEstimatedRoundTripImpactPct', 'Max. becsült oda-vissza árhatás (%)', { min: 0.1, max: 100, step: 0.1 })}
        {field('minExitCapacityScore', 'Min. Exit Capacity Score', { min: 0, max: 100 })}
        {field('maxLiquidityUtilizationPct', 'Max. likviditás-kihasználtság (%)', { min: 0.1, max: 100, step: 0.1 })}
        {field('minimumExecutablePosition', 'Min. végrehajtható pozíció (USDC)', { min: 0, step: 1 })}
        {field('positionSizeStep', 'Pozícióméret lépésköze (USDC)', { min: 0.01, step: 0.5 })}
      </div>
      <p className="sfield-help" style={{ marginTop: 14 }}>Ismeretlen kapacitás soha nem számít biztonságosnak. A biztonsági és kockázati ellenőrzések (pl. ismeretlen eladhatóság) függetlenek és elsőbbséget élveznek. A dinamikus méretezés nem garantál nagyobb profitot: a reálisabb méretet és a kisebb végrehajtási kockázatot szolgálja.</p>
    </Card>

    <Card title="KÖZÖSSÉGI INTELLIGENCIA (TELEGRAM-FIRST)" description="Determinisztikus, AI nélküli mérés: figyelem gyorsulása, független szereplők, spam / koordináció valószínűsége, kimerülés és on-chain megerősítés. Soha nem írja felül a biztonsági, kockázati és eladhatósági szabályokat, és nem lassítja a kilépéseket." footer={saveButton}>
      <div className="sgrid">
        <label className="stoggle"><span className="stoggle-text"><span className="sfield-label">Közösségi intelligencia</span><span className="sfield-help">Közösségi árnyék-jellemzők gyűjtése és rögzítése minden döntésnél (az elutasított jelölteknél is).</span></span><input type="checkbox" role="switch" className="switch" checked={draft.socialIntelligenceEnabled} onChange={(event) => setDraft({ ...draft, socialIntelligenceEnabled: event.target.checked })} /></label>
        <label className="sfield"><span className="sfield-label">Mód</span>
          <select value={draft.socialDecisionMode} onChange={(event) => setDraft({ ...draft, socialDecisionMode: event.target.value as NewLaunchSettings['socialDecisionMode'] })}>
            <option value="OFF">Kikapcsolva (OFF)</option>
            <option value="MONITOR_ONLY">Csak mérés (MONITOR_ONLY)</option>
            <option value="ENFORCE_PAPER">Alkalmazás PAPER módban (ENFORCE_PAPER)</option>
          </select>
          <span className="sfield-help">{draft.socialDecisionMode === 'ENFORCE_PAPER' ? 'Az AVOID árnyékdöntés elvehet egy PAPER belépést (hozzáadni, méretet növelni soha nem tud). Átkapcsoláskor új konfiguráció-verzió jön létre – az NL-v2 nem változik visszamenőleg.' : draft.socialDecisionMode === 'MONITOR_ONLY' ? 'Nem változtat semmilyen döntést, méretet vagy kilépést – csak rögzíti, mit javasolt volna.' : 'Nem gyűjt és nem értékel.'}</span>
        </label>
        <label className="stoggle"><span className="stoggle-text"><span className="sfield-label">Opcionális AI közösségi elemzés</span><span className="sfield-help">Előkészítve, alapból kikapcsolva. A determinisztikus pontszámok AI nélkül is teljesek; AI-hiba soha nem állítja le a közösségi elemzést.</span></span><input type="checkbox" role="switch" className="switch" checked={draft.aiSocialAnalysisEnabled} onChange={(event) => setDraft({ ...draft, aiSocialAnalysisEnabled: event.target.checked })} /></label>
      </div>
      <SocialProviderStatus />
      <p className="sfield-help" style={{ marginTop: 14 }}>Elsődleges forrás a Telegram (MTProto, csak nyilvános vagy jogosan elérhető csatornák; privát meghívó linkhez nem csatlakozik). Az X opcionális és alapból ki van kapcsolva. A kapcsolók és hitelesítő adatok szerveroldali környezeti változók (TELEGRAM_SOCIAL_ENABLED, X_SOCIAL_ENABLED, AI_SOCIAL_ANALYSIS_ENABLED) – itt csak az állapotuk látszik, titok soha.</p>
    </Card>

    <Card title="Elemzési javaslatok" description="Kísérleti PAPER beállítás-javaslatok a lezárt Új token kereskedésekből. Soha nem alkalmazódnak automatikusan."
      badge={<button type="button" className="secondary-button" onClick={() => void runOptimizer()} disabled={run?.status === 'RUNNING'}><FlaskConical size={16} aria-hidden="true" /> {run?.status === 'RUNNING' ? 'Elemzés fut…' : 'Elemzés futtatása'}</button>}>
      <p className="sfield-help">HISTORICAL SIMULATION — NOT FUTURE PERFORMANCE. Tanuló szakasz (korábbi 70%) → változatlan értékkel validálás a későbbi 30%-on, plusz gördülő ellenőrzés.{run?.completedAt ? ` Utolsó elemzés: ${date(run.completedAt)} (${run.sampleSize} trade).` : ''}</p>
      {insufficient ? <p className="settings-warning">Nincs elegendő adat megbízható beállítási javaslathoz (minimum {run.result.entry.minimumSampleSize} lezárt trade kell az aktuális konfiguráció-verzióban). A leíró elemzések az Elemzések oldalon így is elérhetők.</p> : null}
      {run?.status === 'FAILED' ? <p className="settings-warning">Az elemzés sikertelen: {run.error}</p> : null}
      {(optimizer?.recommendations ?? []).length === 0 && !insufficient ? <p className="sfield-help" style={{ marginTop: 10 }}>{run ? 'Jelenleg nincs függőben lévő javaslat.' : 'Még nem futott elemzés.'}</p> : null}
      <div className="recommendation-list">
        {(optimizer?.recommendations ?? []).map((recommendation) => {
          const confidence = CONFIDENCE[recommendation.confidenceLevel] ?? { label: recommendation.confidenceLevel, tone: 'neutral' };
          const validation = recommendation.validationMetrics ?? {};
          return <article key={recommendation.id} className="recommendation-card">
            <div className="recommendation-head">
              <strong>{RECOMMENDATION_PARAMETER_LABELS[recommendation.parameter] ?? recommendation.parameter}</strong>
              <Status tone={confidence.tone}>{confidence.label} MEGBÍZHATÓSÁG</Status>
            </div>
            <div className="recommendation-values">
              <div><span>Jelenlegi</span><strong>{recommendation.currentValue == null ? '—' : fmt(recommendation.currentValue)}</strong></div>
              <div><span>Javasolt kísérleti érték</span><strong>{fmt(recommendation.suggestedValue)}</strong></div>
              <div><span>Minta</span><strong>{recommendation.sampleSize} trade</strong></div>
              <div><span>Nyerők megtartása</span><strong>{recommendation.winnerRetention == null ? '—' : `${fmt(Number(recommendation.winnerRetention) * 100, 0)}%`}</strong></div>
              <div><span>Vesztesek kiszűrése</span><strong>{recommendation.loserRejection == null ? '—' : `${fmt(Number(recommendation.loserRejection) * 100, 0)}%`}</strong></div>
              <div><span>Validációs PF</span><strong>{validation.filtered?.profitFactor == null ? '—' : fmt(validation.filtered.profitFactor)}</strong></div>
            </div>
            <p className="sfield-help">{recommendation.reason}</p>
            {(recommendation.warnings ?? []).map((warning: string) => <p key={warning} className="settings-warning">{warning}</p>)}
            <div className="recommendation-actions">
              <button type="button" className="secondary-button" onClick={() => void dismiss(recommendation.id)}>Elvetés</button>
              <button type="button" className="primary-button" onClick={() => void accept(recommendation)}>PAPER kísérlet létrehozása</button>
            </div>
          </article>;
        })}
      </div>
    </Card>

    <Card title="Konfiguráció-verziók" description="Minden módosítás új, változtathatatlan verziót hoz létre; a kereskedések a belépéskori verziójukkal értékelődnek.">
      {(draft.versions ?? []).length === 0 ? <p className="sfield-help">Az első mentéskor jön létre a verziótörténet (jelenleg: {draft.configVersion}).</p> : <ul className="version-list">
        {(draft.versions ?? []).map((version) => <li key={version.version}>
          <span className="version-badge">{version.version}</span>
          <span>{version.parentVersion ? `← ${version.parentVersion}` : 'kezdeti'}</span>
          <span className="sfield-help">{version.note ?? (version.createdFromRecommendationId ? 'Javaslatból' : 'Beállítás módosítás')}</span>
          <time>{date(version.createdAt)}</time>
        </li>)}
      </ul>}
    </Card>

    {message ? <p className="settings-message" role="status" aria-live="polite">{message}</p> : null}
  </div>;
}
