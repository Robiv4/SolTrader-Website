-- CreateEnum
CREATE TYPE "RiskDecision" AS ENUM ('ACCEPT', 'WATCH', 'REJECT');

-- CreateTable
CREATE TABLE "RiskAssessment" (
    "id" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "userId" TEXT,
    "riskScore" DECIMAL(5,2) NOT NULL,
    "decision" "RiskDecision" NOT NULL,
    "factors" JSONB NOT NULL,
    "rejectionReasons" JSONB NOT NULL,
    "warnings" JSONB NOT NULL,
    "source" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RiskAssessment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RiskAssessment_tokenId_createdAt_idx" ON "RiskAssessment"("tokenId", "createdAt");

-- CreateIndex
CREATE INDEX "RiskAssessment_decision_idx" ON "RiskAssessment"("decision");

-- CreateIndex
CREATE INDEX "RiskAssessment_userId_idx" ON "RiskAssessment"("userId");

-- AddForeignKey
ALTER TABLE "RiskAssessment" ADD CONSTRAINT "RiskAssessment_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "Token"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RiskAssessment" ADD CONSTRAINT "RiskAssessment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
