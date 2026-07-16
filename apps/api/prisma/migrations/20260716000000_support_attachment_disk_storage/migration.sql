-- Support attachment bytes move from the row to disk.
--
-- `data` becomes nullable so new rows can omit it; existing rows keep their
-- inline bytes and stay readable (they predate disk storage and are all <= 25 MB).
-- `storedPath` is null exactly for those legacy rows.
ALTER TABLE "SupportAttachment" ALTER COLUMN "data" DROP NOT NULL;
ALTER TABLE "SupportAttachment" ADD COLUMN "storedPath" TEXT;
