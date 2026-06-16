ALTER TABLE "PrintJob"
ADD COLUMN "printerStatsRecordedAt" TIMESTAMP(3);

CREATE TABLE "PrinterStats" (
  "tenantId" TEXT NOT NULL,
  "printerSerial" TEXT NOT NULL,
  "totalPrints" INTEGER NOT NULL DEFAULT 0,
  "successfulPrints" INTEGER NOT NULL DEFAULT 0,
  "failedPrints" INTEGER NOT NULL DEFAULT 0,
  "cancelledPrints" INTEGER NOT NULL DEFAULT 0,
  "trackedFilamentPrints" INTEGER NOT NULL DEFAULT 0,
  "filamentUsedGrams" DECIMAL(14, 3) NOT NULL DEFAULT 0,
  "filamentUsedMeters" DECIMAL(14, 3) NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "PrinterStats_pkey" PRIMARY KEY ("tenantId", "printerSerial"),
  CONSTRAINT "PrinterStats_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "PrinterStats_tenantId_updatedAt_idx" ON "PrinterStats"("tenantId", "updatedAt");

WITH aggregated AS (
  SELECT
    job."tenantId" AS "tenantId",
    printer."serial" AS "printerSerial",
    COUNT(*) FILTER (WHERE job."result" IN ('success', 'failed', 'cancelled'))::INTEGER AS "totalPrints",
    COUNT(*) FILTER (WHERE job."result" = 'success')::INTEGER AS "successfulPrints",
    COUNT(*) FILTER (WHERE job."result" = 'failed')::INTEGER AS "failedPrints",
    COUNT(*) FILTER (WHERE job."result" = 'cancelled')::INTEGER AS "cancelledPrints",
    COUNT(*) FILTER (
      WHERE job."result" IN ('success', 'failed', 'cancelled')
        AND (job."filamentUsedGrams" IS NOT NULL OR job."filamentUsedMeters" IS NOT NULL)
    )::INTEGER AS "trackedFilamentPrints",
    COALESCE(SUM(job."filamentUsedGrams") FILTER (WHERE job."result" IN ('success', 'failed', 'cancelled')), 0)::DECIMAL(14, 3) AS "filamentUsedGrams",
    COALESCE(SUM(job."filamentUsedMeters") FILTER (WHERE job."result" IN ('success', 'failed', 'cancelled')), 0)::DECIMAL(14, 3) AS "filamentUsedMeters"
  FROM "PrintJob" job
  INNER JOIN "Printer" printer ON printer."id" = job."printerId"
  GROUP BY job."tenantId", printer."serial"
)
INSERT INTO "PrinterStats" (
  "tenantId",
  "printerSerial",
  "totalPrints",
  "successfulPrints",
  "failedPrints",
  "cancelledPrints",
  "trackedFilamentPrints",
  "filamentUsedGrams",
  "filamentUsedMeters",
  "updatedAt"
)
SELECT
  aggregated."tenantId",
  aggregated."printerSerial",
  aggregated."totalPrints",
  aggregated."successfulPrints",
  aggregated."failedPrints",
  aggregated."cancelledPrints",
  aggregated."trackedFilamentPrints",
  aggregated."filamentUsedGrams",
  aggregated."filamentUsedMeters",
  CURRENT_TIMESTAMP
FROM aggregated
ON CONFLICT ("tenantId", "printerSerial") DO UPDATE
SET
  "totalPrints" = EXCLUDED."totalPrints",
  "successfulPrints" = EXCLUDED."successfulPrints",
  "failedPrints" = EXCLUDED."failedPrints",
  "cancelledPrints" = EXCLUDED."cancelledPrints",
  "trackedFilamentPrints" = EXCLUDED."trackedFilamentPrints",
  "filamentUsedGrams" = EXCLUDED."filamentUsedGrams",
  "filamentUsedMeters" = EXCLUDED."filamentUsedMeters",
  "updatedAt" = CURRENT_TIMESTAMP;

UPDATE "PrintJob"
SET "printerStatsRecordedAt" = CURRENT_TIMESTAMP
WHERE "result" IN ('success', 'failed', 'cancelled')
  AND "printerStatsRecordedAt" IS NULL;