-- CreateTable
CREATE TABLE "CalibrationRun" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'slicing',
    "printerId" TEXT,
    "printerModel" TEXT NOT NULL,
    "nozzleDiameter" TEXT NOT NULL,
    "amsId" INTEGER,
    "slotId" INTEGER,
    "spoolId" TEXT,
    "brand" TEXT,
    "filamentType" TEXT,
    "materialSubtype" TEXT,
    "colorName" TEXT,
    "parametersJson" JSONB NOT NULL,
    "slicingJobId" TEXT,
    "outputFileId" TEXT,
    "errorMessage" TEXT,
    "measuredJson" JSONB,
    "resultValue" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CalibrationRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CalibrationResult" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "printerModel" TEXT NOT NULL,
    "nozzleDiameter" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "spoolId" TEXT,
    "brand" TEXT,
    "filamentType" TEXT,
    "materialSubtype" TEXT,
    "colorName" TEXT,
    "runId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CalibrationResult_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CalibrationRun_tenantId_status_createdAt_idx" ON "CalibrationRun"("tenantId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "CalibrationRun_tenantId_printerId_idx" ON "CalibrationRun"("tenantId", "printerId");

-- CreateIndex
CREATE INDEX "CalibrationRun_tenantId_spoolId_idx" ON "CalibrationRun"("tenantId", "spoolId");

-- CreateIndex
CREATE INDEX "CalibrationResult_tenantId_kind_printerModel_nozzleDiameter_idx" ON "CalibrationResult"("tenantId", "kind", "printerModel", "nozzleDiameter");

-- CreateIndex
CREATE INDEX "CalibrationResult_tenantId_spoolId_idx" ON "CalibrationResult"("tenantId", "spoolId");

-- AddForeignKey
ALTER TABLE "CalibrationRun" ADD CONSTRAINT "CalibrationRun_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalibrationResult" ADD CONSTRAINT "CalibrationResult_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
