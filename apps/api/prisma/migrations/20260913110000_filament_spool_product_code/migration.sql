-- Preserve the retail barcode or manufacturer article number used to add a spool.
-- Product codes are intentionally not unique: scanning two boxes of the same product creates two spools.
ALTER TABLE "FilamentSpool" ADD COLUMN "productCode" TEXT;
