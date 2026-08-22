-- Printer maintenance tracking (issue #62): the `maintenance` plugin's two tables.
--
-- `PrinterMaintenanceTask` holds ONLY per-printer customization (a retimed or
-- switched-off task, or a user-defined one) — every default comes from the shared
-- catalog, so an untouched printer has no rows here at all.
-- `PrinterMaintenanceLog` is the append-only record of work performed, snapshotting
-- the usage counters as they read at completion so a later stats adjustment cannot
-- retroactively move past due dates.
--
-- Both are keyed by `printerSerial`, matching `PrinterStats`: maintenance is a fact
-- about the physical machine and must survive removing and re-adding the printer.
--
-- GUARDED, like every migration after `init`: `reconcileMigrationHistory` may
-- replay this against a database that already has these objects.

CREATE TABLE IF NOT EXISTS "PrinterMaintenanceTask" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "printerSerial" TEXT NOT NULL,
    "taskKey" TEXT NOT NULL,
    "customTitle" TEXT,
    "customLubricant" TEXT,
    "intervalDays" INTEGER,
    "intervalPrintHours" INTEGER,
    "intervalFilamentKilograms" DECIMAL(10,3),
    "intervalsCleared" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "disabledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PrinterMaintenanceTask_pkey" PRIMARY KEY ("id")
);

-- One customization row per task per physical printer.
CREATE UNIQUE INDEX IF NOT EXISTS "PrinterMaintenanceTask_workspaceId_printerSerial_taskKey_key"
    ON "PrinterMaintenanceTask"("workspaceId", "printerSerial", "taskKey");
-- The detail view loads every task for one printer in a single read.
CREATE INDEX IF NOT EXISTS "PrinterMaintenanceTask_workspaceId_printerSerial_idx"
    ON "PrinterMaintenanceTask"("workspaceId", "printerSerial");

CREATE TABLE IF NOT EXISTS "PrinterMaintenanceLog" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "printerSerial" TEXT NOT NULL,
    "taskKey" TEXT NOT NULL,
    "completedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "printHours" DECIMAL(12,3),
    "filamentKilograms" DECIMAL(12,3),
    "performedByUserId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PrinterMaintenanceLog_pkey" PRIMARY KEY ("id")
);

-- Due dates come from the newest row per task, so the index ends on completedAt.
CREATE INDEX IF NOT EXISTS "PrinterMaintenanceLog_workspaceId_printerSerial_taskKey_com_idx"
    ON "PrinterMaintenanceLog"("workspaceId", "printerSerial", "taskKey", "completedAt");

-- Postgres has no `ADD CONSTRAINT IF NOT EXISTS`; guarded by name so the name
-- matches what Prisma derives, or `migrate diff` reports drift forever after.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PrinterMaintenanceTask_workspaceId_fkey') THEN
    ALTER TABLE "PrinterMaintenanceTask" ADD CONSTRAINT "PrinterMaintenanceTask_workspaceId_fkey"
      FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PrinterMaintenanceLog_workspaceId_fkey') THEN
    ALTER TABLE "PrinterMaintenanceLog" ADD CONSTRAINT "PrinterMaintenanceLog_workspaceId_fkey"
      FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
