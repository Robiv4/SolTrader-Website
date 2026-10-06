-- AlterTable
ALTER TABLE "NewLaunchConfig" ADD COLUMN     "breakEvenCostBufferPercent" DECIMAL(6,3) NOT NULL DEFAULT 0.6;

-- AlterTable
ALTER TABLE "Position" ADD COLUMN     "breakEvenCostBuffer" DECIMAL(8,6);

