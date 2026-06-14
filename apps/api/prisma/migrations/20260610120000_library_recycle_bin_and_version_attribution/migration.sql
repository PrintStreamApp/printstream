-- Recycle bin (soft delete), row-origin tracking, and actor attribution /
-- restore provenance for library files and their version history.
ALTER TABLE "LibraryFile" ADD COLUMN "deletedAt" TIMESTAMP(3);
ALTER TABLE "LibraryFile" ADD COLUMN "origin" TEXT;
ALTER TABLE "LibraryFile" ADD COLUMN "createdById" TEXT;
ALTER TABLE "LibraryFile" ADD COLUMN "createdByName" TEXT;
ALTER TABLE "LibraryFile" ADD COLUMN "restoredFromVersionNumber" INTEGER;

CREATE INDEX "LibraryFile_tenantId_deletedAt_idx" ON "LibraryFile"("tenantId", "deletedAt");

ALTER TABLE "LibraryFileVersion" ADD COLUMN "createdById" TEXT;
ALTER TABLE "LibraryFileVersion" ADD COLUMN "createdByName" TEXT;
ALTER TABLE "LibraryFileVersion" ADD COLUMN "restoredFromVersionNumber" INTEGER;
