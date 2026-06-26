-- Per-view grouping for the printers dashboard (was previously client-side only).
-- "group" is quoted because it is a SQL reserved word.
ALTER TABLE "PrinterView" ADD COLUMN "group" TEXT NOT NULL DEFAULT 'none';
