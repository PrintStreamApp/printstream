-- CreateTable
CREATE TABLE "QueueItem" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "libraryFileId" TEXT,
    "fileName" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'gcode',
    "plateIndex" INTEGER NOT NULL DEFAULT 1,
    "plateName" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "completedCount" INTEGER NOT NULL DEFAULT 0,
    "sortKey" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "targetKind" TEXT NOT NULL DEFAULT 'any',
    "targetPrinterId" TEXT,
    "targetModel" TEXT,
    "printOptionsJson" TEXT,
    "amsMappingJson" TEXT,
    "requiredFilamentsJson" TEXT,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "label" TEXT,
    "createdById" TEXT,
    "lastPrinterId" TEXT,
    "lastDispatchJobId" TEXT,
    "lastPrintJobId" TEXT,
    "lastJobName" TEXT,
    "lastResult" TEXT,
    "lastDispatchedAt" TIMESTAMP(3),
    "lastFinishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QueueItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "QueueItem_tenantId_status_sortKey_idx" ON "QueueItem"("tenantId", "status", "sortKey");

-- CreateIndex
CREATE INDEX "QueueItem_tenantId_sortKey_idx" ON "QueueItem"("tenantId", "sortKey");

-- CreateIndex
CREATE INDEX "QueueItem_tenantId_libraryFileId_idx" ON "QueueItem"("tenantId", "libraryFileId");

-- CreateIndex
CREATE INDEX "QueueItem_tenantId_targetPrinterId_idx" ON "QueueItem"("tenantId", "targetPrinterId");

-- CreateIndex
CREATE INDEX "QueueItem_tenantId_lastPrinterId_idx" ON "QueueItem"("tenantId", "lastPrinterId");

-- CreateIndex
CREATE INDEX "QueueItem_tenantId_lastPrintJobId_idx" ON "QueueItem"("tenantId", "lastPrintJobId");

-- AddForeignKey
ALTER TABLE "QueueItem" ADD CONSTRAINT "QueueItem_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QueueItem" ADD CONSTRAINT "QueueItem_libraryFileId_fkey" FOREIGN KEY ("libraryFileId") REFERENCES "LibraryFile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QueueItem" ADD CONSTRAINT "QueueItem_targetPrinterId_fkey" FOREIGN KEY ("targetPrinterId") REFERENCES "Printer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QueueItem" ADD CONSTRAINT "QueueItem_lastPrinterId_fkey" FOREIGN KEY ("lastPrinterId") REFERENCES "Printer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QueueItem" ADD CONSTRAINT "QueueItem_lastPrintJobId_fkey" FOREIGN KEY ("lastPrintJobId") REFERENCES "PrintJob"("id") ON DELETE SET NULL ON UPDATE CASCADE;
