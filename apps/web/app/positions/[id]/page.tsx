'use client';
/* eslint-disable @typescript-eslint/no-explicit-any */
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import { TokenAvatar } from '../../avatars';
import { apiRequest, DataTable, date, ErrorState, fmt, formatPrice, LoadingState, PageHeader, Panel, Status, useApi } from '../../components';
import { useRealtimeEvents } from '../../hooks/useRealtimeEvents';
import { exitReasonLabel } from '../../locales/hu';
import { decisionBadge, DECISION_SOURCE_LONG, EXIT_REASON_EVENT_LABELS, launchReasons, POSITION_EVENT_LABELS, SECURITY_STATE_LABELS } from '../../locales/position-labels';
import { ANOMALY_LABELS, CAPACITY_BASIS_LABELS, CAPACITY_CLASS_LABELS, CAUSE_LABELS, EXIT_LABELS, impactText, QUALITY_LABELS } from '../../new-launch-analytics';
import { holdingTime } from '../../position-format';
import { PriceChart } from '../../price-chart';

const UNKNOWN = 'Ismeretlen';
const RANGE_LABELS: Record<string, string> = { '1m': '1p', '5m': '5p', '15m': '15p', '30m': '30p', '1h': '1ó', lifetime: 'Pozíció teljes ideje' };

function Field({ label, value, tone }: { label: string; value: ReactNode; tone?: string }) {
  return <div className="detail-field"><span>{label}</span><strong className={tone ?? ''}>{value}</strong></div>;
}

const money = (value: number | null | undefined, signed = false) => (value == null ? '—' : `${signed && value > 0 ? '+' : ''}${fmt(value)} USDC`);
const pctText = (value: number | null | undefined, digits = 1) => (value == null ? '—' : `${value > 0 ? '+' : ''}${fmt(value, digits)}%`);
const tone = (value: number | null | undefined) => (value == null ? '' : value >= 0 ? 'positive-value' : 'negative-value');
const security = (value: string | null | undefined) => SECURITY_STATE_LABELS[value ?? 'UNKNOWN'] ?? value ?? UNKNOWN;

function eventLabel(event: any) {
  if (event.type === 'EXIT') return EXIT_REASON_EVENT_LABELS[String(event.details?.exitReason)] ?? `Kilépés (${exitReasonLabel(event.details?.exitReason)})`;
  return POSITION_EVENT_LABELS[event.type] ?? event.type;
}

const STOP_SOURCE: Record<string, string> = { TRAILING: 'Követő stop', BREAK_EVEN: 'Break-even stop', BASE_STOP_LOSS: 'Alap Stop Loss' };
const LIFECYCLE_LABELS: Record<string, string> = {
  EXIT_TRIGGERED: 'Kilépési feltétel teljesült (trigger)', PAPER_SELL_REQUESTED: 'PAPER eladás kérve', MARKET_DATA_STALE: 'Elavult piaci adat',
  MARKET_EVENT_RECEIVED: 'Piaci esemény beérkezett', EXIT_EVALUATED: 'Kilépés kiértékelve', EXECUTION_REQUESTED: 'Eladás kérve', EXECUTION_STARTED: 'Végrehajtás indul (kitöltési ár)', PAPER_FILL: 'PAPER kitöltés',
  TAKE_PROFIT_TOUCHED: 'TP ÉRINTVE', STOP_LOSS_TOUCHED: 'Stop loss érintve', BREAK_EVEN_STOP_TOUCHED: 'Break-even stop érintve', TRAILING_STOP_TOUCHED: 'Követő stop érintve',
};
/** hh:mm:ss.mmm (the exit path is measured in milliseconds). */
const clockMs = (at: string) => {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? '—' : `${date.toLocaleTimeString('hu-HU')}.${String(date.getMilliseconds()).padStart(3, '0')}`;
};
const msText = (value: number | null | undefined) => (value == null ? '—' : value < 1000 ? `${Math.round(value)} ms` : `${fmt(value / 1000, 1)} mp`);

/** Stored-data reconstruction of how the position was protected and exited (closed positions). */
function ExitDiagnostics({ f }: { f: any }) {
  const price = (value: number | null | undefined) => (value == null ? '—' : formatPrice(value));
  const reasonChanged = f.exit.effectiveReason && f.exit.recordedReason && f.exit.effectiveReason !== f.exit.recordedReason;
  return <Panel title="Exit diagnosztika" description="Kizárólag tárolt adatokból: védő stop, trigger vs. tényleges kitöltés, költségek, adatminőség és a legvalószínűbb fő ok. Diagnosztikai becslés, nem bizonyosság.">
    <div className="detail-grid">
      <Field label="Pozíció belépési ár (szimulált kitöltés)" value={`${price(f.positionEntryPrice)}${f.entrySlippagePercent == null ? '' : ` · csúszás ${pctText(f.entrySlippagePercent, 2)}`}`} />
      <Field label="Alap Stop Loss" value={f.stopLoss.basePrice == null ? '—' : `${price(f.stopLoss.basePrice)} (-${fmt(f.stopLoss.configuredPercent, 1)}%)`} tone="negative-value" />
      <Field label="Take Profit" value={f.takeProfit.price == null ? '—' : `${price(f.takeProfit.price)} (${pctText(f.takeProfit.percentFromEntry)})`} tone="positive-value" />
      <Field label="Break-even" value={!f.breakEven.enabled ? 'kikapcsolva' : f.breakEven.activated ? `aktiválva ${date(f.breakEven.activatedAt)} · stop ${price(f.breakEven.effectiveStopAfterActivation)}` : `nem aktiválódott (+${fmt(f.breakEven.activationPercent, 1)}%)`} />
      {f.breakEven.enabled ? <Field label="Break-even képlet" value={`${f.breakEven.formula} = ${price(f.breakEven.expectedStopPrice)}`} /> : null}
      <Field label="Követő stop" value={!f.trailing.enabled ? 'kikapcsolva' : f.trailing.activated ? `aktiválva ${date(f.trailing.activatedAt)} · stop ${price(f.trailing.actualStopPrice)}${f.trailing.matchesFormula === false ? ' (ELTÉR a képlettől!)' : ''}` : f.trailing.activationPercent == null ? 'nem aktiválódott (aktiválás: a vételtől)' : `nem aktiválódott (+${fmt(f.trailing.activationPercent, 1)}%)`} />
      <Field label="Legmagasabb ár" value={price(f.highestPrice)} />
      <Field label="Érvényes védő stop a kilépéskor" value={f.effectiveStop.price == null ? '—' : `${price(f.effectiveStop.price)} (${pctText(f.effectiveStop.percentFromEntry)})${f.effectiveStop.source ? ` · ${STOP_SOURCE[f.effectiveStop.source] ?? f.effectiveStop.source}` : ''}`} />
      <Field label="Kilépési ok (rögzített → tényleges)" value={<>{EXIT_LABELS[f.exit.recordedReason] ?? f.exit.recordedReason ?? '—'}{reasonChanged ? <> → {EXIT_LABELS[f.exit.effectiveReason] ?? f.exit.effectiveReason}</> : null}</>} />
      <Field label="Trigger ár → megfigyelt ár → kitöltés" value={`${price(f.exit.triggerPrice)} → ${price(f.exit.requestedExitPrice)} → ${price(f.exit.fillPrice)}`} />
      <Field label="Trigger–kitöltés rés" value={pctText(f.exit.triggerGapPercent, 2)} tone={f.exit.triggerGapPercent != null && f.exit.triggerGapPercent < -5 ? 'negative-value' : ''} />
      <Field label="Kilépési csúszás (modellezett)" value={pctText(f.exit.exitSlippagePercent == null ? null : -Math.abs(f.exit.exitSlippagePercent), 2)} />
      <Field label="Kiértékelési rés (előző ár → kilépés)" value={msText(f.exit.evaluationGapMs)} />
      <Field label="Trigger → kitöltés idő" value={msText(f.exit.exitExecutionLatencyMs)} />
      <Field label="Árfolyam kora a kilépéskor" value={`${msText(f.exit.marketDataAgeMs)}${f.exit.exitDataStale ? ' · ELAVULT' : ''}`} />
      <Field label="Likviditás belépés / MFE / trigger" value={`${f.liquidity.atEntry == null ? '—' : `$${fmt(f.liquidity.atEntry, 0)}`} / ${f.liquidity.atMfe == null ? '—' : `$${fmt(f.liquidity.atMfe, 0)}`} / ${f.liquidity.atTrigger == null ? '—' : `$${fmt(f.liquidity.atTrigger, 0)}`} (${pctText(f.liquidity.changePercent, 0)})`} />
      <Field label="MFE / végső nettó hozam" value={`${pctText(f.returns.mfePercent)} / ${pctText(f.returns.netReturnPercent)}`} tone={tone(f.returns.netReturnPercent)} />
      <Field label="Visszaadott a csúcsról" value={f.returns.givebackPercentagePoints == null ? '—' : `${fmt(f.returns.givebackPercentagePoints, 1)} pp`} />
      <Field label="Díjak (belépés + kilépés)" value={`${money(f.costs.entryFee)} + ${money(f.costs.exitFee)}`} />
      <Field label="Csúszás költsége (belépés / kilépés)" value={`${money(f.costs.entrySlippageUsd)} / ${money(f.costs.exitSlippageUsd)}`} />
      <Field label="Árfolyam-út adatminőség" value={f.pathDataQuality === 'OK' ? `${f.pathSamples} tárolt pont` : 'INSUFFICIENT_PRICE_PATH_DATA'} />
      <Field label="Legvalószínűbb fő ok" value={CAUSE_LABELS[f.primaryCause] ?? f.primaryCause} />
    </div>
    {f.exitSpeed ? <>
      <strong className="analysis-subtitle" style={{ marginTop: 16 }}>Exit speed</strong>
      <div className="detail-grid">
        <Field label="TP szint" value={f.exitSpeed.takeProfit.level == null ? '—' : `${price(f.exitSpeed.takeProfit.level)} (${pctText(f.exitSpeed.takeProfit.levelPercent)})`} />
        <Field label="TP első érintése" value={f.exitSpeed.takeProfit.firstTouchedAt ? `${clockMs(f.exitSpeed.takeProfit.firstTouchedAt)} · ${price(f.exitSpeed.takeProfit.firstTouchPrice)} (${pctText(f.positionEntryPrice ? (f.exitSpeed.takeProfit.firstTouchPrice / f.positionEntryPrice - 1) * 100 : null)})` : f.exitSpeed.takeProfit.reachedByPathOnly ? 'elérte (árfolyam-útból; érintés még nem volt rögzítve)' : 'nem érintette'} />
        <Field label="Védő szint a triggerkor" value={price(f.exitSpeed.protectiveLevelAtTrigger)} />
        <Field label="Piaci ár a triggerkor" value={price(f.exitSpeed.marketPriceAtTrigger)} />
        <Field label="Végrehajtási referencia ár" value={price(f.exitSpeed.requestedExitPrice)} />
        <Field label="Szimulált kitöltési ár" value={price(f.exitSpeed.simulatedFillPrice)} />
        <Field label="Trigger → kitöltés idő" value={msText(f.exitSpeed.latency?.triggerToFillLatencyMs)} />
        <Field label="Piaci esemény → kiértékelés" value={msText(f.exitSpeed.latency?.receiveToEvaluationLatencyMs)} />
        <Field label="Trigger → kitöltés ár romlás" value={pctText(f.exitSpeed.triggerToFillDeteriorationPercent, 2)} tone={(f.exitSpeed.triggerToFillDeteriorationPercent ?? 0) < -3 ? 'negative-value' : ''} />
        <Field label="TP érintés → kitöltés romlás" value={pctText(f.exitSpeed.tpTouchToFillDeteriorationPercent, 2)} />
        <Field label="Likviditás trigger / kitöltés" value={`${f.liquidity.atTrigger == null ? '—' : `$${fmt(f.liquidity.atTrigger, 0)}`} / ${f.exitSpeed.liquidityAtFill == null ? '—' : `$${fmt(f.exitSpeed.liquidityAtFill, 0)}`}`} />
        <Field label="PAPER végrehajtási késleltetés" value={f.exitSpeed.paperExecutionLatencyMode ? `${f.exitSpeed.paperExecutionLatencyMode} · ${msText(f.exitSpeed.paperExecutionSimulatedLatencyMs)}` : '—'} />
        <Field label="Piaci adat forrása" value={f.exitSpeed.marketEventSource ? `${f.exitSpeed.marketEventSource}${f.exitSpeed.marketEventSlot ? ` · slot ${f.exitSpeed.marketEventSlot}` : ''}` : '—'} />
        <Field label="Kilépés minősége" value={<>{(f.exitQuality ?? []).map((item: string) => <Status key={item} tone={QUALITY_LABELS[item]?.tone ?? 'neutral'}>{QUALITY_LABELS[item]?.label ?? item}</Status>)}</>} />
      </div>
      {!f.exitSpeed.instrumented ? <p className="annotation">Ez a kilépés az ezredmásodperces mérés bevezetése előtt történt: a késleltetési összetevők nem ismertek (nem becsüljük).</p> : null}
    </> : null}
    {(f.anomalies ?? []).length ? <p className="settings-warning">Anomáliák: {(f.anomalies as string[]).map((item) => ANOMALY_LABELS[item] ?? item).join(' · ')}</p> : null}
    <strong className="analysis-subtitle" style={{ marginTop: 16 }}>Időrend</strong>
    {(f.lifecycle ?? []).length === 0 ? <p className="annotation">Nincs rögzített esemény ehhez a pozícióhoz.</p> : null}
    <ol className="exit-lifecycle">{(f.lifecycle ?? []).map((item: any, index: number, list: any[]) => <li key={index} className={item.type === 'MARKET_DATA_STALE' ? 'anomaly' : ''}>
      <time>{clockMs(item.at)}{index > 0 && Date.parse(item.at) - Date.parse(list[index - 1].at) < 60_000 ? <small> (+{Date.parse(item.at) - Date.parse(list[index - 1].at)} ms)</small> : null}</time>
      <span><strong>{LIFECYCLE_LABELS[item.type] ?? POSITION_EVENT_LABELS[item.type] ?? (String(item.type).startsWith('MILESTONE_') ? `Elérte: ${item.details?.level}%` : item.type === 'EXIT' ? eventLabel(item) : item.type)}</strong>{item.price != null ? ` · ${price(item.price)}` : ''}{item.details?.to ? ` · új stop ${price(item.details.to)}` : ''}</span>
    </li>)}</ol>
  </Panel>;
}

const SIZING_DECISION: Record<string, string> = {
  KEEP: 'A javasolt méret = a kockázatkezelő által jóváhagyott méret',
  REDUCE: 'E fölötti méretnél a becsült árhatás (lásd a korlátot) a beállított maximum fölé menne – csökkentett méret javasolt',
  TOO_SMALL_TO_TRADE: 'A biztonságos méret a minimális végrehajtható méret alatt van',
  BLOCK_UNSAFE: 'Nincs biztonságos eladási útvonal',
  BLOCK_UNKNOWN: 'A kilépési kapacitás ismeretlen (nem tekintjük biztonságosnak)',
  BLOCK_LOW_SCORE: 'Az Exit Capacity Score a beállított minimum alatt van',
};
const CAPACITY_EVENT_LABELS: Record<string, string> = { EXIT_CAPACITY_DETERIORATED: 'Kilépési kapacitás romlott', SELL_ROUTE_LOST: 'ELADÁSI ÚTVONAL ELVESZETT', SELL_ROUTE_CHANGED: 'Eladási útvonal változott (görbe migrált)' };

/** Execution capacity: can the whole position be sold again at an acceptable impact (not a direction forecast). */
function ExecutionCapacity({ c }: { c: any }) {
  const usdc = (value: number | null | undefined) => (value == null ? '—' : `${fmt(value)} USDC`);
  const entry = c.atEntry;
  const sizing = c.sizing;
  const cls = entry ? CAPACITY_CLASS_LABELS[entry.classification] ?? { label: entry.classification, tone: 'neutral' } : null;
  return <Panel title="Végrehajtási kapacitás" description="Ha a teljes pozíciót azonnal el kellene adni, kijutnánk-e elfogadható árhatással? Végrehajthatóság – nem előrejelzés a token irányáról." action={cls ? <Status tone={cls.tone}>{cls.label}</Status> : undefined}>
    {entry ? <>
      <div className="detail-grid">
        <Field label="Pool likviditás belépéskor" value={c.liquidityAtEntry == null ? '—' : `$${fmt(c.liquidityAtEntry, 0)}`} />
        <Field label="Útvonal belépéskor" value={c.routeAtEntry ?? '—'} />
        <Field label="Kért pozíció" value={usdc(sizing?.originalRequestedSize)} />
        <Field label="Kockázatkezelő által jóváhagyott" value={usdc(sizing?.riskApprovedSize)} />
        <Field label="Javasolt biztonságos méret" value={usdc(sizing?.finalRecommendedSize)} />
        <Field label="Tényleges pozíció" value={usdc(c.actualSize)} />
        <Field label="Becsült VÉTELI árhatás" value={impactText(entry.estimatedBuyImpactPct, entry.basis)} />
        <Field label="Becsült azonnali teljes ELADÁSI árhatás" value={impactText(entry.estimatedImmediateSellImpactPct, entry.basis)} />
        <Field label="Oda-vissza árhatás / költség (díjjal)" value={`${impactText(entry.estimatedRoundTripImpactPct, entry.basis)} / ${impactText(entry.estimatedRoundTripCostPct, entry.basis)}`} />
        <Field label="Exit Capacity Score" value={entry.exitCapacityScore == null ? '—' : `${entry.exitCapacityScore} / 100`} />
        <Field label="Max. biztonságos pozíció" value={entry.maxSafePosition == null ? '—' : `${fmt(entry.maxSafePosition, 0)} USDC (korlát: ${entry.bindingConstraint ?? '—'})`} />
        <Field label="Adat alapja" value={`${CAPACITY_BASIS_LABELS[entry.basis] ?? entry.basis}${entry.confidence === 'ESTIMATE' ? ' · BECSLÉS' : ''}`} />
      </div>
      {sizing ? <p className={sizing.decision === 'KEEP' ? 'sfield-help' : 'settings-warning'}>
        Kockázatkezelő: {usdc(sizing.riskApprovedSize)} · Kilépési kapacitás biztonságos maximuma: {usdc(sizing.exitCapacityRecommendedSize)} · Javasolt végső méret: <strong>{usdc(sizing.finalRecommendedSize)}</strong>. {SIZING_DECISION[sizing.decision] ?? sizing.decision}{sizing.decision === 'REDUCE' && entry.bindingConstraint ? ` (korlát: ${({ ENTRY_IMPACT: 'belépési árhatás', EXIT_IMPACT: 'teljes kilépési árhatás', ROUND_TRIP: 'oda-vissza árhatás', LIQUIDITY_UTILIZATION: 'likviditás-kihasználtság', POOL_RESERVE: 'pool tartalék' } as Record<string, string>)[entry.bindingConstraint] ?? entry.bindingConstraint})` : ''}.
        {sizing.sizingMode === 'MONITOR_ONLY' ? ' (MONITOR_ONLY: a tényleges méret nem változott.)' : ' (ENFORCE_PAPER: a javaslat alkalmazva.)'}
      </p> : null}
      {Array.isArray(c.capacityCurve) && c.capacityCurve.length ? <DataTable headers={['Méret', 'Vételi hatás', 'Teljes eladási hatás', 'Oda-vissza']}>{c.capacityCurve.map((point: any) => <tr key={point.sizeUsd}><td>{fmt(point.sizeUsd, 0)} USDC</td><td>{impactText(point.buyImpactPct, point.basis)}</td><td>{point.feasible === false ? 'nem fizethető ki' : impactText(point.sellImpactPct, point.basis)}</td><td>{impactText(point.roundTripImpactPct, point.basis)}</td></tr>)}</DataTable> : null}
    </> : c.legacyEstimate ? <p className="annotation">Ez a pozíció a kapacitás-motor előtt nyílt. Becslés a tárolt belépési likviditásból (${fmt(c.liquidityAtEntry, 0)}): max. biztonságos pozíció kb. {fmt(c.legacyEstimate.maxSafePosition, 0)} USDC (BECSLÉS, korlát: {c.legacyEstimate.bindingConstraint ?? '—'}); tényleges: {usdc(c.actualSize)}.</p> : <p className="annotation">Nincs kapacitás-adat ehhez a pozícióhoz.</p>}
    <strong className="analysis-subtitle" style={{ marginTop: 16 }}>Belépés után</strong>
    <div className="detail-grid">
      <Field label="Kapacitás a kilépési triggerkor" value={c.atTrigger ? `${CAPACITY_CLASS_LABELS[c.atTrigger.classification]?.label ?? c.atTrigger.classification} · eladási hatás ${impactText(c.atTrigger.estimatedExitImpactPct, c.atTrigger.basis)}` : '—'} />
      <Field label="Útvonal a triggerkor" value={c.atTrigger?.routeStatus ?? '—'} />
      <Field label="Likviditás a triggerkor" value={c.atTrigger?.liquidityUsd == null ? '—' : `$${fmt(c.atTrigger.liquidityUsd, 0)}`} />
    </div>
    {(c.events ?? []).length ? <ol className="exit-lifecycle">{c.events.map((event: any, index: number) => <li key={index} className={event.type === 'SELL_ROUTE_LOST' ? 'anomaly' : ''}><time>{clockMs(event.at)}</time><span><strong>{CAPACITY_EVENT_LABELS[event.type] ?? event.type}</strong>{event.details?.from ? ` · ${event.details.from} → ${event.details.to}` : ''}{event.details?.liquidityUsd != null ? ` · likviditás $${fmt(event.details.liquidityUsd, 0)}` : ''}</span></li>)}</ol> : <p className="annotation">Nem volt rögzített kapacitás-romlás vagy útvonal-változás.</p>}
  </Panel>;
}

export default function PositionDetailPage() {
  const params = useParams<{ id: string }>();
  const [range, setRange] = useState('lifetime');
  const detail = useApi<{ data: any }>(`/api/positions/${params.id}`);
  const chart = useApi<{ data: any }>(`/api/positions/${params.id}/chart?range=${range}`);
  const { lastEvent } = useRealtimeEvents(['position_update', 'trade_update', 'pnl_update']);
  const [message, setMessage] = useState('');
  useEffect(() => {
    const payload = lastEvent?.payload as { id?: string; positionId?: string } | undefined;
    if (payload && (payload.id === params.id || payload.positionId === params.id)) {
      detail.refresh();
      chart.refresh();
    }
  }, [lastEvent, params.id, detail.refresh, chart.refresh]);

  const p = detail.data?.data;
  const header = <PageHeader eyebrow="Pozíció részletei" icon={p ? <TokenAvatar address={p.token.address} symbol={p.token.symbol} size={34} /> : undefined} title={p ? `${p.token.symbol}` : 'Pozíció'} subtitle={p?.token.name ?? p?.token.address} action={<Link className="secondary-button" href="/positions">← Pozíciók</Link>} />;
  if (detail.loading && !detail.data) return <>{header}<LoadingState /></>;
  if (detail.error && !detail.data) return <>{header}<ErrorState message={detail.error} /></>;
  if (!p) return <>{header}<ErrorState message="A pozíció nem található." /></>;
  const open = p.status === 'OPEN';
  const levels = p.exitLevels;
  const close = async () => {
    if (!globalThis.confirm(`Biztosan lezárod a(z) ${p.token.symbol} PAPER pozíciót a jelenlegi áron?`)) return;
    setMessage('Pozíció lezárása…');
    try {
      await apiRequest(`/api/positions/${p.id}/close`, { method: 'POST', body: JSON.stringify({ reason: 'manual-close' }) });
      setMessage('A pozíció lezárva.');
      detail.refresh();
      chart.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'A lezárás sikertelen');
    }
  };
  const c = chart.data?.data;
  const pnl = open ? p.unrealizedPnl : p.realizedPnl;
  const pnlPercent = open ? p.unrealizedPnlPercent : p.realizedPnlPercent;
  const entryConfig = p.configuration?.atEntry;
  const currentConfig = p.configuration?.currentPosition;
  const decision = p.decision ?? {};

  return <>
    {header}
    <section className="position-hero">
      <div className="position-hero-main">
        <div className="position-badges">
          <Status tone={open ? 'positive' : 'neutral'}>{open ? 'NYITOTT' : 'LEZÁRT'}</Status>
          <span className={`source-badge source-${String(p.decisionSource).toLowerCase()}`}>{decisionBadge(p.decisionSource, p.strategyName)}</span>
          {p.security?.riskClassification ? <Status tone="warning">{p.security.riskClassification} {p.security.riskScore != null ? fmt(p.security.riskScore, 0) : ''}</Status> : null}
          <span className="annotation" style={{ margin: 0 }}>{p.mode} · {p.token.address.slice(0, 6)}…{p.token.address.slice(-4)}</span>
        </div>
        <div className="position-price">
          <span>{open ? 'Aktuális ár' : 'Kilépési ár'}</span>
          <strong>{formatPrice(open ? p.currentPrice : p.exitPrice)}</strong>
        </div>
        <div className={`position-pnl ${tone(pnl)}`}>
          <span>{open ? 'Nem realizált P&L' : 'Realizált nettó P&L'}</span>
          <strong>{money(pnl, true)}</strong>
          <small>{pctText(pnlPercent)}</small>
          {open && p.estimatedCloseNowPnl != null ? <small title="A nyitott P&L már tartalmazza a belépési díjat; zárásnál még a kilépési díj és a becsült árhatás jön le.">Ha most zárnád: ~{money(p.estimatedCloseNowPnl, true)}</small> : null}
        </div>
      </div>
      <div className="detail-grid">
        <Field label="Belépési ár" value={formatPrice(p.entryPrice)} />
        <Field label={open ? 'Aktuális ár' : 'Kilépési ár'} value={formatPrice(open ? p.currentPrice : p.exitPrice)} />
        <Field label="Befektetett összeg" value={money(p.invested)} />
        <Field label="Aktuális érték" value={open ? money(p.currentValue) : '—'} />
        <Field label="Token mennyiség" value={fmt(p.quantity, 0)} />
        <Field label="Belépés ideje" value={date(p.openedAt)} />
        <Field label="Tartási idő" value={holdingTime(p.openedAt, p.closedAt)} />
        <Field label="Döntési forrás" value={DECISION_SOURCE_LONG[p.decisionSource] ?? p.decisionSource} />
        {!open ? <Field label="Kilépés oka" value={exitReasonLabel(p.exitReason)} /> : null}
        {!open ? <Field label="Díjak / csúszás" value={`${money(p.fees)} / ${money(p.slippage)}`} /> : null}
        {!open ? <Field label="Max. kedvező / kedvezőtlen kitérés" value={`${pctText(p.maxFavorableExcursionPercent)} / ${pctText(p.maxAdverseExcursionPercent)}`} /> : null}
      </div>
      {open ? <div className="row-inline" style={{ marginTop: 12 }}>{message ? <span className="inline-message">{message}</span> : <span />}<button type="button" className="position-close-button" onClick={() => void close()}>Pozíció zárása</button></div> : null}
    </section>

    <Panel title="Árfolyam-grafikon">
      <div className="segmented chart-ranges" role="group" aria-label="Időtáv">
        {(c?.availableRanges ?? ['lifetime']).map((key: string) => <button key={key} type="button" className={range === key ? 'selected' : ''} aria-pressed={range === key} onClick={() => setRange(key)}>{RANGE_LABELS[key] ?? key}</button>)}
      </div>
      {c ? <PriceChart points={c.points} levels={c.levels} markers={c.markers} trailingSteps={c.trailingSteps} entryPrice={p.entryPrice} /> : <LoadingState />}
      <p className="annotation">Vonaldiagram valós, eltárolt piaci árpontokból (nincs kitalált gyertya). A szinteket a worker Exit Engine-je számolja és menti; az oldal csak megjeleníti őket. ▲ vétel · ▼ eladás · ● trailing / break-even esemény.</p>
    </Panel>

    <section className="panel-grid">
      <Panel title="Kilépési szintek">
        <div className="detail-grid">
          <Field label="Stop Loss" value={levels.stopLoss ? `${formatPrice(levels.stopLoss.price)} (${pctText(levels.stopLoss.percentFromEntry)})` : 'nincs'} tone="negative-value" />
          <Field label="Take Profit" value={levels.takeProfit ? `${formatPrice(levels.takeProfit.price)} (${pctText(levels.takeProfit.percentFromEntry)})` : 'nincs'} tone="positive-value" />
          <Field label="Break-even aktiválás" value={levels.breakEven.enabled ? `+${fmt(levels.breakEven.activationPercent, 1)}% (${formatPrice(levels.breakEven.activationPrice)})` : 'kikapcsolva'} />
          <Field label="Break-even stop" value={levels.breakEven.status === 'ACTIVE' ? `AKTÍV (${date(levels.breakEven.appliedAt)})` : levels.breakEven.status === 'WAITING' ? 'Várakozik' : '—'} />
          <Field label="Trailing aktiválás" value={!levels.trailing.enabled ? 'nincs követő stop' : levels.trailing.activationPercent ? `+${fmt(levels.trailing.activationPercent, 1)}% (${formatPrice(levels.trailing.activationLevelPrice)})` : 'azonnal (vételtől)'} />
          <Field label="Trailing távolság" value={levels.trailing.enabled ? `${fmt(levels.trailing.distancePercent, 1)}%` : '—'} />
          <Field label="Trailing állapot" value={levels.trailing.status === 'ACTIVE' ? `AKTÍV (${date(levels.trailing.activatedAt)})` : levels.trailing.status === 'WAITING' ? 'Várakozik' : '—'} />
          <Field label="Aktuális trailing stop" value={levels.trailing.triggerPrice ? formatPrice(levels.trailing.triggerPrice) : '—'} />
          <Field label="Elért legmagasabb ár" value={formatPrice(levels.highestPrice)} />
          {open ? <Field label="Távolság Stop Lossig" value={pctText(levels.stopLoss?.distancePercent)} /> : null}
          {open ? <Field label="Távolság Take Profitig" value={pctText(levels.takeProfit?.distancePercent)} /> : null}
          {open && levels.trailing.status === 'WAITING' ? <Field label="Távolság trailing aktiválásig" value={pctText(levels.trailing.distanceToActivationPercent)} /> : null}
          {open && levels.trailing.status === 'ACTIVE' ? <Field label="Távolság trailing stopig" value={pctText(levels.trailing.distanceToTriggerPercent)} /> : null}
        </div>
      </Panel>
      <Panel title="Piaci adatok">
        <div className="detail-grid">
          <Field label="Ár" value={formatPrice(p.market.priceUsd)} />
          <Field label="Piaci kapitalizáció" value={p.market.marketCapUsd == null ? UNKNOWN : `$${fmt(p.market.marketCapUsd, 0)}`} />
          <Field label="FDV" value={p.market.fdvUsd == null ? UNKNOWN : `$${fmt(p.market.fdvUsd, 0)}`} />
          <Field label="Likviditás" value={p.market.liquidityUsd == null ? UNKNOWN : `$${fmt(p.market.liquidityUsd, 0)}`} />
          <Field label="Forgalom 5p / 1ó" value={`${p.market.volume5m == null ? '—' : `$${fmt(p.market.volume5m, 0)}`} / ${p.market.volume1h == null ? '—' : `$${fmt(p.market.volume1h, 0)}`}`} />
          <Field label="Változás 1p / 5p" value={`${pctText(p.market.priceChange1m)} / ${pctText(p.market.priceChange5m)}`} />
          <Field label="Változás 15p / 1ó" value={`${pctText(p.market.priceChange15m)} / ${pctText(p.market.priceChange1h)}`} />
          <Field label="Vétel / eladás arány" value={p.market.buySellRatio == null ? '—' : fmt(p.market.buySellRatio, 2)} />
          <Field label="Tranzakciók (5p)" value={p.market.transactions5m ?? '—'} />
          <Field label="Token életkor" value={p.market.tokenAgeSeconds == null ? UNKNOWN : holdingTime(new Date(Date.now() - p.market.tokenAgeSeconds * 1000))} />
        </div>
        <p className="annotation">Frissítve: {date(p.market.updatedAt)} · forrás: {p.market.source === 'LAUNCH_STREAM' ? 'launch tranzakció-folyam' : p.market.source === 'MARKET_DATA' ? 'piaci adat' : 'pozíció-árazás'}</p>
      </Panel>
    </section>

    {p.newLaunch ? <section className="panel-grid">
      <Panel title="Új token kilépési stratégia" description={<>A belépéskor rögzített, ténylegesen érvényes beállítás ({p.newLaunch.configVersion ?? '—'}). A Beállítások későbbi módosítása nem írja át.</>} action={<span className="source-badge source-new_launch">ÚJ TOKEN</span>}>
        {p.newLaunch.exitConfig ? <div className="detail-grid">
          <Field label="Stop Loss" value={`${p.newLaunch.exitConfig.stopLossPercent}% · ${levels.stopLoss ? formatPrice(levels.stopLoss.price) : '—'}`} tone="negative-value" />
          <Field label="Take Profit" value={`${p.newLaunch.exitConfig.takeProfitPercent}% · ${levels.takeProfit ? formatPrice(levels.takeProfit.price) : '—'}`} tone="positive-value" />
          <Field label="Break-even" value={p.newLaunch.exitConfig.breakEvenEnabled ? `+${p.newLaunch.exitConfig.breakEvenActivationPercent}% · ${levels.breakEven.status === 'ACTIVE' ? 'AKTÍV' : 'várakozik'}` : 'kikapcsolva'} />
          <Field label="Követő stop" value={p.newLaunch.exitConfig.trailingEnabled ? `+${p.newLaunch.exitConfig.trailingActivationPercent}% aktiválás · ${p.newLaunch.exitConfig.trailingDistancePercent}% távolság · ${levels.trailing.status === 'ACTIVE' ? 'AKTÍV' : 'várakozik'}` : 'kikapcsolva'} />
          <Field label="Aktuális követő stop" value={levels.trailing.triggerPrice ? formatPrice(levels.trailing.triggerPrice) : '—'} />
          <Field label="Elért legmagasabb ár" value={formatPrice(levels.highestPrice)} />
          <Field label="Likviditás-védelmi kilépés" value={p.newLaunch.exitConfig.liquiditySafetyEnabled ? `-${p.newLaunch.exitConfig.liquidityDropExitPercent}% a belépéskorihoz képest` : 'kikapcsolva'} />
          <Field label="Maximum tartási idő" value={p.newLaunch.exitConfig.maxHoldEnabled ? `${p.newLaunch.exitConfig.maxHoldMinutes} perc (${date(p.newLaunch.maxHoldUntil)})` : 'nincs'} />
          <Field label="Minőségi szűrő a belépéskor" value={p.newLaunch.qualityGate?.evaluated ? `${p.newLaunch.qualityGate.mode} · ${p.newLaunch.qualityGate.wouldPass ? 'átment' : 'nem ment volna át'}` : 'nem értékelt'} />
        </div> : <p className="annotation">Ez a pozíció a kilépési beállítások rögzítése előtt nyílt.</p>}
      </Panel>
      <Panel title="Likviditás és árfolyam-út" description="Valós, megfigyelt árakból (csak elemzés – belépési döntéshez soha nem használt)">
        <div className="detail-grid">
          <Field label="Likviditás belépéskor" value={p.liquidity?.atEntry == null ? UNKNOWN : `$${fmt(p.liquidity.atEntry, 0)}`} />
          <Field label="Jelenlegi / utolsó likviditás" value={p.liquidity?.current == null ? UNKNOWN : `$${fmt(p.liquidity.current, 0)}`} />
          <Field label="Likviditás változás" value={pctText(p.liquidity?.changePercent)} tone={tone(p.liquidity?.changePercent)} />
          <Field label="MFE (max. kedvező kitérés)" value={p.path?.mfePercent == null ? UNKNOWN : `${pctText(p.path.mfePercent)} · ${money(p.path.mfeUsd, true)}`} tone="positive-value" />
          <Field label="MAE (max. kedvezőtlen kitérés)" value={p.path?.maePercent == null ? UNKNOWN : `${pctText(p.path.maePercent)} · ${money(p.path.maeUsd)}`} tone="negative-value" />
          <Field label="Idő az MFE-ig / MAE-ig" value={`${p.path?.timeToMfeMs == null ? '—' : holdingTime(new Date(Date.now() - p.path.timeToMfeMs))} / ${p.path?.timeToMaeMs == null ? '—' : holdingTime(new Date(Date.now() - p.path.timeToMaeMs))}`} />
        </div>
        {p.path?.milestones && Object.keys(p.path.milestones).length ? <div className="milestone-list">{Object.entries(p.path.milestones as Record<string, number>).sort((a, b) => a[1] - b[1]).map(([key, after]) => <span key={key} className={`milestone ${key.startsWith('+') ? 'up' : 'down'}`}>{key}% · {holdingTime(new Date(Date.now() - after))}</span>)}</div> : <p className="annotation">{p.path ? 'Még nem ért el ±3%-os szintet.' : 'Nincs tárolt árfolyam-út ehhez a pozícióhoz.'}</p>}
      </Panel>
    </section> : null}

    <section className="panel-grid">
      <Panel title="Belépési döntés">
        <p className="annotation">Döntési forrás: <strong>{DECISION_SOURCE_LONG[decision.source] ?? decision.source}</strong></p>
        {decision.source === 'NEW_LAUNCH' && decision.launch ? <div className="detail-grid">
          <Field label="Launch Score" value={decision.launch.score ?? '—'} />
          <Field label="Launch Momentum" value={decision.launch.launchMomentumScore ?? '—'} />
          <Field label="Vásárlói minőség" value={decision.launch.buyerQualityScore ?? '—'} />
          <Field label="Vételi nyomás" value={decision.launch.buyPressureScore ?? '—'} />
          <Field label="Likviditás minőség" value={decision.launch.liquidityScore ?? '—'} />
          <Field label="Kifáradás" value={decision.launch.exhaustionScore ?? '—'} />
          <Field label="Adatminőség" value={decision.launch.dataQuality ?? '—'} />
          <Field label="Életkor a belépéskor" value={decision.launch.ageSeconds == null ? '—' : `${fmt(decision.launch.ageSeconds, 0)} mp`} />
          <Field label="Észlelt → döntési → kitöltési ár" value={`${formatPrice(decision.launch.detectedPrice)} → ${formatPrice(decision.launch.decisionPrice)} → ${formatPrice(decision.launch.simulatedFillPrice)}`} />
          <Field label="Észlelés → kitöltés" value={decision.launch.detectedAt && decision.launch.fillAt ? `${fmt((new Date(decision.launch.fillAt).getTime() - new Date(decision.launch.detectedAt).getTime()) / 1000, 1)} mp` : '—'} />
        </div> : null}
        {decision.source === 'AI' && decision.ai ? <div className="detail-grid">
          <Field label="AI szolgáltató / modell" value={`${decision.ai.provider} / ${decision.ai.model}`} />
          <Field label="AI döntés" value={`${decision.ai.rawDecision ?? '—'} → ${decision.ai.effectiveDecision}`} />
          <Field label="AI bizalom" value={decision.ai.confidence == null ? '—' : `${fmt(decision.ai.confidence, 0)}/100`} />
          <Field label="Belépés minősége" value={decision.ai.entryQuality == null ? '—' : `${fmt(decision.ai.entryQuality, 0)}/100`} />
          <Field label="Elemzés ideje" value={date(decision.ai.analyzedAt)} />
        </div> : null}
        {decision.source === 'STRATEGY' && decision.strategy ? <div className="detail-grid">
          <Field label="Elsődleges stratégia" value={String(decision.strategy.primaryStrategy ?? '—').replace('Strategy', '')} />
          <Field label="Stratégia pontszám" value={decision.strategy.strategyScore == null ? '—' : fmt(decision.strategy.strategyScore, 0)} />
          <Field label="Összetett pontszám" value={decision.strategy.compositeScore ?? '—'} />
          <Field label="Megerősítések" value={Array.isArray(decision.strategy.confirmations) ? decision.strategy.confirmations.join(', ') || '—' : '—'} />
        </div> : null}
        {(() => {
          const reasons = decision.source === 'NEW_LAUNCH' ? launchReasons(decision.launch?.reasons) : decision.source === 'AI' ? decision.ai?.reasons : decision.strategy?.reasons;
          const warnings = decision.source === 'NEW_LAUNCH' ? launchReasons(decision.launch?.warnings) : decision.source === 'AI' ? decision.ai?.warnings : decision.strategy?.warnings;
          return <>
            {Array.isArray(reasons) && reasons.length ? <><strong className="analysis-subtitle">Indokok</strong><ul className="analysis-list">{reasons.slice(0, 8).map((reason: string, index: number) => <li key={index}>{reason}</li>)}</ul></> : null}
            {Array.isArray(warnings) && warnings.length ? <><strong className="analysis-subtitle">Figyelmeztetések</strong><ul className="analysis-list negative-value">{warnings.slice(0, 8).map((warning: string, index: number) => <li key={index}>{warning}</li>)}</ul></> : null}
          </>;
        })()}
      </Panel>
      <Panel title="Biztonság és kockázat">
        <div className="detail-grid">
          <Field label="Eladhatóság" value={security(p.security.sellability)} tone={p.security.sellability === 'VERIFIED' ? 'positive-value' : 'warning-value'} />
          <Field label="Mint authority" value={security(p.security.mintAuthority)} />
          <Field label="Freeze authority" value={security(p.security.freezeAuthority)} />
          <Field label="Token szabvány" value={p.security.tokenStandard === 'spl-token-2022' ? 'Token-2022' : p.security.tokenStandard === 'spl-token' ? 'SPL Token' : UNKNOWN} />
          <Field label="Átutalási korlátozás / kiterjesztések" value={p.security.extensions == null ? UNKNOWN : p.security.extensions.length ? p.security.extensions.join(', ') : 'nincs'} />
          <Field label="Holder koncentráció kockázat" value={p.security.holderConcentrationRisk == null ? UNKNOWN : `${fmt(p.security.holderConcentrationRisk, 0)}/100`} />
          <Field label="Top holder koncentráció kockázat" value={p.security.topHolderConcentrationRisk == null ? UNKNOWN : `${fmt(p.security.topHolderConcentrationRisk, 0)}/100`} />
          <Field label="Likviditás kockázat" value={p.security.liquidityRisk == null ? UNKNOWN : `${fmt(p.security.liquidityRisk, 0)}/100`} />
          <Field label="Kockázati pontszám" value={p.security.riskScore == null ? UNKNOWN : `${fmt(p.security.riskScore, 0)} (${p.security.riskClassification ?? '—'})`} />
          <Field label="Kemény tiltások" value={p.security.hardBlockReasons?.length ? p.security.hardBlockReasons.join(', ') : 'nincs'} />
        </div>
        {p.security.warnings?.length ? <p className="annotation">Figyelmeztetések: {p.security.warnings.join(', ')}</p> : null}
      </Panel>
    </section>

    <section className="panel-grid">
      <Panel title="Belépéskori beállítás">
        {entryConfig ? <div className="detail-grid">
          <Field label="Stop Loss" value={entryConfig.stopLossPercent == null ? '—' : `${entryConfig.stopLossPercent}%`} />
          <Field label="Take Profit" value={entryConfig.takeProfitPercent == null ? '—' : `${entryConfig.takeProfitPercent}%`} />
          <Field label="Trailing aktiválás" value={entryConfig.trailingActivationPercent == null ? 'azonnal' : `${entryConfig.trailingActivationPercent}%`} />
          <Field label="Trailing távolság" value={entryConfig.trailingStopPercent == null ? '—' : `${entryConfig.trailingStopPercent}%`} />
          <Field label="Break-even aktiválás" value={entryConfig.breakEvenActivationPercent == null ? 'kikapcsolva' : `${entryConfig.breakEvenActivationPercent}%`} />
          <Field label="Kockázati szorzó" value={entryConfig.riskMultiplier ?? '—'} />
          <Field label="Döntési küszöb (min. pontszám)" value={entryConfig.minSignalScore ?? '—'} />
          <Field label="Max. pozíció %" value={entryConfig.maxPositionPercent == null ? '—' : `${entryConfig.maxPositionPercent}%`} />
        </div> : <p className="annotation">Ehhez a pozícióhoz nincs rögzített belépéskori beállítás (a funkció bevezetése előtt nyílt).</p>}
      </Panel>
      <Panel title="Aktuális pozíciós beállítás">
        <div className="detail-grid">
          <Field label="Stop Loss (a belépéshez képest)" value={pctText(currentConfig?.stopLossPercent)} />
          <Field label="Take Profit (a belépéshez képest)" value={pctText(currentConfig?.takeProfitPercent)} />
          <Field label="Trailing aktiválás" value={currentConfig?.trailingActivationPercent == null ? 'azonnal' : `${fmt(currentConfig.trailingActivationPercent, 1)}%`} />
          <Field label="Trailing távolság" value={currentConfig?.trailingStopPercent == null ? '—' : `${fmt(currentConfig.trailingStopPercent, 1)}%`} />
          <Field label="Break-even aktiválás" value={currentConfig?.breakEvenActivationPercent == null ? 'kikapcsolva' : `${fmt(currentConfig.breakEvenActivationPercent, 1)}%`} />
        </div>
        <p className="annotation">Ezek a pozícióhoz tartozó, az Exit Engine által használt szintek. A Beállítások későbbi módosítása nem írja át a már nyitott pozíció belépéskori beállítását.</p>
      </Panel>
    </section>

    {p.executionCapacity && (p.executionCapacity.hasEntrySnapshot || p.executionCapacity.legacyEstimate) ? <ExecutionCapacity c={p.executionCapacity} /> : null}
    {p.status === 'CLOSED' && p.exitForensics ? <ExitDiagnostics f={p.exitForensics} /> : null}

    <Panel title="Pozíció események">
      {p.timeline.length ? <ol className="position-timeline">{p.timeline.map((event: any, index: number) => (
        <li key={index} className={`timeline-${String(event.type).toLowerCase()}`}>
          <time>{new Date(event.at).toLocaleTimeString('hu-HU')}</time>
          <strong>{eventLabel(event)}</strong>
          <span>{event.price != null ? formatPrice(event.price) : ''}{event.type === 'EXIT' && event.details?.netPnl != null ? ` · nettó ${money(event.details.netPnl, true)}` : ''}{event.type === 'TRAILING_MOVED' && event.details?.to ? ` · új stop ${formatPrice(event.details.to)}` : ''}</span>
        </li>
      ))}</ol> : <p className="annotation">Még nincs rögzített esemény.</p>}
      <p className="annotation">Csak valós, rögzített események. {p.tradeId ? <Link href={`/trades/${p.tradeId}`}>Kereskedés részletei →</Link> : null} · <Link href={`/tokens/${p.token.address}`}>Token részletei →</Link></p>
    </Panel>
  </>;
}
