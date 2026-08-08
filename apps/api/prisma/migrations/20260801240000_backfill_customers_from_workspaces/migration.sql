-- Give every pre-existing workspace the Customer the squash forgot to create.
--
-- The third and largest instance of one root cause: the squash retired the
-- migrations that introduced customers, so a database that was behind the
-- squash point has the TABLES (restored by the two repair migrations before
-- this) and no ROWS. Observed on staging after both repairs: zero `Customer`
-- rows and every `Workspace.customerId` null.
--
-- That is not cosmetic. `listUserCustomers` reads `CustomerMembership`, so with
-- no rows every existing cloud customer loses their billing scope outright --
-- no plan management, no payment method, no invoices, no licences -- while
-- their workspaces keep working. On production that is 17 workspaces.
--
-- OWNERSHIP RULE: the earliest admin of the workspace, by membership date.
-- 15 of 17 production workspaces have exactly one admin, so there is nothing to
-- choose. The two with two admins resolve correctly by date -- the second admin
-- in each is the other party helping out, not the owner -- but this is the one
-- judgement in the file, and it decides who controls a real customer's payment
-- method. Verify the two multi-admin cases before running this on production.
--
-- ONE CUSTOMER PER OWNER, not per workspace. A person who owns two workspaces
-- must end up with one account holding both; minting one per workspace is
-- exactly the duplicate-account problem accounts were introduced to prevent.
--
-- PLATFORM USERS CAN OWN, but are never swept in as members. Those are two
-- different questions and conflating them got the answer wrong: excluding
-- platform users from ownership too would have handed the operator's OWN
-- workspace to the next admin along -- on production, the second admin of
-- `ewen` is the owner of a different customer's business. Support access is why
-- a platform user appears in someone else's workspace; it is not why they
-- appear in their own.
--
-- Idempotent: it only ever fills a null `customerId`, so re-running does
-- nothing and a database built by init (which has no workspaces) skips it.

DO $$
DECLARE
  owner_row RECORD;
  workspace_row RECORD;
  new_customer_id TEXT;
  bound_subscriptions BIGINT;
BEGIN
  -- One pass per prospective owner, so every workspace they own lands on the
  -- same Customer.
  FOR owner_row IN
    SELECT DISTINCT ON (owner_id) owner_id, display_name, email
    FROM (
      SELECT DISTINCT ON (w.id)
        w.id AS workspace_id, u.id AS owner_id, u."displayName" AS display_name, u.email AS email
      FROM "Workspace" w
      JOIN "AuthWorkspaceMembership" m ON m."workspaceId" = w.id
      JOIN "AuthUser" u ON u.id = m."userId"
      JOIN "AuthUserGroupMembership" ug ON ug."userId" = u.id
      JOIN "AuthGroup" g ON g.id = ug."groupId" AND g."workspaceId" = w.id AND g.key = 'admin'
      WHERE w."customerId" IS NULL
      ORDER BY w.id, m."createdAt" ASC, u.id ASC
    ) owners
    ORDER BY owner_id
  LOOP
    -- Reuse an account they already own before minting one, so a partial run
    -- cannot leave one person holding two.
    SELECT id INTO new_customer_id FROM "Customer"
    WHERE "ownerUserId" = owner_row.owner_id ORDER BY "createdAt" ASC LIMIT 1;

    IF new_customer_id IS NULL THEN
      new_customer_id := 'cus_' || replace(gen_random_uuid()::text, '-', '');
      INSERT INTO "Customer" ("id", "name", "ownerUserId", "allowWorkspaceInvites", "createdAt", "updatedAt")
      VALUES (
        new_customer_id,
        -- Mirrors `customerNameForOwner`: the person, not the workspace.
        COALESCE(NULLIF(btrim(owner_row.display_name), ''), NULLIF(btrim(owner_row.email), ''), 'My account'),
        owner_row.owner_id,
        true,
        now(),
        now()
      );
    END IF;

    INSERT INTO "CustomerMembership" ("id", "customerId", "userId", "billingRole", "createdAt")
    VALUES ('cmb_' || replace(gen_random_uuid()::text, '-', ''), new_customer_id, owner_row.owner_id, 'billing', now())
    ON CONFLICT ("customerId", "userId") DO NOTHING;

    -- Every workspace whose earliest admin is this person.
    FOR workspace_row IN
      SELECT workspace_id FROM (
        SELECT DISTINCT ON (w.id) w.id AS workspace_id, u.id AS owner_id
        FROM "Workspace" w
        JOIN "AuthWorkspaceMembership" m ON m."workspaceId" = w.id
        JOIN "AuthUser" u ON u.id = m."userId"
        JOIN "AuthUserGroupMembership" ug ON ug."userId" = u.id
        JOIN "AuthGroup" g ON g.id = ug."groupId" AND g."workspaceId" = w.id AND g.key = 'admin'
        WHERE w."customerId" IS NULL
        ORDER BY w.id, m."createdAt" ASC, u.id ASC
      ) resolved
      WHERE owner_id = owner_row.owner_id
    LOOP
      UPDATE "Workspace" SET "customerId" = new_customer_id WHERE id = workspace_row.workspace_id;

      -- Everyone else in the workspace joins the organisation WITHOUT billing,
      -- matching `joinWorkspaceOrganisationMembership`: being in a workspace
      -- has never granted sight of the card.
      INSERT INTO "CustomerMembership" ("id", "customerId", "userId", "billingRole", "createdAt")
      SELECT 'cmb_' || replace(gen_random_uuid()::text, '-', ''), new_customer_id, m."userId", 'none', now()
      FROM "AuthWorkspaceMembership" m
      JOIN "AuthUser" u ON u.id = m."userId"
      WHERE m."workspaceId" = workspace_row.workspace_id AND u."isPlatformUser" = false
      ON CONFLICT ("customerId", "userId") DO NOTHING;
    END LOOP;
  END LOOP;

  -- The payment method moves from the subscription to the account, which is the
  -- whole point of accounts: one card for a person with several workspaces.
  -- Done here rather than in the previous migration because that one could only
  -- decline to drop the column -- there was nowhere to put the value until the
  -- Customer rows above existed.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'WorkspaceSubscription' AND column_name = 'paddleCustomerId'
  ) THEN
    EXECUTE '
      UPDATE "Customer" c
      SET "paddleCustomerId" = s."paddleCustomerId"
      FROM "WorkspaceSubscription" s
      JOIN "Workspace" w ON w.id = s."workspaceId"
      WHERE w."customerId" = c.id
        AND s."paddleCustomerId" IS NOT NULL
        AND c."paddleCustomerId" IS NULL';

    EXECUTE 'SELECT count(s."paddleCustomerId") FROM "WorkspaceSubscription" s
             JOIN "Workspace" w ON w.id = s."workspaceId"
             LEFT JOIN "Customer" c ON c.id = w."customerId"
             WHERE s."paddleCustomerId" IS NOT NULL
               AND (c.id IS NULL OR c."paddleCustomerId" IS DISTINCT FROM s."paddleCustomerId")'
      INTO bound_subscriptions;

    IF bound_subscriptions = 0 THEN
      ALTER TABLE "WorkspaceSubscription" DROP COLUMN "paddleCustomerId";
    ELSE
      RAISE WARNING 'WorkspaceSubscription.paddleCustomerId could not be moved for % row(s); column left in place', bound_subscriptions;
    END IF;
  END IF;
END $$;
