-- AlterTable
ALTER TABLE "TokenMetric"
ADD COLUMN     "dexId" TEXT,
ADD COLUMN     "poolAddress" TEXT;

-- CreateIndex
CREATE INDEX "TokenMetric_poolAddress_idx" ON "TokenMetric"("poolAddress");
