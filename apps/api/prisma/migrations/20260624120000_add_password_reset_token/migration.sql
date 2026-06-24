-- Optional email password-reset for the OSS auth-password provider: a one-time
-- reset code (SHA-256 hash) and its expiry, populated only while a reset is
-- pending and cleared on use. Nullable so the provider works without email.
ALTER TABLE "AuthPasswordCredential"
ADD COLUMN "resetTokenHash" TEXT,
ADD COLUMN "resetTokenExpiresAt" TIMESTAMP(3);
