/*
  Warnings:

  - A unique constraint covering the columns `[userId]` on the table `BotConfig` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[userId,address]` on the table `Wallet` will be added. If there are existing duplicate values, this will fail.

*/
-- DropForeignKey
ALTER TABLE "BotConfig" DROP CONSTRAINT "BotConfig_userId_fkey";

-- DropForeignKey
ALTER TABLE "Wallet" DROP CONSTRAINT "Wallet_userId_fkey";

-- DropIndex
DROP INDEX "Wallet_address_key";

-- AlterTable
ALTER TABLE "BotConfig" ADD COLUMN     "botTradingWalletAddress" VARCHAR(255),
ADD COLUMN     "maxTokenAgeHours" INTEGER DEFAULT 168,
ADD COLUMN     "minLiquidityUsd" DECIMAL(18,8),
ADD COLUMN     "minVolumeUsd" DECIMAL(18,8),
ADD COLUMN     "preferredQuoteCurrency" TEXT NOT NULL DEFAULT 'USDC';

-- AlterTable
ALTER TABLE "Wallet" ADD COLUMN     "botTradingWalletAddress" VARCHAR(255),
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'CONNECTED',
ADD COLUMN     "walletType" TEXT NOT NULL DEFAULT 'PHANTOM';

-- CreateTable
CREATE TABLE "RiskConfig" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "maxPositionPercent" DECIMAL(5,2),
    "maxTotalExposurePercent" DECIMAL(5,2),
    "maxConcurrentPositions" INTEGER DEFAULT 3,
    "dailyLossLimitPercent" DECIMAL(5,2),
    "maxSlippagePercent" DECIMAL(5,2),
    "minSignalScore" DECIMAL(5,2),
    "cooldownSeconds" INTEGER DEFAULT 60,
    "stopLossPercent" DECIMAL(5,2),
    "takeProfitPercent" DECIMAL(5,2),
    "trailingStopPercent" DECIMAL(5,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RiskConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StrategyConfig" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "strategyName" TEXT NOT NULL,
    "isEnabled" BOOLEAN NOT NULL DEFAULT false,
    "params" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StrategyConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationConfig" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "telegramEnabled" BOOLEAN NOT NULL DEFAULT false,
    "telegramChatId" TEXT,
    "emailAlerts" BOOLEAN NOT NULL DEFAULT false,
    "pushAlerts" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RiskConfig_userId_key" ON "RiskConfig"("userId");

-- CreateIndex
CREATE INDEX "RiskConfig_userId_idx" ON "RiskConfig"("userId");

-- CreateIndex
CREATE INDEX "StrategyConfig_userId_idx" ON "StrategyConfig"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "StrategyConfig_userId_strategyName_key" ON "StrategyConfig"("userId", "strategyName");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationConfig_userId_key" ON "NotificationConfig"("userId");

-- CreateIndex
CREATE INDEX "NotificationConfig_userId_idx" ON "NotificationConfig"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "BotConfig_userId_key" ON "BotConfig"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Wallet_userId_address_key" ON "Wallet"("userId", "address");

-- AddForeignKey
ALTER TABLE "BotConfig" ADD CONSTRAINT "BotConfig_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RiskConfig" ADD CONSTRAINT "RiskConfig_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StrategyConfig" ADD CONSTRAINT "StrategyConfig_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationConfig" ADD CONSTRAINT "NotificationConfig_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Wallet" ADD CONSTRAINT "Wallet_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
