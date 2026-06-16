ALTER TABLE "TenantStats"
ADD COLUMN "trackedFilamentPrints" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "PlatformStats" (
  "id" TEXT NOT NULL,
  "tenantCount" INTEGER NOT NULL DEFAULT 0,
  "userCount" INTEGER NOT NULL DEFAULT 0,
  "printerCount" INTEGER NOT NULL DEFAULT 0,
  "totalPrints" INTEGER NOT NULL DEFAULT 0,
  "successfulPrintDurationSeconds" INTEGER NOT NULL DEFAULT 0,
  "wastedPrintDurationSeconds" INTEGER NOT NULL DEFAULT 0,
  "trackedFilamentPrints" INTEGER NOT NULL DEFAULT 0,
  "filamentUsedGrams" DECIMAL(14, 3) NOT NULL DEFAULT 0,
  "filamentUsedMeters" DECIMAL(14, 3) NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "PlatformStats_pkey" PRIMARY KEY ("id")
);

WITH tenant_aggregated AS (
  SELECT
    tenant."id" AS "tenantId",
    COUNT(job."id") FILTER (WHERE job."result" IN ('success', 'failed', 'cancelled'))::INTEGER AS "totalPrints",
    COUNT(job."id") FILTER (WHERE job."result" = 'success')::INTEGER AS "successfulPrints",
    COUNT(job."id") FILTER (WHERE job."result" = 'failed')::INTEGER AS "failedPrints",
    COUNT(job."id") FILTER (WHERE job."result" = 'cancelled')::INTEGER AS "cancelledPrints",
    COALESCE(SUM(job."durationSeconds") FILTER (WHERE job."result" = 'success'), 0)::INTEGER AS "successfulPrintDurationSeconds",
    COALESCE(SUM(job."durationSeconds") FILTER (WHERE job."result" IN ('failed', 'cancelled')), 0)::INTEGER AS "wastedPrintDurationSeconds",
    COUNT(job."id") FILTER (
      WHERE job."result" IN ('success', 'failed', 'cancelled')
        AND (job."filamentUsedGrams" IS NOT NULL OR job."filamentUsedMeters" IS NOT NULL)
    )::INTEGER AS "trackedFilamentPrints",
    COALESCE(SUM(job."filamentUsedGrams") FILTER (WHERE job."result" IN ('success', 'failed', 'cancelled')), 0)::DECIMAL(14, 3) AS "filamentUsedGrams",
    COALESCE(SUM(job."filamentUsedMeters") FILTER (WHERE job."result" IN ('success', 'failed', 'cancelled')), 0)::DECIMAL(14, 3) AS "filamentUsedMeters"
  FROM "Tenant" tenant
  LEFT JOIN "PrintJob" job ON job."tenantId" = tenant."id"
  GROUP BY tenant."id"
)
UPDATE "TenantStats" stats
SET
  "totalPrints" = tenant_aggregated."totalPrints",
  "successfulPrints" = tenant_aggregated."successfulPrints",
  "failedPrints" = tenant_aggregated."failedPrints",
  "cancelledPrints" = tenant_aggregated."cancelledPrints",
  "successfulPrintDurationSeconds" = tenant_aggregated."successfulPrintDurationSeconds",
  "wastedPrintDurationSeconds" = tenant_aggregated."wastedPrintDurationSeconds",
  "trackedFilamentPrints" = tenant_aggregated."trackedFilamentPrints",
  "filamentUsedGrams" = tenant_aggregated."filamentUsedGrams",
  "filamentUsedMeters" = tenant_aggregated."filamentUsedMeters",
  "updatedAt" = CURRENT_TIMESTAMP
FROM tenant_aggregated
WHERE stats."tenantId" = tenant_aggregated."tenantId";

INSERT INTO "PlatformStats" (
  "id",
  "tenantCount",
  "userCount",
  "printerCount",
  "totalPrints",
  "successfulPrintDurationSeconds",
  "wastedPrintDurationSeconds",
  "trackedFilamentPrints",
  "filamentUsedGrams",
  "filamentUsedMeters"
)
VALUES (
  'platform',
  (SELECT COUNT(*)::INTEGER FROM "Tenant"),
  (SELECT COUNT(DISTINCT "userId")::INTEGER FROM "AuthTenantMembership"),
  (SELECT COUNT(*)::INTEGER FROM "Printer"),
  COALESCE((SELECT SUM("totalPrints")::INTEGER FROM "TenantStats"), 0),
  COALESCE((SELECT SUM("successfulPrintDurationSeconds")::INTEGER FROM "TenantStats"), 0),
  COALESCE((SELECT SUM("wastedPrintDurationSeconds")::INTEGER FROM "TenantStats"), 0),
  COALESCE((SELECT SUM("trackedFilamentPrints")::INTEGER FROM "TenantStats"), 0),
  COALESCE((SELECT SUM("filamentUsedGrams") FROM "TenantStats"), 0)::DECIMAL(14, 3),
  COALESCE((SELECT SUM("filamentUsedMeters") FROM "TenantStats"), 0)::DECIMAL(14, 3)
)
ON CONFLICT ("id") DO UPDATE
SET
  "tenantCount" = EXCLUDED."tenantCount",
  "userCount" = EXCLUDED."userCount",
  "printerCount" = EXCLUDED."printerCount",
  "totalPrints" = EXCLUDED."totalPrints",
  "successfulPrintDurationSeconds" = EXCLUDED."successfulPrintDurationSeconds",
  "wastedPrintDurationSeconds" = EXCLUDED."wastedPrintDurationSeconds",
  "trackedFilamentPrints" = EXCLUDED."trackedFilamentPrints",
  "filamentUsedGrams" = EXCLUDED."filamentUsedGrams",
  "filamentUsedMeters" = EXCLUDED."filamentUsedMeters",
  "updatedAt" = CURRENT_TIMESTAMP;

CREATE OR REPLACE FUNCTION ensure_platform_stats_row()
RETURNS VOID AS $$
BEGIN
  INSERT INTO "PlatformStats" ("id") VALUES ('platform')
  ON CONFLICT ("id") DO NOTHING;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION refresh_platform_workspace_counts()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM ensure_platform_stats_row();

  UPDATE "PlatformStats"
  SET
    "tenantCount" = (SELECT COUNT(*)::INTEGER FROM "Tenant"),
    "userCount" = (SELECT COUNT(DISTINCT "userId")::INTEGER FROM "AuthTenantMembership"),
    "printerCount" = (SELECT COUNT(*)::INTEGER FROM "Printer"),
    "updatedAt" = CURRENT_TIMESTAMP
  WHERE "id" = 'platform';

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER platform_workspace_counts_sync_on_tenant
AFTER INSERT OR DELETE ON "Tenant"
FOR EACH ROW
EXECUTE FUNCTION refresh_platform_workspace_counts();

CREATE TRIGGER platform_workspace_counts_sync_on_membership
AFTER INSERT OR UPDATE OR DELETE ON "AuthTenantMembership"
FOR EACH ROW
EXECUTE FUNCTION refresh_platform_workspace_counts();

CREATE TRIGGER platform_workspace_counts_sync_on_printer
AFTER INSERT OR DELETE ON "Printer"
FOR EACH ROW
EXECUTE FUNCTION refresh_platform_workspace_counts();

CREATE OR REPLACE FUNCTION sync_tenant_print_stats()
RETURNS TRIGGER AS $$
DECLARE
  old_total INTEGER := 0;
  old_success INTEGER := 0;
  old_failed INTEGER := 0;
  old_cancelled INTEGER := 0;
  old_success_duration INTEGER := 0;
  old_wasted_duration INTEGER := 0;
  old_tracked_filament INTEGER := 0;
  old_filament_grams NUMERIC := 0;
  old_filament_meters NUMERIC := 0;
  new_total INTEGER := 0;
  new_success INTEGER := 0;
  new_failed INTEGER := 0;
  new_cancelled INTEGER := 0;
  new_success_duration INTEGER := 0;
  new_wasted_duration INTEGER := 0;
  new_tracked_filament INTEGER := 0;
  new_filament_grams NUMERIC := 0;
  new_filament_meters NUMERIC := 0;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    old_total := CASE WHEN OLD."result" IN ('success', 'failed', 'cancelled') THEN 1 ELSE 0 END;
    old_success := CASE WHEN OLD."result" = 'success' THEN 1 ELSE 0 END;
    old_failed := CASE WHEN OLD."result" = 'failed' THEN 1 ELSE 0 END;
    old_cancelled := CASE WHEN OLD."result" = 'cancelled' THEN 1 ELSE 0 END;
    old_success_duration := CASE WHEN OLD."result" = 'success' THEN COALESCE(OLD."durationSeconds", 0) ELSE 0 END;
    old_wasted_duration := CASE WHEN OLD."result" IN ('failed', 'cancelled') THEN COALESCE(OLD."durationSeconds", 0) ELSE 0 END;
    old_tracked_filament := CASE WHEN OLD."result" IN ('success', 'failed', 'cancelled') AND (OLD."filamentUsedGrams" IS NOT NULL OR OLD."filamentUsedMeters" IS NOT NULL) THEN 1 ELSE 0 END;
    old_filament_grams := CASE WHEN OLD."result" IN ('success', 'failed', 'cancelled') THEN COALESCE(OLD."filamentUsedGrams", 0) ELSE 0 END;
    old_filament_meters := CASE WHEN OLD."result" IN ('success', 'failed', 'cancelled') THEN COALESCE(OLD."filamentUsedMeters", 0) ELSE 0 END;
  END IF;

  IF TG_OP <> 'DELETE' THEN
    new_total := CASE WHEN NEW."result" IN ('success', 'failed', 'cancelled') THEN 1 ELSE 0 END;
    new_success := CASE WHEN NEW."result" = 'success' THEN 1 ELSE 0 END;
    new_failed := CASE WHEN NEW."result" = 'failed' THEN 1 ELSE 0 END;
    new_cancelled := CASE WHEN NEW."result" = 'cancelled' THEN 1 ELSE 0 END;
    new_success_duration := CASE WHEN NEW."result" = 'success' THEN COALESCE(NEW."durationSeconds", 0) ELSE 0 END;
    new_wasted_duration := CASE WHEN NEW."result" IN ('failed', 'cancelled') THEN COALESCE(NEW."durationSeconds", 0) ELSE 0 END;
    new_tracked_filament := CASE WHEN NEW."result" IN ('success', 'failed', 'cancelled') AND (NEW."filamentUsedGrams" IS NOT NULL OR NEW."filamentUsedMeters" IS NOT NULL) THEN 1 ELSE 0 END;
    new_filament_grams := CASE WHEN NEW."result" IN ('success', 'failed', 'cancelled') THEN COALESCE(NEW."filamentUsedGrams", 0) ELSE 0 END;
    new_filament_meters := CASE WHEN NEW."result" IN ('success', 'failed', 'cancelled') THEN COALESCE(NEW."filamentUsedMeters", 0) ELSE 0 END;
  END IF;

  IF TG_OP = 'INSERT' THEN
    INSERT INTO "TenantStats" (
      "tenantId",
      "totalPrints",
      "successfulPrints",
      "failedPrints",
      "cancelledPrints",
      "successfulPrintDurationSeconds",
      "wastedPrintDurationSeconds",
      "trackedFilamentPrints",
      "filamentUsedGrams",
      "filamentUsedMeters",
      "updatedAt"
    )
    VALUES (
      NEW."tenantId",
      new_total,
      new_success,
      new_failed,
      new_cancelled,
      new_success_duration,
      new_wasted_duration,
      new_tracked_filament,
      new_filament_grams,
      new_filament_meters,
      CURRENT_TIMESTAMP
    )
    ON CONFLICT ("tenantId") DO UPDATE
    SET
      "totalPrints" = "TenantStats"."totalPrints" + new_total,
      "successfulPrints" = "TenantStats"."successfulPrints" + new_success,
      "failedPrints" = "TenantStats"."failedPrints" + new_failed,
      "cancelledPrints" = "TenantStats"."cancelledPrints" + new_cancelled,
      "successfulPrintDurationSeconds" = "TenantStats"."successfulPrintDurationSeconds" + new_success_duration,
      "wastedPrintDurationSeconds" = "TenantStats"."wastedPrintDurationSeconds" + new_wasted_duration,
      "trackedFilamentPrints" = "TenantStats"."trackedFilamentPrints" + new_tracked_filament,
      "filamentUsedGrams" = "TenantStats"."filamentUsedGrams" + new_filament_grams,
      "filamentUsedMeters" = "TenantStats"."filamentUsedMeters" + new_filament_meters,
      "updatedAt" = CURRENT_TIMESTAMP;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    -- Lifetime print stats are append-on-finish. Historical PrintJob rows can
    -- be deleted by user cleanup or printer removal cascades, but those deletes
    -- must not erase already-recorded production totals.
    RETURN OLD;
  END IF;

  IF NEW."tenantId" <> OLD."tenantId" THEN
    UPDATE "TenantStats"
    SET
      "totalPrints" = GREATEST(0, "totalPrints" - old_total),
      "successfulPrints" = GREATEST(0, "successfulPrints" - old_success),
      "failedPrints" = GREATEST(0, "failedPrints" - old_failed),
      "cancelledPrints" = GREATEST(0, "cancelledPrints" - old_cancelled),
      "successfulPrintDurationSeconds" = GREATEST(0, "successfulPrintDurationSeconds" - old_success_duration),
      "wastedPrintDurationSeconds" = GREATEST(0, "wastedPrintDurationSeconds" - old_wasted_duration),
      "trackedFilamentPrints" = GREATEST(0, "trackedFilamentPrints" - old_tracked_filament),
      "filamentUsedGrams" = GREATEST(0, "filamentUsedGrams" - old_filament_grams),
      "filamentUsedMeters" = GREATEST(0, "filamentUsedMeters" - old_filament_meters),
      "updatedAt" = CURRENT_TIMESTAMP
    WHERE "tenantId" = OLD."tenantId";

    INSERT INTO "TenantStats" (
      "tenantId",
      "totalPrints",
      "successfulPrints",
      "failedPrints",
      "cancelledPrints",
      "successfulPrintDurationSeconds",
      "wastedPrintDurationSeconds",
      "trackedFilamentPrints",
      "filamentUsedGrams",
      "filamentUsedMeters",
      "updatedAt"
    )
    VALUES (
      NEW."tenantId",
      new_total,
      new_success,
      new_failed,
      new_cancelled,
      new_success_duration,
      new_wasted_duration,
      new_tracked_filament,
      new_filament_grams,
      new_filament_meters,
      CURRENT_TIMESTAMP
    )
    ON CONFLICT ("tenantId") DO UPDATE
    SET
      "totalPrints" = "TenantStats"."totalPrints" + new_total,
      "successfulPrints" = "TenantStats"."successfulPrints" + new_success,
      "failedPrints" = "TenantStats"."failedPrints" + new_failed,
      "cancelledPrints" = "TenantStats"."cancelledPrints" + new_cancelled,
      "successfulPrintDurationSeconds" = "TenantStats"."successfulPrintDurationSeconds" + new_success_duration,
      "wastedPrintDurationSeconds" = "TenantStats"."wastedPrintDurationSeconds" + new_wasted_duration,
      "trackedFilamentPrints" = "TenantStats"."trackedFilamentPrints" + new_tracked_filament,
      "filamentUsedGrams" = "TenantStats"."filamentUsedGrams" + new_filament_grams,
      "filamentUsedMeters" = "TenantStats"."filamentUsedMeters" + new_filament_meters,
      "updatedAt" = CURRENT_TIMESTAMP;
    RETURN NEW;
  END IF;

  UPDATE "TenantStats"
  SET
    "totalPrints" = GREATEST(0, "totalPrints" + new_total - old_total),
    "successfulPrints" = GREATEST(0, "successfulPrints" + new_success - old_success),
    "failedPrints" = GREATEST(0, "failedPrints" + new_failed - old_failed),
    "cancelledPrints" = GREATEST(0, "cancelledPrints" + new_cancelled - old_cancelled),
    "successfulPrintDurationSeconds" = GREATEST(0, "successfulPrintDurationSeconds" + new_success_duration - old_success_duration),
    "wastedPrintDurationSeconds" = GREATEST(0, "wastedPrintDurationSeconds" + new_wasted_duration - old_wasted_duration),
    "trackedFilamentPrints" = GREATEST(0, "trackedFilamentPrints" + new_tracked_filament - old_tracked_filament),
    "filamentUsedGrams" = GREATEST(0, "filamentUsedGrams" + new_filament_grams - old_filament_grams),
    "filamentUsedMeters" = GREATEST(0, "filamentUsedMeters" + new_filament_meters - old_filament_meters),
    "updatedAt" = CURRENT_TIMESTAMP
  WHERE "tenantId" = NEW."tenantId";

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tenant_print_stats_sync ON "PrintJob";

CREATE TRIGGER tenant_print_stats_sync
AFTER INSERT OR UPDATE ON "PrintJob"
FOR EACH ROW
EXECUTE FUNCTION sync_tenant_print_stats();

CREATE OR REPLACE FUNCTION sync_platform_stats_from_tenant_stats()
RETURNS TRIGGER AS $$
DECLARE
  total_prints_delta INTEGER := 0;
  successful_duration_delta INTEGER := 0;
  wasted_duration_delta INTEGER := 0;
  tracked_filament_delta INTEGER := 0;
  filament_grams_delta NUMERIC := 0;
  filament_meters_delta NUMERIC := 0;
BEGIN
  PERFORM ensure_platform_stats_row();

  IF TG_OP = 'INSERT' THEN
    total_prints_delta := NEW."totalPrints";
    successful_duration_delta := NEW."successfulPrintDurationSeconds";
    wasted_duration_delta := NEW."wastedPrintDurationSeconds";
    tracked_filament_delta := NEW."trackedFilamentPrints";
    filament_grams_delta := COALESCE(NEW."filamentUsedGrams", 0);
    filament_meters_delta := COALESCE(NEW."filamentUsedMeters", 0);
  ELSIF TG_OP = 'DELETE' THEN
    total_prints_delta := -OLD."totalPrints";
    successful_duration_delta := -OLD."successfulPrintDurationSeconds";
    wasted_duration_delta := -OLD."wastedPrintDurationSeconds";
    tracked_filament_delta := -OLD."trackedFilamentPrints";
    filament_grams_delta := -COALESCE(OLD."filamentUsedGrams", 0);
    filament_meters_delta := -COALESCE(OLD."filamentUsedMeters", 0);
  ELSE
    total_prints_delta := NEW."totalPrints" - OLD."totalPrints";
    successful_duration_delta := NEW."successfulPrintDurationSeconds" - OLD."successfulPrintDurationSeconds";
    wasted_duration_delta := NEW."wastedPrintDurationSeconds" - OLD."wastedPrintDurationSeconds";
    tracked_filament_delta := NEW."trackedFilamentPrints" - OLD."trackedFilamentPrints";
    filament_grams_delta := COALESCE(NEW."filamentUsedGrams", 0) - COALESCE(OLD."filamentUsedGrams", 0);
    filament_meters_delta := COALESCE(NEW."filamentUsedMeters", 0) - COALESCE(OLD."filamentUsedMeters", 0);
  END IF;

  UPDATE "PlatformStats"
  SET
    "totalPrints" = GREATEST(0, "totalPrints" + total_prints_delta),
    "successfulPrintDurationSeconds" = GREATEST(0, "successfulPrintDurationSeconds" + successful_duration_delta),
    "wastedPrintDurationSeconds" = GREATEST(0, "wastedPrintDurationSeconds" + wasted_duration_delta),
    "trackedFilamentPrints" = GREATEST(0, "trackedFilamentPrints" + tracked_filament_delta),
    "filamentUsedGrams" = GREATEST(0, "filamentUsedGrams" + filament_grams_delta),
    "filamentUsedMeters" = GREATEST(0, "filamentUsedMeters" + filament_meters_delta),
    "updatedAt" = CURRENT_TIMESTAMP
  WHERE "id" = 'platform';

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER platform_print_stats_sync
AFTER INSERT OR UPDATE OR DELETE ON "TenantStats"
FOR EACH ROW
EXECUTE FUNCTION sync_platform_stats_from_tenant_stats();