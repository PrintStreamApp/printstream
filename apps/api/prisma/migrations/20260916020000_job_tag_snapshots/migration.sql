ALTER TABLE "PrintJob" ADD COLUMN "tagSnapshotJson" TEXT;
-- A one-time baseline of recoverable legacy assignments. Never infer original files from shared bytes.
UPDATE "PrintJob" j SET "tagSnapshotJson" = jsonb_build_object(
  'tags', COALESCE((
    SELECT jsonb_agg(jsonb_build_object('id', t.id, 'entityKind', t."entityKind", 'name', t.name, 'group', t."group", 'color', t.color))
    FROM "WorkspaceTag" t WHERE t."workspaceId" = j."workspaceId" AND (
      (t."entityKind" = 'printer' AND EXISTS (SELECT 1 FROM "_PrinterTags" a WHERE a."A" = j."printerId" AND a."B" = t.id)) OR
      (t."entityKind" = 'file' AND EXISTS (SELECT 1 FROM "_LibraryFileTags" a WHERE a."A" IN (j."sourceLibraryFileId", j."fileId", j."sourceProjectFileId") AND a."B" = t.id)) OR
      (t."entityKind" = 'spool' AND EXISTS (SELECT 1 FROM "_SpoolTags" a JOIN "FilamentSpoolUsage" u ON u."spoolId" = a."A" WHERE a."B" = t.id AND u."jobId" = j.id AND u."workspaceId" = j."workspaceId"))
    )
  ), '[]'::jsonb),
  'spoolIds', COALESCE((SELECT jsonb_agg(DISTINCT u."spoolId") FROM "FilamentSpoolUsage" u WHERE u."jobId" = j.id AND u."workspaceId" = j."workspaceId"), '[]'::jsonb)
)::text;
