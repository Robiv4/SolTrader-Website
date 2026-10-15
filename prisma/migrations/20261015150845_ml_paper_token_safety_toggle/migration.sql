-- AlterTable
ALTER TABLE "MlPaperDecision" ADD COLUMN     "ignoredSafetyBlockers" JSONB,
ADD COLUMN     "tokenSafetyChecksEnabled" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "MlPaperSettings" ADD COLUMN     "tokenSafetyChecksEnabled" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "Trade" ADD COLUMN     "mlTokenSafetyChecks" BOOLEAN;

