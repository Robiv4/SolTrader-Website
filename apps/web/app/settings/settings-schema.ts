import { Database, LogIn, Power, Rocket, ShieldCheck, SlidersHorizontal, type LucideIcon } from 'lucide-react';

/**
 * Declarative description of the Settings page: groups A–F, their cards and fields. The same description drives
 * rendering, search, dirty tracking and validation, so a field can never be shown without a real backend value.
 *
 * Sources (all PostgreSQL, per user):
 *   bot  -> BotConfig   (PATCH /api/settings)
 *   risk -> RiskConfig  (PATCH /api/settings/risk)
 *   nl   -> NewLaunchConfig (PUT /api/settings/new-launch, creates a new config version on change)
 *   gate -> NewLaunchConfig.qualityGate
 */
export type GroupId = 'bot' | 'launch' | 'entry' | 'risk' | 'sources' | 'advanced';
export type Source = 'bot' | 'risk' | 'nl' | 'gate';
/** When a change takes effect: worker reads it within seconds / only new positions / needs a worker restart (server env). */
export type Apply = 'immediate' | 'new-positions' | 'restart';

export interface FieldDef {
  source: Source;
  key: string;
  label: string;
  help?: string;
  kind: 'number' | 'toggle' | 'select';
  min?: number;
  max?: number;
  step?: number;
  /** Empty input allowed (stored as null). */
  nullable?: boolean;
  placeholder?: string;
  options?: Array<{ value: string; label: string }>;
  apply: Apply;
  /** Only shown (and validated) when the given toggle of the same source is on. */
  dependsOn?: string;
}

export type CustomCard =
  | 'bot-status' | 'paper-strategy' | 'paper-account' | 'live-safety' | 'nl-security' | 'risk-classes' | 'hard-rules'
  | 'nl-providers' | 'social-status' | 'rpc-status' | 'telegram' | 'wallet' | 'ml-status' | 'nl-optimizer' | 'nl-versions' | 'profile' | 'retired';

export interface CardDef {
  id: string;
  group: GroupId;
  title: string;
  description?: string;
  fields?: FieldDef[];
  custom?: CustomCard;
  /** Extra search words for custom cards. */
  keywords?: string;
  /** Apply badge for custom cards. */
  apply?: Apply;
  note?: string;
}

export const GROUPS: Array<{ id: GroupId; letter: string; label: string; description: string; icon: LucideIcon }> = [
  { id: 'bot', letter: 'A', label: 'Bot működése', description: 'Állapot, kereskedési mód, PAPER számla', icon: Power },
  { id: 'launch', letter: 'B', label: 'New Launch figyelés', description: 'Friss tokenek felismerése és értékelése', icon: Rocket },
  { id: 'entry', letter: 'C', label: 'Belépési stratégia', description: 'Méret, likviditás, minőségi szűrő', icon: LogIn },
  { id: 'risk', letter: 'D', label: 'Kockázatkezelés és kilépés', description: 'SL / TP / trailing, limitek, osztályok', icon: ShieldCheck },
  { id: 'sources', letter: 'E', label: 'Adatforrások és kapcsolatok', description: 'Szolgáltatók, RPC, Telegram, tárca', icon: Database },
  { id: 'advanced', letter: 'F', label: 'Haladó', description: 'ML SHADOW, javaslatok, verziók, profil', icon: SlidersHorizontal },
];

export const APPLY_LABELS: Record<Apply, { text: string; title: string; tone: string }> = {
  immediate: { text: 'Azonnal', title: 'Mentés után a worker legfeljebb ~10 másodpercen belül ezzel számol – újraindítás nem kell.', tone: 'positive' },
  'new-positions': { text: 'Új pozíciókra', title: 'Csak az ezután nyitott pozíciókra érvényes; a nyitott pozíciók a belépéskor rögzített beállítással futnak tovább.', tone: 'info' },
  restart: { text: 'Worker újraindítás', title: 'Szerveroldali környezeti változó: a változáshoz a worker újraindítása szükséges. Itt csak az állapot látszik.', tone: 'warning' },
};

/** Old deep links (before the redesign) -> new group. */
export const LEGACY_HASHES: Record<string, GroupId> = {
  account: 'bot', trading: 'risk', scanner: 'risk', risk: 'risk', ai: 'advanced', strategies: 'advanced', 'new-launch': 'launch',
  notifications: 'sources', security: 'sources', profile: 'advanced',
};

const num = (source: Source, key: string, label: string, apply: Apply, options: Partial<FieldDef> = {}): FieldDef => ({ source, key, label, apply, kind: 'number', ...options });
const toggle = (source: Source, key: string, label: string, apply: Apply, help?: string): FieldDef => ({ source, key, label, apply, kind: 'toggle', help });

export const CARDS: CardDef[] = [
  // ---------------- A. Bot működése ----------------
  { id: 'bot-status', group: 'bot', title: 'Bot állapota', description: 'Csak olvasható összefoglaló: mi fut most, és milyen biztonsági korlátok érvényesek.', custom: 'bot-status', keywords: 'állapot fut leállítva vészleállítás paper live shadow ml worker indítás' },
  {
    id: 'trading-mode', group: 'bot', title: 'Kereskedési mód', description: 'A New Launch kizárólag PAPER módban nyit pozíciót.',
    fields: [{ source: 'bot', key: 'tradingMode', label: 'Kereskedési mód', kind: 'select', apply: 'immediate', options: [{ value: 'PAPER', label: 'PAPER – automatikus szimulált kereskedés' }, { value: 'SEMI_AUTO', label: 'SEMI_AUTO – jóváhagyással (New Launch nem nyit)' }], help: 'LIVE módot csak a biztonsági kapu kezel; ez a lista nem tudja bekapcsolni.' }],
  },
  { id: 'paper-strategy', group: 'bot', title: 'Aktív kereskedési ML modell', description: 'Melyik jóváhagyott Autonomous ML modell kereskedik PAPER módban. Modell nélkül a rendszer csak adatot gyűjt.', custom: 'paper-strategy', keywords: 'aktív modell ml modell machine learning autonomous paper jóváhagyás adatgyűjtés szüneteltetés kockázat model', apply: 'immediate' },
  { id: 'paper-account', group: 'bot', title: 'PAPER számla', custom: 'paper-account', keywords: 'paper számla egyenleg kezdőtőke visszaállítás reset usdc', apply: 'immediate' },
  { id: 'live-safety', group: 'bot', title: 'LIVE biztonsági kapu', description: 'A LIVE kereskedés tiltva marad; a kapu állapota itt ellenőrizhető.', custom: 'live-safety', keywords: 'live biztonság kapu vészleállítás emergency', apply: 'immediate' },

  // ---------------- B. New Launch figyelés ----------------
  {
    id: 'nl-main', group: 'launch', title: 'New Launch figyelés', description: 'Pump.fun, Raydium és Meteora friss tokenjeinek figyelése, értékelése (BUY / WATCH / REJECT) és PAPER belépés.',
    fields: [toggle('nl', 'enabled', 'New Launch figyelés és PAPER belépés', 'immediate', 'Ez az egyetlen kapcsoló, amely a friss tokenek automatikus PAPER vételét engedélyezi. Kikapcsolva a nyitott pozíciók kilépés-figyelése továbbra is fut.')],
  },
  {
    id: 'nl-window', group: 'launch', title: 'Időablak', description: 'Mennyi idős tokeneket és mennyi megfigyelés után értékeljen.',
    fields: [
      num('nl', 'minAgeSeconds', 'Min. életkor vétel előtt (mp)', 'immediate', { min: 0, max: 600 }),
      num('nl', 'maxAgeSeconds', 'Max. életkor (mp)', 'immediate', { min: 10, max: 3600, help: 'Ennél idősebb launch már nem értékelődik (LAUNCH_WINDOW_EXPIRED).' }),
      num('nl', 'observationSeconds', 'Megfigyelési idő (mp)', 'immediate', { min: 2, max: 600 }),
    ],
  },
  {
    id: 'nl-activity', group: 'launch', title: 'Aktivitás és Launch Score', description: 'Valódi kereslet jelei: tranzakciók, független vevők, vételi túlsúly, forgalom.',
    fields: [
      num('nl', 'minTransactions', 'Min. tranzakciószám', 'immediate', { min: 1, max: 10000 }),
      num('nl', 'minUniqueBuyers', 'Min. egyedi vásárló', 'immediate', { min: 1, max: 10000 }),
      num('nl', 'minBuySellRatio', 'Min. vétel/eladás arány', 'immediate', { min: 0.1, max: 100, step: 0.1 }),
      num('nl', 'minLaunchVolumeUsd', 'Min. launch forgalom (USD)', 'immediate', { min: 0, step: 100 }),
      num('nl', 'minScore', 'Min. Launch Score', 'immediate', { min: 0, max: 100, help: 'BUY döntéshez szükséges minimum pontszám (0–100).' }),
      num('nl', 'maxExhaustionScore', 'Max. kifáradási pontszám', 'immediate', { min: 0, max: 100, help: 'Efölött a pumpa kifulladtnak számít (LAUNCH_EXHAUSTED).' }),
    ],
  },
  { id: 'nl-security', group: 'launch', title: 'Kötelező biztonsági ellenőrzések', description: 'Rendszerszintű szabályok – nem kapcsolhatók ki. Ismeretlen eladhatóság soha nem számít biztonságosnak.', custom: 'nl-security', keywords: 'biztonság eladhatóság mint freeze authority holder dev token-2022 kötelező' },
  {
    id: 'nl-social', group: 'launch', title: 'Közösségi intelligencia', description: 'Determinisztikus, AI nélküli közösségi mérés (Telegram-first). Soha nem írja felül a biztonsági és kockázati szabályokat.',
    fields: [
      toggle('nl', 'socialIntelligenceEnabled', 'Közösségi jellemzők gyűjtése', 'immediate', 'Minden döntésnél rögzíti a közösségi árnyék-jellemzőket (az elutasított jelölteknél is).'),
      { source: 'nl', key: 'socialDecisionMode', label: 'Közösségi döntési mód', kind: 'select', apply: 'immediate', options: [{ value: 'OFF', label: 'Kikapcsolva (OFF)' }, { value: 'MONITOR_ONLY', label: 'Csak mérés (MONITOR_ONLY)' }, { value: 'ENFORCE_PAPER', label: 'Alkalmazás PAPER módban (ENFORCE_PAPER)' }], help: 'ENFORCE_PAPER: az AVOID árnyékdöntés elvehet egy PAPER belépést, de hozzáadni vagy méretet növelni soha nem tud.' },
    ],
  },

  // ---------------- C. Belépési stratégia ----------------
  {
    id: 'entry-size', group: 'entry', title: 'Pozícióméret és gyakoriság', description: 'A New Launch pozíciók szándékosan kicsik.',
    fields: [
      num('nl', 'maxPositionPercent', 'Max. pozícióméret (egyenleg %)', 'immediate', { min: 0.1, max: 10, step: 0.1, help: 'A kockázati osztály szorzója ezt tovább csökkentheti.' }),
      num('nl', 'maxConcurrentPositions', 'Max. egyidejű New Launch pozíció', 'immediate', { min: 1, max: 20 }),
      num('nl', 'cooldownSeconds', 'Várakozás két vétel között ugyanarra a tokenre (mp)', 'immediate', { min: 0, max: 86400 }),
    ],
  },
  {
    id: 'entry-liquidity', group: 'entry', title: 'Likviditás, árhatás és kockázat', description: 'Belépési feltételek a launch likviditására és kockázati pontszámára.',
    fields: [
      num('nl', 'minLiquidityUsd', 'Min. likviditás (USD)', 'immediate', { min: 0, step: 500 }),
      num('nl', 'maxLiquidityUsd', 'Max. likviditás (USD)', 'immediate', { min: 0, step: 1000, nullable: true, placeholder: 'nincs felső határ' }),
      num('nl', 'maxPriceImpactPercent', 'Max. árhatás (%)', 'immediate', { min: 0.1, max: 50, step: 0.1 }),
      num('nl', 'maxRiskScore', 'Max. kockázati pontszám', 'immediate', { min: 0, max: 100 }),
      num('nl', 'liquidityOutflowWarningPercent', 'Likviditás-kiáramlás figyelmeztetés (%)', 'immediate', { min: 1, max: 99, help: 'Ekkora csökkenésnél figyelmeztet és csökkenti a Launch Score-t.' }),
      num('nl', 'liquidityCriticalPercent', 'Kritikus likviditás-csökkenés (%)', 'immediate', { min: 1, max: 99, help: 'Ekkora csökkenés után a jelölt végleg elutasítva (CRITICAL_LIQUIDITY).' }),
      num('nl', 'minObservedSellers', 'Eladhatósághoz szükséges független eladók', 'immediate', { min: 1, max: 50 }),
    ],
  },
  {
    id: 'quality-gate', group: 'entry', title: 'Belépési minőségi szűrő', description: 'A kemény biztonsági és kockázati ellenőrzés UTÁN fut; biztonsági tiltást soha nem fordíthat vételre. Ismeretlen érték esetén a feltétel nem teljesül.',
    fields: [
      { source: 'gate', key: 'mode', label: 'Szűrő módja', kind: 'select', apply: 'immediate', options: [{ value: 'OFF', label: 'Kikapcsolva (OFF)' }, { value: 'MONITOR_ONLY', label: 'Csak mérés (MONITOR_ONLY)' }, { value: 'ENFORCE_PAPER', label: 'Szűrés PAPER módban (ENFORCE_PAPER)' }], help: 'MONITOR_ONLY: nem tilt, csak rögzíti, hogy átment volna-e.' },
      num('gate', 'minLaunchScore', 'Min. Launch Score', 'immediate', { min: 0, nullable: true, placeholder: 'nincs feltétel' }),
      num('gate', 'minUniqueBuyers', 'Min. egyedi vásárló', 'immediate', { min: 0, nullable: true, placeholder: 'nincs feltétel' }),
      num('gate', 'minLiquidityUsd', 'Min. likviditás (USD)', 'immediate', { min: 0, step: 500, nullable: true, placeholder: 'nincs feltétel' }),
      num('gate', 'minBuySellRatio', 'Min. vétel/eladás arány', 'immediate', { min: 0, step: 0.1, nullable: true, placeholder: 'nincs feltétel' }),
      num('gate', 'maxExhaustionScore', 'Max. kifáradási pontszám', 'immediate', { min: 0, nullable: true, placeholder: 'nincs feltétel' }),
      num('gate', 'maxPriceImpactPercent', 'Max. árhatás (%)', 'immediate', { min: 0, step: 0.1, nullable: true, placeholder: 'nincs feltétel' }),
      num('gate', 'maxHolderConcentrationPercent', 'Max. holder koncentráció (%)', 'immediate', { min: 0, step: 0.5, nullable: true, placeholder: 'nincs feltétel' }),
      num('gate', 'maxDevAllocationPercent', 'Max. dev allokáció (%)', 'immediate', { min: 0, step: 0.5, nullable: true, placeholder: 'nincs feltétel' }),
      num('gate', 'minDataQuality', 'Min. adatminőség', 'immediate', { min: 0, nullable: true, placeholder: 'nincs feltétel' }),
    ],
  },
  {
    id: 'exit-capacity', group: 'entry', title: 'Dinamikus pozícióméret / kilépési kapacitás', description: 'Vétel előtt: ha a teljes pozíciót azonnal el kellene adni, elfogadható árhatással kijutnánk-e? A méretet csak csökkentheti.',
    fields: [
      toggle('nl', 'dynamicPositionSizingEnabled', 'Kilépési kapacitás számítása', 'immediate', 'Minden belépésnél kiszámolja és rögzíti a biztonságos méretet.'),
      { source: 'nl', key: 'exitCapacityMode', label: 'Mód', kind: 'select', apply: 'immediate', options: [{ value: 'MONITOR_ONLY', label: 'Csak mérés (MONITOR_ONLY)' }, { value: 'ENFORCE_PAPER', label: 'Alkalmazás PAPER módban (ENFORCE_PAPER)' }], dependsOn: 'dynamicPositionSizingEnabled', help: 'MONITOR_ONLY: a tényleges méret nem változik, csak rögzíti a javaslatot.' },
      num('nl', 'maxEstimatedEntryImpactPct', 'Max. becsült belépési árhatás (%)', 'immediate', { min: 0.1, max: 50, step: 0.1, dependsOn: 'dynamicPositionSizingEnabled' }),
      num('nl', 'maxEstimatedExitImpactPct', 'Max. becsült kilépési árhatás (%)', 'immediate', { min: 0.1, max: 50, step: 0.1, dependsOn: 'dynamicPositionSizingEnabled' }),
      num('nl', 'maxEstimatedRoundTripImpactPct', 'Max. becsült oda-vissza árhatás (%)', 'immediate', { min: 0.1, max: 100, step: 0.1, dependsOn: 'dynamicPositionSizingEnabled' }),
      num('nl', 'minExitCapacityScore', 'Min. Exit Capacity Score', 'immediate', { min: 0, max: 100, dependsOn: 'dynamicPositionSizingEnabled' }),
      num('nl', 'maxLiquidityUtilizationPct', 'Max. likviditás-kihasználtság (%)', 'immediate', { min: 0.1, max: 100, step: 0.1, dependsOn: 'dynamicPositionSizingEnabled' }),
      num('nl', 'minimumExecutablePosition', 'Min. végrehajtható pozíció (USDC)', 'immediate', { min: 0, step: 1, dependsOn: 'dynamicPositionSizingEnabled' }),
      num('nl', 'positionSizeStep', 'Pozícióméret lépésköze (USDC)', 'immediate', { min: 0.01, step: 0.5, dependsOn: 'dynamicPositionSizingEnabled' }),
    ],
  },
  {
    id: 'unbuyable', group: 'entry', title: 'Nem vásárolható tokenek kihagyása', description: 'Ha egy token tartósan blokkolt / nem vásárolható, egy ideig nem próbálkozik vele újra.',
    fields: [
      num('bot', 'skipUnbuyableAfterMinutes', 'Kihagyás ennyi perc sikertelenség után', 'immediate', { min: 0, max: 1440, help: '0 = kikapcsolva. A számla-limitek (tele a pozíciók, nincs egyenleg) nem számítanak bele.' }),
      num('bot', 'skipUnbuyableForMinutes', 'Kihagyás időtartama (perc)', 'immediate', { min: 1, max: 10080 }),
    ],
  },

  // ---------------- D. Kockázatkezelés és kilépés ----------------
  {
    id: 'exit-basic', group: 'risk', title: 'Stop loss és take profit', description: 'A New Launch pozíciók kilépési szabályai. A belépéskor érvényes beállítás a pozícióhoz rögzül.',
    fields: [
      num('nl', 'stopLossPercent', 'Stop loss (%)', 'new-positions', { min: 1, max: 90, step: 0.5 }),
      num('nl', 'takeProfitPercent', 'Take profit (%)', 'new-positions', { min: 1, max: 1000, step: 0.5 }),
    ],
  },
  {
    id: 'exit-protect', group: 'risk', title: 'Profitvédelem', description: 'Break-even, követő stop és tartási idő – csak az újonnan nyitott pozíciókra.',
    fields: [
      toggle('nl', 'breakEvenEnabled', 'Break-even', 'new-positions', 'Az aktiválási nyereség elérésekor a stop a nettó nullszintre emelkedik.'),
      num('nl', 'breakEvenActivationPercent', 'Break-even aktiválás (%)', 'new-positions', { min: 0.5, max: 500, step: 0.5, dependsOn: 'breakEvenEnabled' }),
      num('nl', 'breakEvenCostBufferPercent', 'Break-even költségpuffer (%)', 'new-positions', { min: 0, max: 10, step: 0.1, dependsOn: 'breakEvenEnabled', help: '0,6% = a két PAPER díj (2 × 0,30%).' }),
      toggle('nl', 'trailingEnabled', 'Követő stop (trailing)', 'new-positions', 'Csak az aktiválási nyereség után kezd követni, és soha nem mozdul lefelé.'),
      num('nl', 'trailingActivationPercent', 'Követő stop aktiválás (%)', 'new-positions', { min: 0, max: 500, step: 0.5, dependsOn: 'trailingEnabled', help: '0 = azonnal a vételtől.' }),
      num('nl', 'trailingDistancePercent', 'Követő stop távolság (%)', 'new-positions', { min: 0.5, max: 90, step: 0.5, dependsOn: 'trailingEnabled' }),
      toggle('nl', 'maxHoldEnabled', 'Maximum tartási idő', 'new-positions', 'Ennyi perc után a pozíció MAX_HOLD_TIME okkal zár.'),
      num('nl', 'maxHoldMinutes', 'Maximum tartási idő (perc)', 'new-positions', { min: 1, max: 10080, dependsOn: 'maxHoldEnabled' }),
      toggle('nl', 'liquiditySafetyExitEnabled', 'Likviditás-védelmi kilépés', 'new-positions', 'Zárás, ha a likviditás a belépéskorihoz képest ennyivel csökkent (LIQUIDITY_SAFETY).'),
      num('nl', 'liquidityDropExitPercent', 'Likviditásesés kilépési küszöb (%)', 'new-positions', { min: 1, max: 99, dependsOn: 'liquiditySafetyExitEnabled' }),
    ],
  },
  {
    id: 'account-limits', group: 'risk', title: 'Számla-szintű limitek', description: 'Minden PAPER belépésre érvényes központi korlátok (a régi, még nyitott pozíciókat is beleszámolva).',
    fields: [
      num('risk', 'maxTotalExposurePercent', 'Max. teljes kitettség (%)', 'immediate', { min: 0, max: 100, step: 0.1, nullable: true, placeholder: 'alapérték: 25' }),
      num('risk', 'maxConcurrentPositions', 'Max. összes nyitott pozíció', 'immediate', { min: 1, max: 50, nullable: true, placeholder: 'alapérték: 3', help: 'Az összes nyitott PAPER pozíció; a New Launch saját limitje ezen belül érvényes.' }),
      num('bot', 'maxDailyLoss', 'Napi veszteségkorlát (USDC)', 'immediate', { min: 0, step: 1, nullable: true, placeholder: 'pl. 30', help: 'Elsőbbséget élvez a %-os korláttal szemben. Üresen a %-os korlát számít.' }),
      num('risk', 'dailyLossLimitPercent', 'Napi veszteségkorlát (%)', 'immediate', { min: 0, max: 100, step: 0.1, nullable: true }),
      num('risk', 'maxSlippagePercent', 'Max. csúszás (%)', 'immediate', { min: 0, max: 100, step: 0.1, nullable: true, help: 'A kockázati motor csúszás-küszöbe és a végrehajtás felső határa.' }),
    ],
  },
  { id: 'risk-classes', group: 'risk', title: 'Kockázati irányelv és osztályok', description: 'Kockázati pontszám-határok és pozícióméret-szorzók osztályonként.', custom: 'risk-classes', keywords: 'kockázati irányelv conservative balanced exploratory low moderate high very_high szorzó osztály', apply: 'immediate' },
  {
    id: 'risk-baseline', group: 'risk', title: 'Kockázati pontszám alapküszöbei', description: 'A kockázati motor ezekhez viszonyítva súlyozza a jelöltek kockázati pontszámát (nem önálló belépési feltétel).',
    fields: [
      num('bot', 'minLiquidityUsd', 'Likviditás referencia (USD)', 'immediate', { min: 1, step: 100, nullable: true, placeholder: 'alapérték: 5000' }),
      num('bot', 'minVolumeUsd', 'Forgalom referencia (USD)', 'immediate', { min: 1, step: 100, nullable: true, placeholder: 'alapérték: 2000' }),
      num('bot', 'maxTokenAgeHours', 'Token életkor referencia (óra)', 'immediate', { min: 1, max: 7200, nullable: true, placeholder: 'alapérték: 168' }),
    ],
    note: 'Ezek a korábbi „Tokenfigyelő szűrők” értékei: a scanner megszűnt, de a New Launch kockázati pontszáma továbbra is ezekkel számol, ezért változatlanul megmaradtak.',
  },
  { id: 'hard-rules', group: 'risk', title: 'Kemény biztonsági tiltások', description: 'Rendszerszintű szabályok – mindig érvényesek, nem kapcsolhatók ki.', custom: 'hard-rules', keywords: 'kemény tiltás eladhatóság pool végrehajtás likviditás árhatás piaci adat' },

  // ---------------- E. Adatforrások és kapcsolatok ----------------
  { id: 'nl-providers', group: 'sources', title: 'Launch-felfedezés szolgáltatói', description: 'Pump.fun, Raydium, Meteora és Helius WebSocket állapota.', custom: 'nl-providers', keywords: 'pump.fun raydium meteora helius websocket szolgáltató provider felfedezés', apply: 'restart' },
  { id: 'rpc-status', group: 'sources', title: 'Solana RPC', description: 'A közös RPC-kezelő állapota (címkék, nem URL-ek vagy kulcsok).', custom: 'rpc-status', keywords: 'rpc solana helius primary fallback circuit breaker', apply: 'restart' },
  { id: 'social-status', group: 'sources', title: 'Közösségi szolgáltatók', description: 'Telegram / X gyűjtés állapota. A kapcsolók és hitelesítők szerveroldali környezeti változók.', custom: 'social-status', keywords: 'telegram x twitter mtproto közösségi social', apply: 'restart' },
  { id: 'telegram', group: 'sources', title: 'Telegram értesítések', custom: 'telegram', keywords: 'telegram értesítés bot chat összekapcsolás teszt', apply: 'immediate' },
  { id: 'wallet', group: 'sources', title: 'Tárca', description: 'A tárcakezelés elsődleges helye a Tárca oldal.', custom: 'wallet', keywords: 'tárca wallet phantom solflare backpack cím egyenleg bot trading' },

  // ---------------- F. Haladó ----------------
  { id: 'ml-status', group: 'advanced', title: 'Machine Learning (SHADOW)', description: 'Csak olvasható állapot. Az ML SHADOW módban fut: semmilyen módon nem befolyásolja a BUY / SELL döntéseket.', custom: 'ml-status', keywords: 'ml machine learning shadow modell snapshot outcome predikció adatkészlet', apply: 'restart' },
  { id: 'nl-optimizer', group: 'advanced', title: 'Elemzési javaslatok', description: 'Kísérleti PAPER beállítás-javaslatok a lezárt New Launch kereskedésekből. Soha nem alkalmazódnak automatikusan.', custom: 'nl-optimizer', keywords: 'optimalizáló javaslat ajánlás kísérlet elemzés' },
  { id: 'nl-versions', group: 'advanced', title: 'Konfiguráció-verziók', description: 'Minden New Launch módosítás új, változtathatatlan verziót hoz létre; a kereskedések a belépéskori verziójukkal értékelődnek.', custom: 'nl-versions', keywords: 'verzió nl-v történet konfiguráció' },
  { id: 'profile', group: 'advanced', title: 'Profilkép', custom: 'profile', keywords: 'profil profilkép avatar kép', apply: 'immediate' },
  { id: 'retired', group: 'advanced', title: 'Megszűnt funkciók', description: 'A régi Token Scanner, a Momentum / Breakout / Pullback stratégiák, az AI Trader belépések és a tokenlistás kézi vétel megszűnt.', custom: 'retired', keywords: 'scanner tokenfigyelő stratégia momentum breakout pullback ai trader kézi vétel megszűnt régi' },
];

/** Accent-insensitive, lower-case form for search. */
export function normalize(text: string) {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

export function fieldMatches(field: FieldDef, query: string) {
  return normalize(`${field.label} ${field.help ?? ''} ${field.key}`).includes(query);
}

export function cardMatches(card: CardDef, query: string) {
  return normalize(`${card.title} ${card.description ?? ''} ${card.keywords ?? ''} ${card.note ?? ''}`).includes(query);
}
