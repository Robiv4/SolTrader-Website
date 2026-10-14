# ML EXIT modell – terv (még nincs implementálva)

**Jelenlegi állapot:** az ML stratégia **ML belépés + szabályalapú kilépés**. A kilépést kizárólag a közös Exit Engine
végzi (stop-loss, take-profit, trailing, időkorlát, likviditási és vészhelyzeti kilépés). A jelenlegi modellek
(pl. `ML-LGBM-DATASETV2-s42`, cél: `plus20BeforeMinus10_30m`) **belépési** modellek: azt becslik, hogy a jelölt a
snapshot-pont után 30 percen belül előbb ér-e +20%-ot, mint –10%-ot. Eladási döntésre nem használhatók, és nem is
használjuk őket erre.

## 1. Miért kell külön modell?

A belépési modell egyetlen időpontban (pl. AGE_30S) dönt egy *még meg nem vett* jelöltről. A kilépési döntés
egy *nyitott pozícióról* szól, sokszor, a pozíció élete során, és a helyes kérdés más:
„a következő N percben várhatóan jobb-e tartani, mint most eladni (díjak és árhatás után)?”

## 2. Adatok (pozíciónként, ismétlődő döntési pontokon)

Döntési pontok: a belépés után rögzített időközönként (pl. 15 s, 30 s, 60 s, 2 m, 5 m …) és árszint-eseményeknél.
Minden ponton **csak az addig ismert** adatokból (szivárgásmentes `observedAt` ellenőrzés, mint a belépési feature-öknél):

- pozíció: belépési ár, tartási idő, nem realizált P&L %, eddigi MFE/MAE, távolság az SL/TP/trailing szintektől;
- piac: aktuális ár, rövid ablakos árváltozás / volatilitás, forgalom- és tranzakciósebesség, vétel/eladás arány,
  egyedi vevők/eladók trendje, likviditás és annak változása, aktuális kilépési árhatás (exit capacity);
- token / biztonság: létrehozói eladás, holder-koncentráció változása (a belépéskori biztonsági tények rögzítve);
- a belépés kontextusa: belépési ML-valószínűség és modellverzió (csak feature, nem cél).

Forrás: a meglévő `PositionPathMetric` / pozícióesemények, a trade-stream (5 s gyertyák) és az exit-capacity mérés.
Új tábla kell a döntési pontok snapshotjaihoz (pl. `MlExitSnapshot`, additív migráció), a belépési snapshotoktól
külön, saját `featureVersion`-nel.

## 3. Címkék

Elsődleges cél (osztályozás), minden döntési pontra:
`holdBetterThanSell_H` = a pont után H időn belül (pl. 5 / 15 perc) a **szabályalapú kilépés szerint elért** nettó
eredmény (díjak, slippage, árhatás után) jobb-e, mint az azonnali eladás nettó eredménye.

Kiegészítő címkék elemzéshez: további MFE/MAE a horizonton, „–X% előbb, mint +Y%” útcímkék a pozíció aktuális
árától. A címke csak a horizont lezárulta után ismert (`label_end_ms`), a felosztás ezt figyelembe veszi.

## 4. Tanítás és validáció

1. Dataset-verzió (immutábilis, hash-elt), mint a belépési modellnél; pozíciónként csoportosítva (egy pozíció
   döntési pontjai soha nem kerülhetnek tanító és teszt halmazba is).
2. Időbeli felosztás purge + embargo résekkel, walk-forward hajtások.
3. Kiértékelés: nem csak AUC, hanem **szimulált PAPER eredmény**: ugyanazokon a pozíciókon a szabályalapú Exit Engine
   vs. Exit Engine + ML kilépési jelzés (nettó P&L, max. visszaesés, Profit Factor, átlagos tartási idő).
4. Minimum minta: elegendő lezárt pozíció és döntési pont (pl. ≥ 300 pozíció, ≥ 50 „tartás jobb” és ≥ 50 „eladás
   jobb” eset), különben a modell nem léphet tovább.

## 5. Bevezetés lépései (mind explicit, egyik sem automatikus)

1. **TRAINED** – offline tanítás és riport.
2. **SHADOW** – élő futtatás nyitott PAPER pozíciókon, kereskedés nélkül; a javasolt kilépések naplózása és
   utólagos összevetése a tényleges (szabályalapú) kilépésekkel.
3. **PAPER-jóváhagyás** – külön admin jóváhagyás (e-mailes megerősítéssel), külön a belépési modelltől.
4. Felhasználói opció: „ML belépés + ML kilépés (PAPER)”, alapból kikapcsolva.

## 6. Prioritás és biztonság (változatlan szabályok)

- Az ML kilépés **csak korábbi eladást kérhet**, a kötelező kilépéseket soha nem késleltetheti vagy írhatja felül.
- Mindig elsőbbséget élvez: vészleállítás, stop-loss, likviditási / rug-pull kényszerkilépés, adatkiesés miatti
  védőkilépés, maximális tartási idő.
- Modellhiba, visszavont jóváhagyás vagy hiányzó adat esetén a pozíciót továbbra is a szabályalapú Exit Engine védi
  (fail-safe), automatikus modellcsere nincs.
- Kizárólag PAPER; LIVE kereskedés ezzel nem kapcsolható be.

## 7. A felületen

Amíg nincs jóváhagyott ML EXIT modell, a Beállításokban és a Machine Learning → PAPER stratégiák oldalon a mód neve:
**„ML belépés + szabályalapú kilépés”**. Teljes ML BUY/SELL kereskedést a rendszer nem állít.
