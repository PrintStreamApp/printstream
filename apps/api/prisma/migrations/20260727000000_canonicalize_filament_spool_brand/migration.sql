-- One spelling per vendor. The Filament plugin's brand dropdown used to offer the legal name
-- "Bambu Lab", while every derived path spells it "Bambu" — preset names read "Bambu PLA Basic",
-- and `resolveFilamentIdentity` returns "Bambu" for a genuine tray. A stored spool's own brand
-- OVERRIDES the derived one, so a hand-entered spool and an auto-ingested one were two different
-- brands in the same inventory: the brand filter split them and the same filament read differently
-- across surfaces.
--
-- The dropdown now offers "Bambu" and the API canonicalises on write
-- (`normalizeFilamentVendorLabel`), so this only has to carry the rows written before that.
-- Deliberately exact-match, not a LIKE: "Bambu Lab" is the one spelling we know to be the same
-- manufacturer. Anything else a user typed is their own text and is left alone.
UPDATE "FilamentSpool"
SET "brand" = 'Bambu'
WHERE "brand" = 'Bambu Lab';
