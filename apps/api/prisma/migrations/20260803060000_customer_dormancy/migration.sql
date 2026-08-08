-- Retiring a customer account without destroying it.
--
-- Soft by design: `dormantAt` is the whole switch, so restoring clears one
-- field and nothing has to be rebuilt. Dormancy is never copied onto the
-- account's workspaces -- `isWorkspaceDisabled` derives it -- because a copy
-- could not tell, on restore, which workspaces had been disabled on their own
-- before the account was retired.
--
-- GUARDED, like every migration after `init`: `reconcileMigrationHistory`
-- collapses a pre-squash history into a satisfied `init` row and then applies
-- everything recorded after it, against a database that may already have these
-- columns. See `apply-migrations.test.ts`.

ALTER TABLE "Customer" ADD COLUMN IF NOT EXISTS "dormantAt" TIMESTAMP(3);
ALTER TABLE "Customer" ADD COLUMN IF NOT EXISTS "dormantByUserId" TEXT;
ALTER TABLE "Customer" ADD COLUMN IF NOT EXISTS "dormantReason" TEXT;
-- Whether the customer may bring themselves back. True for the ordinary case
-- (they stopped paying and later want back); an operator retiring an account
-- for abuse withholds it, or the account could simply undo the decision.
ALTER TABLE "Customer" ADD COLUMN IF NOT EXISTS "dormantSelfRestorable" BOOLEAN NOT NULL DEFAULT true;

-- Every dormancy-aware query filters on this, and the platform list sorts by it.
CREATE INDEX IF NOT EXISTS "Customer_dormantAt_idx" ON "Customer"("dormantAt");
