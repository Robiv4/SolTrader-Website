-- AlterTable
ALTER TABLE "NewLaunchConfig" ADD COLUMN     "dynamicPositionSizingEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "exitCapacityMode" TEXT NOT NULL DEFAULT 'MONITOR_ONLY',
ADD COLUMN     "maxEstimatedEntryImpactPct" DECIMAL(6,3) NOT NULL DEFAULT 3,
ADD COLUMN     "maxEstimatedExitImpactPct" DECIMAL(6,3) NOT NULL DEFAULT 3,
ADD COLUMN     "maxEstimatedRoundTripImpactPct" DECIMAL(6,3) NOT NULL DEFAULT 6,
ADD COLUMN     "maxLiquidityUtilizationPct" DECIMAL(6,3) NOT NULL DEFAULT 5,
ADD COLUMN     "minExitCapacityScore" INTEGER NOT NULL DEFAULT 50,
ADD COLUMN     "minimumExecutablePosition" DECIMAL(18,6) NOT NULL DEFAULT 5,
ADD COLUMN     "positionSizeStep" DECIMAL(18,6) NOT NULL DEFAULT 1;

