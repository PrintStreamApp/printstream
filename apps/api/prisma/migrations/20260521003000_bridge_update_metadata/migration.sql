ALTER TABLE "Bridge"
ADD COLUMN "protocolVersion" INTEGER,
ADD COLUMN "runnerAbiVersion" TEXT,
ADD COLUMN "updateChannel" TEXT NOT NULL DEFAULT 'stable',
ADD COLUMN "updateStatus" TEXT,
ADD COLUMN "latestAvailableVersion" TEXT,
ADD COLUMN "lastUpdateCheckAt" TIMESTAMP(3),
ADD COLUMN "lastUpdateError" TEXT;