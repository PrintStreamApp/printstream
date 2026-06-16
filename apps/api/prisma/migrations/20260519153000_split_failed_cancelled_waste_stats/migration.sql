ALTER TABLE "TenantStats"
ADD COLUMN "failedPrintDurationSeconds" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "cancelledPrintDurationSeconds" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "failedFilamentUsedGrams" DECIMAL(14, 3) NOT NULL DEFAULT 0,
ADD COLUMN "cancelledFilamentUsedGrams" DECIMAL(14, 3) NOT NULL DEFAULT 0,
ADD COLUMN "failedFilamentUsedMeters" DECIMAL(14, 3) NOT NULL DEFAULT 0,
ADD COLUMN "cancelledFilamentUsedMeters" DECIMAL(14, 3) NOT NULL DEFAULT 0;

ALTER TABLE "PlatformStats"
ADD COLUMN "failedPrintDurationSeconds" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "cancelledPrintDurationSeconds" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "failedFilamentUsedGrams" DECIMAL(14, 3) NOT NULL DEFAULT 0,
ADD COLUMN "cancelledFilamentUsedGrams" DECIMAL(14, 3) NOT NULL DEFAULT 0,
ADD COLUMN "failedFilamentUsedMeters" DECIMAL(14, 3) NOT NULL DEFAULT 0,
ADD COLUMN "cancelledFilamentUsedMeters" DECIMAL(14, 3) NOT NULL DEFAULT 0;

ALTER TABLE "PrinterStats"
ADD COLUMN "failedPrintDurationSeconds" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "cancelledPrintDurationSeconds" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "failedFilamentUsedGrams" DECIMAL(14, 3) NOT NULL DEFAULT 0,
ADD COLUMN "cancelledFilamentUsedGrams" DECIMAL(14, 3) NOT NULL DEFAULT 0,
ADD COLUMN "failedFilamentUsedMeters" DECIMAL(14, 3) NOT NULL DEFAULT 0,
ADD COLUMN "cancelledFilamentUsedMeters" DECIMAL(14, 3) NOT NULL DEFAULT 0;

WITH tenant_breakdown AS (
  SELECT
    tenant."id" AS "tenantId",
    COALESCE(SUM(job."durationSeconds") FILTER (WHERE job."result" = 'failed'), 0) AS "failedPrintDurationSeconds",
    COALESCE(SUM(job."durationSeconds") FILTER (WHERE job."result" = 'cancelled'), 0) AS "cancelledPrintDurationSeconds",
    COALESCE(SUM(job."filamentUsedGrams") FILTER (WHERE job."result" = 'failed'), 0)::DECIMAL(14, 3) AS "failedFilamentUsedGrams",
    COALESCE(SUM(job."filamentUsedGrams") FILTER (WHERE job."result" = 'cancelled'), 0)::DECIMAL(14, 3) AS "cancelledFilamentUsedGrams",
    COALESCE(SUM(job."filamentUsedMeters") FILTER (WHERE job."result" = 'failed'), 0)::DECIMAL(14, 3) AS "failedFilamentUsedMeters",
    COALESCE(SUM(job."filamentUsedMeters") FILTER (WHERE job."result" = 'cancelled'), 0)::DECIMAL(14, 3) AS "cancelledFilamentUsedMeters"
  FROM "Tenant" tenant
  LEFT JOIN "PrintJob" job ON job."tenantId" = tenant."id"
  GROUP BY tenant."id"
)
UPDATE "TenantStats" stats
SET
  "failedPrintDurationSeconds" = tenant_breakdown."failedPrintDurationSeconds",
  "cancelledPrintDurationSeconds" = tenant_breakdown."cancelledPrintDurationSeconds",
  "wastedPrintDurationSeconds" = tenant_breakdown."failedPrintDurationSeconds" + tenant_breakdown."cancelledPrintDurationSeconds",
  "failedFilamentUsedGrams" = tenant_breakdown."failedFilamentUsedGrams",
  "cancelledFilamentUsedGrams" = tenant_breakdown."cancelledFilamentUsedGrams",
  "wastedFilamentUsedGrams" = tenant_breakdown."failedFilamentUsedGrams" + tenant_breakdown."cancelledFilamentUsedGrams",
  "failedFilamentUsedMeters" = tenant_breakdown."failedFilamentUsedMeters",
  "cancelledFilamentUsedMeters" = tenant_breakdown."cancelledFilamentUsedMeters",
  "wastedFilamentUsedMeters" = tenant_breakdown."failedFilamentUsedMeters" + tenant_breakdown."cancelledFilamentUsedMeters",
  "updatedAt" = CURRENT_TIMESTAMP
FROM tenant_breakdown
WHERE stats."tenantId" = tenant_breakdown."tenantId";

WITH printer_breakdown AS (
  SELECT
    printer."tenantId" AS "tenantId",
    printer."serial" AS "printerSerial",
    COALESCE(SUM(job."durationSeconds") FILTER (WHERE job."result" = 'failed'), 0) AS "failedPrintDurationSeconds",
    COALESCE(SUM(job."durationSeconds") FILTER (WHERE job."result" = 'cancelled'), 0) AS "cancelledPrintDurationSeconds",
    COALESCE(SUM(job."filamentUsedGrams") FILTER (WHERE job."result" = 'failed'), 0)::DECIMAL(14, 3) AS "failedFilamentUsedGrams",
    COALESCE(SUM(job."filamentUsedGrams") FILTER (WHERE job."result" = 'cancelled'), 0)::DECIMAL(14, 3) AS "cancelledFilamentUsedGrams",
    COALESCE(SUM(job."filamentUsedMeters") FILTER (WHERE job."result" = 'failed'), 0)::DECIMAL(14, 3) AS "failedFilamentUsedMeters",
    COALESCE(SUM(job."filamentUsedMeters") FILTER (WHERE job."result" = 'cancelled'), 0)::DECIMAL(14, 3) AS "cancelledFilamentUsedMeters"
  FROM "Printer" printer
  LEFT JOIN "PrintJob" job ON job."printerId" = printer."id"
  GROUP BY printer."tenantId", printer."serial"
)
UPDATE "PrinterStats" stats
SET
  "failedPrintDurationSeconds" = printer_breakdown."failedPrintDurationSeconds",
  "cancelledPrintDurationSeconds" = printer_breakdown."cancelledPrintDurationSeconds",
  "wastedPrintDurationSeconds" = printer_breakdown."failedPrintDurationSeconds" + printer_breakdown."cancelledPrintDurationSeconds",
  "failedFilamentUsedGrams" = printer_breakdown."failedFilamentUsedGrams",
  "cancelledFilamentUsedGrams" = printer_breakdown."cancelledFilamentUsedGrams",
  "wastedFilamentUsedGrams" = printer_breakdown."failedFilamentUsedGrams" + printer_breakdown."cancelledFilamentUsedGrams",
  "failedFilamentUsedMeters" = printer_breakdown."failedFilamentUsedMeters",
  "cancelledFilamentUsedMeters" = printer_breakdown."cancelledFilamentUsedMeters",
  "wastedFilamentUsedMeters" = printer_breakdown."failedFilamentUsedMeters" + printer_breakdown."cancelledFilamentUsedMeters",
  "updatedAt" = CURRENT_TIMESTAMP
FROM printer_breakdown
WHERE stats."tenantId" = printer_breakdown."tenantId"
  AND stats."printerSerial" = printer_breakdown."printerSerial";

INSERT INTO "PlatformStats" (
  "id",
  "failedPrintDurationSeconds",
  "cancelledPrintDurationSeconds",
  "wastedPrintDurationSeconds",
  "failedFilamentUsedGrams",
  "cancelledFilamentUsedGrams",
  "wastedFilamentUsedGrams",
  "failedFilamentUsedMeters",
  "cancelledFilamentUsedMeters",
  "wastedFilamentUsedMeters"
)
VALUES (
  'platform',
  COALESCE((SELECT SUM("failedPrintDurationSeconds") FROM "TenantStats"), 0),
  COALESCE((SELECT SUM("cancelledPrintDurationSeconds") FROM "TenantStats"), 0),
  COALESCE((SELECT SUM("wastedPrintDurationSeconds") FROM "TenantStats"), 0),
  COALESCE((SELECT SUM("failedFilamentUsedGrams") FROM "TenantStats"), 0)::DECIMAL(14, 3),
  COALESCE((SELECT SUM("cancelledFilamentUsedGrams") FROM "TenantStats"), 0)::DECIMAL(14, 3),
  COALESCE((SELECT SUM("wastedFilamentUsedGrams") FROM "TenantStats"), 0)::DECIMAL(14, 3),
  COALESCE((SELECT SUM("failedFilamentUsedMeters") FROM "TenantStats"), 0)::DECIMAL(14, 3),
  COALESCE((SELECT SUM("cancelledFilamentUsedMeters") FROM "TenantStats"), 0)::DECIMAL(14, 3),
  COALESCE((SELECT SUM("wastedFilamentUsedMeters") FROM "TenantStats"), 0)::DECIMAL(14, 3)
)
ON CONFLICT ("id") DO UPDATE
SET
  "failedPrintDurationSeconds" = EXCLUDED."failedPrintDurationSeconds",
  "cancelledPrintDurationSeconds" = EXCLUDED."cancelledPrintDurationSeconds",
  "wastedPrintDurationSeconds" = EXCLUDED."wastedPrintDurationSeconds",
  "failedFilamentUsedGrams" = EXCLUDED."failedFilamentUsedGrams",
  "cancelledFilamentUsedGrams" = EXCLUDED."cancelledFilamentUsedGrams",
  "wastedFilamentUsedGrams" = EXCLUDED."wastedFilamentUsedGrams",
  "failedFilamentUsedMeters" = EXCLUDED."failedFilamentUsedMeters",
  "cancelledFilamentUsedMeters" = EXCLUDED."cancelledFilamentUsedMeters",
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
    INSERT INTO "TenantStats" (
      "tenantId",
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
      NEW."tenantId",
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
    ON CONFLICT ("tenantId") DO UPDATE
    SET
      "totalPrints" = "TenantStats"."totalPrints" + new_total,
      "successfulPrints" = "TenantStats"."successfulPrints" + new_success,
      "failedPrints" = "TenantStats"."failedPrints" + new_failed,
      "cancelledPrints" = "TenantStats"."cancelledPrints" + new_cancelled,
      "successfulPrintDurationSeconds" = "TenantStats"."successfulPrintDurationSeconds" + new_success_duration,
      "failedPrintDurationSeconds" = "TenantStats"."failedPrintDurationSeconds" + new_failed_duration,
      "cancelledPrintDurationSeconds" = "TenantStats"."cancelledPrintDurationSeconds" + new_cancelled_duration,
      "wastedPrintDurationSeconds" = "TenantStats"."wastedPrintDurationSeconds" + new_wasted_duration,
      "trackedFilamentPrints" = "TenantStats"."trackedFilamentPrints" + new_tracked_filament,
      "filamentUsedGrams" = "TenantStats"."filamentUsedGrams" + new_filament_grams,
      "successfulFilamentUsedGrams" = "TenantStats"."successfulFilamentUsedGrams" + new_successful_filament_grams,
      "failedFilamentUsedGrams" = "TenantStats"."failedFilamentUsedGrams" + new_failed_filament_grams,
      "cancelledFilamentUsedGrams" = "TenantStats"."cancelledFilamentUsedGrams" + new_cancelled_filament_grams,
      "wastedFilamentUsedGrams" = "TenantStats"."wastedFilamentUsedGrams" + new_wasted_filament_grams,
      "filamentUsedMeters" = "TenantStats"."filamentUsedMeters" + new_filament_meters,
      "successfulFilamentUsedMeters" = "TenantStats"."successfulFilamentUsedMeters" + new_successful_filament_meters,
      "failedFilamentUsedMeters" = "TenantStats"."failedFilamentUsedMeters" + new_failed_filament_meters,
      "cancelledFilamentUsedMeters" = "TenantStats"."cancelledFilamentUsedMeters" + new_cancelled_filament_meters,
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
    WHERE "tenantId" = OLD."tenantId";

    INSERT INTO "TenantStats" (
      "tenantId",
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
      NEW."tenantId",
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
    ON CONFLICT ("tenantId") DO UPDATE
    SET
      "totalPrints" = "TenantStats"."totalPrints" + new_total,
      "successfulPrints" = "TenantStats"."successfulPrints" + new_success,
      "failedPrints" = "TenantStats"."failedPrints" + new_failed,
      "cancelledPrints" = "TenantStats"."cancelledPrints" + new_cancelled,
      "successfulPrintDurationSeconds" = "TenantStats"."successfulPrintDurationSeconds" + new_success_duration,
      "failedPrintDurationSeconds" = "TenantStats"."failedPrintDurationSeconds" + new_failed_duration,
      "cancelledPrintDurationSeconds" = "TenantStats"."cancelledPrintDurationSeconds" + new_cancelled_duration,
      "wastedPrintDurationSeconds" = "TenantStats"."wastedPrintDurationSeconds" + new_wasted_duration,
      "trackedFilamentPrints" = "TenantStats"."trackedFilamentPrints" + new_tracked_filament,
      "filamentUsedGrams" = "TenantStats"."filamentUsedGrams" + new_filament_grams,
      "successfulFilamentUsedGrams" = "TenantStats"."successfulFilamentUsedGrams" + new_successful_filament_grams,
      "failedFilamentUsedGrams" = "TenantStats"."failedFilamentUsedGrams" + new_failed_filament_grams,
      "cancelledFilamentUsedGrams" = "TenantStats"."cancelledFilamentUsedGrams" + new_cancelled_filament_grams,
      "wastedFilamentUsedGrams" = "TenantStats"."wastedFilamentUsedGrams" + new_wasted_filament_grams,
      "filamentUsedMeters" = "TenantStats"."filamentUsedMeters" + new_filament_meters,
      "successfulFilamentUsedMeters" = "TenantStats"."successfulFilamentUsedMeters" + new_successful_filament_meters,
      "failedFilamentUsedMeters" = "TenantStats"."failedFilamentUsedMeters" + new_failed_filament_meters,
      "cancelledFilamentUsedMeters" = "TenantStats"."cancelledFilamentUsedMeters" + new_cancelled_filament_meters,
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
  WHERE "tenantId" = NEW."tenantId";

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION sync_platform_stats_from_tenant_stats()
RETURNS TRIGGER AS $$
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
$$ LANGUAGE plpgsql;