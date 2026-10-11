'use client';
/* eslint-disable @typescript-eslint/no-explicit-any */

import { FlaskConical } from 'lucide-react';
import { useState } from 'react';
import type { ReactNode } from 'react';

import { apiRequest, date, fmt, Status, useApi } from './components';

export type QualityGate = {
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

/** New Launch settings as returned by GET /api/settings/new-launch (editable fields + read-only context). */
export type NewLaunchSettings = Record<string, any> & {
  enabled: boolean;
  configVersion: string;
  qualityGate: QualityGate;
  paperOnlyNotice?: string;
  exitNotice?: string;
  qualityGateNotice?: string;
  providers?: Array<{ source: string; label: string; status: string; detail: string | null }>;
  mandatorySecurity?: string[];
  versions?: Array<{ version: string; parentVersion: string | null; note: string | null; createdAt: string; createdFromRecommendationId: string | null }>;
};

/** Response-only keys: never sent back on save. */
export const NEW_LAUNCH_READ_ONLY_KEYS = new Set(['paperOnlyNotice', 'exitNotice', 'qualityGateNotice', 'providers', 'mandatorySecurity', 'persisted', 'paperOnly', 'useAiConfirmation', 'versions', 'pendingRecommendations', 'tieredTakeProfitSupported', 'configVersion']);

/** Body for PUT /api/settings/new-launch: the whole editable draft (incl. fields not shown, so nothing is reset). */
export function newLaunchSaveBody(draft: NewLaunchSettings) {
  const { mode, minLaunchScore, minUniqueBuyers, minLiquidityUsd, minBuySellRatio, maxExhaustionScore, maxPriceImpactPercent, maxHolderConcentrationPercent, maxDevAllocationPercent, minDataQuality } = draft.qualityGate;
  return {
    ...Object.fromEntries(Object.entries(draft).filter(([key]) => !NEW_LAUNCH_READ_ONLY_KEYS.has(key))),
    qualityGate: { mode, minLaunchScore, minUniqueBuyers, minLiquidityUsd, minBuySellRatio, maxExhaustionScore, maxPriceImpactPercent, maxHolderConcentrationPercent, maxDevAllocationPercent, minDataQuality },
  };
}

export const SECURITY_LABELS: Record<string, string> = {
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

const SOCIAL_PROVIDER_STATE: Record<string, { tone: string; text: string }> = {
  CONNECTED: { tone: 'positive', text: 'KAPCSOLÓDVA' }, ACTIVE: { tone: 'positive', text: 'AKTÍV' }, CONNECTING: { tone: 'warning', text: 'KAPCSOLÓDIK' },
  RATE_LIMITED: { tone: 'warning', text: 'KORLÁTOZVA' }, DEGRADED: { tone: 'warning', text: 'GYENGE' }, DISCONNECTED: { tone: 'danger', text: 'NINCS KAPCSOLAT' },
  DISABLED: { tone: 'neutral', text: 'KI' }, NOT_CONFIGURED: { tone: 'neutral', text: 'NINCS BEÁLLÍTVA' },
};

/** Read-only social provider states (server-side configuration; no credential is ever sent to the browser). */
export function SocialProviderStatus() {
  const { data } = useApi<{ data: any }>('/api/social/status');
  const status = data?.data;
  const badge = (provider: any) => {
    if (!provider) return <Status tone="neutral">ISMERETLEN</Status>;
    const state = provider.enabled ? SOCIAL_PROVIDER_STATE[provider.state] ?? { tone: 'neutral', text: provider.state } : SOCIAL_PROVIDER_STATE.DISABLED;
    return <Status tone={state.tone}>{state.text}</Status>;
  };
  if (!status?.available) return <p className="sfield-help">Közösségi szolgáltatók: a worker még nem jelentett állapotot (nem fut, vagy a gyűjtés ki van kapcsolva).</p>;
  return <div className="status-list">
    <div className="status-row"><span>Telegram (MTProto)</span><span>{status.telegram?.enabled ? badge(status.telegram) : <Status tone="neutral">KI</Status>}</span></div>
    <div className="status-row"><span>X (Twitter)</span><span>{status.x?.enabled ? badge(status.x) : <Status tone="neutral">KI</Status>}</span></div>
    <div className="status-row"><span>AI közösségi elemzés (szerver)</span><span><Status tone="neutral">{status.aiEnabled ? 'BE' : 'KI'}</Status></span></div>
    <div className="status-row"><span>Mód</span><span><Status tone="info">CSAK MÉRÉS</Status></span></div>
  </div>;
}

const CONFIDENCE: Record<string, { label: string; tone: string }> = { LOW: { label: 'ALACSONY', tone: 'warning' }, MEDIUM: { label: 'KÖZEPES', tone: 'info' }, HIGH: { label: 'MAGAS', tone: 'positive' } };

/** Experimental PAPER setting recommendations from closed New Launch trades (never applied automatically). */
export function NewLaunchRecommendations({ onChanged, setMessage }: { onChanged: () => void; setMessage: (message: string) => void }) {
  const { data, refresh } = useApi<{ data: { latestRun: any; recommendations: any[] } }>('/api/new-launch/optimizer');
  const [running, setRunning] = useState(false);
  const optimizer = data?.data;
  const run = optimizer?.latestRun;
  const insufficient = run?.status === 'COMPLETED' && run?.result?.entry?.sufficientData === false;
  const runOptimizer = async () => {
    setRunning(true);
    setMessage('Elemzés indítása… (a háttérben fut, néhány másodperc)');
    try {
      await apiRequest('/api/new-launch/optimizer/run', { method: 'POST', body: JSON.stringify({ version: 'current', sample: 'all' }) });
      for (let attempt = 0; attempt < 30; attempt += 1) {
        await new Promise((resolve) => globalThis.setTimeout(resolve, 2000));
        const state = await apiRequest<{ data: { latestRun: any } }>('/api/new-launch/optimizer');
        if (state.data.latestRun?.status !== 'RUNNING') break;
      }
      refresh();
      setMessage('Az elemzés elkészült.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Az elemzés indítása sikertelen');
    } finally {
      setRunning(false);
    }
  };
  const accept = async (recommendation: any) => {
    const label = RECOMMENDATION_PARAMETER_LABELS[recommendation.parameter] ?? recommendation.parameter;
    if (!globalThis.confirm(`Új PAPER kísérlet létrehozása: ${label} ${fmt(recommendation.currentValue)} → ${fmt(recommendation.suggestedValue)}.\n\nEz új konfiguráció-verziót hoz létre (csak PAPER). A korábbi kereskedések és a nyitott pozíciók nem változnak. Folytatod?`)) return;
    try {
      const response = await apiRequest<{ data: { configVersion: string } }>(`/api/new-launch/recommendations/${recommendation.id}/accept`, { method: 'POST', body: '{}' });
      setMessage(`PAPER kísérlet létrehozva: ${response.data.configVersion}.`);
      refresh();
      onChanged();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'A kísérlet létrehozása sikertelen');
    }
  };
  const dismiss = async (id: string) => {
    await apiRequest(`/api/new-launch/recommendations/${id}/dismiss`, { method: 'POST', body: '{}' }).catch(() => undefined);
    refresh();
  };
  return <>
    <div className="card-toolbar">
      <p className="sfield-help">Historikus szimuláció, nem jövőbeli teljesítmény. Tanuló szakasz (70%) → változatlan értékkel validálás a későbbi 30%-on.{run?.completedAt ? ` Utolsó elemzés: ${date(run.completedAt)} (${run.sampleSize} trade).` : ''}</p>
      <button type="button" className="secondary-button" onClick={() => void runOptimizer()} disabled={running || run?.status === 'RUNNING'}><FlaskConical size={16} aria-hidden="true" /> {running || run?.status === 'RUNNING' ? 'Elemzés fut…' : 'Elemzés futtatása'}</button>
    </div>
    {insufficient ? <p className="settings-warning">Nincs elegendő adat megbízható javaslathoz (minimum {run.result.entry.minimumSampleSize} lezárt trade kell az aktuális konfiguráció-verzióban).</p> : null}
    {run?.status === 'FAILED' ? <p className="settings-warning">Az elemzés sikertelen: {run.error}</p> : null}
    {(optimizer?.recommendations ?? []).length === 0 && !insufficient ? <p className="sfield-help">{run ? 'Jelenleg nincs függőben lévő javaslat.' : 'Még nem futott elemzés.'}</p> : null}
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
  </>;
}

/** Immutable configuration version history of New Launch. */
export function NewLaunchVersions({ settings }: { settings: NewLaunchSettings }): ReactNode {
  const versions = settings.versions ?? [];
  if (versions.length === 0) return <p className="sfield-help">Az első mentéskor jön létre a verziótörténet (jelenleg: {settings.configVersion}).</p>;
  return <ul className="version-list">
    {versions.map((version) => <li key={version.version}>
      <span className="version-badge">{version.version}</span>
      <span>{version.parentVersion ? `← ${version.parentVersion}` : 'kezdeti'}</span>
      <span className="sfield-help">{version.note ?? (version.createdFromRecommendationId ? 'Javaslatból' : 'Beállítás módosítás')}</span>
      <time>{date(version.createdAt)}</time>
    </li>)}
  </ul>;
}
