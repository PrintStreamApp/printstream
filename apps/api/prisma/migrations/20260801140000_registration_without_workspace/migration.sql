-- Registration creates an ACCOUNT; the workspace became optional.
--
-- A registrant now gets a customer and a way to sign in, and decides afterwards
-- what to use it for. (The column this loosens was later DROPPED outright by
-- `20260802150000_registration_account_only`, hence the guard: the reconcile
-- path replays this chain against databases already at the final schema, where
-- the column no longer exists.)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'PendingRegistration' AND column_name = 'workspaceName'
  ) THEN
    ALTER TABLE "PendingRegistration" ALTER COLUMN "workspaceName" DROP NOT NULL;
  END IF;
END $$;
