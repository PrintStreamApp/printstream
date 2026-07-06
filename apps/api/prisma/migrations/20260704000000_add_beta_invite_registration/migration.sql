-- CreateTable
CREATE TABLE "BetaInviteCode" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "note" TEXT,
    "disabled" BOOLEAN NOT NULL DEFAULT false,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "usedAt" TIMESTAMP(3),
    "usedByEmail" TEXT,
    "usedByTenantId" TEXT,

    CONSTRAINT "BetaInviteCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PendingRegistration" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "displayName" TEXT,
    "workspaceName" TEXT NOT NULL,
    "inviteCodeId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PendingRegistration_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BetaInviteCode_code_key" ON "BetaInviteCode"("code");

-- CreateIndex
CREATE INDEX "BetaInviteCode_createdAt_idx" ON "BetaInviteCode"("createdAt");

-- CreateIndex
CREATE INDEX "PendingRegistration_email_expiresAt_idx" ON "PendingRegistration"("email", "expiresAt");

-- AddForeignKey
ALTER TABLE "PendingRegistration" ADD CONSTRAINT "PendingRegistration_inviteCodeId_fkey" FOREIGN KEY ("inviteCodeId") REFERENCES "BetaInviteCode"("id") ON DELETE CASCADE ON UPDATE CASCADE;
