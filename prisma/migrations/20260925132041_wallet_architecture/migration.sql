/*
  Warnings:

  - You are about to drop the column `address` on the `Wallet` table. All the data in the column will be lost.
  - You are about to drop the column `botTradingWalletAddress` on the `Wallet` table. All the data in the column will be lost.
  - You are about to drop the column `isPaper` on the `Wallet` table. All the data in the column will be lost.
  - You are about to drop the column `isPrimary` on the `Wallet` table. All the data in the column will be lost.
  - You are about to drop the column `status` on the `Wallet` table. All the data in the column will be lost.
  - You are about to drop the column `walletType` on the `Wallet` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[userId,publicAddress]` on the table `Wallet` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `publicAddress` to the `Wallet` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "WalletType" AS ENUM ('USER', 'BOT_TRADING');

-- DropIndex
DROP INDEX "Wallet_address_idx";

-- DropIndex
DROP INDEX "Wallet_userId_address_key";

-- AlterTable
ALTER TABLE "Wallet"
ADD COLUMN     "publicAddress" TEXT,
ADD COLUMN     "isActive" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "lastBalance" DECIMAL(18,8),
ADD COLUMN     "lastBalanceAt" TIMESTAMP(3),
ADD COLUMN     "network" TEXT NOT NULL DEFAULT 'mainnet-beta',
ADD COLUMN     "provider" TEXT DEFAULT 'PHANTOM',
ADD COLUMN     "type" "WalletType" NOT NULL DEFAULT 'USER';

UPDATE "Wallet" SET "publicAddress" = "address" WHERE "publicAddress" IS NULL;

ALTER TABLE "Wallet"
ALTER COLUMN "publicAddress" SET NOT NULL,
ALTER COLUMN "label" DROP NOT NULL;

ALTER TABLE "Wallet"
DROP COLUMN "address",
DROP COLUMN "botTradingWalletAddress",
DROP COLUMN "isPaper",
DROP COLUMN "isPrimary",
DROP COLUMN "status",
DROP COLUMN "walletType";

-- CreateIndex
CREATE INDEX "Wallet_userId_type_isActive_idx" ON "Wallet"("userId", "type", "isActive");

-- CreateIndex
CREATE INDEX "Wallet_publicAddress_idx" ON "Wallet"("publicAddress");

-- CreateIndex
CREATE UNIQUE INDEX "Wallet_userId_publicAddress_key" ON "Wallet"("userId", "publicAddress");
