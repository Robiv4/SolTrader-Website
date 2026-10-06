'use client';
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BarChart3, Check, Copy, Droplets, LineChart, Rocket, Wallet } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState, type ReactNode } from 'react';

import { AiAnalysisPanel } from '../../ai-analysis-panel';
import { TokenAvatar } from '../../avatars';
import { date, DataTable, EmptyState, ErrorState, formatPrice, fmt, LoadingState, PageHeader, Stacked, Status, useApi } from '../../components';
import { label } from '../../locales/hu';
import { launchReasons, SECURITY_STATE_LABELS } from '../../locales/position-labels';
import { PriceChart } from '../../price-chart';
import { SignalAnalysisPanel } from '../../signal-analysis-panel';
import { DashCard, Kpi, ScoreBar, StatList } from '../../ui-cards';

const RISK_FACTOR_LABELS: Record<string, string> = {
  liquidityRisk: 'Likviditás',
  liquidityConcentrationRisk: 'Likviditás koncentráció',
  tokenAgeRisk: 'Token életkor',
  poolConditionRisk: 'Pool állapot',
  holderDistributionRisk: 'Holder eloszlás',
  topHolderConcentrationRisk: 'Top holder koncentráció',
  mintAuthorityRisk: 'Mint authority',
  freezeAuthorityRisk: 'Freeze authority',
  metadataAnomalyRisk: 'Metaadat anomália',
  volatilityRisk: 'Volatilitás',
  volumeLiquidityRisk: 'Forgalom / likviditás',
  priceImpactRisk: 'Árhatás',
  suspiciousActivityRisk: 'Gyanús aktivitás',
  sellabilityRisk: 'Eladhatóság',
};
const SOURCE_LABELS: Record<string, string> = { PUMP_FUN: 'Pump.fun', RAYDIUM: 'Raydium', METEORA: 'Meteora' };
const DECISION_LABELS: Record<string, { text: string; tone: string }> = { BUY: { text: 'VÉTEL', tone: 'positive' }, WATCH: { text: 'FIGYELÉS', tone: 'warning' }, REJECT: { text: 'ELUTASÍTVA', tone: 'danger' } };
const RANGES: Array<[string, string, number]> = [['15m', '15 perc', 15 * 60_000], ['1h', '1 óra', 3_600_000], ['6h', '6 óra', 6 * 3_600_000], ['24h', '24 óra', 24 * 3_600_000]];
const NO_LEVELS = { entry: null, stopLoss: null, takeProfit: null, trailingStop: null, breakEvenActivation: null, trailingActivation: null, current: null, exit: null };

function toStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item)) : [];
}

function riskTone(decision: string | undefined) {
  if (decision === 'ACCEPT') return 'positive';
  if (decision === 'WATCH') return 'warning';
  if (decision === 'REJECT') return 'danger';
  return 'neutral';
}

function directionTone(direction: string | null | undefined) {
  if (direction === 'BUY') return 'positive';
  if (direction === 'SELL') return 'danger';
  if (direction === 'WATCH') return 'warning';
  return 'neutral';
}

function age(seconds: number | null | undefined) {
  if (seconds == null) return '—';
  if (seconds < 60) return `${seconds} mp`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} perc`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} óra ${Math.floor((seconds % 3600) / 60)} perc`;
  return `${Math.floor(seconds / 86_400)} nap`;
}

const usd = (value: number | null | undefined) => (value == null ? '—' : `$${fmt(value, value >= 100 ? 0 : 2)}`);
const pct = (value: number | null | undefined) => (value == null ? '—' : `${value > 0 ? '+' : ''}${fmt(value)}%`);

function CopyAddress({ address }: { address: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await globalThis.navigator.clipboard.writeText(address);
      setCopied(true);
      globalThis.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  };
  return <button type="button" className="address-chip" onClick={() => void copy()} aria-label="Tokencím másolása" title={address}>
    <span>{address.slice(0, 6)}…{address.slice(-6)}</span>{copied ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}
    <span className="sr-only" role="status" aria-live="polite">{copied ? 'Cím kimásolva' : ''}</span>
  </button>;
}

const CONFIRMATION_LABELS: Record<string, { text: string; tone: string }> = {
  STRONG_CONFIRMATION: { text: 'Erős megerősítés', tone: 'positive' }, MODERATE_CONFIRMATION: { text: 'Mérsékelt megerősítés', tone: 'positive' },
  SOCIAL_LEADING: { text: 'Közösségi figyelem vezet', tone: 'info' }, ONCHAIN_LEADING: { text: 'On-chain aktivitás vezet', tone: 'info' },
  DIVERGENCE: { text: 'Eltérés', tone: 'warning' }, SOCIAL_ONLY_HYPE: { text: 'Csak közösségi hype', tone: 'warning' }, WEAK_ACTIVITY: { text: 'Gyenge aktivitás', tone: 'neutral' }, UNKNOWN: { text: 'Ismeretlen', tone: 'neutral' },
};
const FRESHNESS_LABELS: Record<string, string> = { FRESH: 'friss', AGING: 'öregedő', STALE: 'ELAVULT', UNKNOWN: 'ismeretlen' };
const MATCH_LABELS: Record<string, string> = { MINT_ADDRESS: 'mint cím', OFFICIAL_SOCIAL_LINK: 'hivatalos link', EXACT_PROJECT_NAME: 'pontos név', TICKER: 'csak ticker (bizonytalan)', MULTI_SIGNAL_MATCH: 'több jel', UNKNOWN: 'ismeretlen' };

/** Social Intelligence (deterministic, MONITOR_ONLY): measured attention, never a buy signal on its own. */
function SocialCard({ address }: { address: string }) {
  const { data } = useApi<{ data: any }>(`/api/tokens/${address}/social`);
  const social = data?.data;
  const latest = social?.latest;
  const details = latest?.details ?? {};
  const confirmation = CONFIRMATION_LABELS[latest?.confirmation] ?? CONFIRMATION_LABELS.UNKNOWN;
  const sourceRow = (key: string, text: string) => {
    const item = details.bySource?.[key];
    const provider = (details.sources ?? []).find((source: any) => source.source === key);
    return [text, provider?.available ? `${item?.mentions5m ?? '—'} említés / 5 perc · ${item?.uniqueAuthors5m ?? '—'} szerző` : provider ? `nem elérhető (${provider.state})` : 'nincs adat'] as [string, string];
  };
  return <DashCard title="Közösségi intelligencia" description="Determinisztikus mérés (AI nélkül): figyelem, minőség, spam-valószínűség és on-chain megerősítés. Megfigyelés – önmagában nem vételi jel, és a biztonsági / kockázati szabályokat soha nem írja felül."
    action={latest ? <Status tone={confirmation.tone}>{confirmation.text}</Status> : undefined}>
    {!latest ? <EmptyState message={social?.links ? 'Még nincs közösségi pillanatkép (a token nem került közösségi figyelésbe, vagy nincs elérhető forrás).' : 'Nincs közösségi adat ehhez a tokenhez.'} /> : <>
      <div className="score-grid">
        <ScoreBar label="Social Score" value={latest.socialScore} />
        <ScoreBar label="Lendület" value={latest.momentumScore} />
        <ScoreBar label="Minőség" value={latest.qualityScore} />
        <ScoreBar label="Spam-valószínűség (alacsony = jó)" value={latest.spamScore} invert />
        <ScoreBar label="Kimerülés (alacsony = jó)" value={latest.exhaustionScore} invert />
        <ScoreBar label="Adatminőség" value={latest.dataQuality} />
      </div>
      <StatList items={[
        sourceRow('X', 'X'),
        sourceRow('TELEGRAM', 'Telegram'),
        ['Említés-trend', latest.mentionTrend === 'ACCELERATING' ? 'gyorsul' : latest.mentionTrend === 'DECELERATING' ? 'lassul' : latest.mentionTrend === 'STABLE' ? 'stabil' : 'ismeretlen'],
        ['Token-azonosítás', `${MATCH_LABELS[latest.matchBasis] ?? latest.matchBasis}${latest.tokenMatchConfidence != null ? ` · ${fmt(latest.tokenMatchConfidence * 100, 0)}%` : ''}`],
        ['Frissesség', `${FRESHNESS_LABELS[latest.freshness] ?? latest.freshness} · ${date(latest.at)}`],
        ['Hivatalos linkek', social?.links ? [social.links.twitter ? `X: @${social.links.twitter}` : null, social.links.telegram ? `TG: ${social.links.telegram}` : null, social.links.website ?? null].filter(Boolean).join(' · ') || 'nincs megadva' : 'nem ismert'],
      ]} />
      {(details.reasons ?? []).length ? <><strong className="analysis-subtitle">Pozitív jelek</strong><ul className="analysis-list">{details.reasons.map((reason: string) => <li key={reason}>{reason}</li>)}</ul></> : null}
      {(details.warnings ?? []).length ? <><strong className="analysis-subtitle">Figyelmeztetések</strong><ul className="analysis-list">{details.warnings.map((warning: string) => <li key={warning}>{warning}</li>)}</ul></> : null}
    </>}
  </DashCard>;
}

export default function TokenDetailPage() {
  const params = useParams<{ address: string }>();
  const { data, error, loading } = useApi<{ data: any }>(`/api/tokens/${params.address}`);
  const [range, setRange] = useState('1h');
  // A stable window per range selection; refreshed by re-selecting the range.
  const [now] = useState(() => Date.now());
  const rangeMs = RANGES.find(([key]) => key === range)?.[2] ?? 3_600_000;
  const chart = useApi<{ data: { points: Array<{ t: number; price: number }> } }>(`/api/tokens/${params.address}/chart?from=${now - rangeMs}&to=${now}`);

  const header = (title = 'Token részletei', subtitle?: string, action?: ReactNode) => <PageHeader eyebrow="Token részletei" icon={<TokenAvatar address={params.address} symbol={title} size={34} />} title={title} subtitle={subtitle} action={action} />;
  if (loading && !data) return <>{header()}<LoadingState /></>;
  if (error && !data) return <>{header()}<ErrorState message={error === 'Token not found' ? 'Ezt a tokent a rendszer még nem látta (sem a tokenfigyelő, sem az új token észlelés).' : error} /></>;

  const token = data?.data;
  const launch = token?.launch ?? null;
  const launchOnly = token?.dataSource === 'LAUNCH' && !token?.id;
  const latestRisk = token?.riskAssessments?.[0];
  const factors: Record<string, number> = latestRisk?.factors ?? {};
  const warnings = toStringList(latestRisk?.warnings);
  const hardBlocks = toStringList(latestRisk?.hardBlockReasons ?? latestRisk?.rejectionReasons);
  const signals = token?.signals ?? [];
  const snapshot = launch?.snapshot ?? null;
  const decision = launch?.decision ?? null;
  const security = (launch?.security ?? null) as Record<string, any> | null;
  const decisionInfo = decision ? DECISION_LABELS[decision.decision] : null;
  const securityState = (value: boolean | null | undefined) => (value === true ? 'REVOKED' : value === false ? 'ACTIVE' : 'UNKNOWN');

  const action = <div className="header-actions">
    {launch ? <span className="source-badge source-new_launch">ÚJ TOKEN · {SOURCE_LABELS[launch.source] ?? launch.source}</span> : null}
    {token?.openPositionId ? <Link className="primary-button" href={`/positions/${token.openPositionId}`}>Nyitott pozíció →</Link> : null}
  </div>;

  return <>
    {header(token?.symbol ?? params.address, token?.name ?? undefined, action)}
    <div className="token-meta-row">
      <CopyAddress address={token?.address ?? params.address} />
      <span className="token-meta-item">Életkor: <strong>{age(launch?.ageSeconds ?? token?.tokenAgeSeconds)}</strong></span>
      <span className="token-meta-item">Frissítve: <strong>{token?.lastUpdatedAt ? date(token.lastUpdatedAt) : '—'}</strong></span>
      <span className="token-meta-item">Adatforrás: <strong>{token?.dataSource === 'MARKET_DATA' ? 'piaci adat' : token?.dataSource === 'LAUNCH' ? 'launch tranzakció-folyam' : 'token adatbázis'}</strong></span>
    </div>

    <section className="kpi-grid" aria-label="Piaci adatok">
      <Kpi icon={<Wallet size={20} />} label="Ár" value={formatPrice(token?.priceUsd)} tone="brand"
        sub={token?.priceChange1h != null ? <span>{pct(token.priceChange1h)} (1 óra)</span> : undefined}
        note={token?.priceChange24h != null ? `24 óra: ${pct(token.priceChange24h)}` : launch?.detectedPriceUsd ? `észleléskor: ${formatPrice(launch.detectedPriceUsd)}` : undefined} />
      <Kpi icon={<Droplets size={20} />} label="Likviditás" value={usd(token?.liquidityUsd)} note={launch && !token?.id ? 'bonding curve valós tartaléka alapján' : undefined} />
      <Kpi icon={<BarChart3 size={20} />} label={launchOnly ? 'Launch forgalom' : '24 órás forgalom'} value={usd(token?.volume24h)} note={snapshot ? `${snapshot.buyCount ?? 0} vétel · ${snapshot.sellCount ?? 0} eladás` : undefined} />
      <Kpi icon={<LineChart size={20} />} label="Piaci kapitalizáció" value={usd(token?.marketCap)} note={snapshot?.bondingProgress != null ? `bonding curve: ${fmt(snapshot.bondingProgress * 100, 0)}%` : undefined} />
    </section>

    <DashCard title="Árfolyam" description="Valós, eltárolt árpontokból rajzolt vonaldiagram (nincs kitalált gyertya)." className="dash-card-spaced"
      action={<div className="segmented" role="group" aria-label="Időtáv">{RANGES.map(([key, text]) => <button key={key} type="button" className={range === key ? 'selected' : ''} aria-pressed={range === key} onClick={() => setRange(key)}>{text}</button>)}</div>}>
      {chart.loading && !chart.data ? <LoadingState /> : <PriceChart points={chart.data?.data?.points ?? []} levels={NO_LEVELS} />}
    </DashCard>

    {launch ? <section className="dash-grid-2">
      <DashCard title="Új token / Sniper értékelés" description={decision ? `Utolsó döntés: ${date(decision.decisionAt)}` : 'Ehhez a tokenhez még nincs döntés a fiókodban.'}
        action={decisionInfo ? <Status tone={decisionInfo.tone}>{decisionInfo.text}</Status> : undefined}>
        {decision ? <>
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
          {launchReasons(decision.reasons).length ? <><strong className="analysis-subtitle">Indokok</strong><ul className="analysis-list">{launchReasons(decision.reasons).slice(0, 6).map((reason, index) => <li key={index}>{reason}</li>)}</ul></> : null}
          {launchReasons(decision.warnings).length ? <><strong className="analysis-subtitle">Figyelmeztetések</strong><ul className="analysis-list">{launchReasons(decision.warnings).slice(0, 6).map((warning, index) => <li key={index}>{warning}</li>)}</ul></> : null}
        </> : <EmptyState message="Az új token stratégia még nem értékelte ezt a tokent (vagy ki van kapcsolva)." />}
      </DashCard>
      <DashCard title="Launch aktivitás és biztonság" description={`Forrás: ${SOURCE_LABELS[launch.source] ?? launch.source} · észlelve ${date(launch.detectedAt)}`}>
        <StatList items={[
          ['Életkor', age(launch.ageSeconds)],
          ['Vételek / eladások', snapshot ? `${snapshot.buyCount ?? 0} / ${snapshot.sellCount ?? 0}` : '—'],
          ['Egyedi vásárlók / eladók', snapshot ? `${snapshot.uniqueBuyers ?? 'Ismeretlen'} / ${snapshot.uniqueSellers ?? 'Ismeretlen'}` : '—'],
          ['Legnagyobb vásárló részesedése', snapshot?.largestBuyerShare != null ? `${fmt(snapshot.largestBuyerShare * 100, 0)}%` : 'Ismeretlen'],
          ['Eladhatóság', SECURITY_STATE_LABELS[security?.sellability ?? 'UNKNOWN'] ?? 'Ismeretlen'],
          ['Mint authority', SECURITY_STATE_LABELS[securityState(security?.mintAuthorityRevoked)]],
          ['Freeze authority', SECURITY_STATE_LABELS[securityState(security?.freezeAuthorityRevoked)]],
          ['Token szabvány', security?.tokenProgram === 'spl-token-2022' ? 'Token-2022' : security?.tokenProgram === 'spl-token' ? 'SPL Token' : 'Ismeretlen'],
          // BLOCKED here only means a waitable launch condition (e.g. liquidity still low); hard security blocks reject the launch.
          ['Kockázati pontszám', decision?.riskScore != null ? `${fmt(decision.riskScore, 0)} (${decision.riskClassification === 'BLOCKED' ? 'feltételre vár' : label(decision.riskClassification ?? '—')})` : 'Ismeretlen'],
        ]} />
      </DashCard>
    </section> : null}
    {launch ? <SocialCard address={params.address} /> : null}

    {!launchOnly ? <>
      <AiAnalysisPanel analysis={token?.aiAnalysis} decisionMode={token?.decisionMode === 'AI' ? 'AI' : 'STRATEGY'} />
      {token?.decisionMode === 'AI' ? null : <SignalAnalysisPanel decisionMode="STRATEGY" analysis={token?.analysis} riskScore={latestRisk?.riskScore ?? null} riskClassification={latestRisk?.classification ?? null} />}
    </> : null}

    <section className="dash-grid-2">
      <DashCard title="Kockázati tényezők" description={latestRisk ? `Forrás: ${latestRisk.source} · ${date(latestRisk.createdAt)}` : undefined}
        action={latestRisk ? <Status tone={latestRisk.hardBlocked ? 'danger' : riskTone(latestRisk.decision)}>{latestRisk.hardBlocked ? 'Blokkolva' : label(latestRisk.classification ?? latestRisk.decision)}</Status> : undefined}>
        {!latestRisk ? <EmptyState message={launchOnly ? 'Az új tokenek kockázatát az új token stratégia értékeli (lásd fent); teljes kockázati elemzés akkor készül, ha a token a tokenfigyelőbe is bekerül.' : 'Ehhez a tokenhez még nincs kockázati elemzés.'} /> : <>
          <div className="risk-summary">
            <div><span>Kockázati pontszám</span><strong>{fmt(latestRisk.riskScore, 0)}<small>/100</small></strong></div>
            <div><span>Paper döntés</span><strong>{latestRisk.hardBlocked ? 'Blokkolva' : latestRisk.positionMultiplier < 1 ? 'Csökkentett pozíció' : 'Engedélyezve'}</strong></div>
          </div>
          <div className="score-grid">
            {Object.entries(factors).map(([factor, value]) => <ScoreBar key={factor} label={RISK_FACTOR_LABELS[factor] ?? factor} value={value} invert />)}
          </div>
          {hardBlocks.length > 0 ? <p className="settings-warning">Kemény tiltás: {hardBlocks.join(', ')}</p> : null}
          {warnings.length > 0 ? <p className="sfield-help" style={{ marginTop: 12 }}>Figyelmeztetések: {warnings.join(', ')}</p> : null}
        </>}
      </DashCard>

      <DashCard title="Jelzés-előzmények" description="A stratégiák jelzései ennél a tokennél">
        {signals.length === 0 ? <EmptyState message="Ehhez a tokenhez még nem adott jelzést egyik stratégia sem." /> : <DataTable headers={['Stratégia', 'Pontszám · kockázat', 'Időpont']}>
          {signals.slice(0, 10).map((signal: any) => <tr key={signal.id}>
            <td><Stacked top={String(signal.strategyName ?? signal.signalType ?? '—').replace('Strategy', '')} bottom={<Status tone={directionTone(signal.direction)}>{label(signal.direction ?? '—')}</Status>} /></td>
            <td><Stacked top={`jelzés ${fmt(signal.score, 0)}`} bottom={`kockázat ${fmt(signal.riskScore, 0)}`} /></td>
            <td>{date(signal.createdAt)}</td>
          </tr>)}
        </DataTable>}
      </DashCard>
    </section>

    <DashCard title="Token adatok" className="dash-card-spaced">
      <StatList items={[
        ['Név', token?.name ?? '—'],
        ['Szimbólum', token?.symbol ?? '—'],
        ['Tizedesjegyek', token?.decimals ?? '—'],
        ['DEX / forrás', token?.dexId ?? '—'],
        ['Pool / bonding curve', token?.poolAddress ? <span className="mono-text">{token.poolAddress}</span> : '—'],
        launch?.creator ? ['Létrehozó', <span key="creator" className="mono-text">{launch.creator}</span>] : null,
        ['Utolsó frissítés', token?.lastUpdatedAt ? date(token.lastUpdatedAt) : '—'],
      ]} />
      {launch ? <p className="sfield-help" style={{ marginTop: 14 }}><Rocket size={14} aria-hidden="true" /> Ezt a tokent az új token észlelés találta meg; az adatok a valós on-chain tranzakció-folyamból származnak.</p> : null}
    </DashCard>
  </>;
}
