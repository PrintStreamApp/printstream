-- AlterTable
ALTER TABLE "Bridge" ADD COLUMN "installationId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Bridge_installationId_key" ON "Bridge"("installationId");
