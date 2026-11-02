-- Extend the cloud-only durable subscription ledger; existing operations remain quantities.
ALTER TABLE "BillingSubscriptionOperation"
  ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'quantity',
  ADD COLUMN "sourcePricingVersionId" TEXT,
  ADD COLUMN "targetUnitMinor" INTEGER;

-- Historical approvals do not acquire a new subscriber-migration scope implicitly.
ALTER TABLE "BillingPriceVersion" ADD COLUMN "priceReductionPolicy" TEXT;
