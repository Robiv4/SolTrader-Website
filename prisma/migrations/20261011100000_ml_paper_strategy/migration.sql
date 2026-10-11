-- AlterTable
ALTER TABLE "MlModelVersion" ADD COLUMN     "paperApproved" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "paperApprovedAt" TIMESTAMP(3),
ADD COLUMN     "paperApprovedBy" TEXT,
ADD COLUMN     "paperRevokedAt" TIMESTAMP(3),
ADD COLUMN     "paperRevokedBy" TEXT;

-- AlterTable
ALTER TABLE "Position" ADD COLUMN     "entryStrategy" TEXT;

-- AlterTable
ALTER TABLE "Trade" ADD COLUMN     "entryStrategy" TEXT,
ADD COLUMN     "mlModelVersion" TEXT,
ADD COLUMN     "mlPaperDecisionId" TEXT;

-- CreateTable
CREATE TABLE "MlPaperSettings" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "strategyMode" TEXT NOT NULL DEFAULT 'DEFAULT',
    "modelVersion" TEXT,
    "buyThreshold" DECIMAL(4,3) NOT NULL DEFAULT 0.7,
    "decisionWindowSeconds" INTEGER NOT NULL DEFAULT 10,
    "enabledAt" TIMESTAMP(3),
    "enabledBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MlPaperSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MlPaperDecision" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "candidateId" TEXT,
    "mint" TEXT NOT NULL,
    "modelVersion" TEXT NOT NULL,
    "featureVersion" TEXT NOT NULL,
    "snapshotKind" TEXT NOT NULL,
    "snapshotAt" TIMESTAMP(3) NOT NULL,
    "detectedAt" TIMESTAMP(3) NOT NULL,
    "features" JSONB NOT NULL,
    "featureHash" TEXT NOT NULL,
    "dataQuality" INTEGER NOT NULL,
    "probability" DECIMAL(8,6),
    "threshold" DECIMAL(4,3) NOT NULL,
    "mlDecision" TEXT NOT NULL,
    "errorReason" TEXT,
    "baseDecision" TEXT,
    "baseReasons" JSONB,
    "safetyPassed" BOOLEAN,
    "safetyBlockers" JSONB,
    "outcome" TEXT NOT NULL,
    "signalId" TEXT,
    "positionId" TEXT,
    "tradeId" TEXT,
    "executionReason" TEXT,
    "decidedAt" TIMESTAMP(3) NOT NULL,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MlPaperDecision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MlPaperSettings_userId_key" ON "MlPaperSettings"("userId");

-- CreateIndex
CREATE INDEX "MlPaperDecision_modelVersion_decidedAt_idx" ON "MlPaperDecision"("modelVersion", "decidedAt");

-- CreateIndex
CREATE INDEX "MlPaperDecision_userId_decidedAt_idx" ON "MlPaperDecision"("userId", "decidedAt");

-- CreateIndex
CREATE INDEX "MlPaperDecision_outcome_idx" ON "MlPaperDecision"("outcome");

-- CreateIndex
CREATE UNIQUE INDEX "MlPaperDecision_userId_mint_key" ON "MlPaperDecision"("userId", "mint");

-- AddForeignKey
ALTER TABLE "MlPaperSettings" ADD CONSTRAINT "MlPaperSettings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Data: every existing New Launch PAPER entry was made by the rule-based strategy (ML PAPER did not exist).
-- Origin is recorded once and never rewritten by a later strategy / model change.
UPDATE "Trade" SET "entryStrategy" = 'DEFAULT' WHERE "decisionSource" = 'NEW_LAUNCH' AND "entryStrategy" IS NULL;
UPDATE "Position" SET "entryStrategy" = 'DEFAULT' WHERE "exitPolicy" = 'NEW_LAUNCH' AND "entryStrategy" IS NULL;
