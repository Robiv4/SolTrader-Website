-- AlterTable
ALTER TABLE "LaunchCandidate" ADD COLUMN     "socialLinks" JSONB;

-- AlterTable
ALTER TABLE "LaunchDecision" ADD COLUMN     "socialSummary" JSONB;

-- AlterTable
ALTER TABLE "NewLaunchConfig" ADD COLUMN     "aiSocialAnalysisEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "socialDecisionMode" TEXT NOT NULL DEFAULT 'MONITOR_ONLY',
ADD COLUMN     "socialIntelligenceEnabled" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "SocialSnapshot" (
    "id" TEXT NOT NULL,
    "mint" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "socialScore" INTEGER,
    "momentumScore" INTEGER,
    "qualityScore" INTEGER,
    "spamScore" INTEGER,
    "exhaustionScore" INTEGER,
    "dataQuality" INTEGER,
    "confirmation" TEXT NOT NULL,
    "shadowDecision" TEXT NOT NULL,
    "mentionTrend" TEXT NOT NULL,
    "tokenMatchConfidence" DECIMAL(5,3),
    "matchBasis" TEXT NOT NULL,
    "mentions5m" INTEGER,
    "uniqueAuthors5m" INTEGER,
    "freshness" TEXT NOT NULL,
    "details" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SocialSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SocialSnapshot_mint_at_idx" ON "SocialSnapshot"("mint", "at");

