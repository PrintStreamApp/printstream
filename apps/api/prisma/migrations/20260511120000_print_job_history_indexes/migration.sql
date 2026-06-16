-- Improve job history ordering and active-print lookup paths.
CREATE INDEX "PrintJob_tenantId_printerId_finishedAt_startedAt_idx" ON "PrintJob"("tenantId", "printerId", "finishedAt", "startedAt");
CREATE INDEX "PrintJob_tenantId_finishedAt_printerId_idx" ON "PrintJob"("tenantId", "finishedAt", "printerId");
