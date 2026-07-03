-- Platform billing controls: admin-comped printers (raise the Free cap, excluded
-- from Pro per-printer billing) and scheduled end-of-period cancellation.
ALTER TABLE "TenantSubscription" ADD COLUMN "compedPrinters" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "TenantSubscription" ADD COLUMN "scheduledCancelAt" TIMESTAMP(3);
