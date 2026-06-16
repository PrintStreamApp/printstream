CREATE TABLE "OrderTemplateVariant" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderTemplateVariant_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "OrderTemplatePrint"
ADD COLUMN "templateVariantId" TEXT;

INSERT INTO "OrderTemplateVariant" ("id", "tenantId", "templateId", "name", "position", "createdAt", "updatedAt")
SELECT
    'template-variant-' || "OrderTemplate"."id",
    "OrderTemplate"."tenantId",
    "OrderTemplate"."id",
    'Default',
    0,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "OrderTemplate";

UPDATE "OrderTemplatePrint"
SET "templateVariantId" = 'template-variant-' || "templateId"
WHERE "templateVariantId" IS NULL;

ALTER TABLE "OrderPrint"
ADD COLUMN "templateVariantId" TEXT,
ADD COLUMN "templateVariantName" TEXT;

UPDATE "OrderPrint"
SET
    "templateVariantId" = "OrderTemplatePrint"."templateVariantId",
    "templateVariantName" = "OrderTemplateVariant"."name"
FROM "OrderTemplatePrint"
LEFT JOIN "OrderTemplateVariant"
    ON "OrderTemplateVariant"."id" = "OrderTemplatePrint"."templateVariantId"
WHERE "OrderPrint"."templatePrintId" = "OrderTemplatePrint"."id";

CREATE TABLE "OrderVariantSelection" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "templateVariantId" TEXT,
    "templateVariantName" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "position" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderVariantSelection_pkey" PRIMARY KEY ("id")
);

INSERT INTO "OrderVariantSelection" (
    "id",
    "tenantId",
    "orderId",
    "templateVariantId",
    "templateVariantName",
    "quantity",
    "position",
    "createdAt",
    "updatedAt"
)
SELECT
    'order-variant-selection-' || "Order"."id",
    "Order"."tenantId",
    "Order"."id",
    'template-variant-' || "Order"."templateId",
    COALESCE("OrderTemplateVariant"."name", 'Default'),
    1,
    0,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "Order"
LEFT JOIN "OrderTemplateVariant"
    ON "OrderTemplateVariant"."id" = 'template-variant-' || "Order"."templateId"
WHERE "Order"."templateId" IS NOT NULL;

ALTER TABLE "OrderTemplatePrint"
ALTER COLUMN "templateVariantId" SET NOT NULL;

ALTER TABLE "OrderTemplatePrint" DROP CONSTRAINT "OrderTemplatePrint_templateId_fkey";

ALTER TABLE "OrderTemplatePrint"
ADD CONSTRAINT "OrderTemplatePrint_templateVariantId_fkey"
FOREIGN KEY ("templateVariantId") REFERENCES "OrderTemplateVariant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "OrderTemplateVariant"
ADD CONSTRAINT "OrderTemplateVariant_tenantId_fkey"
FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "OrderTemplateVariant"
ADD CONSTRAINT "OrderTemplateVariant_templateId_fkey"
FOREIGN KEY ("templateId") REFERENCES "OrderTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "OrderVariantSelection"
ADD CONSTRAINT "OrderVariantSelection_tenantId_fkey"
FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "OrderVariantSelection"
ADD CONSTRAINT "OrderVariantSelection_orderId_fkey"
FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "OrderVariantSelection"
ADD CONSTRAINT "OrderVariantSelection_templateVariantId_fkey"
FOREIGN KEY ("templateVariantId") REFERENCES "OrderTemplateVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "OrderPrint"
ADD CONSTRAINT "OrderPrint_templateVariantId_fkey"
FOREIGN KEY ("templateVariantId") REFERENCES "OrderTemplateVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

DROP INDEX "OrderTemplatePrint_tenantId_templateId_position_idx";

ALTER TABLE "OrderTemplatePrint" DROP COLUMN "templateId";

CREATE INDEX "OrderTemplateVariant_tenantId_templateId_position_idx" ON "OrderTemplateVariant"("tenantId", "templateId", "position");
CREATE INDEX "OrderTemplatePrint_tenantId_templateVariantId_position_idx" ON "OrderTemplatePrint"("tenantId", "templateVariantId", "position");
CREATE INDEX "OrderVariantSelection_tenantId_orderId_position_idx" ON "OrderVariantSelection"("tenantId", "orderId", "position");
CREATE INDEX "OrderVariantSelection_tenantId_templateVariantId_idx" ON "OrderVariantSelection"("tenantId", "templateVariantId");
CREATE INDEX "OrderPrint_tenantId_templateVariantId_idx" ON "OrderPrint"("tenantId", "templateVariantId");