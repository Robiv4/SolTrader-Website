-- AlterTable
ALTER TABLE "Trade" ADD COLUMN     "entryAt" TIMESTAMP(3),
ADD COLUMN     "executionDelayMs" INTEGER,
ADD COLUMN     "exitAt" TIMESTAMP(3),
ADD COLUMN     "paperDecision" JSONB,
ADD COLUMN     "partialFillRatio" DECIMAL(5,4),
ADD COLUMN     "priorityFee" DECIMAL(18,8),
ADD COLUMN     "stopLoss" DECIMAL(18,8),
ADD COLUMN     "takeProfit" DECIMAL(18,8),
ADD COLUMN     "trailingStop" DECIMAL(5,4);

-- CreateTable
CREATE TABLE "BotState" (
    "id" TEXT NOT NULL,
    "status" "BotStatus" NOT NULL DEFAULT 'STOPPED',
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "BotState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BotStrategyConfig" (
    "id" TEXT NOT NULL,
    "strategyName" TEXT NOT NULL,
    "isEnabled" BOOLEAN NOT NULL DEFAULT false,
    "configJson" JSONB NOT NULL,
    "maxExposure" DECIMAL(18,8),
    "maxPositions" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BotStrategyConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BotState_status_idx" ON "BotState"("status");

-- CreateIndex
CREATE INDEX "BotState_updatedAt_idx" ON "BotState"("updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "BotStrategyConfig_strategyName_key" ON "BotStrategyConfig"("strategyName");

-- CreateIndex
CREATE INDEX "BotStrategyConfig_isEnabled_idx" ON "BotStrategyConfig"("isEnabled");
