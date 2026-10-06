# PAPER kereskedés – teljesítmény-audit (2026-09-28)

Vizsgált adat: az `admin@soltrader.com` fiók 59 lezárt PAPER kereskedése (nettó −85,44 USDC), valamint a belépés → pozíciókezelés → kilépés → analitika teljes kódútja.

## Fő megállapítás

A gyenge eredmény **elsősorban implementációs/tervezési hibákból** eredt, nem a stratégiák paramétereiből:

1. **A követő stop (trailing) azonnal élesedett a vétel után**, a csúcsár a *piaci* belépési ár volt, míg a pozíció a csúszással drágább *kitöltési* áron nyílt. Így az 5%-os trailing gyakorlatilag egy 5%-nál is szorosabb második Stop Lossként működött. A 36 trailing kilépésből **25-nél a csúcsár sem érte el a nettó nullszintet**, csak 5 volt nyereséges, és jellemzően 2 percen belül zártak.
2. **Az automatikus vételeknél a kockázati szorzó nem érvényesült**, ha be volt állítva „Pozícióméret automatikus vételnél (USDC)” (a fiókban 500 USDC). Ezért HIGH kockázatú tokenekre ~230–240 USDC-s (az egyenleg ~24%-a) pozíciók nyíltak az elvárt 5% × 0,35 = 1,75% helyett. A legnagyobb veszteségek (−42,72, −17,00, −11,54, −9,56 USDC) mind 120–240 USDC-s pozíciókból jöttek.
3. **A kilépésnél nem volt csúszás modellezve** (túl optimista), és **a védelmi szintek a jelzés pillanatnyi árából** számolódtak, nem a tényleges kitöltési árból.
4. A beállítások a 59 trade alatt többször változtak (SL 2→10→30→20→40→20%, TP 4→7→14→6→25%, trailing 1/7/5%), és nem volt pillanatkép róluk – az összesített statisztika így több konfiguráció keveréke.

## Válaszok a 20 kérdésre

| # | Kérdés | Minősítés | Megállapítás |
|---|---|---|---|
| 1 | Azonnal aktív a trailing a belépés után? | **BUG** (javítva) | Igen: `highest = belépési piaci ár`, trigger = highest × (1 − 5%) már az első ciklusban. |
| 2 | Zárhat TRAILING_STOP veszteséggel? | **BUG** (javítva) | Igen, a 36 trailing kilépésből csak 5 volt nyereséges. Aktiválási küszöb mellett (pl. 15% aktiválás, 8% távolság) a trigger a belépés fölött van (115 × 0,92 = 105,8). |
| 3 | Hány trailing aktiválódott nettó nullszint alatt? | **BUG** | 36/36 (mind a belépéskor élesedett); 25-nél a csúcs sem érte el a +0,6%-os nettó nullszintet. |
| 4 | Helyes csúcsárra épül a trailing? | **DESIGN ISSUE** (javítva) | A csúcs a piaci árból indult, a belépés a kitöltési árból – ez eltolta a triggert a nyitás pillanatában. Most a kitöltési ár a bázis, az aktiválás attól számít. |
| 5 | Csökkenhet a highestPrice? | **CORRECT** | Nem (`max`), most invariáns-teszt is védi, ahogy a trigger és a stop monotonitását is. |
| 6 | Helyesen van perzisztálva a trailing-állapot? | **BUG** (javítva) | Csak a %-os távolság és a csúcs volt tárolva, aktiválás/trigger nem. Most: `trailingActive`, `trailingActivatedAt`, `trailingActivationPrice`, `trailingTriggerPrice`, `breakEvenAppliedAt` a pozíción; worker-újraindítás után onnan folytatódik. |
| 7 | Helyes kitöltési árra épül az SL/TP? | **BUG** (javítva) | A jelzés idejének árából (akár 2 perccel korábbi) számolódott. Most: `SL = kitöltési ár × (1 − SL%)`, `TP = kitöltési ár × (1 + TP%)`. |
| 8 | Helyes irányú a csúszás? | **CORRECT / BUG** | Vételnél helyes (drágább). Eladásnál nem volt csúszás → most `kitöltés = piaci × (1 − csúszás%)`. |
| 9 | Pontosan egyszer számolódik a csúszás? | **CORRECT** | A csúszás csak a kitöltési árban szerepel; a „Csúszás” összeg tájékoztató, sehol nincs még egyszer levonva. |
| 10 | Pontosan egyszer számolódnak a díjak? | **CORRECT** | Belépési + kilépési díj (0,30%–0,30%), mind az 59 trade-nél `bruttó − díjak = nettó` pontosan. |
| 11 | Matematikailag helyes a nettó P&L? | **CORRECT** | `bruttó = (kilépési kitöltés − belépési kitöltés) × mennyiség`; mind az 59 trade-nél 0 eltérés. |
| 12 | Helyes a profit faktor? | **CORRECT** | Nettó nyerők összege / \|nettó vesztesek összege\|, nyitott pozíciók nélkül; veszteség nélkül `null`. |
| 13 | Helyes a max. visszaesés? | **DESIGN ISSUE** (javítva) | Csak dollárban volt, 0-tól induló görbén, és a nyitott P&L is belekeveredett. Most: realizált egyenleggörbe (kezdő egyenleg + kumulált nettó), dollárban és a csúcshoz mért %-ban. |
| 14 | Miért HIGH mind az 59? | **CORRECT** | A kockázati pontszámok 53–71 közöttiek, a küszöbök (≤50 MODERATE, ≤90 HIGH) szerint ez HIGH. A szkennelt memecoin-univerzum ilyen; a határok tesztelve (30/31, 50/51, 90/91). |
| 15 | Érvényesül a HIGH 0,35-ös szorzó? | **BUG** (javítva) | Beállított USDC-méret mellett nem (lásd fent). Most az automatikus vételnél mindig: alap (USDC-méret vagy % × egyenleg) × szorzó. Kézi vétel pontosan a megadott összeg. |
| 16 | Van a beállítottnál nagyobb pozíció? | **BUG** (javítva) | Igen: 242,50 / 240,42 / 238,03 / 233,78 / 230,59 / 229,12 / 223,10 USDC a ~45 USDC-s (5%) helyett. Emellett 0–5 USDC-s „por” pozíciók is nyíltak (maradék keret) – most 1 USDC alatt nincs automatikus vétel. |
| 17 | Aránytalanul veszítenek az alacsony pontszámúak? | **INSUFFICIENT DATA** | Automatikusan nem volt 50 alatti belépés. 60–69: 26 db, PF 0,31; 70–79: 19 db, PF 0,80. Az új pontszám-bontás gyűjti az adatot. |
| 18 | Miért gyenge a Momentum? | **INSUFFICIENT DATA** (részben BUG) | A 35 trade-ből a veszteség nagyja a túlméretezett pozíciókból és az azonnali trailingből jön. Hogy túl későn lép-e be (kimerült pumpa), nem mérhető: a belépéskori 24h/1h változás nem volt rögzítve – mostantól a beállítás-pillanatkép tárolja. |
| 19 | Előfordul duplikált belépés? | **CORRECT** | 0 átfedő pozíció ugyanarra a tokenre, 0 ismételt jelzés. Újrabelépés min. 42 mp-cel a kilépés után (a cooldown a *belépéstől* számít, tokenenként). |
| 20 | Használ elavult piaci adatot a végrehajtás? | **DESIGN ISSUE** (javítva) | Az elavultsági korlát (120 s) működött, de a megosztott gyorsítótár miatt a kilépésnél akár 20 s-os ár is számíthatott. Most belépésnél és kilépésnél legfeljebb 5 s-os árjegyzés. |

## Dokumentált szabályok

**Kitöltési modell** (`packages/trading-engine/src/paper-fills.ts`)

- árhatás% = 0,1 + 100 × összeg / (likviditás / 2 + összeg)
- VÉTEL kitöltés = piaci × (1 + árhatás%) — mindig drágább
- ELADÁS kitöltés = piaci × (1 − árhatás%) — mindig olcsóbb; likviditásadat nélkül 0,1%
- díj = a kitöltött érték 0,30%-a belépéskor és kilépéskor
- nettó P&L = (kilépési kitöltés − belépési kitöltés) × mennyiség − belépési díj − kilépési díj

**Kilépési szabályok** (`packages/trading-engine/src/exit-rules.ts`)

- Stop Loss: ár ≤ SL (belépési kitöltés × (1 − SL%))
- Take Profit: ár ≥ TP (belépési kitöltés × (1 + TP%)), a teljes pozíciót zárja
- Trailing: élesedik, ha a csúcs ≥ belépési kitöltés × (1 + aktiválás%); ezután trigger = csúcs × (1 − távolság%), zár, ha ár ≤ trigger. Üres/0 aktiválás = régi viselkedés (azonnal él).
- Break-even (opcionális): ha a csúcs ≥ belépés × (1 + BE%), a Stop Loss a belépés × 1,006 szintre emelkedik.
- Precedencia ugyanazon pillanatképen: STOP_LOSS > TAKE_PROFIT > TRAILING_STOP.
- Invariánsok: a csúcs, a trigger és a stop sosem csökken; élesedés után a trailing aktív marad.
- Kitöltési szabály: a triggert az aktuális pillanatkép észleli, a kitöltés ennek az árából (mínusz csúszás) történik – nem a trigger szintjén. Két frissítés közötti nagy mozgás így valósághűen jelenik meg (pl. −20%-os SL mellett −41%-os kilépés).

**Egyéb**

- Cooldown: felhasználó + token szintű, a legutóbbi *belépés* időpontjától számít (nem a kilépéstől, nem globális).
- Napi veszteség: UTC napforduló, lezárt nettó + nyitott nem realizált P&L; a díjak és a kézi trade-ek is beleszámítanak. Egy felhasználó jelöltjei sorban (nem párhuzamosan) futnak, így a kitettség/napi limit nem kerülhető meg egyidejű belépéssel a workerben.
- Meglévő beállítások nem változtak. Az új „Trailing aktiválás %” a meglévő fiókoknál üres (= régi, azonnali viselkedés + figyelmeztetés a Beállításokban); új fiókoknál 15%.

## Mostantól rögzített diagnosztika (új trade-eknél)

- Pozíció: `entryMarketPrice`, trailing-aktiválás és -állapot, break-even.
- Trade: `entryMarketPrice`, `exitMarketPrice`, `exitSlippage`, `configSnapshot` (a belépéskori SL/TP/trailing/aktiválás, min. pontszám, max. pozíció %, beállított méret, kockázati szorzó, egyenleg, likviditás, 24h/1h változás, jelzés kora, stratégia-paraméterek), `exitDiagnostics` (miért zárt: átlépett szint, megfigyelt ár, csúcs, trailing trigger, precedencia).
- Régi trade-eknél a nem rögzített értékek „nincs rögzítve” jelzést kapnak – nincs utólagos becslés.
