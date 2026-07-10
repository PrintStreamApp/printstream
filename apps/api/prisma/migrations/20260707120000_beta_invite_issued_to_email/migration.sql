-- AlterTable
ALTER TABLE "BetaInviteCode" ADD COLUMN "issuedToEmail" TEXT;

-- CreateIndex
CREATE INDEX "BetaInviteCode_issuedToEmail_idx" ON "BetaInviteCode"("issuedToEmail");
