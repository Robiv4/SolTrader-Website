ALTER TABLE "BacktestRun"
ADD COLUMN "userId" TEXT,
ADD COLUMN "strategyName" TEXT,
ADD COLUMN "startDate" TIMESTAMP(3),
ADD COLUMN "endDate" TIMESTAMP(3),
ADD COLUMN "startingBalance" DECIMAL(18,8),
ADD COLUMN "endingBalance" DECIMAL(18,8),
ADD COLUMN "returnPercent" DECIMAL(10,4),
ADD COLUMN "maxDrawdown" DECIMAL(18,8),
ADD COLUMN "winRate" DECIMAL(7,4),
ADD COLUMN "profitFactor" DECIMAL(18,8),
ADD COLUMN "expectancy" DECIMAL(18,8),
ADD COLUMN "tradeCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "fees" DECIMAL(18,8),
ADD COLUMN "slippage" DECIMAL(18,8),
ADD COLUMN "configuration" JSONB;

ALTER TABLE "BacktestTrade"
ADD COLUMN "entryTime" TIMESTAMP(3),
ADD COLUMN "exitTime" TIMESTAMP(3),
ADD COLUMN "holdingTimeMs" INTEGER,
ADD COLUMN "fees" DECIMAL(18,8),
ADD COLUMN "slippage" DECIMAL(18,8),
ADD COLUMN "split" TEXT;

ALTER TABLE "BacktestRun"
ADD CONSTRAINT "BacktestRun_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "BacktestTrade"
ADD CONSTRAINT "BacktestTrade_backtestRunId_fkey"
FOREIGN KEY ("backtestRunId") REFERENCES "BacktestRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "BacktestRun_userId_createdAt_idx" ON "BacktestRun"("userId", "createdAt");
