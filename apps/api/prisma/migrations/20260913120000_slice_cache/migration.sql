-- Keep one immutable completed slice per source lineage. Cache hits materialize a fresh transient
-- output, so the artifact row referenced here is never exposed to Save/Discard mutations.
CREATE TABLE "SliceCacheEntry" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "sourceFileId" TEXT NOT NULL,
    "cacheKey" TEXT NOT NULL,
    "artifactFileId" TEXT NOT NULL,
    "sourceProjectFileId" TEXT,
    "outputFileName" TEXT NOT NULL,
    "slicerName" TEXT,
    "metadataJson" TEXT,
    "sliceSettingsJson" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SliceCacheEntry_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SliceCacheEntry_workspaceId_sourceFileId_key"
ON "SliceCacheEntry"("workspaceId", "sourceFileId");

CREATE INDEX "SliceCacheEntry_workspaceId_updatedAt_idx"
ON "SliceCacheEntry"("workspaceId", "updatedAt");

CREATE INDEX "SliceCacheEntry_artifactFileId_idx"
ON "SliceCacheEntry"("artifactFileId");

CREATE INDEX "SliceCacheEntry_sourceProjectFileId_idx"
ON "SliceCacheEntry"("sourceProjectFileId");

ALTER TABLE "SliceCacheEntry"
ADD CONSTRAINT "SliceCacheEntry_workspaceId_fkey"
FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SliceCacheEntry"
ADD CONSTRAINT "SliceCacheEntry_sourceFileId_fkey"
FOREIGN KEY ("sourceFileId") REFERENCES "LibraryFile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SliceCacheEntry"
ADD CONSTRAINT "SliceCacheEntry_artifactFileId_fkey"
FOREIGN KEY ("artifactFileId") REFERENCES "LibraryFile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SliceCacheEntry"
ADD CONSTRAINT "SliceCacheEntry_sourceProjectFileId_fkey"
FOREIGN KEY ("sourceProjectFileId") REFERENCES "LibraryFile"("id") ON DELETE SET NULL ON UPDATE CASCADE;
