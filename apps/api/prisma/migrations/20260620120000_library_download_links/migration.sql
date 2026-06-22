-- Short-lived, unauthenticated download grants for a single library file.
-- Minted on demand (e.g. the "Open in Bambu Studio" desktop deep link) so an
-- external client with no browser session can fetch one file briefly. Only the
-- token's SHA-256 hash is stored; the raw token lives only in the issued URL.
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

CREATE UNIQUE INDEX "LibraryDownloadLink_tokenHash_key" ON "LibraryDownloadLink"("tokenHash");

CREATE INDEX "LibraryDownloadLink_expiresAt_idx" ON "LibraryDownloadLink"("expiresAt");

CREATE INDEX "LibraryDownloadLink_libraryFileId_idx" ON "LibraryDownloadLink"("libraryFileId");

ALTER TABLE "LibraryDownloadLink"
ADD CONSTRAINT "LibraryDownloadLink_tenantId_fkey"
FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "LibraryDownloadLink"
ADD CONSTRAINT "LibraryDownloadLink_libraryFileId_fkey"
FOREIGN KEY ("libraryFileId") REFERENCES "LibraryFile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
