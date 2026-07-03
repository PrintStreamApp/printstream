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

-- CreateIndex
CREATE UNIQUE INDEX "License_paddleTransactionId_key" ON "License"("paddleTransactionId");

-- CreateIndex
CREATE INDEX "License_email_idx" ON "License"("email");
