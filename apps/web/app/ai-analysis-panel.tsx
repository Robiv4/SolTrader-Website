'use client';
/* eslint-disable @typescript-eslint/no-explicit-any */
import { date, Panel, Status } from './components';

export const AI_DECISION_LABELS: Record<string, string> = { BUY: 'VÉTEL', WATCH: 'MEGFIGYELÉS', SKIP: 'KIHAGYÁS', NONE: 'NINCS DÖNTÉS' };
export const AI_REASON_LABELS: Record<string, string> = {
  AI_CONFIDENCE_BELOW_THRESHOLD: 'az AI bizalom a beállított minimum alatt van',
  AI_HIGH_RISK_NOT_ALLOWED: 'HIGH kockázatú token AI-vétele nincs engedélyezve',
  AI_VERY_HIGH_RISK_NOT_ALLOWED: 'VERY HIGH kockázatú token AI-vétele nincs engedélyezve',
  RISK_CLASS_NOT_ELIGIBLE: 'a kockázati besorolás miatt nem vehető',
  AI_PROVIDER_UNAVAILABLE: 'AI szolgáltató nem elérhető',
  AI_ANALYSIS_INVALID: 'az AI válasza érvénytelen volt (nem került felhasználásra)',
};

export function aiDecisionTone(decision: string | null | undefined) {
  return decision === 'BUY' ? 'positive' : decision === 'WATCH' ? 'warning' : decision === 'SKIP' ? 'neutral' : 'negative';
}

function Score({ label, value, inverse = false }: { label: string; value: number | null | undefined; inverse?: boolean }) {
  const tone = value == null ? '' : (inverse ? value >= 60 : value < 40) ? 'negative' : (inverse ? value < 30 : value >= 70) ? 'positive' : 'warning';
  return <div className={`analysis-headline ${tone}`}><span>{label}</span><strong>{value == null ? '—' : Math.round(value)} <small>/ 100</small></strong></div>;
}

/** "AI elemzés" card on the token details page (cards stack on mobile). */
export function AiAnalysisPanel({ analysis, decisionMode }: { analysis: any; decisionMode: 'AI' | 'STRATEGY' }) {
  if (!analysis) {
    return <Panel title="AI elemzés"><p className="annotation">{decisionMode === 'AI' ? 'Ehhez a tokenhez még nincs AI elemzés. Az AI a kockázati szűrőn átjutott tokeneket elemzi, korlátozott ütemben.' : 'Stratégia mód aktív: AI elemzés nem fut. A Beállításokban kapcsolható be.'}</p></Panel>;
  }
  const reasons: string[] = Array.isArray(analysis.reasons) ? analysis.reasons : [];
  const warnings: string[] = Array.isArray(analysis.warnings) ? analysis.warnings : [];
  const effective = analysis.effectiveDecision as string;
  return (
    <Panel title="AI elemzés">
      <div className="analysis-summary">
        <div className="analysis-headline"><span>Állapot</span><strong><Status tone={decisionMode === 'AI' ? 'positive' : 'neutral'}>{decisionMode === 'AI' ? 'Aktív' : 'Nem aktív (stratégia mód)'}</Status></strong></div>
        <div className="analysis-headline"><span>AI döntés</span><strong><Status tone={aiDecisionTone(effective)}>{AI_DECISION_LABELS[effective] ?? effective}</Status></strong></div>
        <Score label="AI bizalom" value={analysis.confidence} />
      </div>
      {analysis.rawDecision && analysis.rawDecision !== effective ? <p className="analysis-line">Az AI eredeti döntése: {AI_DECISION_LABELS[analysis.rawDecision] ?? analysis.rawDecision} → {AI_DECISION_LABELS[effective] ?? effective} ({AI_REASON_LABELS[analysis.effectiveReason] ?? analysis.effectiveReason})</p> : null}
      {analysis.status !== 'COMPLETED' ? <p className="analysis-line negative-value">{AI_REASON_LABELS[analysis.effectiveReason] ?? analysis.effectiveReason ?? 'Az elemzés nem sikerült.'} – automatikus vétel nem történik.</p> : null}
      {analysis.status === 'COMPLETED' ? <div className="analysis-summary">
        <Score label="Belépés minősége" value={analysis.entryQuality} />
        <Score label="Piaci erő" value={analysis.marketStrength} />
        <Score label="Momentum minőség" value={analysis.momentumQuality} />
        <Score label="Likviditás minőség" value={analysis.liquidityQuality} />
        <Score label="Időzítés minősége" value={analysis.timingQuality} />
        <Score label="Kifáradási kockázat" value={analysis.exhaustionRisk} inverse />
      </div> : null}
      {reasons.length ? <><strong className="analysis-subtitle">Indokok</strong><ul className="analysis-list">{reasons.map((reason, index) => <li key={`r${index}`}>{reason}</li>)}</ul></> : null}
      {warnings.length ? <><strong className="analysis-subtitle">Figyelmeztetések</strong><ul className="analysis-list negative-value">{warnings.map((warning, index) => <li key={`w${index}`}>{warning}</li>)}</ul></> : null}
      {analysis.status === 'COMPLETED' ? <p className="annotation">Javasolt pozícióméret-szorzó: {analysis.recommendedPositionMultiplier ?? '—'} · javasolt SL/TP: {analysis.suggestedStopLossPercent ?? '—'}% / {analysis.suggestedTakeProfitPercent ?? '—'}% · trailing: {analysis.suggestedTrailingActivationPercent ?? '—'}% aktiválás, {analysis.suggestedTrailingDistancePercent ?? '—'}% távolság. Ezeket csak akkor használja a bot, ha a Beállításokban bekapcsolod az AI kilépési paramétereket; a méretet csak csökkenteni tudják.</p> : null}
      <p className="annotation">Utolsó elemzés: {date(analysis.createdAt)} · Következő újraelemzés: {analysis.nextAnalysisAt ? date(analysis.nextAnalysisAt) : '—'} (nagy piaci változásnál korábban) · Szolgáltató: {analysis.provider} / {analysis.model} · prompt: {analysis.promptVersion}{analysis.latencyMs ? ` · ${(analysis.latencyMs / 1000).toFixed(1).replace('.', ',')} s` : ''}. Az AI bizalom nem a nyereség valószínűsége; a kemény biztonsági tiltásokat az AI nem írhatja felül.</p>
    </Panel>
  );
}
