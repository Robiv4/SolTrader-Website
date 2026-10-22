-- CreateTable
CREATE TABLE "MlTrainingJob" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'AUTONOMOUS',
    "name" TEXT,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "stage" TEXT,
    "activeKey" TEXT,
    "datasetVersion" TEXT,
    "bundleVersion" TEXT,
    "readiness" TEXT,
    "requestedBy" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "heartbeatAt" TIMESTAMP(3),
    "leaseOwner" TEXT,
    "cancelRequested" BOOLEAN NOT NULL DEFAULT false,
    "error" TEXT,
    "log" JSONB NOT NULL DEFAULT '[]',
    "result" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MlTrainingJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MlTrainingJob_activeKey_key" ON "MlTrainingJob"("activeKey");

-- CreateIndex
CREATE INDEX "MlTrainingJob_status_requestedAt_idx" ON "MlTrainingJob"("status", "requestedAt");

