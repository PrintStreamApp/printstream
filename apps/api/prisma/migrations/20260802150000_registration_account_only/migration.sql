-- Registration creates an account and nothing else: the workspace fields on the
-- pending row are dead now that workspace creation lives on the get-started
-- page. Rows are minutes-old transients, so dropping the columns loses nothing.
--
-- GUARDED, like every migration after `init`: `reconcileMigrationHistory`
-- replays the recorded chain against databases that may already match it.
ALTER TABLE "PendingRegistration" DROP COLUMN IF EXISTS "workspaceName";
ALTER TABLE "PendingRegistration" DROP COLUMN IF EXISTS "workspaceKind";
