DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'Bridge'
          AND column_name = 'claimCode'
    ) AND NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'Bridge'
          AND column_name = 'connectCode'
    ) THEN
        ALTER TABLE "Bridge" RENAME COLUMN "claimCode" TO "connectCode";
    END IF;
END $$;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname = 'Bridge_claimCode_key'
    ) THEN
        ALTER INDEX "Bridge_claimCode_key" RENAME TO "Bridge_connectCode_key";
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname = 'Bridge_connectCode_key'
    ) THEN
        CREATE UNIQUE INDEX "Bridge_connectCode_key" ON "Bridge"("connectCode");
    END IF;
END $$;