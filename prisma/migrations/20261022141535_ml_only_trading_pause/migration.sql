-- AlterTable
ALTER TABLE "MlPaperSettings" ADD COLUMN     "pausedAt" TIMESTAMP(3),
ADD COLUMN     "pausedBy" TEXT,
ADD COLUMN     "tradingPaused" BOOLEAN NOT NULL DEFAULT false;

