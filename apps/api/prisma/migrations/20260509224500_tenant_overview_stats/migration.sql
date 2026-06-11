ALTER TABLE "PrintJob"
ADD COLUMN "filamentUsedGrams" DECIMAL(14, 3),
ADD COLUMN "filamentUsedMeters" DECIMAL(14, 3);

CREATE TABLE "TenantStats" (
  "tenantId" TEXT NOT NULL,
  "totalPrints" INTEGER NOT NULL DEFAULT 0,
  "successfulPrints" INTEGER NOT NULL DEFAULT 0,
  "failedPrints" INTEGER NOT NULL DEFAULT 0,
  "cancelledPrints" INTEGER NOT NULL DEFAULT 0,
  "filamentUsedGrams" DECIMAL(14, 3) NOT NULL DEFAULT 0,
  "filamentUsedMeters" DECIMAL(14, 3) NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "TenantStats_pkey" PRIMARY KEY ("tenantId"),
  CONSTRAINT "TenantStats_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

INSERT INTO "TenantStats" ("tenantId")
SELECT "id"
FROM "Tenant"
ON CONFLICT ("tenantId") DO NOTHING;

WITH aggregated AS (
  SELECT
    job."tenantId" AS "tenantId",
    COUNT(*)::INTEGER AS "totalPrints",
    COUNT(*) FILTER (WHERE job."result" = 'success')::INTEGER AS "successfulPrints",
    COUNT(*) FILTER (WHERE job."result" = 'failed')::INTEGER AS "failedPrints",
    COUNT(*) FILTER (WHERE job."result" = 'cancelled')::INTEGER AS "cancelledPrints",
    COALESCE(SUM(job."filamentUsedGrams"), 0)::DECIMAL(14, 3) AS "filamentUsedGrams",
    COALESCE(SUM(job."filamentUsedMeters"), 0)::DECIMAL(14, 3) AS "filamentUsedMeters"
  FROM "PrintJob" job
  GROUP BY job."tenantId"
)
UPDATE "TenantStats" stats
SET
  "totalPrints" = aggregated."totalPrints",
  "successfulPrints" = aggregated."successfulPrints",
  "failedPrints" = aggregated."failedPrints",
  "cancelledPrints" = aggregated."cancelledPrints",
  "filamentUsedGrams" = aggregated."filamentUsedGrams",
  "filamentUsedMeters" = aggregated."filamentUsedMeters",
  "updatedAt" = CURRENT_TIMESTAMP
FROM aggregated
WHERE stats."tenantId" = aggregated."tenantId";

CREATE OR REPLACE FUNCTION ensure_tenant_stats_row()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO "TenantStats" ("tenantId") VALUES (NEW."id")
  ON CONFLICT ("tenantId") DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tenant_stats_row_insert
AFTER INSERT ON "Tenant"
FOR EACH ROW
EXECUTE FUNCTION ensure_tenant_stats_row();

CREATE OR REPLACE FUNCTION sync_tenant_print_stats()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO "TenantStats" ("tenantId", "totalPrints", "successfulPrints", "failedPrints", "cancelledPrints", "filamentUsedGrams", "filamentUsedMeters", "updatedAt")
    VALUES (
      NEW."tenantId",
      1,
      CASE WHEN NEW."result" = 'success' THEN 1 ELSE 0 END,
      CASE WHEN NEW."result" = 'failed' THEN 1 ELSE 0 END,
      CASE WHEN NEW."result" = 'cancelled' THEN 1 ELSE 0 END,
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
      "filamentUsedGrams" = GREATEST(0, "filamentUsedGrams" - COALESCE(OLD."filamentUsedGrams", 0)),
      "filamentUsedMeters" = GREATEST(0, "filamentUsedMeters" - COALESCE(OLD."filamentUsedMeters", 0)),
      "updatedAt" = CURRENT_TIMESTAMP
    WHERE "tenantId" = OLD."tenantId";

    INSERT INTO "TenantStats" ("tenantId", "totalPrints", "successfulPrints", "failedPrints", "cancelledPrints", "filamentUsedGrams", "filamentUsedMeters", "updatedAt")
    VALUES (
      NEW."tenantId",
      1,
      CASE WHEN NEW."result" = 'success' THEN 1 ELSE 0 END,
      CASE WHEN NEW."result" = 'failed' THEN 1 ELSE 0 END,
      CASE WHEN NEW."result" = 'cancelled' THEN 1 ELSE 0 END,
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
    "filamentUsedGrams" = GREATEST(0, "filamentUsedGrams" + COALESCE(NEW."filamentUsedGrams", 0) - COALESCE(OLD."filamentUsedGrams", 0)),
    "filamentUsedMeters" = GREATEST(0, "filamentUsedMeters" + COALESCE(NEW."filamentUsedMeters", 0) - COALESCE(OLD."filamentUsedMeters", 0)),
    "updatedAt" = CURRENT_TIMESTAMP
  WHERE "tenantId" = NEW."tenantId";

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tenant_print_stats_sync
AFTER INSERT OR UPDATE OR DELETE ON "PrintJob"
FOR EACH ROW
EXECUTE FUNCTION sync_tenant_print_stats();