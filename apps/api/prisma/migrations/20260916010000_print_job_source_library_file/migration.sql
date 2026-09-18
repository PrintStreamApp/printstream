-- Source identity belongs to the job, never to a snapshot shared by identical files.
-- Older snapshot-only jobs cannot be backfilled unambiguously.
ALTER TABLE "PrintJob" ADD COLUMN "sourceLibraryFileId" TEXT;
CREATE INDEX "PrintJob_workspaceId_sourceLibraryFileId_idx" ON "PrintJob"("workspaceId", "sourceLibraryFileId");
ALTER TABLE "PrintJob" ADD CONSTRAINT "PrintJob_sourceLibraryFileId_fkey"
  FOREIGN KEY ("sourceLibraryFileId") REFERENCES "LibraryFile"("id") ON DELETE SET NULL ON UPDATE CASCADE;
