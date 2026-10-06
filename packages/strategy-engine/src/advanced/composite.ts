import { type AdvancedStrategySettings, POSITIVE_MODULES } from './config.js';
import {
  clampScore,
  disabledResult,
  evaluateBuyPressure,
  evaluateConfirmedBreakout,
  evaluateLiquidityInflow,
  evaluateMomentumAcceleration,
  evaluatePullbackContinuation,
  evaluatePumpExhaustion,
  evaluateRelativeStrength,
  evaluateVolumeSpike,
  type ExhaustionLevel,
  exhaustionLevel,
  REQUIRED_HISTORY_MINUTES,
} from './modules.js';
import type { AdvancedModuleName, MarketFeatures, ModuleContext, PositiveModuleName, StrategyResult } from './types.js';

export const MODULE_LABELS_HU: Record<AdvancedModuleName, string> = {
  Momentum: 'Momentum',
  MomentumAcceleration: 'Momentum gyorsulás',
  VolumeSpike: 'Forgalomkitörés',
  BuyPressure: 'Vételi nyomás',
  ConfirmedBreakout: 'Megerősített kitörés',
  LiquidityInflow: 'Likviditás-beáramlás',
  RelativeStrength: 'Relatív erősség',
  PullbackContinuation: 'Visszahúzódás utáni folytatás',
  PumpExhaustion: 'Pump kifáradás',
};

export interface CompositeSignalResult {
  /** 0-100 after data-coverage factor and exhaustion penalty. */
  score: number;
  /** Weighted average of the available positive modules before adjustments (null if none was available). */
  weightedScore: number | null;
  confirmations: number;
  confirmedModules: PositiveModuleName[];
  unconfirmedModules: PositiveModuleName[];
  unavailableModules: Array<{ module: PositiveModuleName; status: StrategyResult['status']; reason: string | null }>;
  /** Share of the enabled weight whose module produced a real score. */
  coverage: number;
  exhaustionScore: number | null;
  exhaustionLevel: ExhaustionLevel | null;
  exhaustionPenalty: number;
  exhaustionBlocked: boolean;
  criticalLiquidityOutflow: boolean;
  entryEligible: boolean;
  action: 'BUY' | 'WATCH';
  reasons: string[];
  warnings: string[];
  minimumConfirmations: number;
  minimumCompositeScore: number;
}

/**
 * Weighted multi-factor score. Only enabled modules count; modules that are warming up never contribute,
 * and unavailable ones are left out of the average (or counted as 0 when penalizeUnavailable is on) — an
 * unavailable module is never a confirmation. Exhaustion subtracts a penalty and, with the BLOCK policy,
 * prevents automatic entry. Hard safety blocks are enforced elsewhere and cannot be overridden by this score.
 */
export function computeCompositeSignal(results: StrategyResult[], settings: AdvancedStrategySettings): CompositeSignalResult {
  const byName = new Map(results.map((result) => [result.strategy, result]));
  let weightedSum = 0;
  let countedWeight = 0;
  let enabledWeight = 0;
  let availableWeight = 0;
  const confirmedModules: PositiveModuleName[] = [];
  const unconfirmedModules: PositiveModuleName[] = [];
  const unavailableModules: CompositeSignalResult['unavailableModules'] = [];
  for (const name of POSITIVE_MODULES) {
    const moduleSettings = settings.modules[name];
    const result = byName.get(name);
    if (!moduleSettings.enabled || !result || result.status === 'DISABLED') continue;
    const weight = Math.max(0, moduleSettings.weight);
    enabledWeight += weight;
    if (result.status === 'OK' && result.score !== null) {
      weightedSum += weight * result.score;
      countedWeight += weight;
      availableWeight += weight;
      (result.triggered ? confirmedModules : unconfirmedModules).push(name);
    } else {
      unavailableModules.push({ module: name, status: result.status, reason: result.unavailableReason });
      if (settings.penalizeUnavailable && result.status === 'UNAVAILABLE') countedWeight += weight;
    }
  }
  const weightedScore = countedWeight > 0 && availableWeight > 0 ? weightedSum / countedWeight : null;
  const coverage = enabledWeight > 0 ? availableWeight / enabledWeight : 0;
  const exhaustion = byName.get('PumpExhaustion');
  const exhaustionScore = settings.exhaustionEnabled && exhaustion?.status === 'OK' ? exhaustion.score : null;
  const thresholds = { warning: settings.exhaustionWarningThreshold, strongWarning: settings.exhaustionStrongWarningThreshold, block: settings.exhaustionBlockThreshold };
  const level = exhaustionScore === null ? null : exhaustionLevel(exhaustionScore, thresholds);
  const exhaustionPenalty = exhaustionScore === null ? 0 : Math.max(0, settings.exhaustionPenaltyWeight) * Math.max(0, exhaustionScore - settings.exhaustionWarningThreshold);
  const exhaustionBlocked = settings.exhaustionPolicy === 'BLOCK' && level === 'BLOCK';
  const criticalLiquidityOutflow = byName.get('LiquidityInflow')?.features.criticalLiquidityOutflow === true;
  const score = weightedScore === null ? 0 : clampScore(weightedScore * (0.5 + 0.5 * coverage) - exhaustionPenalty);
  const confirmations = confirmedModules.length;
  const entryEligible = weightedScore !== null
    && score >= settings.minimumCompositeScore
    && confirmations >= settings.minimumConfirmations
    && !exhaustionBlocked
    && !criticalLiquidityOutflow;

  const reasons: string[] = [];
  const warnings: string[] = [];
  reasons.push(`Összetett jelzés: ${score}/100, megerősítések: ${confirmations} (minimum ${settings.minimumConfirmations}).`);
  if (confirmedModules.length) reasons.push(`Megerősítette: ${confirmedModules.map((name) => MODULE_LABELS_HU[name]).join(', ')}.`);
  if (unconfirmedModules.length) reasons.push(`Nem erősítette meg: ${unconfirmedModules.map((name) => MODULE_LABELS_HU[name]).join(', ')}.`);
  const warming = unavailableModules.filter((entry) => entry.status === 'WARMING_UP');
  if (warming.length) reasons.push(`Adatgyűjtés folyamatban: ${warming.map((entry) => MODULE_LABELS_HU[entry.module]).join(', ')}.`);
  if (exhaustionScore !== null && level !== 'NORMAL') warnings.push(`Momentum kifáradás: ${exhaustionScore}/100${exhaustionBlocked ? ' – automatikus belépés tiltva' : ''}.`);
  if (criticalLiquidityOutflow) warnings.push('Kritikus likviditás-kiáramlás – automatikus belépés tiltva.');
  if (weightedScore !== null && score < settings.minimumCompositeScore) reasons.push(`A pontszám a ${settings.minimumCompositeScore} küszöb alatt van.`);

  return {
    score,
    weightedScore,
    confirmations,
    confirmedModules,
    unconfirmedModules,
    unavailableModules,
    coverage,
    exhaustionScore,
    exhaustionLevel: level,
    exhaustionPenalty,
    exhaustionBlocked,
    criticalLiquidityOutflow,
    entryEligible,
    action: entryEligible ? 'BUY' : 'WATCH',
    reasons,
    warnings,
    minimumConfirmations: settings.minimumConfirmations,
    minimumCompositeScore: settings.minimumCompositeScore,
  };
}

/** Everything the analysis of one token produced; persisted with signals and trades for later analytics. */
export interface SignalAnalysis {
  version: 1;
  evaluatedAt: string;
  features: MarketFeatures;
  results: StrategyResult[];
  composite: CompositeSignalResult;
  settings: AdvancedStrategySettings;
}

/**
 * Runs every advanced module once for one token. `momentum` is the result of the existing MomentumStrategy
 * (mapped by the caller), so the composite reuses it instead of re-implementing it.
 */
export function analyzeToken(context: ModuleContext, settings: AdvancedStrategySettings, momentum: StrategyResult | null): SignalAnalysis {
  const modules = settings.modules;
  const results: StrategyResult[] = [
    momentum ?? (modules.Momentum.enabled
      ? { strategy: 'Momentum', enabled: true, available: false, status: 'UNAVAILABLE', unavailableReason: 'INSUFFICIENT_MARKET_DATA', triggered: false, score: null, confidence: 0, reasons: ['A Momentum stratégia nem futott.'], warnings: [], features: {}, requiredHistoryMinutes: REQUIRED_HISTORY_MINUTES.Momentum, evaluatedAt: context.now.toISOString() }
      : disabledResult('Momentum', modules.Momentum, context)),
    evaluateMomentumAcceleration(context, modules.MomentumAcceleration),
    evaluateVolumeSpike(context, modules.VolumeSpike),
    evaluateBuyPressure(context, modules.BuyPressure),
    evaluateConfirmedBreakout(context, modules.ConfirmedBreakout),
    evaluateLiquidityInflow(context, modules.LiquidityInflow),
    evaluateRelativeStrength(context, modules.RelativeStrength),
    evaluatePullbackContinuation(context, modules.PullbackContinuation),
    evaluatePumpExhaustion(context, { ...modules.PumpExhaustion, enabled: settings.exhaustionEnabled }, { warning: settings.exhaustionWarningThreshold, strongWarning: settings.exhaustionStrongWarningThreshold, block: settings.exhaustionBlockThreshold }),
  ];
  return { version: 1, evaluatedAt: context.now.toISOString(), features: context.features, results, composite: computeCompositeSignal(results, settings), settings };
}
