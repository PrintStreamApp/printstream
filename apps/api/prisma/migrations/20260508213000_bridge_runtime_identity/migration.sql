ALTER TABLE "Bridge"
ADD COLUMN "runtimeTokenHash" TEXT,
ADD COLUMN "version" TEXT;

CREATE INDEX "Bridge_runtimeTokenHash_idx" ON "Bridge"("runtimeTokenHash");