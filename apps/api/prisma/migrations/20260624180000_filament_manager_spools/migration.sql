-- CreateTable
CREATE TABLE "FilamentSpool" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "brand" TEXT,
    "filamentType" TEXT NOT NULL,
    "materialSubtype" TEXT,
    "colorName" TEXT,
    "colorHex" TEXT,
    "colorsJson" TEXT,
    "trayInfoIdx" TEXT,
    "bambuUuid" TEXT,
    "serial" TEXT,
    "nozzleTempMin" INTEGER,
    "nozzleTempMax" INTEGER,
    "diameterMm" DOUBLE PRECISION NOT NULL DEFAULT 1.75,
    "netWeightGrams" INTEGER NOT NULL DEFAULT 1000,
    "spoolCoreGrams" INTEGER,
    "remainingGrams" DOUBLE PRECISION NOT NULL DEFAULT 1000,
    "remainSource" TEXT NOT NULL DEFAULT 'manual',
    "costCents" INTEGER,
    "currency" TEXT,
    "purchasedAt" TIMESTAMP(3),
    "vendor" TEXT,
    "notes" TEXT,
    "loadedPrinterId" TEXT,
    "loadedAmsId" INTEGER,
    "loadedSlotId" INTEGER,
    "loadedAt" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3),

    CONSTRAINT "FilamentSpool_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FilamentSpoolUsage" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "spoolId" TEXT NOT NULL,
    "jobId" TEXT,
    "grams" DOUBLE PRECISION NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'print',
    "note" TEXT,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FilamentSpoolUsage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FilamentSpool_tenantId_deletedAt_idx" ON "FilamentSpool"("tenantId", "deletedAt");

-- CreateIndex
CREATE INDEX "FilamentSpool_tenantId_filamentType_idx" ON "FilamentSpool"("tenantId", "filamentType");

-- CreateIndex
CREATE INDEX "FilamentSpool_tenantId_brand_idx" ON "FilamentSpool"("tenantId", "brand");

-- CreateIndex
CREATE INDEX "FilamentSpool_tenantId_loadedPrinterId_idx" ON "FilamentSpool"("tenantId", "loadedPrinterId");

-- CreateIndex
CREATE INDEX "FilamentSpool_tenantId_bambuUuid_idx" ON "FilamentSpool"("tenantId", "bambuUuid");

-- CreateIndex
CREATE INDEX "FilamentSpoolUsage_tenantId_spoolId_recordedAt_idx" ON "FilamentSpoolUsage"("tenantId", "spoolId", "recordedAt");

-- CreateIndex
CREATE INDEX "FilamentSpoolUsage_tenantId_jobId_idx" ON "FilamentSpoolUsage"("tenantId", "jobId");

-- AddForeignKey
ALTER TABLE "FilamentSpool" ADD CONSTRAINT "FilamentSpool_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FilamentSpool" ADD CONSTRAINT "FilamentSpool_loadedPrinterId_fkey" FOREIGN KEY ("loadedPrinterId") REFERENCES "Printer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FilamentSpoolUsage" ADD CONSTRAINT "FilamentSpoolUsage_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FilamentSpoolUsage" ADD CONSTRAINT "FilamentSpoolUsage_spoolId_fkey" FOREIGN KEY ("spoolId") REFERENCES "FilamentSpool"("id") ON DELETE CASCADE ON UPDATE CASCADE;
