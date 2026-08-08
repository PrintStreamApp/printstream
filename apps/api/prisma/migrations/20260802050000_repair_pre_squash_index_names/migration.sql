-- A second index the Tenant -> Workspace rename truncated to the wrong name.
--
-- Same cause as the `LibraryFile` one repaired in
-- `20260801230000_repair_pre_squash_drift`: the rename built new index names by
-- substituting `tenantId` -> `workspaceId`, which is longer, so Postgres
-- truncated at 63 bytes somewhere other than where Prisma derives the name.
--
-- Missed the first time because that pass compared staging's indexes against a
-- DEVELOPER database — which carried the identical wrong name, so the shared
-- drift cancelled out and both looked correct. Only
-- `prisma migrate diff --to-schema-datamodel` compares against the datamodel
-- itself, and that is what found it. Diff against the datamodel, never against
-- another database that ran the same migration.
DO $$
DECLARE
  drifted text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE schemaname = 'public'
    AND indexname = 'CalibrationResult_workspaceId_kind_printerModel_nozzleDiame_idx'
  ) THEN
    FOR drifted IN
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname LIKE 'CalibrationResult_workspaceId_kind_printerModel_nozzleDia%'
        AND indexname <> 'CalibrationResult_workspaceId_kind_printerModel_nozzleDiame_idx'
    LOOP
      EXECUTE format('ALTER INDEX %I RENAME TO %I', drifted,
        'CalibrationResult_workspaceId_kind_printerModel_nozzleDiame_idx');
      EXIT;
    END LOOP;
  END IF;
END $$;
