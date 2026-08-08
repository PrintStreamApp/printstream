-- Repair databases the migration squash left short of the datamodel.
--
-- THE BUG THIS FIXES, so it is not re-introduced by the next squash:
--
-- `reconcileMigrationHistory` collapses a pre-squash `_prisma_migrations`
-- history into a single satisfied `00000000000000_init` row, so init is marked
-- applied WITHOUT running. That is correct only if the database was already at
-- the pre-squash HEAD. Any deployment sitting BEHIND that HEAD never ran the
-- migrations the squash then deleted, and no migration will ever create what
-- they would have created -- the schema is silently, permanently short.
--
-- Observed, not theorised: staging deployed the squashed chain successfully and
-- still had no `Customer` table, so `POST /api/register/start` failed with
-- P2022 `The column workspaceKind does not exist in the current database`.
-- Both hosted deployments were behind the squash point by the whole
-- customers/licensing-v2 body of work.
--
-- Everything below is guarded, so this is a no-op on a database built by init
-- (every fresh install, and every developer) and additive on one that is short.
-- It creates only what the RETIRED migrations would have; the rename migration
-- alongside it already handles Tenant -> Workspace.

-- The account above workspaces. `IF NOT EXISTS` rather than a `to_regclass`
-- guard because the whole statement is one object.
CREATE TABLE IF NOT EXISTS "Customer" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "ownerUserId" TEXT,
    "paddleCustomerId" TEXT,
    "allowWorkspaceInvites" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "CustomerMembership" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "billingRole" TEXT NOT NULL DEFAULT 'none',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomerMembership_pkey" PRIMARY KEY ("id")
);

-- Columns the retired migrations added to tables that already existed. These
-- are the ones `CREATE TABLE IF NOT EXISTS` cannot reach: the table is present,
-- so the create is skipped and the column stays missing.
ALTER TABLE "Workspace" ADD COLUMN IF NOT EXISTS "customerId" TEXT;
ALTER TABLE "Workspace" ADD COLUMN IF NOT EXISTS "kind" TEXT NOT NULL DEFAULT 'cloud';
ALTER TABLE "License" ADD COLUMN IF NOT EXISTS "customerId" TEXT;
ALTER TABLE "PendingRegistration" ADD COLUMN IF NOT EXISTS "workspaceKind" TEXT NOT NULL DEFAULT 'cloud';

CREATE UNIQUE INDEX IF NOT EXISTS "Customer_paddleCustomerId_key" ON "Customer"("paddleCustomerId");
CREATE INDEX IF NOT EXISTS "Customer_ownerUserId_idx" ON "Customer"("ownerUserId");
CREATE INDEX IF NOT EXISTS "CustomerMembership_userId_idx" ON "CustomerMembership"("userId");
CREATE UNIQUE INDEX IF NOT EXISTS "CustomerMembership_customerId_userId_key" ON "CustomerMembership"("customerId", "userId");
CREATE INDEX IF NOT EXISTS "Workspace_customerId_idx" ON "Workspace"("customerId");
CREATE INDEX IF NOT EXISTS "License_customerId_idx" ON "License"("customerId");

-- Postgres has no `ADD CONSTRAINT IF NOT EXISTS`, so each is guarded by name.
-- Named explicitly to match what Prisma derives, or `migrate diff` reports the
-- schema as drifted forever after.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Customer_ownerUserId_fkey') THEN
    ALTER TABLE "Customer" ADD CONSTRAINT "Customer_ownerUserId_fkey"
      FOREIGN KEY ("ownerUserId") REFERENCES "AuthUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CustomerMembership_customerId_fkey') THEN
    ALTER TABLE "CustomerMembership" ADD CONSTRAINT "CustomerMembership_customerId_fkey"
      FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CustomerMembership_userId_fkey') THEN
    ALTER TABLE "CustomerMembership" ADD CONSTRAINT "CustomerMembership_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "AuthUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Workspace_customerId_fkey') THEN
    ALTER TABLE "Workspace" ADD CONSTRAINT "Workspace_customerId_fkey"
      FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'License_customerId_fkey') THEN
    ALTER TABLE "License" ADD CONSTRAINT "License_customerId_fkey"
      FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- Column definitions are copied VERBATIM from init, defaults included. A
-- difference as small as an extra `DEFAULT CURRENT_TIMESTAMP` leaves the
-- repaired database permanently drifted from the datamodel, which
-- `prisma migrate diff` then reports on every future check.
