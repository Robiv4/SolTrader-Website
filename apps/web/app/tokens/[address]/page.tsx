'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useMemo, useState } from 'react';

import { AiAnalysisPanel } from '../../ai-analysis-panel';
import { date, DataTable, EmptyState, fmt, Stacked, useApi } from '../../components';
import { label } from '../../locales/hu';
import { launchReasons, SECURITY_STATE_LABELS } from '../../locales/position-labels';
import { TradingChart } from '../../ui/chart/trading-chart';
import { formatAge, formatTokenPrice, KeyValueList, shortAddress, Skeleton, StatusBadge, TabNavigation, type TabItem } from '../../ui/primitives';
import { TokenHeader } from '../../ui/token/token-header';
import { TokenSidePanel } from '../../ui/token/token-side-panel';
import { SOURCE_LABELS, stringList, type TokenDetail, type TokenTrading } from '../../ui/token/token-types';
import { ScoreBar } from '../../ui-cards';

const RISK_FACTOR_LABELS: Record<string, string> = {
  liquidityRisk: 'Likviditás', liquidityConcentrationRisk: 'Likviditás koncentráció', tokenAgeRisk: 'Token életkor', poolConditionRisk: 'Pool állapot',
  holderDistributionRisk: 'Holder eloszlás', topHolderConcentrationRisk: 'Top holder koncentráció', mintAuthorityRisk: 'Mint authority', freezeAuthorityRisk: 'Freeze authority',
  metadataAnomalyRisk: 'Metaadat anomália', volatilityRisk: 'Volatilitás', volumeLiquidityRisk: 'Forgalom / likviditás', priceImpactRisk: 'Árhatás',
  suspiciousActivityRisk: 'Gyanús aktivitás', sellabilityRisk: 'Eladhatóság',
};

interface SocialLatest {
  socialScore: number | null; momentumScore: number | null; qualityScore: number | null; spamScore: number | null; exhaustionScore: number | null; dataQuality: number | null;
  confirmation: string; mentionTrend: string; matchBasis: string; tokenMatchConfidence: number | null; freshness: string; at: string;
  details?: { bySource?: Record<string, { mentions5m?: number; uniqueAuthors5m?: number }>; sources?: Array<{ source: string; available: boolean; state: string }>; reasons?: string[]; warnings?: string[] };
}
interface SocialResponse { latest: SocialLatest | null; links: { twitter: string | null; telegram: string | null; website: string | null } | null }

const CONFIRMATION_LABELS: Record<string, string> = {
  STRONG_CONFIRMATION: 'Erős megerősítés', MODERATE_CONFIRMATION: 'Mérsékelt megerősítés', SOCIAL_LEADING: 'Közösségi figyelem vezet', ONCHAIN_LEADING: 'On-chain aktivitás vezet',
  DIVERGENCE: 'Eltérés', SOCIAL_ONLY_HYPE: 'Csak közösségi hype', WEAK_ACTIVITY: 'Gyenge aktivitás', UNKNOWN: 'Ismeretlen',
};

function SocialTab({ address }: { address: string }) {
  const { data, loading } = useApi<{ data: SocialResponse }>(`/api/tokens/${address}/social`);
  if (loading && !data) return <Skeleton height={160} />;
  const latest = data?.data.latest;
  if (!latest) return <EmptyState message="Ehhez a tokenhez nincs közösségi pillanatkép (nem került közösségi figyelésbe, vagy nincs elérhető forrás)." />;
  const source = (key: string, text: string): [string, string] => {
    const item = latest.details?.bySource?.[key];
    const provider = latest.details?.sources?.find((entry) => entry.source === key);
    return [text, provider?.available ? `${item?.mentions5m ?? '—'} említés / 5 perc · ${item?.uniqueAuthors5m ?? '—'} szerző` : provider ? `nem elérhető (${provider.state})` : 'nincs adat'];
  };
  return <div className="tab-grid">
    <div>
      <p className="muted small-print" style={{ marginTop: 0 }}>Determinisztikus mérés (AI nélkül). Megfigyelés – önmagában nem vételi jel, és a biztonsági szabályokat nem írja felül.</p>
      <div className="score-grid">
        <ScoreBar label="Social Score" value={latest.socialScore} />
        <ScoreBar label="Lendület" value={latest.momentumScore} />
        <ScoreBar label="Minőség" value={latest.qualityScore} />
        <ScoreBar label="Spam-valószínűség (alacsony = jó)" value={latest.spamScore} invert />
        <ScoreBar label="Kimerülés (alacsony = jó)" value={latest.exhaustionScore} invert />
        <ScoreBar label="Adatminőség" value={latest.dataQuality} />
      </div>
    </div>
    <KeyValueList items={[
      ['Megerősítés', CONFIRMATION_LABELS[latest.confirmation] ?? latest.confirmation],
      source('X', 'X'),
      source('TELEGRAM', 'Telegram'),
      ['Frissesség', `${latest.freshness} · ${date(latest.at)}`],
      ['Hivatalos linkek', data?.data.links ? [data.data.links.twitter ? `X: @${data.data.links.twitter}` : null, data.data.links.telegram ? `TG: ${data.data.links.telegram}` : null, data.data.links.website].filter(Boolean).join(' · ') || 'nincs megadva' : 'nem ismert'],
    ]} />
  </div>;
}

type TabId = 'overview' | 'risk' | 'launch' | 'social' | 'ml' | 'paper' | 'history';

export default function TokenDetailPage() {
  const params = useParams<{ address: string }>();
  const address = params.address;
  const { data, error, loading } = useApi<{ data: TokenDetail }>(`/api/tokens/${address}`);
  const trading = useApi<{ data: TokenTrading }>(`/api/tokens/${address}/trading`);
  const [tab, setTab] = useState<TabId>('overview');
  const token = data?.data ?? null;
  const tradingData = trading.data?.data ?? null;

  const tabs = useMemo<Array<TabItem<TabId>>>(() => {
    if (!token) return [];
    const list: Array<TabItem<TabId>> = [{ id: 'overview', label: 'Áttekintés' }, { id: 'risk', label: 'Biztonság és kockázat' }];
    if (token.launch) list.push({ id: 'launch', label: 'New Launch elemzés' }, { id: 'social', label: 'Közösségi adatok' });
    if (tradingData?.ml.paperDecision || tradingData?.ml.shadowPrediction) list.push({ id: 'ml', label: 'ML-elemzés' });
    list.push({ id: 'paper', label: 'PAPER előzmények', count: tradingData?.paperTrades.length ?? null });
    if (token.signals.length || token.aiAnalysis) list.push({ id: 'history', label: 'Korábbi jelzések', count: token.signals.length });
    return list;
  }, [token, tradingData]);

  if (loading && !token) return <div className="token-page"><Skeleton height={86} radius={14} /><div className="token-layout"><Skeleton height={480} radius={14} /><Skeleton height={480} radius={14} /></div></div>;
  if (error && !token) return <EmptyState message={error === 'Token not found' ? 'Ezt a tokent a rendszer még nem látta (a New Launch észlelés sem).' : error} />;
  if (!token) return null;

  const launch = token.launch;
  const decision = launch?.decision ?? null;
  const risk = token.riskAssessments[0] ?? null;
  const security = launch?.security ?? null;
  const securityState = (value: unknown) => (value === true ? 'REVOKED' : value === false ? 'ACTIVE' : 'UNKNOWN');
  const activeTab = tabs.some((item) => item.id === tab) ? tab : 'overview';

  return <div className="token-page">
    <TokenHeader token={token} />
    <div className="token-layout">
      <TradingChart address={address} />
      <TokenSidePanel token={token} trading={tradingData} />
    </div>

    <section className="tcard token-tabs">
      <TabNavigation label="Token részletek" tabs={tabs} active={activeTab} onChange={setTab} />
      <div className="tab-panel" role="tabpanel" id={`panel-${activeTab}`} aria-labelledby={`tab-${activeTab}`}>
        {activeTab === 'overview' ? <div className="tab-grid">
          <KeyValueList items={[
            ['Név', token.name ?? '—'], ['Szimbólum', token.symbol ?? '—'], ['Tizedesjegyek', token.decimals ?? '—'],
            ['Forrás / DEX', launch ? SOURCE_LABELS[launch.source] ?? launch.source : token.dexId ?? '—'],
            ['Pool / bonding curve', token.poolAddress ? <span key="pool" className="mono" title={token.poolAddress}>{shortAddress(token.poolAddress, 6, 6)}</span> : '—'],
            launch?.creator ? ['Létrehozó', <span key="creator" className="mono" title={launch.creator}>{shortAddress(launch.creator, 6, 6)}</span>] : null,
          ]} />
          <KeyValueList items={[
            ['Életkor', formatAge(launch?.ageSeconds ?? token.tokenAgeSeconds)],
            launch ? ['Észlelve', date(launch.detectedAt)] : null,
            launch?.detectedPriceUsd ? ['Ár észleléskor', formatTokenPrice(launch.detectedPriceUsd)] : null,
            ['Adatforrás', token.dataSource === 'MARKET_DATA' ? 'piaci adat' : token.dataSource === 'LAUNCH' ? 'launch tranzakció-folyam' : 'token adatbázis'],
            ['Utolsó frissítés', token.lastUpdatedAt ? date(token.lastUpdatedAt) : '—'],
          ]} />
        </div> : null}

        {activeTab === 'risk' ? <div className="tab-grid">
          <KeyValueList items={[
            ['Eladhatóság', SECURITY_STATE_LABELS[String(security?.sellability ?? 'UNKNOWN')] ?? 'Ismeretlen'],
            ['Mint authority', SECURITY_STATE_LABELS[securityState(security?.mintAuthorityRevoked)]],
            ['Freeze authority', SECURITY_STATE_LABELS[securityState(security?.freezeAuthorityRevoked)]],
            ['Token szabvány', security?.tokenProgram === 'spl-token-2022' ? 'Token-2022' : security?.tokenProgram === 'spl-token' ? 'SPL Token' : 'Ismeretlen'],
            ['Kockázati pontszám', decision?.riskScore != null ? `${fmt(decision.riskScore, 0)} (${decision.riskClassification === 'BLOCKED' ? 'feltételre vár' : label(decision.riskClassification ?? '—')})` : risk?.riskScore != null ? fmt(risk.riskScore, 0) : 'Ismeretlen'],
          ]} />
          <div>
            {risk?.factors && Object.keys(risk.factors).length ? <div className="score-grid">{Object.entries(risk.factors).map(([factor, value]) => <ScoreBar key={factor} label={RISK_FACTOR_LABELS[factor] ?? factor} value={value} invert />)}</div>
              : <p className="muted">Részletes kockázati tényezők nincsenek (a New Launch tokeneket a New Launch stratégia értékeli).</p>}
            {stringList(risk?.hardBlockReasons).length ? <p className="notice notice-negative">Kemény tiltás: {stringList(risk?.hardBlockReasons).join(', ')}</p> : null}
            {decision && launchReasons(decision.warnings).length ? <p className="notice notice-warning">Figyelmeztetések: {launchReasons(decision.warnings).slice(0, 6).join(', ')}</p> : null}
          </div>
        </div> : null}

        {activeTab === 'launch' && launch ? (decision ? <div className="tab-grid">
          <div className="score-grid">
            <ScoreBar label="Launch Score" value={decision.score} />
            <ScoreBar label="Launch momentum" value={decision.launchMomentumScore} />
            <ScoreBar label="Vásárlói minőség" value={decision.buyerQualityScore} />
            <ScoreBar label="Vételi nyomás" value={decision.buyPressureScore} />
            <ScoreBar label="Likviditás minőség" value={decision.liquidityScore} />
            <ScoreBar label="Biztonság" value={decision.securityScore} />
            <ScoreBar label="Kifáradás (alacsony = jó)" value={decision.exhaustionScore} invert />
            <ScoreBar label="Adatminőség" value={decision.dataQuality} />
          </div>
          <div>
            <h4 className="tab-subtitle">Indokok</h4>
            <ul className="side-list">{launchReasons(decision.reasons).slice(0, 8).map((reason) => <li key={reason}>{reason}</li>)}</ul>
            <small className="muted">Utolsó döntés: {date(decision.decisionAt)} · {decision.status}</small>
          </div>
        </div> : <EmptyState message="A New Launch stratégia még nem értékelte ezt a tokent a fiókodban (vagy ki van kapcsolva)." />) : null}

        {activeTab === 'social' ? <SocialTab address={address} /> : null}

        {activeTab === 'ml' ? <div className="tab-grid">
          {tradingData?.ml.paperDecision ? <KeyValueList items={[
            ['ML PAPER döntés', tradingData.ml.paperDecision.mlDecision],
            ['Valószínűség / küszöb', `${tradingData.ml.paperDecision.probability?.toFixed(3) ?? '—'} / ${tradingData.ml.paperDecision.threshold?.toFixed(2) ?? '—'}`],
            ['Döntési pont', `${tradingData.ml.paperDecision.snapshotKind} · ${date(tradingData.ml.paperDecision.decidedAt)}`],
            ['Alapstratégia ugyanekkor', tradingData.ml.paperDecision.baseDecision ?? '—'],
            ['Eredmény', `${tradingData.ml.paperDecision.outcome}${tradingData.ml.paperDecision.executionReason ? ` · ${tradingData.ml.paperDecision.executionReason}` : ''}`],
            tradingData.ml.paperDecision.errorReason ? ['Hiba / kihagyás oka', tradingData.ml.paperDecision.errorReason] : null,
            ['Modell', tradingData.ml.paperDecision.modelVersion],
          ]} /> : <p className="muted">Ehhez a tokenhez nem született ML PAPER döntés (az ML stratégia nincs kiválasztva).</p>}
          {tradingData?.ml.shadowPrediction ? <KeyValueList items={[
            ['SHADOW előrejelzés', tradingData.ml.shadowPrediction.predictedClass],
            ['Valószínűség', tradingData.ml.shadowPrediction.probability?.toFixed(3) ?? '—'],
            ['ML pontszám', `${tradingData.ml.shadowPrediction.mlEntryScore}/100`],
            ['Időpont', date(tradingData.ml.shadowPrediction.predictedAt)],
            ['Modell', tradingData.ml.shadowPrediction.modelVersion],
          ]} /> : null}
        </div> : null}

        {activeTab === 'paper' ? (tradingData?.paperTrades.length ? <DataTable headers={['Belépés', 'Kilépés', 'Méret', 'Nettó P&L', 'Kilépés oka', 'Stratégia']}>
          {tradingData.paperTrades.map((trade) => <tr key={trade.id}>
            <td><Stacked top={formatTokenPrice(trade.entry)} bottom={trade.entryAt ? date(trade.entryAt) : '—'} /></td>
            <td><Stacked top={trade.exit ? formatTokenPrice(trade.exit) : <StatusBadge tone="info">NYITOTT</StatusBadge>} bottom={trade.exitAt ? date(trade.exitAt) : ''} /></td>
            <td>{trade.size !== null ? `${fmt(trade.size)} USDC` : '—'}</td>
            <td className={trade.netPnl !== null && trade.netPnl > 0 ? 'positive-value' : trade.netPnl !== null && trade.netPnl < 0 ? 'negative-value' : ''}>{trade.netPnl !== null ? `${fmt(trade.netPnl)} USDC` : '—'}</td>
            <td>{trade.exitReason ?? '—'}</td>
            <td>{trade.entryStrategy === 'ML' ? `ML (${trade.mlModelVersion ?? '?'})` : 'Alap'}{trade.positionId ? <> · <Link className="table-link" href={`/positions/${trade.positionId}`}>pozíció</Link></> : null}</td>
          </tr>)}
        </DataTable> : <EmptyState message="Ehhez a tokenhez még nem volt PAPER kereskedésed." />) : null}

        {activeTab === 'history' ? <>
          {token.aiAnalysis ? <AiAnalysisPanel analysis={token.aiAnalysis as never} decisionMode="STRATEGY" /> : null}
          {token.signals.length ? <DataTable headers={['Stratégia', 'Irány', 'Pontszám · kockázat', 'Időpont']}>
            {token.signals.slice(0, 15).map((signal) => <tr key={signal.id}>
              <td>{String(signal.strategyName ?? signal.signalType ?? '—').replace('Strategy', '')}</td>
              <td>{label(signal.direction ?? '—')}</td>
              <td>{`${fmt(signal.score, 0)} · ${fmt(signal.riskScore, 0)}`}</td>
              <td>{date(signal.createdAt)}</td>
            </tr>)}
          </DataTable> : null}
          <p className="muted small-print">Történeti adatok a megszüntetett tokenfigyelő / stratégia időszakából.</p>
        </> : null}
      </div>
    </section>
  </div>;
}
