import { booleanSetting, type ModuleSettings, numberSetting } from './config.js';
import { normalizeObservations } from './features.js';
import type { AdvancedModuleName, ModuleContext, StrategyResult } from './types.js';

const MINUTE = 60_000;

/** History each module needs before it contributes (declared, and enforced as WARMING_UP). */
export const REQUIRED_HISTORY_MINUTES: Record<AdvancedModuleName, number> = {
  Momentum: 0,
  MomentumAcceleration: 15,
  VolumeSpike: 5,
  BuyPressure: 0,
  ConfirmedBreakout: 15,
  LiquidityInflow: 15,
  RelativeStrength: 5,
  PullbackContinuation: 20,
  PumpExhaustion: 0,
};

export function clampScore(value: number) {
  return Math.min(100, Math.max(0, Math.round(value)));
}

function fmt(value: number, digits = 1) {
  return value.toFixed(digits).replace('.', ',');
}

function base(name: AdvancedModuleName, settings: ModuleSettings, context: ModuleContext) {
  return {
    strategy: name,
    enabled: settings.enabled,
    requiredHistoryMinutes: REQUIRED_HISTORY_MINUTES[name],
    evaluatedAt: context.now.toISOString(),
  };
}

export function disabledResult(name: AdvancedModuleName, settings: ModuleSettings, context: ModuleContext): StrategyResult {
  return { ...base(name, settings, context), available: false, status: 'DISABLED', unavailableReason: 'DISABLED', triggered: false, score: null, confidence: 0, reasons: [], warnings: [], features: {} };
}

export function unavailableResult(name: AdvancedModuleName, settings: ModuleSettings, context: ModuleContext, reason: string, message: string, features: StrategyResult['features'] = {}): StrategyResult {
  const warming = reason === 'WARMING_UP';
  return {
    ...base(name, settings, context),
    available: false,
    status: warming ? 'WARMING_UP' : 'UNAVAILABLE',
    unavailableReason: reason,
    triggered: false,
    score: null,
    confidence: 0,
    reasons: [message],
    warnings: [],
    features,
  };
}

function okResult(name: AdvancedModuleName, settings: ModuleSettings, context: ModuleContext, result: { score: number; triggered: boolean; confidence?: number; reasons: string[]; warnings?: string[]; features: StrategyResult['features'] }): StrategyResult {
  return {
    ...base(name, settings, context),
    available: true,
    status: 'OK',
    unavailableReason: null,
    triggered: result.triggered,
    score: clampScore(result.score),
    confidence: Math.min(1, Math.max(0, result.confidence ?? 1)),
    reasons: result.reasons,
    warnings: result.warnings ?? [],
    features: result.features,
  };
}

/** Common availability gate: invalid/stale data first, then the declared warm-up. */
function gate(name: AdvancedModuleName, settings: ModuleSettings, context: ModuleContext) {
  if (!settings.enabled) return disabledResult(name, settings, context);
  const quality = context.features.dataQuality;
  if (quality === 'INVALID') return unavailableResult(name, settings, context, 'INVALID_MARKET_DATA', 'Érvénytelen vagy hiányzó ár.');
  if (quality === 'STALE') return unavailableResult(name, settings, context, 'STALE_MARKET_DATA', 'Elavult piaci adat.');
  if (context.features.historyMinutes < REQUIRED_HISTORY_MINUTES[name]) {
    return unavailableResult(name, settings, context, 'WARMING_UP', `Adatgyűjtés folyamatban (${fmt(context.features.historyMinutes, 0)}/${REQUIRED_HISTORY_MINUTES[name]} perc).`, { historyMinutes: context.features.historyMinutes });
  }
  return null;
}

/** Volume Spike (Forgalomkitörés): 5m volume against the previous hour's 5m average, not 24h volume. */
export function evaluateVolumeSpike(context: ModuleContext, settings: ModuleSettings): StrategyResult {
  const name = 'VolumeSpike';
  if (!settings.enabled) return disabledResult(name, settings, context);
  const f = context.features;
  if (f.volume5m === null || f.volume1h === null) return unavailableResult(name, settings, context, 'INSUFFICIENT_MARKET_DATA', 'A szolgáltató nem adott rövid távú (5 perc / 1 óra) forgalmi adatot.');
  const blocked = gate(name, settings, context);
  if (blocked) return blocked;
  if (f.volumeSpikeRatio === null) return unavailableResult(name, settings, context, 'NO_VOLUME_BASELINE', 'Nincs összehasonlítható előző órás forgalom (új pool vagy nulla forgalom).');
  const minRatio = numberSetting(settings, 'minSpikeRatio', 2);
  const minTransactions = numberSetting(settings, 'minTransactions5m', 20);
  const ratio = f.volumeSpikeRatio;
  const reasons = [`Az 5 perces forgalom a megelőző órai átlag ${fmt(ratio)}-szerese (küszöb ${fmt(minRatio)}×).`];
  const warnings: string[] = [];
  let score = Math.min(60, 30 * ratio / minRatio);
  if (f.volumeAcceleration !== null) {
    if (f.volumeAcceleration >= 1.5) { score += 15; reasons.push(`A forgalom 5 perc alatt ${fmt(f.volumeAcceleration)}-szeresére nőtt.`); }
    else if (f.volumeAcceleration >= 1.1) score += 8;
    else if (f.volumeAcceleration < 0.8) warnings.push('A forgalom az előző 5 perchez képest csökken.');
  }
  const activeEnough = f.transactions5m !== null && f.transactions5m >= minTransactions;
  if (activeEnough) { score += 10; reasons.push(`${f.transactions5m} tranzakció az elmúlt 5 percben.`); }
  else warnings.push(`Kevés tranzakció (${f.transactions5m ?? 'n/a'} < ${minTransactions}).`);
  const priceChange = f.priceChange5m;
  if (priceChange !== null && priceChange > 0) { score += Math.min(15, priceChange * 3); reasons.push(`Az ár is emelkedik (+${fmt(priceChange)}% / 5 perc).`); }
  const fallingPrice = priceChange !== null && priceChange < -3;
  if (fallingPrice) { score -= 20; warnings.push(`A forgalom csökkenő ár mellett nő (${fmt(priceChange)}% / 5 perc) – lehetséges eladási hullám.`); }
  const finalScore = clampScore(score);
  return okResult(name, settings, context, {
    score: finalScore,
    triggered: ratio >= minRatio && activeEnough && !fallingPrice && finalScore >= settings.minScore,
    confidence: f.volumeAcceleration === null ? 0.8 : 1,
    reasons,
    warnings,
    features: { volumeSpikeRatio: ratio, volume5m: f.volume5m, volume5mBaseline: f.volume5mBaseline, volumeAcceleration: f.volumeAcceleration, transactions5m: f.transactions5m, priceChange5m: priceChange },
  });
}

/** Buy Pressure (Vételi nyomás): buy/sell counts combined with volume and price; counts alone are not trusted. */
export function evaluateBuyPressure(context: ModuleContext, settings: ModuleSettings): StrategyResult {
  const name = 'BuyPressure';
  if (!settings.enabled) return disabledResult(name, settings, context);
  const f = context.features;
  if (f.buys5m === null || f.sells5m === null) return unavailableResult(name, settings, context, 'INSUFFICIENT_MARKET_DATA', 'Nincs vételi/eladási tranzakcióadat.');
  const blocked = gate(name, settings, context);
  if (blocked) return blocked;
  if (!f.transactions5m) return unavailableResult(name, settings, context, 'NO_RECENT_TRADES', 'Nem volt tranzakció az elmúlt 5 percben.');
  const minRatio = numberSetting(settings, 'minBuySellRatio', 1.5);
  const minAverageTrade = numberSetting(settings, 'minAverageTradeUsd', 25);
  const minVolume = numberSetting(settings, 'minVolume5mUsd', 2_000);
  const shareNow = f.buyShare5m ?? 0.5;
  const ratio = f.buySellCountRatio ?? 0;
  const reasons = [`Vétel/eladás: ${f.buys5m}/${f.sells5m} (arány ${fmt(ratio, 2)}, vételi arány ${fmt(shareNow * 100, 0)}%).`];
  const warnings: string[] = [];
  let score = shareNow * 100;
  if (f.buyShare1h !== null) {
    const delta = shareNow - f.buyShare1h;
    score += Math.max(-10, Math.min(10, delta * 100));
    if (delta > 0.05) reasons.push(`A vételi arány erősödik az órás átlaghoz képest (${fmt(f.buyShare1h * 100, 0)}% → ${fmt(shareNow * 100, 0)}%).`);
  }
  if (f.priceChange5m !== null && f.priceChange5m > 0) score += 5;
  if (f.priceChange5m !== null && f.priceChange5m < -2) { score -= 10; warnings.push('Túlsúlyban lévő vételek ellenére esik az ár.'); }
  let confidence = 1;
  if (f.buySellVolumeRatio === null) {
    // The provider reports trade counts only; without the USD split the score is capped.
    confidence = 0.7;
    score = Math.min(score, 85);
    warnings.push('Vételi/eladási forgalom (USD) nem elérhető – csak darabszám alapján.');
  }
  const tinyTrades = f.volume5m === null || f.volume5m < minVolume || (f.averageTradeSizeUsd5m !== null && f.averageTradeSizeUsd5m < minAverageTrade);
  if (tinyTrades) {
    score = Math.min(score, 55);
    warnings.push(`Sok apró tranzakció / kevés forgalom (átlag ${f.averageTradeSizeUsd5m === null ? 'n/a' : fmt(f.averageTradeSizeUsd5m, 0)} USD) – a darabszám nem megbízható.`);
  }
  const finalScore = clampScore(score);
  return okResult(name, settings, context, {
    score: finalScore,
    triggered: ratio >= minRatio && !tinyTrades && finalScore >= settings.minScore,
    confidence,
    reasons,
    warnings,
    features: { buys5m: f.buys5m, sells5m: f.sells5m, buySellCountRatio: ratio, buyShare5m: shareNow, buyShare1h: f.buyShare1h, buySellVolumeRatio: f.buySellVolumeRatio, averageTradeSizeUsd5m: f.averageTradeSizeUsd5m },
  });
}

/** Momentum Acceleration (Momentum gyorsulás): is the rate of the price move increasing? */
export function evaluateMomentumAcceleration(context: ModuleContext, settings: ModuleSettings): StrategyResult {
  const name = 'MomentumAcceleration';
  const blocked = gate(name, settings, context);
  if (blocked) return blocked;
  const f = context.features;
  if (!f.momentumWindows) return unavailableResult(name, settings, context, 'INSUFFICIENT_MARKET_DATA', 'Hiányoznak az összehasonlító árpontok (5/10/15 perce).');
  const [r1, r2, r3] = f.momentumWindows;
  const acceleration = r3 - r2;
  const previousAcceleration = r2 - r1;
  const reasons = [`Ármozgás 5 perces szakaszokban: ${fmt(r1)}% → ${fmt(r2)}% → ${fmt(r3)}%.`];
  const warnings: string[] = [];
  let score = 50 + 8 * acceleration + 4 * previousAcceleration;
  if (r3 <= 0) { score = Math.min(score, 30); reasons.push('Az utolsó szakaszban nincs emelkedés.'); }
  if (acceleration < 0 && r3 > 0) warnings.push('A momentum lassul.');
  if (acceleration > 0 && previousAcceleration > 0) reasons.push('A momentum két egymást követő szakaszban gyorsult.');
  if (f.volumeSpikeRatio !== null) score += f.volumeSpikeRatio >= 1.2 ? 5 : f.volumeSpikeRatio < 0.8 ? -10 : 0;
  if (f.buyShare5m !== null) score += f.buyShare5m >= 0.55 ? 5 : f.buyShare5m < 0.45 ? -10 : 0;
  const extreme = numberSetting(settings, 'extremeMovePercent', 80);
  const totalMove = Math.max(r1 + r2 + r3, f.priceChange1h ?? Number.NEGATIVE_INFINITY);
  if (totalMove >= extreme) { score = Math.min(score, 60); warnings.push(`Már nagy emelkedés történt (+${fmt(totalMove, 0)}%) – kifáradás-szűrő ellenőrzi.`); }
  const finalScore = clampScore(score);
  return okResult(name, settings, context, {
    score: finalScore,
    triggered: r3 > 0 && acceleration > 0 && finalScore >= settings.minScore,
    reasons,
    warnings,
    features: { window1: r1, window2: r2, window3: r3, momentumVelocity: r3, momentumAcceleration: acceleration, previousAcceleration },
  });
}

/** Confirmed Breakout (Megerősített kitörés): break of the recent high that persists and is backed by volume. */
export function evaluateConfirmedBreakout(context: ModuleContext, settings: ModuleSettings): StrategyResult {
  const name = 'ConfirmedBreakout';
  const blocked = gate(name, settings, context);
  if (blocked) return blocked;
  const f = context.features;
  const price = f.priceUsd!;
  const lookback = numberSetting(settings, 'lookbackMinutes', 30);
  const confirmation = numberSetting(settings, 'confirmationMinutes', 2);
  const reference = context.observations.at(-1)?.timestamp.getTime() ?? context.now.getTime();
  const observations = normalizeObservations(context.observations).filter((observation) => (observation.priceUsd ?? 0) > 0);
  const resistanceWindow = observations.filter((observation) => {
    const time = observation.timestamp.getTime();
    return time >= reference - lookback * MINUTE && time < reference - confirmation * MINUTE;
  });
  if (resistanceWindow.length < 4) return unavailableResult(name, settings, context, 'WARMING_UP', 'Adatgyűjtés folyamatban (kevés árpont az ellenállás meghatározásához).');
  const resistance = Math.max(...resistanceWindow.map((observation) => observation.priceUsd!));
  const confirmationPoints = observations.filter((observation) => {
    const time = observation.timestamp.getTime();
    return time >= reference - confirmation * MINUTE && time < reference;
  });
  const breakoutPercent = (price / resistance - 1) * 100;
  const persisted = confirmationPoints.length > 0 && confirmationPoints.every((observation) => observation.priceUsd! > resistance);
  const minVolumeRatio = numberSetting(settings, 'minVolumeRatio', 1.5);
  const volumeRequired = booleanSetting(settings, 'volumeConfirmationRequired', true);
  const volumeConfirmed = f.volumeSpikeRatio !== null && f.volumeSpikeRatio >= minVolumeRatio;
  const buyConfirmed = f.buyShare5m !== null && f.buyShare5m >= 0.55;
  const liquidityOk = f.liquidityUsd !== null && f.liquidityUsd >= numberSetting(settings, 'minLiquidityUsd', 10_000);
  const reasons: string[] = [];
  const warnings: string[] = [];
  let score: number;
  if (price <= resistance) {
    score = Math.max(0, 40 + breakoutPercent * 2);
    reasons.push(`Az ár (${fmt(breakoutPercent)}%) az ellenállás alatt van.`);
  } else {
    score = 45 + Math.min(15, breakoutPercent * 3);
    reasons.push(`Az ár ${fmt(breakoutPercent)}%-kal az elmúlt ${lookback} perc csúcsa fölött.`);
    if (persisted) { score += 15; reasons.push(`A kitörés ${confirmation} perce tart.`); }
    else warnings.push('A kitörés még nem tartós.');
    if (volumeConfirmed) { score += 15; reasons.push(`Forgalom megerősíti (${fmt(f.volumeSpikeRatio!)}×).`); }
    if (buyConfirmed) { score += 10; reasons.push('A vételi nyomás megerősíti.'); }
    if (volumeRequired && !volumeConfirmed) { score = Math.min(score, 55); warnings.push('Forgalmi megerősítés nélkül – nem megerősített kitörés.'); }
    if (breakoutPercent > numberSetting(settings, 'maxExtensionPercent', 25)) { score -= 15; warnings.push('Az ár már túl messze van a kitörési szinttől (felzárkózásos vétel kockázata).'); }
  }
  if (!liquidityOk) warnings.push('Alacsony likviditás.');
  const finalScore = clampScore(score);
  return okResult(name, settings, context, {
    score: finalScore,
    triggered: price > resistance && persisted && (!volumeRequired || volumeConfirmed) && liquidityOk && finalScore >= settings.minScore,
    confidence: f.volumeSpikeRatio === null ? 0.7 : 1,
    reasons,
    warnings,
    features: { resistance, breakoutPercent, persisted, volumeConfirmed, buyConfirmed, volumeSpikeRatio: f.volumeSpikeRatio },
  });
}

/** Liquidity Inflow (Likviditás-beáramlás) with LIQUIDITY_OUTFLOW detection. Rising liquidity is not a safety signal. */
export function evaluateLiquidityInflow(context: ModuleContext, settings: ModuleSettings): StrategyResult {
  const name = 'LiquidityInflow';
  if (!settings.enabled) return disabledResult(name, settings, context);
  const f = context.features;
  if (f.liquidityUsd === null) return unavailableResult(name, settings, context, 'INSUFFICIENT_MARKET_DATA', 'Nincs likviditási adat.');
  const blocked = gate(name, settings, context);
  if (blocked) return blocked;
  const reference = context.observations.at(-1)?.timestamp ?? context.now;
  const points = [15, 10, 5].map((minutes) => {
    const target = reference.getTime() - minutes * MINUTE;
    const candidates = context.observations.filter((observation) => (observation.liquidityUsd ?? 0) > 0 && Math.abs(observation.timestamp.getTime() - target) <= Math.max(45_000, minutes * MINUTE * 0.3));
    candidates.sort((a, b) => Math.abs(a.timestamp.getTime() - target) - Math.abs(b.timestamp.getTime() - target));
    return candidates[0]?.liquidityUsd ?? null;
  });
  if (points.some((point) => point === null)) return unavailableResult(name, settings, context, 'INSUFFICIENT_MARKET_DATA', 'Hiányoznak a 5/10/15 perccel korábbi likviditási pontok.');
  const series = [...points as number[], f.liquidityUsd];
  const change = (series[3] / series[0] - 1) * 100;
  const increasingSteps = [1, 2, 3].filter((index) => series[index] > series[index - 1]).length;
  const minGrowth = numberSetting(settings, 'minGrowthPercent', 15);
  const warningOutflow = numberSetting(settings, 'outflowWarningPercent', 25);
  const criticalOutflow = numberSetting(settings, 'criticalOutflowPercent', 50);
  const drawdown = f.liquidityDrawdownFromPeak15m ?? 0;
  const outflow = drawdown <= -warningOutflow;
  const critical = drawdown <= -criticalOutflow;
  const reasons = [`Likviditás 15 perc alatt: ${fmt(change)}% (${series.map((value) => `$${Math.round(value).toLocaleString('en-US')}`).join(' → ')}).`];
  const warnings: string[] = [];
  let score = 50 + change * (50 / (2 * minGrowth));
  if (increasingSteps === 3) { score += 10; reasons.push('Folyamatos növekedés mindhárom szakaszban.'); }
  if (f.priceChange15m !== null && f.priceChange15m < -10) { score -= 10; warnings.push('A likviditás nő, de az ár esik.'); }
  if (outflow) {
    score = Math.min(score, 20);
    warnings.push(`LIQUIDITY_OUTFLOW: a likviditás ${fmt(-drawdown, 0)}%-kal a 15 perces csúcs alatt${critical ? ' – kritikus' : ''}.`);
  }
  const finalScore = clampScore(score);
  return okResult(name, settings, context, {
    score: finalScore,
    triggered: change >= minGrowth && increasingSteps >= 2 && !outflow && finalScore >= settings.minScore,
    reasons,
    warnings,
    features: { liquidityChangePercent: change, liquidityVelocity: change / 3, liquidityStability: increasingSteps / 3, liquidityDrawdownFromPeak15m: drawdown, liquidityOutflow: outflow, criticalLiquidityOutflow: critical },
  });
}

/** Pullback Continuation (Visszahúzódás utáni folytatás): impulse → controlled pullback → buyers return → reclaim. */
export function evaluatePullbackContinuation(context: ModuleContext, settings: ModuleSettings): StrategyResult {
  const name = 'PullbackContinuation';
  const blocked = gate(name, settings, context);
  if (blocked) return blocked;
  const f = context.features;
  const lookback = numberSetting(settings, 'lookbackMinutes', 30);
  const reference = context.observations.at(-1)?.timestamp.getTime() ?? context.now.getTime();
  const series = normalizeObservations(context.observations).filter((observation) => (observation.priceUsd ?? 0) > 0 && observation.timestamp.getTime() >= reference - lookback * MINUTE);
  if (series.length < 6) return unavailableResult(name, settings, context, 'WARMING_UP', 'Adatgyűjtés folyamatban (kevés árpont a mintához).');
  const prices = series.map((observation) => observation.priceUsd!);
  const current = prices.at(-1)!;
  // The peak must leave room for a pullback and a reclaim after it.
  const peakIndex = prices.slice(0, -2).reduce((best, price, index) => (price > prices[best] ? index : best), 0);
  const impulseLow = Math.min(...prices.slice(0, peakIndex + 1));
  const peak = prices[peakIndex];
  const afterPeak = prices.slice(peakIndex + 1, -1);
  const trough = afterPeak.length ? Math.min(...afterPeak) : current;
  const troughIndex = peakIndex + 1 + afterPeak.indexOf(trough);
  const impulsePercent = (peak / impulseLow - 1) * 100;
  const retracementPercent = peak > impulseLow ? (peak - trough) / (peak - impulseLow) * 100 : 0;
  const reclaimPercent = (current / trough - 1) * 100;
  const pullbackMinutes = afterPeak.length ? (series[troughIndex].timestamp.getTime() - series[peakIndex].timestamp.getTime()) / MINUTE : 0;
  const minImpulse = numberSetting(settings, 'minImpulsePercent', 15);
  const minRetracement = numberSetting(settings, 'minRetracementPercent', 20);
  const maxRetracement = numberSetting(settings, 'maxRetracementPercent', 65);
  const minReclaim = numberSetting(settings, 'minReclaimPercent', 3);
  const buyersReturn = f.buyShare5m !== null && f.buyShare5m >= 0.55 && (f.buyShare1h === null || f.buyShare5m >= f.buyShare1h);
  const lastStepUp = prices.length >= 2 && current > prices[prices.length - 2];
  const reasons: string[] = [];
  const warnings: string[] = [];
  let score: number;
  let valid = false;
  if (impulsePercent < minImpulse || afterPeak.length === 0) {
    score = 20;
    reasons.push(`Nincs elég erős kezdeti lendület (${fmt(impulsePercent)}% < ${minImpulse}%).`);
  } else {
    score = 40;
    reasons.push(`Kezdeti lendület +${fmt(impulsePercent)}%, visszahúzódás ${fmt(retracementPercent, 0)}% (${fmt(pullbackMinutes, 0)} perc).`);
    const controlled = retracementPercent >= minRetracement && retracementPercent <= maxRetracement;
    if (retracementPercent > maxRetracement) { score = Math.min(score, 25); warnings.push('Kontrollálatlan esés – nem visszahúzódás.'); }
    else if (controlled) { score += 20; valid = true; }
    if (reclaimPercent >= minReclaim) { score += Math.min(20, 20 * reclaimPercent / (2 * minReclaim)); reasons.push(`Visszaszerzés +${fmt(reclaimPercent)}% a mélypontról.`); }
    if (buyersReturn) { score += 10; reasons.push('A vevők visszatértek.'); }
    if (f.volumeAcceleration !== null && f.volumeAcceleration >= 1) score += 10;
    if (!lastStepUp) { score -= 15; warnings.push('Az ár még nem fordult felfelé.'); }
  }
  const finalScore = clampScore(score);
  return okResult(name, settings, context, {
    score: finalScore,
    triggered: valid && reclaimPercent >= minReclaim && buyersReturn && lastStepUp && finalScore >= settings.minScore,
    confidence: f.buyShare5m === null ? 0.7 : 1,
    reasons,
    warnings,
    features: { impulsePercent, retracementPercent, pullbackMinutes, reclaimPercent, buyersReturn },
  });
}

/** Percentile of `value` among the other candidates' values (ties count half); 0 = lowest, 100 = highest. */
export function percentileRank(value: number, others: number[]) {
  if (others.length === 0) return null;
  const below = others.filter((other) => other < value).length;
  const equal = others.filter((other) => other === value).length;
  return (below + 0.5 * equal) / others.length * 100;
}

const RELATIVE_STRENGTH_METRICS = ['priceChange5m', 'volumeSpikeRatio', 'buyShare5m', 'liquidityChange15m'] as const;

/** Relative Strength (Relatív erősség): cross-sectional rank against the current candidate universe. */
export function evaluateRelativeStrength(context: ModuleContext, settings: ModuleSettings): StrategyResult {
  const name = 'RelativeStrength';
  const blocked = gate(name, settings, context);
  if (blocked) return blocked;
  const minSample = numberSetting(settings, 'minCandidateSample', 10);
  const others = (context.universe ?? []).filter((candidate) => candidate.tokenAddress !== context.tokenAddress && candidate.features.dataQuality !== 'INVALID' && candidate.features.dataQuality !== 'STALE');
  const features: StrategyResult['features'] = { candidateCount: others.length + 1 };
  const percentiles: number[] = [];
  for (const metric of RELATIVE_STRENGTH_METRICS) {
    const own = context.features[metric];
    const values = others.map((candidate) => candidate.features[metric]).filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
    if (typeof own !== 'number' || values.length + 1 < minSample) { features[`${metric}Percentile`] = null; continue; }
    const rank = percentileRank(own, values)!;
    features[`${metric}Percentile`] = rank;
    percentiles.push(rank);
  }
  if (percentiles.length < 2) return unavailableResult(name, settings, context, 'INSUFFICIENT_CANDIDATE_SAMPLE', `Nincs elég összehasonlítható jelölt (legalább ${minSample} kell, legalább 2 mutatóval).`, features);
  const score = percentiles.reduce((total, value) => total + value, 0) / percentiles.length;
  const labels: Record<string, string> = { priceChange5m: '5p ármozgás', volumeSpikeRatio: 'forgalomkitörés', buyShare5m: 'vételi arány', liquidityChange15m: 'likviditásnövekedés' };
  const reasons = RELATIVE_STRENGTH_METRICS.filter((metric) => typeof features[`${metric}Percentile`] === 'number')
    .map((metric) => `${labels[metric]}: felső ${fmt(100 - (features[`${metric}Percentile`] as number), 0)}%`);
  return okResult(name, settings, context, {
    score,
    triggered: clampScore(score) >= settings.minScore,
    confidence: percentiles.length / RELATIVE_STRENGTH_METRICS.length,
    reasons: [`${others.length + 1} jelölthöz viszonyítva – ${reasons.join(', ')}.`],
    features,
  });
}

export type ExhaustionLevel = 'NORMAL' | 'WARNING' | 'STRONG_WARNING' | 'BLOCK';

export interface ExhaustionThresholds {
  warning: number;
  strongWarning: number;
  block: number;
}

export function exhaustionLevel(score: number, thresholds: ExhaustionThresholds): ExhaustionLevel {
  if (score >= thresholds.block) return 'BLOCK';
  if (score >= thresholds.strongWarning) return 'STRONG_WARNING';
  if (score >= thresholds.warning) return 'WARNING';
  return 'NORMAL';
}

/**
 * Pump Exhaustion (Pump kifáradás): defensive score 0-100 (100 = extreme evidence that the move is spent).
 * Components: extreme prior move (30), decelerating momentum (15), decelerating volume (15), weakening
 * buy pressure (15), rejection from the local high (15), deteriorating liquidity (10).
 */
export function evaluatePumpExhaustion(context: ModuleContext, settings: ModuleSettings, thresholds: ExhaustionThresholds): StrategyResult {
  const name = 'PumpExhaustion';
  if (!settings.enabled) return disabledResult(name, settings, context);
  const f = context.features;
  if (f.dataQuality === 'INVALID' || f.dataQuality === 'STALE') return unavailableResult(name, settings, context, f.dataQuality === 'STALE' ? 'STALE_MARKET_DATA' : 'INVALID_MARKET_DATA', 'Érvénytelen vagy elavult piaci adat.');
  const priorMove = f.priceChange1h ?? f.priceChange30m;
  if (priorMove === null && f.momentumWindows === null) return unavailableResult(name, settings, context, 'INSUFFICIENT_MARKET_DATA', 'Nincs órás árváltozás és ártörténet sem.');
  const extreme = numberSetting(settings, 'extremeMovePercent', 100);
  const reasons: string[] = [];
  let score = 0;
  let inputs = 0;
  if (priorMove !== null) {
    inputs += 1;
    const points = Math.max(0, Math.min(30, 30 * priorMove / extreme));
    score += points;
    if (priorMove >= extreme * 0.5) reasons.push(`Nagy előzetes emelkedés: +${fmt(priorMove, 0)}%.`);
  }
  if (f.momentumWindows) {
    inputs += 1;
    const [, r2, r3] = f.momentumWindows;
    if (r2 > 0 && r3 < r2) { score += 15; reasons.push('A momentum lassul.'); }
  }
  if (f.volumeAcceleration !== null) {
    inputs += 1;
    if (f.volumeAcceleration < 0.7) { score += 15; reasons.push('A forgalom csökken.'); }
  }
  if (f.buyShare5m !== null) {
    inputs += 1;
    const weakening = f.buyShare5m < 0.5 || (f.buyShare1h !== null && f.buyShare5m < f.buyShare1h - 0.05);
    if (weakening) { score += 15; reasons.push('Gyengül a vételi nyomás / nő az eladási nyomás.'); }
  }
  if (f.distanceFromRecentHighPercent !== null) {
    inputs += 1;
    if (f.distanceFromRecentHighPercent <= -10 && (priorMove ?? 0) > 20) { score += 15; reasons.push(`Visszautasítás a helyi csúcsról (${fmt(f.distanceFromRecentHighPercent)}%).`); }
  }
  if (f.liquidityChange15m !== null) {
    inputs += 1;
    if (f.liquidityChange15m < -10) { score += 10; reasons.push(`Romló likviditás (${fmt(f.liquidityChange15m)}% / 15 perc).`); }
  }
  const finalScore = clampScore(score);
  const level = exhaustionLevel(finalScore, thresholds);
  if (reasons.length === 0) reasons.push('Nincs számottevő kifáradási jel.');
  return okResult(name, settings, context, {
    score: finalScore,
    // For this defensive module "triggered" means: exhaustion reached the warning threshold.
    triggered: level !== 'NORMAL',
    confidence: inputs / 6,
    reasons,
    warnings: level === 'NORMAL' ? [] : [`Pump kifáradás: ${finalScore}/100 (${level}).`],
    features: { exhaustionScore: finalScore, level, priorMovePercent: priorMove, volumeAcceleration: f.volumeAcceleration, buyShare5m: f.buyShare5m, distanceFromRecentHighPercent: f.distanceFromRecentHighPercent },
  });
}
