-- Deferred support notification emails: one row per message, sent by a
-- sweeper after an escalation delay unless the recipient side read the
-- thread first (see apps/api/src/private/cloud/support/pending-emails.ts).
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

-- CreateIndex
CREATE UNIQUE INDEX "SupportPendingEmail_messageId_key" ON "SupportPendingEmail"("messageId");

-- CreateIndex
CREATE INDEX "SupportPendingEmail_sendAt_idx" ON "SupportPendingEmail"("sendAt");

-- CreateIndex
CREATE INDEX "SupportPendingEmail_conversationId_recipientSide_idx" ON "SupportPendingEmail"("conversationId", "recipientSide");

-- AddForeignKey
ALTER TABLE "SupportPendingEmail" ADD CONSTRAINT "SupportPendingEmail_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "SupportConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportPendingEmail" ADD CONSTRAINT "SupportPendingEmail_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "SupportMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
