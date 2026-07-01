-- AlterTable: link a queue item to the order print it was queued for (orders plugin).
-- Plain nullable ids (no FK); a stale link is handled gracefully as a no-op.
ALTER TABLE "QueueItem" ADD COLUMN "orderId" TEXT;
ALTER TABLE "QueueItem" ADD COLUMN "orderPrintId" TEXT;

-- CreateIndex
CREATE INDEX "QueueItem_tenantId_orderPrintId_idx" ON "QueueItem"("tenantId", "orderPrintId");
