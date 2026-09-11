-- A prepared project has two independent file identities: the visible source used for
-- slice/history lineage, and the current or archived file whose bytes the editor opened.
ALTER TABLE "PreparedSlicingSource"
ADD COLUMN "configurationBaseFileId" TEXT;

-- Existing browser flows used one file for both identities, so this is the safe backfill.
UPDATE "PreparedSlicingSource"
SET "configurationBaseFileId" = "sourceFileId";

ALTER TABLE "PreparedSlicingSource"
ALTER COLUMN "configurationBaseFileId" SET NOT NULL;

DROP INDEX "PreparedSlicingSource_provenance_key";
CREATE UNIQUE INDEX "PreparedSlicingSource_provenance_key"
ON "PreparedSlicingSource"(
    "workspaceId",
    "libraryFileId",
    "sourceFileId",
    "configurationBaseFileId",
    "configurationBaseVersionId",
    "contractVersion",
    "configurationDigest"
);

-- Periodic cleanup prunes expired receipts across every workspace.
CREATE INDEX "LibraryUploadCompletion_expiresAt_idx"
ON "LibraryUploadCompletion"("expiresAt");
