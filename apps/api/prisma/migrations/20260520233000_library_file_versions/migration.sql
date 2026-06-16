ALTER TABLE "LibraryFile"
ADD COLUMN "currentVersionNumber" INTEGER NOT NULL DEFAULT 1;

CREATE TABLE "LibraryFileVersion" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "libraryFileId" TEXT NOT NULL,
    "ownerBridgeId" TEXT,
    "folderId" TEXT,
    "name" TEXT NOT NULL,
    "storedPath" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'other',
    "thumbnailPath" TEXT,
    "uploadedAt" TIMESTAMP(3) NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LibraryFileVersion_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "LibraryFileVersion_libraryFileId_versionNumber_key" ON "LibraryFileVersion"("libraryFileId", "versionNumber");

CREATE INDEX "LibraryFileVersion_tenantId_libraryFileId_versionNumber_idx" ON "LibraryFileVersion"("tenantId", "libraryFileId", "versionNumber");

CREATE INDEX "LibraryFile_tenantId_ownerBridgeId_folderId_name_hidden_uploadedAt_idx" ON "LibraryFile"("tenantId", "ownerBridgeId", "folderId", "name", "hidden", "uploadedAt");

ALTER TABLE "LibraryFileVersion"
ADD CONSTRAINT "LibraryFileVersion_tenantId_fkey"
FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "LibraryFileVersion"
ADD CONSTRAINT "LibraryFileVersion_libraryFileId_fkey"
FOREIGN KEY ("libraryFileId") REFERENCES "LibraryFile"("id") ON DELETE CASCADE ON UPDATE CASCADE;