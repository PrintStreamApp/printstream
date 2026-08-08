-- Make the Tenant->Workspace and BillingAccount->Customer renames real in the
-- database, not just in the Prisma models.
--
-- Both renames originally shipped as `@@map`/`@map`, which kept the code and the
-- storage speaking different languages. This renames the storage to match, so
-- there is one vocabulary end to end.
--
-- Idempotent by construction. `00000000000000_init` already creates the NEW
-- names, so on a fresh database every statement here finds nothing and does
-- nothing; on a database created before the rename it does the work. That is
-- why each step is guarded rather than written as a bare ALTER.
--
-- Covers four kinds of thing, and all four are needed for the rename to be
-- real: tables, columns, the constraint/index names Postgres does NOT rewrite
-- when you rename a table, and the stats functions/triggers whose BODIES name
-- the old tables. Plus the persisted VALUES that spell the old word --
-- settings keys and permission strings -- which are data, not schema, and would
-- otherwise silently stop matching the code that reads them.

-- 1. Tables.
DO $$
DECLARE
  renames CONSTANT text[][] := ARRAY[
    ['Tenant', 'Workspace'],
    ['TenantStats', 'WorkspaceStats'],
    ['TenantSubscription', 'WorkspaceSubscription'],
    ['AuthTenantMembership', 'AuthWorkspaceMembership'],
    ['BillingAccount', 'Customer'],
    ['BillingAccountMembership', 'CustomerMembership'],
    ['AuthMagicLinkToken', 'AuthEmailCodeToken']
  ];
  entry text[];
BEGIN
  FOREACH entry SLICE 1 IN ARRAY renames LOOP
    IF to_regclass(format('public.%I', entry[1])) IS NOT NULL
       AND to_regclass(format('public.%I', entry[2])) IS NULL THEN
      EXECUTE format('ALTER TABLE public.%I RENAME TO %I', entry[1], entry[2]);
    END IF;
  END LOOP;
END $$;

-- 2. Columns, wherever they appear.
DO $$
DECLARE
  renames CONSTANT text[][] := ARRAY[
    ['tenantId', 'workspaceId'],
    ['billingAccountId', 'customerId'],
    ['tenantCount', 'workspaceCount'],
    ['tenantName', 'workspaceName'],
    ['usedByTenantId', 'usedByWorkspaceId']
  ];
  entry text[];
  target record;
BEGIN
  FOREACH entry SLICE 1 IN ARRAY renames LOOP
    FOR target IN
      SELECT c.table_name
      FROM information_schema.columns c
      WHERE c.table_schema = 'public'
        AND c.column_name = entry[1]
        AND NOT EXISTS (
          SELECT 1 FROM information_schema.columns existing
          WHERE existing.table_schema = 'public'
            AND existing.table_name = c.table_name
            AND existing.column_name = entry[2]
        )
    LOOP
      EXECUTE format('ALTER TABLE public.%I RENAME COLUMN %I TO %I', target.table_name, entry[1], entry[2]);
    END LOOP;
  END LOOP;
END $$;

-- 3. Constraint and index names. Renaming a table leaves these pointing at the
--    old word, and Prisma derives the names it expects from the table and
--    columns -- so without this the schema reads as drifted forever.
DO $$
DECLARE
  target record;
  renamed text;
BEGIN
  FOR target IN
    SELECT con.conname AS name, rel.relname AS table_name
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    WHERE nsp.nspname = 'public'
      AND (con.conname LIKE '%Tenant%' OR con.conname LIKE '%tenant%'
           OR con.conname LIKE '%BillingAccount%' OR con.conname LIKE '%billingAccount%'
           OR con.conname LIKE '%AuthMagicLinkToken%')
  LOOP
    renamed := replace(replace(replace(replace(replace(target.name,
      'AuthTenantMembership', 'AuthWorkspaceMembership'),
      'BillingAccount', 'Customer'), 'billingAccount', 'customer'),
      'Tenant', 'Workspace'), 'tenant', 'workspace');
    renamed := replace(renamed, 'AuthMagicLinkToken', 'AuthEmailCodeToken');
    IF renamed <> target.name THEN
      EXECUTE format('ALTER TABLE public.%I RENAME CONSTRAINT %I TO %I', target.table_name, target.name, renamed);
    END IF;
  END LOOP;

  FOR target IN
    SELECT indexname AS name
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND (indexname LIKE '%Tenant%' OR indexname LIKE '%tenant%'
           OR indexname LIKE '%BillingAccount%' OR indexname LIKE '%billingAccount%'
           OR indexname LIKE '%AuthMagicLinkToken%')
  LOOP
    renamed := replace(replace(replace(replace(replace(target.name,
      'AuthTenantMembership', 'AuthWorkspaceMembership'),
      'BillingAccount', 'Customer'), 'billingAccount', 'customer'),
      'Tenant', 'Workspace'), 'tenant', 'workspace');
    renamed := replace(renamed, 'AuthMagicLinkToken', 'AuthEmailCodeToken');
    IF renamed <> target.name AND to_regclass(format('public.%I', renamed)) IS NULL THEN
      EXECUTE format('ALTER INDEX public.%I RENAME TO %I', target.name, renamed);
    END IF;
  END LOOP;
END $$;

-- 4. Recreate the stats objects under the new names.
CREATE OR REPLACE FUNCTION public.ensure_platform_stats_row()
 RETURNS void
 LANGUAGE plpgsql
AS $function$
BEGIN
  INSERT INTO "PlatformStats" ("id") VALUES ('platform')
  ON CONFLICT ("id") DO NOTHING;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.ensure_workspace_stats_row()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  INSERT INTO "WorkspaceStats" ("workspaceId") VALUES (NEW."id")
  ON CONFLICT ("workspaceId") DO NOTHING;
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.refresh_platform_workspace_counts()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  PERFORM ensure_platform_stats_row();

  UPDATE "PlatformStats"
  SET
    "workspaceCount" = (SELECT COUNT(*)::INTEGER FROM "Workspace"),
    "userCount" = (SELECT COUNT(DISTINCT "userId")::INTEGER FROM "AuthWorkspaceMembership"),
    "printerCount" = (SELECT COUNT(*)::INTEGER FROM "Printer"),
    "updatedAt" = CURRENT_TIMESTAMP
  WHERE "id" = 'platform';

  RETURN COALESCE(NEW, OLD);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.sync_platform_stats_from_workspace_stats()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  total_prints_delta INTEGER := 0;
  successful_duration_delta INTEGER := 0;
  failed_duration_delta INTEGER := 0;
  cancelled_duration_delta INTEGER := 0;
  wasted_duration_delta INTEGER := 0;
  tracked_filament_delta INTEGER := 0;
  filament_grams_delta NUMERIC := 0;
  successful_filament_grams_delta NUMERIC := 0;
  failed_filament_grams_delta NUMERIC := 0;
  cancelled_filament_grams_delta NUMERIC := 0;
  wasted_filament_grams_delta NUMERIC := 0;
  filament_meters_delta NUMERIC := 0;
  successful_filament_meters_delta NUMERIC := 0;
  failed_filament_meters_delta NUMERIC := 0;
  cancelled_filament_meters_delta NUMERIC := 0;
  wasted_filament_meters_delta NUMERIC := 0;
BEGIN
  PERFORM ensure_platform_stats_row();

  IF TG_OP = 'INSERT' THEN
    total_prints_delta := NEW."totalPrints";
    successful_duration_delta := NEW."successfulPrintDurationSeconds";
    failed_duration_delta := NEW."failedPrintDurationSeconds";
    cancelled_duration_delta := NEW."cancelledPrintDurationSeconds";
    wasted_duration_delta := NEW."wastedPrintDurationSeconds";
    tracked_filament_delta := NEW."trackedFilamentPrints";
    filament_grams_delta := COALESCE(NEW."filamentUsedGrams", 0);
    successful_filament_grams_delta := COALESCE(NEW."successfulFilamentUsedGrams", 0);
    failed_filament_grams_delta := COALESCE(NEW."failedFilamentUsedGrams", 0);
    cancelled_filament_grams_delta := COALESCE(NEW."cancelledFilamentUsedGrams", 0);
    wasted_filament_grams_delta := COALESCE(NEW."wastedFilamentUsedGrams", 0);
    filament_meters_delta := COALESCE(NEW."filamentUsedMeters", 0);
    successful_filament_meters_delta := COALESCE(NEW."successfulFilamentUsedMeters", 0);
    failed_filament_meters_delta := COALESCE(NEW."failedFilamentUsedMeters", 0);
    cancelled_filament_meters_delta := COALESCE(NEW."cancelledFilamentUsedMeters", 0);
    wasted_filament_meters_delta := COALESCE(NEW."wastedFilamentUsedMeters", 0);
  ELSIF TG_OP = 'DELETE' THEN
    total_prints_delta := -OLD."totalPrints";
    successful_duration_delta := -OLD."successfulPrintDurationSeconds";
    failed_duration_delta := -OLD."failedPrintDurationSeconds";
    cancelled_duration_delta := -OLD."cancelledPrintDurationSeconds";
    wasted_duration_delta := -OLD."wastedPrintDurationSeconds";
    tracked_filament_delta := -OLD."trackedFilamentPrints";
    filament_grams_delta := -COALESCE(OLD."filamentUsedGrams", 0);
    successful_filament_grams_delta := -COALESCE(OLD."successfulFilamentUsedGrams", 0);
    failed_filament_grams_delta := -COALESCE(OLD."failedFilamentUsedGrams", 0);
    cancelled_filament_grams_delta := -COALESCE(OLD."cancelledFilamentUsedGrams", 0);
    wasted_filament_grams_delta := -COALESCE(OLD."wastedFilamentUsedGrams", 0);
    filament_meters_delta := -COALESCE(OLD."filamentUsedMeters", 0);
    successful_filament_meters_delta := -COALESCE(OLD."successfulFilamentUsedMeters", 0);
    failed_filament_meters_delta := -COALESCE(OLD."failedFilamentUsedMeters", 0);
    cancelled_filament_meters_delta := -COALESCE(OLD."cancelledFilamentUsedMeters", 0);
    wasted_filament_meters_delta := -COALESCE(OLD."wastedFilamentUsedMeters", 0);
  ELSE
    total_prints_delta := NEW."totalPrints" - OLD."totalPrints";
    successful_duration_delta := NEW."successfulPrintDurationSeconds" - OLD."successfulPrintDurationSeconds";
    failed_duration_delta := NEW."failedPrintDurationSeconds" - OLD."failedPrintDurationSeconds";
    cancelled_duration_delta := NEW."cancelledPrintDurationSeconds" - OLD."cancelledPrintDurationSeconds";
    wasted_duration_delta := NEW."wastedPrintDurationSeconds" - OLD."wastedPrintDurationSeconds";
    tracked_filament_delta := NEW."trackedFilamentPrints" - OLD."trackedFilamentPrints";
    filament_grams_delta := COALESCE(NEW."filamentUsedGrams", 0) - COALESCE(OLD."filamentUsedGrams", 0);
    successful_filament_grams_delta := COALESCE(NEW."successfulFilamentUsedGrams", 0) - COALESCE(OLD."successfulFilamentUsedGrams", 0);
    failed_filament_grams_delta := COALESCE(NEW."failedFilamentUsedGrams", 0) - COALESCE(OLD."failedFilamentUsedGrams", 0);
    cancelled_filament_grams_delta := COALESCE(NEW."cancelledFilamentUsedGrams", 0) - COALESCE(OLD."cancelledFilamentUsedGrams", 0);
    wasted_filament_grams_delta := COALESCE(NEW."wastedFilamentUsedGrams", 0) - COALESCE(OLD."wastedFilamentUsedGrams", 0);
    filament_meters_delta := COALESCE(NEW."filamentUsedMeters", 0) - COALESCE(OLD."filamentUsedMeters", 0);
    successful_filament_meters_delta := COALESCE(NEW."successfulFilamentUsedMeters", 0) - COALESCE(OLD."successfulFilamentUsedMeters", 0);
    failed_filament_meters_delta := COALESCE(NEW."failedFilamentUsedMeters", 0) - COALESCE(OLD."failedFilamentUsedMeters", 0);
    cancelled_filament_meters_delta := COALESCE(NEW."cancelledFilamentUsedMeters", 0) - COALESCE(OLD."cancelledFilamentUsedMeters", 0);
    wasted_filament_meters_delta := COALESCE(NEW."wastedFilamentUsedMeters", 0) - COALESCE(OLD."wastedFilamentUsedMeters", 0);
  END IF;

  UPDATE "PlatformStats"
  SET
    "totalPrints" = GREATEST(0, "totalPrints" + total_prints_delta),
    "successfulPrintDurationSeconds" = GREATEST(0, "successfulPrintDurationSeconds" + successful_duration_delta),
    "failedPrintDurationSeconds" = GREATEST(0, "failedPrintDurationSeconds" + failed_duration_delta),
    "cancelledPrintDurationSeconds" = GREATEST(0, "cancelledPrintDurationSeconds" + cancelled_duration_delta),
    "wastedPrintDurationSeconds" = GREATEST(0, "wastedPrintDurationSeconds" + wasted_duration_delta),
    "trackedFilamentPrints" = GREATEST(0, "trackedFilamentPrints" + tracked_filament_delta),
    "filamentUsedGrams" = GREATEST(0, "filamentUsedGrams" + filament_grams_delta),
    "successfulFilamentUsedGrams" = GREATEST(0, "successfulFilamentUsedGrams" + successful_filament_grams_delta),
    "failedFilamentUsedGrams" = GREATEST(0, "failedFilamentUsedGrams" + failed_filament_grams_delta),
    "cancelledFilamentUsedGrams" = GREATEST(0, "cancelledFilamentUsedGrams" + cancelled_filament_grams_delta),
    "wastedFilamentUsedGrams" = GREATEST(0, "wastedFilamentUsedGrams" + wasted_filament_grams_delta),
    "filamentUsedMeters" = GREATEST(0, "filamentUsedMeters" + filament_meters_delta),
    "successfulFilamentUsedMeters" = GREATEST(0, "successfulFilamentUsedMeters" + successful_filament_meters_delta),
    "failedFilamentUsedMeters" = GREATEST(0, "failedFilamentUsedMeters" + failed_filament_meters_delta),
    "cancelledFilamentUsedMeters" = GREATEST(0, "cancelledFilamentUsedMeters" + cancelled_filament_meters_delta),
    "wastedFilamentUsedMeters" = GREATEST(0, "wastedFilamentUsedMeters" + wasted_filament_meters_delta),
    "updatedAt" = CURRENT_TIMESTAMP
  WHERE "id" = 'platform';

  RETURN COALESCE(NEW, OLD);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.sync_workspace_print_stats()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  old_total INTEGER := 0;
  old_success INTEGER := 0;
  old_failed INTEGER := 0;
  old_cancelled INTEGER := 0;
  old_success_duration INTEGER := 0;
  old_failed_duration INTEGER := 0;
  old_cancelled_duration INTEGER := 0;
  old_wasted_duration INTEGER := 0;
  old_tracked_filament INTEGER := 0;
  old_filament_grams NUMERIC := 0;
  old_successful_filament_grams NUMERIC := 0;
  old_failed_filament_grams NUMERIC := 0;
  old_cancelled_filament_grams NUMERIC := 0;
  old_wasted_filament_grams NUMERIC := 0;
  old_filament_meters NUMERIC := 0;
  old_successful_filament_meters NUMERIC := 0;
  old_failed_filament_meters NUMERIC := 0;
  old_cancelled_filament_meters NUMERIC := 0;
  old_wasted_filament_meters NUMERIC := 0;
  new_total INTEGER := 0;
  new_success INTEGER := 0;
  new_failed INTEGER := 0;
  new_cancelled INTEGER := 0;
  new_success_duration INTEGER := 0;
  new_failed_duration INTEGER := 0;
  new_cancelled_duration INTEGER := 0;
  new_wasted_duration INTEGER := 0;
  new_tracked_filament INTEGER := 0;
  new_filament_grams NUMERIC := 0;
  new_successful_filament_grams NUMERIC := 0;
  new_failed_filament_grams NUMERIC := 0;
  new_cancelled_filament_grams NUMERIC := 0;
  new_wasted_filament_grams NUMERIC := 0;
  new_filament_meters NUMERIC := 0;
  new_successful_filament_meters NUMERIC := 0;
  new_failed_filament_meters NUMERIC := 0;
  new_cancelled_filament_meters NUMERIC := 0;
  new_wasted_filament_meters NUMERIC := 0;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    old_total := CASE WHEN OLD."result" IN ('success', 'failed', 'cancelled') THEN 1 ELSE 0 END;
    old_success := CASE WHEN OLD."result" = 'success' THEN 1 ELSE 0 END;
    old_failed := CASE WHEN OLD."result" = 'failed' THEN 1 ELSE 0 END;
    old_cancelled := CASE WHEN OLD."result" = 'cancelled' THEN 1 ELSE 0 END;
    old_success_duration := CASE WHEN OLD."result" = 'success' THEN COALESCE(OLD."durationSeconds", 0) ELSE 0 END;
    old_failed_duration := CASE WHEN OLD."result" = 'failed' THEN COALESCE(OLD."durationSeconds", 0) ELSE 0 END;
    old_cancelled_duration := CASE WHEN OLD."result" = 'cancelled' THEN COALESCE(OLD."durationSeconds", 0) ELSE 0 END;
    old_wasted_duration := old_failed_duration + old_cancelled_duration;
    old_tracked_filament := CASE WHEN OLD."result" IN ('success', 'failed', 'cancelled') AND (OLD."filamentUsedGrams" IS NOT NULL OR OLD."filamentUsedMeters" IS NOT NULL) THEN 1 ELSE 0 END;
    old_filament_grams := CASE WHEN OLD."result" IN ('success', 'failed', 'cancelled') THEN COALESCE(OLD."filamentUsedGrams", 0) ELSE 0 END;
    old_successful_filament_grams := CASE WHEN OLD."result" = 'success' THEN COALESCE(OLD."filamentUsedGrams", 0) ELSE 0 END;
    old_failed_filament_grams := CASE WHEN OLD."result" = 'failed' THEN COALESCE(OLD."filamentUsedGrams", 0) ELSE 0 END;
    old_cancelled_filament_grams := CASE WHEN OLD."result" = 'cancelled' THEN COALESCE(OLD."filamentUsedGrams", 0) ELSE 0 END;
    old_wasted_filament_grams := old_failed_filament_grams + old_cancelled_filament_grams;
    old_filament_meters := CASE WHEN OLD."result" IN ('success', 'failed', 'cancelled') THEN COALESCE(OLD."filamentUsedMeters", 0) ELSE 0 END;
    old_successful_filament_meters := CASE WHEN OLD."result" = 'success' THEN COALESCE(OLD."filamentUsedMeters", 0) ELSE 0 END;
    old_failed_filament_meters := CASE WHEN OLD."result" = 'failed' THEN COALESCE(OLD."filamentUsedMeters", 0) ELSE 0 END;
    old_cancelled_filament_meters := CASE WHEN OLD."result" = 'cancelled' THEN COALESCE(OLD."filamentUsedMeters", 0) ELSE 0 END;
    old_wasted_filament_meters := old_failed_filament_meters + old_cancelled_filament_meters;
  END IF;

  IF TG_OP <> 'DELETE' THEN
    new_total := CASE WHEN NEW."result" IN ('success', 'failed', 'cancelled') THEN 1 ELSE 0 END;
    new_success := CASE WHEN NEW."result" = 'success' THEN 1 ELSE 0 END;
    new_failed := CASE WHEN NEW."result" = 'failed' THEN 1 ELSE 0 END;
    new_cancelled := CASE WHEN NEW."result" = 'cancelled' THEN 1 ELSE 0 END;
    new_success_duration := CASE WHEN NEW."result" = 'success' THEN COALESCE(NEW."durationSeconds", 0) ELSE 0 END;
    new_failed_duration := CASE WHEN NEW."result" = 'failed' THEN COALESCE(NEW."durationSeconds", 0) ELSE 0 END;
    new_cancelled_duration := CASE WHEN NEW."result" = 'cancelled' THEN COALESCE(NEW."durationSeconds", 0) ELSE 0 END;
    new_wasted_duration := new_failed_duration + new_cancelled_duration;
    new_tracked_filament := CASE WHEN NEW."result" IN ('success', 'failed', 'cancelled') AND (NEW."filamentUsedGrams" IS NOT NULL OR NEW."filamentUsedMeters" IS NOT NULL) THEN 1 ELSE 0 END;
    new_filament_grams := CASE WHEN NEW."result" IN ('success', 'failed', 'cancelled') THEN COALESCE(NEW."filamentUsedGrams", 0) ELSE 0 END;
    new_successful_filament_grams := CASE WHEN NEW."result" = 'success' THEN COALESCE(NEW."filamentUsedGrams", 0) ELSE 0 END;
    new_failed_filament_grams := CASE WHEN NEW."result" = 'failed' THEN COALESCE(NEW."filamentUsedGrams", 0) ELSE 0 END;
    new_cancelled_filament_grams := CASE WHEN NEW."result" = 'cancelled' THEN COALESCE(NEW."filamentUsedGrams", 0) ELSE 0 END;
    new_wasted_filament_grams := new_failed_filament_grams + new_cancelled_filament_grams;
    new_filament_meters := CASE WHEN NEW."result" IN ('success', 'failed', 'cancelled') THEN COALESCE(NEW."filamentUsedMeters", 0) ELSE 0 END;
    new_successful_filament_meters := CASE WHEN NEW."result" = 'success' THEN COALESCE(NEW."filamentUsedMeters", 0) ELSE 0 END;
    new_failed_filament_meters := CASE WHEN NEW."result" = 'failed' THEN COALESCE(NEW."filamentUsedMeters", 0) ELSE 0 END;
    new_cancelled_filament_meters := CASE WHEN NEW."result" = 'cancelled' THEN COALESCE(NEW."filamentUsedMeters", 0) ELSE 0 END;
    new_wasted_filament_meters := new_failed_filament_meters + new_cancelled_filament_meters;
  END IF;

  IF TG_OP = 'INSERT' THEN
    INSERT INTO "WorkspaceStats" (
      "workspaceId",
      "totalPrints",
      "successfulPrints",
      "failedPrints",
      "cancelledPrints",
      "successfulPrintDurationSeconds",
      "failedPrintDurationSeconds",
      "cancelledPrintDurationSeconds",
      "wastedPrintDurationSeconds",
      "trackedFilamentPrints",
      "filamentUsedGrams",
      "successfulFilamentUsedGrams",
      "failedFilamentUsedGrams",
      "cancelledFilamentUsedGrams",
      "wastedFilamentUsedGrams",
      "filamentUsedMeters",
      "successfulFilamentUsedMeters",
      "failedFilamentUsedMeters",
      "cancelledFilamentUsedMeters",
      "wastedFilamentUsedMeters",
      "updatedAt"
    )
    VALUES (
      NEW."workspaceId",
      new_total,
      new_success,
      new_failed,
      new_cancelled,
      new_success_duration,
      new_failed_duration,
      new_cancelled_duration,
      new_wasted_duration,
      new_tracked_filament,
      new_filament_grams,
      new_successful_filament_grams,
      new_failed_filament_grams,
      new_cancelled_filament_grams,
      new_wasted_filament_grams,
      new_filament_meters,
      new_successful_filament_meters,
      new_failed_filament_meters,
      new_cancelled_filament_meters,
      new_wasted_filament_meters,
      CURRENT_TIMESTAMP
    )
    ON CONFLICT ("workspaceId") DO UPDATE
    SET
      "totalPrints" = "WorkspaceStats"."totalPrints" + new_total,
      "successfulPrints" = "WorkspaceStats"."successfulPrints" + new_success,
      "failedPrints" = "WorkspaceStats"."failedPrints" + new_failed,
      "cancelledPrints" = "WorkspaceStats"."cancelledPrints" + new_cancelled,
      "successfulPrintDurationSeconds" = "WorkspaceStats"."successfulPrintDurationSeconds" + new_success_duration,
      "failedPrintDurationSeconds" = "WorkspaceStats"."failedPrintDurationSeconds" + new_failed_duration,
      "cancelledPrintDurationSeconds" = "WorkspaceStats"."cancelledPrintDurationSeconds" + new_cancelled_duration,
      "wastedPrintDurationSeconds" = "WorkspaceStats"."wastedPrintDurationSeconds" + new_wasted_duration,
      "trackedFilamentPrints" = "WorkspaceStats"."trackedFilamentPrints" + new_tracked_filament,
      "filamentUsedGrams" = "WorkspaceStats"."filamentUsedGrams" + new_filament_grams,
      "successfulFilamentUsedGrams" = "WorkspaceStats"."successfulFilamentUsedGrams" + new_successful_filament_grams,
      "failedFilamentUsedGrams" = "WorkspaceStats"."failedFilamentUsedGrams" + new_failed_filament_grams,
      "cancelledFilamentUsedGrams" = "WorkspaceStats"."cancelledFilamentUsedGrams" + new_cancelled_filament_grams,
      "wastedFilamentUsedGrams" = "WorkspaceStats"."wastedFilamentUsedGrams" + new_wasted_filament_grams,
      "filamentUsedMeters" = "WorkspaceStats"."filamentUsedMeters" + new_filament_meters,
      "successfulFilamentUsedMeters" = "WorkspaceStats"."successfulFilamentUsedMeters" + new_successful_filament_meters,
      "failedFilamentUsedMeters" = "WorkspaceStats"."failedFilamentUsedMeters" + new_failed_filament_meters,
      "cancelledFilamentUsedMeters" = "WorkspaceStats"."cancelledFilamentUsedMeters" + new_cancelled_filament_meters,
      "wastedFilamentUsedMeters" = "WorkspaceStats"."wastedFilamentUsedMeters" + new_wasted_filament_meters,
      "updatedAt" = CURRENT_TIMESTAMP;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  IF NEW."workspaceId" <> OLD."workspaceId" THEN
    UPDATE "WorkspaceStats"
    SET
      "totalPrints" = GREATEST(0, "totalPrints" - old_total),
      "successfulPrints" = GREATEST(0, "successfulPrints" - old_success),
      "failedPrints" = GREATEST(0, "failedPrints" - old_failed),
      "cancelledPrints" = GREATEST(0, "cancelledPrints" - old_cancelled),
      "successfulPrintDurationSeconds" = GREATEST(0, "successfulPrintDurationSeconds" - old_success_duration),
      "failedPrintDurationSeconds" = GREATEST(0, "failedPrintDurationSeconds" - old_failed_duration),
      "cancelledPrintDurationSeconds" = GREATEST(0, "cancelledPrintDurationSeconds" - old_cancelled_duration),
      "wastedPrintDurationSeconds" = GREATEST(0, "wastedPrintDurationSeconds" - old_wasted_duration),
      "trackedFilamentPrints" = GREATEST(0, "trackedFilamentPrints" - old_tracked_filament),
      "filamentUsedGrams" = GREATEST(0, "filamentUsedGrams" - old_filament_grams),
      "successfulFilamentUsedGrams" = GREATEST(0, "successfulFilamentUsedGrams" - old_successful_filament_grams),
      "failedFilamentUsedGrams" = GREATEST(0, "failedFilamentUsedGrams" - old_failed_filament_grams),
      "cancelledFilamentUsedGrams" = GREATEST(0, "cancelledFilamentUsedGrams" - old_cancelled_filament_grams),
      "wastedFilamentUsedGrams" = GREATEST(0, "wastedFilamentUsedGrams" - old_wasted_filament_grams),
      "filamentUsedMeters" = GREATEST(0, "filamentUsedMeters" - old_filament_meters),
      "successfulFilamentUsedMeters" = GREATEST(0, "successfulFilamentUsedMeters" - old_successful_filament_meters),
      "failedFilamentUsedMeters" = GREATEST(0, "failedFilamentUsedMeters" - old_failed_filament_meters),
      "cancelledFilamentUsedMeters" = GREATEST(0, "cancelledFilamentUsedMeters" - old_cancelled_filament_meters),
      "wastedFilamentUsedMeters" = GREATEST(0, "wastedFilamentUsedMeters" - old_wasted_filament_meters),
      "updatedAt" = CURRENT_TIMESTAMP
    WHERE "workspaceId" = OLD."workspaceId";

    INSERT INTO "WorkspaceStats" (
      "workspaceId",
      "totalPrints",
      "successfulPrints",
      "failedPrints",
      "cancelledPrints",
      "successfulPrintDurationSeconds",
      "failedPrintDurationSeconds",
      "cancelledPrintDurationSeconds",
      "wastedPrintDurationSeconds",
      "trackedFilamentPrints",
      "filamentUsedGrams",
      "successfulFilamentUsedGrams",
      "failedFilamentUsedGrams",
      "cancelledFilamentUsedGrams",
      "wastedFilamentUsedGrams",
      "filamentUsedMeters",
      "successfulFilamentUsedMeters",
      "failedFilamentUsedMeters",
      "cancelledFilamentUsedMeters",
      "wastedFilamentUsedMeters",
      "updatedAt"
    )
    VALUES (
      NEW."workspaceId",
      new_total,
      new_success,
      new_failed,
      new_cancelled,
      new_success_duration,
      new_failed_duration,
      new_cancelled_duration,
      new_wasted_duration,
      new_tracked_filament,
      new_filament_grams,
      new_successful_filament_grams,
      new_failed_filament_grams,
      new_cancelled_filament_grams,
      new_wasted_filament_grams,
      new_filament_meters,
      new_successful_filament_meters,
      new_failed_filament_meters,
      new_cancelled_filament_meters,
      new_wasted_filament_meters,
      CURRENT_TIMESTAMP
    )
    ON CONFLICT ("workspaceId") DO UPDATE
    SET
      "totalPrints" = "WorkspaceStats"."totalPrints" + new_total,
      "successfulPrints" = "WorkspaceStats"."successfulPrints" + new_success,
      "failedPrints" = "WorkspaceStats"."failedPrints" + new_failed,
      "cancelledPrints" = "WorkspaceStats"."cancelledPrints" + new_cancelled,
      "successfulPrintDurationSeconds" = "WorkspaceStats"."successfulPrintDurationSeconds" + new_success_duration,
      "failedPrintDurationSeconds" = "WorkspaceStats"."failedPrintDurationSeconds" + new_failed_duration,
      "cancelledPrintDurationSeconds" = "WorkspaceStats"."cancelledPrintDurationSeconds" + new_cancelled_duration,
      "wastedPrintDurationSeconds" = "WorkspaceStats"."wastedPrintDurationSeconds" + new_wasted_duration,
      "trackedFilamentPrints" = "WorkspaceStats"."trackedFilamentPrints" + new_tracked_filament,
      "filamentUsedGrams" = "WorkspaceStats"."filamentUsedGrams" + new_filament_grams,
      "successfulFilamentUsedGrams" = "WorkspaceStats"."successfulFilamentUsedGrams" + new_successful_filament_grams,
      "failedFilamentUsedGrams" = "WorkspaceStats"."failedFilamentUsedGrams" + new_failed_filament_grams,
      "cancelledFilamentUsedGrams" = "WorkspaceStats"."cancelledFilamentUsedGrams" + new_cancelled_filament_grams,
      "wastedFilamentUsedGrams" = "WorkspaceStats"."wastedFilamentUsedGrams" + new_wasted_filament_grams,
      "filamentUsedMeters" = "WorkspaceStats"."filamentUsedMeters" + new_filament_meters,
      "successfulFilamentUsedMeters" = "WorkspaceStats"."successfulFilamentUsedMeters" + new_successful_filament_meters,
      "failedFilamentUsedMeters" = "WorkspaceStats"."failedFilamentUsedMeters" + new_failed_filament_meters,
      "cancelledFilamentUsedMeters" = "WorkspaceStats"."cancelledFilamentUsedMeters" + new_cancelled_filament_meters,
      "wastedFilamentUsedMeters" = "WorkspaceStats"."wastedFilamentUsedMeters" + new_wasted_filament_meters,
      "updatedAt" = CURRENT_TIMESTAMP;
    RETURN NEW;
  END IF;

  UPDATE "WorkspaceStats"
  SET
    "totalPrints" = GREATEST(0, "totalPrints" + new_total - old_total),
    "successfulPrints" = GREATEST(0, "successfulPrints" + new_success - old_success),
    "failedPrints" = GREATEST(0, "failedPrints" + new_failed - old_failed),
    "cancelledPrints" = GREATEST(0, "cancelledPrints" + new_cancelled - old_cancelled),
    "successfulPrintDurationSeconds" = GREATEST(0, "successfulPrintDurationSeconds" + new_success_duration - old_success_duration),
    "failedPrintDurationSeconds" = GREATEST(0, "failedPrintDurationSeconds" + new_failed_duration - old_failed_duration),
    "cancelledPrintDurationSeconds" = GREATEST(0, "cancelledPrintDurationSeconds" + new_cancelled_duration - old_cancelled_duration),
    "wastedPrintDurationSeconds" = GREATEST(0, "wastedPrintDurationSeconds" + new_wasted_duration - old_wasted_duration),
    "trackedFilamentPrints" = GREATEST(0, "trackedFilamentPrints" + new_tracked_filament - old_tracked_filament),
    "filamentUsedGrams" = GREATEST(0, "filamentUsedGrams" + new_filament_grams - old_filament_grams),
    "successfulFilamentUsedGrams" = GREATEST(0, "successfulFilamentUsedGrams" + new_successful_filament_grams - old_successful_filament_grams),
    "failedFilamentUsedGrams" = GREATEST(0, "failedFilamentUsedGrams" + new_failed_filament_grams - old_failed_filament_grams),
    "cancelledFilamentUsedGrams" = GREATEST(0, "cancelledFilamentUsedGrams" + new_cancelled_filament_grams - old_cancelled_filament_grams),
    "wastedFilamentUsedGrams" = GREATEST(0, "wastedFilamentUsedGrams" + new_wasted_filament_grams - old_wasted_filament_grams),
    "filamentUsedMeters" = GREATEST(0, "filamentUsedMeters" + new_filament_meters - old_filament_meters),
    "successfulFilamentUsedMeters" = GREATEST(0, "successfulFilamentUsedMeters" + new_successful_filament_meters - old_successful_filament_meters),
    "failedFilamentUsedMeters" = GREATEST(0, "failedFilamentUsedMeters" + new_failed_filament_meters - old_failed_filament_meters),
    "cancelledFilamentUsedMeters" = GREATEST(0, "cancelledFilamentUsedMeters" + new_cancelled_filament_meters - old_cancelled_filament_meters),
    "wastedFilamentUsedMeters" = GREATEST(0, "wastedFilamentUsedMeters" + new_wasted_filament_meters - old_wasted_filament_meters),
    "updatedAt" = CURRENT_TIMESTAMP
  WHERE "workspaceId" = NEW."workspaceId";

  RETURN NEW;
END;
$function$
;

DROP TRIGGER IF EXISTS platform_print_stats_sync ON public."WorkspaceStats";
CREATE TRIGGER platform_print_stats_sync AFTER INSERT OR DELETE OR UPDATE ON public."WorkspaceStats" FOR EACH ROW EXECUTE FUNCTION sync_platform_stats_from_workspace_stats();
DROP TRIGGER IF EXISTS platform_workspace_counts_sync_on_membership ON public."AuthWorkspaceMembership";
CREATE TRIGGER platform_workspace_counts_sync_on_membership AFTER INSERT OR DELETE OR UPDATE ON public."AuthWorkspaceMembership" FOR EACH ROW EXECUTE FUNCTION refresh_platform_workspace_counts();
DROP TRIGGER IF EXISTS platform_workspace_counts_sync_on_printer ON public."Printer";
CREATE TRIGGER platform_workspace_counts_sync_on_printer AFTER INSERT OR DELETE ON public."Printer" FOR EACH ROW EXECUTE FUNCTION refresh_platform_workspace_counts();
DROP TRIGGER IF EXISTS platform_workspace_counts_sync_on_workspace ON public."Workspace";
CREATE TRIGGER platform_workspace_counts_sync_on_workspace AFTER INSERT OR DELETE ON public."Workspace" FOR EACH ROW EXECUTE FUNCTION refresh_platform_workspace_counts();
DROP TRIGGER IF EXISTS workspace_print_stats_sync ON public."PrintJob";
CREATE TRIGGER workspace_print_stats_sync AFTER INSERT OR UPDATE ON public."PrintJob" FOR EACH ROW EXECUTE FUNCTION sync_workspace_print_stats();
DROP TRIGGER IF EXISTS workspace_stats_row_insert ON public."Workspace";
CREATE TRIGGER workspace_stats_row_insert AFTER INSERT ON public."Workspace" FOR EACH ROW EXECUTE FUNCTION ensure_workspace_stats_row();

-- 5. Stats functions and triggers. Their BODIES name the tables, so a table
--    rename alone leaves them referring to something that no longer exists.
--    Recreated under new names, then the old ones dropped; the triggers go
--    first because a function cannot be dropped while one depends on it.
DROP TRIGGER IF EXISTS tenant_print_stats_sync ON "Workspace";
DROP TRIGGER IF EXISTS tenant_print_stats_sync ON "PrintJob";
DROP TRIGGER IF EXISTS tenant_stats_row_insert ON "Workspace";
DROP TRIGGER IF EXISTS platform_workspace_counts_sync_on_tenant ON "Workspace";

DROP FUNCTION IF EXISTS sync_tenant_print_stats() CASCADE;
DROP FUNCTION IF EXISTS ensure_tenant_stats_row() CASCADE;
DROP FUNCTION IF EXISTS sync_platform_stats_from_tenant_stats() CASCADE;

-- 6. The stats rollup columns need a database-level DEFAULT: the trigger
--    functions insert these rows without naming `updatedAt`. Databases
--    provisioned from the old datamodel-only snapshot never got one. Setting an
--    existing default again is a no-op, so this is safe on every database.
ALTER TABLE "WorkspaceStats" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "PlatformStats"  ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "PrinterStats"   ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;

-- 7. Persisted VALUES. Settings keys and permission strings spell the old word
--    inside their data; the code now reads the new spelling, so without this the
--    rows simply stop matching and every scoped setting silently reverts to its
--    default.
UPDATE "Setting" SET key = 'workspace:' || substring(key from 8) WHERE key LIKE 'tenant:%';
UPDATE "Setting" SET key = replace(key, ':tenant:', ':workspace:') WHERE key LIKE '%:tenant:%';
UPDATE "Setting" SET key = replace(key, '_tenantEnabled:', '_workspaceEnabled:') WHERE key LIKE '%_tenantEnabled:%';
UPDATE "Setting" SET key = replace(key, '_tenantAllowed:', '_workspaceAllowed:') WHERE key LIKE '%_tenantAllowed:%';
UPDATE "Setting" SET key = replace(key, 'platform:tenantDisabled', 'platform:workspaceDisabled') WHERE key LIKE '%platform:tenantDisabled%';
UPDATE "Setting" SET key = 'workspace.slicing.profiles.' || substring(key from 25) WHERE key LIKE 'tenant.slicing.profiles.%';

-- `permissions` is a string array, so the swap is per element.
UPDATE "AuthGroup"
SET permissions = array_replace(array_replace(permissions, 'tenants.manage', 'workspaces.manage'), 'tenants.disable', 'workspaces.disable')
WHERE permissions && ARRAY['tenants.manage', 'tenants.disable'];
