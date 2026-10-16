'use client';
/* eslint-disable @typescript-eslint/no-explicit-any */

import Link from 'next/link';

import { DataTable, date, EmptyState, ErrorState, fmt, LoadingState, Metric, Panel, Status, useApi } from '../components';
import { launchReasons } from '../locales/position-labels';

const SELLABILITY_LABELS: Record<string, string> = { VERIFIED: 'igazolt', NOT_VERIFIED: 'nem igazolt', FAILED: 'sikertelen' };

/** Analysis-only table: other minimum-liquidity levels over the same past ML BUYs (no trade results). */
function LiquidityComparison({ data, trades }: { data: any; trades: any[] }) {
  if (!data) return null;
  return <Panel title="Likviditási minimumok összehasonlítása (csak elemzés)" description="Ugyanazokra a múltbeli ML BUY döntésekre: hány felelt volna meg az adott minimumnak, hányat akadályozott volna más rögzített kötelező ellenőrzés, és hány lehetett volna végrehajtásra alkalmas. Ezek jogosultsági számok, nem végrehajtott kereskedések.">
    <DataTable wide headers={['Minimum', 'Megfelelt volna', 'Más ellenőrzés tiltotta volna', 'Végrehajtásra alkalmas lehetett', 'Későbbi ármozgás (SHADOW)']}>
      {data.levels.map((level: any) => <tr key={level.minimumUsd}>
        <td>{fmt(level.minimumUsd, 0)} USD</td>
        <td>{fmt(level.meetsMinimum, 0)}</td>
        <td>{fmt(level.blockedByOtherChecks, 0)}</td>
        <td>{fmt(level.potentiallyExecutable, 0)}</td>
        <td>{level.laterPriceMovement.labelled ? <>{pct(level.laterPriceMovement.hitRate)} érte el előbb a +20%-ot, mint a –10%-ot<small className="sfield-help" style={{ display: 'block' }}>{fmt(level.laterPriceMovement.labelled, 0)} címkézett · medián 30 p hozam: {level.laterPriceMovement.median30mReturnPct == null ? '—' : `${fmt(level.laterPriceMovement.median30mReturnPct, 1)}%`}</small></> : 'nincs címkézett kimenet'}</td>
      </tr>)}
    </DataTable>
    <p className="sfield-help">{fmt(data.mlBuyDecisions, 0)} ML BUY döntés · ténylegesen végrehajtva: {fmt(data.actuallyExecuted, 0)} · likviditás ismeretlen: {fmt(data.unknownLiquidity, 0)} · a döntés előtti utolsó launch-snapshotból: {fmt(data.liquidityFromSnapshot, 0)}. A későbbi ármozgás időhelyes SHADOW-kimenet a snapshot-ponttól (a jogosultsághoz nem használjuk), díjak, slippage és Exit Engine nélkül.</p>
    <ul className="analysis-list">{(data.missingData ?? []).map((item: string) => <li key={item} className="sfield-help">Hiányzó adat: {item}</li>)}</ul>
    {trades.length ? <DataTable headers={['Alkalmazott ML minimum', 'Lezárt ML trade', 'Nettó P&L']}>
      {trades.map((row: any) => <tr key={String(row.minLiquidityUsd)}><td>{row.minLiquidityUsd == null ? 'nincs rögzítve (korábbi)' : `${fmt(row.minLiquidityUsd, 0)} USD`}</td><td>{fmt(row.trades, 0)}</td><td>{usd(row.netPnl)}</td></tr>)}
    </DataTable> : null}
  </Panel>;
}

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
        <Metric label="Összes ML BUY" value={fmt(d.mlFunnel?.mlBuy ?? 0, 0)} note={`tiltva: ${fmt(d.mlFunnel?.blocked ?? 0, 0)}`} />
        <Metric label="Likviditási minimum miatt" value={fmt(d.mlFunnel?.blockedByLiquidityMinimum ?? 0, 0)} note={`csak emiatt: ${fmt(d.mlFunnel?.onlyLiquidityMinimum ?? 0, 0)}`} />
        <Metric label="Honeypot / tokenbiztonság miatt" value={fmt(d.mlFunnel?.blockedByTokenSecurity ?? 0, 0)} note={`ebből igazolt honeypot-jel: ${fmt(d.mlFunnel?.honeypotBlocked ?? 0, 0)}`} />
        <Metric label="Kritikus likviditáscsökkenés miatt" value={fmt(d.mlFunnel?.blockedByCriticalLiquidity ?? 0, 0)} />
        <Metric label="Árhatás miatt" value={fmt(d.mlFunnel?.blockedByPriceImpact ?? 0, 0)} />
        <Metric label="Egyéb kockázat / lejárat miatt" value={fmt(d.mlFunnel?.blockedByOtherRiskOrExpiry ?? 0, 0)} />
        <Metric label="Végrehajtás elutasította" value={fmt(d.mlFunnel?.executionRejected ?? 0, 0)} note="limitek, ár, vészleállítás" />
        <Metric label="Megnyitott PAPER pozíció" value={fmt(d.mlFunnel?.positionsOpened ?? 0, 0)} note={`függőben: ${fmt(d.mlFunnel?.pending ?? 0, 0)}`} />
      </div>
      <p className="sfield-help">Egy ML BUY-nak több tiltási oka is lehet, ezért a tiltási csoportok összege meghaladhatja a tiltott döntések számát („csak emiatt” = kizárólag ez az ok).</p>
    </Panel>
    <LiquidityComparison data={d.liquidityComparison} trades={d.mlTradesByMinLiquidity ?? []} />
    <Panel title="Modellverziónkénti PAPER teljesítmény">
      {(d.byModel ?? []).length === 0 ? <EmptyState message="Még nincs lezárt ML PAPER trade." /> : <DataTable headers={['Modell', 'Trade', 'Nettó P&L', 'PF', 'Találati arány', 'Max. visszaesés']}>
        {d.byModel.map((row: any) => <tr key={row.modelVersion}><td>{row.modelVersion}</td><td>{row.trades}</td><td>{usd(row.netPnl)}</td><td>{row.profitFactor == null ? '—' : fmt(row.profitFactor, 2)}</td><td>{pct(row.winRate)}</td><td>{usd(row.maxDrawdownUsd)}</td></tr>)}
      </DataTable>}
    </Panel>
    <Panel title="Legutóbbi ML PAPER döntések">
      {(d.recentDecisions ?? []).length === 0 ? <EmptyState message="Még nincs ML PAPER döntés (az ML stratégia alapból kikapcsolt)." /> : <DataTable wide headers={['Idő', 'Token', 'Modell', 'Valószínűség / küszöb', 'ML döntés', 'Likviditás / ML minimum', 'Alapstratégia (összehasonlítás)', 'Tokenbiztonság', 'Eredmény / ok', 'PAPER pozíció']}>
        {d.recentDecisions.map((row: any) => {
          const outcome = OUTCOME_LABELS[row.outcome] ?? { text: row.outcome, tone: 'neutral' };
          return <tr key={row.id}>
            <td>{date(row.decidedAt)}<small className="sfield-help" style={{ display: 'block' }}>{row.snapshotKind}</small></td>
            <td>{row.mint.slice(0, 6)}…</td>
            <td>{row.modelVersion}</td>
            <td>{row.probability == null ? '—' : `${row.probability.toFixed(3)} / ${row.threshold?.toFixed(2)}`}</td>
            <td><Status tone={row.mlDecision === 'ML_BUY' ? 'positive' : row.mlDecision === 'ML_ERROR' ? 'danger' : 'neutral'}>{row.mlDecision}</Status>{row.errorReason ? <small className="sfield-help" style={{ display: 'block' }}>{row.errorReason}</small> : null}</td>
            <td>{row.baseDecision ?? '—'}{launchReasons((row.baseReasons ?? []).filter((reason: string) => reason.startsWith('COMPARE_'))).map((text) => <small key={text} className="sfield-help" style={{ display: 'block' }}>{text}</small>)}</td>
            <td>{row.liquidityUsd == null ? '—' : `${fmt(row.liquidityUsd, 0)} USD`}<small className="sfield-help" style={{ display: 'block' }}>min. {row.minLiquidityUsd == null ? 'nincs rögzítve' : `${fmt(row.minLiquidityUsd, 0)} USD`}</small></td>
            <td>{SECURITY_LABELS[row.tokenSecurity?.status] ? <Status tone={SECURITY_LABELS[row.tokenSecurity.status].tone}>{row.tokenSecurity.honeypot ? 'HONEYPOT-GYANÚ' : SECURITY_LABELS[row.tokenSecurity.status].text}</Status> : '—'}{(row.tokenSecurity?.blockers ?? []).length ? <small className="sfield-help" style={{ display: 'block' }}>{launchReasons(row.tokenSecurity.blockers).join(', ')}</small> : null}{row.sellability ? <small className="sfield-help" style={{ display: 'block' }}>eladhatóság: {SELLABILITY_LABELS[row.sellability] ?? row.sellability}</small> : null}</td>
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
