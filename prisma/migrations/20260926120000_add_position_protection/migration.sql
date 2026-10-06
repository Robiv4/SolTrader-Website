ALTER TABLE "Position"
ADD COLUMN "signalId" TEXT,
ADD COLUMN "stopLossPrice" DECIMAL(18,8),
ADD COLUMN "takeProfitPrice" DECIMAL(18,8),
ADD COLUMN "trailingStopPercent" DECIMAL(5,4),
ADD COLUMN "highestPrice" DECIMAL(18,8),
ADD COLUMN "lowestPrice" DECIMAL(18,8),
ADD COLUMN "realizedPnl" DECIMAL(18,8),
ADD COLUMN "exitReason" TEXT;

CREATE INDEX "Position_signalId_idx" ON "Position"("signalId");

ALTER TABLE "Position"
ADD CONSTRAINT "Position_signalId_fkey"
FOREIGN KEY ("signalId") REFERENCES "Signal"("id") ON DELETE SET NULL ON UPDATE CASCADE;