ALTER TABLE "PrintJob"
ADD COLUMN "taskId" TEXT;

CREATE INDEX "PrintJob_tenantId_printerId_taskId_idx"
ON "PrintJob"("tenantId", "printerId", "taskId");
