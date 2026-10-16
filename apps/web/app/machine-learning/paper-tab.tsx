'use client';
/* eslint-disable @typescript-eslint/no-explicit-any */

import Link from 'next/link';

import { DataTable, date, EmptyState, ErrorState, fmt, LoadingState, Metric, Panel, Status, useApi } from '../components';
import { launchReasons } from '../locales/position-labels';

const SECURITY_LABELS: Record<string, { text: string; tone: string }> = {
  PASSED: { text: 'RENDBEN', tone: 'positive' }, BLOCKED: { text: 'TILTVA', tone: 'danger' }, PENDING: { text: 'NEM IGAZOLT', tone: 'warning' }, NOT_CHECKED: { text: 'NEM KELLETT', tone: 'neutral' },
};

const pct = (value: number | null | undefined) => (value == null ? '—' : `${(value * 100).toFixed(1)}%`);
const usd = (value: number | null | undefined) => (value == null ? '—' : `${fmt(value, 2)} USDC`);
const OUTCOME_LABELS: Record<string, { text: string; tone: string }> = {
  EXECUTED: { text: 'VÉGREHAJTVA', tone: 'positive' }, SIGNALED: { text: 'JELZÉS KIADVA', tone: 'info' }, PENDING: { text: 'BIZTONSÁGRA VÁR', tone: 'warning' },
  SAFETY_BLOCKED: { text: 'BIZTONSÁG TILTOTTA', tone: 'danger' }, EXPIRED: { text: 'LEJÁRT', tone: 'neutral' }, EXECUTION_REJECTED: { text: 'VÉGREHAJTÁS ELUTASÍTVA', tone: 'warning' },
  SKIPPED: { text: 'ML SKIP', tone: 'neutral' }, ERROR: { text: 'ML HIBA', tone: 'danger' },
};

function StrategyStats({ title, stats }: { title: string; stats: any }) {
  return <Panel title={title} description={stats?.sufficientSample ? undefined : 'Kis minta (< 30 lezárt trade): nem von le következtetést.'}>
    <div className="metric-grid">
      <Metric label="Lezárt trade" value={fmt(stats?.trades ?? 0, 0)} />
      <Metric label="Realizált nettó P&L" value={usd(stats?.netPnl)} />
      <Metric label="Profit Factor" value={stats?.profitFactor == null ? '—' : fmt(stats.profitFactor, 2)} />
      <Metric label="Találati arány" value={pct(stats?.winRate)} />
      <Metric label="Max. visszaesés" value={usd(stats?.maxDrawdownUsd)} />
      <Metric label="Díjak / szimulált slippage" value={`${fmt(stats?.fees ?? 0, 2)} / ${fmt(stats?.slippage ?? 0, 2)}`} />
    </div>
  </Panel>;
}

/** PAPER strategy comparison (real closed PAPER trades) + training data overview (SHADOW collection). */
export function PaperTab() {
  const { data, error, loading } = useApi<{ data: any }>('/api/ml/paper?days=90');
  if (loading && !data) return <LoadingState />;
  if (error) return <ErrorState message={error} />;
  const d = data?.data;
  if (!d) return <EmptyState message="Nincs adat." />;
  const t = d.training ?? {};
  const decisionTotals = (d.decisions ?? []).reduce((acc: Record<string, number>, item: any) => ({ ...acc, [item.mlDecision]: (acc[item.mlDecision] ?? 0) + item.count }), {});
  return <>
    <p className="sfield-help"><strong>ML belépés + szabályalapú kilépés.</strong> Az ML stratégia kizárólag a vételi döntést hozza (az alapstratégia döntése csak összehasonlítás); a kilépést a közös, szabályalapú Exit Engine végzi. ML-alapú eladás (ML SELL) még nincs. Három külön adatréteg: <em>SHADOW-előrejelzések</em> (minden jelölt, kereskedés nélkül), <em>ML PAPER döntések</em> (az ML stratégiát választók jelöltjei) és <em>lezárt PAPER tradek</em> (valós szimulált eredmény, utolsó {d.periodDays} nap).</p>
    <h3 className="section-title">3. Lezárt PAPER tradek – stratégiánként külön</h3>
    <div className="dash-grid-2">
      <StrategyStats title="Alapstratégia (DEFAULT) PAPER" stats={d.strategies?.DEFAULT} />
      <StrategyStats title="ML belépések PAPER (csak ML-eredetű tradek)" stats={d.strategies?.ML} />
    </div>
    <h3 className="section-title">2. ML PAPER döntések</h3>
    <Panel title="ML vételi döntések" description="Egy döntés jelöltenként, a modell snapshot-időpontjában. A stratégiai döntést kizárólag az ML hozza (az alapstratégia nem vétózhat); ML BUY után csak a kötelező csalás- és honeypotvédelem, a piaci / végrehajtási feltételek és a kockázati limitek állíthatják meg.">
      <div className="metric-grid">
        <Metric label="ML BUY" value={fmt(decisionTotals.ML_BUY ?? 0, 0)} />
        <Metric label="ML SKIP" value={fmt(decisionTotals.ML_SKIP ?? 0, 0)} />
        <Metric label="ML hiba" value={fmt(decisionTotals.ML_ERROR ?? 0, 0)} />
      </div>
      <h4 className="section-title">ML BUY tölcsér (utolsó {d.periodDays} nap)</h4>
      <div className="metric-grid">
        <Metric label="ML BUY jelzés" value={fmt(d.mlFunnel?.mlBuy ?? 0, 0)} />
        <Metric label="Tokenbiztonság (csalás / honeypot) tiltotta" value={fmt(d.mlFunnel?.blockedByTokenSecurity ?? 0, 0)} note={`ebből igazolt honeypot-jel: ${fmt(d.mlFunnel?.honeypotBlocked ?? 0, 0)}`} />
        <Metric label="Piac / kockázat / lejárat" value={fmt(d.mlFunnel?.blockedByMarketOrRisk ?? 0, 0)} />
        <Metric label="Végrehajtás elutasította" value={fmt(d.mlFunnel?.executionRejected ?? 0, 0)} note="limitek, ár, vészleállítás" />
        <Metric label="Megnyitott PAPER pozíció" value={fmt(d.mlFunnel?.positionsOpened ?? 0, 0)} />
        <Metric label="Függőben" value={fmt(d.mlFunnel?.pending ?? 0, 0)} />
      </div>
    </Panel>
    <Panel title="Modellverziónkénti PAPER teljesítmény">
      {(d.byModel ?? []).length === 0 ? <EmptyState message="Még nincs lezárt ML PAPER trade." /> : <DataTable headers={['Modell', 'Trade', 'Nettó P&L', 'PF', 'Találati arány', 'Max. visszaesés']}>
        {d.byModel.map((row: any) => <tr key={row.modelVersion}><td>{row.modelVersion}</td><td>{row.trades}</td><td>{usd(row.netPnl)}</td><td>{row.profitFactor == null ? '—' : fmt(row.profitFactor, 2)}</td><td>{pct(row.winRate)}</td><td>{usd(row.maxDrawdownUsd)}</td></tr>)}
      </DataTable>}
    </Panel>
    <Panel title="Legutóbbi ML PAPER döntések">
      {(d.recentDecisions ?? []).length === 0 ? <EmptyState message="Még nincs ML PAPER döntés (az ML stratégia alapból kikapcsolt)." /> : <DataTable wide headers={['Idő', 'Token', 'Modell', 'Valószínűség / küszöb', 'ML döntés', 'Alapstratégia (összehasonlítás)', 'Tokenbiztonság', 'Eredmény / ok', 'PAPER pozíció']}>
        {d.recentDecisions.map((row: any) => {
          const outcome = OUTCOME_LABELS[row.outcome] ?? { text: row.outcome, tone: 'neutral' };
          return <tr key={row.id}>
            <td>{date(row.decidedAt)}<small className="sfield-help" style={{ display: 'block' }}>{row.snapshotKind}</small></td>
            <td>{row.mint.slice(0, 6)}…</td>
            <td>{row.modelVersion}</td>
            <td>{row.probability == null ? '—' : `${row.probability.toFixed(3)} / ${row.threshold?.toFixed(2)}`}</td>
            <td><Status tone={row.mlDecision === 'ML_BUY' ? 'positive' : row.mlDecision === 'ML_ERROR' ? 'danger' : 'neutral'}>{row.mlDecision}</Status>{row.errorReason ? <small className="sfield-help" style={{ display: 'block' }}>{row.errorReason}</small> : null}</td>
            <td>{row.baseDecision ?? '—'}{launchReasons((row.baseReasons ?? []).filter((reason: string) => reason.startsWith('COMPARE_'))).map((text) => <small key={text} className="sfield-help" style={{ display: 'block' }}>{text}</small>)}</td>
            <td>{SECURITY_LABELS[row.tokenSecurity?.status] ? <Status tone={SECURITY_LABELS[row.tokenSecurity.status].tone}>{row.tokenSecurity.honeypot ? 'HONEYPOT-GYANÚ' : SECURITY_LABELS[row.tokenSecurity.status].text}</Status> : '—'}{(row.tokenSecurity?.blockers ?? []).length ? <small className="sfield-help" style={{ display: 'block' }}>{launchReasons(row.tokenSecurity.blockers).join(', ')}</small> : null}</td>
            <td><Status tone={outcome.tone}>{outcome.text}</Status>{(row.safetyBlockers ?? []).length ? <small className="sfield-help" style={{ display: 'block' }}>{launchReasons(row.safetyBlockers).join(', ')}</small> : row.executionReason ? <small className="sfield-help" style={{ display: 'block' }}>{launchReasons(String(row.executionReason).split(/[,:]\s*/).filter(Boolean)).join(', ')}</small> : null}</td>
            <td>{row.trade ? <><Link className="table-link" href={`/positions/${row.trade.positionId}`}>{row.trade.status === 'OPEN' ? 'nyitott' : 'lezárt'}</Link>{row.trade.netPnl != null ? <small className={row.trade.netPnl >= 0 ? 'positive-value' : 'negative-value'} style={{ display: 'block' }}>{usd(row.trade.netPnl)}</small> : null}<small className="sfield-help" style={{ display: 'block' }}>{row.trade.modelVersion}</small></> : 'nincs'}</td>
          </tr>;
        })}
      </DataTable>}
    </Panel>
    <h3 className="section-title">1. SHADOW-előrejelzések (nincs kereskedés)</h3>
    <Panel title="SHADOW-előrejelzések modellenként" description="Minden New Launch jelöltre készül, kereskedés nélkül – nem azonos az ML PAPER döntésekkel és a tényleges tradekkel.">
      {(d.shadowPredictions ?? []).length === 0 ? <EmptyState message="Ebben az időszakban nem készült SHADOW-előrejelzés." /> : <DataTable headers={['Modell', 'Előrejelzett osztály', 'Darab']}>
        {d.shadowPredictions.map((row: any) => <tr key={`${row.modelVersion}-${row.predictedClass}`}><td>{row.modelVersion}</td><td>{row.predictedClass}</td><td>{fmt(row.count, 0)}</td></tr>)}
      </DataTable>}
    </Panel>
    <Panel title="Tanítóadat a következő modellhez" description="SHADOW adatgyűjtés minden New Launch jelöltről (a kihagyottakról is), az aktív stratégiától függetlenül. Új modell csak kézi tanítás, validáció, SHADOW teszt és admin jóváhagyás után kerülhet PAPER használatba – automatikus modellcsere nincs.">
      <div className="metric-grid">
        <Metric label="AGE_30S jelöltek" value={fmt(t.snapshots?.AGE_30S ?? 0, 0)} note={`alkalmas: ${fmt(t.validForTraining?.true ?? 0, 0)} · alkalmatlan: ${fmt(t.validForTraining?.false ?? 0, 0)}`} />
        <Metric label="Címkézett jelöltek" value={fmt(t.labelledCandidates ?? 0, 0)} note="COMPLETE / PARTIAL kimenettel" />
        <Metric label="Lezárt ML PAPER trade" value={fmt(t.mlPaperTradesClosed ?? 0, 0)} note="csak kutatási célhoz (torzított minta)" />
        <Metric label="Lefedett időszak" value={t.coverage?.from ? `${date(t.coverage.from)} – ${date(t.coverage.to)}` : '—'} />
        <Metric label="Utolsó dataset" value={t.lastDataset?.version ?? '—'} note={t.lastDataset ? `${fmt(t.lastDataset.rows, 0)} sor · ${t.lastDataset.readiness ?? ''}` : 'még nem készült'} />
        <Metric label="Új alkalmas jelölt azóta" value={t.newValidCandidatesSinceLastDataset == null ? '—' : fmt(t.newValidCandidatesSinceLastDataset, 0)} />
      </div>
      {(t.qualityIssues ?? []).length ? <ul className="analysis-list">{t.qualityIssues.map((issue: string) => <li key={issue} className="sfield-help">⚠ {issue}</li>)}</ul> : <p className="sfield-help">Nincs ismert adatminőségi akadály.</p>}
    </Panel>
  </>;
}
