CREATE TYPE "PaperOrderStatus" AS ENUM ('QUEUED', 'PARTIALLY_FILLED', 'FILLED', 'REJECTED', 'CANCELLED');

CREATE TABLE "PaperAccount" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USDC',
    "initialBalance" DECIMAL(18,8) NOT NULL,
    "cashBalance" DECIMAL(18,8) NOT NULL,
    "equity" DECIMAL(18,8) NOT NULL,
    "realizedPnl" DECIMAL(18,8) NOT NULL DEFAULT 0,
    "unrealizedPnl" DECIMAL(18,8) NOT NULL DEFAULT 0,
    "totalFees" DECIMAL(18,8) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaperAccount_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PaperOrder" (
    "id" TEXT NOT NULL,
    "paperAccountId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenAddress" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "side" "TradeSide" NOT NULL,
    "strategyName" TEXT,
    "signalId" TEXT,
    "status" "PaperOrderStatus" NOT NULL DEFAULT 'QUEUED',
    "requestedNotionalUsd" DECIMAL(18,8) NOT NULL,
    "filledNotionalUsd" DECIMAL(18,8) NOT NULL DEFAULT 0,
    "quantity" DECIMAL(18,8) NOT NULL DEFAULT 0,
    "executionPriceUsd" DECIMAL(18,8),
    "feeUsd" DECIMAL(18,8) NOT NULL DEFAULT 0,
    "slippageUsd" DECIMAL(18,8) NOT NULL DEFAULT 0,
    "priorityFeeUsd" DECIMAL(18,8) NOT NULL DEFAULT 0,
    "executionDelayMs" INTEGER NOT NULL DEFAULT 0,
    "partialFillRatio" DECIMAL(5,4),
    "signalScore" DECIMAL(5,2),
    "riskScore" DECIMAL(5,2),
    "rejectionReason" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaperOrder_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PaperFill" (
    "id" TEXT NOT NULL,
    "paperOrderId" TEXT NOT NULL,
    "tokenAddress" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "quantity" DECIMAL(18,8) NOT NULL,
    "priceUsd" DECIMAL(18,8) NOT NULL,
    "notionalUsd" DECIMAL(18,8) NOT NULL,
    "feeUsd" DECIMAL(18,8) NOT NULL,
    "slippageUsd" DECIMAL(18,8) NOT NULL,
    "filledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaperFill_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PaperAccount_userId_key" ON "PaperAccount"("userId");
CREATE INDEX "PaperAccount_userId_idx" ON "PaperAccount"("userId");
CREATE INDEX "PaperOrder_paperAccountId_createdAt_idx" ON "PaperOrder"("paperAccountId", "createdAt");
CREATE INDEX "PaperOrder_userId_createdAt_idx" ON "PaperOrder"("userId", "createdAt");
CREATE INDEX "PaperFill_paperOrderId_idx" ON "PaperFill"("paperOrderId");

ALTER TABLE "PaperAccount"
    ADD CONSTRAINT "PaperAccount_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PaperOrder"
    ADD CONSTRAINT "PaperOrder_paperAccountId_fkey"
    FOREIGN KEY ("paperAccountId") REFERENCES "PaperAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PaperOrder"
    ADD CONSTRAINT "PaperOrder_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PaperFill"
    ADD CONSTRAINT "PaperFill_paperOrderId_fkey"
    FOREIGN KEY ("paperOrderId") REFERENCES "PaperOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
