-- Short-window market observations (provider rolling windows)
ALTER TABLE "TokenMetric" ADD COLUMN "priceChange5m" DECIMAL(12,4);
ALTER TABLE "TokenMetric" ADD COLUMN "volume5m" DECIMAL(30,8);
ALTER TABLE "TokenMetric" ADD COLUMN "volume1h" DECIMAL(30,8);
ALTER TABLE "TokenMetric" ADD COLUMN "buyCount5m" INTEGER;
ALTER TABLE "TokenMetric" ADD COLUMN "sellCount5m" INTEGER;
ALTER TABLE "TokenMetric" ADD COLUMN "buyCount1h" INTEGER;
ALTER TABLE "TokenMetric" ADD COLUMN "sellCount1h" INTEGER;
ALTER TABLE "TokenMetric" ADD COLUMN "provider" TEXT;
ALTER TABLE "TokenMetric" ADD COLUMN "dataQuality" TEXT;

-- Liquidity at entry (optional liquidity-outflow exit)
ALTER TABLE "Position" ADD COLUMN "entryLiquidityUsd" DECIMAL(24,8);

-- Advanced strategy / composite signal settings (one row per user, created lazily; code defaults apply until then)
CREATE TABLE "AdvancedStrategyConfig" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "compositeEnabled" BOOLEAN NOT NULL DEFAULT false,
    "minimumConfirmations" INTEGER NOT NULL DEFAULT 3,
    "minimumCompositeScore" INTEGER NOT NULL DEFAULT 65,
    "penalizeUnavailable" BOOLEAN NOT NULL DEFAULT false,
    "exhaustionEnabled" BOOLEAN NOT NULL DEFAULT true,
    "exhaustionWarningThreshold" INTEGER NOT NULL DEFAULT 40,
    "exhaustionStrongWarningThreshold" INTEGER NOT NULL DEFAULT 70,
    "exhaustionBlockThreshold" INTEGER NOT NULL DEFAULT 85,
    "exhaustionPolicy" TEXT NOT NULL DEFAULT 'BLOCK',
    "exhaustionPenaltyWeight" DECIMAL(5,3) NOT NULL DEFAULT 0.5,
    "liquidityOutflowExitEnabled" BOOLEAN NOT NULL DEFAULT false,
    "liquidityOutflowExitPercent" DECIMAL(5,2) NOT NULL DEFAULT 50,
    "modules" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AdvancedStrategyConfig_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AdvancedStrategyConfig_userId_key" ON "AdvancedStrategyConfig"("userId");
ALTER TABLE "AdvancedStrategyConfig" ADD CONSTRAINT "AdvancedStrategyConfig_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
