/** Hungarian labels for decision sources, position events, launch reasons and security states. */
export const DECISION_SOURCE_LABELS: Record<string, string> = {
  NEW_LAUNCH: 'ÚJ TOKEN',
  AI: 'AI',
  MANUAL_PAPER: 'MANUÁLIS',
  STRATEGY: 'STRATÉGIA',
};

export const DECISION_SOURCE_LONG: Record<string, string> = {
  NEW_LAUNCH: 'Új token / Sniper',
  AI: 'AI',
  MANUAL_PAPER: 'Manuális Paper',
  STRATEGY: 'Stratégia',
};

/** Badge text: the strategy name for strategy entries (MOMENTUM / BREAKOUT / ...). */
export function decisionBadge(source: string | null | undefined, strategyName?: string | null) {
  if (source === 'STRATEGY' && strategyName) {
    const name = strategyName.replace('Strategy', '').replace('CompositeSignal', 'Összetett');
    return name.toUpperCase();
  }
  return DECISION_SOURCE_LABELS[source ?? 'STRATEGY'] ?? source ?? '—';
}

export const POSITION_EVENT_LABELS: Record<string, string> = {
  ENTRY: 'PAPER VÉTEL',
  EXIT: 'Kilépés',
  BREAK_EVEN_APPLIED: 'Break-even aktiválódott (stop a nullszintre emelve)',
  TRAILING_ACTIVATED: 'Követő stop aktiválódott',
  TRAILING_MOVED: 'Követő stop feljebb lépett',
  LIQUIDITY_WARNING: 'Likviditás-figyelmeztetés',
  MARKET_DATA_STALE: 'Elavult piaci adat',
  TAKE_PROFIT_TOUCHED: 'TP érintve',
  STOP_LOSS_TOUCHED: 'Stop loss érintve',
  BREAK_EVEN_STOP_TOUCHED: 'Break-even stop érintve',
  TRAILING_STOP_TOUCHED: 'Követő stop érintve',
  EXIT_CAPACITY_DETERIORATED: 'Kilépési kapacitás romlott',
  SELL_ROUTE_LOST: 'Eladási útvonal elveszett',
  SELL_ROUTE_CHANGED: 'Eladási útvonal változott',
};

export const EXIT_REASON_EVENT_LABELS: Record<string, string> = {
  STOP_LOSS: 'STOP LOSS',
  TAKE_PROFIT: 'TAKE PROFIT',
  TRAILING_STOP: 'KÖVETŐ STOP',
  BREAK_EVEN_STOP: 'BREAK-EVEN STOP',
  LIQUIDITY_OUTFLOW: 'LIKVIDITÁS-BIZTONSÁGI KILÉPÉS',
  EMERGENCY_STOP: 'VÉSZLEÁLLÍTÁS',
  'manual-close': 'KÉZI ZÁRÁS',
};

export const SECURITY_STATE_LABELS: Record<string, string> = {
  VERIFIED: 'Ellenőrizve',
  NOT_VERIFIED: 'Nincs még ellenőrizve',
  FAILED: 'Sikertelen',
  UNKNOWN: 'Ismeretlen',
  REVOKED: 'Visszavonva',
  ACTIVE: 'Aktív',
};

export const LAUNCH_REASON_LABELS: Record<string, string> = {
  LAUNCH_TOO_YOUNG: 'túl fiatal (min. életkor előtt)',
  OBSERVATION_IN_PROGRESS: 'Launch adatok gyűjtése…',
  INSUFFICIENT_LAUNCH_DATA: 'kevés launch adat',
  LAUNCH_WINDOW_EXPIRED: 'kifutott a launch-ablakból',
  SELLABILITY_NOT_VERIFIED: 'eladhatóság még nincs igazolva',
  SELLABILITY_FAILED: 'eladhatóság sikertelen',
  SECURITY_CHECK_PENDING: 'biztonsági ellenőrzés folyamatban',
  MINT_AUTHORITY_ACTIVE: 'mint authority aktív',
  FREEZE_AUTHORITY_ACTIVE: 'freeze authority aktív',
  CRITICAL_TOKEN_EXTENSION: 'kritikus Token-2022 kiterjesztés',
  UNSUPPORTED_TRANSFER_RESTRICTION: 'nem támogatott átutalási korlátozás',
  CRITICAL_LIQUIDITY: 'kritikus likviditás-csökkenés',
  CREATOR_SELLING: 'a létrehozó elad',
  LAUNCH_EXHAUSTED: 'kifáradt launch',
  RISK_SCORE_ABOVE_LAUNCH_MAXIMUM: 'kockázat a maximum fölött',
  RISK_NOT_ASSESSED: 'kockázat még nincs értékelve',
  LIQUIDITY_BELOW_MINIMUM: 'likviditás a minimum alatt',
  LIQUIDITY_ABOVE_MAXIMUM: 'likviditás a maximum fölött',
  PRICE_IMPACT_UNKNOWN: 'árhatás ismeretlen',
  PRICE_IMPACT_TOO_HIGH: 'túl nagy árhatás',
  TRANSACTIONS_BELOW_MINIMUM: 'kevés tranzakció',
  UNIQUE_BUYERS_UNKNOWN: 'egyedi vásárlók száma ismeretlen',
  UNIQUE_BUYERS_BELOW_MINIMUM: 'kevés egyedi vásárló',
  BUY_SELL_RATIO_BELOW_MINIMUM: 'alacsony vétel/eladás arány',
  LAUNCH_VOLUME_BELOW_MINIMUM: 'kevés launch forgalom',
  LAUNCH_SCORE_BELOW_MINIMUM: 'Launch Score a minimum alatt',
  ALL_LAUNCH_CONDITIONS_MET: 'minden feltétel teljesült',
  LIQUIDITY_OUTFLOW: 'likviditás-kiáramlás',
  LOW_LIQUIDITY: 'alacsony likviditás',
  POOL_TOO_YOUNG: 'nagyon friss pool',
  EXCESSIVE_VOLUME_TO_LIQUIDITY: 'a forgalom túl nagy a likviditáshoz képest',
  LOW_TRANSACTION_COUNT: 'kevés tranzakció',
  LOW_VOLUME: 'alacsony forgalom',
  SINGLE_WALLET_DOMINATES_BUYS: 'egy tárca dominálja a vételeket',
  HIGH_EARLY_SUPPLY_CONCENTRATION: 'magas korai tokenkoncentráció',
  AUTHORITY_STATUS_UNKNOWN: 'authority állapot ismeretlen',
  HIGH_VOLATILITY: 'magas volatilitás',
};

export function launchReasons(reasons: unknown) {
  return Array.isArray(reasons) ? reasons.map((reason) => LAUNCH_REASON_LABELS[String(reason)] ?? String(reason)) : [];
}

export const PROVIDER_STATUS_LABELS: Record<string, { label: string; tone: string }> = {
  ACTIVE: { label: 'Aktív', tone: 'positive' },
  CONNECTING: { label: 'Kapcsolódás…', tone: 'neutral' },
  DEGRADED: { label: 'Korlátozott', tone: 'warning' },
  UNAVAILABLE: { label: 'Nem elérhető', tone: 'negative' },
  NOT_CONFIGURED: { label: 'Nem konfigurált', tone: 'neutral' },
};
