-- AlterTable
ALTER TABLE "WorkspaceSubscription" ADD COLUMN     "billingCurrency" TEXT,
ADD COLUMN     "billingEffectsPending" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "billingQuoteId" TEXT,
ADD COLUMN     "blockPriceId" TEXT,
ADD COLUMN     "blockQuantity" INTEGER,
ADD COLUMN     "blockUnitMinor" INTEGER,
ADD COLUMN     "pricingVersionId" TEXT,
ADD COLUMN     "promoApplied" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "promoDiscountId" TEXT,
ADD COLUMN     "providerUpdatedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "SelfHostedSubscription" ADD COLUMN     "billingCurrency" TEXT,
ADD COLUMN     "billingEffectsPending" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "blockPriceId" TEXT,
ADD COLUMN     "blockQuantity" INTEGER,
ADD COLUMN     "blockUnitMinor" INTEGER,
ADD COLUMN     "pricingVersionId" TEXT,
ADD COLUMN     "promoApplied" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "promoDiscountId" TEXT,
ADD COLUMN     "providerUpdatedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "BillingPriceVersion" (
    "id" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "promoDiscountId" TEXT NOT NULL,
    "prices" JSONB NOT NULL,
    "bindings" JSONB NOT NULL,
    "effectiveAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BillingPriceVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingPricingState" (
    "id" TEXT NOT NULL,
    "activeVersionId" TEXT,
    "reviewPeriod" TEXT,
    "leaseToken" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "lastError" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BillingPricingState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingPriceReview" (
    "id" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "periodKey" TEXT,
    "status" TEXT NOT NULL,
    "baseVersionId" TEXT,
    "fingerprint" TEXT NOT NULL,
    "prices" JSONB NOT NULL,
    "currentPrices" JSONB,
    "observations" JSONB,
    "observationDate" TEXT,
    "driftBasisPoints" JSONB,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "effectiveAt" TIMESTAMP(3),
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "leaseToken" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "bindings" JSONB NOT NULL DEFAULT '[]',
    "pendingBinding" TEXT,
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "notificationOptionalDispatchedAt" TIMESTAMP(3),
    "notificationDeliveredAt" TIMESTAMP(3),
    "notificationToken" TEXT,
    "notificationUntil" TIMESTAMP(3),

    CONSTRAINT "BillingPriceReview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingSubscriptionOperation" (
    "id" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "activeSubscriptionId" TEXT,
    "product" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "desiredBlocks" INTEGER NOT NULL,
    "targetBlocks" INTEGER NOT NULL,
    "pricingVersionId" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "priceId" TEXT NOT NULL,
    "preimage" JSONB NOT NULL,
    "confirmedReceipt" JSONB,
    "effectsPending" BOOLEAN NOT NULL DEFAULT false,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submittedAt" TIMESTAMP(3),
    "confirmedAt" TIMESTAMP(3),

    CONSTRAINT "BillingSubscriptionOperation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingSubscriptionReceipt" (
    "id" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "product" TEXT NOT NULL,
    "providerUpdatedAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL,

    CONSTRAINT "BillingSubscriptionReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingNotificationOutbox" (
    "id" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),
    "leaseToken" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,

    CONSTRAINT "BillingNotificationOutbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingCheckoutQuote" (
    "id" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "product" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "targetKind" TEXT,
    "versionId" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "blockQuantity" INTEGER NOT NULL,
    "regularUnitMinor" INTEGER NOT NULL,
    "providerSnapshot" JSONB,
    "promoEligible" BOOLEAN NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "transactionId" TEXT,
    "fulfilledAt" TIMESTAMP(3),
    "fulfilledLicenseId" TEXT,
    "checkoutUrl" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BillingCheckoutQuote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BillingPriceVersion_environment_idx" ON "BillingPriceVersion"("environment");

-- CreateIndex
CREATE UNIQUE INDEX "BillingPriceReview_periodKey_key" ON "BillingPriceReview"("periodKey");

-- CreateIndex
CREATE INDEX "BillingPriceReview_environment_status_idx" ON "BillingPriceReview"("environment", "status");

-- CreateIndex
CREATE UNIQUE INDEX "BillingSubscriptionOperation_activeSubscriptionId_key" ON "BillingSubscriptionOperation"("activeSubscriptionId");

-- CreateIndex
CREATE INDEX "BillingSubscriptionOperation_environment_status_idx" ON "BillingSubscriptionOperation"("environment", "status");

-- CreateIndex
CREATE INDEX "BillingSubscriptionOperation_subscriptionId_createdAt_idx" ON "BillingSubscriptionOperation"("subscriptionId", "createdAt");

-- CreateIndex
CREATE INDEX "BillingNotificationOutbox_environment_sentAt_leaseUntil_idx" ON "BillingNotificationOutbox"("environment", "sentAt", "leaseUntil");

-- CreateIndex
CREATE UNIQUE INDEX "BillingCheckoutQuote_transactionId_key" ON "BillingCheckoutQuote"("transactionId");

-- CreateIndex
CREATE INDEX "BillingCheckoutQuote_environment_targetId_idx" ON "BillingCheckoutQuote"("environment", "targetId");

