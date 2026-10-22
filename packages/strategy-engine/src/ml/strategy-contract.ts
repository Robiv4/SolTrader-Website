/**
 * ML-only trading contract (SolTrader 3.0). Pure and deterministic: who may open NEW PAPER entries for a user, and in
 * which user-facing operating state the user is. Shared by the worker (signals, execution) and the API (state display).
 *
 * Components are independent and never exclusive:
 *   data collection  - always runs (launch tracking, market stream, on-chain, Community / Telegram, ML snapshots +
 *                      outcomes), with or without a model, a BUY or any user strategy;
 *   training         - offline, versioned, never changes the selection;
 *   trading          - only the ONE selected, PAPER-approved model may open new entries.
 *
 * Operating states (one per user):
 *   DATA_COLLECTION   - no trading model selected: data only, no new positions;
 *   MODEL_TRAINING    - no trading model selected, a training run is in progress (data collection continues);
 *   ML_PAPER_ACTIVE   - the selected, approved model alone makes PAPER entry decisions;
 *   TRADING_PAUSED    - no new entries (user pause, emergency stop, not PAPER); data collection and the protection of
 *                       open positions continue;
 *   MODEL_UNAVAILABLE - the selected model cannot be used (revoked, retired, missing, unsupported): no new positions.
 *
 * Never: a DEFAULT (rule-based) fallback in ML-only mode, two models entering for one user, LIVE trading.
 * Exits of open positions are not decided here: the Exit Engine protects them in every state.
 */

/** Redis marker of a running training (operating state MODEL_TRAINING; informational, never gates trading). */
export const ML_TRAINING_KEY = 'ml:training:active';

export type MlTradingState = 'DATA_COLLECTION' | 'MODEL_TRAINING' | 'ML_PAPER_ACTIVE' | 'TRADING_PAUSED' | 'MODEL_UNAVAILABLE';
/** DEFAULT = rule-based (legacy), ML = ML PAPER entry model (rule-based exits), ML_AUTONOMOUS = Autonomous ML bundle. */
export type EntryStrategy = 'DEFAULT' | 'ML' | 'ML_AUTONOMOUS';
export const ML_AUTONOMOUS_STRATEGY = 'ML_AUTONOMOUS';
/** Feature version of Autonomous bundles (kept here to avoid an import cycle; equals ML_AUTONOMOUS_FEATURE_VERSION). */
const AUTONOMOUS_FEATURE_VERSION = 'ML-FEATURES-AUTONOMOUS-v1';

export interface StrategySelectionInput {
  /** ML_ONLY_ARCHITECTURE_ENABLED: the rule-based strategy can no longer open entries. */
  mlOnly: boolean;
  /** Stored selection; null = no row (ML-only: no model; legacy: DEFAULT). */
  settings: { strategyMode: string; modelVersion: string | null; autonomousBundleVersion?: string | null; tradingPaused?: boolean | null } | null;
  /** false = the selection could not be read: fail-closed (no entries). */
  settingsReadable?: boolean;
  /** The selected model's registry row (null = not found / not looked up). */
  model: { version: string; paperApproved: boolean; status: string; featureVersion?: string | null } | null;
  /** strategyMode ML_AUTONOMOUS: the selected Autonomous bundle's registry row (null = not found / not looked up). */
  bundle?: { version: string; paperApproved: boolean; status: string; featureVersion?: string | null } | null;
  /** Feature versions the worker can build at decision time. */
  supportedFeatureVersion?: (featureVersion: string) => boolean;
  trainingInProgress?: boolean;
  emergencyStop?: boolean;
  /** Bot / server trading mode: anything but PAPER (or LIVE enabled) pauses entries. */
  tradingMode?: string | null;
  liveEnabled?: boolean;
}

export interface EntryAuthority {
  state: MlTradingState;
  /** May NEW entries be opened at all for this user? */
  mayOpenEntries: boolean;
  /** The only strategy allowed to open entries (null = none). */
  entryStrategy: EntryStrategy | null;
  /** ML: the only model version allowed to open entries. */
  authorizedModelVersion: string | null;
  /** Why entries are not allowed (empty when allowed). */
  reasons: string[];
  components: { dataCollection: 'RUNNING'; training: 'RUNNING' | 'IDLE'; trading: 'ACTIVE' | 'INACTIVE' };
}

const blocked = (state: MlTradingState, reasons: string[], training: boolean): EntryAuthority => ({
  state, mayOpenEntries: false, entryStrategy: null, authorizedModelVersion: null, reasons,
  components: { dataCollection: 'RUNNING', training: training ? 'RUNNING' : 'IDLE', trading: 'INACTIVE' },
});

/** Why a selected model cannot trade (empty = usable). */
export function modelUnavailableReasons(modelVersion: string, model: StrategySelectionInput['model'], supported?: (featureVersion: string) => boolean) {
  if (!model || model.version !== modelVersion) return ['MODEL_NOT_FOUND'];
  const reasons: string[] = [];
  if (!model.paperApproved) reasons.push('MODEL_NOT_PAPER_APPROVED');
  if (model.status === 'RETIRED') reasons.push('MODEL_RETIRED');
  if (supported && model.featureVersion && !supported(model.featureVersion)) reasons.push('MODEL_FEATURE_VERSION_UNSUPPORTED');
  return reasons;
}

/** Entry authority + operating state of one user (fail-closed on anything unknown). */
export function resolveEntryAuthority(input: StrategySelectionInput): EntryAuthority {
  const training = Boolean(input.trainingInProgress);
  if (input.liveEnabled || (input.tradingMode !== undefined && input.tradingMode !== null && input.tradingMode !== 'PAPER')) return blocked('TRADING_PAUSED', ['PAPER_MODE_REQUIRED'], training);
  if (input.settingsReadable === false) return blocked('TRADING_PAUSED', ['STRATEGY_SELECTION_UNREADABLE'], training);
  if (input.emergencyStop) return blocked('TRADING_PAUSED', ['EMERGENCY_STOP'], training);
  if (input.settings?.tradingPaused) return blocked('TRADING_PAUSED', ['TRADING_PAUSED_BY_USER'], training);
  const stored = input.settings?.strategyMode;
  // Every unknown mode is treated as "no trading model" (never as DEFAULT buying).
  const mode = stored === 'ML' ? 'ML' : stored === ML_AUTONOMOUS_STRATEGY ? ML_AUTONOMOUS_STRATEGY : stored === 'DEFAULT' || stored === undefined ? 'DEFAULT' : 'UNKNOWN';
  const modelVersion = input.settings?.modelVersion ?? null;
  if (mode === ML_AUTONOMOUS_STRATEGY) {
    // Autonomous ML: the selected bundle alone makes BUY / HOLD / SELL decisions in its own PAPER account.
    const bundleVersion = input.settings?.autonomousBundleVersion ?? null;
    if (!bundleVersion) return blocked(training ? 'MODEL_TRAINING' : 'DATA_COLLECTION', ['NO_TRADING_MODEL_SELECTED'], training);
    const bundleReasons = modelUnavailableReasons(bundleVersion, input.bundle ?? null, (featureVersion) => featureVersion === AUTONOMOUS_FEATURE_VERSION);
    if (bundleReasons.length) return blocked('MODEL_UNAVAILABLE', bundleReasons, training);
    return { state: 'ML_PAPER_ACTIVE', mayOpenEntries: true, entryStrategy: ML_AUTONOMOUS_STRATEGY, authorizedModelVersion: bundleVersion, reasons: [], components: { dataCollection: 'RUNNING', training: training ? 'RUNNING' : 'IDLE', trading: 'ACTIVE' } };
  }
  if (mode === 'UNKNOWN') return blocked('DATA_COLLECTION', ['UNKNOWN_STRATEGY_MODE'], training);
  // ML-only: a DEFAULT row (old selection) or no row means "no trading model"; the model must be chosen explicitly again.
  const mlSelected = mode === 'ML' && modelVersion !== null;
  if (!input.mlOnly && mode === 'DEFAULT') {
    // Legacy compatibility (flag off): the rule-based strategy keeps working unchanged.
    return { state: 'ML_PAPER_ACTIVE', mayOpenEntries: true, entryStrategy: 'DEFAULT', authorizedModelVersion: null, reasons: [], components: { dataCollection: 'RUNNING', training: training ? 'RUNNING' : 'IDLE', trading: 'ACTIVE' } };
  }
  if (!mlSelected) return blocked(training ? 'MODEL_TRAINING' : 'DATA_COLLECTION', ['NO_TRADING_MODEL_SELECTED'], training);
  const reasons = modelUnavailableReasons(modelVersion, input.model, input.supportedFeatureVersion);
  // No fallback: an unusable model never hands entries to the DEFAULT strategy.
  if (reasons.length) return blocked('MODEL_UNAVAILABLE', reasons, training);
  return { state: 'ML_PAPER_ACTIVE', mayOpenEntries: true, entryStrategy: 'ML', authorizedModelVersion: modelVersion, reasons: [], components: { dataCollection: 'RUNNING', training: training ? 'RUNNING' : 'IDLE', trading: 'ACTIVE' } };
}

/**
 * Execution-time check of one entry signal against the authority (defence in depth: a signal made before a model switch,
 * by another model or by the rule-based strategy in ML-only mode is never executed).
 */
export function authorizeEntry(authority: EntryAuthority, signal: { entryStrategy: EntryStrategy; modelVersion?: string | null }): { allowed: true } | { allowed: false; reason: string } {
  if (!authority.mayOpenEntries || !authority.entryStrategy) return { allowed: false, reason: authority.reasons[0] ?? authority.state };
  if (signal.entryStrategy !== authority.entryStrategy) return { allowed: false, reason: signal.entryStrategy === 'DEFAULT' ? 'DEFAULT_STRATEGY_DISABLED' : 'ENTRY_STRATEGY_NOT_ACTIVE' };
  if (signal.entryStrategy !== 'DEFAULT' && (!signal.modelVersion || signal.modelVersion !== authority.authorizedModelVersion)) return { allowed: false, reason: 'ML_MODEL_NOT_SELECTED' };
  return { allowed: true };
}

/** Strategies a user can choose in the UI (ML-only: no DEFAULT selector). */
export function selectableStrategies(mlOnly: boolean): EntryStrategy[] {
  return mlOnly ? ['ML', ML_AUTONOMOUS_STRATEGY] : ['DEFAULT', 'ML', ML_AUTONOMOUS_STRATEGY];
}
