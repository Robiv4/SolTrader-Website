-- CreateTable
CREATE TABLE "TelegramSource" (
    "id" TEXT NOT NULL,
    "tokenId" TEXT,
    "mint" TEXT NOT NULL,
    "telegramEntityId" TEXT,
    "telegramUsername" TEXT,
    "telegramUrl" TEXT,
    "sourceType" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "officialStatus" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "discoveredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastVerifiedAt" TIMESTAMP(3),
    "matchBasis" TEXT NOT NULL,
    "matchConfidence" DECIMAL(5,3) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "accessStatus" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TelegramSource_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TelegramSource_mint_idx" ON "TelegramSource"("mint");

-- CreateIndex
CREATE INDEX "TelegramSource_telegramUsername_idx" ON "TelegramSource"("telegramUsername");

-- CreateIndex
CREATE UNIQUE INDEX "TelegramSource_mint_telegramUsername_key" ON "TelegramSource"("mint", "telegramUsername");

