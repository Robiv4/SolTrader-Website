-- Per-user setting: skip tokens that stay blocked / unbuyable for a while so the scanner moves on.
ALTER TABLE "BotConfig" ADD COLUMN "skipUnbuyableAfterMinutes" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "BotConfig" ADD COLUMN "skipUnbuyableForMinutes" INTEGER NOT NULL DEFAULT 60;
