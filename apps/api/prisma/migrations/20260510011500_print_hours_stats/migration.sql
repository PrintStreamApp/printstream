ALTER TABLE "TenantStats"
ADD COLUMN "successfulPrintDurationSeconds" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "wastedPrintDurationSeconds" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "PrinterStats"
ADD COLUMN "successfulPrintDurationSeconds" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "wastedPrintDurationSeconds" INTEGER NOT NULL DEFAULT 0;

WITH tenant_aggregated AS (
  SELECT
    job."tenantId" AS "tenantId",
    COALESCE(SUM(job."durationSeconds") FILTER (WHERE job."result" = 'success'), 0)::INTEGER AS "successfulPrintDurationSeconds",
    COALESCE(SUM(job."durationSeconds") FILTER (WHERE job."result" IN ('failed', 'cancelled')), 0)::INTEGER AS "wastedPrintDurationSeconds"
  FROM "PrintJob" job
  GROUP BY job."tenantId"
)
UPDATE "TenantStats" stats
SET
  "successfulPrintDurationSeconds" = tenant_aggregated."successfulPrintDurationSeconds",
  "wastedPrintDurationSeconds" = tenant_aggregated."wastedPrintDurationSeconds",
  "updatedAt" = CURRENT_TIMESTAMP
FROM tenant_aggregated
WHERE stats."tenantId" = tenant_aggregated."tenantId";

WITH printer_aggregated AS (
  SELECT
    job."tenantId" AS "tenantId",
    printer."serial" AS "printerSerial",
    COALESCE(SUM(job."durationSeconds") FILTER (WHERE job."result" = 'success'), 0)::INTEGER AS "successfulPrintDurationSeconds",
    COALESCE(SUM(job."durationSeconds") FILTER (WHERE job."result" IN ('failed', 'cancelled')), 0)::INTEGER AS "wastedPrintDurationSeconds"
  FROM "PrintJob" job
  INNER JOIN "Printer" printer ON printer."id" = job."printerId"
  GROUP BY job."tenantId", printer."serial"
)
UPDATE "PrinterStats" stats
SET
  "successfulPrintDurationSeconds" = printer_aggregated."successfulPrintDurationSeconds",
  "wastedPrintDurationSeconds" = printer_aggregated."wastedPrintDurationSeconds",
  "updatedAt" = CURRENT_TIMESTAMP
FROM printer_aggregated
WHERE stats."tenantId" = printer_aggregated."tenantId"
  AND stats."printerSerial" = printer_aggregated."printerSerial";

CREATE OR REPLACE FUNCTION sync_tenant_print_stats()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO "TenantStats" (
      "tenantId",
      "totalPrints",
      "successfulPrints",
      "failedPrints",
      "cancelledPrints",
      "successfulPrintDurationSeconds",
      "wastedPrintDurationSeconds",
      "filamentUsedGrams",
      "filamentUsedMeters",
      "updatedAt"
    )
    VALUES (
      NEW."tenantId",
      1,
      CASE WHEN NEW."result" = 'success' THEN 1 ELSE 0 END,
      CASE WHEN NEW."result" = 'failed' THEN 1 ELSE 0 END,
      CASE WHEN NEW."result" = 'cancelled' THEN 1 ELSE 0 END,
      CASE WHEN NEW."result" = 'success' THEN COALESCE(NEW."durationSeconds", 0) ELSE 0 END,
      CASE WHEN NEW."result" IN ('failed', 'cancelled') THEN COALESCE(NEW."durationSeconds", 0) ELSE 0 END,
      COALESCE(NEW."filamentUsedGrams", 0),
      COALESCE(NEW."filamentUsedMeters", 0),
      CURRENT_TIMESTAMP
    )
    ON CONFLICT ("tenantId") DO UPDATE
    SET
      "totalPrints" = "TenantStats"."totalPrints" + 1,
      "successfulPrints" = "TenantStats"."successfulPrints" + CASE WHEN NEW."result" = 'success' THEN 1 ELSE 0 END,
      "failedPrints" = "TenantStats"."failedPrints" + CASE WHEN NEW."result" = 'failed' THEN 1 ELSE 0 END,
      "cancelledPrints" = "TenantStats"."cancelledPrints" + CASE WHEN NEW."result" = 'cancelled' THEN 1 ELSE 0 END,
      "successfulPrintDurationSeconds" = "TenantStats"."successfulPrintDurationSeconds" + CASE WHEN NEW."result" = 'success' THEN COALESCE(NEW."durationSeconds", 0) ELSE 0 END,
      "wastedPrintDurationSeconds" = "TenantStats"."wastedPrintDurationSeconds" + CASE WHEN NEW."result" IN ('failed', 'cancelled') THEN COALESCE(NEW."durationSeconds", 0) ELSE 0 END,
      "filamentUsedGrams" = "TenantStats"."filamentUsedGrams" + COALESCE(NEW."filamentUsedGrams", 0),
      "filamentUsedMeters" = "TenantStats"."filamentUsedMeters" + COALESCE(NEW."filamentUsedMeters", 0),
      "updatedAt" = CURRENT_TIMESTAMP;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    UPDATE "TenantStats"
    SET
      "totalPrints" = GREATEST(0, "totalPrints" - 1),
      "successfulPrints" = GREATEST(0, "successfulPrints" - CASE WHEN OLD."result" = 'success' THEN 1 ELSE 0 END),
      "failedPrints" = GREATEST(0, "failedPrints" - CASE WHEN OLD."result" = 'failed' THEN 1 ELSE 0 END),
      "cancelledPrints" = GREATEST(0, "cancelledPrints" - CASE WHEN OLD."result" = 'cancelled' THEN 1 ELSE 0 END),
      "successfulPrintDurationSeconds" = GREATEST(0, "successfulPrintDurationSeconds" - CASE WHEN OLD."result" = 'success' THEN COALESCE(OLD."durationSeconds", 0) ELSE 0 END),
      "wastedPrintDurationSeconds" = GREATEST(0, "wastedPrintDurationSeconds" - CASE WHEN OLD."result" IN ('failed', 'cancelled') THEN COALESCE(OLD."durationSeconds", 0) ELSE 0 END),
      "filamentUsedGrams" = GREATEST(0, "filamentUsedGrams" - COALESCE(OLD."filamentUsedGrams", 0)),
      "filamentUsedMeters" = GREATEST(0, "filamentUsedMeters" - COALESCE(OLD."filamentUsedMeters", 0)),
      "updatedAt" = CURRENT_TIMESTAMP
    WHERE "tenantId" = OLD."tenantId";
    RETURN OLD;
  END IF;

  IF NEW."tenantId" <> OLD."tenantId" THEN
    UPDATE "TenantStats"
    SET
      "totalPrints" = GREATEST(0, "totalPrints" - 1),
      "successfulPrints" = GREATEST(0, "successfulPrints" - CASE WHEN OLD."result" = 'success' THEN 1 ELSE 0 END),
      "failedPrints" = GREATEST(0, "failedPrints" - CASE WHEN OLD."result" = 'failed' THEN 1 ELSE 0 END),
      "cancelledPrints" = GREATEST(0, "cancelledPrints" - CASE WHEN OLD."result" = 'cancelled' THEN 1 ELSE 0 END),
      "successfulPrintDurationSeconds" = GREATEST(0, "successfulPrintDurationSeconds" - CASE WHEN OLD."result" = 'success' THEN COALESCE(OLD."durationSeconds", 0) ELSE 0 END),
      "wastedPrintDurationSeconds" = GREATEST(0, "wastedPrintDurationSeconds" - CASE WHEN OLD."result" IN ('failed', 'cancelled') THEN COALESCE(OLD."durationSeconds", 0) ELSE 0 END),
      "filamentUsedGrams" = GREATEST(0, "filamentUsedGrams" - COALESCE(OLD."filamentUsedGrams", 0)),
      "filamentUsedMeters" = GREATEST(0, "filamentUsedMeters" - COALESCE(OLD."filamentUsedMeters", 0)),
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
      "filamentUsedGrams",
      "filamentUsedMeters",
      "updatedAt"
    )
    VALUES (
      NEW."tenantId",
      1,
      CASE WHEN NEW."result" = 'success' THEN 1 ELSE 0 END,
      CASE WHEN NEW."result" = 'failed' THEN 1 ELSE 0 END,
      CASE WHEN NEW."result" = 'cancelled' THEN 1 ELSE 0 END,
      CASE WHEN NEW."result" = 'success' THEN COALESCE(NEW."durationSeconds", 0) ELSE 0 END,
      CASE WHEN NEW."result" IN ('failed', 'cancelled') THEN COALESCE(NEW."durationSeconds", 0) ELSE 0 END,
      COALESCE(NEW."filamentUsedGrams", 0),
      COALESCE(NEW."filamentUsedMeters", 0),
      CURRENT_TIMESTAMP
    )
    ON CONFLICT ("tenantId") DO UPDATE
    SET
      "totalPrints" = "TenantStats"."totalPrints" + 1,
      "successfulPrints" = "TenantStats"."successfulPrints" + CASE WHEN NEW."result" = 'success' THEN 1 ELSE 0 END,
      "failedPrints" = "TenantStats"."failedPrints" + CASE WHEN NEW."result" = 'failed' THEN 1 ELSE 0 END,
      "cancelledPrints" = "TenantStats"."cancelledPrints" + CASE WHEN NEW."result" = 'cancelled' THEN 1 ELSE 0 END,
      "successfulPrintDurationSeconds" = "TenantStats"."successfulPrintDurationSeconds" + CASE WHEN NEW."result" = 'success' THEN COALESCE(NEW."durationSeconds", 0) ELSE 0 END,
      "wastedPrintDurationSeconds" = "TenantStats"."wastedPrintDurationSeconds" + CASE WHEN NEW."result" IN ('failed', 'cancelled') THEN COALESCE(NEW."durationSeconds", 0) ELSE 0 END,
      "filamentUsedGrams" = "TenantStats"."filamentUsedGrams" + COALESCE(NEW."filamentUsedGrams", 0),
      "filamentUsedMeters" = "TenantStats"."filamentUsedMeters" + COALESCE(NEW."filamentUsedMeters", 0),
      "updatedAt" = CURRENT_TIMESTAMP;
    RETURN NEW;
  END IF;

  UPDATE "TenantStats"
  SET
    "successfulPrints" = GREATEST(0, "successfulPrints" + (CASE WHEN NEW."result" = 'success' THEN 1 ELSE 0 END) - (CASE WHEN OLD."result" = 'success' THEN 1 ELSE 0 END)),
    "failedPrints" = GREATEST(0, "failedPrints" + (CASE WHEN NEW."result" = 'failed' THEN 1 ELSE 0 END) - (CASE WHEN OLD."result" = 'failed' THEN 1 ELSE 0 END)),
    "cancelledPrints" = GREATEST(0, "cancelledPrints" + (CASE WHEN NEW."result" = 'cancelled' THEN 1 ELSE 0 END) - (CASE WHEN OLD."result" = 'cancelled' THEN 1 ELSE 0 END)),
    "successfulPrintDurationSeconds" = GREATEST(0, "successfulPrintDurationSeconds" + (CASE WHEN NEW."result" = 'success' THEN COALESCE(NEW."durationSeconds", 0) ELSE 0 END) - (CASE WHEN OLD."result" = 'success' THEN COALESCE(OLD."durationSeconds", 0) ELSE 0 END)),
    "wastedPrintDurationSeconds" = GREATEST(0, "wastedPrintDurationSeconds" + (CASE WHEN NEW."result" IN ('failed', 'cancelled') THEN COALESCE(NEW."durationSeconds", 0) ELSE 0 END) - (CASE WHEN OLD."result" IN ('failed', 'cancelled') THEN COALESCE(OLD."durationSeconds", 0) ELSE 0 END)),
    "filamentUsedGrams" = GREATEST(0, "filamentUsedGrams" + COALESCE(NEW."filamentUsedGrams", 0) - COALESCE(OLD."filamentUsedGrams", 0)),
    "filamentUsedMeters" = GREATEST(0, "filamentUsedMeters" + COALESCE(NEW."filamentUsedMeters", 0) - COALESCE(OLD."filamentUsedMeters", 0)),
    "updatedAt" = CURRENT_TIMESTAMP
  WHERE "tenantId" = NEW."tenantId";

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;