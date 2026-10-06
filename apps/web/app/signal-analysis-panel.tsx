'use client';
/* eslint-disable @typescript-eslint/no-explicit-any */
import { fmt, Panel, Status } from './components';
import { EXHAUSTION_LEVEL_LABELS, MODULE_LABELS_HU, MODULE_STATUS_LABELS, UNAVAILABLE_REASON_LABELS } from './locales/strategy-labels';

type ModuleResult = { strategy: string; status: string; available: boolean; triggered: boolean; score: number | null; reasons: string[]; warnings: string[]; unavailableReason: string | null };

function moduleTone(result: ModuleResult) {
  if (result.strategy === 'PumpExhaustion') return (result.score ?? 0) >= 70 ? 'negative' : (result.score ?? 0) >= 40 ? 'warning' : 'positive';
  if (result.status !== 'OK') return 'neutral';
  return result.triggered ? 'positive' : 'neutral';
}

/** Explainable breakdown of the latest signal analysis of one token (cards, stacked on mobile). */
export function SignalAnalysisPanel({ analysis, riskScore, riskClassification, decisionMode = 'STRATEGY' }: { analysis: any; riskScore?: number | null; riskClassification?: string | null; decisionMode?: 'AI' | 'STRATEGY' }) {
  if (!analysis) {
    return <Panel title="Jelzéselemzés"><p className="annotation">Ehhez a tokenhez még nincs jelzéselemzés. A worker a kockázati szűrőn átjutott (figyelt vagy jóváhagyott) tokeneket elemzi minden ciklusban.</p></Panel>;
  }
  const results: ModuleResult[] = analysis.results ?? [];
  const positive = results.filter((result) => result.strategy !== 'PumpExhaustion');
  const exhaustion = results.find((result) => result.strategy === 'PumpExhaustion');
  const confirmed: string[] = analysis.confirmedModules ?? [];
  const unconfirmed: string[] = analysis.unconfirmedModules ?? [];
  const enabled = positive.filter((result) => result.status !== 'DISABLED').length;
  const decision = decisionMode === 'AI' ? 'Csak tájékoztató (AI mód)' : analysis.action === 'BUY' ? 'Jóváhagyásra jelölt' : 'Megfigyelés';
  return (
    <Panel title="Jelzéselemzés">
      <div className="analysis-summary">
        <div className="analysis-headline">
          <span>Összetett jelzés</span>
          <strong>{analysis.compositeScore ?? '—'} <small>/ 100</small></strong>
        </div>
        <div className="analysis-headline">
          <span>Megerősítések</span>
          <strong>{analysis.confirmations ?? 0} <small>/ {enabled}</small></strong>
        </div>
        <div className="analysis-headline">
          <span>Jelzés-döntés</span>
          <strong><Status tone={analysis.action === 'BUY' ? 'positive' : 'neutral'}>{decision}</Status></strong>
        </div>
        <div className="analysis-headline">
          <span>Kockázat (külön tény)</span>
          <strong>{riskScore == null ? '—' : fmt(riskScore, 0)} <small>{riskClassification ?? ''}</small></strong>
        </div>
      </div>
      {confirmed.length ? <p className="analysis-line positive-value">✓ Megerősítette: {confirmed.map((name) => MODULE_LABELS_HU[name] ?? name).join(', ')}</p> : null}
      {unconfirmed.length ? <p className="analysis-line">✗ Nem erősítette meg: {unconfirmed.map((name) => MODULE_LABELS_HU[name] ?? name).join(', ')}</p> : null}
      {exhaustion?.status === 'OK' ? <p className={`analysis-line ${(exhaustion.score ?? 0) >= 70 ? 'negative-value' : ''}`}>{analysis.exhaustionLevel && analysis.exhaustionLevel !== 'NORMAL' ? 'Figyelmeztetés: ' : ''}Pump kifáradás {exhaustion.score}/100 ({EXHAUSTION_LEVEL_LABELS[analysis.exhaustionLevel] ?? analysis.exhaustionLevel ?? '—'}){analysis.exhaustionBlocked ? ' – automatikus belépés tiltva' : ''}</p> : null}
      {analysis.criticalLiquidityOutflow ? <p className="analysis-line negative-value">Kritikus likviditás-kiáramlás – automatikus belépés tiltva.</p> : null}
      <div className="analysis-grid">
        {results.map((result) => (
          <details key={result.strategy} className={`analysis-card ${moduleTone(result)}`}>
            <summary>
              <span className="analysis-name">{MODULE_LABELS_HU[result.strategy] ?? result.strategy}</span>
              <span className="analysis-score">{result.status === 'OK' ? result.score : '—'}</span>
              <small>{result.status === 'OK'
                ? result.strategy === 'PumpExhaustion' ? 'kifáradás' : result.triggered ? '✓ megerősít' : 'nem erősít meg'
                : result.status === 'UNAVAILABLE' ? UNAVAILABLE_REASON_LABELS[result.unavailableReason ?? ''] ?? MODULE_STATUS_LABELS.UNAVAILABLE : MODULE_STATUS_LABELS[result.status] ?? result.status}</small>
            </summary>
            <ul>
              {result.reasons.map((reason, index) => <li key={`r${index}`}>{reason}</li>)}
              {result.warnings.map((warning, index) => <li key={`w${index}`} className="negative-value">{warning}</li>)}
            </ul>
          </details>
        ))}
      </div>
      <p className="annotation">
        {analysis.source === 'LIVE' ? 'Élő elemzés (a worker minden ciklusban frissíti).' : 'Az utoljára mentett elemzés.'} Kiértékelve: {analysis.evaluatedAt ? new Date(analysis.evaluatedAt).toLocaleString('hu-HU') : '—'} · ártörténet: {fmt(analysis.features?.historyMinutes ?? 0, 0)} perc, {analysis.features?.snapshotCount ?? 0} pillanatkép · adatminőség: {analysis.features?.dataQuality ?? '—'}. A jelzés erőssége nem jelenti, hogy a token biztonságos: a kockázati besorolás és a kemény tiltások külön érvényesek.
      </p>
    </Panel>
  );
}
