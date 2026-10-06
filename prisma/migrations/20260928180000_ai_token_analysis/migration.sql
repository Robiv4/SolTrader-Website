-- Per-user AI settings (existing users get no row: code defaults apply, AI mode OFF)
CREATE TABLE "AiConfig" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "aiAnalysisEnabled" BOOLEAN NOT NULL DEFAULT false,
    "aiMinimumConfidence" INTEGER NOT NULL DEFAULT 75,
    "aiRecheckSeconds" INTEGER NOT NULL DEFAULT 30,
    "aiMaxAnalysesPerMinute" INTEGER NOT NULL DEFAULT 10,
    "aiAllowHighRisk" BOOLEAN NOT NULL DEFAULT true,
    "aiAllowVeryHighRisk" BOOLEAN NOT NULL DEFAULT false,
    "aiDynamicExitSuggestionsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "aiDecisionTtlSeconds" INTEGER NOT NULL DEFAULT 180,
    "aiUseExitParameters" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AiConfig_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AiConfig_userId_key" ON "AiConfig"("userId");
ALTER TABLE "AiConfig" ADD CONSTRAINT "AiConfig_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AI analyses (authoritative history)
CREATE TABLE "AiAnalysis" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "tokenAddress" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "riskAssessmentId" TEXT,
    "status" TEXT NOT NULL,
    "rawDecision" TEXT,
    "effectiveDecision" TEXT NOT NULL,
    "effectiveReason" TEXT,
    "confidence" DECIMAL(5,2),
    "entryQuality" DECIMAL(5,2),
    "marketStrength" DECIMAL(5,2),
    "momentumQuality" DECIMAL(5,2),
    "liquidityQuality" DECIMAL(5,2),
    "timingQuality" DECIMAL(5,2),
    "exhaustionRisk" DECIMAL(5,2),
    "recommendedPositionMultiplier" DECIMAL(5,4),
    "suggestedStopLossPercent" DECIMAL(7,2),
    "suggestedTakeProfitPercent" DECIMAL(7,2),
    "suggestedTrailingActivationPercent" DECIMAL(7,2),
    "suggestedTrailingDistancePercent" DECIMAL(7,2),
    "recheckSeconds" INTEGER,
    "reasons" JSONB,
    "warnings" JSONB,
    "errorMessage" TEXT,
    "inputHash" TEXT NOT NULL,
    "marketStateHash" TEXT NOT NULL,
    "input" JSONB,
    "latencyMs" INTEGER,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "cached" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AiAnalysis_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AiAnalysis_userId_tokenId_createdAt_idx" ON "AiAnalysis"("userId", "tokenId", "createdAt");
CREATE INDEX "AiAnalysis_userId_createdAt_idx" ON "AiAnalysis"("userId", "createdAt");
ALTER TABLE "AiAnalysis" ADD CONSTRAINT "AiAnalysis_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AiAnalysis" ADD CONSTRAINT "AiAnalysis_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "Token"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Decision source of every trade (existing trades: manual buys -> MANUAL_PAPER, everything else -> STRATEGY)
ALTER TABLE "Trade" ADD COLUMN "decisionSource" TEXT NOT NULL DEFAULT 'STRATEGY';
ALTER TABLE "Trade" ADD COLUMN "aiAnalysisId" TEXT;
UPDATE "Trade" SET "decisionSource" = 'MANUAL_PAPER' WHERE "strategyName" = 'MANUAL_PAPER';
