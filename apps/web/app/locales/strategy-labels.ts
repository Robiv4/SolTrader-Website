/** Hungarian UI labels of the signal modules (internal names stay English). */
export const MODULE_LABELS_HU: Record<string, string> = {
  Momentum: 'Momentum',
  MomentumAcceleration: 'Momentum gyorsulás',
  VolumeSpike: 'Forgalomkitörés',
  BuyPressure: 'Vételi nyomás',
  ConfirmedBreakout: 'Megerősített kitörés',
  LiquidityInflow: 'Likviditás-beáramlás',
  RelativeStrength: 'Relatív erősség',
  PullbackContinuation: 'Visszahúzódás utáni folytatás',
  PumpExhaustion: 'Pump kifáradás',
  CompositeSignal: 'Összetett jelzés',
  MANUAL_PAPER: 'Manuális Paper',
};

export const MODULE_PARAMETER_LABELS: Record<string, string> = {
  extremeMovePercent: 'Rendkívüli emelkedés (%)',
  minSpikeRatio: 'Minimum kitörési arány (×)',
  minTransactions5m: 'Min. tranzakció / 5 perc',
  minBuySellRatio: 'Min. vétel/eladás arány',
  minAverageTradeUsd: 'Min. átlagos tranzakció (USD)',
  minVolume5mUsd: 'Min. 5 perces forgalom (USD)',
  lookbackMinutes: 'Visszatekintés (perc)',
  confirmationMinutes: 'Megerősítési idő (perc)',
  volumeConfirmationRequired: 'Forgalmi megerősítés kötelező',
  minVolumeRatio: 'Min. forgalmi arány (×)',
  maxExtensionPercent: 'Max. távolság a kitöréstől (%)',
  minLiquidityUsd: 'Min. likviditás (USD)',
  minGrowthPercent: 'Min. likviditásnövekedés (%)',
  outflowWarningPercent: 'Kiáramlás figyelmeztetés (%)',
  criticalOutflowPercent: 'Kritikus kiáramlás (%)',
  minCandidateSample: 'Min. jelöltszám',
  minImpulsePercent: 'Min. kezdeti lendület (%)',
  minRetracementPercent: 'Min. visszahúzódás (%)',
  maxRetracementPercent: 'Max. visszahúzódás (%)',
  minReclaimPercent: 'Min. visszaszerzés (%)',
};

export const MODULE_STATUS_LABELS: Record<string, string> = {
  OK: 'Kiértékelve',
  WARMING_UP: 'Adatgyűjtés folyamatban',
  UNAVAILABLE: 'Nem elérhető',
  DISABLED: 'Kikapcsolva',
};

export const UNAVAILABLE_REASON_LABELS: Record<string, string> = {
  INSUFFICIENT_MARKET_DATA: 'Nincs elég piaci adat',
  INSUFFICIENT_CANDIDATE_SAMPLE: 'Kevés összehasonlítható jelölt',
  INVALID_MARKET_DATA: 'Érvénytelen piaci adat',
  STALE_MARKET_DATA: 'Elavult piaci adat',
  NO_VOLUME_BASELINE: 'Nincs forgalmi alapszint',
  NO_RECENT_TRADES: 'Nincs friss tranzakció',
  WARMING_UP: 'Adatgyűjtés folyamatban',
  DISABLED: 'Kikapcsolva',
};

export const EXHAUSTION_LEVEL_LABELS: Record<string, string> = {
  NORMAL: 'normál',
  WARNING: 'figyelmeztetés',
  STRONG_WARNING: 'erős figyelmeztetés',
  BLOCK: 'belépés tiltva',
};
