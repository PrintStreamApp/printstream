-- AlterTable: bridge self-reported crash health (see bridge crash-tracker).
ALTER TABLE "Bridge" ADD COLUMN "lastCrashAt" TIMESTAMP(3);
ALTER TABLE "Bridge" ADD COLUMN "lastCrashReason" TEXT;
ALTER TABLE "Bridge" ADD COLUMN "recentCrashCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Bridge" ADD COLUMN "lastCrashNotifiedAt" TIMESTAMP(3);
