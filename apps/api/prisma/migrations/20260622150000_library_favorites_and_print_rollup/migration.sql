-- Per-user library favorites + denormalized print-history rollup on LibraryFile.
-- Hand-authored to stay idempotent (the repo applies migrations via `migrate deploy`).

-- Denormalized print-history columns powering the "most printed" / "last printed" sorts.
ALTER TABLE "LibraryFile" ADD COLUMN IF NOT EXISTS "printCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "LibraryFile" ADD COLUMN IF NOT EXISTS "lastPrintedAt" TIMESTAMP(3);

-- Backfill the rollup from existing print history (count of jobs per file + most recent start).
UPDATE "LibraryFile" lf
SET "printCount" = sub.cnt,
    "lastPrintedAt" = sub.last_started
FROM (
  SELECT "fileId", COUNT(*)::int AS cnt, MAX("startedAt") AS last_started
  FROM "PrintJob"
  WHERE "fileId" IS NOT NULL
  GROUP BY "fileId"
) sub
WHERE lf."id" = sub."fileId";

-- Sort-supporting indexes (explicit names kept in sync with schema @@index(map: ...)).
CREATE INDEX IF NOT EXISTS "LibraryFile_tenant_bridge_folder_printCount_idx"
  ON "LibraryFile" ("tenantId", "ownerBridgeId", "folderId", "hidden", "printCount");
CREATE INDEX IF NOT EXISTS "LibraryFile_tenant_bridge_folder_lastPrintedAt_idx"
  ON "LibraryFile" ("tenantId", "ownerBridgeId", "folderId", "hidden", "lastPrintedAt");

-- Per-user favorite star. No FK to AuthUser so favorites work in no-auth installs too.
CREATE TABLE IF NOT EXISTS "LibraryFileFavorite" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "libraryFileId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LibraryFileFavorite_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "LibraryFileFavorite_userId_libraryFileId_key"
  ON "LibraryFileFavorite" ("userId", "libraryFileId");
CREATE INDEX IF NOT EXISTS "LibraryFileFavorite_tenantId_userId_idx"
  ON "LibraryFileFavorite" ("tenantId", "userId");
CREATE INDEX IF NOT EXISTS "LibraryFileFavorite_libraryFileId_idx"
  ON "LibraryFileFavorite" ("libraryFileId");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'LibraryFileFavorite_tenantId_fkey') THEN
    ALTER TABLE "LibraryFileFavorite"
      ADD CONSTRAINT "LibraryFileFavorite_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'LibraryFileFavorite_libraryFileId_fkey') THEN
    ALTER TABLE "LibraryFileFavorite"
      ADD CONSTRAINT "LibraryFileFavorite_libraryFileId_fkey"
      FOREIGN KEY ("libraryFileId") REFERENCES "LibraryFile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
