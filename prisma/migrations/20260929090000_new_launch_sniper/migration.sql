-- New Launch / Sniper (PAPER only). Existing data untouched.
CREATE TABLE "NewLaunchConfig" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "minAgeSeconds" INTEGER NOT NULL DEFAULT 5,
    "maxAgeSeconds" INTEGER NOT NULL DEFAULT 90,
    "observationSeconds" INTEGER NOT NULL DEFAULT 10,
    "cooldownSeconds" INTEGER NOT NULL DEFAULT 60,
    "minTransactions" INTEGER NOT NULL DEFAULT 15,
    "minUniqueBuyers" INTEGER NOT NULL DEFAULT 10,
    "minBuySellRatio" DECIMAL(6,2) NOT NULL DEFAULT 1.5,
    "minLaunchVolumeUsd" DECIMAL(14,2) NOT NULL DEFAULT 2000,
    "minScore" INTEGER NOT NULL DEFAULT 70,
    "maxExhaustionScore" INTEGER NOT NULL DEFAULT 70,
    "minLiquidityUsd" DECIMAL(14,2) NOT NULL DEFAULT 10000,
    "maxLiquidityUsd" DECIMAL(14,2),
    "maxPriceImpactPercent" DECIMAL(6,2) NOT NULL DEFAULT 3,
    "liquidityOutflowWarningPercent" DECIMAL(6,2) NOT NULL DEFAULT 25,
    "liquidityCriticalPercent" DECIMAL(6,2) NOT NULL DEFAULT 50,
    "maxRiskScore" INTEGER NOT NULL DEFAULT 80,
    "maxPositionPercent" DECIMAL(6,2) NOT NULL DEFAULT 1,
    "maxConcurrentPositions" INTEGER NOT NULL DEFAULT 2,
    "minObservedSellers" INTEGER NOT NULL DEFAULT 1,
    "independentMode" BOOLEAN NOT NULL DEFAULT true,
    "useAiConfirmation" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "NewLaunchConfig_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "NewLaunchConfig_userId_key" ON "NewLaunchConfig"("userId");
ALTER TABLE "NewLaunchConfig" ADD CONSTRAINT "NewLaunchConfig_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "LaunchCandidate" (
    "id" TEXT NOT NULL,
    "mint" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "poolAddress" TEXT,
    "bondingCurve" TEXT,
    "quoteMint" TEXT,
    "creator" TEXT,
    "name" TEXT,
    "symbol" TEXT,
    "detectedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3),
    "firstTradableAt" TIMESTAMP(3),
    "initialLiquidityUsd" DECIMAL(18,2),
    "detectedPriceUsd" DECIMAL(30,18),
    "status" TEXT NOT NULL DEFAULT 'OBSERVING',
    "security" JSONB,
    "lastMetrics" JSONB,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "LaunchCandidate_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "LaunchCandidate_mint_key" ON "LaunchCandidate"("mint");
CREATE INDEX "LaunchCandidate_detectedAt_idx" ON "LaunchCandidate"("detectedAt");
CREATE INDEX "LaunchCandidate_status_idx" ON "LaunchCandidate"("status");

CREATE TABLE "LaunchSnapshot" (
    "id" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "takenAt" TIMESTAMP(3) NOT NULL,
    "priceUsd" DECIMAL(30,18),
    "liquidityUsd" DECIMAL(18,2),
    "volumeUsd" DECIMAL(18,2),
    "buyCount" INTEGER,
    "sellCount" INTEGER,
    "buyVolumeUsd" DECIMAL(18,2),
    "sellVolumeUsd" DECIMAL(18,2),
    "uniqueBuyers" INTEGER,
    "uniqueSellers" INTEGER,
    "largestBuyerShare" DECIMAL(6,4),
    "marketCapUsd" DECIMAL(20,2),
    "bondingProgress" DECIMAL(6,4),
    "dataQuality" INTEGER,
    CONSTRAINT "LaunchSnapshot_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "LaunchSnapshot_candidateId_takenAt_idx" ON "LaunchSnapshot"("candidateId", "takenAt");
ALTER TABLE "LaunchSnapshot" ADD CONSTRAINT "LaunchSnapshot_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "LaunchCandidate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "LaunchDecision" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "mint" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "score" INTEGER,
    "launchMomentumScore" INTEGER,
    "exhaustionScore" INTEGER,
    "liquidityScore" INTEGER,
    "buyerQualityScore" INTEGER,
    "buyPressureScore" INTEGER,
    "securityScore" INTEGER,
    "dataQuality" INTEGER NOT NULL,
    "riskScore" DECIMAL(5,2),
    "riskClassification" TEXT,
    "reasons" JSONB NOT NULL,
    "warnings" JSONB NOT NULL,
    "features" JSONB,
    "signalId" TEXT,
    "detectedAt" TIMESTAMP(3) NOT NULL,
    "securityCompletedAt" TIMESTAMP(3),
    "decisionAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LaunchDecision_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "LaunchDecision_userId_decisionAt_idx" ON "LaunchDecision"("userId", "decisionAt");
CREATE INDEX "LaunchDecision_userId_mint_idx" ON "LaunchDecision"("userId", "mint");
CREATE INDEX "LaunchDecision_decision_idx" ON "LaunchDecision"("decision");
ALTER TABLE "LaunchDecision" ADD CONSTRAINT "LaunchDecision_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LaunchDecision" ADD CONSTRAINT "LaunchDecision_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "LaunchCandidate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "PositionEvent" (
    "id" TEXT NOT NULL,
    "positionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "price" DECIMAL(30,18),
    "details" JSONB,
    CONSTRAINT "PositionEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "PositionEvent_positionId_at_idx" ON "PositionEvent"("positionId", "at");
CREATE INDEX "PositionEvent_userId_idx" ON "PositionEvent"("userId");
ALTER TABLE "PositionEvent" ADD CONSTRAINT "PositionEvent_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "Position"("id") ON DELETE CASCADE ON UPDATE CASCADE;
