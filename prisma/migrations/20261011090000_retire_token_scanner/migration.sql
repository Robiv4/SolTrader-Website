-- Retire the legacy token scanner / strategy runner / AI trader entry flow.
--
-- Data-only migration: no table, column or row is dropped. BotConfig.isScannerEnabled, maxMonitoredTokens,
-- StrategyConfig, AdvancedStrategyConfig, AiConfig and all signals / trades / AI analyses stay for history.
--
-- New Launch used to run only for users whose token-scanner switch was ON (it loaded its risk settings through the
-- scanner query). It is now independent of that switch, so to keep every user's effective behaviour New Launch is
-- switched off where the scanner was off. The user can switch it on again under Settings > B. New Launch figyelés.

INSERT INTO "AuditLog" ("id", "userId", "action", "details", "createdAt")
SELECT 'mig_' || md5(nl."userId" || '20261011090000_retire_token_scanner'), nl."userId", 'settings_migration',
       jsonb_build_object('migration', '20261011090000_retire_token_scanner', 'field', 'NewLaunchConfig.enabled', 'from', true, 'to', false,
                          'reason', 'BotConfig.isScannerEnabled was false: New Launch did not run before the scanner was retired'),
       NOW()
FROM "NewLaunchConfig" AS nl
JOIN "BotConfig" AS bot ON bot."userId" = nl."userId"
WHERE bot."isScannerEnabled" = false AND nl."enabled" = true;

UPDATE "NewLaunchConfig" AS nl
SET "enabled" = false, "updatedAt" = NOW()
FROM "BotConfig" AS bot
WHERE bot."userId" = nl."userId" AND bot."isScannerEnabled" = false AND nl."enabled" = true;
