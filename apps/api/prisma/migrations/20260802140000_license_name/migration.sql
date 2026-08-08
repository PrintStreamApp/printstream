-- What the holder calls a licence, so an account holding several self-hosted
-- subscriptions can tell them apart. Display only; never identity.
--
-- GUARDED, like every migration after `init`: `reconcileMigrationHistory`
-- collapses a pre-squash history into a satisfied `init` row and then applies
-- everything recorded after it, against a database that may already have the
-- object. `apply-migrations.test.ts` replays that path.

ALTER TABLE "License" ADD COLUMN IF NOT EXISTS "name" TEXT;
