ALTER TABLE "TenantStats"
ADD COLUMN "successfulFilamentUsedGrams" DECIMAL(14, 3) NOT NULL DEFAULT 0,
ADD COLUMN "wastedFilamentUsedGrams" DECIMAL(14, 3) NOT NULL DEFAULT 0,
ADD COLUMN "successfulFilamentUsedMeters" DECIMAL(14, 3) NOT NULL DEFAULT 0,
ADD COLUMN "wastedFilamentUsedMeters" DECIMAL(14, 3) NOT NULL DEFAULT 0;

ALTER TABLE "PlatformStats"
ADD COLUMN "successfulFilamentUsedGrams" DECIMAL(14, 3) NOT NULL DEFAULT 0,
ADD COLUMN "wastedFilamentUsedGrams" DECIMAL(14, 3) NOT NULL DEFAULT 0,
ADD COLUMN "successfulFilamentUsedMeters" DECIMAL(14, 3) NOT NULL DEFAULT 0,
ADD COLUMN "wastedFilamentUsedMeters" DECIMAL(14, 3) NOT NULL DEFAULT 0;

ALTER TABLE "PrinterStats"
ADD COLUMN "successfulFilamentUsedGrams" DECIMAL(14, 3) NOT NULL DEFAULT 0,
ADD COLUMN "wastedFilamentUsedGrams" DECIMAL(14, 3) NOT NULL DEFAULT 0,
ADD COLUMN "successfulFilamentUsedMeters" DECIMAL(14, 3) NOT NULL DEFAULT 0,
ADD COLUMN "wastedFilamentUsedMeters" DECIMAL(14, 3) NOT NULL DEFAULT 0;

WITH tenant_filament_aggregated AS (
  SELECT
    tenant."id" AS "tenantId",
    COALESCE(SUM(job."filamentUsedGrams") FILTER (WHERE job."result" = 'success'), 0)::DECIMAL(14, 3) AS "successfulFilamentUsedGrams",
    COALESCE(SUM(job."filamentUsedGrams") FILTER (WHERE job."result" IN ('failed', 'cancelled')), 0)::DECIMAL(14, 3) AS "wastedFilamentUsedGrams",
    COALESCE(SUM(job."filamentUsedMeters") FILTER (WHERE job."result" = 'success'), 0)::DECIMAL(14, 3) AS "successfulFilamentUsedMeters",
    COALESCE(SUM(job."filamentUsedMeters") FILTER (WHERE job."result" IN ('failed', 'cancelled')), 0)::DECIMAL(14, 3) AS "wastedFilamentUsedMeters"
  FROM "Tenant" tenant
  LEFT JOIN "PrintJob" job ON job."tenantId" = tenant."id"
  GROUP BY tenant."id"
)
UPDATE "TenantStats" stats
SET
  "successfulFilamentUsedGrams" = tenant_filament_aggregated."successfulFilamentUsedGrams",
  "wastedFilamentUsedGrams" = tenant_filament_aggregated."wastedFilamentUsedGrams",
  "successfulFilamentUsedMeters" = tenant_filament_aggregated."successfulFilamentUsedMeters",
  "wastedFilamentUsedMeters" = tenant_filament_aggregated."wastedFilamentUsedMeters",
  "updatedAt" = CURRENT_TIMESTAMP
FROM tenant_filament_aggregated
WHERE stats."tenantId" = tenant_filament_aggregated."tenantId";

WITH printer_filament_aggregated AS (
  SELECT
    printer."tenantId" AS "tenantId",
    printer."serial" AS "printerSerial",
    COALESCE(SUM(job."filamentUsedGrams") FILTER (WHERE job."result" = 'success'), 0)::DECIMAL(14, 3) AS "successfulFilamentUsedGrams",
    COALESCE(SUM(job."filamentUsedGrams") FILTER (WHERE job."result" IN ('failed', 'cancelled')), 0)::DECIMAL(14, 3) AS "wastedFilamentUsedGrams",
    COALESCE(SUM(job."filamentUsedMeters") FILTER (WHERE job."result" = 'success'), 0)::DECIMAL(14, 3) AS "successfulFilamentUsedMeters",
    COALESCE(SUM(job."filamentUsedMeters") FILTER (WHERE job."result" IN ('failed', 'cancelled')), 0)::DECIMAL(14, 3) AS "wastedFilamentUsedMeters"
  FROM "Printer" printer
  LEFT JOIN "PrintJob" job ON job."printerId" = printer."id"
  GROUP BY printer."tenantId", printer."serial"
)
UPDATE "PrinterStats" stats
SET
  "successfulFilamentUsedGrams" = printer_filament_aggregated."successfulFilamentUsedGrams",
  "wastedFilamentUsedGrams" = printer_filament_aggregated."wastedFilamentUsedGrams",
  "successfulFilamentUsedMeters" = printer_filament_aggregated."successfulFilamentUsedMeters",
  "wastedFilamentUsedMeters" = printer_filament_aggregated."wastedFilamentUsedMeters",
  "updatedAt" = CURRENT_TIMESTAMP
FROM printer_filament_aggregated
WHERE stats."tenantId" = printer_filament_aggregated."tenantId"
  AND stats."printerSerial" = printer_filament_aggregated."printerSerial";

INSERT INTO "PlatformStats" (
  "id",
  "successfulFilamentUsedGrams",
  "wastedFilamentUsedGrams",
  "successfulFilamentUsedMeters",
  "wastedFilamentUsedMeters"
)
VALUES (
  'platform',
  COALESCE((SELECT SUM("successfulFilamentUsedGrams") FROM "TenantStats"), 0)::DECIMAL(14, 3),
  COALESCE((SELECT SUM("wastedFilamentUsedGrams") FROM "TenantStats"), 0)::DECIMAL(14, 3),
  COALESCE((SELECT SUM("successfulFilamentUsedMeters") FROM "TenantStats"), 0)::DECIMAL(14, 3),
  COALESCE((SELECT SUM("wastedFilamentUsedMeters") FROM "TenantStats"), 0)::DECIMAL(14, 3)
)
ON CONFLICT ("id") DO UPDATE
SET
  "successfulFilamentUsedGrams" = EXCLUDED."successfulFilamentUsedGrams",
  "wastedFilamentUsedGrams" = EXCLUDED."wastedFilamentUsedGrams",
  "successfulFilamentUsedMeters" = EXCLUDED."successfulFilamentUsedMeters",
  "wastedFilamentUsedMeters" = EXCLUDED."wastedFilamentUsedMeters",
  "updatedAt" = CURRENT_TIMESTAMP;

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
  old_successful_filament_grams NUMERIC := 0;
  old_wasted_filament_grams NUMERIC := 0;
  old_filament_meters NUMERIC := 0;
  old_successful_filament_meters NUMERIC := 0;
  old_wasted_filament_meters NUMERIC := 0;
  new_total INTEGER := 0;
  new_success INTEGER := 0;
  new_failed INTEGER := 0;
  new_cancelled INTEGER := 0;
  new_success_duration INTEGER := 0;
  new_wasted_duration INTEGER := 0;
  new_tracked_filament INTEGER := 0;
  new_filament_grams NUMERIC := 0;
  new_successful_filament_grams NUMERIC := 0;
  new_wasted_filament_grams NUMERIC := 0;
  new_filament_meters NUMERIC := 0;
  new_successful_filament_meters NUMERIC := 0;
  new_wasted_filament_meters NUMERIC := 0;
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
    old_successful_filament_grams := CASE WHEN OLD."result" = 'success' THEN COALESCE(OLD."filamentUsedGrams", 0) ELSE 0 END;
    old_wasted_filament_grams := CASE WHEN OLD."result" IN ('failed', 'cancelled') THEN COALESCE(OLD."filamentUsedGrams", 0) ELSE 0 END;
    old_filament_meters := CASE WHEN OLD."result" IN ('success', 'failed', 'cancelled') THEN COALESCE(OLD."filamentUsedMeters", 0) ELSE 0 END;
    old_successful_filament_meters := CASE WHEN OLD."result" = 'success' THEN COALESCE(OLD."filamentUsedMeters", 0) ELSE 0 END;
    old_wasted_filament_meters := CASE WHEN OLD."result" IN ('failed', 'cancelled') THEN COALESCE(OLD."filamentUsedMeters", 0) ELSE 0 END;
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
    new_successful_filament_grams := CASE WHEN NEW."result" = 'success' THEN COALESCE(NEW."filamentUsedGrams", 0) ELSE 0 END;
    new_wasted_filament_grams := CASE WHEN NEW."result" IN ('failed', 'cancelled') THEN COALESCE(NEW."filamentUsedGrams", 0) ELSE 0 END;
    new_filament_meters := CASE WHEN NEW."result" IN ('success', 'failed', 'cancelled') THEN COALESCE(NEW."filamentUsedMeters", 0) ELSE 0 END;
    new_successful_filament_meters := CASE WHEN NEW."result" = 'success' THEN COALESCE(NEW."filamentUsedMeters", 0) ELSE 0 END;
    new_wasted_filament_meters := CASE WHEN NEW."result" IN ('failed', 'cancelled') THEN COALESCE(NEW."filamentUsedMeters", 0) ELSE 0 END;
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
      "successfulFilamentUsedGrams",
      "wastedFilamentUsedGrams",
      "filamentUsedMeters",
      "successfulFilamentUsedMeters",
      "wastedFilamentUsedMeters",
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
      new_successful_filament_grams,
      new_wasted_filament_grams,
      new_filament_meters,
      new_successful_filament_meters,
      new_wasted_filament_meters,
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
      "successfulFilamentUsedGrams" = "TenantStats"."successfulFilamentUsedGrams" + new_successful_filament_grams,
      "wastedFilamentUsedGrams" = "TenantStats"."wastedFilamentUsedGrams" + new_wasted_filament_grams,
      "filamentUsedMeters" = "TenantStats"."filamentUsedMeters" + new_filament_meters,
      "successfulFilamentUsedMeters" = "TenantStats"."successfulFilamentUsedMeters" + new_successful_filament_meters,
      "wastedFilamentUsedMeters" = "TenantStats"."wastedFilamentUsedMeters" + new_wasted_filament_meters,
      "updatedAt" = CURRENT_TIMESTAMP;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
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
      "successfulFilamentUsedGrams" = GREATEST(0, "successfulFilamentUsedGrams" - old_successful_filament_grams),
      "wastedFilamentUsedGrams" = GREATEST(0, "wastedFilamentUsedGrams" - old_wasted_filament_grams),
      "filamentUsedMeters" = GREATEST(0, "filamentUsedMeters" - old_filament_meters),
      "successfulFilamentUsedMeters" = GREATEST(0, "successfulFilamentUsedMeters" - old_successful_filament_meters),
      "wastedFilamentUsedMeters" = GREATEST(0, "wastedFilamentUsedMeters" - old_wasted_filament_meters),
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
      "successfulFilamentUsedGrams",
      "wastedFilamentUsedGrams",
      "filamentUsedMeters",
      "successfulFilamentUsedMeters",
      "wastedFilamentUsedMeters",
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
      new_successful_filament_grams,
      new_wasted_filament_grams,
      new_filament_meters,
      new_successful_filament_meters,
      new_wasted_filament_meters,
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
      "successfulFilamentUsedGrams" = "TenantStats"."successfulFilamentUsedGrams" + new_successful_filament_grams,
      "wastedFilamentUsedGrams" = "TenantStats"."wastedFilamentUsedGrams" + new_wasted_filament_grams,
      "filamentUsedMeters" = "TenantStats"."filamentUsedMeters" + new_filament_meters,
      "successfulFilamentUsedMeters" = "TenantStats"."successfulFilamentUsedMeters" + new_successful_filament_meters,
      "wastedFilamentUsedMeters" = "TenantStats"."wastedFilamentUsedMeters" + new_wasted_filament_meters,
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
    "successfulFilamentUsedGrams" = GREATEST(0, "successfulFilamentUsedGrams" + new_successful_filament_grams - old_successful_filament_grams),
    "wastedFilamentUsedGrams" = GREATEST(0, "wastedFilamentUsedGrams" + new_wasted_filament_grams - old_wasted_filament_grams),
    "filamentUsedMeters" = GREATEST(0, "filamentUsedMeters" + new_filament_meters - old_filament_meters),
    "successfulFilamentUsedMeters" = GREATEST(0, "successfulFilamentUsedMeters" + new_successful_filament_meters - old_successful_filament_meters),
    "wastedFilamentUsedMeters" = GREATEST(0, "wastedFilamentUsedMeters" + new_wasted_filament_meters - old_wasted_filament_meters),
    "updatedAt" = CURRENT_TIMESTAMP
  WHERE "tenantId" = NEW."tenantId";

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION sync_platform_stats_from_tenant_stats()
RETURNS TRIGGER AS $$
DECLARE
  total_prints_delta INTEGER := 0;
  successful_duration_delta INTEGER := 0;
  wasted_duration_delta INTEGER := 0;
  tracked_filament_delta INTEGER := 0;
  filament_grams_delta NUMERIC := 0;
  successful_filament_grams_delta NUMERIC := 0;
  wasted_filament_grams_delta NUMERIC := 0;
  filament_meters_delta NUMERIC := 0;
  successful_filament_meters_delta NUMERIC := 0;
  wasted_filament_meters_delta NUMERIC := 0;
BEGIN
  PERFORM ensure_platform_stats_row();

  IF TG_OP = 'INSERT' THEN
    total_prints_delta := NEW."totalPrints";
    successful_duration_delta := NEW."successfulPrintDurationSeconds";
    wasted_duration_delta := NEW."wastedPrintDurationSeconds";
    tracked_filament_delta := NEW."trackedFilamentPrints";
    filament_grams_delta := COALESCE(NEW."filamentUsedGrams", 0);
    successful_filament_grams_delta := COALESCE(NEW."successfulFilamentUsedGrams", 0);
    wasted_filament_grams_delta := COALESCE(NEW."wastedFilamentUsedGrams", 0);
    filament_meters_delta := COALESCE(NEW."filamentUsedMeters", 0);
    successful_filament_meters_delta := COALESCE(NEW."successfulFilamentUsedMeters", 0);
    wasted_filament_meters_delta := COALESCE(NEW."wastedFilamentUsedMeters", 0);
  ELSIF TG_OP = 'DELETE' THEN
    total_prints_delta := -OLD."totalPrints";
    successful_duration_delta := -OLD."successfulPrintDurationSeconds";
    wasted_duration_delta := -OLD."wastedPrintDurationSeconds";
    tracked_filament_delta := -OLD."trackedFilamentPrints";
    filament_grams_delta := -COALESCE(OLD."filamentUsedGrams", 0);
    successful_filament_grams_delta := -COALESCE(OLD."successfulFilamentUsedGrams", 0);
    wasted_filament_grams_delta := -COALESCE(OLD."wastedFilamentUsedGrams", 0);
    filament_meters_delta := -COALESCE(OLD."filamentUsedMeters", 0);
    successful_filament_meters_delta := -COALESCE(OLD."successfulFilamentUsedMeters", 0);
    wasted_filament_meters_delta := -COALESCE(OLD."wastedFilamentUsedMeters", 0);
  ELSE
    total_prints_delta := NEW."totalPrints" - OLD."totalPrints";
    successful_duration_delta := NEW."successfulPrintDurationSeconds" - OLD."successfulPrintDurationSeconds";
    wasted_duration_delta := NEW."wastedPrintDurationSeconds" - OLD."wastedPrintDurationSeconds";
    tracked_filament_delta := NEW."trackedFilamentPrints" - OLD."trackedFilamentPrints";
    filament_grams_delta := COALESCE(NEW."filamentUsedGrams", 0) - COALESCE(OLD."filamentUsedGrams", 0);
    successful_filament_grams_delta := COALESCE(NEW."successfulFilamentUsedGrams", 0) - COALESCE(OLD."successfulFilamentUsedGrams", 0);
    wasted_filament_grams_delta := COALESCE(NEW."wastedFilamentUsedGrams", 0) - COALESCE(OLD."wastedFilamentUsedGrams", 0);
    filament_meters_delta := COALESCE(NEW."filamentUsedMeters", 0) - COALESCE(OLD."filamentUsedMeters", 0);
    successful_filament_meters_delta := COALESCE(NEW."successfulFilamentUsedMeters", 0) - COALESCE(OLD."successfulFilamentUsedMeters", 0);
    wasted_filament_meters_delta := COALESCE(NEW."wastedFilamentUsedMeters", 0) - COALESCE(OLD."wastedFilamentUsedMeters", 0);
  END IF;

  UPDATE "PlatformStats"
  SET
    "totalPrints" = GREATEST(0, "totalPrints" + total_prints_delta),
    "successfulPrintDurationSeconds" = GREATEST(0, "successfulPrintDurationSeconds" + successful_duration_delta),
    "wastedPrintDurationSeconds" = GREATEST(0, "wastedPrintDurationSeconds" + wasted_duration_delta),
    "trackedFilamentPrints" = GREATEST(0, "trackedFilamentPrints" + tracked_filament_delta),
    "filamentUsedGrams" = GREATEST(0, "filamentUsedGrams" + filament_grams_delta),
    "successfulFilamentUsedGrams" = GREATEST(0, "successfulFilamentUsedGrams" + successful_filament_grams_delta),
    "wastedFilamentUsedGrams" = GREATEST(0, "wastedFilamentUsedGrams" + wasted_filament_grams_delta),
    "filamentUsedMeters" = GREATEST(0, "filamentUsedMeters" + filament_meters_delta),
    "successfulFilamentUsedMeters" = GREATEST(0, "successfulFilamentUsedMeters" + successful_filament_meters_delta),
    "wastedFilamentUsedMeters" = GREATEST(0, "wastedFilamentUsedMeters" + wasted_filament_meters_delta),
    "updatedAt" = CURRENT_TIMESTAMP
  WHERE "id" = 'platform';

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;