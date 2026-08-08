-- Second repair pass: the differences a column-EXISTENCE check cannot see.
--
-- `20260801220000_repair_pre_squash_customers` fixed the missing tables and
-- columns, and staging still failed to register with P2011
-- `Null constraint violation on the fields: (inviteCodeId)`. The first pass
-- compared which columns exist; it did not compare nullability, leftover
-- columns, or index names, and all three had drifted. Comparing the FULL
-- `information_schema.columns` row plus `pg_indexes` and `pg_constraint`
-- against the datamodel is what found the rest.
--
-- A separate migration rather than an edit to that one: it is already applied
-- on staging, and Prisma refuses a migration whose checksum changed after it
-- ran.
--
-- Every statement is guarded, and the two DROPs additionally refuse to run when
-- the column holds anything, so no deployment can lose data to this even if its
-- history differs from the two that were inspected.

-- Open registration made the invite code optional; that migration was retired
-- by the squash, so a pre-squash database still rejects a registration with no
-- code. Re-running `DROP NOT NULL` on an already-nullable column is a no-op.
ALTER TABLE "PendingRegistration" ALTER COLUMN "inviteCodeId" DROP NOT NULL;

DO $$
DECLARE
  bound_licenses bigint;
  bound_subscriptions bigint;
  drifted_index text;
BEGIN
  -- Licences moved from a workspace to a CUSTOMER; the column that dropped the
  -- old binding was retired by the squash. Verified empty on both hosted
  -- deployments before this was written (0 of 8 on production), but the count
  -- is re-checked HERE rather than trusted: a column with data left behind is
  -- recoverable, a dropped one is not.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'License' AND column_name = 'workspaceId'
  ) THEN
    EXECUTE 'SELECT count("workspaceId") FROM "License"' INTO bound_licenses;
    IF bound_licenses = 0 THEN
      ALTER TABLE "License" DROP COLUMN "workspaceId";
    ELSE
      RAISE WARNING 'License.workspaceId still binds % licence(s); left in place for manual migration to customerId', bound_licenses;
    END IF;
  END IF;

  -- Same story: the Paddle customer moved onto `Customer`, so one person with
  -- several workspaces has one payment method rather than one per workspace.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'WorkspaceSubscription' AND column_name = 'paddleCustomerId'
  ) THEN
    EXECUTE 'SELECT count("paddleCustomerId") FROM "WorkspaceSubscription"' INTO bound_subscriptions;
    IF bound_subscriptions = 0 THEN
      ALTER TABLE "WorkspaceSubscription" DROP COLUMN "paddleCustomerId";
    ELSE
      RAISE WARNING 'WorkspaceSubscription.paddleCustomerId still set on % row(s); left in place for manual migration to Customer.paddleCustomerId', bound_subscriptions;
    END IF;
  END IF;

  -- Postgres truncates an identifier at 63 bytes. The rename migration built
  -- this index name by substituting `tenantId` -> `workspaceId`, which is
  -- longer, so the truncation landed somewhere other than where Prisma derives
  -- it. THREE names were observed in the wild for one index -- the canonical
  -- `..._hidden__idx` that `init` creates, plus `..._hidden_uplo` on staging
  -- and `..._hidden_upl_` on a developer machine -- because the substitution
  -- truncated differently depending on the pre-rename name it started from.
  -- Harmless at runtime, and permanent drift in `migrate diff`, which is how a
  -- real difference gets lost in the noise. Renames whichever variant is
  -- present to the one the datamodel expects.
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE schemaname = 'public'
    AND indexname = 'LibraryFile_workspaceId_ownerBridgeId_folderId_name_hidden__idx'
  ) THEN
    FOR drifted_index IN
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname LIKE 'LibraryFile_workspaceId_ownerBridgeId_folderId_name_hidden%'
        AND indexname <> 'LibraryFile_workspaceId_ownerBridgeId_folderId_name_hidden__idx'
    LOOP
      EXECUTE format(
        'ALTER INDEX %I RENAME TO %I',
        drifted_index,
        'LibraryFile_workspaceId_ownerBridgeId_folderId_name_hidden__idx'
      );
      EXIT;
    END LOOP;
  END IF;
END $$;
