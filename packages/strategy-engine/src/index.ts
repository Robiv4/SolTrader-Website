export interface StrategyModel {
  id: string;
  name: string;
  enabled: boolean;
  stage: 'scanner' | 'paper' | 'semi-auto' | 'live';
}

export function createStrategy(id: string, name: string): StrategyModel {
  return { id, name, enabled: true, stage: 'paper' };
}

export type RecommendedAction = 'BUY' | 'SELL' | 'WATCH' | 'REJECT';

export interface StrategyMarketData {
  token: string;
  timestamp: Date;
  riskScore: number;
  shortTermMomentum?: number;
  volumeAcceleration?: number;
  buyPressure?: number;
  liquidityStability?: number;
  localConsolidation?: number;
  resistance?: number;
  breakout?: number;
  volumeConfirmation?: number;
  initialImpulse?: number;
  retracement?: number;
  support?: number;
  renewedBuyingPressure?: number;
}

export interface StrategyEvaluationContext {
  hasOpenPosition?: boolean;
}

export interface StrategySignal {
  token: string;
  timestamp: Date;
  strategy: string;
  score: number;
  riskScore: number;
  reasons: string[];
  recommendedAction: RecommendedAction;
}

export interface Strategy<TConfiguration extends object = object> {
  readonly name: string;
  readonly description: string;
  readonly parameters: readonly string[];
  readonly entryConditions: readonly string[];
  readonly exitConditions: readonly string[];
  readonly cooldownMs: number;
  readonly configuration: TConfiguration;
  evaluate(data: StrategyMarketData, context?: StrategyEvaluationContext): StrategySignal;
}

export interface MomentumStrategyConfiguration {
  minimumMomentum: number;
  minimumVolumeAcceleration: number;
  minimumBuyPressure: number;
  minimumLiquidityStability: number;
  maximumRiskScore: number;
  cooldownMs: number;
}

export interface BreakoutStrategyConfiguration {
  minimumConsolidation: number;
  minimumResistance: number;
  minimumBreakout: number;
  minimumVolumeConfirmation: number;
  maximumRiskScore: number;
  cooldownMs: number;
}

export interface PullbackStrategyConfiguration {
  minimumInitialImpulse: number;
  minimumRetracement: number;
  minimumSupport: number;
  minimumRenewedBuyingPressure: number;
  maximumRiskScore: number;
  cooldownMs: number;
}

export const DEFAULT_MOMENTUM_CONFIGURATION: MomentumStrategyConfiguration = {
  minimumMomentum: 60,
  minimumVolumeAcceleration: 55,
  minimumBuyPressure: 55,
  minimumLiquidityStability: 50,
  maximumRiskScore: 66,
  cooldownMs: 15 * 60 * 1000,
};

export const DEFAULT_BREAKOUT_CONFIGURATION: BreakoutStrategyConfiguration = {
  minimumConsolidation: 60,
  minimumResistance: 60,
  minimumBreakout: 65,
  minimumVolumeConfirmation: 60,
  maximumRiskScore: 66,
  cooldownMs: 20 * 60 * 1000,
};

export const DEFAULT_PULLBACK_CONFIGURATION: PullbackStrategyConfiguration = {
  minimumInitialImpulse: 60,
  minimumRetracement: 40,
  minimumSupport: 60,
  minimumRenewedBuyingPressure: 60,
  maximumRiskScore: 66,
  cooldownMs: 20 * 60 * 1000,
};

/** Strategy names accepted by createConfiguredStrategy, i.e. the names users can enable per account. */
export const CONFIGURABLE_STRATEGY_NAMES = ['Momentum', 'Breakout', 'Pullback'] as const;
export type ConfigurableStrategyName = (typeof CONFIGURABLE_STRATEGY_NAMES)[number];

/** Tunable numeric parameters (and their defaults) for each configurable strategy. */
export const STRATEGY_PARAMETER_DEFAULTS: Record<ConfigurableStrategyName, Record<string, number>> = {
  Momentum: { ...DEFAULT_MOMENTUM_CONFIGURATION },
  Breakout: { ...DEFAULT_BREAKOUT_CONFIGURATION },
  Pullback: { ...DEFAULT_PULLBACK_CONFIGURATION },
};

export function isConfigurableStrategyName(name: string): name is ConfigurableStrategyName {
  return (CONFIGURABLE_STRATEGY_NAMES as readonly string[]).includes(name);
}

function clamp(value: number) {
  return Math.min(100, Math.max(0, Math.round(value)));
}

function value(data: number | undefined) {
  return data ?? 0;
}

function assessSignal(
  data: StrategyMarketData,
  context: StrategyEvaluationContext,
  strategy: string,
  score: number,
  entryConditions: Array<[boolean, string]>,
  exitConditions: Array<[boolean, string]>,
  maximumRiskScore: number,
) {
  const reasons = entryConditions.map(([condition, reason]) => condition ? reason : `${reason} not met.`);
  const exits = exitConditions.filter(([condition]) => condition).map(([, reason]) => reason);
  const normalizedScore = clamp(score);

  if (data.riskScore > maximumRiskScore) {
    return {
      token: data.token,
      timestamp: data.timestamp,
      strategy,
      score: normalizedScore,
      riskScore: data.riskScore,
      reasons: [`Risk score ${data.riskScore} exceeds configured maximum ${maximumRiskScore}.`],
      recommendedAction: 'REJECT' as const,
    };
  }

  if (context.hasOpenPosition && exits.length === exitConditions.length && exits.length > 0) {
    return {
      token: data.token,
      timestamp: data.timestamp,
      strategy,
      score: normalizedScore,
      riskScore: data.riskScore,
      reasons: exits,
      recommendedAction: 'SELL' as const,
    };
  }

  const allEntryConditionsMet = entryConditions.every(([condition]) => condition);
  return {
    token: data.token,
    timestamp: data.timestamp,
    strategy,
    score: normalizedScore,
    riskScore: data.riskScore,
    reasons: allEntryConditionsMet ? reasons : [...reasons, 'Entry conditions are incomplete.'],
    recommendedAction: allEntryConditionsMet ? 'BUY' as const : 'WATCH' as const,
  };
}

export class MomentumStrategy implements Strategy<MomentumStrategyConfiguration> {
  readonly name = 'MomentumStrategy';
  readonly description = 'Evaluates short-term momentum with volume, buy pressure, liquidity stability, and risk.';
  readonly parameters = ['short-term momentum', 'volume acceleration', 'buy pressure', 'liquidity stability', 'risk score'];
  readonly entryConditions = ['momentum threshold', 'volume acceleration threshold', 'buy pressure threshold', 'liquidity stability threshold', 'risk threshold'];
  readonly exitConditions = ['momentum has weakened', 'buy pressure has weakened'];

  constructor(readonly configuration: MomentumStrategyConfiguration = DEFAULT_MOMENTUM_CONFIGURATION) {}

  get cooldownMs() {
    return this.configuration.cooldownMs;
  }

  evaluate(data: StrategyMarketData, context: StrategyEvaluationContext = {}) {
    const momentum = value(data.shortTermMomentum);
    const volumeAcceleration = value(data.volumeAcceleration);
    const buyPressure = value(data.buyPressure);
    const liquidityStability = value(data.liquidityStability);
    const score = (momentum + volumeAcceleration + buyPressure + liquidityStability + (100 - data.riskScore)) / 5;
    return assessSignal(data, context, this.name, score, [
      [momentum >= this.configuration.minimumMomentum, 'Short-term momentum meets threshold.'],
      [volumeAcceleration >= this.configuration.minimumVolumeAcceleration, 'Volume acceleration meets threshold.'],
      [buyPressure >= this.configuration.minimumBuyPressure, 'Buy pressure meets threshold.'],
      [liquidityStability >= this.configuration.minimumLiquidityStability, 'Liquidity is stable.'],
    ], [
      [momentum < this.configuration.minimumMomentum, 'Momentum has weakened.'],
      [buyPressure < this.configuration.minimumBuyPressure, 'Buy pressure has weakened.'],
    ], this.configuration.maximumRiskScore);
  }
}

export class BreakoutStrategy implements Strategy<BreakoutStrategyConfiguration> {
  readonly name = 'BreakoutStrategy';
  readonly description = 'Evaluates local consolidation, resistance, breakout strength, and confirming volume.';
  readonly parameters = ['local consolidation', 'resistance', 'breakout', 'volume confirmation', 'risk score'];
  readonly entryConditions = ['consolidation threshold', 'resistance threshold', 'breakout threshold', 'volume confirmation threshold', 'risk threshold'];
  readonly exitConditions = ['breakout has failed', 'volume confirmation has weakened'];

  constructor(readonly configuration: BreakoutStrategyConfiguration = DEFAULT_BREAKOUT_CONFIGURATION) {}

  get cooldownMs() {
    return this.configuration.cooldownMs;
  }

  evaluate(data: StrategyMarketData, context: StrategyEvaluationContext = {}) {
    const consolidation = value(data.localConsolidation);
    const resistance = value(data.resistance);
    const breakout = value(data.breakout);
    const volumeConfirmation = value(data.volumeConfirmation);
    const score = (consolidation + resistance + breakout + volumeConfirmation + (100 - data.riskScore)) / 5;
    return assessSignal(data, context, this.name, score, [
      [consolidation >= this.configuration.minimumConsolidation, 'Local consolidation meets threshold.'],
      [resistance >= this.configuration.minimumResistance, 'Resistance level is defined.'],
      [breakout >= this.configuration.minimumBreakout, 'Breakout strength meets threshold.'],
      [volumeConfirmation >= this.configuration.minimumVolumeConfirmation, 'Breakout volume is confirmed.'],
    ], [
      [breakout < this.configuration.minimumBreakout, 'Breakout has failed.'],
      [volumeConfirmation < this.configuration.minimumVolumeConfirmation, 'Volume confirmation has weakened.'],
    ], this.configuration.maximumRiskScore);
  }
}

export class PullbackStrategy implements Strategy<PullbackStrategyConfiguration> {
  readonly name = 'PullbackStrategy';
  readonly description = 'Evaluates an initial impulse, retracement, support, and renewed buying pressure.';
  readonly parameters = ['initial impulse', 'retracement', 'support', 'renewed buying pressure', 'risk score'];
  readonly entryConditions = ['impulse threshold', 'retracement threshold', 'support threshold', 'renewed buying threshold', 'risk threshold'];
  readonly exitConditions = ['support has failed', 'buying pressure has weakened'];

  constructor(readonly configuration: PullbackStrategyConfiguration = DEFAULT_PULLBACK_CONFIGURATION) {}

  get cooldownMs() {
    return this.configuration.cooldownMs;
  }

  evaluate(data: StrategyMarketData, context: StrategyEvaluationContext = {}) {
    const impulse = value(data.initialImpulse);
    const retracement = value(data.retracement);
    const support = value(data.support);
    const renewedBuying = value(data.renewedBuyingPressure);
    const score = (impulse + retracement + support + renewedBuying + (100 - data.riskScore)) / 5;
    return assessSignal(data, context, this.name, score, [
      [impulse >= this.configuration.minimumInitialImpulse, 'Initial impulse meets threshold.'],
      [retracement >= this.configuration.minimumRetracement, 'Retracement is present.'],
      [support >= this.configuration.minimumSupport, 'Support meets threshold.'],
      [renewedBuying >= this.configuration.minimumRenewedBuyingPressure, 'Renewed buying pressure meets threshold.'],
    ], [
      [support < this.configuration.minimumSupport, 'Support has failed.'],
      [renewedBuying < this.configuration.minimumRenewedBuyingPressure, 'Buying pressure has weakened.'],
    ], this.configuration.maximumRiskScore);
  }
}

export function createDefaultStrategies(): Strategy[] {
  return [new MomentumStrategy(), new BreakoutStrategy(), new PullbackStrategy()];
}

function numberParam(params: Record<string, unknown>, key: string, fallback: number): number {
  const raw = params[key];
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback;
}

/**
 * Builds a strategy instance from a persisted per-user StrategyConfig row
 * (strategyName + params JSON from PostgreSQL). Unknown strategy names return
 * undefined instead of silently defaulting to a strategy the user didn't choose.
 */
export function createConfiguredStrategy(strategyName: string, params: Record<string, unknown> = {}): Strategy | undefined {
  switch (strategyName) {
    case 'Momentum':
      return new MomentumStrategy({
        minimumMomentum: numberParam(params, 'minimumMomentum', DEFAULT_MOMENTUM_CONFIGURATION.minimumMomentum),
        minimumVolumeAcceleration: numberParam(params, 'minimumVolumeAcceleration', DEFAULT_MOMENTUM_CONFIGURATION.minimumVolumeAcceleration),
        minimumBuyPressure: numberParam(params, 'minimumBuyPressure', DEFAULT_MOMENTUM_CONFIGURATION.minimumBuyPressure),
        minimumLiquidityStability: numberParam(params, 'minimumLiquidityStability', DEFAULT_MOMENTUM_CONFIGURATION.minimumLiquidityStability),
        maximumRiskScore: numberParam(params, 'maximumRiskScore', DEFAULT_MOMENTUM_CONFIGURATION.maximumRiskScore),
        cooldownMs: numberParam(params, 'cooldownMs', DEFAULT_MOMENTUM_CONFIGURATION.cooldownMs),
      });
    case 'Breakout':
      return new BreakoutStrategy({
        minimumConsolidation: numberParam(params, 'minimumConsolidation', DEFAULT_BREAKOUT_CONFIGURATION.minimumConsolidation),
        minimumResistance: numberParam(params, 'minimumResistance', DEFAULT_BREAKOUT_CONFIGURATION.minimumResistance),
        minimumBreakout: numberParam(params, 'minimumBreakout', DEFAULT_BREAKOUT_CONFIGURATION.minimumBreakout),
        minimumVolumeConfirmation: numberParam(params, 'minimumVolumeConfirmation', DEFAULT_BREAKOUT_CONFIGURATION.minimumVolumeConfirmation),
        maximumRiskScore: numberParam(params, 'maximumRiskScore', DEFAULT_BREAKOUT_CONFIGURATION.maximumRiskScore),
        cooldownMs: numberParam(params, 'cooldownMs', DEFAULT_BREAKOUT_CONFIGURATION.cooldownMs),
      });
    case 'Pullback':
      return new PullbackStrategy({
        minimumInitialImpulse: numberParam(params, 'minimumInitialImpulse', DEFAULT_PULLBACK_CONFIGURATION.minimumInitialImpulse),
        minimumRetracement: numberParam(params, 'minimumRetracement', DEFAULT_PULLBACK_CONFIGURATION.minimumRetracement),
        minimumSupport: numberParam(params, 'minimumSupport', DEFAULT_PULLBACK_CONFIGURATION.minimumSupport),
        minimumRenewedBuyingPressure: numberParam(params, 'minimumRenewedBuyingPressure', DEFAULT_PULLBACK_CONFIGURATION.minimumRenewedBuyingPressure),
        maximumRiskScore: numberParam(params, 'maximumRiskScore', DEFAULT_PULLBACK_CONFIGURATION.maximumRiskScore),
        cooldownMs: numberParam(params, 'cooldownMs', DEFAULT_PULLBACK_CONFIGURATION.cooldownMs),
      });
    default:
      return undefined;
  }
}


export * from './advanced/index.js';
export * from './launch/index.js';
export * from './ml/index.js';
export * from './social/index.js';
