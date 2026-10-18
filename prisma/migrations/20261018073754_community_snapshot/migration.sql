-- CreateTable
CREATE TABLE "CommunitySnapshot" (
    "id" TEXT NOT NULL,
    "mint" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "version" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "quality" TEXT NOT NULL,
    "communityScore" INTEGER,
    "dataQuality" INTEGER NOT NULL,
    "coverage" DECIMAL(6,4),
    "socialMomentum" INTEGER,
    "spamScore" INTEGER,
    "mentions5m" INTEGER,
    "uniqueAuthors5m" INTEGER,
    "onchainBuyers5m" INTEGER,
    "buyerConcentration" DECIMAL(6,4),
    "paidPromotion" BOOLEAN,
    "features" JSONB NOT NULL,
    "sources" JSONB NOT NULL,
    "components" JSONB NOT NULL,
    "lateExcluded" JSONB NOT NULL,
    "reasons" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommunitySnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CommunitySnapshot_mint_at_idx" ON "CommunitySnapshot"("mint", "at");

-- CreateIndex
CREATE INDEX "CommunitySnapshot_at_idx" ON "CommunitySnapshot"("at");

