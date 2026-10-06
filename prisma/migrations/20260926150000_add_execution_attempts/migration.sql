CREATE TABLE "ExecutionAttempt" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "requestFingerprint" TEXT NOT NULL,
  "state" TEXT NOT NULL,
  "attemptCount" INTEGER NOT NULL DEFAULT 1,
  "transactionSignature" TEXT,
  "request" JSONB NOT NULL,
  "record" JSONB NOT NULL,
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ExecutionAttempt_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ExecutionAttempt_userId_idempotencyKey_key" ON "ExecutionAttempt"("userId", "idempotencyKey");
CREATE INDEX "ExecutionAttempt_userId_state_updatedAt_idx" ON "ExecutionAttempt"("userId", "state", "updatedAt");
CREATE INDEX "ExecutionAttempt_transactionSignature_idx" ON "ExecutionAttempt"("transactionSignature");
ALTER TABLE "ExecutionAttempt" ADD CONSTRAINT "ExecutionAttempt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
