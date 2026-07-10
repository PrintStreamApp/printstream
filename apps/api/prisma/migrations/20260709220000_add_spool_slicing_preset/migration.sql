-- The slicing preset (filament profile name) a spool slices with; null = auto-match.
ALTER TABLE "FilamentSpool" ADD COLUMN "slicingPresetName" TEXT;
