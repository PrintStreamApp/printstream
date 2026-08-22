-- Cloud feature-usage telemetry (issue #46): per-workspace x usage-key x UTC-day
-- counters behind the platform-admin "which features are actually used" surfaces.
-- Written only by the private cloud recorder (batched increments); OSS installs
-- never touch the table, so it stays empty there. Keys are namespaced strings
-- (`plugin:<name>` / `feature:<area>` / `view:<view>`); rows age out via the
-- FEATURE_USAGE_RETENTION_DAYS sweep.
--
-- GUARDED, like every migration after `init`: `reconcileMigrationHistory` may
-- replay this against a database that already has these objects.

CREATE TABLE IF NOT EXISTS "WorkspaceFeatureUsage" (
    "workspaceId" TEXT NOT NULL,
    "feature" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkspaceFeatureUsage_pkey" PRIMARY KEY ("workspaceId", "feature", "day")
);

-- Platform aggregates scan by key over a day window; the retention sweep scans by day alone.
CREATE INDEX IF NOT EXISTS "WorkspaceFeatureUsage_feature_day_idx" ON "WorkspaceFeatureUsage"("feature", "day");
CREATE INDEX IF NOT EXISTS "WorkspaceFeatureUsage_day_idx" ON "WorkspaceFeatureUsage"("day");

-- Postgres has no `ADD CONSTRAINT IF NOT EXISTS`; guarded by name so the name
-- matches what Prisma derives, or `migrate diff` reports drift forever after.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'WorkspaceFeatureUsage_workspaceId_fkey') THEN
    ALTER TABLE "WorkspaceFeatureUsage" ADD CONSTRAINT "WorkspaceFeatureUsage_workspaceId_fkey"
      FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
