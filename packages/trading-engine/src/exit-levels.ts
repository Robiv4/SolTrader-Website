/**
 * Read model of a position's exit levels. It never re-evaluates exits: every level comes from the state the
 * Exit Engine (worker) persisted on the position; only distances to the current price are derived here.
 */
export interface PersistedExitState {
  entryPrice: number;
  stopLossPrice: number | null;
  takeProfitPrice: number | null;
  /** Fractions as stored on the position (0.08 = 8%). */
  trailingDistance: number | null;
  trailingActivation: number | null;
  trailingActive: boolean;
  trailingActivatedAt: Date | null;
  trailingActivationPrice: number | null;
  trailingTriggerPrice: number | null;
  breakEvenActivation: number | null;
  breakEvenAppliedAt: Date | null;
  highestPrice: number | null;
  lowestPrice: number | null;
}

export interface ExitLevelsView {
  entryPrice: number;
  currentPrice: number | null;
  stopLoss: { price: number; percentFromEntry: number; distancePercent: number | null } | null;
  takeProfit: { price: number; percentFromEntry: number; distancePercent: number | null } | null;
  breakEven: { enabled: boolean; activationPercent: number | null; activationPrice: number | null; status: 'OFF' | 'WAITING' | 'ACTIVE'; appliedAt: string | null; distanceToActivationPercent: number | null };
  trailing: {
    enabled: boolean;
    distancePercent: number | null;
    activationPercent: number | null;
    /** Price at which trailing arms (entry x (1 + activation)); null when armed from entry (legacy). */
    activationLevelPrice: number | null;
    status: 'OFF' | 'WAITING' | 'ACTIVE';
    activatedAt: string | null;
    activationPrice: number | null;
    triggerPrice: number | null;
    distanceToActivationPercent: number | null;
    distanceToTriggerPercent: number | null;
  };
  highestPrice: number | null;
  lowestPrice: number | null;
}

const distance = (target: number | null, current: number | null) => (target !== null && current !== null && current > 0 ? (target / current - 1) * 100 : null);

export function describeExitLevels(state: PersistedExitState, currentPrice: number | null): ExitLevelsView {
  const entry = state.entryPrice;
  const level = (price: number | null) => (price !== null && price > 0 ? { price, percentFromEntry: (price / entry - 1) * 100, distancePercent: distance(price, currentPrice) } : null);
  const trailingEnabled = state.trailingDistance !== null && state.trailingDistance > 0;
  const activationLevelPrice = trailingEnabled && state.trailingActivation ? entry * (1 + state.trailingActivation) : null;
  const breakEvenEnabled = state.breakEvenActivation !== null && state.breakEvenActivation > 0;
  const breakEvenActivationPrice = breakEvenEnabled ? entry * (1 + state.breakEvenActivation!) : null;
  return {
    entryPrice: entry,
    currentPrice,
    stopLoss: level(state.stopLossPrice),
    takeProfit: level(state.takeProfitPrice),
    breakEven: {
      enabled: breakEvenEnabled,
      activationPercent: breakEvenEnabled ? state.breakEvenActivation! * 100 : null,
      activationPrice: breakEvenActivationPrice,
      status: !breakEvenEnabled ? 'OFF' : state.breakEvenAppliedAt ? 'ACTIVE' : 'WAITING',
      appliedAt: state.breakEvenAppliedAt?.toISOString() ?? null,
      distanceToActivationPercent: state.breakEvenAppliedAt ? null : distance(breakEvenActivationPrice, currentPrice),
    },
    trailing: {
      enabled: trailingEnabled,
      distancePercent: trailingEnabled ? state.trailingDistance! * 100 : null,
      activationPercent: trailingEnabled && state.trailingActivation ? state.trailingActivation * 100 : trailingEnabled ? 0 : null,
      activationLevelPrice,
      status: !trailingEnabled ? 'OFF' : state.trailingActive ? 'ACTIVE' : 'WAITING',
      activatedAt: state.trailingActivatedAt?.toISOString() ?? null,
      activationPrice: state.trailingActivationPrice,
      triggerPrice: state.trailingActive ? state.trailingTriggerPrice : null,
      distanceToActivationPercent: state.trailingActive ? null : distance(activationLevelPrice, currentPrice),
      distanceToTriggerPercent: state.trailingActive ? distance(state.trailingTriggerPrice, currentPrice) : null,
    },
    highestPrice: state.highestPrice,
    lowestPrice: state.lowestPrice,
  };
}
