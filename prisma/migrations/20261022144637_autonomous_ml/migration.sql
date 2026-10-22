-- AlterTable
ALTER TABLE "MlPaperSettings" ADD COLUMN     "autonomousBundleVersion" TEXT;

-- CreateTable
CREATE TABLE "MlAutonomousModelBundle" (
    "id" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'TRAINED',
    "readiness" TEXT NOT NULL,
    "featureVersion" TEXT NOT NULL,
    "labelVersion" TEXT NOT NULL,
    "datasetVersion" TEXT NOT NULL,
    "artifactPath" TEXT NOT NULL,
    "artifactHash" TEXT NOT NULL,
    "policy" JSONB NOT NULL,
    "metrics" JSONB NOT NULL,
    "statusHistory" JSONB NOT NULL,
    "paperApproved" BOOLEAN NOT NULL DEFAULT false,
    "paperApprovedAt" TIMESTAMP(3),
    "paperApprovedBy" TEXT,
    "paperRevokedAt" TIMESTAMP(3),
    "paperRevokedBy" TEXT,
    "createdBy" TEXT,
    "trainedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MlAutonomousModelBundle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MlAutonomousDecisionSnapshot" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "mint" TEXT NOT NULL,
    "candidateId" TEXT,
    "positionId" TEXT,
    "trigger" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "featureVersion" TEXT NOT NULL,
    "features" JSONB NOT NULL,
    "observedAt" JSONB NOT NULL,
    "featureHash" TEXT NOT NULL,
    "dataQuality" INTEGER NOT NULL,
    "lateDataExcluded" JSONB NOT NULL,
    "validForTraining" BOOLEAN NOT NULL,
    "invalidReasons" JSONB NOT NULL,
    "referencePriceUsd" DECIMAL(30,18),
    "referenceLiquidityUsd" DECIMAL(24,8),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MlAutonomousDecisionSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MlAutonomousOutcome" (
    "id" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "labelVersion" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "labels" JSONB NOT NULL,
    "uncertainty" JSONB NOT NULL,
    "exclusionReason" TEXT,
    "labelEndAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MlAutonomousOutcome_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MlAutonomousDecision" (
    "id" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "userId" TEXT,
    "accountId" TEXT,
    "bundleVersion" TEXT NOT NULL,
    "snapshotId" TEXT,
    "mint" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "outputs" JSONB,
    "suggestedSizeUsd" DECIMAL(18,6),
    "executedSizeUsd" DECIMAL(18,6),
    "featureHash" TEXT NOT NULL,
    "decidedAt" TIMESTAMP(3) NOT NULL,
    "executionStatus" TEXT NOT NULL,
    "executionReason" TEXT,
    "safetyBlockers" JSONB,
    "positionId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MlAutonomousDecision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MlAutonomousAccount" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accountKey" TEXT NOT NULL,
    "initialBalance" DECIMAL(18,6) NOT NULL,
    "cashBalance" DECIMAL(18,6) NOT NULL,
    "realizedPnl" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "feesPaid" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "impactCost" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MlAutonomousAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MlAutonomousPosition" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "mint" TEXT NOT NULL,
    "symbol" TEXT,
    "bundleVersion" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "openKey" TEXT,
    "initialQuantity" DECIMAL(30,12) NOT NULL,
    "quantity" DECIMAL(30,12) NOT NULL,
    "entryFillPrice" DECIMAL(30,18) NOT NULL,
    "entryMarketPrice" DECIMAL(30,18) NOT NULL,
    "entryNotionalUsd" DECIMAL(18,6) NOT NULL,
    "entryFeeUsd" DECIMAL(18,6) NOT NULL,
    "entryImpactPct" DECIMAL(10,4) NOT NULL,
    "entryLiquidityUsd" DECIMAL(24,8),
    "entryContext" JSONB NOT NULL,
    "entrySnapshotId" TEXT,
    "entryDecisionId" TEXT,
    "highestPrice" DECIMAL(30,18) NOT NULL,
    "lowestPrice" DECIMAL(30,18) NOT NULL,
    "partiallySold" BOOLEAN NOT NULL DEFAULT false,
    "realizedPnlUsd" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "feesUsd" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "exitReason" TEXT,
    "openedAt" TIMESTAMP(3) NOT NULL,
    "lastEvaluatedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MlAutonomousPosition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MlAutonomousFill" (
    "id" TEXT NOT NULL,
    "positionId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "quantity" DECIMAL(30,12) NOT NULL,
    "fillPrice" DECIMAL(30,18) NOT NULL,
    "marketPrice" DECIMAL(30,18) NOT NULL,
    "notionalUsd" DECIMAL(18,6) NOT NULL,
    "feeUsd" DECIMAL(18,6) NOT NULL,
    "impactPct" DECIMAL(10,4) NOT NULL,
    "realizedPnlUsd" DECIMAL(18,6),
    "decisionId" TEXT,
    "reason" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MlAutonomousFill_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MlAutonomousModelBundle_version_key" ON "MlAutonomousModelBundle"("version");

-- CreateIndex
CREATE INDEX "MlAutonomousDecisionSnapshot_kind_at_idx" ON "MlAutonomousDecisionSnapshot"("kind", "at");

-- CreateIndex
CREATE INDEX "MlAutonomousDecisionSnapshot_mint_at_idx" ON "MlAutonomousDecisionSnapshot"("mint", "at");

-- CreateIndex
CREATE UNIQUE INDEX "MlAutonomousOutcome_snapshotId_key" ON "MlAutonomousOutcome"("snapshotId");

-- CreateIndex
CREATE INDEX "MlAutonomousOutcome_status_idx" ON "MlAutonomousOutcome"("status");

-- CreateIndex
CREATE UNIQUE INDEX "MlAutonomousDecision_idempotencyKey_key" ON "MlAutonomousDecision"("idempotencyKey");

-- CreateIndex
CREATE INDEX "MlAutonomousDecision_bundleVersion_decidedAt_idx" ON "MlAutonomousDecision"("bundleVersion", "decidedAt");

-- CreateIndex
CREATE INDEX "MlAutonomousDecision_userId_decidedAt_idx" ON "MlAutonomousDecision"("userId", "decidedAt");

-- CreateIndex
CREATE INDEX "MlAutonomousDecision_accountId_decidedAt_idx" ON "MlAutonomousDecision"("accountId", "decidedAt");

-- CreateIndex
CREATE UNIQUE INDEX "MlAutonomousAccount_userId_key" ON "MlAutonomousAccount"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "MlAutonomousAccount_accountKey_key" ON "MlAutonomousAccount"("accountKey");

-- CreateIndex
CREATE UNIQUE INDEX "MlAutonomousPosition_openKey_key" ON "MlAutonomousPosition"("openKey");

-- CreateIndex
CREATE INDEX "MlAutonomousPosition_accountId_status_idx" ON "MlAutonomousPosition"("accountId", "status");

-- CreateIndex
CREATE INDEX "MlAutonomousPosition_userId_status_idx" ON "MlAutonomousPosition"("userId", "status");

-- CreateIndex
CREATE INDEX "MlAutonomousFill_accountId_at_idx" ON "MlAutonomousFill"("accountId", "at");

-- AddForeignKey
ALTER TABLE "MlAutonomousOutcome" ADD CONSTRAINT "MlAutonomousOutcome_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "MlAutonomousDecisionSnapshot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MlAutonomousPosition" ADD CONSTRAINT "MlAutonomousPosition_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "MlAutonomousAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MlAutonomousFill" ADD CONSTRAINT "MlAutonomousFill_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "MlAutonomousPosition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

