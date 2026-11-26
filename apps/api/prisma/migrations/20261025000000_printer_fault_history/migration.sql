-- CreateTable
CREATE TABLE "PrinterFault" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "printerId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "message" TEXT,
    "firstObservedAt" TIMESTAMP(3) NOT NULL,
    "lastObservedAt" TIMESTAMP(3) NOT NULL,
    "observedClearedAt" TIMESTAMP(3),

    CONSTRAINT "PrinterFault_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PrinterFaultGap" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "faultId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "reason" TEXT NOT NULL,

    CONSTRAINT "PrinterFaultGap_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PrintJobFault" (
    "workspaceId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "faultId" TEXT NOT NULL,
    "alreadyPresent" BOOLEAN NOT NULL,

    CONSTRAINT "PrintJobFault_pkey" PRIMARY KEY ("jobId","faultId")
);

-- CreateTable
CREATE TABLE "PrinterFaultIdlePeriod" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "faultId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "PrinterFaultIdlePeriod_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PrinterFaultJobSpan" (
    "workspaceId" TEXT NOT NULL,
    "faultId" TEXT NOT NULL,
    "jobKey" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "PrinterFaultJobSpan_pkey" PRIMARY KEY ("faultId","jobKey")
);

-- CreateIndex
CREATE INDEX "PrinterFault_workspaceId_printerId_observedClearedAt_idx" ON "PrinterFault"("workspaceId", "printerId", "observedClearedAt");

-- CreateIndex
CREATE UNIQUE INDEX "PrinterFault_workspaceId_id_key" ON "PrinterFault"("workspaceId", "id");

-- CreateIndex
CREATE INDEX "PrinterFaultGap_workspaceId_faultId_idx" ON "PrinterFaultGap"("workspaceId", "faultId");

-- CreateIndex
CREATE INDEX "PrintJobFault_workspaceId_faultId_idx" ON "PrintJobFault"("workspaceId", "faultId");

-- CreateIndex
CREATE INDEX "PrinterFaultIdlePeriod_workspaceId_startedAt_idx" ON "PrinterFaultIdlePeriod"("workspaceId", "startedAt");

-- CreateIndex
CREATE INDEX "PrinterFaultJobSpan_workspaceId_jobKey_idx" ON "PrinterFaultJobSpan"("workspaceId", "jobKey");

-- CreateIndex
CREATE UNIQUE INDEX "Printer_workspaceId_id_key" ON "Printer"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "PrintJob_workspaceId_id_key" ON "PrintJob"("workspaceId", "id");

-- AddForeignKey
ALTER TABLE "PrinterFault" ADD CONSTRAINT "PrinterFault_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrinterFault" ADD CONSTRAINT "PrinterFault_workspaceId_printerId_fkey" FOREIGN KEY ("workspaceId", "printerId") REFERENCES "Printer"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrinterFaultGap" ADD CONSTRAINT "PrinterFaultGap_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrinterFaultGap" ADD CONSTRAINT "PrinterFaultGap_workspaceId_faultId_fkey" FOREIGN KEY ("workspaceId", "faultId") REFERENCES "PrinterFault"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrintJobFault" ADD CONSTRAINT "PrintJobFault_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrintJobFault" ADD CONSTRAINT "PrintJobFault_workspaceId_jobId_fkey" FOREIGN KEY ("workspaceId", "jobId") REFERENCES "PrintJob"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrintJobFault" ADD CONSTRAINT "PrintJobFault_workspaceId_faultId_fkey" FOREIGN KEY ("workspaceId", "faultId") REFERENCES "PrinterFault"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrinterFaultIdlePeriod" ADD CONSTRAINT "PrinterFaultIdlePeriod_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrinterFaultIdlePeriod" ADD CONSTRAINT "PrinterFaultIdlePeriod_workspaceId_faultId_fkey" FOREIGN KEY ("workspaceId", "faultId") REFERENCES "PrinterFault"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrinterFaultJobSpan" ADD CONSTRAINT "PrinterFaultJobSpan_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrinterFaultJobSpan" ADD CONSTRAINT "PrinterFaultJobSpan_workspaceId_faultId_fkey" FOREIGN KEY ("workspaceId", "faultId") REFERENCES "PrinterFault"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Prisma cannot represent partial uniqueness. NULL is the uncleared/open state.
CREATE UNIQUE INDEX "PrinterFault_open_source_code_key" ON "PrinterFault" ("workspaceId", "printerId", "source", "code") WHERE "observedClearedAt" IS NULL;
CREATE UNIQUE INDEX "PrinterFaultGap_open_key" ON "PrinterFaultGap" ("faultId") WHERE "endedAt" IS NULL;
CREATE UNIQUE INDEX "PrinterFaultIdlePeriod_open_key" ON "PrinterFaultIdlePeriod" ("faultId") WHERE "endedAt" IS NULL;
ALTER TABLE "PrinterFault" ADD CONSTRAINT "PrinterFault_source_check" CHECK ("source" IN ('hms', 'device_error'));
ALTER TABLE "PrinterFault" ADD CONSTRAINT "PrinterFault_observation_order_check" CHECK ("lastObservedAt" >= "firstObservedAt" AND ("observedClearedAt" IS NULL OR "observedClearedAt" >= "firstObservedAt"));
ALTER TABLE "PrinterFaultGap" ADD CONSTRAINT "PrinterFaultGap_order_check" CHECK ("endedAt" IS NULL OR "endedAt" >= "startedAt");
ALTER TABLE "PrinterFaultGap" ADD CONSTRAINT "PrinterFaultGap_reason_check" CHECK ("reason" IN ('disconnect', 'restart'));
ALTER TABLE "PrinterFaultIdlePeriod" ADD CONSTRAINT "PrinterFaultIdlePeriod_order_check" CHECK ("endedAt" IS NULL OR "endedAt" >= "startedAt");
ALTER TABLE "PrinterFaultJobSpan" ADD CONSTRAINT "PrinterFaultJobSpan_order_check" CHECK ("endedAt" IS NULL OR "endedAt" >= "startedAt");
