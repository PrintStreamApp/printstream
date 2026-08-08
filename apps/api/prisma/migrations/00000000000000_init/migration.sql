-- PrintStream initial schema.
--
-- This migration replaces the 66 migrations that preceded it (see git history
-- before the squash). It is the whole schema from empty, so `prisma migrate
-- deploy` now works on a fresh database and the shadow-database workflows
-- (`migrate dev`, `migrate diff --from-migrations`) work again.
--
-- Databases created BEFORE the squash carry the old 66 rows in
-- `_prisma_migrations`; they are collapsed onto this one row, without re-running
-- anything, by `reconcileMigrationHistory` (apps/api/src/lib/apply-migrations.ts)
-- and the matching step in scripts/bootstrap-prisma-migrations.mjs.

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "Customer" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "ownerUserId" TEXT,
    "paddleCustomerId" TEXT,
    "allowWorkspaceInvites" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerMembership" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "billingRole" TEXT NOT NULL DEFAULT 'none',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomerMembership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Workspace" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'cloud',
    "customerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Workspace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkspaceSubscription" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "plan" TEXT NOT NULL DEFAULT 'free',
    "status" TEXT NOT NULL DEFAULT 'active',
    "paddleSubscriptionId" TEXT,
    "priceId" TEXT,
    "printerQuantity" INTEGER NOT NULL DEFAULT 0,
    "compedPrinters" INTEGER NOT NULL DEFAULT 0,
    "currentPeriodEnd" TIMESTAMP(3),
    "canceledAt" TIMESTAMP(3),
    "scheduledCancelAt" TIMESTAMP(3),
    "compedByUserId" TEXT,
    "compedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkspaceSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "License" (
    "id" TEXT NOT NULL,
    "edition" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'purchase',
    "customerId" TEXT,
    "licensee" TEXT NOT NULL,
    "email" TEXT,
    "key" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "paddleCustomerId" TEXT,
    "paddleTransactionId" TEXT,
    "updatesUntil" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "maxPrinters" INTEGER,
    "lastRefreshedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "License_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Printer" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "bridgeId" TEXT,
    "name" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "serial" TEXT NOT NULL,
    "accessCode" TEXT NOT NULL,
    "model" TEXT NOT NULL DEFAULT 'unknown',
    "currentPlateType" TEXT,
    "currentNozzleDiameters" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Printer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Bridge" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT,
    "name" TEXT NOT NULL,
    "connectCode" TEXT,
    "runtimeTokenHash" TEXT,
    "installationId" TEXT,
    "version" TEXT,
    "buildRevision" TEXT,
    "sourceFingerprint" TEXT,
    "releaseFingerprint" TEXT,
    "protocolVersion" INTEGER,
    "runnerAbiVersion" TEXT,
    "updateChannel" TEXT NOT NULL DEFAULT 'stable',
    "updateStatus" TEXT,
    "latestAvailableVersion" TEXT,
    "lastUpdateCheckAt" TIMESTAMP(3),
    "lastUpdateError" TEXT,
    "lastSeenAt" TIMESTAMP(3),
    "lastCrashAt" TIMESTAMP(3),
    "lastCrashReason" TEXT,
    "recentCrashCount" INTEGER NOT NULL DEFAULT 0,
    "lastCrashNotifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Bridge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PrintJob" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "printerId" TEXT NOT NULL,
    "taskId" TEXT,
    "printerFilePath" TEXT,
    "jobName" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL DEFAULT 'library',
    "calibrationOption" INTEGER,
    "fileId" TEXT,
    "fileName" TEXT,
    "fileSizeBytes" INTEGER,
    "sourceProjectFileId" TEXT,
    "sliceSettingsJson" TEXT,
    "plate" INTEGER,
    "useAms" BOOLEAN,
    "bedLevel" BOOLEAN,
    "amsMapping" TEXT,
    "progressPercent" INTEGER,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "durationSeconds" INTEGER,
    "result" TEXT NOT NULL DEFAULT 'unknown',
    "thumbnailPath" TEXT,
    "snapshotPath" TEXT,
    "filamentUsedGrams" DECIMAL(14,3),
    "filamentUsedMeters" DECIMAL(14,3),
    "printerStatsRecordedAt" TIMESTAMP(3),

    CONSTRAINT "PrintJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DispatchJob" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "printerId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "jobName" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "remoteName" TEXT NOT NULL,
    "error" TEXT,
    "startCommandAttemptedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "DispatchJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkspaceStats" (
    "workspaceId" TEXT NOT NULL,
    "totalPrints" INTEGER NOT NULL DEFAULT 0,
    "successfulPrints" INTEGER NOT NULL DEFAULT 0,
    "failedPrints" INTEGER NOT NULL DEFAULT 0,
    "cancelledPrints" INTEGER NOT NULL DEFAULT 0,
    "successfulPrintDurationSeconds" INTEGER NOT NULL DEFAULT 0,
    "failedPrintDurationSeconds" INTEGER NOT NULL DEFAULT 0,
    "cancelledPrintDurationSeconds" INTEGER NOT NULL DEFAULT 0,
    "wastedPrintDurationSeconds" INTEGER NOT NULL DEFAULT 0,
    "trackedFilamentPrints" INTEGER NOT NULL DEFAULT 0,
    "filamentUsedGrams" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "successfulFilamentUsedGrams" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "failedFilamentUsedGrams" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "cancelledFilamentUsedGrams" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "wastedFilamentUsedGrams" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "filamentUsedMeters" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "successfulFilamentUsedMeters" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "failedFilamentUsedMeters" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "cancelledFilamentUsedMeters" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "wastedFilamentUsedMeters" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkspaceStats_pkey" PRIMARY KEY ("workspaceId")
);

-- CreateTable
CREATE TABLE "PlatformStats" (
    "id" TEXT NOT NULL,
    "workspaceCount" INTEGER NOT NULL DEFAULT 0,
    "userCount" INTEGER NOT NULL DEFAULT 0,
    "printerCount" INTEGER NOT NULL DEFAULT 0,
    "totalPrints" INTEGER NOT NULL DEFAULT 0,
    "successfulPrintDurationSeconds" INTEGER NOT NULL DEFAULT 0,
    "failedPrintDurationSeconds" INTEGER NOT NULL DEFAULT 0,
    "cancelledPrintDurationSeconds" INTEGER NOT NULL DEFAULT 0,
    "wastedPrintDurationSeconds" INTEGER NOT NULL DEFAULT 0,
    "trackedFilamentPrints" INTEGER NOT NULL DEFAULT 0,
    "filamentUsedGrams" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "successfulFilamentUsedGrams" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "failedFilamentUsedGrams" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "cancelledFilamentUsedGrams" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "wastedFilamentUsedGrams" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "filamentUsedMeters" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "successfulFilamentUsedMeters" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "failedFilamentUsedMeters" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "cancelledFilamentUsedMeters" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "wastedFilamentUsedMeters" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlatformStats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PrinterStats" (
    "workspaceId" TEXT NOT NULL,
    "printerSerial" TEXT NOT NULL,
    "manualTotalPrints" INTEGER NOT NULL DEFAULT 0,
    "manualPrintDurationSeconds" INTEGER NOT NULL DEFAULT 0,
    "totalPrints" INTEGER NOT NULL DEFAULT 0,
    "successfulPrints" INTEGER NOT NULL DEFAULT 0,
    "failedPrints" INTEGER NOT NULL DEFAULT 0,
    "cancelledPrints" INTEGER NOT NULL DEFAULT 0,
    "successfulPrintDurationSeconds" INTEGER NOT NULL DEFAULT 0,
    "failedPrintDurationSeconds" INTEGER NOT NULL DEFAULT 0,
    "cancelledPrintDurationSeconds" INTEGER NOT NULL DEFAULT 0,
    "wastedPrintDurationSeconds" INTEGER NOT NULL DEFAULT 0,
    "trackedFilamentPrints" INTEGER NOT NULL DEFAULT 0,
    "filamentUsedGrams" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "successfulFilamentUsedGrams" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "failedFilamentUsedGrams" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "cancelledFilamentUsedGrams" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "wastedFilamentUsedGrams" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "filamentUsedMeters" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "successfulFilamentUsedMeters" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "failedFilamentUsedMeters" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "cancelledFilamentUsedMeters" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "wastedFilamentUsedMeters" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PrinterStats_pkey" PRIMARY KEY ("workspaceId","printerSerial")
);

-- CreateTable
CREATE TABLE "LibraryFile" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "ownerBridgeId" TEXT,
    "name" TEXT NOT NULL,
    "storedPath" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "thumbnailPath" TEXT,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "currentVersionNumber" INTEGER NOT NULL DEFAULT 1,
    "folderId" TEXT,
    "snapshotKey" TEXT,
    "hidden" BOOLEAN NOT NULL DEFAULT false,
    "deletedAt" TIMESTAMP(3),
    "origin" TEXT,
    "createdById" TEXT,
    "createdByName" TEXT,
    "restoredFromVersionNumber" INTEGER,
    "derivedChipsJson" TEXT,
    "derivedChipsVersion" INTEGER,
    "printCount" INTEGER NOT NULL DEFAULT 0,
    "lastPrintedAt" TIMESTAMP(3),
    "sourceProjectFileId" TEXT,
    "sliceSettingsJson" TEXT,

    CONSTRAINT "LibraryFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LibraryFileFavorite" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "libraryFileId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LibraryFileFavorite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LibraryFileVersion" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "libraryFileId" TEXT NOT NULL,
    "ownerBridgeId" TEXT,
    "folderId" TEXT,
    "name" TEXT NOT NULL,
    "storedPath" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'other',
    "thumbnailPath" TEXT,
    "uploadedAt" TIMESTAMP(3) NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,
    "createdByName" TEXT,
    "restoredFromVersionNumber" INTEGER,

    CONSTRAINT "LibraryFileVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LibraryDownloadLink" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "libraryFileId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,

    CONSTRAINT "LibraryDownloadLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LibraryFolder" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "ownerBridgeId" TEXT,
    "name" TEXT NOT NULL,
    "parentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LibraryFolder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LibraryFileReplica" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "libraryFileId" TEXT NOT NULL,
    "bridgeId" TEXT NOT NULL,
    "storedPath" TEXT NOT NULL,
    "contentHash" TEXT,
    "sizeBytes" INTEGER NOT NULL,
    "replicaKind" TEXT NOT NULL DEFAULT 'cache',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "lastVerifiedAt" TIMESTAMP(3),
    "lastAccessedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LibraryFileReplica_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Setting" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,

    CONSTRAINT "Setting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "PrinterView" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "printerIds" TEXT,
    "cardsPerRow" INTEGER NOT NULL DEFAULT 3,
    "stateFilter" TEXT NOT NULL DEFAULT 'all',
    "modelFilter" TEXT NOT NULL DEFAULT '[]',
    "nozzleDiameterFilter" TEXT NOT NULL DEFAULT '[]',
    "plateTypeFilter" TEXT NOT NULL DEFAULT '[]',
    "sortKey" TEXT NOT NULL DEFAULT 'name',
    "sortDirection" TEXT NOT NULL DEFAULT 'asc',
    "group" TEXT NOT NULL DEFAULT 'none',
    "cardContentSettings" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PrinterView_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Plugin" (
    "name" TEXT NOT NULL,
    "version" TEXT,
    "description" TEXT,
    "source" TEXT NOT NULL,
    "installPath" TEXT NOT NULL,
    "entryPath" TEXT NOT NULL,
    "installedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Plugin_pkey" PRIMARY KEY ("name")
);

-- CreateTable
CREATE TABLE "AuthUser" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "displayName" TEXT,
    "isPlatformUser" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AuthUser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuthWorkspaceMembership" (
    "userId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "loginDisabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AuthWorkspaceMembership_pkey" PRIMARY KEY ("userId","workspaceId")
);

-- CreateTable
CREATE TABLE "AuthGroup" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT,
    "key" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "permissions" TEXT[],
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "isEditable" BOOLEAN NOT NULL DEFAULT true,
    "isRemovable" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AuthGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuthUserGroupMembership" (
    "userId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuthUserGroupMembership_pkey" PRIMARY KEY ("userId","groupId")
);

-- CreateTable
CREATE TABLE "AuthServiceAccount" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "tokenPrefix" TEXT NOT NULL,
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AuthServiceAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuthServiceAccountGroupMembership" (
    "serviceAccountId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuthServiceAccountGroupMembership_pkey" PRIMARY KEY ("serviceAccountId","groupId")
);

-- CreateTable
CREATE TABLE "AuthPasskeyCredential" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL,
    "publicKey" BYTEA NOT NULL,
    "transports" TEXT[],
    "counter" INTEGER NOT NULL DEFAULT 0,
    "aaguid" TEXT,
    "backedUp" BOOLEAN NOT NULL DEFAULT false,
    "nickname" TEXT,
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AuthPasskeyCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuthPasswordCredential" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
    "resetTokenHash" TEXT,
    "resetTokenExpiresAt" TIMESTAMP(3),
    "lastChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AuthPasswordCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuthEmailCodeToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "email" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "redirectTo" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuthEmailCodeToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuthSession" (
    "id" TEXT NOT NULL,
    "secretHash" TEXT NOT NULL,
    "userId" TEXT,
    "serviceAccountId" TEXT,
    "userAgent" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuthSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT,
    "actorType" TEXT NOT NULL,
    "actorUserId" TEXT,
    "actorServiceAccountId" TEXT,
    "actorLabel" TEXT,
    "requestMethod" TEXT NOT NULL,
    "requestPath" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "statusCode" INTEGER NOT NULL,
    "ipAddress" TEXT,
    "metadataJson" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderTemplate" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "description" TEXT,
    "notesTemplate" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderTemplateVariant" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderTemplateVariant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderTemplatePrint" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "templateVariantId" TEXT NOT NULL,
    "libraryFileId" TEXT,
    "libraryFileName" TEXT NOT NULL,
    "plate" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL,
    "notes" TEXT,
    "position" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderTemplatePrint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "templateId" TEXT,
    "templateName" TEXT NOT NULL,
    "templateCode" TEXT,
    "templateDescription" TEXT,
    "name" TEXT NOT NULL,
    "notes" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderVariantSelection" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "templateVariantId" TEXT,
    "templateVariantName" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "position" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderVariantSelection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderPrint" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "templatePrintId" TEXT,
    "templateVariantId" TEXT,
    "templateVariantName" TEXT,
    "projectFilamentOverrides" JSONB,
    "libraryFileId" TEXT,
    "libraryFileName" TEXT NOT NULL,
    "plate" INTEGER NOT NULL,
    "notes" TEXT,
    "groupPosition" INTEGER NOT NULL,
    "sequenceNumber" INTEGER NOT NULL,
    "sequenceCount" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "completionSource" TEXT,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "startedPrinterId" TEXT,
    "startedAt" TIMESTAMP(3),
    "lastPrintJobId" TEXT,
    "lastPrintResult" TEXT,
    "lastPrintFinishedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderPrint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FilamentSpool" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "brand" TEXT,
    "filamentType" TEXT NOT NULL,
    "materialSubtype" TEXT,
    "colorName" TEXT,
    "colorHex" TEXT,
    "colorsJson" TEXT,
    "trayInfoIdx" TEXT,
    "bambuUuid" TEXT,
    "slicingPresetName" TEXT,
    "serial" TEXT,
    "nozzleTempMin" INTEGER,
    "nozzleTempMax" INTEGER,
    "diameterMm" DOUBLE PRECISION NOT NULL DEFAULT 1.75,
    "netWeightGrams" INTEGER NOT NULL DEFAULT 1000,
    "spoolCoreGrams" INTEGER,
    "remainingGrams" DOUBLE PRECISION NOT NULL DEFAULT 1000,
    "remainSource" TEXT NOT NULL DEFAULT 'manual',
    "costCents" INTEGER,
    "currency" TEXT,
    "purchasedAt" TIMESTAMP(3),
    "vendor" TEXT,
    "notes" TEXT,
    "loadedPrinterId" TEXT,
    "loadedAmsId" INTEGER,
    "loadedSlotId" INTEGER,
    "loadedAt" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3),

    CONSTRAINT "FilamentSpool_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FilamentSpoolUsage" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "spoolId" TEXT NOT NULL,
    "jobId" TEXT,
    "grams" DOUBLE PRECISION NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'print',
    "note" TEXT,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FilamentSpoolUsage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CalibrationRun" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'slicing',
    "printerId" TEXT,
    "printerModel" TEXT NOT NULL,
    "nozzleDiameter" TEXT NOT NULL,
    "amsId" INTEGER,
    "slotId" INTEGER,
    "spoolId" TEXT,
    "brand" TEXT,
    "filamentType" TEXT,
    "materialSubtype" TEXT,
    "colorName" TEXT,
    "parametersJson" JSONB NOT NULL,
    "slicingJobId" TEXT,
    "outputFileId" TEXT,
    "errorMessage" TEXT,
    "measuredJson" JSONB,
    "resultValue" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CalibrationRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CalibrationResult" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "printerModel" TEXT NOT NULL,
    "nozzleDiameter" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "spoolId" TEXT,
    "brand" TEXT,
    "filamentType" TEXT,
    "materialSubtype" TEXT,
    "colorName" TEXT,
    "runId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CalibrationResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QueueItem" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "libraryFileId" TEXT,
    "fileName" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'gcode',
    "plateIndex" INTEGER NOT NULL DEFAULT 1,
    "plateName" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "completedCount" INTEGER NOT NULL DEFAULT 0,
    "sortKey" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "targetKind" TEXT NOT NULL DEFAULT 'any',
    "targetPrinterId" TEXT,
    "targetModel" TEXT,
    "printOptionsJson" TEXT,
    "amsMappingJson" TEXT,
    "requiredFilamentsJson" TEXT,
    "compatibleModelsJson" TEXT,
    "plateType" TEXT,
    "nozzleDiametersJson" TEXT,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "label" TEXT,
    "createdById" TEXT,
    "orderId" TEXT,
    "orderPrintId" TEXT,
    "lastPrinterId" TEXT,
    "lastDispatchJobId" TEXT,
    "lastPrintJobId" TEXT,
    "lastJobName" TEXT,
    "lastResult" TEXT,
    "lastDispatchedAt" TIMESTAMP(3),
    "lastFinishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QueueItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportConversation" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "userId" TEXT,
    "userEmail" TEXT,
    "userName" TEXT,
    "workspaceId" TEXT,
    "workspaceName" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "assignedToUserId" TEXT,
    "assignedToName" TEXT,
    "lastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userLastReadAt" TIMESTAMP(3),
    "platformLastReadAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupportConversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportMessage" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "senderUserId" TEXT,
    "senderName" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "pageUrl" TEXT,
    "appVersion" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupportMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportPendingEmail" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "recipientSide" TEXT NOT NULL,
    "sendAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupportPendingEmail_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportAttachment" (
    "id" TEXT NOT NULL,
    "messageId" TEXT,
    "uploaderUserId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "data" BYTEA,
    "storedPath" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupportAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Suggestion" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "authorUserId" TEXT,
    "authorName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Suggestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SuggestionVote" (
    "suggestionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "value" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SuggestionVote_pkey" PRIMARY KEY ("suggestionId","userId")
);

-- CreateTable
CREATE TABLE "SuggestionComment" (
    "id" TEXT NOT NULL,
    "suggestionId" TEXT NOT NULL,
    "parentId" TEXT,
    "authorUserId" TEXT,
    "authorName" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SuggestionComment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BetaInviteCode" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "note" TEXT,
    "disabled" BOOLEAN NOT NULL DEFAULT false,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "usedAt" TIMESTAMP(3),
    "usedByEmail" TEXT,
    "usedByWorkspaceId" TEXT,
    "issuedToEmail" TEXT,

    CONSTRAINT "BetaInviteCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PendingRegistration" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "displayName" TEXT,
    "workspaceName" TEXT NOT NULL,
    "inviteCodeId" TEXT,
    "workspaceKind" TEXT NOT NULL DEFAULT 'cloud',
    "codeHash" TEXT NOT NULL,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PendingRegistration_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Customer_paddleCustomerId_key" ON "Customer"("paddleCustomerId");

-- CreateIndex
CREATE INDEX "Customer_ownerUserId_idx" ON "Customer"("ownerUserId");

-- CreateIndex
CREATE INDEX "CustomerMembership_userId_idx" ON "CustomerMembership"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerMembership_customerId_userId_key" ON "CustomerMembership"("customerId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "Workspace_slug_key" ON "Workspace"("slug");

-- CreateIndex
CREATE INDEX "Workspace_customerId_idx" ON "Workspace"("customerId");

-- CreateIndex
CREATE UNIQUE INDEX "Workspace_name_key" ON "Workspace"("name");

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceSubscription_workspaceId_key" ON "WorkspaceSubscription"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceSubscription_paddleSubscriptionId_key" ON "WorkspaceSubscription"("paddleSubscriptionId");

-- CreateIndex
CREATE UNIQUE INDEX "License_paddleTransactionId_key" ON "License"("paddleTransactionId");

-- CreateIndex
CREATE INDEX "License_email_idx" ON "License"("email");

-- CreateIndex
CREATE INDEX "License_customerId_idx" ON "License"("customerId");

-- CreateIndex
CREATE INDEX "License_paddleCustomerId_idx" ON "License"("paddleCustomerId");

-- CreateIndex
CREATE INDEX "Printer_workspaceId_bridgeId_position_idx" ON "Printer"("workspaceId", "bridgeId", "position");

-- CreateIndex
CREATE INDEX "Printer_workspaceId_position_idx" ON "Printer"("workspaceId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "Printer_workspaceId_serial_key" ON "Printer"("workspaceId", "serial");

-- CreateIndex
CREATE UNIQUE INDEX "Bridge_connectCode_key" ON "Bridge"("connectCode");

-- CreateIndex
CREATE UNIQUE INDEX "Bridge_installationId_key" ON "Bridge"("installationId");

-- CreateIndex
CREATE INDEX "Bridge_workspaceId_createdAt_idx" ON "Bridge"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "Bridge_runtimeTokenHash_idx" ON "Bridge"("runtimeTokenHash");

-- CreateIndex
CREATE INDEX "PrintJob_workspaceId_printerId_startedAt_idx" ON "PrintJob"("workspaceId", "printerId", "startedAt");

-- CreateIndex
CREATE INDEX "PrintJob_workspaceId_printerId_finishedAt_startedAt_idx" ON "PrintJob"("workspaceId", "printerId", "finishedAt", "startedAt");

-- CreateIndex
CREATE INDEX "PrintJob_workspaceId_printerId_taskId_idx" ON "PrintJob"("workspaceId", "printerId", "taskId");

-- CreateIndex
CREATE INDEX "PrintJob_workspaceId_finishedAt_printerId_idx" ON "PrintJob"("workspaceId", "finishedAt", "printerId");

-- CreateIndex
CREATE INDEX "PrintJob_workspaceId_fileId_idx" ON "PrintJob"("workspaceId", "fileId");

-- CreateIndex
CREATE INDEX "DispatchJob_workspaceId_printerId_status_idx" ON "DispatchJob"("workspaceId", "printerId", "status");

-- CreateIndex
CREATE INDEX "DispatchJob_printerId_status_idx" ON "DispatchJob"("printerId", "status");

-- CreateIndex
CREATE INDEX "PrinterStats_workspaceId_updatedAt_idx" ON "PrinterStats"("workspaceId", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "LibraryFile_snapshotKey_key" ON "LibraryFile"("snapshotKey");

-- CreateIndex
CREATE INDEX "LibraryFile_workspaceId_uploadedAt_idx" ON "LibraryFile"("workspaceId", "uploadedAt");

-- CreateIndex
CREATE INDEX "LibraryFile_workspaceId_folderId_idx" ON "LibraryFile"("workspaceId", "folderId");

-- CreateIndex
CREATE INDEX "LibraryFile_workspaceId_ownerBridgeId_folderId_idx" ON "LibraryFile"("workspaceId", "ownerBridgeId", "folderId");

-- CreateIndex
CREATE INDEX "LibraryFile_workspaceId_hidden_uploadedAt_idx" ON "LibraryFile"("workspaceId", "hidden", "uploadedAt");

-- CreateIndex
CREATE INDEX "LibraryFile_workspaceId_ownerBridgeId_folderId_name_hidden__idx" ON "LibraryFile"("workspaceId", "ownerBridgeId", "folderId", "name", "hidden", "uploadedAt");

-- CreateIndex
CREATE INDEX "LibraryFile_workspaceId_deletedAt_idx" ON "LibraryFile"("workspaceId", "deletedAt");

-- CreateIndex
CREATE INDEX "LibraryFile_workspace_bridge_folder_printCount_idx" ON "LibraryFile"("workspaceId", "ownerBridgeId", "folderId", "hidden", "printCount");

-- CreateIndex
CREATE INDEX "LibraryFile_workspace_bridge_folder_lastPrintedAt_idx" ON "LibraryFile"("workspaceId", "ownerBridgeId", "folderId", "hidden", "lastPrintedAt");

-- CreateIndex
CREATE INDEX "LibraryFileFavorite_workspaceId_userId_idx" ON "LibraryFileFavorite"("workspaceId", "userId");

-- CreateIndex
CREATE INDEX "LibraryFileFavorite_libraryFileId_idx" ON "LibraryFileFavorite"("libraryFileId");

-- CreateIndex
CREATE UNIQUE INDEX "LibraryFileFavorite_userId_libraryFileId_key" ON "LibraryFileFavorite"("userId", "libraryFileId");

-- CreateIndex
CREATE INDEX "LibraryFileVersion_workspaceId_libraryFileId_versionNumber_idx" ON "LibraryFileVersion"("workspaceId", "libraryFileId", "versionNumber");

-- CreateIndex
CREATE UNIQUE INDEX "LibraryFileVersion_libraryFileId_versionNumber_key" ON "LibraryFileVersion"("libraryFileId", "versionNumber");

-- CreateIndex
CREATE UNIQUE INDEX "LibraryDownloadLink_tokenHash_key" ON "LibraryDownloadLink"("tokenHash");

-- CreateIndex
CREATE INDEX "LibraryDownloadLink_expiresAt_idx" ON "LibraryDownloadLink"("expiresAt");

-- CreateIndex
CREATE INDEX "LibraryDownloadLink_libraryFileId_idx" ON "LibraryDownloadLink"("libraryFileId");

-- CreateIndex
CREATE INDEX "LibraryFolder_workspaceId_ownerBridgeId_parentId_idx" ON "LibraryFolder"("workspaceId", "ownerBridgeId", "parentId");

-- CreateIndex
CREATE INDEX "LibraryFolder_workspaceId_parentId_idx" ON "LibraryFolder"("workspaceId", "parentId");

-- CreateIndex
CREATE UNIQUE INDEX "LibraryFolder_workspaceId_parentId_name_key" ON "LibraryFolder"("workspaceId", "parentId", "name");

-- CreateIndex
CREATE INDEX "LibraryFileReplica_workspaceId_bridgeId_status_idx" ON "LibraryFileReplica"("workspaceId", "bridgeId", "status");

-- CreateIndex
CREATE INDEX "LibraryFileReplica_workspaceId_expiresAt_idx" ON "LibraryFileReplica"("workspaceId", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "LibraryFileReplica_libraryFileId_bridgeId_key" ON "LibraryFileReplica"("libraryFileId", "bridgeId");

-- CreateIndex
CREATE INDEX "PrinterView_workspaceId_name_idx" ON "PrinterView"("workspaceId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "PrinterView_workspaceId_name_key" ON "PrinterView"("workspaceId", "name");

-- CreateIndex
CREATE INDEX "AuthUser_email_idx" ON "AuthUser"("email");

-- CreateIndex
CREATE INDEX "AuthUser_createdAt_idx" ON "AuthUser"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AuthUser_email_key" ON "AuthUser"("email");

-- CreateIndex
CREATE INDEX "AuthWorkspaceMembership_workspaceId_createdAt_idx" ON "AuthWorkspaceMembership"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "AuthWorkspaceMembership_workspaceId_loginDisabled_idx" ON "AuthWorkspaceMembership"("workspaceId", "loginDisabled");

-- CreateIndex
CREATE INDEX "AuthGroup_workspaceId_key_idx" ON "AuthGroup"("workspaceId", "key");

-- CreateIndex
CREATE INDEX "AuthGroup_workspaceId_createdAt_idx" ON "AuthGroup"("workspaceId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AuthGroup_workspaceId_key_key" ON "AuthGroup"("workspaceId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "AuthGroup_workspaceId_name_key" ON "AuthGroup"("workspaceId", "name");

-- CreateIndex
CREATE INDEX "AuthUserGroupMembership_groupId_idx" ON "AuthUserGroupMembership"("groupId");

-- CreateIndex
CREATE UNIQUE INDEX "AuthServiceAccount_tokenHash_key" ON "AuthServiceAccount"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "AuthServiceAccount_tokenPrefix_key" ON "AuthServiceAccount"("tokenPrefix");

-- CreateIndex
CREATE INDEX "AuthServiceAccount_workspaceId_createdAt_idx" ON "AuthServiceAccount"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "AuthServiceAccount_workspaceId_revokedAt_idx" ON "AuthServiceAccount"("workspaceId", "revokedAt");

-- CreateIndex
CREATE INDEX "AuthServiceAccountGroupMembership_groupId_idx" ON "AuthServiceAccountGroupMembership"("groupId");

-- CreateIndex
CREATE UNIQUE INDEX "AuthPasskeyCredential_credentialId_key" ON "AuthPasskeyCredential"("credentialId");

-- CreateIndex
CREATE INDEX "AuthPasskeyCredential_userId_idx" ON "AuthPasskeyCredential"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "AuthPasswordCredential_userId_key" ON "AuthPasswordCredential"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "AuthEmailCodeToken_tokenHash_key" ON "AuthEmailCodeToken"("tokenHash");

-- CreateIndex
CREATE INDEX "AuthEmailCodeToken_email_expiresAt_idx" ON "AuthEmailCodeToken"("email", "expiresAt");

-- CreateIndex
CREATE INDEX "AuthEmailCodeToken_userId_expiresAt_idx" ON "AuthEmailCodeToken"("userId", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "AuthSession_secretHash_key" ON "AuthSession"("secretHash");

-- CreateIndex
CREATE INDEX "AuthSession_userId_expiresAt_idx" ON "AuthSession"("userId", "expiresAt");

-- CreateIndex
CREATE INDEX "AuthSession_serviceAccountId_expiresAt_idx" ON "AuthSession"("serviceAccountId", "expiresAt");

-- CreateIndex
CREATE INDEX "AuthSession_revokedAt_idx" ON "AuthSession"("revokedAt");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_workspaceId_createdAt_idx" ON "AuditLog"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_actorUserId_createdAt_idx" ON "AuditLog"("actorUserId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_actorServiceAccountId_createdAt_idx" ON "AuditLog"("actorServiceAccountId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_action_createdAt_idx" ON "AuditLog"("action", "createdAt");

-- CreateIndex
CREATE INDEX "OrderTemplate_workspaceId_name_idx" ON "OrderTemplate"("workspaceId", "name");

-- CreateIndex
CREATE INDEX "OrderTemplate_workspaceId_createdAt_idx" ON "OrderTemplate"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "OrderTemplateVariant_workspaceId_templateId_position_idx" ON "OrderTemplateVariant"("workspaceId", "templateId", "position");

-- CreateIndex
CREATE INDEX "OrderTemplatePrint_workspaceId_templateVariantId_position_idx" ON "OrderTemplatePrint"("workspaceId", "templateVariantId", "position");

-- CreateIndex
CREATE INDEX "OrderTemplatePrint_workspaceId_libraryFileId_idx" ON "OrderTemplatePrint"("workspaceId", "libraryFileId");

-- CreateIndex
CREATE INDEX "Order_workspaceId_templateId_idx" ON "Order"("workspaceId", "templateId");

-- CreateIndex
CREATE INDEX "Order_workspaceId_status_createdAt_idx" ON "Order"("workspaceId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "OrderVariantSelection_workspaceId_orderId_position_idx" ON "OrderVariantSelection"("workspaceId", "orderId", "position");

-- CreateIndex
CREATE INDEX "OrderVariantSelection_workspaceId_templateVariantId_idx" ON "OrderVariantSelection"("workspaceId", "templateVariantId");

-- CreateIndex
CREATE INDEX "OrderPrint_workspaceId_orderId_groupPosition_sequenceNumber_idx" ON "OrderPrint"("workspaceId", "orderId", "groupPosition", "sequenceNumber");

-- CreateIndex
CREATE INDEX "OrderPrint_workspaceId_status_startedAt_idx" ON "OrderPrint"("workspaceId", "status", "startedAt");

-- CreateIndex
CREATE INDEX "OrderPrint_workspaceId_templateVariantId_idx" ON "OrderPrint"("workspaceId", "templateVariantId");

-- CreateIndex
CREATE INDEX "OrderPrint_workspaceId_libraryFileId_idx" ON "OrderPrint"("workspaceId", "libraryFileId");

-- CreateIndex
CREATE INDEX "OrderPrint_workspaceId_startedPrinterId_idx" ON "OrderPrint"("workspaceId", "startedPrinterId");

-- CreateIndex
CREATE INDEX "OrderPrint_workspaceId_lastPrintJobId_idx" ON "OrderPrint"("workspaceId", "lastPrintJobId");

-- CreateIndex
CREATE INDEX "FilamentSpool_workspaceId_deletedAt_idx" ON "FilamentSpool"("workspaceId", "deletedAt");

-- CreateIndex
CREATE INDEX "FilamentSpool_workspaceId_filamentType_idx" ON "FilamentSpool"("workspaceId", "filamentType");

-- CreateIndex
CREATE INDEX "FilamentSpool_workspaceId_brand_idx" ON "FilamentSpool"("workspaceId", "brand");

-- CreateIndex
CREATE INDEX "FilamentSpool_workspaceId_loadedPrinterId_idx" ON "FilamentSpool"("workspaceId", "loadedPrinterId");

-- CreateIndex
CREATE INDEX "FilamentSpool_workspaceId_bambuUuid_idx" ON "FilamentSpool"("workspaceId", "bambuUuid");

-- CreateIndex
CREATE INDEX "FilamentSpoolUsage_workspaceId_spoolId_recordedAt_idx" ON "FilamentSpoolUsage"("workspaceId", "spoolId", "recordedAt");

-- CreateIndex
CREATE INDEX "FilamentSpoolUsage_workspaceId_jobId_idx" ON "FilamentSpoolUsage"("workspaceId", "jobId");

-- CreateIndex
CREATE INDEX "CalibrationRun_workspaceId_status_createdAt_idx" ON "CalibrationRun"("workspaceId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "CalibrationRun_workspaceId_printerId_idx" ON "CalibrationRun"("workspaceId", "printerId");

-- CreateIndex
CREATE INDEX "CalibrationRun_workspaceId_spoolId_idx" ON "CalibrationRun"("workspaceId", "spoolId");

-- CreateIndex
CREATE INDEX "CalibrationResult_workspaceId_kind_printerModel_nozzleDiame_idx" ON "CalibrationResult"("workspaceId", "kind", "printerModel", "nozzleDiameter");

-- CreateIndex
CREATE INDEX "CalibrationResult_workspaceId_spoolId_idx" ON "CalibrationResult"("workspaceId", "spoolId");

-- CreateIndex
CREATE INDEX "QueueItem_workspaceId_status_sortKey_idx" ON "QueueItem"("workspaceId", "status", "sortKey");

-- CreateIndex
CREATE INDEX "QueueItem_workspaceId_sortKey_idx" ON "QueueItem"("workspaceId", "sortKey");

-- CreateIndex
CREATE INDEX "QueueItem_workspaceId_libraryFileId_idx" ON "QueueItem"("workspaceId", "libraryFileId");

-- CreateIndex
CREATE INDEX "QueueItem_workspaceId_targetPrinterId_idx" ON "QueueItem"("workspaceId", "targetPrinterId");

-- CreateIndex
CREATE INDEX "QueueItem_workspaceId_lastPrinterId_idx" ON "QueueItem"("workspaceId", "lastPrinterId");

-- CreateIndex
CREATE INDEX "QueueItem_workspaceId_lastPrintJobId_idx" ON "QueueItem"("workspaceId", "lastPrintJobId");

-- CreateIndex
CREATE INDEX "QueueItem_workspaceId_orderPrintId_idx" ON "QueueItem"("workspaceId", "orderPrintId");

-- CreateIndex
CREATE INDEX "SupportConversation_lastMessageAt_idx" ON "SupportConversation"("lastMessageAt");

-- CreateIndex
CREATE INDEX "SupportConversation_userId_lastMessageAt_idx" ON "SupportConversation"("userId", "lastMessageAt");

-- CreateIndex
CREATE INDEX "SupportConversation_status_lastMessageAt_idx" ON "SupportConversation"("status", "lastMessageAt");

-- CreateIndex
CREATE INDEX "SupportMessage_conversationId_createdAt_idx" ON "SupportMessage"("conversationId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "SupportPendingEmail_messageId_key" ON "SupportPendingEmail"("messageId");

-- CreateIndex
CREATE INDEX "SupportPendingEmail_sendAt_idx" ON "SupportPendingEmail"("sendAt");

-- CreateIndex
CREATE INDEX "SupportPendingEmail_conversationId_recipientSide_idx" ON "SupportPendingEmail"("conversationId", "recipientSide");

-- CreateIndex
CREATE INDEX "SupportAttachment_messageId_idx" ON "SupportAttachment"("messageId");

-- CreateIndex
CREATE INDEX "SupportAttachment_createdAt_idx" ON "SupportAttachment"("createdAt");

-- CreateIndex
CREATE INDEX "Suggestion_createdAt_idx" ON "Suggestion"("createdAt");

-- CreateIndex
CREATE INDEX "Suggestion_authorUserId_idx" ON "Suggestion"("authorUserId");

-- CreateIndex
CREATE INDEX "SuggestionVote_userId_idx" ON "SuggestionVote"("userId");

-- CreateIndex
CREATE INDEX "SuggestionComment_suggestionId_createdAt_idx" ON "SuggestionComment"("suggestionId", "createdAt");

-- CreateIndex
CREATE INDEX "SuggestionComment_authorUserId_idx" ON "SuggestionComment"("authorUserId");

-- CreateIndex
CREATE UNIQUE INDEX "BetaInviteCode_code_key" ON "BetaInviteCode"("code");

-- CreateIndex
CREATE INDEX "BetaInviteCode_createdAt_idx" ON "BetaInviteCode"("createdAt");

-- CreateIndex
CREATE INDEX "BetaInviteCode_issuedToEmail_idx" ON "BetaInviteCode"("issuedToEmail");

-- CreateIndex
CREATE INDEX "PendingRegistration_email_expiresAt_idx" ON "PendingRegistration"("email", "expiresAt");

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "AuthUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerMembership" ADD CONSTRAINT "CustomerMembership_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerMembership" ADD CONSTRAINT "CustomerMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "AuthUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Workspace" ADD CONSTRAINT "Workspace_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceSubscription" ADD CONSTRAINT "WorkspaceSubscription_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "License" ADD CONSTRAINT "License_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Printer" ADD CONSTRAINT "Printer_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Printer" ADD CONSTRAINT "Printer_bridgeId_fkey" FOREIGN KEY ("bridgeId") REFERENCES "Bridge"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Bridge" ADD CONSTRAINT "Bridge_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrintJob" ADD CONSTRAINT "PrintJob_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrintJob" ADD CONSTRAINT "PrintJob_printerId_fkey" FOREIGN KEY ("printerId") REFERENCES "Printer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrintJob" ADD CONSTRAINT "PrintJob_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "LibraryFile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrintJob" ADD CONSTRAINT "PrintJob_sourceProjectFileId_fkey" FOREIGN KEY ("sourceProjectFileId") REFERENCES "LibraryFile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DispatchJob" ADD CONSTRAINT "DispatchJob_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DispatchJob" ADD CONSTRAINT "DispatchJob_printerId_fkey" FOREIGN KEY ("printerId") REFERENCES "Printer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceStats" ADD CONSTRAINT "WorkspaceStats_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrinterStats" ADD CONSTRAINT "PrinterStats_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LibraryFile" ADD CONSTRAINT "LibraryFile_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LibraryFile" ADD CONSTRAINT "LibraryFile_ownerBridgeId_fkey" FOREIGN KEY ("ownerBridgeId") REFERENCES "Bridge"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LibraryFile" ADD CONSTRAINT "LibraryFile_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "LibraryFolder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LibraryFile" ADD CONSTRAINT "LibraryFile_sourceProjectFileId_fkey" FOREIGN KEY ("sourceProjectFileId") REFERENCES "LibraryFile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LibraryFileFavorite" ADD CONSTRAINT "LibraryFileFavorite_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LibraryFileFavorite" ADD CONSTRAINT "LibraryFileFavorite_libraryFileId_fkey" FOREIGN KEY ("libraryFileId") REFERENCES "LibraryFile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LibraryFileVersion" ADD CONSTRAINT "LibraryFileVersion_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LibraryFileVersion" ADD CONSTRAINT "LibraryFileVersion_libraryFileId_fkey" FOREIGN KEY ("libraryFileId") REFERENCES "LibraryFile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LibraryDownloadLink" ADD CONSTRAINT "LibraryDownloadLink_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LibraryDownloadLink" ADD CONSTRAINT "LibraryDownloadLink_libraryFileId_fkey" FOREIGN KEY ("libraryFileId") REFERENCES "LibraryFile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LibraryFolder" ADD CONSTRAINT "LibraryFolder_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LibraryFolder" ADD CONSTRAINT "LibraryFolder_ownerBridgeId_fkey" FOREIGN KEY ("ownerBridgeId") REFERENCES "Bridge"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LibraryFolder" ADD CONSTRAINT "LibraryFolder_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "LibraryFolder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LibraryFileReplica" ADD CONSTRAINT "LibraryFileReplica_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LibraryFileReplica" ADD CONSTRAINT "LibraryFileReplica_libraryFileId_fkey" FOREIGN KEY ("libraryFileId") REFERENCES "LibraryFile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LibraryFileReplica" ADD CONSTRAINT "LibraryFileReplica_bridgeId_fkey" FOREIGN KEY ("bridgeId") REFERENCES "Bridge"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrinterView" ADD CONSTRAINT "PrinterView_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthWorkspaceMembership" ADD CONSTRAINT "AuthWorkspaceMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "AuthUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthWorkspaceMembership" ADD CONSTRAINT "AuthWorkspaceMembership_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthGroup" ADD CONSTRAINT "AuthGroup_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthUserGroupMembership" ADD CONSTRAINT "AuthUserGroupMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "AuthUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthUserGroupMembership" ADD CONSTRAINT "AuthUserGroupMembership_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "AuthGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthServiceAccount" ADD CONSTRAINT "AuthServiceAccount_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthServiceAccountGroupMembership" ADD CONSTRAINT "AuthServiceAccountGroupMembership_serviceAccountId_fkey" FOREIGN KEY ("serviceAccountId") REFERENCES "AuthServiceAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthServiceAccountGroupMembership" ADD CONSTRAINT "AuthServiceAccountGroupMembership_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "AuthGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthPasskeyCredential" ADD CONSTRAINT "AuthPasskeyCredential_userId_fkey" FOREIGN KEY ("userId") REFERENCES "AuthUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthPasswordCredential" ADD CONSTRAINT "AuthPasswordCredential_userId_fkey" FOREIGN KEY ("userId") REFERENCES "AuthUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthEmailCodeToken" ADD CONSTRAINT "AuthEmailCodeToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "AuthUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthSession" ADD CONSTRAINT "AuthSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "AuthUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthSession" ADD CONSTRAINT "AuthSession_serviceAccountId_fkey" FOREIGN KEY ("serviceAccountId") REFERENCES "AuthServiceAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "AuthUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorServiceAccountId_fkey" FOREIGN KEY ("actorServiceAccountId") REFERENCES "AuthServiceAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderTemplate" ADD CONSTRAINT "OrderTemplate_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderTemplateVariant" ADD CONSTRAINT "OrderTemplateVariant_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderTemplateVariant" ADD CONSTRAINT "OrderTemplateVariant_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "OrderTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderTemplatePrint" ADD CONSTRAINT "OrderTemplatePrint_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderTemplatePrint" ADD CONSTRAINT "OrderTemplatePrint_templateVariantId_fkey" FOREIGN KEY ("templateVariantId") REFERENCES "OrderTemplateVariant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderTemplatePrint" ADD CONSTRAINT "OrderTemplatePrint_libraryFileId_fkey" FOREIGN KEY ("libraryFileId") REFERENCES "LibraryFile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "OrderTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderVariantSelection" ADD CONSTRAINT "OrderVariantSelection_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderVariantSelection" ADD CONSTRAINT "OrderVariantSelection_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderVariantSelection" ADD CONSTRAINT "OrderVariantSelection_templateVariantId_fkey" FOREIGN KEY ("templateVariantId") REFERENCES "OrderTemplateVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderPrint" ADD CONSTRAINT "OrderPrint_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderPrint" ADD CONSTRAINT "OrderPrint_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderPrint" ADD CONSTRAINT "OrderPrint_templatePrintId_fkey" FOREIGN KEY ("templatePrintId") REFERENCES "OrderTemplatePrint"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderPrint" ADD CONSTRAINT "OrderPrint_templateVariantId_fkey" FOREIGN KEY ("templateVariantId") REFERENCES "OrderTemplateVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderPrint" ADD CONSTRAINT "OrderPrint_libraryFileId_fkey" FOREIGN KEY ("libraryFileId") REFERENCES "LibraryFile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderPrint" ADD CONSTRAINT "OrderPrint_startedPrinterId_fkey" FOREIGN KEY ("startedPrinterId") REFERENCES "Printer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderPrint" ADD CONSTRAINT "OrderPrint_lastPrintJobId_fkey" FOREIGN KEY ("lastPrintJobId") REFERENCES "PrintJob"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FilamentSpool" ADD CONSTRAINT "FilamentSpool_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FilamentSpool" ADD CONSTRAINT "FilamentSpool_loadedPrinterId_fkey" FOREIGN KEY ("loadedPrinterId") REFERENCES "Printer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FilamentSpoolUsage" ADD CONSTRAINT "FilamentSpoolUsage_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FilamentSpoolUsage" ADD CONSTRAINT "FilamentSpoolUsage_spoolId_fkey" FOREIGN KEY ("spoolId") REFERENCES "FilamentSpool"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalibrationRun" ADD CONSTRAINT "CalibrationRun_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalibrationResult" ADD CONSTRAINT "CalibrationResult_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QueueItem" ADD CONSTRAINT "QueueItem_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QueueItem" ADD CONSTRAINT "QueueItem_libraryFileId_fkey" FOREIGN KEY ("libraryFileId") REFERENCES "LibraryFile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QueueItem" ADD CONSTRAINT "QueueItem_targetPrinterId_fkey" FOREIGN KEY ("targetPrinterId") REFERENCES "Printer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QueueItem" ADD CONSTRAINT "QueueItem_lastPrinterId_fkey" FOREIGN KEY ("lastPrinterId") REFERENCES "Printer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QueueItem" ADD CONSTRAINT "QueueItem_lastPrintJobId_fkey" FOREIGN KEY ("lastPrintJobId") REFERENCES "PrintJob"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportMessage" ADD CONSTRAINT "SupportMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "SupportConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportPendingEmail" ADD CONSTRAINT "SupportPendingEmail_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "SupportConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportPendingEmail" ADD CONSTRAINT "SupportPendingEmail_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "SupportMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportAttachment" ADD CONSTRAINT "SupportAttachment_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "SupportMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SuggestionVote" ADD CONSTRAINT "SuggestionVote_suggestionId_fkey" FOREIGN KEY ("suggestionId") REFERENCES "Suggestion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SuggestionComment" ADD CONSTRAINT "SuggestionComment_suggestionId_fkey" FOREIGN KEY ("suggestionId") REFERENCES "Suggestion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SuggestionComment" ADD CONSTRAINT "SuggestionComment_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "SuggestionComment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PendingRegistration" ADD CONSTRAINT "PendingRegistration_inviteCodeId_fkey" FOREIGN KEY ("inviteCodeId") REFERENCES "BetaInviteCode"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION public.ensure_platform_stats_row()
 RETURNS void
 LANGUAGE plpgsql
AS $function$
BEGIN
  INSERT INTO "PlatformStats" ("id") VALUES ('platform')
  ON CONFLICT ("id") DO NOTHING;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.ensure_workspace_stats_row()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  INSERT INTO "WorkspaceStats" ("workspaceId") VALUES (NEW."id")
  ON CONFLICT ("workspaceId") DO NOTHING;
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.refresh_platform_workspace_counts()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  PERFORM ensure_platform_stats_row();

  UPDATE "PlatformStats"
  SET
    "workspaceCount" = (SELECT COUNT(*)::INTEGER FROM "Workspace"),
    "userCount" = (SELECT COUNT(DISTINCT "userId")::INTEGER FROM "AuthWorkspaceMembership"),
    "printerCount" = (SELECT COUNT(*)::INTEGER FROM "Printer"),
    "updatedAt" = CURRENT_TIMESTAMP
  WHERE "id" = 'platform';

  RETURN COALESCE(NEW, OLD);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.sync_platform_stats_from_workspace_stats()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  total_prints_delta INTEGER := 0;
  successful_duration_delta INTEGER := 0;
  failed_duration_delta INTEGER := 0;
  cancelled_duration_delta INTEGER := 0;
  wasted_duration_delta INTEGER := 0;
  tracked_filament_delta INTEGER := 0;
  filament_grams_delta NUMERIC := 0;
  successful_filament_grams_delta NUMERIC := 0;
  failed_filament_grams_delta NUMERIC := 0;
  cancelled_filament_grams_delta NUMERIC := 0;
  wasted_filament_grams_delta NUMERIC := 0;
  filament_meters_delta NUMERIC := 0;
  successful_filament_meters_delta NUMERIC := 0;
  failed_filament_meters_delta NUMERIC := 0;
  cancelled_filament_meters_delta NUMERIC := 0;
  wasted_filament_meters_delta NUMERIC := 0;
BEGIN
  PERFORM ensure_platform_stats_row();

  IF TG_OP = 'INSERT' THEN
    total_prints_delta := NEW."totalPrints";
    successful_duration_delta := NEW."successfulPrintDurationSeconds";
    failed_duration_delta := NEW."failedPrintDurationSeconds";
    cancelled_duration_delta := NEW."cancelledPrintDurationSeconds";
    wasted_duration_delta := NEW."wastedPrintDurationSeconds";
    tracked_filament_delta := NEW."trackedFilamentPrints";
    filament_grams_delta := COALESCE(NEW."filamentUsedGrams", 0);
    successful_filament_grams_delta := COALESCE(NEW."successfulFilamentUsedGrams", 0);
    failed_filament_grams_delta := COALESCE(NEW."failedFilamentUsedGrams", 0);
    cancelled_filament_grams_delta := COALESCE(NEW."cancelledFilamentUsedGrams", 0);
    wasted_filament_grams_delta := COALESCE(NEW."wastedFilamentUsedGrams", 0);
    filament_meters_delta := COALESCE(NEW."filamentUsedMeters", 0);
    successful_filament_meters_delta := COALESCE(NEW."successfulFilamentUsedMeters", 0);
    failed_filament_meters_delta := COALESCE(NEW."failedFilamentUsedMeters", 0);
    cancelled_filament_meters_delta := COALESCE(NEW."cancelledFilamentUsedMeters", 0);
    wasted_filament_meters_delta := COALESCE(NEW."wastedFilamentUsedMeters", 0);
  ELSIF TG_OP = 'DELETE' THEN
    total_prints_delta := -OLD."totalPrints";
    successful_duration_delta := -OLD."successfulPrintDurationSeconds";
    failed_duration_delta := -OLD."failedPrintDurationSeconds";
    cancelled_duration_delta := -OLD."cancelledPrintDurationSeconds";
    wasted_duration_delta := -OLD."wastedPrintDurationSeconds";
    tracked_filament_delta := -OLD."trackedFilamentPrints";
    filament_grams_delta := -COALESCE(OLD."filamentUsedGrams", 0);
    successful_filament_grams_delta := -COALESCE(OLD."successfulFilamentUsedGrams", 0);
    failed_filament_grams_delta := -COALESCE(OLD."failedFilamentUsedGrams", 0);
    cancelled_filament_grams_delta := -COALESCE(OLD."cancelledFilamentUsedGrams", 0);
    wasted_filament_grams_delta := -COALESCE(OLD."wastedFilamentUsedGrams", 0);
    filament_meters_delta := -COALESCE(OLD."filamentUsedMeters", 0);
    successful_filament_meters_delta := -COALESCE(OLD."successfulFilamentUsedMeters", 0);
    failed_filament_meters_delta := -COALESCE(OLD."failedFilamentUsedMeters", 0);
    cancelled_filament_meters_delta := -COALESCE(OLD."cancelledFilamentUsedMeters", 0);
    wasted_filament_meters_delta := -COALESCE(OLD."wastedFilamentUsedMeters", 0);
  ELSE
    total_prints_delta := NEW."totalPrints" - OLD."totalPrints";
    successful_duration_delta := NEW."successfulPrintDurationSeconds" - OLD."successfulPrintDurationSeconds";
    failed_duration_delta := NEW."failedPrintDurationSeconds" - OLD."failedPrintDurationSeconds";
    cancelled_duration_delta := NEW."cancelledPrintDurationSeconds" - OLD."cancelledPrintDurationSeconds";
    wasted_duration_delta := NEW."wastedPrintDurationSeconds" - OLD."wastedPrintDurationSeconds";
    tracked_filament_delta := NEW."trackedFilamentPrints" - OLD."trackedFilamentPrints";
    filament_grams_delta := COALESCE(NEW."filamentUsedGrams", 0) - COALESCE(OLD."filamentUsedGrams", 0);
    successful_filament_grams_delta := COALESCE(NEW."successfulFilamentUsedGrams", 0) - COALESCE(OLD."successfulFilamentUsedGrams", 0);
    failed_filament_grams_delta := COALESCE(NEW."failedFilamentUsedGrams", 0) - COALESCE(OLD."failedFilamentUsedGrams", 0);
    cancelled_filament_grams_delta := COALESCE(NEW."cancelledFilamentUsedGrams", 0) - COALESCE(OLD."cancelledFilamentUsedGrams", 0);
    wasted_filament_grams_delta := COALESCE(NEW."wastedFilamentUsedGrams", 0) - COALESCE(OLD."wastedFilamentUsedGrams", 0);
    filament_meters_delta := COALESCE(NEW."filamentUsedMeters", 0) - COALESCE(OLD."filamentUsedMeters", 0);
    successful_filament_meters_delta := COALESCE(NEW."successfulFilamentUsedMeters", 0) - COALESCE(OLD."successfulFilamentUsedMeters", 0);
    failed_filament_meters_delta := COALESCE(NEW."failedFilamentUsedMeters", 0) - COALESCE(OLD."failedFilamentUsedMeters", 0);
    cancelled_filament_meters_delta := COALESCE(NEW."cancelledFilamentUsedMeters", 0) - COALESCE(OLD."cancelledFilamentUsedMeters", 0);
    wasted_filament_meters_delta := COALESCE(NEW."wastedFilamentUsedMeters", 0) - COALESCE(OLD."wastedFilamentUsedMeters", 0);
  END IF;

  UPDATE "PlatformStats"
  SET
    "totalPrints" = GREATEST(0, "totalPrints" + total_prints_delta),
    "successfulPrintDurationSeconds" = GREATEST(0, "successfulPrintDurationSeconds" + successful_duration_delta),
    "failedPrintDurationSeconds" = GREATEST(0, "failedPrintDurationSeconds" + failed_duration_delta),
    "cancelledPrintDurationSeconds" = GREATEST(0, "cancelledPrintDurationSeconds" + cancelled_duration_delta),
    "wastedPrintDurationSeconds" = GREATEST(0, "wastedPrintDurationSeconds" + wasted_duration_delta),
    "trackedFilamentPrints" = GREATEST(0, "trackedFilamentPrints" + tracked_filament_delta),
    "filamentUsedGrams" = GREATEST(0, "filamentUsedGrams" + filament_grams_delta),
    "successfulFilamentUsedGrams" = GREATEST(0, "successfulFilamentUsedGrams" + successful_filament_grams_delta),
    "failedFilamentUsedGrams" = GREATEST(0, "failedFilamentUsedGrams" + failed_filament_grams_delta),
    "cancelledFilamentUsedGrams" = GREATEST(0, "cancelledFilamentUsedGrams" + cancelled_filament_grams_delta),
    "wastedFilamentUsedGrams" = GREATEST(0, "wastedFilamentUsedGrams" + wasted_filament_grams_delta),
    "filamentUsedMeters" = GREATEST(0, "filamentUsedMeters" + filament_meters_delta),
    "successfulFilamentUsedMeters" = GREATEST(0, "successfulFilamentUsedMeters" + successful_filament_meters_delta),
    "failedFilamentUsedMeters" = GREATEST(0, "failedFilamentUsedMeters" + failed_filament_meters_delta),
    "cancelledFilamentUsedMeters" = GREATEST(0, "cancelledFilamentUsedMeters" + cancelled_filament_meters_delta),
    "wastedFilamentUsedMeters" = GREATEST(0, "wastedFilamentUsedMeters" + wasted_filament_meters_delta),
    "updatedAt" = CURRENT_TIMESTAMP
  WHERE "id" = 'platform';

  RETURN COALESCE(NEW, OLD);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.sync_workspace_print_stats()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  old_total INTEGER := 0;
  old_success INTEGER := 0;
  old_failed INTEGER := 0;
  old_cancelled INTEGER := 0;
  old_success_duration INTEGER := 0;
  old_failed_duration INTEGER := 0;
  old_cancelled_duration INTEGER := 0;
  old_wasted_duration INTEGER := 0;
  old_tracked_filament INTEGER := 0;
  old_filament_grams NUMERIC := 0;
  old_successful_filament_grams NUMERIC := 0;
  old_failed_filament_grams NUMERIC := 0;
  old_cancelled_filament_grams NUMERIC := 0;
  old_wasted_filament_grams NUMERIC := 0;
  old_filament_meters NUMERIC := 0;
  old_successful_filament_meters NUMERIC := 0;
  old_failed_filament_meters NUMERIC := 0;
  old_cancelled_filament_meters NUMERIC := 0;
  old_wasted_filament_meters NUMERIC := 0;
  new_total INTEGER := 0;
  new_success INTEGER := 0;
  new_failed INTEGER := 0;
  new_cancelled INTEGER := 0;
  new_success_duration INTEGER := 0;
  new_failed_duration INTEGER := 0;
  new_cancelled_duration INTEGER := 0;
  new_wasted_duration INTEGER := 0;
  new_tracked_filament INTEGER := 0;
  new_filament_grams NUMERIC := 0;
  new_successful_filament_grams NUMERIC := 0;
  new_failed_filament_grams NUMERIC := 0;
  new_cancelled_filament_grams NUMERIC := 0;
  new_wasted_filament_grams NUMERIC := 0;
  new_filament_meters NUMERIC := 0;
  new_successful_filament_meters NUMERIC := 0;
  new_failed_filament_meters NUMERIC := 0;
  new_cancelled_filament_meters NUMERIC := 0;
  new_wasted_filament_meters NUMERIC := 0;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    old_total := CASE WHEN OLD."result" IN ('success', 'failed', 'cancelled') THEN 1 ELSE 0 END;
    old_success := CASE WHEN OLD."result" = 'success' THEN 1 ELSE 0 END;
    old_failed := CASE WHEN OLD."result" = 'failed' THEN 1 ELSE 0 END;
    old_cancelled := CASE WHEN OLD."result" = 'cancelled' THEN 1 ELSE 0 END;
    old_success_duration := CASE WHEN OLD."result" = 'success' THEN COALESCE(OLD."durationSeconds", 0) ELSE 0 END;
    old_failed_duration := CASE WHEN OLD."result" = 'failed' THEN COALESCE(OLD."durationSeconds", 0) ELSE 0 END;
    old_cancelled_duration := CASE WHEN OLD."result" = 'cancelled' THEN COALESCE(OLD."durationSeconds", 0) ELSE 0 END;
    old_wasted_duration := old_failed_duration + old_cancelled_duration;
    old_tracked_filament := CASE WHEN OLD."result" IN ('success', 'failed', 'cancelled') AND (OLD."filamentUsedGrams" IS NOT NULL OR OLD."filamentUsedMeters" IS NOT NULL) THEN 1 ELSE 0 END;
    old_filament_grams := CASE WHEN OLD."result" IN ('success', 'failed', 'cancelled') THEN COALESCE(OLD."filamentUsedGrams", 0) ELSE 0 END;
    old_successful_filament_grams := CASE WHEN OLD."result" = 'success' THEN COALESCE(OLD."filamentUsedGrams", 0) ELSE 0 END;
    old_failed_filament_grams := CASE WHEN OLD."result" = 'failed' THEN COALESCE(OLD."filamentUsedGrams", 0) ELSE 0 END;
    old_cancelled_filament_grams := CASE WHEN OLD."result" = 'cancelled' THEN COALESCE(OLD."filamentUsedGrams", 0) ELSE 0 END;
    old_wasted_filament_grams := old_failed_filament_grams + old_cancelled_filament_grams;
    old_filament_meters := CASE WHEN OLD."result" IN ('success', 'failed', 'cancelled') THEN COALESCE(OLD."filamentUsedMeters", 0) ELSE 0 END;
    old_successful_filament_meters := CASE WHEN OLD."result" = 'success' THEN COALESCE(OLD."filamentUsedMeters", 0) ELSE 0 END;
    old_failed_filament_meters := CASE WHEN OLD."result" = 'failed' THEN COALESCE(OLD."filamentUsedMeters", 0) ELSE 0 END;
    old_cancelled_filament_meters := CASE WHEN OLD."result" = 'cancelled' THEN COALESCE(OLD."filamentUsedMeters", 0) ELSE 0 END;
    old_wasted_filament_meters := old_failed_filament_meters + old_cancelled_filament_meters;
  END IF;

  IF TG_OP <> 'DELETE' THEN
    new_total := CASE WHEN NEW."result" IN ('success', 'failed', 'cancelled') THEN 1 ELSE 0 END;
    new_success := CASE WHEN NEW."result" = 'success' THEN 1 ELSE 0 END;
    new_failed := CASE WHEN NEW."result" = 'failed' THEN 1 ELSE 0 END;
    new_cancelled := CASE WHEN NEW."result" = 'cancelled' THEN 1 ELSE 0 END;
    new_success_duration := CASE WHEN NEW."result" = 'success' THEN COALESCE(NEW."durationSeconds", 0) ELSE 0 END;
    new_failed_duration := CASE WHEN NEW."result" = 'failed' THEN COALESCE(NEW."durationSeconds", 0) ELSE 0 END;
    new_cancelled_duration := CASE WHEN NEW."result" = 'cancelled' THEN COALESCE(NEW."durationSeconds", 0) ELSE 0 END;
    new_wasted_duration := new_failed_duration + new_cancelled_duration;
    new_tracked_filament := CASE WHEN NEW."result" IN ('success', 'failed', 'cancelled') AND (NEW."filamentUsedGrams" IS NOT NULL OR NEW."filamentUsedMeters" IS NOT NULL) THEN 1 ELSE 0 END;
    new_filament_grams := CASE WHEN NEW."result" IN ('success', 'failed', 'cancelled') THEN COALESCE(NEW."filamentUsedGrams", 0) ELSE 0 END;
    new_successful_filament_grams := CASE WHEN NEW."result" = 'success' THEN COALESCE(NEW."filamentUsedGrams", 0) ELSE 0 END;
    new_failed_filament_grams := CASE WHEN NEW."result" = 'failed' THEN COALESCE(NEW."filamentUsedGrams", 0) ELSE 0 END;
    new_cancelled_filament_grams := CASE WHEN NEW."result" = 'cancelled' THEN COALESCE(NEW."filamentUsedGrams", 0) ELSE 0 END;
    new_wasted_filament_grams := new_failed_filament_grams + new_cancelled_filament_grams;
    new_filament_meters := CASE WHEN NEW."result" IN ('success', 'failed', 'cancelled') THEN COALESCE(NEW."filamentUsedMeters", 0) ELSE 0 END;
    new_successful_filament_meters := CASE WHEN NEW."result" = 'success' THEN COALESCE(NEW."filamentUsedMeters", 0) ELSE 0 END;
    new_failed_filament_meters := CASE WHEN NEW."result" = 'failed' THEN COALESCE(NEW."filamentUsedMeters", 0) ELSE 0 END;
    new_cancelled_filament_meters := CASE WHEN NEW."result" = 'cancelled' THEN COALESCE(NEW."filamentUsedMeters", 0) ELSE 0 END;
    new_wasted_filament_meters := new_failed_filament_meters + new_cancelled_filament_meters;
  END IF;

  IF TG_OP = 'INSERT' THEN
    INSERT INTO "WorkspaceStats" (
      "workspaceId",
      "totalPrints",
      "successfulPrints",
      "failedPrints",
      "cancelledPrints",
      "successfulPrintDurationSeconds",
      "failedPrintDurationSeconds",
      "cancelledPrintDurationSeconds",
      "wastedPrintDurationSeconds",
      "trackedFilamentPrints",
      "filamentUsedGrams",
      "successfulFilamentUsedGrams",
      "failedFilamentUsedGrams",
      "cancelledFilamentUsedGrams",
      "wastedFilamentUsedGrams",
      "filamentUsedMeters",
      "successfulFilamentUsedMeters",
      "failedFilamentUsedMeters",
      "cancelledFilamentUsedMeters",
      "wastedFilamentUsedMeters",
      "updatedAt"
    )
    VALUES (
      NEW."workspaceId",
      new_total,
      new_success,
      new_failed,
      new_cancelled,
      new_success_duration,
      new_failed_duration,
      new_cancelled_duration,
      new_wasted_duration,
      new_tracked_filament,
      new_filament_grams,
      new_successful_filament_grams,
      new_failed_filament_grams,
      new_cancelled_filament_grams,
      new_wasted_filament_grams,
      new_filament_meters,
      new_successful_filament_meters,
      new_failed_filament_meters,
      new_cancelled_filament_meters,
      new_wasted_filament_meters,
      CURRENT_TIMESTAMP
    )
    ON CONFLICT ("workspaceId") DO UPDATE
    SET
      "totalPrints" = "WorkspaceStats"."totalPrints" + new_total,
      "successfulPrints" = "WorkspaceStats"."successfulPrints" + new_success,
      "failedPrints" = "WorkspaceStats"."failedPrints" + new_failed,
      "cancelledPrints" = "WorkspaceStats"."cancelledPrints" + new_cancelled,
      "successfulPrintDurationSeconds" = "WorkspaceStats"."successfulPrintDurationSeconds" + new_success_duration,
      "failedPrintDurationSeconds" = "WorkspaceStats"."failedPrintDurationSeconds" + new_failed_duration,
      "cancelledPrintDurationSeconds" = "WorkspaceStats"."cancelledPrintDurationSeconds" + new_cancelled_duration,
      "wastedPrintDurationSeconds" = "WorkspaceStats"."wastedPrintDurationSeconds" + new_wasted_duration,
      "trackedFilamentPrints" = "WorkspaceStats"."trackedFilamentPrints" + new_tracked_filament,
      "filamentUsedGrams" = "WorkspaceStats"."filamentUsedGrams" + new_filament_grams,
      "successfulFilamentUsedGrams" = "WorkspaceStats"."successfulFilamentUsedGrams" + new_successful_filament_grams,
      "failedFilamentUsedGrams" = "WorkspaceStats"."failedFilamentUsedGrams" + new_failed_filament_grams,
      "cancelledFilamentUsedGrams" = "WorkspaceStats"."cancelledFilamentUsedGrams" + new_cancelled_filament_grams,
      "wastedFilamentUsedGrams" = "WorkspaceStats"."wastedFilamentUsedGrams" + new_wasted_filament_grams,
      "filamentUsedMeters" = "WorkspaceStats"."filamentUsedMeters" + new_filament_meters,
      "successfulFilamentUsedMeters" = "WorkspaceStats"."successfulFilamentUsedMeters" + new_successful_filament_meters,
      "failedFilamentUsedMeters" = "WorkspaceStats"."failedFilamentUsedMeters" + new_failed_filament_meters,
      "cancelledFilamentUsedMeters" = "WorkspaceStats"."cancelledFilamentUsedMeters" + new_cancelled_filament_meters,
      "wastedFilamentUsedMeters" = "WorkspaceStats"."wastedFilamentUsedMeters" + new_wasted_filament_meters,
      "updatedAt" = CURRENT_TIMESTAMP;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  IF NEW."workspaceId" <> OLD."workspaceId" THEN
    UPDATE "WorkspaceStats"
    SET
      "totalPrints" = GREATEST(0, "totalPrints" - old_total),
      "successfulPrints" = GREATEST(0, "successfulPrints" - old_success),
      "failedPrints" = GREATEST(0, "failedPrints" - old_failed),
      "cancelledPrints" = GREATEST(0, "cancelledPrints" - old_cancelled),
      "successfulPrintDurationSeconds" = GREATEST(0, "successfulPrintDurationSeconds" - old_success_duration),
      "failedPrintDurationSeconds" = GREATEST(0, "failedPrintDurationSeconds" - old_failed_duration),
      "cancelledPrintDurationSeconds" = GREATEST(0, "cancelledPrintDurationSeconds" - old_cancelled_duration),
      "wastedPrintDurationSeconds" = GREATEST(0, "wastedPrintDurationSeconds" - old_wasted_duration),
      "trackedFilamentPrints" = GREATEST(0, "trackedFilamentPrints" - old_tracked_filament),
      "filamentUsedGrams" = GREATEST(0, "filamentUsedGrams" - old_filament_grams),
      "successfulFilamentUsedGrams" = GREATEST(0, "successfulFilamentUsedGrams" - old_successful_filament_grams),
      "failedFilamentUsedGrams" = GREATEST(0, "failedFilamentUsedGrams" - old_failed_filament_grams),
      "cancelledFilamentUsedGrams" = GREATEST(0, "cancelledFilamentUsedGrams" - old_cancelled_filament_grams),
      "wastedFilamentUsedGrams" = GREATEST(0, "wastedFilamentUsedGrams" - old_wasted_filament_grams),
      "filamentUsedMeters" = GREATEST(0, "filamentUsedMeters" - old_filament_meters),
      "successfulFilamentUsedMeters" = GREATEST(0, "successfulFilamentUsedMeters" - old_successful_filament_meters),
      "failedFilamentUsedMeters" = GREATEST(0, "failedFilamentUsedMeters" - old_failed_filament_meters),
      "cancelledFilamentUsedMeters" = GREATEST(0, "cancelledFilamentUsedMeters" - old_cancelled_filament_meters),
      "wastedFilamentUsedMeters" = GREATEST(0, "wastedFilamentUsedMeters" - old_wasted_filament_meters),
      "updatedAt" = CURRENT_TIMESTAMP
    WHERE "workspaceId" = OLD."workspaceId";

    INSERT INTO "WorkspaceStats" (
      "workspaceId",
      "totalPrints",
      "successfulPrints",
      "failedPrints",
      "cancelledPrints",
      "successfulPrintDurationSeconds",
      "failedPrintDurationSeconds",
      "cancelledPrintDurationSeconds",
      "wastedPrintDurationSeconds",
      "trackedFilamentPrints",
      "filamentUsedGrams",
      "successfulFilamentUsedGrams",
      "failedFilamentUsedGrams",
      "cancelledFilamentUsedGrams",
      "wastedFilamentUsedGrams",
      "filamentUsedMeters",
      "successfulFilamentUsedMeters",
      "failedFilamentUsedMeters",
      "cancelledFilamentUsedMeters",
      "wastedFilamentUsedMeters",
      "updatedAt"
    )
    VALUES (
      NEW."workspaceId",
      new_total,
      new_success,
      new_failed,
      new_cancelled,
      new_success_duration,
      new_failed_duration,
      new_cancelled_duration,
      new_wasted_duration,
      new_tracked_filament,
      new_filament_grams,
      new_successful_filament_grams,
      new_failed_filament_grams,
      new_cancelled_filament_grams,
      new_wasted_filament_grams,
      new_filament_meters,
      new_successful_filament_meters,
      new_failed_filament_meters,
      new_cancelled_filament_meters,
      new_wasted_filament_meters,
      CURRENT_TIMESTAMP
    )
    ON CONFLICT ("workspaceId") DO UPDATE
    SET
      "totalPrints" = "WorkspaceStats"."totalPrints" + new_total,
      "successfulPrints" = "WorkspaceStats"."successfulPrints" + new_success,
      "failedPrints" = "WorkspaceStats"."failedPrints" + new_failed,
      "cancelledPrints" = "WorkspaceStats"."cancelledPrints" + new_cancelled,
      "successfulPrintDurationSeconds" = "WorkspaceStats"."successfulPrintDurationSeconds" + new_success_duration,
      "failedPrintDurationSeconds" = "WorkspaceStats"."failedPrintDurationSeconds" + new_failed_duration,
      "cancelledPrintDurationSeconds" = "WorkspaceStats"."cancelledPrintDurationSeconds" + new_cancelled_duration,
      "wastedPrintDurationSeconds" = "WorkspaceStats"."wastedPrintDurationSeconds" + new_wasted_duration,
      "trackedFilamentPrints" = "WorkspaceStats"."trackedFilamentPrints" + new_tracked_filament,
      "filamentUsedGrams" = "WorkspaceStats"."filamentUsedGrams" + new_filament_grams,
      "successfulFilamentUsedGrams" = "WorkspaceStats"."successfulFilamentUsedGrams" + new_successful_filament_grams,
      "failedFilamentUsedGrams" = "WorkspaceStats"."failedFilamentUsedGrams" + new_failed_filament_grams,
      "cancelledFilamentUsedGrams" = "WorkspaceStats"."cancelledFilamentUsedGrams" + new_cancelled_filament_grams,
      "wastedFilamentUsedGrams" = "WorkspaceStats"."wastedFilamentUsedGrams" + new_wasted_filament_grams,
      "filamentUsedMeters" = "WorkspaceStats"."filamentUsedMeters" + new_filament_meters,
      "successfulFilamentUsedMeters" = "WorkspaceStats"."successfulFilamentUsedMeters" + new_successful_filament_meters,
      "failedFilamentUsedMeters" = "WorkspaceStats"."failedFilamentUsedMeters" + new_failed_filament_meters,
      "cancelledFilamentUsedMeters" = "WorkspaceStats"."cancelledFilamentUsedMeters" + new_cancelled_filament_meters,
      "wastedFilamentUsedMeters" = "WorkspaceStats"."wastedFilamentUsedMeters" + new_wasted_filament_meters,
      "updatedAt" = CURRENT_TIMESTAMP;
    RETURN NEW;
  END IF;

  UPDATE "WorkspaceStats"
  SET
    "totalPrints" = GREATEST(0, "totalPrints" + new_total - old_total),
    "successfulPrints" = GREATEST(0, "successfulPrints" + new_success - old_success),
    "failedPrints" = GREATEST(0, "failedPrints" + new_failed - old_failed),
    "cancelledPrints" = GREATEST(0, "cancelledPrints" + new_cancelled - old_cancelled),
    "successfulPrintDurationSeconds" = GREATEST(0, "successfulPrintDurationSeconds" + new_success_duration - old_success_duration),
    "failedPrintDurationSeconds" = GREATEST(0, "failedPrintDurationSeconds" + new_failed_duration - old_failed_duration),
    "cancelledPrintDurationSeconds" = GREATEST(0, "cancelledPrintDurationSeconds" + new_cancelled_duration - old_cancelled_duration),
    "wastedPrintDurationSeconds" = GREATEST(0, "wastedPrintDurationSeconds" + new_wasted_duration - old_wasted_duration),
    "trackedFilamentPrints" = GREATEST(0, "trackedFilamentPrints" + new_tracked_filament - old_tracked_filament),
    "filamentUsedGrams" = GREATEST(0, "filamentUsedGrams" + new_filament_grams - old_filament_grams),
    "successfulFilamentUsedGrams" = GREATEST(0, "successfulFilamentUsedGrams" + new_successful_filament_grams - old_successful_filament_grams),
    "failedFilamentUsedGrams" = GREATEST(0, "failedFilamentUsedGrams" + new_failed_filament_grams - old_failed_filament_grams),
    "cancelledFilamentUsedGrams" = GREATEST(0, "cancelledFilamentUsedGrams" + new_cancelled_filament_grams - old_cancelled_filament_grams),
    "wastedFilamentUsedGrams" = GREATEST(0, "wastedFilamentUsedGrams" + new_wasted_filament_grams - old_wasted_filament_grams),
    "filamentUsedMeters" = GREATEST(0, "filamentUsedMeters" + new_filament_meters - old_filament_meters),
    "successfulFilamentUsedMeters" = GREATEST(0, "successfulFilamentUsedMeters" + new_successful_filament_meters - old_successful_filament_meters),
    "failedFilamentUsedMeters" = GREATEST(0, "failedFilamentUsedMeters" + new_failed_filament_meters - old_failed_filament_meters),
    "cancelledFilamentUsedMeters" = GREATEST(0, "cancelledFilamentUsedMeters" + new_cancelled_filament_meters - old_cancelled_filament_meters),
    "wastedFilamentUsedMeters" = GREATEST(0, "wastedFilamentUsedMeters" + new_wasted_filament_meters - old_wasted_filament_meters),
    "updatedAt" = CURRENT_TIMESTAMP
  WHERE "workspaceId" = NEW."workspaceId";

  RETURN NEW;
END;
$function$
;

CREATE TRIGGER platform_print_stats_sync AFTER INSERT OR DELETE OR UPDATE ON public."WorkspaceStats" FOR EACH ROW EXECUTE FUNCTION sync_platform_stats_from_workspace_stats();
CREATE TRIGGER platform_workspace_counts_sync_on_membership AFTER INSERT OR DELETE OR UPDATE ON public."AuthWorkspaceMembership" FOR EACH ROW EXECUTE FUNCTION refresh_platform_workspace_counts();
CREATE TRIGGER platform_workspace_counts_sync_on_printer AFTER INSERT OR DELETE ON public."Printer" FOR EACH ROW EXECUTE FUNCTION refresh_platform_workspace_counts();
CREATE TRIGGER platform_workspace_counts_sync_on_workspace AFTER INSERT OR DELETE ON public."Workspace" FOR EACH ROW EXECUTE FUNCTION refresh_platform_workspace_counts();
CREATE TRIGGER workspace_print_stats_sync AFTER INSERT OR UPDATE ON public."PrintJob" FOR EACH ROW EXECUTE FUNCTION sync_workspace_print_stats();
CREATE TRIGGER workspace_stats_row_insert AFTER INSERT ON public."Workspace" FOR EACH ROW EXECUTE FUNCTION ensure_workspace_stats_row();
