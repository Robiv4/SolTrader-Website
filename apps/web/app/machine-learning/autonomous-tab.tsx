'use client';
/* eslint-disable @typescript-eslint/no-explicit-any */

import { useState } from 'react';

import { apiRequest, DataTable, date, EmptyState, ErrorState, fmt, LoadingState, Metric, Panel, Status, useApi } from '../components';

const usd = (value: number | null | undefined) => (value == null ? '—' : `${fmt(value, 2)} USDC`);
const pct = (value: number | null | undefined) => (value == null ? '—' : `${(value * 100).toFixed(1)}%`);
const num = (value: number | null | undefined, digits = 2) => (value == null ? '—' : fmt(value, digits));
const STATUS_TONE: Record<string, string> = { TRAINED: 'neutral', VALIDATED: 'warning', SHADOW: 'info', RETIRED: 'neutral' };
const READINESS_TONE: Record<string, string> = { INSUFFICIENT_DATA: 'danger', RESEARCH_ONLY: 'warning', SHADOW_READY: 'positive' };
const ACTION_TONE: Record<string, string> = { BUY: 'positive', SELL: 'warning', PARTIAL_SELL: 'warning', PROTECTION_SELL: 'danger', HOLD: 'info', WAIT: 'neutral', SKIP: 'neutral', ERROR: 'danger' };
const STRATEGY_LABEL: Record<string, string> = { DEFAULT: 'Régi DEFAULT', ML_V3: 'ML v3 (ML-FEATURES-v1)', ML_COMMUNITY: 'Community ML', ML_AUTONOMOUS: 'Autonomous ML' };

function Backtest({ title, stats }: { title: string; stats: any }) {
  return <tr><td>{title}</td><td>{num(stats?.trades, 0)}</td><td>{usd(stats?.netPnl)}</td><td>{stats?.profitFactor == null ? '—' : num(stats.profitFactor)}</td><td>{usd(stats?.expectancy)}</td><td>{pct(stats?.winRate)}</td><td>{usd(stats?.maxDrawdown)}</td></tr>;
}

/** Autonomous ML (ML_AUTONOMOUS): bundles + gates, own virtual PAPER account, strategy comparison, decisions, coverage. */
export function AutonomousTab({ isAdmin }: { isAdmin: boolean }) {
  const overview = useApi<{ data: any }>('/api/ml/autonomous/overview');
  const comparison = useApi<{ data: any }>('/api/ml/autonomous/comparison?days=90');
  const [message, setMessage] = useState<{ text: string; tone: string } | null>(null);
  if (overview.loading && !overview.data) return <LoadingState />;
  if (overview.error) return <ErrorState message={overview.error} />;
  const d = overview.data?.data;
  if (!d) return <EmptyState message="Nincs adat." />;

  const act = async (pathName: string, method: string, body: Record<string, unknown>, done: string) => {
    setMessage({ text: 'Folyamatban…', tone: 'info' });
    try {
      await apiRequest(pathName, { method, body: JSON.stringify(body) });
      setMessage({ text: done, tone: 'success' });
      overview.refresh();
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : 'Sikertelen', tone: 'error' });
    }
  };

  return <>
    <p className="sfield-help"><strong>Autonomous ML (PAPER).</strong> Egyetlen verziózott modellcsomag dönt a BUY / WAIT / SKIP és a HOLD / PARTIAL_SELL / SELL között, és méretet javasol. A kötelező védelem (csalás- és honeypotvédelem, eladhatóság, likviditás, árhatás, pozícióméret, kitettség, napi veszteség, vészleállítás, elavult piaci adat, technikai fail-safe kilépések) mindig érvényes. Külön virtuális PAPER számlán kereskedik; a PAPER számlát nem érinti, valódi pénz nincs. Új csomag betanítása semmit nem aktivál.</p>
    {message ? <p className={`settings-message ${message.tone}`} role="status">{message.text}</p> : null}

    <Panel title="Modellcsomagok" description="Előléptetés lépésenként (TRAINED → VALIDATED → SHADOW), külön PAPER jóváhagyás és külön kiválasztás – mind kifejezett, e-mailben megerősített admin művelet.">
      {(d.bundles ?? []).length === 0 ? <EmptyState message="Még nincs Autonomous modellcsomag (pnpm ml:autonomous:dataset, majd pnpm ml:autonomous:train)." /> : <DataTable wide headers={['Csomag', 'Állapot', 'Teszt (policy)', 'Stressz ×2 / ×3', 'Walk-forward', 'SHADOW döntés', 'Műveletek']}>
        {d.bundles.map((bundle: any) => {
          const policy = bundle.test?.policy;
          const folds = bundle.test?.walkForward ?? [];
          return <tr key={bundle.version}>
            <td><strong>{bundle.version}</strong><small className="sfield-help" style={{ display: 'block' }}>{bundle.datasetVersion} · {date(bundle.trainedAt)}</small></td>
            <td><Status tone={STATUS_TONE[bundle.status] ?? 'neutral'}>{bundle.status}</Status> <Status tone={READINESS_TONE[bundle.readiness] ?? 'neutral'}>{bundle.readiness}</Status>{bundle.paperApproved ? <> <Status tone="positive">PAPER JÓVÁHAGYVA</Status></> : null}</td>
            <td>{policy ? `${num(policy.trades, 0)} trade · ${usd(policy.netPnl)} · PF ${policy.profitFactor == null ? '—' : num(policy.profitFactor)}` : '—'}<small className="sfield-help" style={{ display: 'block' }}>mind megvéve: {usd(bundle.test?.buyAll?.netPnl)} · véletlen: {usd(bundle.test?.randomSameCount?.netPnl)}</small></td>
            <td>{usd(bundle.test?.liquidityStress?.impactX2?.netPnl)} / {usd(bundle.test?.liquidityStress?.impactX3?.netPnl)}</td>
            <td>{folds.length ? `${folds.filter((fold: any) => fold.netPnl > 0).length} / ${folds.length} pozitív` : '—'}{bundle.test?.overfitting?.risk ? <small className="sfield-help" style={{ display: 'block' }}>túlilleszkedés kockázat</small> : null}</td>
            <td>{num(bundle.shadowDecisions, 0)}</td>
            <td>{isAdmin ? <div className="header-actions">
              {bundle.status === 'TRAINED' ? <button type="button" className="secondary-button" onClick={() => void act(`/api/ml/autonomous/bundles/${bundle.version}/status`, 'POST', { status: 'VALIDATED' }, 'VALIDATED')}>Validálás</button> : null}
              {bundle.status === 'VALIDATED' ? <button type="button" className="secondary-button" onClick={() => void act(`/api/ml/autonomous/bundles/${bundle.version}/status`, 'POST', { status: 'SHADOW' }, 'SHADOW módban fut (nem kereskedik)')}>SHADOW</button> : null}
              {bundle.status === 'SHADOW' && !bundle.paperApproved ? <button type="button" className="secondary-button" onClick={() => void act(`/api/ml/autonomous/bundles/${bundle.version}/paper-approval`, 'POST', {}, 'PAPER-jóváhagyva (még nincs kiválasztva)')}>PAPER jóváhagyás</button> : null}
              {bundle.paperApproved ? <button type="button" className="secondary-button" onClick={() => void act(`/api/ml/autonomous/bundles/${bundle.version}/paper-approval`, 'DELETE', {}, 'Jóváhagyás visszavonva: új belépés nincs, a nyitott pozíciókat a fail-safe védi')}>Visszavonás</button> : null}
              {bundle.paperApproved ? <button type="button" className="primary-button" onClick={() => void act('/api/settings/ml-paper', 'PUT', { strategyMode: 'ML_AUTONOMOUS', autonomousBundleVersion: bundle.version }, 'Kiválasztva: az Autonomous ML PAPER kereskedés ezzel a csomaggal indul')}>Kiválasztás kereskedésre</button> : null}
              {bundle.status !== 'RETIRED' ? <button type="button" className="link-button" onClick={() => void act(`/api/ml/autonomous/bundles/${bundle.version}/status`, 'POST', { status: 'RETIRED' }, 'Kivezetve')}>Kivezetés</button> : null}
            </div> : '—'}</td>
          </tr>;
        })}
      </DataTable>}
    </Panel>

    {d.bundles?.[0] ? <Panel title={`Kiértékelés – ${d.bundles[0].version} (teszt-blokk, offline)`} description="Időrendi teszt-blokk (purge + embargo, tokenenként szétválasztva). Egyenlő 20 USD méretű belépésekkel; a díj, a slippage és az árhatás benne van. A technikailag sikeres tanítás nem jelent kereskedési alkalmasságot.">
      <DataTable wide headers={['Változat', 'Trade', 'Nettó P&L', 'PF', 'Átlagos várható érték', 'Találati arány', 'Max. visszaesés']}>
        <Backtest title="Modell policy" stats={d.bundles[0].test?.policy} />
        <Backtest title="Mind megvéve (összehasonlítás)" stats={d.bundles[0].test?.buyAll} />
        <Backtest title="Véletlen, azonos darabszám" stats={d.bundles[0].test?.randomSameCount} />
        <Backtest title="Likviditási stressz: árhatás ×2" stats={d.bundles[0].test?.liquidityStress?.impactX2} />
        <Backtest title="Likviditási stressz: árhatás ×3" stats={d.bundles[0].test?.liquidityStress?.impactX3} />
        {Object.entries(d.bundles[0].test?.regimes ?? {}).map(([regime, stats]) => <Backtest key={regime} title={`Rezsim: ${regime}`} stats={stats} />)}
        {(d.bundles[0].test?.periods ?? []).map((stats: any) => <Backtest key={stats.fromMs} title={`Időszak: ${date(new Date(stats.fromMs).toISOString())}`} stats={stats} />)}
      </DataTable>
      <p className="sfield-help">Kihagyott lehetőségek (pozitív, de SKIP): {fmt(d.bundles[0].test?.missedOpportunities?.positiveRowsSkipped ?? 0, 0)} · Kilépési policy értéke a tesztben: {num(d.bundles[0].test?.exit?.policyValuePct)} százalékpont (mindig tartás: {num(d.bundles[0].test?.exit?.alwaysHoldValuePct)}).</p>
    </Panel> : null}

    <Panel title="Autonomous virtuális PAPER számla" description="Külön, auditálható számlaazonosító; a felhasználó PAPER számlájától és tradjeitől teljesen elkülönítve.">
      {!d.account ? <EmptyState message="Még nincs Autonomous számla (az első kiválasztás után jön létre)." /> : <div className="metric-grid">
        <Metric label="Számla" value={d.account.accountKey} />
        <Metric label="Kezdő egyenleg / készpénz" value={`${usd(d.account.initialBalance)} / ${usd(d.account.cashBalance)}`} />
        <Metric label="Realizált nettó P&L" value={usd(d.account.realizedPnl)} />
        <Metric label="Díjak / árhatás" value={`${usd(d.account.feesPaid)} / ${usd(d.account.impactCost)}`} />
        <Metric label="Nyitott / lezárt pozíció" value={`${fmt(d.account.openPositions, 0)} / ${fmt(d.account.closedPositions, 0)}`} note={`nyitott bekerülés: ${usd(d.account.openCostBasisUsd)}`} />
      </div>}
    </Panel>

    <Panel title="Stratégiák összehasonlítása (utolsó 90 nap, élő PAPER eredmények)" description="Minden stratégia a saját számlájáról / tradjeiből; a számlák és a P&L nincsenek összekeverve. Az offline backtest, a likviditási stresszteszt és a rezsimenkénti eredmény a csomag tanítási metrikáiban van.">
      {comparison.loading && !comparison.data ? <LoadingState /> : <DataTable wide headers={['Stratégia', 'Számla', 'Trade', 'Nettó P&L', 'PF', 'Átlagos várható érték', 'Találati arány', 'Max. visszaesés', 'Díjak / slippage']}>
        {Object.entries(comparison.data?.data?.strategies ?? {}).map(([key, stats]: [string, any]) => <tr key={key}>
          <td>{STRATEGY_LABEL[key] ?? key}</td><td><small className="sfield-help">{stats.ledger}</small></td><td>{num(stats.trades, 0)}</td><td>{usd(stats.netPnl)}</td><td>{stats.profitFactor == null ? '—' : num(stats.profitFactor)}</td>
          <td>{usd(stats.expectancy)}</td><td>{pct(stats.winRate)}</td><td>{usd(stats.maxDrawdownUsd)}</td><td>{usd(stats.fees)} / {usd(stats.slippage ?? stats.impactCostUsd)}</td>
        </tr>)}
      </DataTable>}
    </Panel>

    <Panel title="Pozíciók">
      {(d.positions ?? []).length === 0 ? <EmptyState message="Nincs Autonomous pozíció." /> : <DataTable wide headers={['Token', 'Csomag', 'Állapot', 'Belépés', 'Mennyiség', 'Realizált P&L', 'Kilépési ok', 'Nyitva / zárva']}>
        {d.positions.map((row: any) => <tr key={row.id}>
          <td>{row.symbol ?? '—'}<small className="sfield-help" style={{ display: 'block' }}>{row.mint.slice(0, 6)}…{row.mint.slice(-4)}</small></td><td>{row.bundleVersion}</td>
          <td><Status tone={row.status === 'OPEN' ? 'info' : 'neutral'}>{row.status}</Status>{row.partiallySold ? <small className="sfield-help" style={{ display: 'block' }}>részben eladva</small> : null}</td>
          <td>{usd(row.entryNotionalUsd)}</td><td>{num(row.quantity, 2)}</td><td className={row.realizedPnlUsd >= 0 ? 'positive-value' : 'negative-value'}>{usd(row.realizedPnlUsd)}</td><td>{row.exitReason ?? '—'}</td>
          <td>{date(row.openedAt)}{row.closedAt ? <small className="sfield-help" style={{ display: 'block' }}>{date(row.closedAt)}</small> : null}</td>
        </tr>)}
      </DataTable>}
    </Panel>

    <Panel title="Legutóbbi döntések" description="Minden döntés: csomagverzió, akció, modellkimenetek, javasolt és végrehajtott méret, feature-hash, végrehajtási eredmény, biztonsági blokkolás.">
      {(d.decisions ?? []).length === 0 ? <EmptyState message="Még nincs döntés." /> : <DataTable wide headers={['Idő', 'Token', 'Fajta', 'Akció', 'Kimenetek', 'Javasolt / végrehajtott', 'Eredmény', 'Feature-hash']}>
        {d.decisions.map((row: any) => <tr key={row.id}>
          <td>{date(row.decidedAt)}<small className="sfield-help" style={{ display: 'block' }}>{row.bundleVersion}</small></td><td>{row.mint.slice(0, 6)}…</td><td>{row.kind}</td>
          <td><Status tone={ACTION_TONE[row.action] ?? 'neutral'}>{row.action}</Status></td>
          <td><small className="sfield-help">{row.outputs ? Object.entries(row.outputs).map(([key, value]) => `${key}: ${typeof value === 'number' ? value.toFixed(3) : String(value)}`).join(' · ') : '—'}</small></td>
          <td>{usd(row.suggestedSizeUsd)} / {usd(row.executedSizeUsd)}</td>
          <td>{row.executionStatus}{row.executionReason ? <small className="sfield-help" style={{ display: 'block' }}>{row.executionReason}</small> : null}</td>
          <td><small className="sfield-help">{row.featureHash?.slice(0, 10) || '—'}</small></td>
        </tr>)}
      </DataTable>}
    </Panel>

    <Panel title="Adatlefedettség" description="Döntési snapshotok, címkézés (kizárási okokkal) és az utolsó dataset lefedettsége. Bizonytalan counterfactual eredmény nem tanítócímke.">
      <div className="dash-grid-2">
        <DataTable headers={['Fajta', 'Kiváltó', 'Snapshot']}>{(d.coverage?.snapshots ?? []).map((row: any) => <tr key={`${row.kind}-${row.trigger}`}><td>{row.kind}</td><td>{row.trigger}</td><td>{fmt(row.count, 0)}</td></tr>)}</DataTable>
        <DataTable headers={['Címke', 'Kizárási ok', 'Darab']}>{(d.coverage?.outcomes ?? []).map((row: any) => <tr key={`${row.status}-${row.exclusionReason}`}><td>{row.status}</td><td>{row.exclusionReason ?? '—'}</td><td>{fmt(row.count, 0)}</td></tr>)}</DataTable>
      </div>
      {d.coverage?.lastDataset ? <p className="sfield-help">Utolsó dataset: {d.coverage.lastDataset.version} · {fmt(d.coverage.lastDataset.rows, 0)} sor · ENTRY {fmt(d.coverage.lastDataset.coverage?.entry?.total ?? 0, 0)} · POSITION {fmt(d.coverage.lastDataset.coverage?.position?.total ?? 0, 0)} · {date(d.coverage.lastDataset.createdAt)}</p> : <p className="sfield-help">Még nem készült Autonomous dataset.</p>}
      {d.health ? <p className="sfield-help">Worker: {fmt(d.health.trackedCandidates ?? 0, 0)} követett jelölt · ENTRY snapshot {fmt(d.health.metrics?.entrySnapshots ?? 0, 0)} · POSITION snapshot {fmt(d.health.metrics?.positionSnapshots ?? 0, 0)} · megelőzött duplikátum {fmt(d.health.metrics?.duplicatePrevented ?? 0, 0)} · valós árra vár {fmt(d.health.metrics?.waitingForQuote ?? 0, 0)}</p> : null}
    </Panel>
  </>;
}
