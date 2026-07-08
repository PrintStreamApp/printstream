-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "Tenant" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TenantSubscription" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "plan" TEXT NOT NULL DEFAULT 'free',
    "status" TEXT NOT NULL DEFAULT 'active',
    "paddleCustomerId" TEXT,
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

    CONSTRAINT "TenantSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "License" (
    "id" TEXT NOT NULL,
    "edition" TEXT NOT NULL,
    "licensee" TEXT NOT NULL,
    "email" TEXT,
    "key" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "paddleCustomerId" TEXT,
    "paddleTransactionId" TEXT,
    "updatesUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "License_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Printer" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
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
    "tenantId" TEXT,
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
    "tenantId" TEXT NOT NULL,
    "printerId" TEXT NOT NULL,
    "taskId" TEXT,
    "printerFilePath" TEXT,
    "jobName" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL DEFAULT 'library',
    "calibrationOption" INTEGER,
    "fileId" TEXT,
    "fileName" TEXT,
    "fileSizeBytes" INTEGER,
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
    "tenantId" TEXT NOT NULL,
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
CREATE TABLE "TenantStats" (
    "tenantId" TEXT NOT NULL,
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
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TenantStats_pkey" PRIMARY KEY ("tenantId")
);

-- CreateTable
CREATE TABLE "PlatformStats" (
    "id" TEXT NOT NULL,
    "tenantCount" INTEGER NOT NULL DEFAULT 0,
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
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformStats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PrinterStats" (
    "tenantId" TEXT NOT NULL,
    "printerSerial" TEXT NOT NULL,
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
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PrinterStats_pkey" PRIMARY KEY ("tenantId","printerSerial")
);

-- CreateTable
CREATE TABLE "LibraryFile" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
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

    CONSTRAINT "LibraryFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LibraryFileFavorite" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "libraryFileId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LibraryFileFavorite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LibraryFileVersion" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
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
    "tenantId" TEXT NOT NULL,
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
    "tenantId" TEXT NOT NULL,
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
    "tenantId" TEXT NOT NULL,
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
    "tenantId" TEXT NOT NULL,
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
CREATE TABLE "AuthTenantMembership" (
    "userId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "loginDisabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AuthTenantMembership_pkey" PRIMARY KEY ("userId","tenantId")
);

-- CreateTable
CREATE TABLE "AuthGroup" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
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
    "tenantId" TEXT NOT NULL,
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
CREATE TABLE "AuthMagicLinkToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "email" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "redirectTo" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuthMagicLinkToken_pkey" PRIMARY KEY ("id")
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
    "tenantId" TEXT,
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
    "tenantId" TEXT NOT NULL,
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
    "tenantId" TEXT NOT NULL,
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
    "tenantId" TEXT NOT NULL,
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
    "tenantId" TEXT NOT NULL,
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

-- CreateTable
CREATE TABLE "OrderPrint" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
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
    "tenantId" TEXT NOT NULL,
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
    "tenantId" TEXT NOT NULL,
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
    "tenantId" TEXT NOT NULL,
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
    "tenantId" TEXT NOT NULL,
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
    "tenantId" TEXT NOT NULL,
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
    "tenantId" TEXT,
    "tenantName" TEXT,
    "resolvedAt" TIMESTAMP(3),
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
CREATE TABLE "Suggestion" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
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
    "usedByTenantId" TEXT,

    CONSTRAINT "BetaInviteCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PendingRegistration" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "displayName" TEXT,
    "workspaceName" TEXT NOT NULL,
    "inviteCodeId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PendingRegistration_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Tenant_slug_key" ON "Tenant"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Tenant_name_key" ON "Tenant"("name");

-- CreateIndex
CREATE UNIQUE INDEX "TenantSubscription_tenantId_key" ON "TenantSubscription"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "TenantSubscription_paddleSubscriptionId_key" ON "TenantSubscription"("paddleSubscriptionId");

-- CreateIndex
CREATE INDEX "TenantSubscription_paddleCustomerId_idx" ON "TenantSubscription"("paddleCustomerId");

-- CreateIndex
CREATE UNIQUE INDEX "License_paddleTransactionId_key" ON "License"("paddleTransactionId");

-- CreateIndex
CREATE INDEX "License_email_idx" ON "License"("email");

-- CreateIndex
CREATE INDEX "Printer_tenantId_bridgeId_position_idx" ON "Printer"("tenantId", "bridgeId", "position");

-- CreateIndex
CREATE INDEX "Printer_tenantId_position_idx" ON "Printer"("tenantId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "Printer_tenantId_serial_key" ON "Printer"("tenantId", "serial");

-- CreateIndex
CREATE UNIQUE INDEX "Bridge_connectCode_key" ON "Bridge"("connectCode");

-- CreateIndex
CREATE UNIQUE INDEX "Bridge_installationId_key" ON "Bridge"("installationId");

-- CreateIndex
CREATE INDEX "Bridge_tenantId_createdAt_idx" ON "Bridge"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "Bridge_runtimeTokenHash_idx" ON "Bridge"("runtimeTokenHash");

-- CreateIndex
CREATE INDEX "PrintJob_tenantId_printerId_startedAt_idx" ON "PrintJob"("tenantId", "printerId", "startedAt");

-- CreateIndex
CREATE INDEX "PrintJob_tenantId_printerId_finishedAt_startedAt_idx" ON "PrintJob"("tenantId", "printerId", "finishedAt", "startedAt");

-- CreateIndex
CREATE INDEX "PrintJob_tenantId_printerId_taskId_idx" ON "PrintJob"("tenantId", "printerId", "taskId");

-- CreateIndex
CREATE INDEX "PrintJob_tenantId_finishedAt_printerId_idx" ON "PrintJob"("tenantId", "finishedAt", "printerId");

-- CreateIndex
CREATE INDEX "PrintJob_tenantId_fileId_idx" ON "PrintJob"("tenantId", "fileId");

-- CreateIndex
CREATE INDEX "DispatchJob_tenantId_printerId_status_idx" ON "DispatchJob"("tenantId", "printerId", "status");

-- CreateIndex
CREATE INDEX "DispatchJob_printerId_status_idx" ON "DispatchJob"("printerId", "status");

-- CreateIndex
CREATE INDEX "PrinterStats_tenantId_updatedAt_idx" ON "PrinterStats"("tenantId", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "LibraryFile_snapshotKey_key" ON "LibraryFile"("snapshotKey");

-- CreateIndex
CREATE INDEX "LibraryFile_tenantId_uploadedAt_idx" ON "LibraryFile"("tenantId", "uploadedAt");

-- CreateIndex
CREATE INDEX "LibraryFile_tenantId_folderId_idx" ON "LibraryFile"("tenantId", "folderId");

-- CreateIndex
CREATE INDEX "LibraryFile_tenantId_ownerBridgeId_folderId_idx" ON "LibraryFile"("tenantId", "ownerBridgeId", "folderId");

-- CreateIndex
CREATE INDEX "LibraryFile_tenantId_hidden_uploadedAt_idx" ON "LibraryFile"("tenantId", "hidden", "uploadedAt");

-- CreateIndex
CREATE INDEX "LibraryFile_tenantId_ownerBridgeId_folderId_name_hidden_upl_idx" ON "LibraryFile"("tenantId", "ownerBridgeId", "folderId", "name", "hidden", "uploadedAt");

-- CreateIndex
CREATE INDEX "LibraryFile_tenantId_deletedAt_idx" ON "LibraryFile"("tenantId", "deletedAt");

-- CreateIndex
CREATE INDEX "LibraryFile_tenant_bridge_folder_printCount_idx" ON "LibraryFile"("tenantId", "ownerBridgeId", "folderId", "hidden", "printCount");

-- CreateIndex
CREATE INDEX "LibraryFile_tenant_bridge_folder_lastPrintedAt_idx" ON "LibraryFile"("tenantId", "ownerBridgeId", "folderId", "hidden", "lastPrintedAt");

-- CreateIndex
CREATE INDEX "LibraryFileFavorite_tenantId_userId_idx" ON "LibraryFileFavorite"("tenantId", "userId");

-- CreateIndex
CREATE INDEX "LibraryFileFavorite_libraryFileId_idx" ON "LibraryFileFavorite"("libraryFileId");

-- CreateIndex
CREATE UNIQUE INDEX "LibraryFileFavorite_userId_libraryFileId_key" ON "LibraryFileFavorite"("userId", "libraryFileId");

-- CreateIndex
CREATE INDEX "LibraryFileVersion_tenantId_libraryFileId_versionNumber_idx" ON "LibraryFileVersion"("tenantId", "libraryFileId", "versionNumber");

-- CreateIndex
CREATE UNIQUE INDEX "LibraryFileVersion_libraryFileId_versionNumber_key" ON "LibraryFileVersion"("libraryFileId", "versionNumber");

-- CreateIndex
CREATE UNIQUE INDEX "LibraryDownloadLink_tokenHash_key" ON "LibraryDownloadLink"("tokenHash");

-- CreateIndex
CREATE INDEX "LibraryDownloadLink_expiresAt_idx" ON "LibraryDownloadLink"("expiresAt");

-- CreateIndex
CREATE INDEX "LibraryDownloadLink_libraryFileId_idx" ON "LibraryDownloadLink"("libraryFileId");

-- CreateIndex
CREATE INDEX "LibraryFolder_tenantId_ownerBridgeId_parentId_idx" ON "LibraryFolder"("tenantId", "ownerBridgeId", "parentId");

-- CreateIndex
CREATE INDEX "LibraryFolder_tenantId_parentId_idx" ON "LibraryFolder"("tenantId", "parentId");

-- CreateIndex
CREATE UNIQUE INDEX "LibraryFolder_tenantId_parentId_name_key" ON "LibraryFolder"("tenantId", "parentId", "name");

-- CreateIndex
CREATE INDEX "LibraryFileReplica_tenantId_bridgeId_status_idx" ON "LibraryFileReplica"("tenantId", "bridgeId", "status");

-- CreateIndex
CREATE INDEX "LibraryFileReplica_tenantId_expiresAt_idx" ON "LibraryFileReplica"("tenantId", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "LibraryFileReplica_libraryFileId_bridgeId_key" ON "LibraryFileReplica"("libraryFileId", "bridgeId");

-- CreateIndex
CREATE INDEX "PrinterView_tenantId_name_idx" ON "PrinterView"("tenantId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "PrinterView_tenantId_name_key" ON "PrinterView"("tenantId", "name");

-- CreateIndex
CREATE INDEX "AuthUser_email_idx" ON "AuthUser"("email");

-- CreateIndex
CREATE INDEX "AuthUser_createdAt_idx" ON "AuthUser"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AuthUser_email_key" ON "AuthUser"("email");

-- CreateIndex
CREATE INDEX "AuthTenantMembership_tenantId_createdAt_idx" ON "AuthTenantMembership"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "AuthTenantMembership_tenantId_loginDisabled_idx" ON "AuthTenantMembership"("tenantId", "loginDisabled");

-- CreateIndex
CREATE INDEX "AuthGroup_tenantId_key_idx" ON "AuthGroup"("tenantId", "key");

-- CreateIndex
CREATE INDEX "AuthGroup_tenantId_createdAt_idx" ON "AuthGroup"("tenantId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AuthGroup_tenantId_key_key" ON "AuthGroup"("tenantId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "AuthGroup_tenantId_name_key" ON "AuthGroup"("tenantId", "name");

-- CreateIndex
CREATE INDEX "AuthUserGroupMembership_groupId_idx" ON "AuthUserGroupMembership"("groupId");

-- CreateIndex
CREATE UNIQUE INDEX "AuthServiceAccount_tokenHash_key" ON "AuthServiceAccount"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "AuthServiceAccount_tokenPrefix_key" ON "AuthServiceAccount"("tokenPrefix");

-- CreateIndex
CREATE INDEX "AuthServiceAccount_tenantId_createdAt_idx" ON "AuthServiceAccount"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "AuthServiceAccount_tenantId_revokedAt_idx" ON "AuthServiceAccount"("tenantId", "revokedAt");

-- CreateIndex
CREATE INDEX "AuthServiceAccountGroupMembership_groupId_idx" ON "AuthServiceAccountGroupMembership"("groupId");

-- CreateIndex
CREATE UNIQUE INDEX "AuthPasskeyCredential_credentialId_key" ON "AuthPasskeyCredential"("credentialId");

-- CreateIndex
CREATE INDEX "AuthPasskeyCredential_userId_idx" ON "AuthPasskeyCredential"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "AuthPasswordCredential_userId_key" ON "AuthPasswordCredential"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "AuthMagicLinkToken_tokenHash_key" ON "AuthMagicLinkToken"("tokenHash");

-- CreateIndex
CREATE INDEX "AuthMagicLinkToken_email_expiresAt_idx" ON "AuthMagicLinkToken"("email", "expiresAt");

-- CreateIndex
CREATE INDEX "AuthMagicLinkToken_userId_expiresAt_idx" ON "AuthMagicLinkToken"("userId", "expiresAt");

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
CREATE INDEX "AuditLog_tenantId_createdAt_idx" ON "AuditLog"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_actorUserId_createdAt_idx" ON "AuditLog"("actorUserId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_actorServiceAccountId_createdAt_idx" ON "AuditLog"("actorServiceAccountId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_action_createdAt_idx" ON "AuditLog"("action", "createdAt");

-- CreateIndex
CREATE INDEX "OrderTemplate_tenantId_name_idx" ON "OrderTemplate"("tenantId", "name");

-- CreateIndex
CREATE INDEX "OrderTemplate_tenantId_createdAt_idx" ON "OrderTemplate"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "OrderTemplateVariant_tenantId_templateId_position_idx" ON "OrderTemplateVariant"("tenantId", "templateId", "position");

-- CreateIndex
CREATE INDEX "OrderTemplatePrint_tenantId_templateVariantId_position_idx" ON "OrderTemplatePrint"("tenantId", "templateVariantId", "position");

-- CreateIndex
CREATE INDEX "OrderTemplatePrint_tenantId_libraryFileId_idx" ON "OrderTemplatePrint"("tenantId", "libraryFileId");

-- CreateIndex
CREATE INDEX "Order_tenantId_templateId_idx" ON "Order"("tenantId", "templateId");

-- CreateIndex
CREATE INDEX "Order_tenantId_status_createdAt_idx" ON "Order"("tenantId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "OrderVariantSelection_tenantId_orderId_position_idx" ON "OrderVariantSelection"("tenantId", "orderId", "position");

-- CreateIndex
CREATE INDEX "OrderVariantSelection_tenantId_templateVariantId_idx" ON "OrderVariantSelection"("tenantId", "templateVariantId");

-- CreateIndex
CREATE INDEX "OrderPrint_tenantId_orderId_groupPosition_sequenceNumber_idx" ON "OrderPrint"("tenantId", "orderId", "groupPosition", "sequenceNumber");

-- CreateIndex
CREATE INDEX "OrderPrint_tenantId_status_startedAt_idx" ON "OrderPrint"("tenantId", "status", "startedAt");

-- CreateIndex
CREATE INDEX "OrderPrint_tenantId_templateVariantId_idx" ON "OrderPrint"("tenantId", "templateVariantId");

-- CreateIndex
CREATE INDEX "OrderPrint_tenantId_libraryFileId_idx" ON "OrderPrint"("tenantId", "libraryFileId");

-- CreateIndex
CREATE INDEX "OrderPrint_tenantId_startedPrinterId_idx" ON "OrderPrint"("tenantId", "startedPrinterId");

-- CreateIndex
CREATE INDEX "OrderPrint_tenantId_lastPrintJobId_idx" ON "OrderPrint"("tenantId", "lastPrintJobId");

-- CreateIndex
CREATE INDEX "FilamentSpool_tenantId_deletedAt_idx" ON "FilamentSpool"("tenantId", "deletedAt");

-- CreateIndex
CREATE INDEX "FilamentSpool_tenantId_filamentType_idx" ON "FilamentSpool"("tenantId", "filamentType");

-- CreateIndex
CREATE INDEX "FilamentSpool_tenantId_brand_idx" ON "FilamentSpool"("tenantId", "brand");

-- CreateIndex
CREATE INDEX "FilamentSpool_tenantId_loadedPrinterId_idx" ON "FilamentSpool"("tenantId", "loadedPrinterId");

-- CreateIndex
CREATE INDEX "FilamentSpool_tenantId_bambuUuid_idx" ON "FilamentSpool"("tenantId", "bambuUuid");

-- CreateIndex
CREATE INDEX "FilamentSpoolUsage_tenantId_spoolId_recordedAt_idx" ON "FilamentSpoolUsage"("tenantId", "spoolId", "recordedAt");

-- CreateIndex
CREATE INDEX "FilamentSpoolUsage_tenantId_jobId_idx" ON "FilamentSpoolUsage"("tenantId", "jobId");

-- CreateIndex
CREATE INDEX "CalibrationRun_tenantId_status_createdAt_idx" ON "CalibrationRun"("tenantId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "CalibrationRun_tenantId_printerId_idx" ON "CalibrationRun"("tenantId", "printerId");

-- CreateIndex
CREATE INDEX "CalibrationRun_tenantId_spoolId_idx" ON "CalibrationRun"("tenantId", "spoolId");

-- CreateIndex
CREATE INDEX "CalibrationResult_tenantId_kind_printerModel_nozzleDiameter_idx" ON "CalibrationResult"("tenantId", "kind", "printerModel", "nozzleDiameter");

-- CreateIndex
CREATE INDEX "CalibrationResult_tenantId_spoolId_idx" ON "CalibrationResult"("tenantId", "spoolId");

-- CreateIndex
CREATE INDEX "QueueItem_tenantId_status_sortKey_idx" ON "QueueItem"("tenantId", "status", "sortKey");

-- CreateIndex
CREATE INDEX "QueueItem_tenantId_sortKey_idx" ON "QueueItem"("tenantId", "sortKey");

-- CreateIndex
CREATE INDEX "QueueItem_tenantId_libraryFileId_idx" ON "QueueItem"("tenantId", "libraryFileId");

-- CreateIndex
CREATE INDEX "QueueItem_tenantId_targetPrinterId_idx" ON "QueueItem"("tenantId", "targetPrinterId");

-- CreateIndex
CREATE INDEX "QueueItem_tenantId_lastPrinterId_idx" ON "QueueItem"("tenantId", "lastPrinterId");

-- CreateIndex
CREATE INDEX "QueueItem_tenantId_lastPrintJobId_idx" ON "QueueItem"("tenantId", "lastPrintJobId");

-- CreateIndex
CREATE INDEX "QueueItem_tenantId_orderPrintId_idx" ON "QueueItem"("tenantId", "orderPrintId");

-- CreateIndex
CREATE INDEX "SupportConversation_lastMessageAt_idx" ON "SupportConversation"("lastMessageAt");

-- CreateIndex
CREATE INDEX "SupportConversation_userId_lastMessageAt_idx" ON "SupportConversation"("userId", "lastMessageAt");

-- CreateIndex
CREATE INDEX "SupportConversation_status_lastMessageAt_idx" ON "SupportConversation"("status", "lastMessageAt");

-- CreateIndex
CREATE INDEX "SupportMessage_conversationId_createdAt_idx" ON "SupportMessage"("conversationId", "createdAt");

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
CREATE INDEX "PendingRegistration_email_expiresAt_idx" ON "PendingRegistration"("email", "expiresAt");

-- AddForeignKey
ALTER TABLE "TenantSubscription" ADD CONSTRAINT "TenantSubscription_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Printer" ADD CONSTRAINT "Printer_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Printer" ADD CONSTRAINT "Printer_bridgeId_fkey" FOREIGN KEY ("bridgeId") REFERENCES "Bridge"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Bridge" ADD CONSTRAINT "Bridge_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrintJob" ADD CONSTRAINT "PrintJob_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrintJob" ADD CONSTRAINT "PrintJob_printerId_fkey" FOREIGN KEY ("printerId") REFERENCES "Printer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrintJob" ADD CONSTRAINT "PrintJob_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "LibraryFile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DispatchJob" ADD CONSTRAINT "DispatchJob_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DispatchJob" ADD CONSTRAINT "DispatchJob_printerId_fkey" FOREIGN KEY ("printerId") REFERENCES "Printer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TenantStats" ADD CONSTRAINT "TenantStats_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrinterStats" ADD CONSTRAINT "PrinterStats_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LibraryFile" ADD CONSTRAINT "LibraryFile_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LibraryFile" ADD CONSTRAINT "LibraryFile_ownerBridgeId_fkey" FOREIGN KEY ("ownerBridgeId") REFERENCES "Bridge"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LibraryFile" ADD CONSTRAINT "LibraryFile_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "LibraryFolder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LibraryFileFavorite" ADD CONSTRAINT "LibraryFileFavorite_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LibraryFileFavorite" ADD CONSTRAINT "LibraryFileFavorite_libraryFileId_fkey" FOREIGN KEY ("libraryFileId") REFERENCES "LibraryFile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LibraryFileVersion" ADD CONSTRAINT "LibraryFileVersion_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LibraryFileVersion" ADD CONSTRAINT "LibraryFileVersion_libraryFileId_fkey" FOREIGN KEY ("libraryFileId") REFERENCES "LibraryFile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LibraryDownloadLink" ADD CONSTRAINT "LibraryDownloadLink_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LibraryDownloadLink" ADD CONSTRAINT "LibraryDownloadLink_libraryFileId_fkey" FOREIGN KEY ("libraryFileId") REFERENCES "LibraryFile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LibraryFolder" ADD CONSTRAINT "LibraryFolder_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LibraryFolder" ADD CONSTRAINT "LibraryFolder_ownerBridgeId_fkey" FOREIGN KEY ("ownerBridgeId") REFERENCES "Bridge"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LibraryFolder" ADD CONSTRAINT "LibraryFolder_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "LibraryFolder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LibraryFileReplica" ADD CONSTRAINT "LibraryFileReplica_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LibraryFileReplica" ADD CONSTRAINT "LibraryFileReplica_libraryFileId_fkey" FOREIGN KEY ("libraryFileId") REFERENCES "LibraryFile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LibraryFileReplica" ADD CONSTRAINT "LibraryFileReplica_bridgeId_fkey" FOREIGN KEY ("bridgeId") REFERENCES "Bridge"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrinterView" ADD CONSTRAINT "PrinterView_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthTenantMembership" ADD CONSTRAINT "AuthTenantMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "AuthUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthTenantMembership" ADD CONSTRAINT "AuthTenantMembership_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthGroup" ADD CONSTRAINT "AuthGroup_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthUserGroupMembership" ADD CONSTRAINT "AuthUserGroupMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "AuthUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthUserGroupMembership" ADD CONSTRAINT "AuthUserGroupMembership_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "AuthGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthServiceAccount" ADD CONSTRAINT "AuthServiceAccount_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthServiceAccountGroupMembership" ADD CONSTRAINT "AuthServiceAccountGroupMembership_serviceAccountId_fkey" FOREIGN KEY ("serviceAccountId") REFERENCES "AuthServiceAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthServiceAccountGroupMembership" ADD CONSTRAINT "AuthServiceAccountGroupMembership_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "AuthGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthPasskeyCredential" ADD CONSTRAINT "AuthPasskeyCredential_userId_fkey" FOREIGN KEY ("userId") REFERENCES "AuthUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthPasswordCredential" ADD CONSTRAINT "AuthPasswordCredential_userId_fkey" FOREIGN KEY ("userId") REFERENCES "AuthUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthMagicLinkToken" ADD CONSTRAINT "AuthMagicLinkToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "AuthUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthSession" ADD CONSTRAINT "AuthSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "AuthUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthSession" ADD CONSTRAINT "AuthSession_serviceAccountId_fkey" FOREIGN KEY ("serviceAccountId") REFERENCES "AuthServiceAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "AuthUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorServiceAccountId_fkey" FOREIGN KEY ("actorServiceAccountId") REFERENCES "AuthServiceAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderTemplate" ADD CONSTRAINT "OrderTemplate_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderTemplateVariant" ADD CONSTRAINT "OrderTemplateVariant_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderTemplateVariant" ADD CONSTRAINT "OrderTemplateVariant_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "OrderTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderTemplatePrint" ADD CONSTRAINT "OrderTemplatePrint_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderTemplatePrint" ADD CONSTRAINT "OrderTemplatePrint_templateVariantId_fkey" FOREIGN KEY ("templateVariantId") REFERENCES "OrderTemplateVariant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderTemplatePrint" ADD CONSTRAINT "OrderTemplatePrint_libraryFileId_fkey" FOREIGN KEY ("libraryFileId") REFERENCES "LibraryFile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "OrderTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderVariantSelection" ADD CONSTRAINT "OrderVariantSelection_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderVariantSelection" ADD CONSTRAINT "OrderVariantSelection_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderVariantSelection" ADD CONSTRAINT "OrderVariantSelection_templateVariantId_fkey" FOREIGN KEY ("templateVariantId") REFERENCES "OrderTemplateVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderPrint" ADD CONSTRAINT "OrderPrint_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

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
ALTER TABLE "FilamentSpool" ADD CONSTRAINT "FilamentSpool_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FilamentSpool" ADD CONSTRAINT "FilamentSpool_loadedPrinterId_fkey" FOREIGN KEY ("loadedPrinterId") REFERENCES "Printer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FilamentSpoolUsage" ADD CONSTRAINT "FilamentSpoolUsage_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FilamentSpoolUsage" ADD CONSTRAINT "FilamentSpoolUsage_spoolId_fkey" FOREIGN KEY ("spoolId") REFERENCES "FilamentSpool"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalibrationRun" ADD CONSTRAINT "CalibrationRun_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalibrationResult" ADD CONSTRAINT "CalibrationResult_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QueueItem" ADD CONSTRAINT "QueueItem_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

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
ALTER TABLE "SuggestionVote" ADD CONSTRAINT "SuggestionVote_suggestionId_fkey" FOREIGN KEY ("suggestionId") REFERENCES "Suggestion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SuggestionComment" ADD CONSTRAINT "SuggestionComment_suggestionId_fkey" FOREIGN KEY ("suggestionId") REFERENCES "Suggestion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SuggestionComment" ADD CONSTRAINT "SuggestionComment_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "SuggestionComment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PendingRegistration" ADD CONSTRAINT "PendingRegistration_inviteCodeId_fkey" FOREIGN KEY ("inviteCodeId") REFERENCES "BetaInviteCode"("id") ON DELETE CASCADE ON UPDATE CASCADE;

