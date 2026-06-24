-- Email/password credential for the OSS `auth-password` provider. One row per
-- user; `passwordHash` is an algorithm-tagged, salted hash (argon2id, or a
-- scrypt fallback), never a reversible secret. `mustChangePassword` is set when
-- an admin sets/resets the password and cleared on the user's next self-change.
CREATE TABLE "AuthPasswordCredential" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
    "lastChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AuthPasswordCredential_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AuthPasswordCredential_userId_key" ON "AuthPasswordCredential"("userId");

ALTER TABLE "AuthPasswordCredential"
ADD CONSTRAINT "AuthPasswordCredential_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "AuthUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
