'use client';
/* eslint-disable @typescript-eslint/no-explicit-any */

import { ChevronDown, FlaskConical } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Fragment, useState } from 'react';
import type { ReactNode } from 'react';

import { apiRequest, DataTable, date, EmptyState, ErrorState, fmt, formatPrice, LoadingState, Metric, Panel, Stacked, Status, useApi } from './components';
import { RECOMMENDATION_PARAMETER_LABELS } from './new-launch-settings-panel';

const TABS = [['overview', 'Áttekintés'], ['entry', 'Belépés'], ['exit', 'Kilépés'], ['quality', 'Launch minőség'], ['execution', 'Végrehajtás'], ['capacity', 'Likviditás / Kapacitás'], ['social', 'Közösségi'], ['optimizer', 'Optimalizáló']] as const;
type Tab = (typeof TABS)[number][0];

export const EXIT_LABELS: Record<string, string> = { BREAK_EVEN_STOP: 'Break-even stop', STOP_LOSS: 'Stop Loss', TAKE_PROFIT: 'Take Profit', TRAILING_STOP: 'Követő stop', BREAK_EVEN: 'Break-even stop', LIQUIDITY_SAFETY: 'Likviditás-védelem', MAX_HOLD_TIME: 'Max. tartási idő', MANUAL: 'Kézi zárás', OTHER: 'Egyéb' };
const DIAGNOSIS: Record<string, { label: string; tone: string; help: string }> = {
  POOR_ENTRY: { label: 'Gyenge belépés?', tone: 'danger', help: 'Az MFE +3% alatt maradt, és gyorsan jött a nagy MAE / stop loss.' },
  GOOD_ENTRY_BAD_EXIT: { label: 'Jó belépés, rossz kilépés?', tone: 'warning', help: 'Legalább +10%-ot elért, mégis veszteséggel zárt.' },
  NORMAL_LOSS: { label: 'Normál veszteség', tone: 'neutral', help: 'Egyik jellegzetes mintába sem illik.' },
  SUCCESSFUL_EXIT: { label: 'Sikeres kilépés', tone: 'positive', help: 'Nyereséggel zárt, az MFE legalább 30%-át megtartva.' },
  UNCLASSIFIED: { label: 'Nem besorolható', tone: 'neutral', help: 'Nincs elég árfolyam-adat, vagy nyerő, de az MFE nagy részét visszaadta.' },
};
const METRIC_LABELS: Record<string, string> = {
  launchScore: 'Launch Score', launchMomentumScore: 'Momentum', exhaustionScore: 'Kifáradás', tokenAgeSeconds: 'Token életkor (mp)', liquidityUsd: 'Likviditás ($)', uniqueBuyers: 'Egyedi vásárlók',
  buySellRatio: 'Vétel/eladás arány', buyVolumeRatio: 'Vételi volumen arány', priceImpactPercent: 'Árhatás (%)', holderConcentrationPercent: 'Holder koncentráció (%)', devAllocationPercent: 'Dev allokáció (%)',
  entryLatencyMs: 'Belépési késés (ms)', riskScore: 'Kockázati pontszám', mfePercent: 'MFE (%)', maePercent: 'MAE (%)', holdMs: 'Tartási idő (ms)',
};
const REJECTION_LABELS: Record<string, string> = {
  LOW_LIQUIDITY: 'Alacsony likviditás', HIGH_PRICE_IMPACT: 'Nagy árhatás', SELLABILITY_UNKNOWN: 'Eladhatóság ismeretlen', SELLABILITY_FAILED: 'Eladhatóság sikertelen', MINT_AUTHORITY: 'Mint authority', FREEZE_AUTHORITY: 'Freeze authority',
  HOLDER_CONCENTRATION: 'Holder koncentráció', DEV_ALLOCATION: 'Dev allokáció / eladás', HIGH_EXHAUSTION: 'Kifáradt pump', LOW_UNIQUE_BUYERS: 'Kevés egyedi vásárló', LOW_BUY_SELL_RATIO: 'Alacsony vétel/eladás arány',
  LOW_LAUNCH_SCORE: 'Alacsony Launch Score', HIGH_RISK: 'Magas kockázat', DUPLICATE_POSITION: 'Duplikált pozíció', EXPIRED_LAUNCH: 'Lejárt launch-ablak', INSUFFICIENT_DATA: 'Kevés adat / még figyelés', LOW_LAUNCH_VOLUME: 'Alacsony launch forgalom',
  TOKEN_EXTENSION: 'Token-2022 korlátozás', HIGH_LIQUIDITY: 'Túl magas likviditás', QUALITY_GATE: 'Minőségi szűrő',
};
const FUNNEL_LABELS: Record<string, string> = { detected: 'Észlelve', ageEligible: 'Életkor rendben', liquidityEligible: 'Likviditás rendben', securityPassed: 'Biztonság rendben', devNotSelling: 'Dev nem ad el', sellabilityVerified: 'Eladhatóság igazolva', observationCompleted: 'Megfigyelés kész', launchScorePassed: 'Launch Score rendben', riskApproved: 'Kockázat jóváhagyva', paperBuy: 'PAPER vétel', winner: 'Nyerő' };

export const ANOMALY_LABELS: Record<string, string> = {
  BREAK_EVEN_LARGE_NEGATIVE_EXIT: 'Break-even stop nagy veszteséggel', TRAILING_EXIT_BELOW_EXPECTED: 'Követő stop a várt szint alatt', LARGE_TRIGGER_FILL_GAP: 'Nagy rés trigger és kitöltés között',
  EXIT_DATA_STALE: 'Elavult piaci adat a kilépéskor', HIGH_EXIT_LATENCY: 'Lassú kilépés-végrehajtás', LIQUIDITY_COLLAPSE_EXIT: 'Likviditás-összeomlás', MISLABELED_EXIT_REASON: 'Hibásan címkézett kilépési ok',
  MFE_BELOW_REALIZED_RETURN: 'MFE kisebb a realizált hozamnál', MAE_ABOVE_REALIZED_RETURN: 'MAE nagyobb a realizált hozamnál',
};
export const CAUSE_LABELS: Record<string, string> = {
  ENTRY_QUALITY: 'Belépési minőség', EXIT_POLICY: 'Kilépési szabály', EXECUTION_QUALITY: 'Végrehajtás (késés / ritka kiértékelés)', LIQUIDITY_COLLAPSE: 'Likviditás-összeomlás',
  IMPLEMENTATION_ANOMALY: 'Implementációs anomália', MARKET_MOVE: 'Piaci mozgás (gap)', INSUFFICIENT_DATA: 'Nincs elég adat',
};
export const QUALITY_LABELS: Record<string, { label: string; tone: string }> = {
  GOOD_EXIT: { label: 'Jó kilépés', tone: 'positive' },
  NORMAL_MARKET_GIVEBACK: { label: 'Normál piaci visszaesés', tone: 'neutral' },
  SLOW_DETECTION: { label: 'Lassú észlelés', tone: 'danger' },
  SLOW_EXECUTION: { label: 'Lassú végrehajtás', tone: 'danger' },
  HIGH_SLIPPAGE: { label: 'Nagy csúszás (ár elment a trigger után)', tone: 'warning' },
  HIGH_PRICE_IMPACT: { label: 'Nagy árhatás', tone: 'warning' },
  LIQUIDITY_COLLAPSE: { label: 'Likviditás-összeomlás', tone: 'danger' },
  STALE_MARKET_DATA: { label: 'Elavult piaci adat', tone: 'warning' },
  MISSED_TP_TOUCH: { label: 'TP elérve, de nem lett elkapva', tone: 'warning' },
  EXIT_ENGINE_ANOMALY: { label: 'Exit Engine anomália', tone: 'danger' },
  INSUFFICIENT_DATA: { label: 'Nincs elég adat', tone: 'neutral' },
};
const msShort = (value: number | null | undefined) => (value == null ? '—' : Math.abs(value) < 1 ? `${(value * 1000).toFixed(0)} µs` : Math.abs(value) < 1000 ? `${fmt(value, value < 10 ? 2 : 0)} ms` : `${fmt(value / 1000, 1)} mp`);

const EXECUTION_REJECTION_LABELS: Record<string, string> = { NEW_LAUNCH_ALREADY_TRADED: 'Már kereskedett token', MAX_OPEN_POSITIONS: 'Max. nyitott pozíció', DAILY_LOSS_LIMIT: 'Napi veszteséglimit', INSUFFICIENT_BALANCE: 'Nincs elég egyenleg' };
const EXPIRY_LABELS: Record<string, string> = {
  DETECTED_TOO_LATE_OR_NO_PRIOR_DECISION: 'Későn észlelve / nincs korábbi döntés', OBSERVATION_NOT_FINISHED: 'Megfigyelés nem fejeződött be', SECURITY_OR_RISK_DATA_PENDING: 'Biztonsági / kockázati adat függőben',
  SELLABILITY_NOT_VERIFIED: 'Eladhatóság nem igazolt', LIQUIDITY_NEVER_REACHED_MINIMUM: 'Likviditás nem érte el a minimumot', ACTIVITY_TOO_LOW: 'Túl alacsony aktivitás', LAUNCH_SCORE_TOO_LOW: 'Launch Score túl alacsony', OTHER: 'Egyéb',
};
const PIPELINE_LABELS: Record<string, string> = {
  detectionToCandidateMs: 'Észlelés → első döntés', detectionToSecurityMs: 'Észlelés → biztonsági ellenőrzés', observationDurationMs: 'Megfigyelés hossza', observationToDecisionMs: 'Megfigyelés vége → döntés',
  decisionToOrderMs: 'Döntés → megbízás', orderToFillMs: 'Megbízás → kitöltés', detectionToFillMs: 'Észlelés → kitöltés',
};

const priceOrDash = (value: number | null | undefined) => (value == null ? '—' : formatPrice(value));
const usd = (value: number | null | undefined, signed = false) => (value == null ? '—' : `${signed && value > 0 ? '+' : ''}${fmt(value)} USDC`);
const pct = (value: number | null | undefined, digits = 1) => (value == null ? '—' : `${value > 0 ? '+' : ''}${fmt(value, digits)}%`);
const tone = (value: number | null | undefined) => (value == null || value === 0 ? '' : value > 0 ? 'positive-value' : 'negative-value');
const duration = (msValue: number | null | undefined) => {
  if (msValue == null) return '—';
  if (Math.abs(msValue) < 1000) return `${Math.round(msValue)} ms`;
  const seconds = Math.round(msValue / 1000);
  if (seconds < 90) return `${seconds} mp`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} perc`;
  return `${fmt(seconds / 3600, 1)} óra`;
};

function PerfTable({ rows, first }: { rows: any[] | undefined; first: string }) {
  if (!rows?.length) return <EmptyState message="Nincs adat." />;
  return <DataTable wide headers={[first, 'Trade', 'Nyerési arány', 'Nettó P&L', 'Profit faktor', 'Várható érték', 'Átl. nyerő', 'Átl. vesztes', 'Átl. MFE', 'Átl. MAE', 'Visszaesés']}>
    {rows.map((row) => <tr key={row.label ?? row.group ?? row.version}>
      <td><strong>{row.label ?? EXIT_LABELS[row.group] ?? row.group ?? row.version}</strong></td>
      <td>{row.trades}{row.trades < 20 ? <span className="sample-note"> · kis minta</span> : null}</td>
      <td>{row.winRate == null ? '—' : `${fmt(row.winRate, 0)}%`}</td>
      <td className={tone(row.netPnl)}>{usd(row.netPnl, true)}</td>
      <td>{row.profitFactor == null ? '—' : fmt(row.profitFactor)}</td>
      <td className={tone(row.expectancy)}>{row.expectancy == null ? '—' : fmt(row.expectancy, 3)}</td>
      <td>{row.averageWinner == null ? '—' : fmt(row.averageWinner)}</td>
      <td>{row.averageLoser == null ? '—' : fmt(row.averageLoser)}</td>
      <td>{pct(row.averageMfePercent)}</td>
      <td>{pct(row.averageMaePercent)}</td>
      <td>{fmt(row.maxDrawdown)}</td>
    </tr>)}
  </DataTable>;
}

function Section({ title, description, children, action }: { title: string; description?: ReactNode; children: ReactNode; action?: ReactNode }) {
  return <Panel title={title} description={description} action={action}>{children}</Panel>;
}

function TradeFacts({ trade }: { trade: any }) {
  const facts: string[] = [];
  const f = trade.facts ?? {};
  if (trade.mfePercent != null) facts.push(trade.mfePercent < 3 ? `Soha nem ment +${fmt(trade.mfePercent, 1)}% fölé` : `Elérte a +${fmt(trade.mfePercent, 1)}%-ot`);
  if (trade.exitGroup === 'STOP_LOSS' && f.timeToExitMs != null) facts.push(`Stop loss ${duration(f.timeToExitMs)} után`);
  if (f.liquidityChangePercent != null) facts.push(`Likviditás ${pct(f.liquidityChangePercent, 0)}`);
  if (f.entryBuySellRatio != null && f.exitBuySellRatio != null) facts.push(`Vétel/eladás arány ${fmt(f.entryBuySellRatio, 1)} → ${fmt(f.exitBuySellRatio, 1)}`);
  if (trade.mfePercent != null && trade.mfePercent >= 10) facts.push(f.trailingActive ? 'A követő stop aktív volt' : 'A követő stop még nem aktiválódott');
  if (f.breakEvenActive) facts.push('Break-even aktiválódott');
  if (trade.givebackPercent != null && trade.givebackPercent > 0) facts.push(`${fmt(trade.givebackPercent, 1)} százalékpontot adott vissza a csúcsról`);
  if (trade.mfePercent == null) facts.push('Nincs elég tárolt árfolyam-adat (MFE/MAE ismeretlen)');
  const diagnosis = DIAGNOSIS[trade.diagnosis] ?? DIAGNOSIS.UNCLASSIFIED;
  return <div className="trade-facts">
    <Status tone={diagnosis.tone}>{diagnosis.label}</Status>
    <ul>{facts.map((fact) => <li key={fact}>{fact}</li>)}</ul>
    <small>Diagnosztikai becslés, nem bizonyosság. {diagnosis.help}</small>
  </div>;
}

function ExitGrid({ grid, metric }: { grid: any; metric: string }) {
  if (!grid?.cells?.length) return <EmptyState message="Nincs szimulálható adat." />;
  const value = (cell: any) => {
    if (!cell.stats) return null;
    if (metric === 'trades') return cell.resolved;
    return cell.stats[metric];
  };
  const format = (cell: any) => {
    const v = value(cell);
    if (v == null) return '—';
    if (metric === 'netPnl') return usd(v, true);
    if (metric === 'winRate') return `${fmt(v, 0)}%`;
    if (metric === 'trades') return String(v);
    return fmt(v, metric === 'expectancy' ? 3 : 2);
  };
  return <div className="table-scroll"><table className="grid-table">
    <thead><tr><th scope="col">{grid.xLabel} ↓ / {grid.yLabel} →</th>{grid.ys.map((y: number) => <th key={y} scope="col">{y}%</th>)}</tr></thead>
    <tbody>{grid.xs.map((x: number) => <tr key={x}><th scope="row">{x}%</th>{grid.ys.map((y: number) => {
      const cell = grid.cells.find((item: any) => item.x === x && item.y === y);
      return <td key={y} title={`Feloldott: ${cell?.resolved ?? 0} · bizonytalan sorrend: ${cell?.ambiguous ?? 0} · kevés adat: ${(cell?.lowResolution ?? 0) + (cell?.noExitInData ?? 0)}`}><strong className={metric === 'netPnl' || metric === 'expectancy' ? tone(value(cell ?? {})) : ''}>{cell ? format(cell) : '—'}</strong><small>{cell?.resolved ?? 0} feloldott · {cell?.ambiguous ?? 0} bizonytalan</small>{cell?.badExitsEvaluated ? <small>GEBE javul: {cell.improvedBadExits}/{cell.badExitsEvaluated}</small> : null}{cell?.winnersEvaluated ? <small>nyerő romlik: {cell.worsenedWinners}/{cell.winnersEvaluated}</small> : null}</td>;
    })}</tr>)}</tbody>
  </table></div>;
}

function ForensicTable({ rows, empty }: { rows: any[] | undefined; empty: string }) {
  if (!rows?.length) return <EmptyState message={empty} />;
  return <DataTable wide headers={['Token', 'MFE → végső', 'Visszaadott', 'Break-even', 'Követő stop', 'Védő stop', 'Trigger → kitöltés', 'Rés', 'Kiért. rés', 'Likviditás', 'Rögzített → tényleges ok', 'Fő ok', 'Kilépés minősége', 'Anomáliák']}>
    {rows.map((row) => <tr key={row.id}>
      <td>{row.positionId ? <Link href={`/positions/${row.positionId}`}><strong>{row.symbol}</strong></Link> : <strong>{row.symbol}</strong>}<small className="sfield-help" style={{ display: 'block' }}>{date(row.closedAt)}</small></td>
      <td><Stacked top={pct(row.mfePercent)} bottom={`→ ${pct(row.realizedReturnPercent)}`} /></td>
      <td>{row.givebackPercentagePoints == null ? '—' : `${fmt(row.givebackPercentagePoints, 1)} pp`}</td>
      <td>{row.breakEvenActivated ? <Stacked top="igen" bottom={row.breakEvenActivatedAt ? date(row.breakEvenActivatedAt) : ''} /> : 'nem'}</td>
      <td>{row.trailingActivated ? <Stacked top="igen" bottom={row.trailingActivatedAt ? date(row.trailingActivatedAt) : ''} /> : 'nem'}</td>
      <td>{row.effectiveStop ? <Stacked top={priceOrDash(row.effectiveStop.price)} bottom={({ TRAILING: 'követő', BREAK_EVEN: 'break-even', BASE_STOP_LOSS: 'alap SL' } as Record<string, string>)[row.effectiveStop.source] ?? row.effectiveStop.source ?? ''} /> : '—'}</td>
      <td><Stacked top={priceOrDash(row.triggerPrice)} bottom={`→ ${priceOrDash(row.fillPrice)}`} /></td>
      <td className={row.triggerGapPercent != null && row.triggerGapPercent < -5 ? 'negative-value' : ''}>{pct(row.triggerGapPercent, 1)}</td>
      <td>{duration(row.evaluationGapMs)}</td>
      <td>{pct(row.liquidityChangePercent, 0)}</td>
      <td>{EXIT_LABELS[row.recordedReason] ?? row.recordedReason ?? '—'}{row.effectiveReason && row.effectiveReason !== row.recordedReason ? <> → <strong>{EXIT_LABELS[row.effectiveReason] ?? row.effectiveReason}</strong></> : null}</td>
      <td><Status tone={row.primaryCause === 'INSUFFICIENT_DATA' ? 'neutral' : row.primaryCause === 'IMPLEMENTATION_ANOMALY' || row.primaryCause === 'EXECUTION_QUALITY' ? 'danger' : 'warning'}>{CAUSE_LABELS[row.primaryCause] ?? row.primaryCause}</Status>{row.pathDataQuality === 'INSUFFICIENT_PRICE_PATH_DATA' ? <small className="sfield-help" style={{ display: 'block' }}>INSUFFICIENT_PRICE_PATH_DATA</small> : null}</td>
      <td>{((row.exitQuality ?? []) as string[]).map((item) => <Status key={item} tone={QUALITY_LABELS[item]?.tone ?? 'neutral'}>{QUALITY_LABELS[item]?.label ?? item}</Status>)}</td>
      <td>{(row.anomalies ?? []).length ? (row.anomalies as string[]).map((item) => ANOMALY_LABELS[item] ?? item).join(', ') : '—'}</td>
    </tr>)}
  </DataTable>;
}

function ExitSpeedSection({ speed }: { speed: any }) {
  if (!speed) return null;
  const row = (label: string, value: any) => <tr key={label}><td>{label}</td><td>{msShort(value?.median)}</td><td>{msShort(value?.p95)}</td><td>{value?.count ?? 0}</td></tr>;
  const tp = speed.tpCapture ?? {};
  return <Section title="Exit speed" description={`${speed.instrumentedTrades} / ${speed.closedTrades} lezárt trade-nél van mért kilépési időzítés (a korábbiaknál nincs – nem becsüljük). Az érintés (touch) nem azonos a kitöltéssel.`}>
    <div className="metric-grid">
      <Metric label="Lezárt trade" value={speed.closedTrades} />
      <Metric label="TP érintés" value={speed.touches?.TAKE_PROFIT ?? 0} />
      <Metric label="SL érintés" value={speed.touches?.STOP_LOSS ?? 0} />
      <Metric label="Break-even érintés" value={speed.touches?.BREAK_EVEN_STOP ?? 0} />
      <Metric label="Követő stop érintés" value={speed.touches?.TRAILING_STOP ?? 0} />
    </div>
    <DataTable headers={['Szakasz', 'Medián', 'P95', 'n']}>
      {row('Piaci esemény → kiértékelés', speed.marketEventToEvaluationMs)}
      {row('Kiértékelés időtartama', speed.exitEvaluationDurationMs)}
      {row('Trigger → végrehajtási kérés', speed.triggerToExecutionRequestMs)}
      {row('Végrehajtási kérés → kitöltés', speed.executionRequestToFillMs)}
      {row('Trigger → kitöltés', speed.triggerToFillMs)}
      {row('Piaci esemény → kitöltés', speed.marketEventToFillMs)}
    </DataTable>
    <div className="panel-grid" style={{ marginTop: 16 }}>
      <div>
        <strong className="analysis-subtitle">Ár romlása a trigger és a kitöltés között</strong>
        <div className="metric-grid">
          <Metric label="Trigger → kitöltés (átlag / medián)" value={`${pct(speed.triggerToFillDeterioration?.average, 2)} / ${pct(speed.triggerToFillDeterioration?.median, 2)}`} note={`P95 legrosszabb: ${pct(speed.triggerToFillDeterioration?.p95Adverse, 2)} · n = ${speed.triggerToFillDeterioration?.count ?? 0}`} />
          <Metric label="TP érintés → kitöltés (átlag / medián)" value={`${pct(speed.tpTouchToFillDeterioration?.average, 2)} / ${pct(speed.tpTouchToFillDeterioration?.median, 2)}`} note={`n = ${speed.tpTouchToFillDeterioration?.count ?? 0}`} />
        </div>
      </div>
      <div>
        <strong className="analysis-subtitle">TP elérve vs. TP elkapva</strong>
        <DataTable headers={['Kategória', 'Trade']}>
          <tr><td>TP elérve (rögzített érintés / csak árfolyam-útból)</td><td>{tp.reached ?? 0} ({tp.touchRecorded ?? 0} / {tp.reachedByPathOnly ?? 0})</td></tr>
          <tr><td>TP elérve és ≥ TP áron zárt</td><td className="positive-value">{tp.exitedAtOrAboveTp ?? 0}</td></tr>
          <tr><td>TP elérve, de TP alatt zárt</td><td className={tp.exitedBelowTp ? 'negative-value' : ''}>{tp.exitedBelowTp ?? 0}</td></tr>
          <tr><td>TP elérve, végül veszteséggel zárt</td><td className={tp.closedNegative ? 'negative-value' : ''}>{tp.closedNegative ?? 0}</td></tr>
        </DataTable>
      </div>
    </div>
    <div className="panel-grid" style={{ marginTop: 16 }}>
      <div>
        <strong className="analysis-subtitle">Visszaadott profit (MFE − realizált hozam)</strong>
        <div className="metric-grid">
          <Metric label="Medián" value={speed.profitGiveback?.p50 == null ? '—' : `${fmt(speed.profitGiveback.p50, 1)} pp`} />
          <Metric label="P75" value={speed.profitGiveback?.p75 == null ? '—' : `${fmt(speed.profitGiveback.p75, 1)} pp`} />
          <Metric label="P95" value={speed.profitGiveback?.p95 == null ? '—' : `${fmt(speed.profitGiveback.p95, 1)} pp`} note={`n = ${speed.profitGiveback?.count ?? 0}`} />
        </div>
      </div>
      <div>
        <strong className="analysis-subtitle">Kilépés minősége (egy trade több osztályba is eshet)</strong>
        <DataTable headers={['Besorolás', 'Trade']}>{Object.entries(speed.qualityCounts ?? {}).sort((x: any, y: any) => y[1] - x[1]).map(([key, count]) => <tr key={key}><td><Status tone={QUALITY_LABELS[key]?.tone ?? 'neutral'}>{QUALITY_LABELS[key]?.label ?? key}</Status></td><td>{String(count)}</td></tr>)}</DataTable>
      </div>
    </div>
  </Section>;
}

export const CAPACITY_CLASS_LABELS: Record<string, { label: string; tone: string }> = {
  EXCELLENT: { label: 'Kiváló', tone: 'positive' }, GOOD: { label: 'Jó', tone: 'positive' }, MODERATE: { label: 'Közepes', tone: 'warning' },
  POOR: { label: 'Gyenge', tone: 'danger' }, UNSAFE: { label: 'Nem biztonságos', tone: 'danger' }, UNKNOWN: { label: 'Ismeretlen', tone: 'neutral' },
};
export const CAPACITY_BASIS_LABELS: Record<string, string> = {
  EXECUTABLE_QUOTE: 'Végrehajtható ajánlat', ROUTE_SIMULATION: 'Útvonal-szimuláció', POOL_MODEL: 'Pool-modell (élő görbe-tartalékok)', LIQUIDITY_ESTIMATE: 'BECSLÉS likviditásból', INSUFFICIENT_DATA: 'Nincs elég adat',
};
/** Impacts are shown with precision matching their basis (an estimate never as 2.347%). */
export const impactText = (value: number | null | undefined, basis?: string | null) => (value == null ? '—' : basis === 'LIQUIDITY_ESTIMATE' ? `~${fmt(Math.round(value * 2) / 2, 1)}%` : `${fmt(value, 1)}%`);

function CapacitySection({ capacity }: { capacity: any }) {
  const [variant, setVariant] = useState<'UNCONSTRAINED' | 'CAPACITY_LIMITED'>('UNCONSTRAINED');
  if (!capacity) return <EmptyState message="Nincs adat." />;
  const e = capacity.entrySummary ?? {};
  const scenarios = (capacity.scenarios ?? []).filter((row: any) => row.variant === variant);
  const base = scenarios[0];
  return <>
    <Section title="Kilépési kapacitás" description="Kérdés: ha a teljes pozíciót azonnal el kellene adni, kijutnánk-e elfogadható árhatással? Ez végrehajthatóság, NEM előrejelzés arról, hogy a token emelkedik-e.">
      <div className="metric-grid">
        <Metric label="Belépési pillanatkép" value={`${e.tradesWithSnapshot ?? 0} trade`} note="Csak a kapacitás-motor bevezetése után nyitott trade-ekhez" />
        <Metric label="Átl. Exit Capacity Score" value={e.averageExitCapacityScore == null ? '—' : fmt(e.averageExitCapacityScore, 0)} />
        <Metric label="Belépési árhatás (medián)" value={pct(e.medianEntryImpactPct, 1)} />
        <Metric label="Teljes kilépési árhatás (medián / P95)" value={`${pct(e.medianFullExitImpactPct, 1)} / ${pct(e.p95FullExitImpactPct, 1)}`} />
        <Metric label="Csökkentett volna / tiltott volna" value={`${e.wouldReduce ?? 0} / ${e.wouldBlock ?? 0}`} note={e.averageRecommendedReductionPct == null ? undefined : `Átl. javasolt csökkentés: ${fmt(e.averageRecommendedReductionPct, 0)}%`} />
        <Metric label="Kapacitás-romlás / útvonal-vesztés belépés után" value={`${capacity.deteriorationEvents ?? 0} / ${capacity.routeLossEvents ?? 0}`} />
      </div>
      <p className="sfield-help">Mód: <strong>{e.enforcedTrades ? `${e.enforcedTrades} trade ENFORCE_PAPER módban` : 'MONITOR_ONLY – a javaslat nem változtatta a valós méretet (NL-v2 összehasonlítható marad)'}</strong>. Küszöbök: belépési hatás ≤ {capacity.config?.maxEntryImpactPct}%, teljes kilépési hatás ≤ {capacity.config?.maxExitImpactPct}%, oda-vissza ≤ {capacity.config?.maxRoundTripImpactPct}%, likviditás-kihasználtság ≤ {capacity.config?.maxLiquidityUtilizationPct}%.</p>
    </Section>
    <Section title="Tőke-skálázhatóság" description={<>HISTORICAL SIMULATION — NOT FUTURE PERFORMANCE. {capacity.replayAssumptions} Kalibráció a tényleges méreten: tényleges nettó {usd(capacity.calibration?.actualNetPnl, true)} vs. visszajátszott {usd(capacity.calibration?.replayNetPnl, true)} ({capacity.calibration?.trades ?? 0} trade).</>}
      action={<label className="inline-select">Változat<select value={variant} onChange={(event) => setVariant(event.target.value as typeof variant)}><option value="UNCONSTRAINED">Korlát nélkül</option><option value="CAPACITY_LIMITED">Kapacitás-korláttal</option></select></label>}>
      {!scenarios.length ? <EmptyState message="Nincs visszajátszható trade (hiányzó likviditás-adat)." /> : <DataTable wide headers={['Méret / trade', 'Végrehajtható', 'Csökkentve / elutasítva', 'Nettó P&L', 'Hozam a tőkén', 'Profit faktor', 'Várható érték', 'Max. visszaesés', 'Átl. vételi hatás', 'Átl. eladási hatás', 'Átl. oda-vissza költség']}>
        {scenarios.map((row: any) => <tr key={row.sizeUsd}>
          <td><strong>{fmt(row.sizeUsd, 0)} USDC</strong></td>
          <td>{row.tradesExecutable}{row.tradesWithoutData ? <small className="sfield-help"> · {row.tradesWithoutData} adat nélkül</small> : null}</td>
          <td>{row.tradesReduced} / {row.tradesRejected}</td>
          <td className={tone(row.netPnl)}>{usd(row.netPnl, true)}</td>
          <td className={tone(row.returnOnCapitalPct)}>{pct(row.returnOnCapitalPct, 2)}</td>
          <td>{row.profitFactor == null ? '—' : fmt(row.profitFactor)}</td>
          <td className={tone(row.expectancy)}>{row.expectancy == null ? '—' : fmt(row.expectancy, 2)}</td>
          <td>{fmt(row.maxDrawdown)}</td>
          <td>{impactText(row.averageBuyImpactPct, 'LIQUIDITY_ESTIMATE')}</td>
          <td>{impactText(row.averageSellImpactPct, 'LIQUIDITY_ESTIMATE')}</td>
          <td>{impactText(row.averageRoundTripCostPct, 'LIQUIDITY_ESTIMATE')}</td>
        </tr>)}
      </DataTable>}
      {base ? <p className="sfield-help">A hozam a tőkén (nettó P&L / befektetett USDC) mutatja, mennyi marad meg a profitból nagyobb méretnél – a P&L-t nem szabad egyszerűen a tőkével felszorozni. A dinamikus méretezés nem garantál nagyobb profitot: a célja a reálisabb méret és a kisebb végrehajtási kockázat.</p> : null}
    </Section>
    <section className="panel-grid">
      <Section title="Kapacitás vs. eredmény" description="Csoportosítás a belépéskori biztonságos méret szerint (végrehajthatóság, nem irány)">
        <DataTable headers={['Kapacitás', 'Trade', 'Nyerési arány', 'PF', 'Várható érték', 'Átl. MFE', 'Átl. MAE']}>{(capacity.capacityVsOutcome ?? []).map((row: any) => <tr key={row.bucket}><td>{row.bucket}</td><td>{row.trades}{row.trades < 20 ? <span className="sample-note"> · kis minta</span> : null}</td><td>{row.winRate == null ? '—' : `${fmt(row.winRate, 0)}%`}</td><td>{row.profitFactor == null ? '—' : fmt(row.profitFactor)}</td><td className={tone(row.expectancy)}>{row.expectancy == null ? '—' : fmt(row.expectancy, 2)}</td><td>{pct(row.averageMfePercent)}</td><td>{pct(row.averageMaePercent)}</td></tr>)}</DataTable>
      </Section>
      <Section title="Részleges kilépés (szimuláció)" description="100% egyszerre vs. 2 × 50% vs. 4 × 25% (3 mp-enként), időrendben, csak a trigger után tárolt árakból. Nem kapcsol be részleges eladást.">
        {capacity.partialExit?.evaluated ? <div className="metric-grid">
          <Metric label="Kiértékelt trade" value={capacity.partialExit.evaluated} note={`${capacity.partialExit.insufficientData} trade-nél nincs elég adat`} />
          <Metric label="2 × 50% vs. 100%" value={pct((capacity.partialExit.halves / capacity.partialExit.full - 1) * 100, 2)} />
          <Metric label="4 × 25% vs. 100%" value={pct((capacity.partialExit.quarters / capacity.partialExit.full - 1) * 100, 2)} />
        </div> : <EmptyState message="Nincs elég tárolt árfolyam-adat a trigger után." />}
      </Section>
    </section>
    <Section title="Maximális biztonságos pozíció trade-enként" description="A belépéskori pillanatképből, régebbi trade-eknél a tárolt belépési likviditásból (BECSLÉS)">
      {(capacity.perTrade ?? []).length === 0 ? <EmptyState message="Nincs adat." /> : <DataTable wide headers={['Token', 'Tényleges méret', 'Max. biztonságos', 'Alap', 'Korlát', 'Likviditás belépés → kilépés', 'Kapacitás a triggerkor', 'Nettó P&L']}>
        {capacity.perTrade.slice().reverse().slice(0, 60).map((row: any) => <tr key={row.id}>
          <td>{row.positionId ? <Link href={`/positions/${row.positionId}`}><strong>{row.symbol}</strong></Link> : row.symbol}<small className="sfield-help" style={{ display: 'block' }}>{date(row.closedAt)}</small></td>
          <td>{usd(row.actualSize)}</td>
          <td>{row.maxSafePositionAtEntry == null ? '—' : `${row.maxSafeBasis === 'LIQUIDITY_ESTIMATE' ? '~' : ''}${fmt(row.maxSafePositionAtEntry, 0)} USDC`}</td>
          <td><small>{CAPACITY_BASIS_LABELS[row.maxSafeBasis] ?? row.maxSafeBasis}</small></td>
          <td><small>{row.bindingConstraint ?? '—'}</small></td>
          <td>{row.liquidityAtEntry == null ? '—' : `$${fmt(row.liquidityAtEntry, 0)}`} → {row.liquidityAtExit == null ? '—' : `$${fmt(row.liquidityAtExit, 0)}`}</td>
          <td>{row.exitCapacityAtTrigger ? <Status tone={CAPACITY_CLASS_LABELS[row.exitCapacityAtTrigger.classification]?.tone ?? 'neutral'}>{CAPACITY_CLASS_LABELS[row.exitCapacityAtTrigger.classification]?.label ?? row.exitCapacityAtTrigger.classification}</Status> : '—'}</td>
          <td className={tone(row.netPnl)}>{usd(row.netPnl, true)}</td>
        </tr>)}
      </DataTable>}
    </Section>
  </>;
}

const SOCIAL_KEY_LABELS: Record<string, string> = {
  UNKNOWN: 'Nincs adat', RISING: 'Emelkedő', FLAT: 'Stagnáló', FALLING: 'Csökkenő', LOW: 'Alacsony', MEDIUM: 'Közepes', HIGH: 'Magas',
  STRONG_CONFIRMATION: 'Erős megerősítés', MODERATE_CONFIRMATION: 'Mérsékelt megerősítés', SOCIAL_LEADING: 'Közösségi vezet', ONCHAIN_LEADING: 'On-chain vezet',
  DIVERGENCE: 'Eltérés', SOCIAL_ONLY_HYPE: 'Csak közösségi hype', WEAK_ACTIVITY: 'Gyenge aktivitás', TELEGRAM_LEADING: 'Telegram vezet',
  TELEGRAM_DATA_NOT_AVAILABLE: 'Nincs Telegram-adat', 'TG LOW': 'TG alacsony', 'TG MEDIUM': 'TG közepes', 'TG HIGH': 'TG magas',
};

const TELEGRAM_STATE: Record<string, { tone: string; text: string }> = {
  CONNECTED: { tone: 'positive', text: 'KAPCSOLÓDVA' }, CONNECTING: { tone: 'warning', text: 'KAPCSOLÓDIK' }, DISCONNECTED: { tone: 'danger', text: 'NINCS KAPCSOLAT' },
  RATE_LIMITED: { tone: 'warning', text: 'KORLÁTOZVA (FLOOD_WAIT)' }, DEGRADED: { tone: 'warning', text: 'GYENGE' }, DISABLED: { tone: 'neutral', text: 'KIKAPCSOLVA' },
  NOT_CONFIGURED: { tone: 'neutral', text: 'NINCS BEÁLLÍTVA' }, ACTIVE: { tone: 'positive', text: 'AKTÍV' },
};

function TelegramStatsTable({ rows, first }: { rows: any[] | undefined; first: string }) {
  if (!rows?.length) return <EmptyState message="Nincs adat." />;
  return <DataTable wide headers={[first, 'Trade', 'Nyerő / vesztes', 'Nyerési arány', 'Nettó P&L', 'PF', 'Várható érték', 'Átl. MFE', 'Átl. MAE']}>
    {rows.map((row) => <tr key={row.key}>
      <td><strong>{SOCIAL_KEY_LABELS[row.key] ?? row.key.split(' × ').map((part: string) => SOCIAL_KEY_LABELS[part] ?? part).join(' × ')}</strong></td>
      <td>{row.trades}{row.trades > 0 && row.trades < 20 ? <span className="sample-note"> · kis minta</span> : null}</td>
      <td>{row.wins} / {row.losses}</td>
      <td>{row.winRate == null ? '—' : `${fmt(row.winRate, 0)}%`}</td>
      <td className={tone(row.netPnl)}>{row.trades ? usd(row.netPnl, true) : '—'}</td>
      <td>{row.profitFactor == null ? '—' : fmt(row.profitFactor)}</td>
      <td className={tone(row.expectancy)}>{row.expectancy == null ? '—' : fmt(row.expectancy, 2)}</td>
      <td>{pct(row.averageMfePercent)}</td>
      <td>{pct(row.averageMaePercent)}</td>
    </tr>)}
  </DataTable>;
}

/** Telegram-only analytics (MONITOR_ONLY): features frozen at entry; older trades = TELEGRAM_DATA_NOT_AVAILABLE. */
function TelegramSection({ telegram }: { telegram: any }) {
  if (!telegram) return null;
  const o = telegram.overview ?? {};
  const state = TELEGRAM_STATE[o.state] ?? { tone: 'neutral', text: o.state ?? 'ISMERETLEN' };
  const noData = telegram.dataStatus === 'TELEGRAM_DATA_NOT_AVAILABLE';
  const val = (value: number | null | undefined, digits = 0) => (value == null ? '—' : fmt(value, digits));
  return <>
    <Section title="Telegram közösségi intelligencia" description={<>Elsődleges közösségi forrás (MTProto, csak nyilvános / jogosan elérhető csatornák). Determinisztikus, AI nélkül; <strong>MONITOR_ONLY</strong> – a BUY döntést, méretet, Launch / Risk Score-t, SL / TP / BE / trailinget nem változtatja. A korábbi trade-ekhez nincs visszamenőleges adat: ezek „Nincs Telegram-adat” csoportban maradnak.</>}
      action={<Status tone={state.tone}>{state.text}</Status>}>
      <div className="metric-grid">
        <Metric label="Telegram" value={o.enabled ? 'BE' : 'KI'} note={`Motor: ${o.engineStatus ?? '—'}`} />
        <Metric label="Figyelt tokenek / talált források" value={`${o.monitoredTokens ?? '—'} / ${o.matchedSources ?? 0}`} note={o.sources ? `hivatalos ${o.sources.official} · közösségi ${o.sources.community} · nem elérhető ${o.sources.noAccess}` : undefined} />
        <Metric label="Lefedettség / friss lefedettség (7 nap)" value={`${o.coveragePct == null ? '—' : `${fmt(o.coveragePct, 0)}%`} / ${o.freshCoveragePct == null ? '—' : `${fmt(o.freshCoveragePct, 0)}%`}`} note={`${o.tokens ?? 0} token döntéssel`} />
        <Metric label="Üzenetek (fogadott / hozzárendelt)" value={`${o.messagesReceived ?? '—'} / ${o.messagesProcessed ?? '—'}`} />
        <Metric label="Átl. aktív felhasználó (5 p)" value={val(o.averageUniqueUsers5m)} />
        <Metric label="Átl. lendület / minőség / spam" value={`${val(o.averageMomentum)} / ${val(o.averageQuality)} / ${val(o.averageSpam)}`} note={`Adatminőség: ${val(o.averageDataQuality)}`} />
        <Metric label="Trade-ek Telegram-adattal" value={`${telegram.tradesWithTelegram} / ${telegram.tradesTotal}`} note={telegram.sampleNote === 'TELEGRAM_DATA_NOT_AVAILABLE' ? 'Még nincs Telegram-adatos trade' : telegram.sampleNote} />
      </div>
      {noData ? <p className="sfield-help">TELEGRAM_DATA_NOT_AVAILABLE – a lezárt trade-ek a Telegram-gyűjtés előttiek (vagy nem volt forrás). Visszamenőleges kitöltés nincs; az eredmények az új trade-ekkel épülnek fel.</p> : null}
    </Section>
    <section className="panel-grid">
      <Section title="Telegram Momentum sávok"><TelegramStatsTable rows={telegram.momentumBuckets} first="Momentum" /></Section>
      <Section title="Telegram Quality sávok"><TelegramStatsTable rows={telegram.qualityBuckets} first="Quality" /></Section>
    </section>
    <section className="panel-grid">
      <Section title="Telegram spam / koordináció" description={`Alacsony < ${telegram.levels?.spamLow}, magas > ${telegram.levels?.spamHigh} (valószínűség, nem bizonyíték)`}><TelegramStatsTable rows={telegram.spam} first="Spam" /></Section>
      <Section title="Telegram × on-chain" description={`HIGH TELEGRAM = Telegram Momentum > ${telegram.levels?.high}; HIGH ONCHAIN = Launch Momentum ≥ ${telegram.levels?.highOnchainMomentum}`}><TelegramStatsTable rows={telegram.telegramOnchainMatrix} first="Csoport" /></Section>
    </section>
    <Section title="Launch Score × Telegram" description={`TG alacsony < ${telegram.levels?.low} ≤ közepes ≤ ${telegram.levels?.high} < magas (Telegram Momentum)`}><TelegramStatsTable rows={telegram.launchScoreByTelegram} first="Launch Score × TG" /></Section>
    <Section title="Belépési életkor × Telegram"><TelegramStatsTable rows={telegram.entryAgeByTelegram} first="Életkor × TG" /></Section>
    <section className="panel-grid">
      <Section title="Telegram / on-chain megerősítés és eltérés"><TelegramStatsTable rows={telegram.confirmation} first="Állapot" /></Section>
      <Section title="Diagnosztikai osztályok vs. Telegram">
        <DataTable headers={['Osztály', 'Trade', 'Átl. lendület', 'Átl. minőség', 'Átl. spam', 'Átl. felhasználó (5 p)']}>{(telegram.diagnosis ?? []).map((row: any) => <tr key={row.diagnosis}><td>{DIAGNOSIS[row.diagnosis]?.label ?? row.diagnosis}</td><td>{row.trades}</td><td>{val(row.averageMomentum)}</td><td>{val(row.averageQuality)}</td><td>{val(row.averageSpam)}</td><td>{val(row.averageUniqueUsers5m)}</td></tr>)}</DataTable>
      </Section>
    </section>
    <Section title="Feltételezett Telegram-szűrők" description="HISTORICAL SIMULATION — NOT FUTURE PERFORMANCE. Rangsor: PF → várható érték → P&L → visszaesés → nyertes-megtartás (nem nyerési arány). Telegram-adat nélküli trade-et egyik szűrő sem távolít el. A stratégia nem változik.">
      <DataTable wide headers={['#', 'Szűrő', 'Eltávolítva (vesztes / nyerő)', 'Nyertes-megtartás', 'P&L előtte → utána', 'PF előtte → utána', 'Várható érték', 'Visszaesés', 'Validáció (holdout 30%)', 'Figyelmeztetés']}>
        {(telegram.filters ?? []).map((filter: any, index: number) => <tr key={filter.id}>
          <td>{index + 1}</td>
          <td><strong>{filter.label}</strong></td>
          <td>{filter.all.tradesRemoved} ({filter.all.losersRemoved} / {filter.all.winnersRemoved})</td>
          <td>{filter.all.winnerRetentionPct == null ? '—' : `${fmt(filter.all.winnerRetentionPct, 0)}%`}</td>
          <td>{usd(filter.all.netPnlBefore, true)} → <span className={tone(filter.all.netPnlChange)}>{usd(filter.all.netPnlAfter, true)}</span></td>
          <td>{val(filter.all.profitFactorBefore, 2)} → {val(filter.all.profitFactorAfter, 2)}</td>
          <td>{val(filter.all.expectancyBefore, 2)} → {val(filter.all.expectancyAfter, 2)}</td>
          <td>{val(filter.all.maxDrawdownBefore, 2)} → {val(filter.all.maxDrawdownAfter, 2)}</td>
          <td>{filter.validation ? `${usd(filter.validation.holdout.netPnlChange, true)} · PF ${val(filter.validation.holdout.profitFactorAfter, 2)}` : 'kevés adat (< 50)'}</td>
          <td>{filter.warnings?.length ? <span className="sample-note">{filter.warnings.join(' · ')}</span> : '—'}</td>
        </tr>)}
      </DataTable>
    </Section>
  </>;
}

function SocialStatsTable({ rows, first }: { rows: any[] | undefined; first: string }) {
  if (!rows?.length) return <EmptyState message="Nincs adat." />;
  return <DataTable wide headers={[first, 'Trade', 'Nyerési arány', 'Nettó P&L', 'PF', 'Várható érték', 'Átl. nyerő', 'Átl. vesztes', 'Átl. MFE', 'Átl. MAE', 'Max. visszaesés']}>
    {rows.map((row) => <tr key={row.key}>
      <td><strong>{SOCIAL_KEY_LABELS[row.key] ?? row.key}</strong></td>
      <td>{row.trades}{row.trades > 0 && row.trades < 20 ? <span className="sample-note"> · kis minta</span> : null}</td>
      <td>{row.winRate == null ? '—' : `${fmt(row.winRate, 0)}%`}</td>
      <td className={tone(row.netPnl)}>{row.trades ? usd(row.netPnl, true) : '—'}</td>
      <td>{row.profitFactor == null ? '—' : fmt(row.profitFactor)}</td>
      <td className={tone(row.expectancy)}>{row.expectancy == null ? '—' : fmt(row.expectancy, 2)}</td>
      <td>{row.averageWinner == null ? '—' : fmt(row.averageWinner)}</td>
      <td>{row.averageLoser == null ? '—' : fmt(row.averageLoser)}</td>
      <td>{pct(row.averageMfePercent)}</td>
      <td>{pct(row.averageMaePercent)}</td>
      <td>{row.maxDrawdown == null ? '—' : fmt(row.maxDrawdown)}</td>
    </tr>)}
  </DataTable>;
}

function SocialSection({ social }: { social: any }) {
  if (!social) return <EmptyState message="Nincs adat." />;
  const o = social.overview ?? {};
  const enough = social.tradesWithSocial >= 50;
  const answer = (text: string) => (enough ? text : 'Még nincs elég adat (legalább 50 trade kell közösségi pillanatképpel) – nem állítunk előrejelző értéket.');
  return <>
    <Section title="Közösségi intelligencia" description={<>Determinisztikus (AI nélküli) mérés: figyelem, független szereplők, spam / koordináció valószínűsége, kimerülés és on-chain megerősítés. <strong>MONITOR_ONLY</strong>: az NL-v2 döntéseket nem változtatja – csak rögzíti, mit javasolt volna. Csak a döntés pillanatában ismert adatot használja (nincs lookahead). Hiányzó adat = „Nincs adat”, nem negatív jel.</>}>
      <div className="metric-grid">
        <Metric label="Tokenek közösségi adattal (7 nap)" value={`${o.tokensWithSocial ?? 0} / ${o.tokens ?? 0}`} note={o.coveragePct == null ? undefined : `Lefedettség: ${fmt(o.coveragePct, 0)}%`} />
        <Metric label="X / Telegram lefedettség" value={`${o.xCoveragePct == null ? '—' : `${fmt(o.xCoveragePct, 0)}%`} / ${o.telegramCoveragePct == null ? '—' : `${fmt(o.telegramCoveragePct, 0)}%`}`} />
        <Metric label="Átl. Social Score / lendület" value={`${o.averageSocialScore == null ? '—' : fmt(o.averageSocialScore, 0)} / ${o.averageMomentum == null ? '—' : fmt(o.averageMomentum, 0)}`} />
        <Metric label="Átl. spam / adatminőség" value={`${o.averageSpam == null ? '—' : fmt(o.averageSpam, 0)} / ${o.averageDataQuality == null ? '—' : fmt(o.averageDataQuality, 0)}`} />
        <Metric label="Elavult adat aránya" value={o.staleRatePct == null ? '—' : `${fmt(o.staleRatePct, 0)}%`} />
        <Metric label="Trade-ek belépéskori közösségi adattal" value={`${social.tradesWithSocial} / ${social.tradesTotal}`} note={social.sampleNote} />
      </div>
      {o.shadowDecisionCounts ? <p className="sfield-help">Árnyékdöntések (minden döntés, elutasítottakkal együtt): {Object.entries(o.shadowDecisionCounts).map(([key, count]) => `${key}: ${count}`).join(' · ') || '—'}</p> : null}
    </Section>
    <Section title="Social Score sávok" description="Belépéskori Social Score szerint. Kis mintából nem javasolunk küszöböt."><SocialStatsTable rows={social.scoreBuckets} first="Social Score" /></Section>
    <Section title="Közösségi × on-chain" description={`HIGH SOCIAL = Social Score ≥ ${social.thresholds?.highSocialScore}; HIGH ONCHAIN = Launch Momentum ≥ ${social.thresholds?.highOnchainMomentum}`}><SocialStatsTable rows={social.socialOnchainMatrix} first="Csoport" /></Section>
    <Section title="Közösségi × kilépési kapacitás" description="Elég likvidek-e a felkapott tokenek a skálázáshoz? (GOOD = EXCELLENT / GOOD kapacitás)"><SocialStatsTable rows={social.socialCapacityMatrix} first="Csoport" /></Section>
    <section className="panel-grid">
      <Section title="Közösségi lendület a belépéskor"><SocialStatsTable rows={social.momentumTrend} first="Trend" /></Section>
      <Section title="Spam-valószínűség" description={`Alacsony < ${social.thresholds?.spamLow}, magas > ${social.thresholds?.spamHigh}`}><SocialStatsTable rows={social.spam} first="Spam" /></Section>
    </section>
    <Section title="Közösségi kimerülés" description="Késői / FOMO jellegű figyelem: magas, de lassuló említések, kiterjedt ár, lassuló vásárlók">
      <DataTable wide headers={['Kimerülés', 'Trade', 'Nettó P&L', 'PF', 'Átl. MFE', 'Átl. MAE', 'Medián belépési életkor', 'Átl. Pump Exhaustion']}>{(social.exhaustion ?? []).map((row: any) => <tr key={row.key}><td><strong>{SOCIAL_KEY_LABELS[row.key] ?? row.key}</strong></td><td>{row.trades}</td><td className={tone(row.netPnl)}>{row.trades ? usd(row.netPnl, true) : '—'}</td><td>{row.profitFactor == null ? '—' : fmt(row.profitFactor)}</td><td>{pct(row.averageMfePercent)}</td><td>{pct(row.averageMaePercent)}</td><td>{row.medianEntryAgeSeconds == null ? '—' : `${fmt(row.medianEntryAgeSeconds, 0)} mp`}</td><td>{row.averagePumpExhaustion == null ? '—' : fmt(row.averagePumpExhaustion, 0)}</td></tr>)}</DataTable>
    </Section>
    <Section title="Közösségi / on-chain megerősítés"><SocialStatsTable rows={social.confirmation} first="Állapot" /></Section>
    <section className="panel-grid">
      <Section title="Diagnosztikai osztályok vs. közösségi jellemzők" description="Kiszűrhették volna-e a POOR_ENTRY trade-eket sok SUCCESSFUL_EXIT elvesztése nélkül?">
        <DataTable headers={['Osztály', 'Trade', 'Átl. Social', 'Átl. lendület', 'Átl. spam', 'Átl. kimerülés']}>{(social.diagnosisVsSocial ?? []).map((row: any) => <tr key={row.diagnosis}><td>{DIAGNOSIS[row.diagnosis]?.label ?? row.diagnosis}</td><td>{row.trades}</td><td>{row.averageSocialScore == null ? '—' : fmt(row.averageSocialScore, 0)}</td><td>{row.averageMomentum == null ? '—' : fmt(row.averageMomentum, 0)}</td><td>{row.averageSpam == null ? '—' : fmt(row.averageSpam, 0)}</td><td>{row.averageExhaustion == null ? '—' : fmt(row.averageExhaustion, 0)}</td></tr>)}</DataTable>
      </Section>
      <Section title="Vezet vagy követ?" description="Közösségi gyorsulás vs. az ár első +10%-os mozgása (időbeli sorrend, nem ok-okozat; felbontás ~30 mp)">
        {social.leadLag?.pairs ? <div className="metric-grid">
          <Metric label="Kiértékelt párok" value={social.leadLag.pairs} />
          <Metric label="Közösségi gyorsulás előbb / ár előbb" value={`${social.leadLag.socialFirst} / ${social.leadLag.priceFirst}`} />
          <Metric label="Medián eltérés" value={social.leadLag.medianLagMs == null ? '—' : `${fmt(social.leadLag.medianLagMs / 1000, 0)} mp`} note="Pozitív: a közösségi gyorsulás előzte meg az ármozgást" />
        </div> : <EmptyState message="Még nincs olyan trade, amelyhez közösségi gyorsulás és ármozgás is tárolva van." />}
      </Section>
    </section>
    <Section title="Feltételezett közösségi szűrők" description="HISTORICAL SIMULATION — NOT FUTURE PERFORMANCE. Ismeretlen közösségi adatú trade-et egyik szűrő sem távolít el. Nem a nyerési arány számít: nettó P&L, PF, várható érték, visszaesés és nyertes-megtartás együtt.">
      <DataTable wide headers={['Szűrő', 'Eltávolítva', 'Vesztes / POOR_ENTRY / nyerő eltávolítva', 'Nyertes-megtartás', 'Trade-megtartás', 'Nettó P&L változás', 'PF előtte → utána', 'Várható érték előtte → utána', 'Időrendi validáció (holdout)']}>
        {(social.filters ?? []).map((filter: any) => <tr key={filter.id}>
          <td><strong>{filter.label}</strong></td>
          <td>{filter.all.tradesRemoved}</td>
          <td>{filter.all.losersRemoved} / {filter.all.poorEntriesRemoved} / {filter.all.winnersRemoved}</td>
          <td>{filter.all.winnerRetentionPct == null ? '—' : `${fmt(filter.all.winnerRetentionPct, 0)}%`}</td>
          <td>{filter.all.tradeRetentionPct == null ? '—' : `${fmt(filter.all.tradeRetentionPct, 0)}%`}</td>
          <td className={tone(filter.all.netPnlChange)}>{usd(filter.all.netPnlChange, true)}</td>
          <td>{filter.all.profitFactorBefore == null ? '—' : fmt(filter.all.profitFactorBefore)} → {filter.all.profitFactorAfter == null ? '—' : fmt(filter.all.profitFactorAfter)}</td>
          <td>{filter.all.expectancyBefore == null ? '—' : fmt(filter.all.expectancyBefore, 2)} → {filter.all.expectancyAfter == null ? '—' : fmt(filter.all.expectancyAfter, 2)}</td>
          <td>{filter.validation ? `${usd(filter.validation.holdout.netPnlChange, true)} · nyertes-megtartás ${filter.validation.holdout.winnerRetentionPct == null ? '—' : `${fmt(filter.validation.holdout.winnerRetentionPct, 0)}%`}` : 'kevés adat (< 50)'}</td>
        </tr>)}
      </DataTable>
    </Section>
    <Section title="Kérdések, amelyekre az adat válaszol" description="Csak akkor állítunk bármit, ha az adat alátámasztja">
      <ul className="analysis-list">
        <li>Magasabb-e a nyerők közösségi lendülete belépéskor? {answer(`Nyerők átlaga ${social.winnersVsLosers?.winners?.averageMomentum == null ? '—' : fmt(social.winnersVsLosers.winners.averageMomentum, 0)} vs. vesztesek ${social.winnersVsLosers?.losers?.averageMomentum == null ? '—' : fmt(social.winnersVsLosers.losers.averageMomentum, 0)} (n = ${social.winnersVsLosers?.winners?.trades ?? 0} / ${social.winnersVsLosers?.losers?.trades ?? 0}).`)}</li>
        <li>Rosszabbul teljesítenek-e a magas spam-pontszámú tokenek? {answer('Lásd a Spam-valószínűség táblát (PF, várható érték).')}</li>
        <li>Jobb-e a HIGH SOCIAL + HIGH ONCHAIN bármelyik jelnél önmagában? {answer('Lásd a Közösségi × on-chain mátrixot.')}</li>
        <li>Veszélyes marad-e a HIGH SOCIAL + POOR EXIT CAPACITY? {answer('Lásd a Közösségi × kilépési kapacitás mátrixot.')}</li>
        <li>A közösségi gyorsulás az ármozgás előtt vagy után jön? {social.leadLag?.pairs >= 20 ? `${social.leadLag.socialFirst} esetben előtte, ${social.leadLag.priceFirst} esetben utána (időbeli sorrend, nem ok-okozat).` : 'Még nincs elég (≥ 20) kiértékelhető pár.'}</li>
      </ul>
    </Section>
  </>;
}

function TimingTable({ rows }: { rows: Record<string, any> | undefined }) {
  const entries = Object.entries(rows ?? {});
  if (!entries.length) return <EmptyState message="Nincs mért időbélyeg." />;
  return <DataTable headers={['Szakasz', 'Medián', 'P95', 'Max', 'n']}>{entries.map(([key, value]) => <tr key={key}><td>{PIPELINE_LABELS[key] ?? key}</td><td>{duration(value.median)}</td><td>{duration(value.p95)}</td><td>{duration(value.max)}</td><td>{value.count}</td></tr>)}</DataTable>;
}

export function NewLaunchAnalytics() {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>('overview');
  const [version, setVersion] = useState('current');
  const [sample, setSample] = useState('all');
  const [lossesOnly, setLossesOnly] = useState(false);
  const [openTrade, setOpenTrade] = useState<string | null>(null);
  const [gridMetric, setGridMetric] = useState('netPnl');
  const [filter, setFilter] = useState({ launchScore: '80', uniqueBuyers: '20', liquidityUsd: '20000', exhaustionScore: '40', priceImpactPercent: '1.5' });
  const [simulation, setSimulation] = useState<any>(null);
  const [runMessage, setRunMessage] = useState('');
  const { data, error, loading, refresh } = useApi<{ data: any }>(`/api/analytics/new-launch?version=${version}&sample=${sample}`);
  if (loading && !data) return <LoadingState />;
  if (error && !data) return <ErrorState message={error} />;
  const d = data?.data;
  const a = d?.analytics;
  const s = a?.summary ?? {};
  const trades = (a?.trades ?? []).filter((trade: any) => !lossesOnly || trade.netPnl <= 0);

  const runSimulation = async () => {
    const conditions = [
      filter.launchScore && { feature: 'launchScore', kind: 'min', value: Number(filter.launchScore) },
      filter.uniqueBuyers && { feature: 'uniqueBuyers', kind: 'min', value: Number(filter.uniqueBuyers) },
      filter.liquidityUsd && { feature: 'liquidityUsd', kind: 'min', value: Number(filter.liquidityUsd) },
      filter.exhaustionScore && { feature: 'exhaustionScore', kind: 'max', value: Number(filter.exhaustionScore) },
      filter.priceImpactPercent && { feature: 'priceImpactPercent', kind: 'max', value: Number(filter.priceImpactPercent) },
    ].filter(Boolean);
    if (!conditions.length) return;
    const response = await apiRequest<{ data: any }>('/api/analytics/new-launch/simulate-filter', { method: 'POST', body: JSON.stringify({ conditions, version, sample: sample === 'all' ? 'all' : Number(sample) }) }).catch(() => null);
    setSimulation(response?.data ?? null);
  };
  const runOptimizer = async () => {
    setRunMessage('Az elemzés a háttérben fut…');
    await apiRequest('/api/new-launch/optimizer/run', { method: 'POST', body: JSON.stringify({ version, sample: sample === 'all' ? 'all' : Number(sample) }) }).catch(() => undefined);
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await new Promise((resolve) => globalThis.setTimeout(resolve, 2000));
      const state = await apiRequest<{ data: { latestRun: any } }>('/api/new-launch/optimizer').catch(() => null);
      if (state?.data.latestRun?.status !== 'RUNNING') break;
    }
    setRunMessage('');
    refresh();
  };
  const run = d?.latestRun;
  const exitResult = run?.result?.exit;

  return <div className="nl-analytics">
    <Panel title="Új token / Sniper elemzés" description={<>Konfiguráció: <strong>{version === 'current' ? `${d?.currentConfigVersion} (aktuális)` : version === 'all' ? 'minden verzió' : version}</strong> · {a?.sampleSize ?? 0} lezárt trade{a?.summary?.tradesWithPath != null ? ` · ${a.summary.tradesWithPath} valós árfolyam-úttal` : ''}. Az optimalizálás alapból az aktuális verzióra vonatkozik, mert az eltérő konfigurációk keverése félrevezető lehet.</>}
      action={<div className="header-actions">
        <label className="inline-select">Verzió<select value={version} onChange={(event) => setVersion(event.target.value)}><option value="current">Aktuális</option><option value="all">Minden verzió</option>{(d?.versions ?? []).map((item: any) => <option key={item.version} value={item.version}>{item.version}</option>)}</select></label>
        <label className="inline-select">Minta<select value={sample} onChange={(event) => setSample(event.target.value)}><option value="all">Mind</option><option value="50">Utolsó 50</option><option value="100">Utolsó 100</option><option value="250">Utolsó 250</option></select></label>
      </div>}>
      <div className="segmented tab-bar" role="tablist" aria-label="Új token elemzés nézetek">{TABS.map(([key, label]) => <button key={key} type="button" role="tab" aria-selected={tab === key} className={tab === key ? 'selected' : ''} onClick={() => setTab(key)}>{label}</button>)}</div>
    </Panel>

    {tab === 'overview' ? <>
      <section className="metric-grid">
        <Metric label="Nettó P&L" value={usd(s.netPnl, true)} tone={tone(s.netPnl)} />
        <Metric label="Nyerési arány" value={s.winRate == null ? '—' : `${fmt(s.winRate, 0)}%`} note={s.breakEvenWinRate == null ? undefined : `Nullszinthez szükséges: ${fmt(s.breakEvenWinRate, 0)}% (a megfigyelt átl. nyerő/vesztes alapján, nem előrejelzés)`} />
        <Metric label="Profit faktor" value={s.profitFactor == null ? '—' : fmt(s.profitFactor)} />
        <Metric label="Várható érték / trade" value={s.expectancy == null ? '—' : `${fmt(s.expectancy, 3)} USDC`} note="Az átlagosan várható nettó eredmény egy kereskedésre a történeti mintában." />
        <Metric label="Max. visszaesés" value={usd(s.maxDrawdown)} />
        <Metric label="Átl. nyerő / vesztes" value={`${s.averageWinner == null ? '—' : fmt(s.averageWinner)} / ${s.averageLoser == null ? '—' : fmt(s.averageLoser)}`} note={s.payoffRatio == null ? undefined : `Payoff arány: ${fmt(s.payoffRatio)}`} />
        <Metric label="Átl. MFE / MAE" value={`${pct(s.averageMfePercent)} / ${pct(s.averageMaePercent)}`} note="Maximális kedvező / kedvezőtlen kitérés a belépés után" />
      </section>
      <section className="panel-grid">
        <Section title="Új token tölcsér" description={`Utolsó ${d?.funnel?.sinceDays ?? 7} nap, launch-onként a legtovább jutott szakasz`}>
          <div className="funnel">{(d?.funnel?.funnel ?? []).map((stage: any) => <div className="funnel-row" key={stage.stage}>
            <span className="funnel-label">{FUNNEL_LABELS[stage.stage] ?? stage.stage}</span>
            <span className="funnel-bar"><span style={{ width: `${Math.max(2, stage.conversionFromDetected ?? 0)}%` }} /></span>
            <strong>{stage.count}</strong>
            <small>{stage.conversionFromPrevious == null ? '' : `${fmt(stage.conversionFromPrevious, 0)}%`}</small>
          </div>)}</div>
        </Section>
        <Section title="Elutasítási okok" description={`${d?.funnel?.rejectedLaunches ?? 0} nem megvett launch végső döntése alapján (egy launch-nak több oka is lehet)`}>
          {(d?.funnel?.rejectionReasons ?? []).length === 0 ? <EmptyState message="Nincs adat." /> : <DataTable headers={['Ok', 'Darab', 'Arány']}>{d.funnel.rejectionReasons.slice(0, 16).map((item: any) => <tr key={item.reason}><td>{REJECTION_LABELS[item.reason] ?? item.reason}</td><td>{item.count}</td><td>{item.share == null ? '—' : `${fmt(item.share, 0)}%`}</td></tr>)}</DataTable>}
        </Section>
      </section>
      <section className="panel-grid">
        <Section title="Launch Score után kiesett launchok" description={`${d?.funnel?.afterScoreBreakdown?.launches ?? 0} launch ment át a Launch Score-on vétel nélkül; az utolsó döntésük okai`}>
          {(d?.funnel?.afterScoreBreakdown?.reasons ?? []).length === 0 ? <EmptyState message="Nincs adat." /> : <DataTable headers={['Ok', 'Darab']}>{d.funnel.afterScoreBreakdown.reasons.slice(0, 12).map(([reason, count]: [string, number]) => <tr key={reason}><td>{REJECTION_LABELS[reason] ?? reason}</td><td>{count}</td></tr>)}</DataTable>}
          <strong className="analysis-subtitle" style={{ marginTop: 16 }}>Végrehajtási (kockázat / limit) elutasítások</strong>
          {(d?.funnel?.executionRejections ?? []).length === 0 ? <EmptyState message="Nincs végrehajtási elutasítás." /> : <DataTable headers={['Ok', 'Darab']}>{d.funnel.executionRejections.map(([reason, count]: [string, number]) => <tr key={reason}><td>{EXECUTION_REJECTION_LABELS[reason] ?? reason}</td><td>{count}</td></tr>)}</DataTable>}
        </Section>
        <Section title="Lejárt launchok okai" description="A launch állapota közvetlenül a figyelési ablak lejárta előtt">
          {(d?.funnel?.expiryCauses ?? []).length === 0 ? <EmptyState message="Nincs lejárt launch." /> : <DataTable headers={['Ok', 'Darab']}>{d.funnel.expiryCauses.map(([cause, count]: [string, number]) => <tr key={cause}><td>{EXPIRY_LABELS[cause] ?? cause}</td><td>{count}</td></tr>)}</DataTable>}
        </Section>
      </section>
      <section className="panel-grid">
        <Section title="Diagnosztikai besorolás" description="Szabályalapú becslés (nem bizonyosság) arról, a belépés vagy a kilépés volt-e a gyenge pont">
          <DataTable headers={['Besorolás', 'Trade', 'Jelentés']}>{Object.entries(DIAGNOSIS).map(([key, info]) => <tr key={key}><td><Status tone={info.tone}>{info.label}</Status></td><td>{a?.diagnosisCounts?.[key] ?? 0}</td><td><span className="sfield-help">{info.help}</span></td></tr>)}</DataTable>
        </Section>
        <Section title="Konfigurációk összehasonlítása" description="Verziónként, a belépéskori konfiguráció szerint">
          <PerfTable rows={(a?.configComparison ?? []).map((row: any) => ({ ...row, label: row.version }))} first="Verzió" />
        </Section>
      </section>
      <Section title="Új token kereskedések" description="Kattints egy sorra a teljes pozíció-részletekért; a „Mi történt?” diagnosztikai összefoglaló." action={<label className="stoggle compact-toggle"><span className="sfield-label">Csak vesztesek</span><input type="checkbox" role="switch" className="switch" checked={lossesOnly} onChange={(event) => setLossesOnly(event.target.checked)} /></label>}>
        {trades.length === 0 ? <EmptyState message="Nincs lezárt Új token kereskedés ebben a nézetben." /> : <DataTable wide headers={['Token', 'Belépés → kilépés', 'Nettó P&L', 'MFE', 'MAE', 'Kilépés oka', 'Belépési életkor', 'Launch Score', 'Tartás', 'Lezárva', '']}>
          {trades.map((trade: any) => <Fragment key={trade.id}>
            <tr className="clickable-row" onClick={() => trade.positionId && router.push(`/positions/${trade.positionId}`)}>
              <td>{trade.positionId ? <Link className="row-link" href={`/positions/${trade.positionId}`} onClick={(event) => event.stopPropagation()}><strong>{trade.symbol}</strong></Link> : <strong>{trade.symbol}</strong>}</td>
              <td><Stacked top={formatPrice(trade.entryPrice)} bottom={`→ ${formatPrice(trade.exitPrice)}`} /></td>
              <td className={tone(trade.netPnl)}><Stacked top={usd(trade.netPnl, true)} bottom={pct(trade.returnPercent)} /></td>
              <td>{pct(trade.mfePercent)}</td>
              <td>{pct(trade.maePercent)}</td>
              <td>{EXIT_LABELS[trade.exitGroup] ?? trade.exitReason}</td>
              <td>{trade.entryAgeSeconds == null ? '—' : `${fmt(trade.entryAgeSeconds, 0)} mp`}</td>
              <td>{trade.launchScore ?? '—'}</td>
              <td>{duration(trade.holdMs)}</td>
              <td>{date(trade.closedAt)}</td>
              <td><button type="button" className="text-button" aria-expanded={openTrade === trade.id} onClick={(event) => { event.stopPropagation(); setOpenTrade(openTrade === trade.id ? null : trade.id); }}>Mi történt? <ChevronDown size={14} aria-hidden="true" /></button></td>
            </tr>
            {openTrade === trade.id ? <tr className="facts-row"><td colSpan={11}><TradeFacts trade={trade} /></td></tr> : null}
          </Fragment>)}
        </DataTable>}
      </Section>
    </> : null}

    {tab === 'entry' ? <>
      <Section title="Nyerő vs. vesztes launchok" description="Medián és kvartilisek (P25–P75) mellett az átlag; a memecoin-eloszlásokban extrém kiugrók vannak">
        <DataTable wide headers={['Mutató', 'Nyerők medián', 'Nyerők P25–P75', 'Nyerők átlag (n)', 'Vesztesek medián', 'Vesztesek P25–P75', 'Vesztesek átlag (n)']}>
          {(a?.winnerVsLoser ?? []).map((row: any) => <tr key={row.metric}>
            <td><strong>{METRIC_LABELS[row.metric] ?? row.metric}</strong></td>
            <td>{row.winners.median == null ? '—' : fmt(row.winners.median)}</td>
            <td>{row.winners.p25 == null ? '—' : `${fmt(row.winners.p25)} – ${fmt(row.winners.p75)}`}</td>
            <td>{row.winners.average == null ? '—' : fmt(row.winners.average)} ({row.winners.count})</td>
            <td>{row.losers.median == null ? '—' : fmt(row.losers.median)}</td>
            <td>{row.losers.p25 == null ? '—' : `${fmt(row.losers.p25)} – ${fmt(row.losers.p75)}`}</td>
            <td>{row.losers.average == null ? '—' : fmt(row.losers.average)} ({row.losers.count})</td>
          </tr>)}
        </DataTable>
      </Section>
      <Section title="Belépés után azonnal gyenge" description={`Belépési minőség jelei (${a?.immediateFailure?.tradesWithPath ?? 0} trade valós árfolyam-úttal)`}>
        <div className="metric-grid">
          <Metric label="Soha nem érte el a +3%-ot" value={a?.immediateFailure?.neverReached3 ?? 0} />
          <Metric label="Soha nem érte el a +5%-ot" value={a?.immediateFailure?.neverReached5 ?? 0} />
          <Metric label="-5% 30 mp-en belül" value={a?.immediateFailure?.hitMinus5Within30s ?? 0} />
          <Metric label="-10% 60 mp-en belül" value={a?.immediateFailure?.hitMinus10Within60s ?? 0} />
          <Metric label="Stop loss 15 / 30 / 60 / 120 mp alatt" value={Object.values(a?.immediateFailure?.stopLossWithin ?? {}).join(' / ') || '—'} />
        </div>
      </Section>
      <Section title="Launch Score szerint"><PerfTable rows={a?.buckets?.launchScore} first="Launch Score" /></Section>
      <Section title="Token életkor belépéskor"><PerfTable rows={a?.buckets?.tokenAge} first="Életkor" /></Section>
      <Section title="Likviditás belépéskor"><PerfTable rows={a?.buckets?.liquidity} first="Likviditás" /></Section>
      <Section title="Egyedi vásárlók"><PerfTable rows={a?.buckets?.uniqueBuyers} first="Vásárlók" /></Section>
      <Section title="Vétel/eladás arány"><PerfTable rows={a?.buckets?.buySellRatio} first="Arány" /></Section>
      <Section title="Minőségi szűrő szimuláció" description="HISTORICAL SIMULATION — NOT FUTURE PERFORMANCE">
        <div className="panel-grid">
          <div>
            <strong className="analysis-subtitle">Belépéskor rögzített értékelés ({a?.qualityGate?.recorded?.evaluated ?? 0} trade)</strong>
            <PerfTable rows={[{ label: 'Tényleges', ...(a?.qualityGate?.recorded?.actual ?? {}) }, { label: 'Átment volna', ...(a?.qualityGate?.recorded?.wouldPass ?? {}) }, { label: 'Kiszűrte volna', ...(a?.qualityGate?.recorded?.wouldFail ?? {}) }].filter((row) => row.trades)} first="Csoport" />
          </div>
          <div>
            <strong className="analysis-subtitle">A jelenlegi szűrő (v{a?.qualityGate?.currentGateWhatIf?.gateVersion}) a rögzített belépési adatokon</strong>
            <PerfTable rows={[{ label: 'Tényleges', ...(a?.qualityGate?.currentGateWhatIf?.actual ?? {}) }, { label: 'Átment volna', ...(a?.qualityGate?.currentGateWhatIf?.wouldPass ?? {}) }, { label: 'Kiszűrte volna', ...(a?.qualityGate?.currentGateWhatIf?.removed ?? {}) }].filter((row) => row.trades)} first="Csoport" />
          </div>
        </div>
      </Section>
      <Section title="Szigorúbb belépési szűrő kipróbálása" description="Mennyi maradt volna a korábbi trade-ekből? Ismeretlen érték esetén a trade nem megy át.">
        <div className="sgrid sgrid-3">
          {([['launchScore', 'Launch Score ≥'], ['uniqueBuyers', 'Egyedi vásárlók ≥'], ['liquidityUsd', 'Likviditás ($) ≥'], ['exhaustionScore', 'Kifáradás ≤'], ['priceImpactPercent', 'Árhatás (%) ≤']] as const).map(([key, label]) => <label key={key} className="sfield"><span className="sfield-label">{label}</span><input type="number" value={filter[key]} placeholder="nincs feltétel" onChange={(event) => setFilter({ ...filter, [key]: event.target.value })} /></label>)}
        </div>
        <div className="recommendation-actions" style={{ marginTop: 16 }}><button type="button" className="primary-button" onClick={() => void runSimulation()}>Szimuláció</button></div>
        {simulation ? <div className="simulation-result">
          <p className="settings-warning">{simulation.label}</p>
          <div className="metric-grid">
            <Metric label="Korábbi trade-ek" value={simulation.historicalTrades} />
            <Metric label="Megmaradt volna" value={simulation.remaining} />
            <Metric label="Nyerők megtartva" value={`${simulation.winnersRetained} / ${simulation.winners}`} />
            <Metric label="Vesztesek kiszűrve" value={`${simulation.losersRemoved} / ${simulation.losers}`} />
          </div>
          <PerfTable rows={[{ label: 'Eredeti', ...simulation.before }, { label: 'Szűrővel', ...simulation.after }]} first="Változat" />
        </div> : null}
      </Section>
    </> : null}

    {tab === 'exit' ? <>
      <Section title="Kilépési okok"><PerfTable rows={a?.exitReasons} first="Kilépés" /></Section>
      <Section title="Profitot elért, mégis vesztes lett" description="A kilépéskezelés diagnosztikája: hány trade ért el adott nyereséget, majd zárt veszteséggel">
        <DataTable headers={['Elérte', 'Trade', 'Később veszteséggel zárt', 'Arány', 'Medián MFE', 'Medián végső hozam', 'Medián visszaadott']}>{(a?.profitReachedButLost ?? []).map((row: any) => <tr key={row.level}><td>+{row.level}%</td><td>{row.reached}</td><td className={row.closedNegative ? 'negative-value' : ''}>{row.closedNegative}</td><td>{row.share == null ? '—' : `${fmt(row.share, 0)}%`}</td><td>{pct(row.medianMfePercent)}</td><td className={tone(row.medianFinalReturnPercent)}>{pct(row.medianFinalReturnPercent)}</td><td>{row.medianGivebackPp == null ? '—' : `${fmt(row.medianGivebackPp, 1)} pp`}</td></tr>)}</DataTable>
      </Section>
      <Section title="Jó belépés, rossz kilépés – rekonstrukció" description="Minden GOOD_ENTRY_BAD_EXIT trade kizárólag tárolt adatokból: védő stop, trigger vs. kitöltés, kiértékelési rés, likviditás, fő ok. Ahol nincs elég árfolyam-pont: INSUFFICIENT_PRICE_PATH_DATA.">
        <ForensicTable rows={a?.goodEntryBadExit} empty="Nincs GOOD_ENTRY_BAD_EXIT trade ebben a nézetben." />
      </Section>
      <Section title="Gyanús kilépések" description="Minden lezárt trade, amelynél legalább egy anomália-ellenőrzés jelzett. Kattints a tokenre a pozíció részleteihez.">
        <ForensicTable rows={a?.suspiciousExits} empty="Nincs gyanús kilépés." />
      </Section>
      <Section title="Adatintegritás" description="Ellenőrzések, mielőtt bármilyen optimalizálási eredményben megbíznánk">
        <div className="metric-grid">
          <Metric label="Duplikált trade / pozíció" value={a?.dataIntegrity?.duplicateTradesPerPosition ?? '—'} />
          <Metric label="Érvénytelen ár" value={a?.dataIntegrity?.invalidPrices ?? '—'} />
          <Metric label="Jövőbeli időbélyeg" value={a?.dataIntegrity?.futureTimestamps ?? '—'} />
          <Metric label="Kilépés a belépés előtt" value={a?.dataIntegrity?.exitBeforeEntry ?? '—'} />
          <Metric label="MFE < realizált hozam" value={a?.dataIntegrity?.mfeBelowRealizedReturn ?? '—'} />
          <Metric label="MAE > realizált hozam" value={a?.dataIntegrity?.maeAboveRealizedReturn ?? '—'} />
          <Metric label="Hibásan címkézett kilépési ok" value={a?.dataIntegrity?.mislabeledExitReasons ?? '—'} note="Régi trade-ek, ahol a break-even/SL címke került a követő stop helyett" />
          <Metric label="Lefelé mozgó követő stop" value={a?.dataIntegrity?.trailingMovedDown ?? '—'} />
          <Metric label="Kevés árfolyam-adat" value={a?.dataIntegrity?.insufficientPathData ?? '—'} />
        </div>
      </Section>
      <Section title="Stop Loss diagnosztika" description="Minden SL trade: MFE a stop előtt, MAE, idő a stopig, break-even / követő stop állapot">
        {(a?.stopLossDiagnostics ?? []).length === 0 ? <EmptyState message="Nincs Stop Loss kilépés." /> : <DataTable wide headers={['Token', 'MFE a stop előtt', 'MAE', 'Idő a stopig', 'Legmagasabb ár', 'Break-even elérve', 'Követő stop aktív', 'Likviditás változás', 'Belépési árhatás', 'Nettó P&L']}>{a.stopLossDiagnostics.map((row: any) => <tr key={row.id}><td>{row.positionId ? <Link href={`/positions/${row.positionId}`}>{row.symbol}</Link> : row.symbol}</td><td>{pct(row.mfePercent)}</td><td>{pct(row.maePercent)}</td><td>{duration(row.timeToStopMs)}</td><td>{formatPrice(row.highestPriceBeforeStop)}</td><td>{row.breakEvenActivationReached ? 'igen' : 'nem'}</td><td>{row.trailingActivated ? 'igen' : 'nem'}</td><td>{pct(row.liquidityChangePercent, 0)}</td><td>{pct(row.entryPriceImpactPercent, 2)}</td><td className={tone(row.netPnl)}>{usd(row.netPnl, true)}</td></tr>)}</DataTable>}
      </Section>
      <section className="panel-grid">
        <Section title="Take Profit diagnosztika" description="Idő a célig és a cél előtti legnagyobb visszaesés">
          {(a?.takeProfitDiagnostics ?? []).length === 0 ? <EmptyState message="Nincs Take Profit kilépés." /> : <DataTable headers={['Token', 'Idő a TP-ig', 'MAE a TP előtt', 'MFE']}>{a.takeProfitDiagnostics.map((row: any) => <tr key={row.id}><td>{row.symbol}</td><td>{duration(row.timeToTakeProfitMs)}</td><td>{pct(row.maeBeforeTakeProfitPercent)}</td><td>{pct(row.mfePercent)}</td></tr>)}</DataTable>}
        </Section>
        <Section title="Break-even diagnosztika" description={`${a?.breakEvenDiagnostics?.activated ?? 0} trade-nél aktiválódott`}>
          {(a?.breakEvenDiagnostics?.trades ?? []).length === 0 ? <EmptyState message="Még nem aktiválódott break-even." /> : <DataTable headers={['Token', 'Aktiválás után', 'Kilépés', 'MFE az aktiválás után', 'Nettó P&L']}>{a.breakEvenDiagnostics.trades.map((row: any) => <tr key={row.id}><td>{row.symbol}</td><td>{duration(row.activationAfterMs)}</td><td>{EXIT_LABELS[row.exitGroup] ?? row.exitGroup}</td><td>{pct(row.mfeAfterActivationPercent)}</td><td className={tone(row.netPnl)}>{usd(row.netPnl, true)}</td></tr>)}</DataTable>}
        </Section>
      </section>
      <Section title="Követő stop diagnosztika" description="A követő stop soha nem mozdulhat lefelé – az utolsó oszlop ezt ellenőrzi a rögzített eseményekből">
        {(a?.trailingDiagnostics ?? []).length === 0 ? <EmptyState message="Nincs követő stoppal zárt trade." /> : <DataTable wide headers={['Token', 'MFE', 'Aktiválási ár', 'Aktiválás után', 'Legmagasabb ár', 'Utolsó stop', 'Kilépési ár', 'Visszaadott a csúcsról', 'Profit megtartás', 'Soha nem ment lefelé']}>{a.trailingDiagnostics.map((row: any) => <tr key={row.id}><td>{row.symbol}</td><td>{pct(row.mfePercent)}</td><td>{formatPrice(row.activationPrice)}</td><td>{duration(row.activationAfterMs)}</td><td>{formatPrice(row.highestPrice)}</td><td>{formatPrice(row.finalTrailingStop)}</td><td>{formatPrice(row.exitPrice)}</td><td>{pct(row.givebackFromHighPercent == null ? null : -row.givebackFromHighPercent)}</td><td>{row.captureRatio == null ? '—' : `${fmt(row.captureRatio * 100, 0)}%`}</td><td>{row.neverMovedDown == null ? '—' : row.neverMovedDown ? 'igen' : 'NEM'}</td></tr>)}</DataTable>}
      </Section>
    </> : null}

    {tab === 'quality' ? <>
      <Section title="Kifáradás (Exhaustion) szerint" description="Belép-e a bot már kifáradt pumpokba?"><PerfTable rows={a?.buckets?.exhaustion} first="Kifáradás" /></Section>
      <Section title="Árhatás szerint"><PerfTable rows={a?.buckets?.priceImpact} first="Árhatás" /></Section>
      <section className="panel-grid">
        <Section title="Kockázati osztály szerint"><PerfTable rows={a?.buckets?.riskClass} first="Osztály" /></Section>
        <Section title="Kockázati pontszám szerint" description="Külön a Launch Score-tól"><PerfTable rows={a?.buckets?.riskScore} first="Pontszám" /></Section>
      </section>
    </> : null}

    {tab === 'execution' ? <>
      <Section title="Késleltetés" description="A beállított megfigyelési idő nem infrastruktúra-késés; a csoportosítás a megfigyelés utáni (döntés + végrehajtás) késést használja">
        <DataTable headers={['Szakasz', 'Medián', 'P25–P75', 'Átlag', 'n']}>{Object.entries(a?.execution?.latency ?? {}).map(([key, value]: [string, any]) => <tr key={key}><td>{({ observationMs: 'Megfigyelés', securityMs: 'Biztonsági ellenőrzés (észleléstől)', decisionMs: 'Döntés (feltételek után)', executionMs: 'Végrehajtás (döntés → kitöltés)', totalMs: 'Összesen (észlelés → kitöltés)', postObservationMs: 'Megfigyelés utáni késés' } as Record<string, string>)[key] ?? key}</td><td>{duration(value.median)}</td><td>{value.p25 == null ? '—' : `${duration(value.p25)} – ${duration(value.p75)}`}</td><td>{duration(value.average)}</td><td>{value.count}</td></tr>)}</DataTable>
      </Section>
      <ExitSpeedSection speed={a?.execution?.exitSpeed} />
      <Section title="Kilépés időzítése" description="Kiértékelési rés: az utolsó tárolt ár és a kilépési megfigyelés közti idő. Trigger → kitöltés: a PAPER eladás végrehajtási ideje.">
        <div className="metric-grid">
          <Metric label="Kiértékelési rés (medián / P95)" value={`${duration(a?.execution?.exitEvaluationGapMs?.median)} / ${duration(a?.execution?.exitEvaluationGapP95Ms)}`} note={`n = ${a?.execution?.exitEvaluationGapMs?.count ?? 0}`} />
          <Metric label="Trigger → kitöltés (medián / P95)" value={`${duration(a?.execution?.triggerToFillMs?.median)} / ${duration(a?.execution?.triggerToFillP95Ms)}`} note={`n = ${a?.execution?.triggerToFillMs?.count ?? 0} (csak az új diagnosztikával zárt trade-ek)`} />
          <Metric label="Árfolyam kora a kilépéskor (medián)" value={duration(a?.execution?.exitQuoteAgeMs?.median)} />
          <Metric label="Elavult adattal zárt" value={a?.execution?.staleDataExits ?? 0} />
          <Metric label="Trigger → kitöltés rés (medián)" value={pct(a?.execution?.exitTriggerGapPercent?.median, 1)} note="Stop-kilépéseknél: mennyivel a védő szint alatt teljesült" />
        </div>
      </Section>
      <Section title="Pipeline időzítés" description={`Utolsó ${d?.funnel?.sinceDays ?? 7} nap, csak mért időbélyegekből`}>
        <TimingTable rows={d?.funnel?.pipelineTiming} />
      </Section>
      <Section title="Eredmény a késés szerint"><PerfTable rows={a?.execution?.byLatency} first="Késés" /></Section>
      <Section title="Árak és csúszás">
        <div className="metric-grid">
          <Metric label="Belépési csúszás (medián)" value={pct(a?.execution?.entrySlippagePercent?.median, 2)} />
          <Metric label="Kilépési csúszás (medián)" value={pct(a?.execution?.exitSlippagePercent?.median, 2)} />
          <Metric label="Észlelés → döntés árváltozás (medián)" value={pct(a?.execution?.detectionToDecisionPriceChangePercent?.median, 1)} />
          <Metric label="Döntés → kitöltés árváltozás (medián)" value={pct(a?.execution?.decisionToFillPriceChangePercent?.median, 2)} />
          <Metric label="Díjak összesen" value={usd(a?.execution?.feesTotal)} />
        </div>
      </Section>
    </> : null}

    {tab === 'capacity' ? <CapacitySection capacity={d?.capacity} /> : null}

    {tab === 'social' ? <><TelegramSection telegram={d?.telegram} /><SocialSection social={d?.social} /></> : null}

    {tab === 'optimizer' ? <>
      <Section title="Optimalizáló" description="Háttérben futó, gyorsítótárazott elemzés. HISTORICAL SIMULATION — NOT FUTURE PERFORMANCE."
        action={<button type="button" className="primary-button" onClick={() => void runOptimizer()} disabled={run?.status === 'RUNNING' || Boolean(runMessage)}><FlaskConical size={16} aria-hidden="true" /> {runMessage ? 'Fut…' : 'Elemzés futtatása'}</button>}>
        {run ? <p className="sfield-help">Utolsó futás: {date(run.completedAt ?? run.startedAt)} · állapot: {run.status} · minta: {run.sampleSize} trade{run.result?.configVersion ? ` · verzió: ${run.result.configVersion}` : ''}</p> : <EmptyState message="Még nem futott elemzés." />}
        {run?.result?.entry?.sufficientData === false ? <p className="settings-warning">Nincs elegendő adat megbízható beállítási javaslathoz (minimum {run.result.entry.minimumSampleSize} trade). A leíró elemzések így is érvényesek.</p> : null}
        {(d?.recommendations ?? []).length ? <>
          <strong className="analysis-subtitle">Függőben lévő javaslatok</strong>
          <DataTable wide headers={['Beállítás', 'Jelenlegi → javasolt', 'Minta', 'Megbízhatóság', 'Nyerők megtartása', 'Vesztesek kiszűrése', 'Validációs várható érték', 'Figyelmeztetés']}>{d.recommendations.map((item: any) => <tr key={item.id}><td>{RECOMMENDATION_PARAMETER_LABELS[item.parameter] ?? item.parameter}</td><td>{fmt(item.currentValue)} → <strong>{fmt(item.suggestedValue)}</strong></td><td>{item.sampleSize}</td><td>{item.confidenceLevel}</td><td>{item.winnerRetention == null ? '—' : `${fmt(Number(item.winnerRetention) * 100, 0)}%`}</td><td>{item.loserRejection == null ? '—' : `${fmt(Number(item.loserRejection) * 100, 0)}%`}</td><td>{item.validationMetrics?.filtered?.expectancy == null ? '—' : `${fmt(item.validationMetrics.base.expectancy, 3)} → ${fmt(item.validationMetrics.filtered.expectancy, 3)}`}</td><td>{(item.warnings ?? []).join(' ') || '—'}</td></tr>)}</DataTable>
          <p className="sfield-help">A javaslatokat a <Link href="/settings#new-launch">Beállítások → Új token / Sniper → Elemzési javaslatok</Link> alatt lehet PAPER kísérletként létrehozni. Automatikusan semmi nem változik.</p>
        </> : null}
      </Section>
      {exitResult ? <>
        <Section title="Kilépési paraméterek szimulációja" description={<>{exitResult.simulatedTrades} trade tárolt árfolyam-útján. Egyik cella sincs „legjobbnak” jelölve – a kompromisszumok láthatók. {exitResult.policy}</>}
          action={<label className="inline-select">Mutató<select value={gridMetric} onChange={(event) => setGridMetric(event.target.value)}><option value="netPnl">Nettó P&L</option><option value="profitFactor">Profit faktor</option><option value="expectancy">Várható érték</option><option value="maxDrawdown">Visszaesés</option><option value="winRate">Nyerési arány</option><option value="trades">Trade szám</option></select></label>}>
          <strong className="analysis-subtitle">Stop Loss × Take Profit (jelenleg: {exitResult.current.stopLossPercent}% / {exitResult.current.takeProfitPercent}%)</strong>
          <ExitGrid grid={exitResult.slTpGrid} metric={gridMetric} />
          <strong className="analysis-subtitle" style={{ marginTop: 20 }}>Követő stop aktiválás × távolság (jelenleg: {exitResult.current.trailingActivationPercent}% / {exitResult.current.trailingDistancePercent}%)</strong>
          <ExitGrid grid={exitResult.trailingGrid} metric={gridMetric} />
          {exitResult.breakEvenGrid ? <><strong className="analysis-subtitle" style={{ marginTop: 20 }}>Break-even aktiválás (jelenleg: {exitResult.current.breakEvenActivationPercent ?? '—'}%)</strong><ExitGrid grid={exitResult.breakEvenGrid} metric={gridMetric} /></> : null}
          {exitResult.pathResolution?.warning ? <p className="settings-warning">{exitResult.pathResolution.warning}</p> : null}
        </Section>
      </> : null}
    </> : null}
  </div>;
}
