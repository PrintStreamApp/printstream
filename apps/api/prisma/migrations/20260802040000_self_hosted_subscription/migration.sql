-- Self-hosted Pro's own metered subscription, and the per-install licence binding.
--
-- GUARDED, like every migration after `init`, and not as a style choice:
-- `reconcileMigrationHistory` collapses a pre-squash history into a satisfied
-- `init` row and then applies everything recorded after it — against a database
-- that may already have those objects. An unguarded statement here fails the
-- deploy for exactly the deployments the reconcile path exists to rescue.
-- `apply-migrations.test.ts` replays that path, and caught this file unguarded.

CREATE TABLE IF NOT EXISTS "SelfHostedSubscription" (
    "id" TEXT NOT NULL,
    "licenseId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "paddleSubscriptionId" TEXT,
    "priceId" TEXT,
    "printerQuantity" INTEGER NOT NULL DEFAULT 0,
    "currentPeriodEnd" TIMESTAMP(3),
    "canceledAt" TIMESTAMP(3),
    "scheduledCancelAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SelfHostedSubscription_pkey" PRIMARY KEY ("id")
);

-- The install a licence is bound to. Null until first activation, so a key can
-- be released to a new machine by clearing it.
ALTER TABLE "License" ADD COLUMN IF NOT EXISTS "installationId" TEXT;
ALTER TABLE "License" ADD COLUMN IF NOT EXISTS "installationBoundAt" TIMESTAMP(3);

CREATE UNIQUE INDEX IF NOT EXISTS "SelfHostedSubscription_licenseId_key" ON "SelfHostedSubscription"("licenseId");
CREATE UNIQUE INDEX IF NOT EXISTS "SelfHostedSubscription_paddleSubscriptionId_key" ON "SelfHostedSubscription"("paddleSubscriptionId");
CREATE INDEX IF NOT EXISTS "License_installationId_idx" ON "License"("installationId");

-- Postgres has no `ADD CONSTRAINT IF NOT EXISTS`; guarded by name so the name
-- matches what Prisma derives, or `migrate diff` reports drift forever after.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SelfHostedSubscription_licenseId_fkey') THEN
    ALTER TABLE "SelfHostedSubscription" ADD CONSTRAINT "SelfHostedSubscription_licenseId_fkey"
      FOREIGN KEY ("licenseId") REFERENCES "License"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
