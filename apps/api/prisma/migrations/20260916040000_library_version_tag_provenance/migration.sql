-- Archive slice tag provenance with the bytes so restoring a version cannot mislabel prints.
ALTER TABLE "LibraryFileVersion" ADD COLUMN "sourceTagSnapshotJson" TEXT;
