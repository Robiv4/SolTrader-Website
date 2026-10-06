-- CreateTable
CREATE TABLE "MlFeatureSnapshot" (
    "id" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "mint" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "snapshotAt" TIMESTAMP(3) NOT NULL,
    "detectedAt" TIMESTAMP(3) NOT NULL,
    "featureVersion" TEXT NOT NULL,
    "features" JSONB NOT NULL,
    "observedAt" JSONB NOT NULL,
    "dataQuality" INTEGER NOT NULL,
    "validForTraining" BOOLEAN NOT NULL,
    "invalidReasons" JSONB NOT NULL,
    "decision" TEXT NOT NULL,
    "decisionContext" JSONB NOT NULL,
    "newLaunchConfigVersion" TEXT,
    "referencePriceUsd" DECIMAL(30,18),
    "positionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MlFeatureSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MlCandidateOutcome" (
    "id" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "mint" TEXT NOT NULL,
    "labelVersion" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "entryPriceUsd" DECIMAL(30,18) NOT NULL,
    "result" JSONB,
    "path" JSONB NOT NULL,
    "validHorizons" JSONB NOT NULL,
    "endReason" TEXT,
    "trackingEndedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MlCandidateOutcome_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MlDatasetVersion" (
    "id" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "featureVersion" TEXT NOT NULL,
    "labelVersion" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "manifest" JSONB NOT NULL,
    "rowCount" INTEGER NOT NULL,
    "filePath" TEXT NOT NULL,
    "fileHash" TEXT NOT NULL,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MlDatasetVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MlModelVersion" (
    "id" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "algorithm" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'TRAINED',
    "readiness" TEXT NOT NULL,
    "featureVersion" TEXT NOT NULL,
    "labelVersion" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "datasetVersion" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "metrics" JSONB NOT NULL,
    "artifactPath" TEXT NOT NULL,
    "artifactHash" TEXT NOT NULL,
    "statusHistory" JSONB NOT NULL,
    "createdBy" TEXT,
    "trainedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MlModelVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MlPrediction" (
    "id" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "modelVersion" TEXT NOT NULL,
    "mint" TEXT NOT NULL,
    "probability" DECIMAL(8,6) NOT NULL,
    "calibrated" BOOLEAN NOT NULL,
    "mlEntryScore" INTEGER NOT NULL,
    "predictedClass" TEXT NOT NULL,
    "dataQuality" INTEGER NOT NULL,
    "contributions" JSONB,
    "latencyMs" DECIMAL(10,3) NOT NULL,
    "predictedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MlPrediction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MlFeatureSnapshot_snapshotAt_idx" ON "MlFeatureSnapshot"("snapshotAt");

-- CreateIndex
CREATE INDEX "MlFeatureSnapshot_mint_idx" ON "MlFeatureSnapshot"("mint");

-- CreateIndex
CREATE INDEX "MlFeatureSnapshot_kind_featureVersion_snapshotAt_idx" ON "MlFeatureSnapshot"("kind", "featureVersion", "snapshotAt");

-- CreateIndex
CREATE UNIQUE INDEX "MlFeatureSnapshot_candidateId_kind_featureVersion_key" ON "MlFeatureSnapshot"("candidateId", "kind", "featureVersion");

-- CreateIndex
CREATE UNIQUE INDEX "MlCandidateOutcome_snapshotId_key" ON "MlCandidateOutcome"("snapshotId");

-- CreateIndex
CREATE INDEX "MlCandidateOutcome_status_idx" ON "MlCandidateOutcome"("status");

-- CreateIndex
CREATE UNIQUE INDEX "MlDatasetVersion_version_key" ON "MlDatasetVersion"("version");

-- CreateIndex
CREATE UNIQUE INDEX "MlModelVersion_version_key" ON "MlModelVersion"("version");

-- CreateIndex
CREATE INDEX "MlPrediction_modelVersion_predictedAt_idx" ON "MlPrediction"("modelVersion", "predictedAt");

-- CreateIndex
CREATE UNIQUE INDEX "MlPrediction_snapshotId_modelVersion_key" ON "MlPrediction"("snapshotId", "modelVersion");

-- AddForeignKey
ALTER TABLE "MlCandidateOutcome" ADD CONSTRAINT "MlCandidateOutcome_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "MlFeatureSnapshot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MlPrediction" ADD CONSTRAINT "MlPrediction_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "MlFeatureSnapshot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

