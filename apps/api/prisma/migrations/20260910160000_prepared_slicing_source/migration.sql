-- A hidden snapshot is trusted as browser-authored only through a server-issued
-- record bound to the source lineage and frozen slicing configuration.
CREATE TABLE "PreparedSlicingSource" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "libraryFileId" TEXT NOT NULL,
    "sourceFileId" TEXT NOT NULL,
    "configurationBaseVersionId" TEXT NOT NULL DEFAULT '',
    "contractVersion" INTEGER NOT NULL,
    "configurationDigest" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PreparedSlicingSource_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PreparedSlicingSource_provenance_key"
ON "PreparedSlicingSource"("workspaceId", "libraryFileId", "sourceFileId", "configurationBaseVersionId", "contractVersion", "configurationDigest");

CREATE INDEX "PreparedSlicingSource_libraryFileId_idx" ON "PreparedSlicingSource"("libraryFileId");
CREATE INDEX "PreparedSlicingSource_workspaceId_sourceFileId_idx" ON "PreparedSlicingSource"("workspaceId", "sourceFileId");

ALTER TABLE "PreparedSlicingSource"
ADD CONSTRAINT "PreparedSlicingSource_workspaceId_fkey"
FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PreparedSlicingSource"
ADD CONSTRAINT "PreparedSlicingSource_libraryFileId_fkey"
FOREIGN KEY ("libraryFileId") REFERENCES "LibraryFile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Snapshot content is tenant-local. The old global key made one workspace resolve another
-- workspace's hidden row when identical bytes and names were staged.
DROP INDEX IF EXISTS "LibraryFile_snapshotKey_key";
CREATE UNIQUE INDEX "LibraryFile_workspaceId_snapshotKey_key"
ON "LibraryFile"("workspaceId", "snapshotKey");
