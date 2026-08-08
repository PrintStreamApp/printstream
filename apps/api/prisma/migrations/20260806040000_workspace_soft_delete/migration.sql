-- Deleting a workspace without destroying it yet.
--
-- The real delete cascades printers, jobs, library rows and their stored BYTES,
-- none of which come back. So the delete an owner performs is deliberately not
-- that one: it sets `deletedAt`, the workspace leaves every listing, and a
-- platform admin can restore it. Only the retention sweep is irreversible.
--
-- `deletedById` is for the admin deciding whether a restore is warranted --
-- "who did this" is the first question asked -- and is nullable because the
-- actor may be gone by then.
--
-- Every listing filters on `deletedAt IS NULL` through one shared predicate,
-- and the sweep scans by it, hence the index.
--
-- GUARDED, like every migration after `init`: `reconcileMigrationHistory`
-- collapses a pre-squash history into a satisfied `init` row and then applies
-- everything recorded after it, against a database that may already have these
-- columns. See `apply-migrations.test.ts`.

ALTER TABLE "Workspace" ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3);
ALTER TABLE "Workspace" ADD COLUMN IF NOT EXISTS "deletedById" TEXT;

CREATE INDEX IF NOT EXISTS "Workspace_deletedAt_idx" ON "Workspace"("deletedAt");
