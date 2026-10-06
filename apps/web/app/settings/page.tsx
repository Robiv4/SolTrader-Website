'use client';

import { Bell, Bot, LineChart, Lock, Radar, Rocket, ShieldCheck, SlidersHorizontal, UserRound, Wallet, type LucideIcon } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import { AdvancedStrategiesPanel } from '../advanced-strategies-panel';
import { AiModeStrategyNotice, AiSettingsPanel } from '../ai-settings-panel';
import { apiRequest, PageHeader, Status } from '../components';
import { LiveSafetyControls } from '../live-safety-controls';
import { NewLaunchSettingsPanel } from '../new-launch-settings-panel';
import { PaperAccountPanel } from '../paper-account-panel';
import { ProfilePicturePanel } from '../profile-picture-panel';
import { TelegramPanel } from '../telegram-panel';
import { WalletSettingsPanel } from '../wallet-connect';

type RiskSettings = {
  riskPolicy: 'CONSERVATIVE' | 'BALANCED' | 'EXPLORATORY';
  lowRiskMax: number;
  moderateRiskMax: number;
  highRiskMax: number;
  veryHighRiskMax: number;
  lowPositionMultiplier: number;
  moderatePositionMultiplier: number;
  highPositionMultiplier: number;
  veryHighPositionMultiplier: number;
  aiAnalysisEnabled: boolean;
  aiRequiredForHighRisk: boolean;
  aiRequiredForVeryHighRisk: boolean;
  aiProviderConfigured?: boolean;
  allowManualPaperWatchBuy: boolean;
  maxPositionPercent: number | null;
  maxTotalExposurePercent: number | null;
  maxConcurrentPositions: number | null;
  dailyLossLimitPercent: number | null;
  maxSlippagePercent: number | null;
  minSignalScore: number | null;
  cooldownSeconds: number | null;
  stopLossPercent: number | null;
  takeProfitPercent: number | null;
  trailingStopPercent: number | null;
  trailingActivationPercent: number | null;
  breakEvenActivationPercent: number | null;
};

type StrategyMap = Record<string, { isEnabled: boolean; params: Record<string, number>; defaults?: Record<string, number> }>;

type SettingsResponse = {
  tradingMode: string;
  isLiveEnabled: boolean;
  isScannerEnabled: boolean;
  isPaperModeDefault: boolean;
  maxPositionSize: number | null;
  maxDailyLoss: number | null;
  riskThreshold: number | null;
  preferredQuoteCurrency: string;
  maxTokenAgeHours: number | null;
  minLiquidityUsd: number | null;
  minVolumeUsd: number | null;
  skipUnbuyableAfterMinutes: number;
  skipUnbuyableForMinutes: number;
  maxMonitoredTokens: number;
  risk: RiskSettings;
  strategies: StrategyMap;
  wallet: Array<{ id: string; label: string | null; address: string; walletType: string; status: string; isPrimary: boolean; isPaper: boolean }>;
  notifications: { telegramEnabled: boolean; telegramChatId: string | null; emailAlerts: boolean; pushAlerts: boolean };
};

type ApiResponse<T> = { data: T };

const strategyNames = ['Momentum', 'Breakout', 'Pullback'];

/** Profile that also enters HIGH-risk tokens: risk ceiling up to 90 and moderately relaxed entry thresholds. */
const highRiskStrategyPreset: Record<string, Record<string, number>> = {
  Momentum: { maximumRiskScore: 90, minimumMomentum: 55, minimumVolumeAcceleration: 50, minimumBuyPressure: 52, minimumLiquidityStability: 40 },
  Breakout: { maximumRiskScore: 90, minimumConsolidation: 40, minimumResistance: 60, minimumBreakout: 52, minimumVolumeConfirmation: 50 },
  Pullback: { maximumRiskScore: 90, minimumInitialImpulse: 15, minimumRetracement: 25, minimumSupport: 60, minimumRenewedBuyingPressure: 50 },
};

const strategyParamLabels: Record<string, string> = {
  minimumMomentum: 'Min. momentum',
  minimumVolumeAcceleration: 'Min. volumen-gyorsulás',
  minimumBuyPressure: 'Min. vételi nyomás',
  minimumLiquidityStability: 'Min. likviditás-stabilitás',
  minimumConsolidation: 'Min. konszolidáció',
  minimumResistance: 'Min. ellenállás',
  minimumBreakout: 'Min. kitörés',
  minimumVolumeConfirmation: 'Min. volumen-megerősítés',
  minimumInitialImpulse: 'Min. kezdeti impulzus',
  minimumRetracement: 'Min. visszahúzódás',
  minimumSupport: 'Min. támasz',
  minimumRenewedBuyingPressure: 'Min. megújuló vételi nyomás',
  maximumRiskScore: 'Max. kockázati pontszám',
  cooldownMs: 'Várakozás (perc)',
};

type SectionId = 'profile' | 'account' | 'trading' | 'scanner' | 'risk' | 'ai' | 'strategies' | 'new-launch' | 'notifications' | 'security';

const SECTIONS: Array<{ id: SectionId; label: string; description: string; icon: LucideIcon }> = [
  { id: 'profile', label: 'Profil', description: 'Profilkép', icon: UserRound },
  { id: 'account', label: 'Számla és mód', description: 'Paper számla, kereskedési mód', icon: Wallet },
  { id: 'trading', label: 'Kereskedés', description: 'Pozícióméret, napi limit', icon: SlidersHorizontal },
  { id: 'scanner', label: 'Tokenfigyelő', description: 'Scanner be/ki, szűrők, kilépések', icon: Radar },
  { id: 'risk', label: 'Kockázatkezelés', description: 'Limitek, kockázati osztályok', icon: ShieldCheck },
  { id: 'ai', label: 'AI elemzés', description: 'AI döntési mód, szolgáltató', icon: Bot },
  { id: 'strategies', label: 'Stratégiák', description: 'Stratégiák, összetett jelzés', icon: LineChart },
  { id: 'new-launch', label: 'Új token / Sniper', description: 'Friss launchok (csak PAPER)', icon: Rocket },
  { id: 'notifications', label: 'Értesítések', description: 'Telegram, e-mail, push', icon: Bell },
  { id: 'security', label: 'Tárca és biztonság', description: 'Tárca, LIVE biztonsági kapu', icon: Lock },
];

function isSection(value: string): value is SectionId {
  return SECTIONS.some((section) => section.id === value);
}

/** One setting: visible label, the control, and a short helper line. */
function Field({ label, help, children }: { label: string; help?: ReactNode; children: ReactNode }) {
  return <label className="sfield"><span className="sfield-label">{label}</span>{children}{help ? <span className="sfield-help">{help}</span> : null}</label>;
}

/** On/off setting shown as a switch with its label and helper text on the left. */
function Toggle({ label, help, checked, onChange, disabled = false }: { label: string; help?: ReactNode; checked: boolean; onChange?: (checked: boolean) => void; disabled?: boolean }) {
  return (
    <label className={`stoggle${disabled ? ' is-disabled' : ''}`}>
      <span className="stoggle-text"><span className="sfield-label">{label}</span>{help ? <span className="sfield-help">{help}</span> : null}</span>
      <input type="checkbox" role="switch" className="switch" checked={checked} disabled={disabled} readOnly={!onChange} onChange={(event) => onChange?.(event.target.checked)} />
    </label>
  );
}

/** A titled group of related settings with its own save action. */
function SettingsCard({ title, description, children, footer }: { title: string; description?: string; children: ReactNode; footer?: ReactNode }) {
  return (
    <section className="scard">
      <header className="scard-head"><h3>{title}</h3>{description ? <p>{description}</p> : null}</header>
      <div className="scard-body">{children}</div>
      {footer ? <footer className="scard-foot">{footer}</footer> : null}
    </section>
  );
}

function Details({ summary = 'Hogyan működik?', children }: { summary?: string; children: ReactNode }) {
  return <details className="sdetails"><summary>{summary}</summary><div>{children}</div></details>;
}

const numberOrNull = (value: string) => (value === '' ? null : Number(value));

export default function SettingsPage() {
  const [settings, setSettings] = useState<SettingsResponse | null>(null);
  const [aiMode, setAiMode] = useState(false);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string>('');
  const [active, setActive] = useState<SectionId>('account');

  // Deep link: /settings#risk opens that section; the hash follows the selection.
  useEffect(() => {
    const fromHash = () => {
      const hash = globalThis.location.hash.replace('#', '');
      if (isSection(hash)) setActive(hash);
    };
    fromHash();
    globalThis.addEventListener('hashchange', fromHash);
    return () => globalThis.removeEventListener('hashchange', fromHash);
  }, []);
  const select = (id: SectionId) => {
    setActive(id);
    setMessage('');
    globalThis.history.replaceState(null, '', `#${id}`);
  };

  const riskDraft = useMemo<RiskSettings>(() => settings?.risk ?? {
    riskPolicy: 'BALANCED', lowRiskMax: 30, moderateRiskMax: 50, highRiskMax: 70, veryHighRiskMax: 85,
    lowPositionMultiplier: 1, moderatePositionMultiplier: 0.75, highPositionMultiplier: 0.35, veryHighPositionMultiplier: 0.15,
    aiAnalysisEnabled: false, aiRequiredForHighRisk: false, aiRequiredForVeryHighRisk: false, allowManualPaperWatchBuy: true,
    maxPositionPercent: null, maxTotalExposurePercent: null, maxConcurrentPositions: null, dailyLossLimitPercent: null, maxSlippagePercent: null,
    minSignalScore: null, cooldownSeconds: null, stopLossPercent: null, takeProfitPercent: null, trailingStopPercent: null,
    trailingActivationPercent: null, breakEvenActivationPercent: null,
  }, [settings]);

  const notificationsDraft = useMemo(() => settings?.notifications ?? { telegramEnabled: false, telegramChatId: '', emailAlerts: false, pushAlerts: false }, [settings]);

  const loadSettings = async () => {
    try {
      // Only the very first load shows the loading state; reloads after a save keep the page mounted.
      const response = await apiRequest<ApiResponse<SettingsResponse>>('/api/settings');
      setSettings(response.data);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'A beállítások betöltése sikertelen');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadSettings();
  }, []);

  const save = async (pending: string, done: string, request: () => Promise<unknown>) => {
    try {
      setMessage(pending);
      await request();
      setMessage(done);
      await loadSettings();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'A mentés sikertelen');
    }
  };

  const updateGeneralSettings = (overrides: Partial<SettingsResponse> = {}, pending = 'Kereskedési beállítások mentése…', done = 'A kereskedési beállítások elmentve.') => settings && save(pending, done, () => apiRequest('/api/settings', {
    method: 'PATCH',
    // The full general payload is always sent (the endpoint applies defaults to omitted fields).
    body: JSON.stringify({
      // LIVE is only ever enabled through the safety gate, so general settings only switch PAPER / SEMI_AUTO.
      ...(settings.tradingMode === 'PAPER' || settings.tradingMode === 'SEMI_AUTO' ? { tradingMode: settings.tradingMode } : {}),
      isScannerEnabled: settings.isScannerEnabled,
      isPaperModeDefault: settings.isPaperModeDefault,
      maxPositionSize: settings.maxPositionSize,
      maxDailyLoss: settings.maxDailyLoss,
      riskThreshold: settings.riskThreshold,
      minLiquidityUsd: settings.minLiquidityUsd,
      minVolumeUsd: settings.minVolumeUsd,
      maxTokenAgeHours: settings.maxTokenAgeHours,
      skipUnbuyableAfterMinutes: settings.skipUnbuyableAfterMinutes,
      skipUnbuyableForMinutes: settings.skipUnbuyableForMinutes,
      maxMonitoredTokens: settings.maxMonitoredTokens,
      ...overrides,
    }),
  }));

  const setScannerEnabled = (value: boolean) => {
    if (!settings) return;
    setSettings({ ...settings, isScannerEnabled: value });
    void updateGeneralSettings({ isScannerEnabled: value }, value ? 'Tokenfigyelő bekapcsolása…' : 'Tokenfigyelő kikapcsolása…', value ? 'A tokenfigyelő bekapcsolva.' : 'A tokenfigyelő kikapcsolva – nem kér le új tokeneket és nem futtat rájuk stratégiát.');
  };

  const updateRiskSettings = () => save('Kockázati beállítások mentése…', 'A kockázati beállítások elmentve.', () => apiRequest('/api/settings/risk', { method: 'PATCH', body: JSON.stringify(riskDraft) }));

  const applyStrategyProfile = (profile: 'HIGH_RISK' | 'DEFAULT') => settings && save(
    profile === 'HIGH_RISK' ? 'Magas kockázatú profil alkalmazása…' : 'Alapértékek visszaállítása…',
    profile === 'HIGH_RISK' ? 'Magas kockázatú profil alkalmazva: a stratégiák a HIGH kockázatú tokenekre is adhatnak vételi jelzést.' : 'A stratégiák alapértékei visszaállítva.',
    async () => {
      for (const name of strategyNames) {
        const current = settings.strategies?.[name];
        const params = profile === 'HIGH_RISK' ? { ...(current?.params ?? {}), ...highRiskStrategyPreset[name] } : { ...(current?.defaults ?? current?.params ?? {}) };
        await apiRequest(`/api/settings/strategies/${encodeURIComponent(name)}`, { method: 'PATCH', body: JSON.stringify({ isEnabled: profile === 'HIGH_RISK' ? true : current?.isEnabled ?? false, params }) });
      }
    },
  );

  const updateStrategy = (name: string, value: { isEnabled: boolean; params: Record<string, number> }) => save(`${name} stratégia mentése…`, `${name} stratégia elmentve.`, () => apiRequest(`/api/settings/strategies/${encodeURIComponent(name)}`, { method: 'PATCH', body: JSON.stringify(value) }));

  const updateNotifications = () => save('Értesítések mentése…', 'Az értesítési beállítások elmentve.', () => apiRequest('/api/settings/notifications', {
    method: 'PATCH',
    body: JSON.stringify({ emailAlerts: notificationsDraft.emailAlerts, pushAlerts: notificationsDraft.pushAlerts }),
  }));

  if (loading || !settings) {
    return <><PageHeader eyebrow="Fiók" title="Beállítások" /><div className="state-panel">A mentett beállítások betöltése…</div></>;
  }

  const setRisk = (patch: Partial<RiskSettings>) => setSettings({ ...settings, risk: { ...riskDraft, ...patch } });
  const saveButton = (text: string, onClick: () => unknown) => <button type="button" className="primary-button" onClick={() => void onClick()}>{text}</button>;
  const current = SECTIONS.find((section) => section.id === active)!;
  const riskClasses: Array<{ label: string; tone: string; max: keyof RiskSettings; multiplier: keyof RiskSettings }> = [
    { label: 'LOW', tone: 'positive', max: 'lowRiskMax', multiplier: 'lowPositionMultiplier' },
    { label: 'MODERATE', tone: 'info', max: 'moderateRiskMax', multiplier: 'moderatePositionMultiplier' },
    { label: 'HIGH', tone: 'warning', max: 'highRiskMax', multiplier: 'highPositionMultiplier' },
    { label: 'VERY_HIGH', tone: 'danger', max: 'veryHighRiskMax', multiplier: 'veryHighPositionMultiplier' },
  ];

  return (
    <>
      <PageHeader eyebrow="Fiók" title="Beállítások" subtitle="Minden beállítás témakörönként – válaszd ki bal oldalt, mit szeretnél módosítani." action={<Status tone={settings.isLiveEnabled ? 'danger' : 'positive'}>{settings.tradingMode} MÓD</Status>} />
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Beállítás témakörök">
          {SECTIONS.map(({ id, label, description, icon: Icon }) => (
            <button key={id} type="button" className={`settings-nav-item${active === id ? ' active' : ''}`} aria-current={active === id ? 'page' : undefined} onClick={() => select(id)}>
              <span className="settings-nav-icon" aria-hidden="true"><Icon size={18} strokeWidth={2} /></span>
              <span className="settings-nav-text"><strong>{label}</strong><small>{description}</small></span>
            </button>
          ))}
        </nav>

        <div className="settings-content">
          <header className="settings-section-head">
            <h2>{current.label}</h2>
            <p>{current.description}</p>
          </header>
          {message ? <p className="settings-message" role="status" aria-live="polite">{message}</p> : null}

          {/* Sections stay mounted (only hidden) so unsaved edits survive switching between them. */}
          <div className="settings-section" hidden={active !== 'profile'}>
            <ProfilePicturePanel />
          </div>
          <div className="settings-section" hidden={active !== 'account'}>
            <PaperAccountPanel />
            <SettingsCard title="Kereskedési mód" description="Hogyan kezelje a bot a vételi jelzéseket." footer={saveButton('Mód mentése', () => updateGeneralSettings())}>
              <div className="sgrid">
                <Field label="Kereskedési mód" help={settings.tradingMode === 'LIVE' ? 'LIVE módot csak a biztonsági kapu kezel.' : 'SEMI_AUTO módban minden belépést neked kell jóváhagynod.'}>
                  <select value={settings.tradingMode} disabled={settings.tradingMode === 'LIVE'} onChange={(event) => setSettings({ ...settings, tradingMode: event.target.value })}>
                    <option value="PAPER">PAPER – automatikus szimulált kereskedés</option>
                    <option value="SEMI_AUTO">SEMI_AUTO – jóváhagyással</option>
                    {settings.tradingMode === 'LIVE' && <option value="LIVE">LIVE (biztonsági kapun keresztül)</option>}
                  </select>
                </Field>
              </div>
              <div className="stoggle-list">
                <Toggle label="Alapértelmezett paper mód" help="Új munkamenetek PAPER módban indulnak." checked={settings.isPaperModeDefault} onChange={(value) => setSettings({ ...settings, isPaperModeDefault: value })} />
              </div>
            </SettingsCard>
          </div>

          <div className="settings-section" hidden={active !== 'trading'}>
            <SettingsCard title="Pozícióméret és napi limit" description="Mekkora összeggel vásároljon a bot, és mikor álljon le aznapra." footer={saveButton('Kereskedési beállítások mentése', () => updateGeneralSettings())}>
              <div className="sgrid">
                <Field label="Pozícióméret automatikus vételnél (USDC)" help="Üresen a „Max. pozíció %” × kockázati szorzó határozza meg.">
                  <input type="number" min="0" step="1" placeholder="pl. 50" value={settings.maxPositionSize ?? ''} onChange={(event) => setSettings({ ...settings, maxPositionSize: numberOrNull(event.target.value) })} />
                </Field>
                <Field label="Napi veszteségkorlát (USDC)" help="Elérésekor aznap nem nyílik új pozíció. Üresen a %-os limit számít.">
                  <input type="number" min="0" step="1" placeholder="pl. 30" value={settings.maxDailyLoss ?? ''} onChange={(event) => setSettings({ ...settings, maxDailyLoss: numberOrNull(event.target.value) })} />
                </Field>
              </div>
              <Details>
                <p>A megadott USDC összeg az automatikus vételek alapmérete és a kézi vétel felső határa. Automatikus vételnél a kockázati szorzó arányosan csökkenti (pl. HIGH 0,35 × 100 USDC = 35 USDC); a kézi vétel pontosan a megadott összeggel történik.</p>
                <p>Kevesebbet vesz, ha nincs elég szabad egyenleg, betelt a teljes kitettségi keret, vagy a token likviditása nem bír el ekkora vételt. 1 USDC alatti automatikus vétel nem jön létre.</p>
              </Details>
            </SettingsCard>


          </div>

          <div className="settings-section" hidden={active !== 'scanner'}>
            <SettingsCard title="Tokenfigyelő (scanner)" description="A DexScreener listáiról folyamatosan új tokeneket vesz fel, értékeli őket, és a Stratégiák / AI alapján vételi jelzést ad.">
              <div className="stoggle-list">
                <Toggle label="Tokenfigyelő bekapcsolva" help={settings.isScannerEnabled ? 'Fut: tokeneket keres, frissít és stratégiákat futtat rájuk. A kapcsoló azonnal ment.' : 'Kikapcsolva: nem kér le új tokeneket, nem frissíti a figyelt listát és nem futtat rájuk stratégiát / AI-t. A kapcsoló azonnal ment.'} checked={settings.isScannerEnabled} onChange={setScannerEnabled} />
              </div>
              <p className="sfield-help">Kikapcsolva is tovább működik: a nyitott pozíciók védelme (stop loss, take profit, követő stop), az <strong>Új token / Sniper</strong> modul és a kézi PAPER vétel. A tokenfigyelő csak akkor fut, ha a bot is fut (Rendszer oldal).</p>
              <p className="sfield-help">A talált tokeneket a <a href="#strategies" onClick={(event) => { event.preventDefault(); select('strategies'); }}>Stratégiák</a> fülön engedélyezett stratégiák (vagy AI módban az AI) értékelik.</p>
            </SettingsCard>
            <div className={settings.isScannerEnabled ? '' : 'scanner-off'}>
            <SettingsCard title="Tokenfigyelő szűrők" description="Mely tokeneket vegye fel a scanner a figyelt listára." footer={saveButton('Szűrők mentése', () => updateGeneralSettings())}>
              <div className="sgrid">
                <Field label="Figyelt tokenek száma" help="10–300. Több token = több lehetőség, lassabb körforgás.">
                  <input type="number" min="10" max="300" step="5" value={settings.maxMonitoredTokens ?? 50} onChange={(event) => setSettings({ ...settings, maxMonitoredTokens: Math.min(300, Math.max(10, Math.round(Number(event.target.value) || 10))) })} />
                </Field>
                <Field label="Min. likviditás (USD)">
                  <input type="number" min="0" step="100" placeholder="5000" value={settings.minLiquidityUsd ?? ''} onChange={(event) => setSettings({ ...settings, minLiquidityUsd: numberOrNull(event.target.value) })} />
                </Field>
                <Field label="Min. 24 órás forgalom (USD)">
                  <input type="number" min="0" step="100" placeholder="2000" value={settings.minVolumeUsd ?? ''} onChange={(event) => setSettings({ ...settings, minVolumeUsd: numberOrNull(event.target.value) })} />
                </Field>
                <Field label="Max. token életkor (óra)">
                  <input type="number" min="1" step="1" placeholder="168" value={settings.maxTokenAgeHours ?? ''} onChange={(event) => setSettings({ ...settings, maxTokenAgeHours: numberOrNull(event.target.value) })} />
                </Field>
              </div>
              <Details>
                <p>A scanner folyamatosan új tokeneket vesz fel a DexScreener listáiról: az ígéreteseket (elfogadott / megfigyelt) félpercenként frissíti, az elutasítottakat 10–20 percre félreteszi, és a helyükre újakat vizsgál. A piaci adatszolgáltató percenkénti kéréskorlátja miatt nagyobb listán lassabb a körforgás.</p>
              </Details>
            </SettingsCard>
            <SettingsCard title="Nem vásárolható tokenek" description="Mennyi idő után hagyja ki a bot azokat a tokeneket, amelyeket nem tud megvenni." footer={saveButton('Mentés', () => updateGeneralSettings())}>
              <div className="sgrid">
                <Field label="Kihagyás ennyi perc után" help="0 = kikapcsolva.">
                  <input type="number" min="0" max="1440" step="1" value={settings.skipUnbuyableAfterMinutes ?? 0} onChange={(event) => setSettings({ ...settings, skipUnbuyableAfterMinutes: Math.max(0, Math.round(Number(event.target.value) || 0)) })} />
                </Field>
                <Field label="Kihagyás időtartama (perc)">
                  <input type="number" min="1" max="10080" step="5" value={settings.skipUnbuyableForMinutes ?? 60} onChange={(event) => setSettings({ ...settings, skipUnbuyableForMinutes: Math.max(1, Math.round(Number(event.target.value) || 1)) })} />
                </Field>
              </div>
              <p className="sfield-help">A számla-limitek (tele a pozíciók, nincs elég egyenleg) nem számítanak bele.</p>
            </SettingsCard>
            <SettingsCard title="Kilépési szabályok" description="Stop loss, take profit, követő stop és break-even a tokenfigyelő (stratégia / AI) és a kézi PAPER pozícióihoz – csak az újonnan nyitottakra érvényes. Az Új token pozíciók saját kilépési beállítást használnak." footer={saveButton('Kilépési szabályok mentése', updateRiskSettings)}>
              <div className="sgrid">
                <Field label="Stop loss (%)"><input type="number" step="0.1" value={riskDraft.stopLossPercent ?? ''} onChange={(event) => setRisk({ stopLossPercent: numberOrNull(event.target.value) })} /></Field>
                <Field label="Take profit (%)"><input type="number" step="0.1" value={riskDraft.takeProfitPercent ?? ''} onChange={(event) => setRisk({ takeProfitPercent: numberOrNull(event.target.value) })} /></Field>
                <Field label="Követő stop távolsága (%)" help="Üresen nincs követő stop."><input type="number" min="0" step="0.1" placeholder="pl. 8" value={riskDraft.trailingStopPercent ?? ''} onChange={(event) => setRisk({ trailingStopPercent: numberOrNull(event.target.value) })} /></Field>
                <Field label="Követő stop aktiválása (%)" help="Ekkora nyereség után kezd követni."><input type="number" min="0" step="0.5" placeholder="pl. 15" value={riskDraft.trailingActivationPercent ?? ''} onChange={(event) => setRisk({ trailingActivationPercent: numberOrNull(event.target.value) })} /></Field>
                <Field label="Break-even aktiválása (%)" help="Üresen kikapcsolva."><input type="number" min="0" step="0.5" placeholder="pl. 10" value={riskDraft.breakEvenActivationPercent ?? ''} onChange={(event) => setRisk({ breakEvenActivationPercent: numberOrNull(event.target.value) })} /></Field>
              </div>
              {riskDraft.trailingStopPercent && !riskDraft.trailingActivationPercent ? <p className="settings-warning">Figyelem: a követő stop most azonnal aktív a vétel után, így egy második, szorosabb stop lossként működik.</p> : null}
              <Details>
                <p>A követő stop akkor aktiválódik, amikor a pozíció elérte az aktiválási nyereséget (a tényleges belépési árhoz képest). Utána az elért legmagasabb ár alatt a megadott távolsággal követi az árat, és soha nem mozdul lefelé. PAPER kísérletezéshez pl. 15% aktiválás és 8% távolság javasolt.</p>
                <p>Break-even: ha a pozíció eléri ezt a nyereséget, a stop loss a nettó nullszintre (belépési ár + díjak) emelkedik.</p>
              </Details>
            </SettingsCard>
            </div>
          </div>

          <div className="settings-section" hidden={active !== 'risk'}>
            <SettingsCard title="Pozíció- és számlalimitek" description="Mennyi tőke lehet kockázatban egyszerre." footer={saveButton('Kockázati beállítások mentése', updateRiskSettings)}>
              <div className="sgrid">
                <Field label="Max. pozíció (az egyenleg %-a)"><input type="number" step="0.1" value={riskDraft.maxPositionPercent ?? ''} onChange={(event) => setRisk({ maxPositionPercent: numberOrNull(event.target.value) })} /></Field>
                <Field label="Max. teljes kitettség (%)"><input type="number" step="0.1" value={riskDraft.maxTotalExposurePercent ?? ''} onChange={(event) => setRisk({ maxTotalExposurePercent: numberOrNull(event.target.value) })} /></Field>
                <Field label="Max. egyidejű pozíciók" help="Elérésekor új pozíció csak egy zárás után nyílik."><input type="number" min="1" max="50" step="1" placeholder="alapérték: 3" value={riskDraft.maxConcurrentPositions ?? ''} onChange={(event) => setRisk({ maxConcurrentPositions: numberOrNull(event.target.value) })} /></Field>
                <Field label="Napi veszteségkorlát (%)" help="Csak ha nincs USDC-ban megadott korlát."><input type="number" step="0.1" value={riskDraft.dailyLossLimitPercent ?? ''} onChange={(event) => setRisk({ dailyLossLimitPercent: numberOrNull(event.target.value) })} /></Field>
                <Field label="Max. csúszás (%)"><input type="number" step="0.1" value={riskDraft.maxSlippagePercent ?? ''} onChange={(event) => setRisk({ maxSlippagePercent: numberOrNull(event.target.value) })} /></Field>
                <Field label="Min. jelzés pontszám"><input type="number" step="1" value={riskDraft.minSignalScore ?? ''} onChange={(event) => setRisk({ minSignalScore: numberOrNull(event.target.value) })} /></Field>
                <Field label="Várakozás két vétel között (mp)"><input type="number" step="1" value={riskDraft.cooldownSeconds ?? ''} onChange={(event) => setRisk({ cooldownSeconds: numberOrNull(event.target.value) })} /></Field>
              </div>
            </SettingsCard>


            <SettingsCard title="Kockázati osztályok" description="Kockázati pontszám-határok és pozícióméret-szorzók osztályonként." footer={saveButton('Kockázati osztályok mentése', updateRiskSettings)}>
              <div className="sgrid">
                <Field label="Kockázati irányelv" help={riskDraft.riskPolicy === 'EXPLORATORY' ? 'Csak PAPER: magasabb kockázatú tokenek is, csökkentett mérettel.' : undefined}>
                  <select value={riskDraft.riskPolicy} onChange={(event) => setRisk({ riskPolicy: event.target.value as RiskSettings['riskPolicy'] })}>
                    <option value="CONSERVATIVE">Óvatos (Conservative)</option>
                    <option value="BALANCED">Kiegyensúlyozott (Balanced)</option>
                    <option value="EXPLORATORY">Felfedező (Exploratory)</option>
                  </select>
                </Field>
              </div>
              <div className="risk-class-table" role="table" aria-label="Kockázati osztályok">
                <div className="risk-class-row risk-class-headrow" role="row">
                  <span role="columnheader">Osztály</span><span role="columnheader">Max. kockázati pontszám</span><span role="columnheader">Pozícióméret-szorzó</span>
                </div>
                {riskClasses.map((row) => (
                  <div className="risk-class-row" role="row" key={row.label}>
                    <span role="rowheader"><Status tone={row.tone}>{row.label}</Status></span>
                    <span role="cell"><input aria-label={`${row.label} max. kockázati pontszám`} type="number" min="0" max="100" step="1" value={riskDraft[row.max] as number} onChange={(event) => setRisk({ [row.max]: Number(event.target.value) } as Partial<RiskSettings>)} /></span>
                    <span role="cell"><input aria-label={`${row.label} pozícióméret-szorzó`} type="number" min="0" max="1" step="0.01" value={riskDraft[row.multiplier] as number} onChange={(event) => setRisk({ [row.multiplier]: Number(event.target.value) } as Partial<RiskSettings>)} /></span>
                  </div>
                ))}
              </div>
              <p className="sfield-help">A szorzók csak akkor csökkentik a vételt, ha nincs fix pozícióméret; kézi vételnél sosem. A besorolás és a kemény tiltások AI módban is érvényesek.</p>
              <div className="stoggle-list">
                <Toggle label="Megfigyelt tokenek kézi vétele" help="PAPER módban kézzel nyithatsz pozíciót Megfigyelés állapotú tokenre; a biztonsági limitek továbbra is érvényesek." checked={riskDraft.allowManualPaperWatchBuy} onChange={(value) => setRisk({ allowManualPaperWatchBuy: value })} />
              </div>
            </SettingsCard>

            <SettingsCard title="Kemény biztonsági tiltások" description="Rendszerszintű szabályok – mindig érvényesek, nem kapcsolhatók ki.">
              <ul className="locked-rules">
                {['Igazoltan sikertelen eladhatóság', 'Érvénytelen pool vagy végrehajtási útvonal', 'Likviditás az abszolút minimum alatt', 'Extrém árhatás vagy áraz(hat)atlan végrehajtás', 'Elavult vagy hiányzó piaci adat', 'Hibás piaci adat'].map((rule) => (
                  <li key={rule}><Lock size={15} aria-hidden="true" /> {rule}</li>
                ))}
              </ul>
            </SettingsCard>
          </div>

          <div className="settings-section" hidden={active !== 'ai'}>
            <AiSettingsPanel onModeChange={setAiMode} />
          </div>

          <div className="settings-section" hidden={active !== 'strategies'}>
            <SettingsCard title="Alap stratégiák" description="A worker csak az itt engedélyezett stratégiákat futtatja. A küszöbök 0–100 közöttiek." footer={<>
              <span className="scard-foot-label">Gyors profil:</span>
              <button type="button" className="secondary-button" onClick={() => void applyStrategyProfile('DEFAULT')}>Alapértékek</button>
              <button type="button" className="primary-button" onClick={() => void applyStrategyProfile('HIGH_RISK')}>Magas kockázatú profil</button>
            </>}>
              <div className={aiMode ? 'ai-mode-dimmed' : ''}>
                <AiModeStrategyNotice aiMode={aiMode} />
                <div className="strategy-stack">
                  {strategyNames.map((name) => {
                    const strategies = settings.strategies ?? {};
                    const strategy = strategies[name] ?? { isEnabled: false, params: {} };
                    const setParam = (key: string, value: number) => setSettings({ ...settings, strategies: { ...strategies, [name]: { ...strategy, params: { ...strategy.params, [key]: value } } } });
                    return (
                      <div key={name} className="strategy-block">
                        <Toggle label={name} help={strategy.isEnabled ? 'Engedélyezve' : 'Kikapcsolva'} checked={strategy.isEnabled} onChange={(value) => setSettings({ ...settings, strategies: { ...strategies, [name]: { ...strategy, isEnabled: value } } })} />
                        <div className="sgrid sgrid-3">
                          {Object.entries(strategy.params).map(([key, value]) => key === 'cooldownMs'
                            ? <Field key={key} label={strategyParamLabels[key] ?? key}><input type="number" min="0" step="1" value={Math.round(value / 60_000)} onChange={(event) => setParam(key, Math.max(0, Number(event.target.value)) * 60_000)} /></Field>
                            : <Field key={key} label={strategyParamLabels[key] ?? key}><input type="number" min="0" max="100" step="1" value={value} onChange={(event) => setParam(key, Math.max(0, Number(event.target.value)))} /></Field>)}
                        </div>
                        <div className="strategy-block-foot"><button type="button" className="secondary-button" onClick={() => void updateStrategy(name, { isEnabled: strategy.isEnabled, params: strategy.params })}>{name} mentése</button></div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </SettingsCard>
            <AdvancedStrategiesPanel aiMode={aiMode} />
          </div>

          <div className="settings-section" hidden={active !== 'new-launch'}>
            <NewLaunchSettingsPanel tradingMode={settings.tradingMode} />
          </div>

          <div className="settings-section" hidden={active !== 'notifications'}>
            <TelegramPanel tradingMode={settings.tradingMode} />
            <SettingsCard title="Egyéb értesítések" footer={saveButton('Értesítések mentése', updateNotifications)}>
              <div className="stoggle-list">
                <Toggle label="E-mail értesítések" checked={notificationsDraft.emailAlerts} onChange={(value) => setSettings({ ...settings, notifications: { ...notificationsDraft, emailAlerts: value } })} />
                <Toggle label="Push értesítések" checked={notificationsDraft.pushAlerts} onChange={(value) => setSettings({ ...settings, notifications: { ...notificationsDraft, pushAlerts: value } })} />
              </div>
            </SettingsCard>
          </div>

          <div className="settings-section" hidden={active !== 'security'}>
            <WalletSettingsPanel />
            <LiveSafetyControls onChange={() => void loadSettings()} />
          </div>
        </div>
      </div>
    </>
  );
}
