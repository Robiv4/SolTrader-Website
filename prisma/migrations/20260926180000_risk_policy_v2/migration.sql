CREATE TYPE "RiskClassification" AS ENUM ('LOW', 'MODERATE', 'HIGH', 'VERY_HIGH', 'EXTREME', 'BLOCKED');
CREATE TYPE "RiskPolicy" AS ENUM ('CONSERVATIVE', 'BALANCED', 'EXPLORATORY');

ALTER TABLE "RiskConfig"
  ADD COLUMN "riskPolicy" "RiskPolicy" NOT NULL DEFAULT 'BALANCED',
  ADD COLUMN "lowRiskMax" INTEGER NOT NULL DEFAULT 30,
  ADD COLUMN "moderateRiskMax" INTEGER NOT NULL DEFAULT 50,
  ADD COLUMN "highRiskMax" INTEGER NOT NULL DEFAULT 70,
  ADD COLUMN "veryHighRiskMax" INTEGER NOT NULL DEFAULT 85,
  ADD COLUMN "lowPositionMultiplier" DECIMAL(4,3) NOT NULL DEFAULT 1.000,
  ADD COLUMN "moderatePositionMultiplier" DECIMAL(4,3) NOT NULL DEFAULT 0.750,
  ADD COLUMN "highPositionMultiplier" DECIMAL(4,3) NOT NULL DEFAULT 0.350,
  ADD COLUMN "veryHighPositionMultiplier" DECIMAL(4,3) NOT NULL DEFAULT 0.150,
  ADD COLUMN "aiAnalysisEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "aiRequiredForHighRisk" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "aiRequiredForVeryHighRisk" BOOLEAN NOT NULL DEFAULT false;

UPDATE "RiskConfig" AS risk
SET "riskPolicy" = CASE
  WHEN bot."riskThreshold" IS NOT NULL AND bot."riskThreshold" <= 50 THEN 'CONSERVATIVE'::"RiskPolicy"
  ELSE 'BALANCED'::"RiskPolicy"
END
FROM "BotConfig" AS bot
WHERE bot."userId" = risk."userId";

ALTER TABLE "RiskAssessment"
  ADD COLUMN "classification" "RiskClassification" NOT NULL DEFAULT 'MODERATE',
  ADD COLUMN "hardBlocked" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "hardBlockReasons" JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN "riskPolicy" "RiskPolicy" NOT NULL DEFAULT 'BALANCED',
  ADD COLUMN "positionMultiplier" DECIMAL(4,3) NOT NULL DEFAULT 1.000;

UPDATE "RiskAssessment"
SET "classification" = CASE
  WHEN "decision" = 'REJECT' THEN 'BLOCKED'::"RiskClassification"
  WHEN "riskScore" <= 30 THEN 'LOW'::"RiskClassification"
  WHEN "riskScore" <= 50 THEN 'MODERATE'::"RiskClassification"
  WHEN "riskScore" <= 70 THEN 'HIGH'::"RiskClassification"
  WHEN "riskScore" <= 85 THEN 'VERY_HIGH'::"RiskClassification"
  ELSE 'EXTREME'::"RiskClassification"
END,
"hardBlocked" = ("decision" = 'REJECT'),
"hardBlockReasons" = CASE WHEN "decision" = 'REJECT' THEN "rejectionReasons" ELSE '[]'::jsonb END,
"positionMultiplier" = CASE
  WHEN "decision" = 'REJECT' OR "riskScore" > 85 THEN 0.000
  WHEN "riskScore" > 70 THEN 0.150
  WHEN "riskScore" > 50 THEN 0.350
  WHEN "riskScore" > 30 THEN 0.750
  ELSE 1.000
END;

ALTER TABLE "Trade"
  ADD COLUMN "riskClassification" "RiskClassification",
  ADD COLUMN "riskPolicy" "RiskPolicy",
  ADD COLUMN "aiConfirmed" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "aiOpportunityScore" DECIMAL(5,2),
  ADD COLUMN "aiConfidence" DECIMAL(5,2);