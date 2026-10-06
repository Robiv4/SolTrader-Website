-- AlterTable
ALTER TABLE "BacktestRun" ALTER COLUMN "userId" SET NOT NULL,
ALTER COLUMN "startDate" SET NOT NULL,
ALTER COLUMN "endDate" SET NOT NULL,
ALTER COLUMN "startingBalance" SET NOT NULL;

-- AlterTable
ALTER TABLE "BacktestTrade" ALTER COLUMN "entry" SET DATA TYPE DECIMAL(30,18),
ALTER COLUMN "exit" SET DATA TYPE DECIMAL(30,18);

-- AlterTable
ALTER TABLE "LaunchDecision" ADD COLUMN     "configVersion" TEXT,
ADD COLUMN     "qualityGateMode" TEXT,
ADD COLUMN     "qualityGateReasons" JSONB,
ADD COLUMN     "qualityGateWouldPass" BOOLEAN;

-- AlterTable
ALTER TABLE "NewLaunchConfig" ADD COLUMN     "breakEvenActivationPercent" DECIMAL(6,2) NOT NULL DEFAULT 10,
ADD COLUMN     "breakEvenEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "configVersion" TEXT NOT NULL DEFAULT 'NL-v1',
ADD COLUMN     "liquidityDropExitPercent" DECIMAL(6,2) NOT NULL DEFAULT 50,
ADD COLUMN     "liquiditySafetyExitEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "maxHoldEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "maxHoldMinutes" INTEGER NOT NULL DEFAULT 30,
ADD COLUMN     "minimumRecommendationSampleSize" INTEGER NOT NULL DEFAULT 50,
ADD COLUMN     "qualityGate" JSONB,
ADD COLUMN     "stopLossPercent" DECIMAL(6,2) NOT NULL DEFAULT 20,
ADD COLUMN     "takeProfitPercent" DECIMAL(7,2) NOT NULL DEFAULT 25,
ADD COLUMN     "tieredTakeProfitEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "tieredTakeProfitLevels" JSONB,
ADD COLUMN     "trailingActivationPercent" DECIMAL(6,2) NOT NULL DEFAULT 15,
ADD COLUMN     "trailingDistancePercent" DECIMAL(6,2) NOT NULL DEFAULT 8,
ADD COLUMN     "trailingEnabled" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "Position" ADD COLUMN     "configVersion" TEXT,
ADD COLUMN     "exitPolicy" TEXT,
ADD COLUMN     "liquidityExitPercent" DECIMAL(6,2),
ADD COLUMN     "maxHoldUntil" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "NewLaunchConfigVersion" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "entryConfig" JSONB NOT NULL,
    "exitConfig" JSONB NOT NULL,
    "qualityGate" JSONB NOT NULL,
    "parentVersion" TEXT,
    "createdFromRecommendationId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NewLaunchConfigVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PositionPathMetric" (
    "id" TEXT NOT NULL,
    "positionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "decisionSource" TEXT,
    "configVersion" TEXT,
    "entryPrice" DECIMAL(30,18) NOT NULL,
    "entryAt" TIMESTAMP(3) NOT NULL,
    "quantity" DECIMAL(18,8) NOT NULL,
    "maxPriceAfterEntry" DECIMAL(30,18),
    "minPriceAfterEntry" DECIMAL(30,18),
    "mfePercent" DECIMAL(12,4),
    "mfeUsd" DECIMAL(18,8),
    "timeToMfeMs" INTEGER,
    "maePercent" DECIMAL(12,4),
    "maeUsd" DECIMAL(18,8),
    "timeToMaeMs" INTEGER,
    "milestones" JSONB NOT NULL,
    "liquidityAtEntry" DECIMAL(24,8),
    "lastLiquidityUsd" DECIMAL(24,8),
    "minLiquidityUsd" DECIMAL(24,8),
    "sampleCount" INTEGER NOT NULL DEFAULT 0,
    "lastPriceAt" TIMESTAMP(3),
    "source" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PositionPathMetric_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NewLaunchOptimizationRun" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "scope" JSONB NOT NULL,
    "sampleSize" INTEGER NOT NULL DEFAULT 0,
    "result" JSONB,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "NewLaunchOptimizationRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NewLaunchOptimizationRecommendation" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "parameter" TEXT NOT NULL,
    "currentValue" DECIMAL(20,6),
    "suggestedValue" DECIMAL(20,6),
    "sampleSize" INTEGER NOT NULL,
    "confidenceLevel" TEXT NOT NULL,
    "trainingMetrics" JSONB NOT NULL,
    "validationMetrics" JSONB NOT NULL,
    "tradeRetention" DECIMAL(7,4),
    "winnerRetention" DECIMAL(7,4),
    "loserRejection" DECIMAL(7,4),
    "reason" TEXT NOT NULL,
    "warnings" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdVersion" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),

    CONSTRAINT "NewLaunchOptimizationRecommendation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "NewLaunchConfigVersion_userId_createdAt_idx" ON "NewLaunchConfigVersion"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "NewLaunchConfigVersion_userId_version_key" ON "NewLaunchConfigVersion"("userId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "PositionPathMetric_positionId_key" ON "PositionPathMetric"("positionId");

-- CreateIndex
CREATE INDEX "PositionPathMetric_userId_decisionSource_idx" ON "PositionPathMetric"("userId", "decisionSource");

-- CreateIndex
CREATE INDEX "PositionPathMetric_userId_configVersion_idx" ON "PositionPathMetric"("userId", "configVersion");

-- CreateIndex
CREATE INDEX "NewLaunchOptimizationRun_userId_startedAt_idx" ON "NewLaunchOptimizationRun"("userId", "startedAt");

-- CreateIndex
CREATE INDEX "NewLaunchOptimizationRecommendation_userId_status_idx" ON "NewLaunchOptimizationRecommendation"("userId", "status");

-- CreateIndex
CREATE INDEX "Position_userId_configVersion_idx" ON "Position"("userId", "configVersion");

-- CreateIndex
CREATE INDEX "Position_userId_closedAt_idx" ON "Position"("userId", "closedAt");

-- AddForeignKey
ALTER TABLE "NewLaunchConfigVersion" ADD CONSTRAINT "NewLaunchConfigVersion_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PositionPathMetric" ADD CONSTRAINT "PositionPathMetric_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "Position"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NewLaunchOptimizationRun" ADD CONSTRAINT "NewLaunchOptimizationRun_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NewLaunchOptimizationRecommendation" ADD CONSTRAINT "NewLaunchOptimizationRecommendation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NewLaunchOptimizationRecommendation" ADD CONSTRAINT "NewLaunchOptimizationRecommendation_runId_fkey" FOREIGN KEY ("runId") REFERENCES "NewLaunchOptimizationRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

