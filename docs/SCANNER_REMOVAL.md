# Régi Token Scanner eltávolítása és Beállítások átszervezése

Dátum: 2026-10-11. Biztonsági keretek: `TRADING_MODE=PAPER`, `LIVE_TRADING_ENABLED=false`, `ML_MODE=SHADOW`. Az ML semmilyen módon
nem befolyásolja a BUY / SELL döntéseket. Adat nem törlődött (trade, token, signal, AI-elemzés, ML adatkészlet / modell / predikció,
audit napló, pozíció).

## 1. Függőségi térkép (eltávolítás előtt)

| Réteg | Elem | Kizárólag a régi lánc? | Döntés |
| --- | --- | --- | --- |
| worker | `token-scanner.ts`, `token-rotation.ts` | igen | törölve |
| worker | `strategy-runner.ts`, `signal-analysis.ts` | igen | törölve |
| worker | `ai-analysis-service.ts` (AI Trader) | igen (a `paper-execution` csak a döntési módot olvasta belőle) | törölve, az AI-ág kivéve a végrehajtásból |
| worker | `scan-config.ts` → `loadActiveUserScanSettings` | **közös**: a New Launch is ezen át kapta a kockázati beállításait, és `isScannerEnabled = true` szűrő volt benne | átnevezve: `user-risk-settings.ts` → `loadActiveUserRiskSettings`, scanner-szűrő nélkül |
| worker | `paper-execution.ts` | **közös**: a NEW_LAUNCH jelzéseket is ez hajtja végre | megmaradt; a scanner-kapcsoló és az AI döntési mód kivéve; alapból csak `NEW_LAUNCH` forrást hajt végre |
| worker | `unbuyable-tracker.ts` | **közös** (a New Launch belépéseknél is számol) | megmaradt |
| worker | `trading-loop.ts` `runTokenMonitor` / `runStrategies` | igen | hookok törölve; `runPaperExecution` + `monitorOpenPositions` maradt |
| worker | `monitorOpenPositions` | **közös**: a régi (nem New Launch) nyitott pozíciók kilépés-figyelése | megmaradt változatlanul |
| package | `@soltrader/token-discovery` (`toRiskEngineConfig`) | **közös** | megmaradt |
| package | `@soltrader/ai-engine`, stratégia-motorok | a worker/API már nem importálja | csomag megmaradt (történeti elemzés, backtest) |
| API | `GET /api/tokens` (lista), `POST/GET /api/paper/orders/manual-buy` | igen | törölve |
| API | `/api/settings/strategies`, `/api/settings/advanced-strategies`, `/api/settings/ai`, `POST /api/bot/strategies/:name/toggle` | igen | törölve |
| API | `GET /api/tokens/:address` (+ chart, social) | **közös** (New Launch és pozíció oldalak linkelik) | megmaradt |
| API | `/api/signals`, `/api/trades`, `/api/analytics`, `/api/backtests` | történeti adatok | megmaradt |
| web | `tokens/page.tsx` (Tokenfigyelő), `strategies/page.tsx`, `ai-settings-panel.tsx`, `advanced-strategies-panel.tsx`, stratégia-kapcsolók | igen | törölve, navigációból kivéve |
| web | `tokens/[address]` részletező oldal | **közös** | megmaradt |
| Prisma | `BotConfig.isScannerEnabled`, `maxMonitoredTokens`, `StrategyConfig`, `AdvancedStrategyConfig`, `AiConfig` | régi | oszlopok / táblák megmaradtak (nem olvasott, nem írt örökség), nincs DROP |

## 2. Indítási feltételek szétválasztása

Korábban a New Launch csak akkor futott egy felhasználónál, ha `BotConfig.isScannerEnabled = true` volt (a kockázati beállítások
betöltése a scanner lekérdezésén ment át). Most a New Launch feltételei:

- `NewLaunchConfig.enabled = true` (**kanonikus kapcsoló**: Beállítások → B. New Launch figyelés),
- `BotConfig.status = RUNNING`, `tradingMode = PAPER`, `isEmergencyStop = false`.

A nyitott pozíciók kilépés-figyelése (Exit Engine, HotPositionMonitor, `monitorOpenPositions`) a kapcsolóktól függetlenül fut.

## 3. Konfiguráció-migráció

Migráció: `prisma/migrations/20261011090000_retire_token_scanner` (csak adat, nincs séma-változás, nincs törlés; előtte automatikus mentés).

| Régi beállítás | Új kanonikus mező | Szabály |
| --- | --- | --- |
| `BotConfig.isScannerEnabled` | `NewLaunchConfig.enabled` | ahol a scanner KI volt és a New Launch BE, ott a New Launch KI lesz (a tényleges viselkedés változatlan); `settings_migration` audit-bejegyzés felhasználónként |
| Tokenfigyelő szűrők (`minLiquidityUsd`, `minVolumeUsd`, `maxTokenAgeHours`) | ugyanazok a mezők, új néven: „Kockázati pontszám alapküszöbei” (D) | érték változatlan – a New Launch kockázati pontszáma ezekkel számol |
| Scanner kilépési szabályok (`RiskConfig.stopLoss/takeProfit/trailing/breakEven`) | New Launch kilépés (`NewLaunchConfig.*`) | nem írjuk át; a régi mezők csak a már nyitott régi pozíciókon (rögzített szinttel) élnek tovább |
| `RiskConfig.maxPositionPercent`, `minSignalScore`, `cooldownSeconds`, `BotConfig.maxPositionSize` | `NewLaunchConfig.maxPositionPercent`, `minScore`, `cooldownSeconds` | a New Launch eddig is a saját mezőit használta; régi értékek megmaradnak, nem jelennek meg |
| `maxMonitoredTokens`, AI / stratégia / összetett jelzés beállítások | – | megmaradnak a DB-ben, nincs backendjük, nem jelennek meg |
| `independentMode`, `tieredTakeProfit*`, `aiSocialAnalysisEnabled`, e-mail / push értesítés | – | nincs működő backend → elrejtve; mentéskor az értékük változatlanul visszaíródik |

## 4. Beállítások oldal (A–F)

A. Bot működése · B. New Launch figyelés · C. Belépési stratégia · D. Kockázatkezelés és kilépés · E. Adatforrások és kapcsolatok · F. Haladó.
A mezőket a `apps/web/app/settings/settings-schema.ts` írja le (forrás, határok, érvényesülés: *Azonnal* / *Új pozíciókra* / *Worker
újraindítás*). Közös mentés-sáv, mezőszintű és mezők közötti validáció, kereső (ékezetfüggetlen), régi `#risk`, `#new-launch` … linkek
átirányítása. Titkos kulcs vagy szolgáltató URL nem jelenik meg.
