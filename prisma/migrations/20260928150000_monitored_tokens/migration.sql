-- Per-user size of the scanner's rotating token pool (token monitor)
ALTER TABLE "BotConfig" ADD COLUMN "maxMonitoredTokens" INTEGER NOT NULL DEFAULT 50;
