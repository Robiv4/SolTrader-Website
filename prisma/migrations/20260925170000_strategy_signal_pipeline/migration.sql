-- CreateEnum
CREATE TYPE "SignalDirection" AS ENUM ('BUY', 'SELL', 'WATCH');

-- AlterTable
ALTER TABLE "TokenMetric"
ADD COLUMN     "buyCount24h" INTEGER,
ADD COLUMN     "sellCount24h" INTEGER;

-- AlterTable
ALTER TABLE "Signal"
ADD COLUMN     "userId" TEXT,
ADD COLUMN     "strategyName" TEXT,
ADD COLUMN     "direction" "SignalDirection",
ADD COLUMN     "reasons" JSONB,
ADD COLUMN     "entryConditions" JSONB,
ADD COLUMN     "invalidationConditions" JSONB,
ADD COLUMN     "recommendedStop" DECIMAL(18,8),
ADD COLUMN     "recommendedTarget" DECIMAL(18,8);

-- CreateIndex
CREATE INDEX "Signal_userId_strategyName_createdAt_idx" ON "Signal"("userId", "strategyName", "createdAt");

-- AddForeignKey
ALTER TABLE "Signal" ADD CONSTRAINT "Signal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
