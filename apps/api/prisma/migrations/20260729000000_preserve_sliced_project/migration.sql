-- Preserve the project 3MF a slice was produced from, so a finished print can be
-- re-sliced from the project rather than only re-dispatched as the same G-code.
--
-- `sourceProjectFileId` points at a hidden, content-deduped snapshot LibraryFile
-- holding the project exactly as it was handed to the slicer. It is set on the
-- sliced OUTPUT row, and copied onto PrintJob at dispatch so history keeps the
-- link after the output is deleted. Both FKs are ON DELETE SET NULL: losing the
-- snapshot must degrade to "re-slice unavailable", never delete the print history.
ALTER TABLE "LibraryFile" ADD COLUMN "sourceProjectFileId" TEXT;
ALTER TABLE "LibraryFile" ADD COLUMN "sliceSettingsJson" TEXT;
ALTER TABLE "PrintJob" ADD COLUMN "sourceProjectFileId" TEXT;
ALTER TABLE "PrintJob" ADD COLUMN "sliceSettingsJson" TEXT;

ALTER TABLE "LibraryFile" ADD CONSTRAINT "LibraryFile_sourceProjectFileId_fkey"
  FOREIGN KEY ("sourceProjectFileId") REFERENCES "LibraryFile"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PrintJob" ADD CONSTRAINT "PrintJob_sourceProjectFileId_fkey"
  FOREIGN KEY ("sourceProjectFileId") REFERENCES "LibraryFile"("id") ON DELETE SET NULL ON UPDATE CASCADE;
