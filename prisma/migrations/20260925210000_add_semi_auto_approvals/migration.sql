CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'STALE', 'EXECUTED');

CREATE TABLE "ApprovalRequest" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "signalId" TEXT NOT NULL,
  "tokenId" TEXT NOT NULL,
  "status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
  "direction" "TradeSide" NOT NULL,
  "signalScore" DECIMAL(5,2) NOT NULL,
  "riskScore" DECIMAL(5,2) NOT NULL,
  "entryPrice" DECIMAL(18,8) NOT NULL,
  "positionSize" DECIMAL(18,8) NOT NULL,
  "stopLoss" DECIMAL(18,8),
  "takeProfit" DECIMAL(18,8),
  "trailingStop" DECIMAL(5,4),
  "reasons" JSONB NOT NULL,
  "proposedOrderHash" TEXT NOT NULL,
  "proposedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "reviewedAt" TIMESTAMP(3),
  "executedAt" TIMESTAMP(3),
  "rejectionReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ApprovalRequest_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ApprovalRequest_proposedOrderHash_key" ON "ApprovalRequest"("proposedOrderHash");
CREATE UNIQUE INDEX "ApprovalRequest_userId_signalId_key" ON "ApprovalRequest"("userId", "signalId");
CREATE INDEX "ApprovalRequest_userId_status_expiresAt_idx" ON "ApprovalRequest"("userId", "status", "expiresAt");
CREATE INDEX "ApprovalRequest_signalId_idx" ON "ApprovalRequest"("signalId");
ALTER TABLE "ApprovalRequest" ADD CONSTRAINT "ApprovalRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ApprovalRequest" ADD CONSTRAINT "ApprovalRequest_signalId_fkey" FOREIGN KEY ("signalId") REFERENCES "Signal"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ApprovalRequest" ADD CONSTRAINT "ApprovalRequest_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "Token"("id") ON DELETE CASCADE ON UPDATE CASCADE;
