'use client';

import Link from 'next/link';

import { label } from '../../locales/hu';
import { launchReasons, SECURITY_STATE_LABELS } from '../../locales/position-labels';
import { formatCompactUsd, formatSignedPercent, formatTokenPrice, KeyValueList, StatusBadge, toneOf } from '../primitives';

import { DECISION_INFO, stringList, type TokenDetail, type TokenTrading } from './token-types';

function ScoreRow({ title, value, invert = false, suffix = '/100' }: { title: string; value: number | null | undefined; invert?: boolean; suffix?: string }) {
  const known = typeof value === 'number' && Number.isFinite(value);
  const good = known ? (invert ? value <= 40 : value >= 70) : false;
  const bad = known ? (invert ? value >= 70 : value < 40) : false;
  return <div className="score-row">
    <span>{title}</span>
    <strong className={good ? 'up' : bad ? 'down' : ''}>{known ? `${Math.round(value)}` : '—'}<small>{known ? suffix : ''}</small></strong>
    <span className="score-track" aria-hidden="true"><i style={{ width: `${known ? Math.max(2, Math.min(100, value)) : 0}%` }} className={good ? 'good' : bad ? 'bad' : ''} /></span>
  </div>;
}

const securityState = (value: unknown) => (value === true ? 'REVOKED' : value === false ? 'ACTIVE' : 'UNKNOWN');

/** Compact, scrollable right column: decision, scores, ML, security, activity, PAPER position, blockers. */
export function TokenSidePanel({ token, trading }: { token: TokenDetail; trading: TokenTrading | null }) {
  const launch = token.launch;
  const decision = launch?.decision ?? null;
  const decisionInfo = decision ? DECISION_INFO[decision.decision] : null;
  const risk = token.riskAssessments[0] ?? null;
  const riskScore = decision?.riskScore ?? risk?.riskScore ?? null;
  const security = launch?.security ?? null;
  const snapshot = launch?.snapshot ?? null;
  const ml = trading?.ml.paperDecision ?? null;
  const shadow = trading?.ml.shadowPrediction ?? null;
  const position = trading?.openPosition ?? null;
  const blockers = decision && decision.decision !== 'BUY' ? launchReasons(decision.reasons).slice(0, 4) : risk?.hardBlocked ? stringList(risk.hardBlockReasons).slice(0, 4) : [];

  return <aside className="token-side" aria-label="Token összefoglaló">
    <section className="side-block">
      <header><h3>Döntés</h3>{decisionInfo ? <StatusBadge tone={decisionInfo.tone}>{decisionInfo.text}</StatusBadge> : <StatusBadge>NINCS</StatusBadge>}</header>
      <ScoreRow title="Launch Score" value={decision?.score} />
      <ScoreRow title="Kockázat" value={riskScore} invert />
      {decision ? <small className="muted">{new Date(decision.decisionAt).toLocaleString('hu-HU')}{decision.riskClassification ? ` · ${decision.riskClassification === 'BLOCKED' ? 'feltételre vár' : label(decision.riskClassification)}` : ''}</small> : <small className="muted">A New Launch még nem értékelte ezt a tokent a fiókodban.</small>}
    </section>

    {ml || shadow ? <section className="side-block">
      <header><h3>Machine Learning</h3>{ml ? <StatusBadge tone={ml.mlDecision === 'ML_BUY' ? 'positive' : ml.mlDecision === 'ML_ERROR' ? 'negative' : 'neutral'}>{ml.mlDecision.replace('_', ' ')}</StatusBadge> : <StatusBadge tone="info">SHADOW</StatusBadge>}</header>
      <KeyValueList items={[
        ml ? ['PAPER döntés', `${ml.probability !== null ? ml.probability.toFixed(3) : '—'} / küszöb ${ml.threshold?.toFixed(2) ?? '—'}`] : null,
        ml ? ['Eredmény', ml.outcome] : null,
        shadow ? ['SHADOW előrejelzés', `${shadow.probability !== null ? shadow.probability.toFixed(3) : '—'} (${shadow.predictedClass.replace('_', ' ')})`] : null,
        ['Modell', ml?.modelVersion ?? shadow?.modelVersion ?? '—'],
      ]} />
    </section> : null}

    <section className="side-block">
      <header><h3>Biztonság</h3>{security ? <StatusBadge tone={security.sellability === 'VERIFIED' ? 'positive' : security.sellability === 'FAILED' ? 'negative' : 'warning'}>{SECURITY_STATE_LABELS[String(security.sellability ?? 'UNKNOWN')] ?? 'Ismeretlen'}</StatusBadge> : null}</header>
      {security ? <KeyValueList items={[
        ['Mint authority', SECURITY_STATE_LABELS[securityState(security.mintAuthorityRevoked)]],
        ['Freeze authority', SECURITY_STATE_LABELS[securityState(security.freezeAuthorityRevoked)]],
        ['Token szabvány', security.tokenProgram === 'spl-token-2022' ? 'Token-2022' : security.tokenProgram === 'spl-token' ? 'SPL Token' : 'Ismeretlen'],
      ]} /> : risk ? <KeyValueList items={[['Kockázati döntés', label(risk.decision)], ['Besorolás', risk.classification ? label(risk.classification) : '—'], ['Kemény tiltás', risk.hardBlocked ? 'Igen' : 'Nem']]} /> : <small className="muted">Nincs biztonsági adat.</small>}
    </section>

    <section className="side-block">
      <header><h3>Piaci aktivitás</h3></header>
      <KeyValueList items={[
        ['Likviditás', formatCompactUsd(token.liquidityUsd)],
        ['Forgalom', formatCompactUsd(token.volume24h)],
        snapshot ? ['Vétel / eladás', `${snapshot.buyCount ?? '—'} / ${snapshot.sellCount ?? '—'}`] : null,
        snapshot ? ['Egyedi vevők / eladók', `${snapshot.uniqueBuyers ?? '—'} / ${snapshot.uniqueSellers ?? '—'}`] : null,
        snapshot?.largestBuyerShare != null ? ['Legnagyobb vevő', `${Math.round(snapshot.largestBuyerShare * 100)}%`] : null,
        snapshot?.bondingProgress != null ? ['Bonding curve', `${Math.round(snapshot.bondingProgress * 100)}%`] : null,
      ]} />
    </section>

    <section className="side-block">
      <header><h3>PAPER pozíció</h3>{position ? <StatusBadge tone="info">NYITOTT</StatusBadge> : <StatusBadge>NINCS</StatusBadge>}</header>
      {position ? <>
        <KeyValueList items={[
          ['Belépés', formatTokenPrice(position.entry)],
          ['Aktuális', formatTokenPrice(position.current)],
          ['Eredmény', <span key="pnl" className={toneOf(position.pnlPercent) === 'positive' ? 'up' : toneOf(position.pnlPercent) === 'negative' ? 'down' : ''}>{formatSignedPercent(position.pnlPercent)}{position.unrealizedPnl !== null ? ` (${position.unrealizedPnl.toFixed(2)} USDC)` : ''}</span>],
          ['Stratégia', position.entryStrategy === 'ML' ? 'ML-modell' : 'Alapstratégia'],
        ]} />
        <Link className="secondary-button small" href={`/positions/${position.id}`}>Pozíció részletei</Link>
      </> : <small className="muted">Szimulált (PAPER) pozíció ehhez a tokenhez nincs nyitva.</small>}
    </section>

    {blockers.length ? <section className="side-block">
      <header><h3>Blokkoló feltételek</h3></header>
      <ul className="side-list">{blockers.map((reason) => <li key={reason}>{reason}</li>)}</ul>
    </section> : null}
  </aside>;
}
