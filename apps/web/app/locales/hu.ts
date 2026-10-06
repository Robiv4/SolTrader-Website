export const hu = {
  nav: {
    overview: 'Áttekintés', dashboard: 'Irányítópult', positions: 'Pozíciók', trades: 'Kereskedések',
    markets: 'Piacok', tokens: 'Tokenfigyelő', newLaunch: 'Új tokenek', signals: 'Jelzések', strategies: 'Stratégiák', analytics: 'Elemzések',
    account: 'Fiók', wallet: 'Tárca', settings: 'Beállítások', system: 'Rendszer', health: 'Rendszerállapot', logs: 'Naplók',
  },
  status: {
    LOW: 'Alacsony', MODERATE: 'Mérsékelt', HIGH: 'Magas', VERY_HIGH: 'Nagyon magas', EXTREME: 'Extrém', BLOCKED: 'Blokkolva',
    ACCEPT: 'Jóváhagyva', WATCH: 'Megfigyelés', REJECT: 'Elutasítva', ANALYZING: 'Elemzés alatt',
    APPROVED: 'Jóváhagyva', APPROVED_REDUCED_SIZE: 'Jóváhagyva csökkentett pozícióval', DATA_INVALID: 'Érvénytelen adat',
    PENDING: 'Várakozik', PROCESSING: 'Elemzés folyamatban', COMPLETED: 'Kész', FAILED: 'Elemzés sikertelen',
    RUNNING: 'Fut', PAUSED: 'Szüneteltetve', STOPPED: 'Leállítva', EMERGENCY_STOP: 'Vészleállítás',
  } as Record<string, string>,
  quality: { VALID: 'Érvényes', PARTIAL: 'Hiányos', STALE: 'Elavult', INVALID: 'Érvénytelen' } as Record<string, string>,
} as const;

export function label(value: unknown, fallback = '—') {
  return typeof value === 'string' ? hu.status[value] ?? value : fallback;
}

export function qualityLabel(value: unknown) {
  return typeof value === 'string' ? hu.quality[value] ?? value : 'Érvénytelen';
}

const common: Record<string, string> = {
  Overview: 'Irányítópult', Dashboard: 'Irányítópult', Positions: 'Pozíciók', Trades: 'Kereskedések',
  Tokens: 'Tokenek', 'Token scanner': 'Tokenfigyelő', Signals: 'Jelzések', Strategies: 'Stratégiák', Analytics: 'Elemzések',
  Wallet: 'Tárca', Settings: 'Beállítások', System: 'Rendszer', Logs: 'Naplók', 'System health': 'Rendszerállapot',
  'Portfolio performance': 'Portfólió teljesítménye', 'Bot status': 'Bot állapota', 'Risk status': 'Kockázati állapot',
  'Open positions': 'Nyitott pozíciók', 'Recent signals': 'Legutóbbi jelzések', 'Recent trades': 'Legutóbbi kereskedések',
  'Signal feed': 'Jelzésfolyam', 'Trade history': 'Kereskedési előzmények', 'Strategy controls': 'Stratégia beállítások',
  'LIVE safety gate': 'LIVE biztonsági kapu', 'Audit stream': 'Auditfolyam',
};

export function translateText(value: string) {
  return common[value] ?? hu.status[value] ?? value;
}

/** Human-readable reasons for worker trade decisions. */
export const decisionReasonLabels: Record<string, string> = {
  CONSERVATIVE_HIGH_RISK_SIGNAL_REQUIREMENT: 'a Conservative kockázati policy magas kockázatú tokennél legalább 80-as jelzési pontszámot kér',
  RISK_POLICY_CONSERVATIVE_LIMIT: 'a Conservative policy nem enged nagyon magas kockázatú tokent',
  BALANCED_VERY_HIGH_RISK_REQUIREMENT: 'a Balanced policy nagyon magas kockázatnál legalább 80-as jelzési pontszámot kér',
  EXPLORATORY_VERY_HIGH_RISK_REQUIREMENT: 'az Exploratory policy nagyon magas kockázatnál legalább 75-ös jelzési pontszámot kér',
  EXTREME_RISK_CLASSIFICATION: 'extrém kockázati besorolás',
  SLIPPAGE_LIMIT_EXCEEDED: 'a becsült csúszás meghaladja a beállított maximumot',
  PUMP_EXHAUSTION_BLOCK: 'a pump kifáradás-szűrő a tiltási küszöb fölött van',
  LIQUIDITY_CRITICAL_OUTFLOW: 'kritikus likviditás-kiáramlás a poolból',
  POSITION_BELOW_MINIMUM: 'a kockázattal korrigált méret 1 USDC alatt lenne',
  POSITION_ALREADY_OPEN: 'ehhez a tokenhez már van nyitott pozíció',
  COOLDOWN_ACTIVE: 'a tokenre még cooldown van érvényben',
  MAX_CONCURRENT_POSITIONS: 'elérted a maximális egyidejű pozíciószámot',
  DAILY_LOSS_LIMIT: 'elérted a napi veszteségkorlátot',
  POSITION_LIMIT_OR_CASH_EXHAUSTED: 'nincs elég paper egyenleg vagy kitettségi keret',
  MARKET_DATA_STALE: 'elavult piaci adat',
  MARKET_DATA_UNAVAILABLE: 'nem elérhető piaci adat',
  LIQUIDITY_BELOW_ABSOLUTE_MINIMUM: 'túl alacsony likviditás',
  AI_ANALYSIS_UNAVAILABLE: 'kötelező AI-elemzés nem érhető el',
  PAPER_ACCOUNT_UNAVAILABLE: 'nincs paper számla',
  INSUFFICIENT_PAPER_CASH: 'nincs elég szabad paper egyenleg a megadott összegre',
  AMOUNT_ABOVE_EXPOSURE_LIMIT: 'a megadott összeg túllépné a teljes kitettségi keretet (Max exposure %)',
  AMOUNT_ABOVE_LIQUIDITY_LIMIT: 'a token likviditása nem bír el ekkora vételt a beállított max. csúszással',
  AMOUNT_ABOVE_MAX_POSITION_SIZE: 'a megadott összeg nagyobb a beállított maximális pozícióméretnél',
  HARD_BLOCKED_ASSESSED: 'a token kritikus biztonsági okból blokkolva van',
  HARD_BLOCKED: 'a token kritikus biztonsági okból blokkolva van',
  UNPRICED_EXECUTION: 'nincs érvényes ár a végrehajtáshoz',
  EXTREME_PRICE_IMPACT: 'extrém árhatás (túl kicsi a likviditás)',
  SIGNAL_SCORE_BELOW_MINIMUM: 'a jelzés pontszáma a beállított minimum alatt van',
  INVALID_POSITION_SIZE: 'érvénytelen pozícióméret',
  HIGH_RISK_AUTOMATION_PAPER_ONLY: 'magas kockázatú tokennel éles (LIVE) módban nem lehet kereskedni',
  AI_CONFIRMATION_FAILED: 'az AI-elemzés nem erősítette meg a belépést',
  EXPLORATORY_POLICY_PAPER_ONLY: 'az Exploratory policy éles (LIVE) módban nem használható',
};

export function describeReasons(reasons: string[]) {
  return reasons.length ? reasons.map((reason) => decisionReasonLabels[reason] ?? reason).join('; ') : 'ismeretlen ok';
}

const exitReasonLabels: Record<string, string> = {
  STOP_LOSS: 'Stop loss', TAKE_PROFIT: 'Profitcél', TRAILING_STOP: 'Követő stop', BREAK_EVEN_STOP: 'Break-even stop', 'manual-close': 'Kézi zárás',
  EMERGENCY_STOP: 'Vészleállítás', SIMULATED_SELL: 'Eladás', POSITION_EXIT: 'Kilépés', LIQUIDITY_OUTFLOW: 'Likviditás-kiáramlás',
};

/** Human-readable exit reason (falls back to the raw code). */
export function exitReasonLabel(value: unknown) {
  return typeof value === 'string' && value ? exitReasonLabels[value] ?? value : '—';
}
