-- Durable journal of the print-dispatch lifecycle. The live executor still runs
-- in-process; this row is written through on each transition so a restart can
-- reconcile orphaned pre-start dispatches and (later) back the cluster-wide
-- per-printer dispatch guard. `startCommandAttemptedAt` is the rob-1 safety
-- boundary: NULL means a start command was provably never published (safe to
-- clean up); a value means a real print may have started (leave to the recorder).
CREATE TABLE "DispatchJob" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "printerId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "jobName" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "remoteName" TEXT NOT NULL,
    "error" TEXT,
    "startCommandAttemptedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "DispatchJob_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "DispatchJob_tenantId_printerId_status_idx" ON "DispatchJob"("tenantId", "printerId", "status");

CREATE INDEX "DispatchJob_printerId_status_idx" ON "DispatchJob"("printerId", "status");

ALTER TABLE "DispatchJob"
ADD CONSTRAINT "DispatchJob_tenantId_fkey"
FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "DispatchJob"
ADD CONSTRAINT "DispatchJob_printerId_fkey"
FOREIGN KEY ("printerId") REFERENCES "Printer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
