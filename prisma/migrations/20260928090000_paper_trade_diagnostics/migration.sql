-- Trailing activation / break-even settings (nullable: existing users keep their current behaviour)
ALTER TABLE "RiskConfig" ADD COLUMN "trailingActivationPercent" DECIMAL(5,2);
ALTER TABLE "RiskConfig" ADD COLUMN "breakEvenActivationPercent" DECIMAL(5,2);

-- Persisted trailing state per position
ALTER TABLE "Position" ADD COLUMN "entryMarketPrice" DECIMAL(30,18);
ALTER TABLE "Position" ADD COLUMN "trailingActivationPercent" DECIMAL(7,4);
ALTER TABLE "Position" ADD COLUMN "trailingActive" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Position" ADD COLUMN "trailingActivatedAt" TIMESTAMP(3);
ALTER TABLE "Position" ADD COLUMN "trailingActivationPrice" DECIMAL(30,18);
ALTER TABLE "Position" ADD COLUMN "trailingTriggerPrice" DECIMAL(30,18);
ALTER TABLE "Position" ADD COLUMN "breakEvenActivationPercent" DECIMAL(7,4);
ALTER TABLE "Position" ADD COLUMN "breakEvenAppliedAt" TIMESTAMP(3);

-- Trade diagnostics
ALTER TABLE "Trade" ADD COLUMN "entryMarketPrice" DECIMAL(30,18);
ALTER TABLE "Trade" ADD COLUMN "exitMarketPrice" DECIMAL(30,18);
ALTER TABLE "Trade" ADD COLUMN "exitSlippage" DECIMAL(18,8);
ALTER TABLE "Trade" ADD COLUMN "configSnapshot" JSONB;
ALTER TABLE "Trade" ADD COLUMN "exitDiagnostics" JSONB;
