-- Cached 3MF-derived display data on LibraryFile so the library listing does not
-- re-inspect every file. Lazily populated; null until first computed.
ALTER TABLE "LibraryFile" ADD COLUMN "derivedChipsJson" TEXT;
ALTER TABLE "LibraryFile" ADD COLUMN "derivedChipsVersion" INTEGER;
