CREATE TABLE "LibraryUploadCompletion" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "intentDigest" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "libraryFileId" TEXT,
    "fileName" TEXT,
    "fileResultJson" TEXT,
    "archivedVersionId" TEXT,
    "unchanged" BOOLEAN,
    "snapshot" BOOLEAN NOT NULL DEFAULT false,
    "preparedSourceId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LibraryUploadCompletion_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "LibraryUploadCompletion_workspaceId_expiresAt_idx"
ON "LibraryUploadCompletion"("workspaceId", "expiresAt");

ALTER TABLE "LibraryUploadCompletion"
ADD CONSTRAINT "LibraryUploadCompletion_workspaceId_fkey"
FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
