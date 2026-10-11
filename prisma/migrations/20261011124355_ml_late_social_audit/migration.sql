-- AlterTable
ALTER TABLE "MlFeatureSnapshot" ADD COLUMN     "lateDataExcluded" JSONB;

-- AlterTable
ALTER TABLE "MlPaperDecision" ADD COLUMN     "lateDataExcluded" JSONB,
ADD COLUMN     "observedAt" JSONB;

