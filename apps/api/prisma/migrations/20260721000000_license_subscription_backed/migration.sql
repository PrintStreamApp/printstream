-- Pro plans now cover self-hosted use, so a license key can be backed by a live
-- subscription rather than a one-time purchase. That needs a run window
-- ("expiresAt", refreshed while the subscription lives), a printer allowance
-- signed into the key, and a link back to the workspace paying for it.
--
-- Existing rows are one-time/community grants: "source" defaults to "purchase"
-- and "expiresAt"/"maxPrinters" stay NULL, which the token contract reads as
-- perpetual + unlimited. Keys already in customers' hands therefore keep
-- working unchanged.
-- AlterTable
ALTER TABLE "License" ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'purchase',
ADD COLUMN     "tenantId" TEXT,
ADD COLUMN     "expiresAt" TIMESTAMP(3),
ADD COLUMN     "maxPrinters" INTEGER,
ADD COLUMN     "lastRefreshedAt" TIMESTAMP(3);

-- Community grants were always perpetual and non-commercial; label them so the
-- refresh endpoint can tell them apart from purchases without re-parsing tokens.
UPDATE "License" SET "source" = 'community' WHERE "edition" = 'community';

-- CreateIndex
CREATE INDEX "License_tenantId_idx" ON "License"("tenantId");

-- CreateIndex
CREATE INDEX "License_paddleCustomerId_idx" ON "License"("paddleCustomerId");

-- AddForeignKey
-- SetNull, not Cascade: a deleted workspace must not destroy the record of a
-- key we issued and were paid for.
ALTER TABLE "License" ADD CONSTRAINT "License_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
