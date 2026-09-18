-- Upgrade the original shared catalog without discarding definitions or assignments.
BEGIN;
CREATE TYPE "TagEntityKind" AS ENUM ('printer', 'file', 'spool');
ALTER TABLE "WorkspaceTag" ADD COLUMN "entityKind" "TagEntityKind" NOT NULL DEFAULT 'printer';
DROP INDEX "WorkspaceTag_workspaceId_nameKey_key";
CREATE UNIQUE INDEX "WorkspaceTag_workspaceId_entityKind_nameKey_key"
ON "WorkspaceTag"("workspaceId", "entityKind", "nameKey");

-- A legacy definition was available in every catalog and has no creation-kind provenance.
-- Preserve that vocabulary as independent copies; the original ID stays with printers.
INSERT INTO "WorkspaceTag" ("id", "workspaceId", "name", "nameKey", "color", "group", "entityKind")
SELECT "id" || ':file', "workspaceId", "name", "nameKey", "color", "group", 'file'
FROM "WorkspaceTag" WHERE "entityKind" = 'printer';
INSERT INTO "WorkspaceTag" ("id", "workspaceId", "name", "nameKey", "color", "group", "entityKind")
SELECT "id" || ':spool', "workspaceId", "name", "nameKey", "color", "group", 'spool'
FROM "WorkspaceTag" WHERE "entityKind" = 'printer';
UPDATE "_LibraryFileTags" SET "B" = "B" || ':file';
UPDATE "_SpoolTags" SET "B" = "B" || ':spool';

-- All future writes must explicitly choose their catalog.
ALTER TABLE "WorkspaceTag" ALTER COLUMN "entityKind" DROP DEFAULT;
COMMIT;
