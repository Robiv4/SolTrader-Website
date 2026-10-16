-- AlterTable
ALTER TABLE "MlPaperDecision" ADD COLUMN     "liquidityUsd" DECIMAL(18,2),
ADD COLUMN     "minLiquidityUsd" DECIMAL(14,2),
ADD COLUMN     "sellability" TEXT;

-- AlterTable
ALTER TABLE "MlPaperSettings" ADD COLUMN     "minLiquidityUsd" DECIMAL(14,2);

-- AlterTable
ALTER TABLE "Trade" ADD COLUMN     "mlMinLiquidityUsd" DECIMAL(14,2);

