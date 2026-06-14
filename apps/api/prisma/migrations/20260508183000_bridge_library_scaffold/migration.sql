-- CreateTable: Bridge
CREATE TABLE "Bridge" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "name" TEXT NOT NULL,
    "connectCode" TEXT,
    "lastSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Bridge_pkey" PRIMARY KEY ("id")
);

-- AlterTable: Printer
ALTER TABLE "Printer"
ADD COLUMN "bridgeId" TEXT;

-- AlterTable: LibraryFile
ALTER TABLE "LibraryFile"
ADD COLUMN "ownerBridgeId" TEXT;

-- AlterTable: LibraryFolder
ALTER TABLE "LibraryFolder"
ADD COLUMN "ownerBridgeId" TEXT;

-- CreateTable: LibraryFileReplica
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

-- CreateIndex: Bridge_connectCode_key
CREATE UNIQUE INDEX "Bridge_connectCode_key" ON "Bridge"("connectCode");

-- CreateIndex: Bridge_tenantId_createdAt_idx
CREATE INDEX "Bridge_tenantId_createdAt_idx" ON "Bridge"("tenantId", "createdAt");

-- CreateIndex: Printer_tenantId_bridgeId_position_idx
CREATE INDEX "Printer_tenantId_bridgeId_position_idx" ON "Printer"("tenantId", "bridgeId", "position");

-- CreateIndex: LibraryFile_tenantId_ownerBridgeId_folderId_idx
CREATE INDEX "LibraryFile_tenantId_ownerBridgeId_folderId_idx" ON "LibraryFile"("tenantId", "ownerBridgeId", "folderId");

-- CreateIndex: LibraryFolder_tenantId_ownerBridgeId_parentId_idx
CREATE INDEX "LibraryFolder_tenantId_ownerBridgeId_parentId_idx" ON "LibraryFolder"("tenantId", "ownerBridgeId", "parentId");

-- CreateIndex: LibraryFileReplica_libraryFileId_bridgeId_key
CREATE UNIQUE INDEX "LibraryFileReplica_libraryFileId_bridgeId_key" ON "LibraryFileReplica"("libraryFileId", "bridgeId");

-- CreateIndex: LibraryFileReplica_tenantId_bridgeId_status_idx
CREATE INDEX "LibraryFileReplica_tenantId_bridgeId_status_idx" ON "LibraryFileReplica"("tenantId", "bridgeId", "status");

-- CreateIndex: LibraryFileReplica_tenantId_expiresAt_idx
CREATE INDEX "LibraryFileReplica_tenantId_expiresAt_idx" ON "LibraryFileReplica"("tenantId", "expiresAt");

-- AddForeignKey: Bridge_tenantId_fkey
ALTER TABLE "Bridge"
ADD CONSTRAINT "Bridge_tenantId_fkey"
FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey: Printer_bridgeId_fkey
ALTER TABLE "Printer"
ADD CONSTRAINT "Printer_bridgeId_fkey"
FOREIGN KEY ("bridgeId") REFERENCES "Bridge"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey: LibraryFile_ownerBridgeId_fkey
ALTER TABLE "LibraryFile"
ADD CONSTRAINT "LibraryFile_ownerBridgeId_fkey"
FOREIGN KEY ("ownerBridgeId") REFERENCES "Bridge"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey: LibraryFolder_ownerBridgeId_fkey
ALTER TABLE "LibraryFolder"
ADD CONSTRAINT "LibraryFolder_ownerBridgeId_fkey"
FOREIGN KEY ("ownerBridgeId") REFERENCES "Bridge"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey: LibraryFileReplica_tenantId_fkey
ALTER TABLE "LibraryFileReplica"
ADD CONSTRAINT "LibraryFileReplica_tenantId_fkey"
FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: LibraryFileReplica_libraryFileId_fkey
ALTER TABLE "LibraryFileReplica"
ADD CONSTRAINT "LibraryFileReplica_libraryFileId_fkey"
FOREIGN KEY ("libraryFileId") REFERENCES "LibraryFile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: LibraryFileReplica_bridgeId_fkey
ALTER TABLE "LibraryFileReplica"
ADD CONSTRAINT "LibraryFileReplica_bridgeId_fkey"
FOREIGN KEY ("bridgeId") REFERENCES "Bridge"("id") ON DELETE CASCADE ON UPDATE CASCADE;