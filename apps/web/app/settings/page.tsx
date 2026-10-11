'use client';
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BrainCircuit, Lock, RotateCcw, Save, Search, X } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import { apiRequest, fmt, PageHeader, Status, useApi } from '../components';
import { LiveSafetyControls } from '../live-safety-controls';
import { PROVIDER_STATUS_LABELS } from '../locales/position-labels';
import { newLaunchSaveBody, NewLaunchRecommendations, type NewLaunchSettings, NewLaunchVersions, SECURITY_LABELS, SocialProviderStatus } from '../new-launch-settings-panel';
import { PaperAccountPanel } from '../paper-account-panel';
import { ProfilePicturePanel } from '../profile-picture-panel';
import { TelegramPanel } from '../telegram-panel';
import { WalletSettingsPanel } from '../wallet-connect';

import { PaperStrategyCard } from './paper-strategy-card';
import { type Apply, APPLY_LABELS, type CardDef, cardMatches, CARDS, type FieldDef, fieldMatches, type GroupId, GROUPS, LEGACY_HASHES, normalize, type Source } from './settings-schema';

type Values = Record<string, any>;
type Drafts = { bot: Values; risk: Values; nl: NewLaunchSettings };
type ApiResponse<T> = { data: T };

/** BotConfig fields owned by this page (PATCH /api/settings). */
const BOT_KEYS = ['tradingMode', 'maxDailyLoss', 'minLiquidityUsd', 'minVolumeUsd', 'maxTokenAgeHours', 'skipUnbuyableAfterMinutes', 'skipUnbuyableForMinutes'];
/** RiskConfig fields owned by this page (PATCH /api/settings/risk). */
const RISK_KEYS = ['riskPolicy', 'lowRiskMax', 'moderateRiskMax', 'highRiskMax', 'veryHighRiskMax', 'lowPositionMultiplier', 'moderatePositionMultiplier', 'highPositionMultiplier', 'veryHighPositionMultiplier', 'maxTotalExposurePercent', 'maxConcurrentPositions', 'dailyLossLimitPercent', 'maxSlippagePercent'];
/** Cards that render an existing self-framed panel. */
const BARE_CARDS = new Set(['paper-account', 'live-safety', 'telegram', 'wallet', 'profile']);
const RISK_CLASSES = [
  { label: 'LOW', tone: 'positive', max: 'lowRiskMax', multiplier: 'lowPositionMultiplier' },
  { label: 'MODERATE', tone: 'info', max: 'moderateRiskMax', multiplier: 'moderatePositionMultiplier' },
  { label: 'HIGH', tone: 'warning', max: 'highRiskMax', multiplier: 'highPositionMultiplier' },
  { label: 'VERY_HIGH', tone: 'danger', max: 'veryHighRiskMax', multiplier: 'veryHighPositionMultiplier' },
] as const;
const HARD_RULES = ['Igazoltan sikertelen eladhatóság', 'Érvénytelen pool vagy végrehajtási útvonal', 'Likviditás az abszolút minimum alatt', 'Extrém árhatás vagy árazhatatlan végrehajtás', 'Elavult vagy hiányzó piaci adat', 'Hibás piaci adat'];
const SOURCE_LABELS: Record<'bot' | 'risk' | 'nl', string> = { bot: 'Bot', risk: 'Kockázat', nl: 'New Launch' };

const pick = (values: Values, keys: string[]) => Object.fromEntries(keys.map((key) => [key, values[key] ?? null]));
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function readValue(drafts: Drafts, source: Source, key: string) {
  if (source === 'gate') return drafts.nl.qualityGate?.[key as keyof NewLaunchSettings['qualityGate']] ?? null;
  return drafts[source]?.[key] ?? null;
}

function writeValue(drafts: Drafts, source: Source, key: string, value: unknown): Drafts {
  if (source === 'gate') return { ...drafts, nl: { ...drafts.nl, qualityGate: { ...drafts.nl.qualityGate, [key]: value } } };
  return { ...drafts, [source]: { ...drafts[source], [key]: value } };
}

function fieldVisible(field: FieldDef, drafts: Drafts) {
  return !field.dependsOn || Boolean(readValue(drafts, field.source, field.dependsOn));
}

/** Validation message of one field, or null. */
function fieldError(field: FieldDef, value: unknown): string | null {
  if (field.kind !== 'number') return null;
  if (value === null || value === undefined || value === '') return field.nullable ? null : 'Kötelező mező.';
  const number = Number(value);
  if (!Number.isFinite(number)) return 'Érvénytelen szám.';
  if (field.min !== undefined && number < field.min) return `Legalább ${fmt(field.min)}.`;
  if (field.max !== undefined && number > field.max) return `Legfeljebb ${fmt(field.max)}.`;
  return null;
}

/** Cross-field rules the API also enforces, keyed by the card that shows them. */
function crossErrors(drafts: Drafts): Array<{ card: string; text: string }> {
  const errors: Array<{ card: string; text: string }> = [];
  if (Number(drafts.nl.minAgeSeconds) >= Number(drafts.nl.maxAgeSeconds)) errors.push({ card: 'nl-window', text: 'A minimum életkornak kisebbnek kell lennie a maximális életkornál.' });
  const thresholds = RISK_CLASSES.map((row) => Number(drafts.risk[row.max]));
  if (thresholds.some((value, index) => !Number.isFinite(value) || value < 0 || value > 100 || (index > 0 && value <= thresholds[index - 1]))) errors.push({ card: 'risk-classes', text: 'A pontszám-határok 0–100 közöttiek és szigorúan növekvők (LOW < MODERATE < HIGH < VERY_HIGH).' });
  if (RISK_CLASSES.some((row) => { const value = Number(drafts.risk[row.multiplier]); return drafts.risk[row.multiplier] === null || !Number.isFinite(value) || value < 0 || value > 1; })) errors.push({ card: 'risk-classes', text: 'A pozícióméret-szorzók 0 és 1 közöttiek.' });
  return errors;
}

function ApplyBadge({ apply }: { apply: Apply }) {
  const meta = APPLY_LABELS[apply];
  return <span className={`apply-badge ${meta.tone}`} title={meta.title}>{meta.text}</span>;
}

function FieldControl({ field, value, saved, onChange, cardApply }: { field: FieldDef; value: unknown; saved: unknown; onChange: (value: unknown) => void; cardApply?: Apply }) {
  const dirty = !same(value ?? null, saved ?? null);
  const error = fieldError(field, value);
  const id = `setting-${field.source}-${field.key}`;
  const label = <span className="sfield-label-row"><span className="sfield-label">{field.label}</span>{dirty ? <span className="dirty-dot" title="Mentetlen módosítás" /> : null}{field.apply !== cardApply ? <ApplyBadge apply={field.apply} /> : null}</span>;
  if (field.kind === 'toggle') {
    return <label className={`stoggle${dirty ? ' is-dirty' : ''}`} htmlFor={id}>
      <span className="stoggle-text">{label}{field.help ? <span className="sfield-help">{field.help}</span> : null}</span>
      <input id={id} type="checkbox" role="switch" className="switch" checked={Boolean(value)} onChange={(event) => onChange(event.target.checked)} />
    </label>;
  }
  return <div className={`sfield${dirty ? ' is-dirty' : ''}${error ? ' has-error' : ''}`}>
    <label htmlFor={id}>{label}</label>
    {field.kind === 'select'
      ? <select id={id} value={String(value ?? '')} onChange={(event) => onChange(event.target.value)}>{field.options?.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
      : <input id={id} type="number" inputMode="decimal" min={field.min} max={field.max} step={field.step ?? 1} placeholder={field.placeholder} value={value === null || value === undefined ? '' : String(value)}
        aria-invalid={error ? true : undefined} aria-describedby={error ? `${id}-error` : undefined}
        onChange={(event) => onChange(event.target.value === '' ? null : Number(event.target.value))} />}
    {error ? <span className="sfield-error" id={`${id}-error`} role="alert">{error}</span> : field.help ? <span className="sfield-help">{field.help}</span> : null}
  </div>;
}

/** Badge of a card: its own, or the one all of its fields share (fields only show a badge when they differ). */
function cardApplyOf(card: CardDef): Apply | undefined {
  if (card.apply) return card.apply;
  const applies = new Set((card.fields ?? []).map((field) => field.apply));
  return applies.size === 1 ? [...applies][0] : undefined;
}

function Card({ card, children }: { card: CardDef; children: ReactNode }) {
  const apply = cardApplyOf(card);
  return <section className="scard" id={`card-${card.id}`}>
    <header className="scard-head scard-head-row">
      <div><h3>{card.title}</h3>{card.description ? <p>{card.description}</p> : null}</div>
      {apply ? <ApplyBadge apply={apply} /> : null}
    </header>
    <div className="scard-body">{children}{card.note ? <p className="sfield-help card-note">{card.note}</p> : null}</div>
  </section>;
}

function BotStatusCard({ general }: { general: Values }) {
  const { data } = useApi<ApiResponse<{ botState: { status: string } | null }>>('/api/bot/status');
  const status = data?.data?.botState?.status ?? general.botStatus ?? 'ISMERETLEN';
  const tone = status === 'RUNNING' ? 'positive' : status === 'PAUSED' ? 'warning' : status === 'EMERGENCY_STOP' ? 'danger' : 'neutral';
  const names: Record<string, string> = { RUNNING: 'FUT', PAUSED: 'SZÜNETEL', STOPPED: 'LEÁLLÍTVA', EMERGENCY_STOP: 'VÉSZLEÁLLÍTÁS' };
  return <div className="status-list">
    <div className="status-row"><span>Bot</span><Status tone={tone}>{names[status] ?? status}</Status></div>
    <div className="status-row"><span>Kereskedési mód</span><Status tone={general.tradingMode === 'PAPER' ? 'positive' : 'warning'}>{general.tradingMode}</Status></div>
    <div className="status-row"><span>New Launch figyelés</span><Status tone={general.newLaunch?.enabled ? 'positive' : 'neutral'}>{general.newLaunch?.enabled ? `BE · ${general.newLaunch.configVersion}` : 'KI'}</Status></div>
    <div className="status-row"><span>LIVE kereskedés</span><Status tone="positive">TILTVA</Status></div>
    <div className="status-row"><span>Machine Learning</span><Status tone="info">SHADOW – nem dönt</Status></div>
    {general.isEmergencyStop ? <p className="settings-warning">Vészleállítás aktív: új belépés nem nyílik, amíg a LIVE biztonsági kapuban fel nem oldod. A nyitott pozíciók kilépés-figyelése fut.</p> : null}
    <p className="sfield-help">Indítás, szüneteltetés és leállítás: <Link className="table-link" href="/dashboard">Irányítópult → Fő vezérlők</Link> (adminisztrátor). Szüneteltetve és leállítva is fut a nyitott pozíciók kilépés-figyelése (SL / TP / trailing).</p>
  </div>;
}

function RpcStatusCard() {
  const { data, error } = useApi<ApiResponse<{ rpc: any; components: Array<{ component: string; state: string }> }>>('/api/system/health');
  if (error) return <p className="sfield-help">Az RPC részletes állapota adminisztrátori jogosultsággal érhető el a <Link className="table-link" href="/system">Rendszer</Link> oldalon.</p>;
  const rpc = data?.data?.rpc;
  const component = data?.data?.components?.find((item) => item.component === 'RPC');
  const providers: any[] = Array.isArray(rpc?.providers) ? rpc.providers : [];
  return <div className="status-list">
    <div className="status-row"><span>RPC összesítve</span><Status tone={component?.state === 'HEALTHY' ? 'positive' : component ? 'warning' : 'neutral'}>{component?.state ?? (data ? 'ISMERETLEN' : 'BETÖLTÉS…')}</Status></div>
    {providers.map((provider, index) => <div className="status-row" key={`${provider.label ?? provider.role ?? index}`}><span>{provider.label ?? provider.role ?? `Szolgáltató ${index + 1}`}</span><Status tone={provider.status === 'HEALTHY' ? 'positive' : provider.status === 'DEGRADED' ? 'warning' : 'danger'}>{provider.status ?? 'ISMERETLEN'}</Status></div>)}
    <p className="sfield-help">Végpontok és API-kulcsok a szerver <code>.env</code> fájljában vannak; a felület soha nem jeleníti meg őket. Módosításuk után a worker újraindítása szükséges.</p>
  </div>;
}

function MlStatusCard() {
  const { data, error } = useApi<ApiResponse<any>>('/api/ml/overview');
  if (error) return <p className="sfield-help">Az ML állapot most nem érhető el ({error}).</p>;
  const ml = data?.data;
  if (!ml) return <p className="sfield-help">Betöltés…</p>;
  const active = (ml.models ?? []).find((model: any) => model.status === 'SHADOW');
  return <div className="status-list">
    <div className="status-row"><span>Mód</span><Status tone="info">{ml.mode ?? 'SHADOW'}</Status></div>
    <div className="status-row"><span>Worker ML állapotjelentés</span><Status tone={ml.worker ? 'positive' : 'warning'}>{ml.worker ? 'ÉL' : 'NINCS ADAT'}</Status></div>
    <div className="status-row"><span>Jelöltek (24 óra)</span><strong>{fmt(ml.candidatesLast24h, 0)}</strong></div>
    <div className="status-row"><span>Predikciók összesen</span><strong>{fmt(ml.predictions, 0)}</strong></div>
    <div className="status-row"><span>Árnyékmodell</span><strong>{active ? `${active.version} (${active.algorithm})` : 'nincs aktív'}</strong></div>
    <p className="sfield-help"><BrainCircuit size={14} aria-hidden="true" /> A módot az <code>ML_MODE</code> szerverváltozó állítja (worker újraindítással). Modellek, adatkészletek és tanítás: <Link className="table-link" href="/machine-learning">Machine Learning oldal</Link>.</p>
  </div>;
}

function RiskClassesCard({ risk, saved, onChange }: { risk: Values; saved: Values; onChange: (key: string, value: unknown) => void }) {
  const dirty = (key: string) => !same(risk[key], saved[key]);
  return <>
    <div className={`sfield${dirty('riskPolicy') ? ' is-dirty' : ''}`}>
      <label htmlFor="setting-risk-riskPolicy"><span className="sfield-label-row"><span className="sfield-label">Kockázati irányelv</span></span></label>
      <select id="setting-risk-riskPolicy" value={risk.riskPolicy ?? 'BALANCED'} onChange={(event) => onChange('riskPolicy', event.target.value)}>
        <option value="CONSERVATIVE">Óvatos (Conservative)</option>
        <option value="BALANCED">Kiegyensúlyozott (Balanced)</option>
        <option value="EXPLORATORY">Felfedező (Exploratory) – csak PAPER</option>
      </select>
    </div>
    <div className="risk-class-table" role="table" aria-label="Kockázati osztályok">
      <div className="risk-class-row risk-class-headrow" role="row"><span role="columnheader">Osztály</span><span role="columnheader">Max. kockázati pontszám</span><span role="columnheader">Pozícióméret-szorzó</span></div>
      {RISK_CLASSES.map((row) => <div className="risk-class-row" role="row" key={row.label}>
        <span role="rowheader"><Status tone={row.tone}>{row.label}</Status></span>
        <span role="cell"><input className={dirty(row.max) ? 'is-dirty' : ''} aria-label={`${row.label} max. kockázati pontszám`} type="number" min="0" max="100" step="1" value={risk[row.max] ?? ''} onChange={(event) => onChange(row.max, event.target.value === '' ? null : Number(event.target.value))} /></span>
        <span role="cell"><input className={dirty(row.multiplier) ? 'is-dirty' : ''} aria-label={`${row.label} pozícióméret-szorzó`} type="number" min="0" max="1" step="0.01" value={risk[row.multiplier] ?? ''} onChange={(event) => onChange(row.multiplier, event.target.value === '' ? null : Number(event.target.value))} /></span>
      </div>)}
    </div>
    <p className="sfield-help">A szorzó a New Launch pozícióméretét csökkenti a token kockázati osztálya szerint. A kemény tiltások minden irányelvnél érvényesek.</p>
  </>;
}

export default function SettingsPage() {
  const [general, setGeneral] = useState<Values | null>(null);
  const [saved, setSaved] = useState<Drafts | null>(null);
  const [drafts, setDrafts] = useState<Drafts | null>(null);
  const [loadError, setLoadError] = useState('');
  const [message, setMessage] = useState<{ text: string; tone: 'info' | 'error' | 'success' } | null>(null);
  const [saving, setSaving] = useState(false);
  const [active, setActive] = useState<GroupId>('bot');
  const [query, setQuery] = useState('');

  const load = useCallback(async () => {
    try {
      const [settings, newLaunch] = await Promise.all([
        apiRequest<ApiResponse<Values>>('/api/settings'),
        apiRequest<ApiResponse<NewLaunchSettings>>('/api/settings/new-launch'),
      ]);
      const next: Drafts = { bot: pick(settings.data, BOT_KEYS), risk: pick(settings.data.risk ?? {}, RISK_KEYS), nl: newLaunch.data };
      setGeneral(settings.data);
      setSaved(next);
      setDrafts(next);
      setLoadError('');
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'A beállítások betöltése sikertelen');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // Deep links: /settings#launch (and the old #risk, #new-launch ... anchors) open that group.
  useEffect(() => {
    const fromHash = () => {
      const hash = globalThis.location.hash.replace('#', '');
      const group = GROUPS.find((item) => item.id === hash)?.id ?? LEGACY_HASHES[hash];
      if (group) setActive(group);
    };
    fromHash();
    globalThis.addEventListener('hashchange', fromHash);
    return () => globalThis.removeEventListener('hashchange', fromHash);
  }, []);

  const dirtySources = useMemo(() => (drafts && saved ? (['bot', 'risk', 'nl'] as const).filter((source) => !same(drafts[source], saved[source])) : []), [drafts, saved]);
  const dirty = dirtySources.length > 0;

  // Leaving the page with unsaved changes asks first.
  useEffect(() => {
    if (!dirty) return undefined;
    const warn = (event: globalThis.BeforeUnloadEvent) => { event.preventDefault(); };
    globalThis.addEventListener('beforeunload', warn);
    return () => globalThis.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const normalizedQuery = normalize(query.trim());
  const searching = normalizedQuery.length > 0;

  /** Cards (and, while searching, the matching fields) to render. */
  const visibleCards = useMemo(() => CARDS.flatMap((card) => {
    if (!searching) return card.group === active ? [{ card, fields: card.fields }] : [];
    if (cardMatches(card, normalizedQuery)) return [{ card, fields: card.fields }];
    const fields = card.fields?.filter((field) => fieldMatches(field, normalizedQuery));
    return fields && fields.length > 0 ? [{ card, fields }] : [];
  }), [active, normalizedQuery, searching]);

  const matchCount = (group: GroupId) => visibleCards.filter((item) => item.card.group === group).length;

  if (loadError && !drafts) return <><PageHeader eyebrow="Fiók" title="Beállítások" /><div className="state-panel" role="alert">{loadError} <button type="button" className="secondary-button" onClick={() => void load()}>Újra</button></div></>;
  if (!drafts || !saved || !general) return <><PageHeader eyebrow="Fiók" title="Beállítások" /><div className="state-panel">A mentett beállítások betöltése…</div></>;

  const change = (source: Source, key: string, value: unknown) => setDrafts((current) => (current ? writeValue(current, source, key, value) : current));
  const cross = crossErrors(drafts);
  const errors = [
    ...CARDS.flatMap((card) => (card.fields ?? []).filter((field) => fieldVisible(field, drafts) && fieldError(field, readValue(drafts, field.source, field.key))).map((field) => `${card.title}: ${field.label}`)),
    ...cross.map((error) => `${CARDS.find((card) => card.id === error.card)?.title ?? ''}: ${error.text}`),
  ];

  const discard = () => { setDrafts(saved); setMessage({ text: 'A módosítások elvetve.', tone: 'info' }); };

  const save = async () => {
    if (errors.length > 0) {
      setMessage({ text: `Javítsd a hibás mezőket: ${errors.slice(0, 3).join(' · ')}${errors.length > 3 ? ' …' : ''}`, tone: 'error' });
      return;
    }
    setSaving(true);
    setMessage({ text: 'Mentés…', tone: 'info' });
    const done: string[] = [];
    try {
      if (dirtySources.includes('bot')) {
        const body = Object.fromEntries(BOT_KEYS.filter((key) => !same(drafts.bot[key], saved.bot[key])).map((key) => [key, drafts.bot[key]]));
        // LIVE is only ever changed through the safety gate.
        if (body.tradingMode !== undefined && body.tradingMode !== 'PAPER' && body.tradingMode !== 'SEMI_AUTO') delete body.tradingMode;
        await apiRequest('/api/settings', { method: 'PATCH', body: JSON.stringify(body) });
        done.push(SOURCE_LABELS.bot);
      }
      if (dirtySources.includes('risk')) {
        await apiRequest('/api/settings/risk', { method: 'PATCH', body: JSON.stringify(drafts.risk) });
        done.push(SOURCE_LABELS.risk);
      }
      let versionNote = '';
      if (dirtySources.includes('nl')) {
        const response = await apiRequest<ApiResponse<NewLaunchSettings>>('/api/settings/new-launch', { method: 'PUT', body: JSON.stringify(newLaunchSaveBody(drafts.nl)) });
        done.push(SOURCE_LABELS.nl);
        if (response.data.configVersion !== saved.nl.configVersion) versionNote = ` Új New Launch konfiguráció-verzió: ${response.data.configVersion} – a nyitott pozíciók a belépéskori beállításukkal futnak tovább.`;
      }
      await load();
      setMessage({ text: `Elmentve (${done.join(', ')}).${versionNote}`, tone: 'success' });
    } catch (error) {
      // What was saved before the failure is reloaded; the rest stays as an unsaved draft.
      const failed = error instanceof Error ? error.message : 'A mentés sikertelen';
      if (done.length > 0) {
        const keep = drafts;
        await load();
        setDrafts((current) => (current ? { ...current, ...Object.fromEntries((['bot', 'risk', 'nl'] as const).filter((source) => !done.includes(SOURCE_LABELS[source])).map((source) => [source, keep[source]])) } : current));
      }
      setMessage({ text: `${done.length ? `Elmentve: ${done.join(', ')}. ` : ''}Hiba: ${failed}`, tone: 'error' });
    } finally {
      setSaving(false);
    }
  };

  const select = (id: GroupId) => {
    setActive(id);
    setQuery('');
    globalThis.history.replaceState(null, '', `#${id}`);
    globalThis.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const renderCustom = (card: CardDef): ReactNode => {
    switch (card.custom) {
      case 'bot-status': return <BotStatusCard general={general} />;
      case 'paper-strategy': return <PaperStrategyCard />;
      case 'paper-account': return <PaperAccountPanel />;
      case 'live-safety': return <LiveSafetyControls onChange={() => void load()} />;
      case 'nl-security': return <ul className="locked-rules">{(drafts.nl.mandatorySecurity ?? []).map((rule) => <li key={rule}><Lock size={15} aria-hidden="true" /> {SECURITY_LABELS[rule] ?? rule}</li>)}</ul>;
      case 'risk-classes': return <RiskClassesCard risk={drafts.risk} saved={saved.risk} onChange={(key, value) => change('risk', key, value)} />;
      case 'hard-rules': return <ul className="locked-rules">{HARD_RULES.map((rule) => <li key={rule}><Lock size={15} aria-hidden="true" /> {rule}</li>)}</ul>;
      case 'nl-providers': return <div className="status-list">
        {(drafts.nl.providers ?? []).map((provider) => {
          const status = PROVIDER_STATUS_LABELS[provider.status] ?? { label: provider.status, tone: 'neutral' };
          return <div className="status-row" key={provider.source}><span>{provider.label}{provider.detail ? <small className="sfield-help"> · {provider.detail}</small> : null}</span><Status tone={status.tone}>{status.label}</Status></div>;
        })}
        {(drafts.nl.providers ?? []).length === 0 ? <p className="sfield-help">A worker még nem jelentett szolgáltató-állapotot.</p> : null}
        <p className="sfield-help">A felfedezés (NEW_LAUNCH_DISCOVERY_ENABLED, SOLANA_WS_URL) szerveroldali beállítás; kulcsot vagy URL-t a felület nem jelenít meg.</p>
      </div>;
      case 'rpc-status': return <RpcStatusCard />;
      case 'social-status': return <SocialProviderStatus />;
      case 'telegram': return <TelegramPanel tradingMode={general.tradingMode} />;
      case 'wallet': return <WalletSettingsPanel />;
      case 'ml-status': return <MlStatusCard />;
      case 'nl-optimizer': return <NewLaunchRecommendations onChanged={() => void load()} setMessage={(text) => setMessage({ text, tone: 'info' })} />;
      case 'nl-versions': return <NewLaunchVersions settings={drafts.nl} />;
      case 'profile': return <ProfilePicturePanel />;
      case 'retired': return <p className="sfield-help">Korábbi jelzéseik, kereskedéseik és AI-elemzéseik megmaradtak, és továbbra is láthatók a <Link className="table-link" href="/signals">Jelzések</Link>, <Link className="table-link" href="/trades">Kereskedések</Link> és <Link className="table-link" href="/analytics">Elemzések</Link> oldalon. Az automatikus belépéseket kizárólag a New Launch modul kezdeményezi.</p>;
      default: return null;
    }
  };

  const renderCard = ({ card, fields }: { card: CardDef; fields?: FieldDef[] }) => {
    if (card.custom && BARE_CARDS.has(card.custom)) return <div key={card.id} id={`card-${card.id}`}>{renderCustom(card)}</div>;
    const shown = (fields ?? []).filter((field) => fieldVisible(field, drafts));
    const toggles = shown.filter((field) => field.kind === 'toggle');
    const inputs = shown.filter((field) => field.kind !== 'toggle');
    return <Card key={card.id} card={card}>
      {cross.filter((error) => error.card === card.id).map((error) => <p key={error.text} className="settings-error" role="alert">{error.text}</p>)}
      {card.custom ? renderCustom(card) : null}
      {card.id === 'trading-mode' && drafts.bot.tradingMode !== 'PAPER' ? <p className="settings-warning">A New Launch csak PAPER módban nyit pozíciót – {drafts.bot.tradingMode} módban nem lesz új belépés.</p> : null}
      {card.id === 'nl-main' && drafts.nl.enabled && drafts.bot.tradingMode !== 'PAPER' ? <p className="settings-warning">A kereskedési mód most {drafts.bot.tradingMode}: a New Launch ebben a módban nem nyit pozíciót.</p> : null}
      {toggles.length > 0 ? <div className="stoggle-list">{toggles.map((field) => <FieldControl key={field.key} field={field} value={readValue(drafts, field.source, field.key)} saved={readValue(saved, field.source, field.key)} onChange={(value) => change(field.source, field.key, value)} cardApply={cardApplyOf(card)} />)}</div> : null}
      {inputs.length > 0 ? <div className={`sgrid${inputs.length > 4 ? ' sgrid-3' : ''}${toggles.length > 0 ? ' sgrid-spaced' : ''}`}>{inputs.map((field) => <FieldControl key={`${field.source}-${field.key}`} field={field} value={readValue(drafts, field.source, field.key)} saved={readValue(saved, field.source, field.key)} onChange={(value) => change(field.source, field.key, value)} cardApply={cardApplyOf(card)} />)}</div> : null}
      {card.id === 'exit-protect' && drafts.nl.trailingEnabled && Number(drafts.nl.trailingActivationPercent) === 0 ? <p className="settings-warning">Figyelem: 0% aktiválásnál a követő stop azonnal él a vétel után, így egy második, szorosabb stop lossként működik.</p> : null}
    </Card>;
  };

  const currentGroup = GROUPS.find((group) => group.id === active)!;
  const groupsToRender = searching ? GROUPS.filter((group) => matchCount(group.id) > 0) : [currentGroup];

  return (
    <>
      <PageHeader eyebrow="Fiók" title="Beállítások" subtitle="A bot működése témakörönként. Minden érték a szerveren tárolódik; titkos kulcs soha nem jelenik meg." action={<Status tone={general.tradingMode === 'PAPER' ? 'positive' : 'warning'}>{general.tradingMode} MÓD</Status>} />
      <div className="settings-search" role="search">
        <Search size={18} aria-hidden="true" />
        <input type="search" placeholder="Keresés a beállítások között (pl. stop loss, likviditás, Telegram)…" aria-label="Keresés a beállítások között" value={query} onChange={(event) => setQuery(event.target.value)} />
        {query ? <button type="button" className="icon-button" aria-label="Keresés törlése" onClick={() => setQuery('')}><X size={16} /></button> : null}
      </div>
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Beállítás csoportok">
          {GROUPS.map(({ id, letter, label, description, icon: Icon }) => {
            const count = searching ? matchCount(id) : null;
            return <button key={id} type="button" className={`settings-nav-item${!searching && active === id ? ' active' : ''}${count === 0 ? ' is-empty' : ''}`} aria-current={!searching && active === id ? 'page' : undefined} onClick={() => select(id)}>
              <span className="settings-nav-icon" aria-hidden="true"><Icon size={18} strokeWidth={2} /></span>
              <span className="settings-nav-text"><strong><span className="settings-nav-letter">{letter}.</span> {label}</strong><small>{description}</small></span>
              {count !== null ? <span className="settings-nav-count">{count}</span> : null}
            </button>;
          })}
        </nav>

        <div className="settings-content">
          {message ? <p className={`settings-message ${message.tone}`} role="status" aria-live="polite">{message.text}</p> : null}
          {searching && visibleCards.length === 0 ? <div className="state-panel">Nincs találat erre: „{query}”.</div> : null}
          {groupsToRender.map((group) => <div className="settings-section" key={group.id}>
            <header className="settings-section-head">
              <h2>{group.letter}. {group.label}</h2>
              <p>{group.description}</p>
            </header>
            {visibleCards.filter((item) => item.card.group === group.id).map(renderCard)}
          </div>)}
          <p className="sfield-help settings-legend"><ApplyBadge apply="immediate" /> mentés után a worker ~10 mp-en belül ezzel számol · <ApplyBadge apply="new-positions" /> csak az ezután nyitott pozíciókra · <ApplyBadge apply="restart" /> szerverváltozó, worker újraindítás kell</p>
        </div>
      </div>

      {dirty ? <div className="settings-savebar" role="region" aria-label="Mentetlen módosítások">
        <span><strong>Mentetlen módosítások:</strong> {dirtySources.map((source) => SOURCE_LABELS[source]).join(', ')}{errors.length > 0 ? <span className="sfield-error"> · Javítandó: {errors[0]}{errors.length > 1 ? ` (+${errors.length - 1})` : ''}</span> : null}</span>
        <div className="settings-savebar-actions">
          <button type="button" className="secondary-button" onClick={discard} disabled={saving}><RotateCcw size={16} aria-hidden="true" /> Elvetés</button>
          <button type="button" className="primary-button" onClick={() => void save()} disabled={saving || errors.length > 0}><Save size={16} aria-hidden="true" /> {saving ? 'Mentés…' : 'Mentés'}</button>
        </div>
      </div> : null}
    </>
  );
}
