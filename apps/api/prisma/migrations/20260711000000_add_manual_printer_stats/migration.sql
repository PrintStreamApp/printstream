-- User-entered usage from outside PrintStream's tracking (e.g. hours printed before
-- the printer was added). Readers add these on top of the tracked counters.
ALTER TABLE "PrinterStats" ADD COLUMN "manualTotalPrints" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "PrinterStats" ADD COLUMN "manualPrintDurationSeconds" INTEGER NOT NULL DEFAULT 0;
