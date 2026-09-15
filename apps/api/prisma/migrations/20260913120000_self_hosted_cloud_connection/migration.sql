ALTER TABLE "SupportConversation"
  ADD COLUMN "customerId" TEXT,
  ADD COLUMN "customerName" TEXT,
  ADD COLUMN "licenseId" TEXT,
  ADD COLUMN "licenseName" TEXT,
  ADD COLUMN "installationFingerprint" TEXT;

CREATE INDEX "SupportConversation_license_install_fp_lastMessage_idx"
  ON "SupportConversation"("licenseId", "installationFingerprint", "lastMessageAt");

ALTER TABLE "Suggestion"
  ADD COLUMN "authorCustomerId" TEXT,
  ADD COLUMN "sourceLicenseId" TEXT,
  ADD COLUMN "sourceInstallationFingerprint" TEXT;

CREATE INDEX "Suggestion_authorCustomerId_idx" ON "Suggestion"("authorCustomerId");

ALTER TABLE "SuggestionComment"
  ADD COLUMN "authorCustomerId" TEXT,
  ADD COLUMN "sourceLicenseId" TEXT,
  ADD COLUMN "sourceInstallationFingerprint" TEXT;

CREATE INDEX "SuggestionComment_authorCustomerId_idx" ON "SuggestionComment"("authorCustomerId");
