-- Host OS and CPU a bridge reports at registration (process.platform / process.arch).
-- Nullable with no default: a bridge older than this field must read as "platform unknown"
-- rather than being silently counted as some default OS, which is the mistake that made
-- "how many Windows bridges are deployed" unanswerable in the first place.
--
-- IF NOT EXISTS like every sibling migration: the chain is replayed against databases that may
-- already carry the column (see apply-migrations.test.ts, which collapses a pre-squash history),
-- so a bare ADD COLUMN aborts the whole run.
ALTER TABLE "Bridge" ADD COLUMN IF NOT EXISTS "platform" TEXT;
ALTER TABLE "Bridge" ADD COLUMN IF NOT EXISTS "arch" TEXT;
