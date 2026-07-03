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

-- CreateIndex
CREATE INDEX "SupportConversation_lastMessageAt_idx" ON "SupportConversation"("lastMessageAt");

-- CreateIndex
CREATE INDEX "SupportConversation_userId_lastMessageAt_idx" ON "SupportConversation"("userId", "lastMessageAt");

-- CreateIndex
CREATE INDEX "SupportConversation_status_lastMessageAt_idx" ON "SupportConversation"("status", "lastMessageAt");

-- CreateIndex
CREATE INDEX "SupportMessage_conversationId_createdAt_idx" ON "SupportMessage"("conversationId", "createdAt");

-- AddForeignKey
ALTER TABLE "SupportMessage" ADD CONSTRAINT "SupportMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "SupportConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Migrate existing feedback reports: each becomes a conversation holding its
-- original message. Resolved reports count as read on the platform side;
-- unresolved ones stay unread so they surface in the new inbox.
INSERT INTO "SupportConversation" (
    "id", "kind", "subject", "status", "userId", "userEmail", "userName",
    "tenantId", "tenantName", "resolvedAt", "lastMessageAt",
    "userLastReadAt", "platformLastReadAt", "createdAt", "updatedAt"
)
SELECT
    f."id",
    f."type",
    left(split_part(f."message", E'\n', 1), 80),
    CASE WHEN f."resolvedAt" IS NOT NULL THEN 'resolved' ELSE 'open' END,
    f."userId",
    f."userEmail",
    f."userName",
    f."tenantId",
    f."tenantName",
    f."resolvedAt",
    f."createdAt",
    f."createdAt",
    f."resolvedAt",
    f."createdAt",
    f."createdAt"
FROM "FeedbackReport" f;

INSERT INTO "SupportMessage" (
    "id", "conversationId", "side", "senderUserId", "senderName", "body",
    "pageUrl", "appVersion", "userAgent", "createdAt"
)
SELECT
    f."id" || '-msg',
    f."id",
    'user',
    f."userId",
    COALESCE(f."userName", f."userEmail", 'Unknown user'),
    f."message",
    f."pageUrl",
    f."appVersion",
    f."userAgent",
    f."createdAt"
FROM "FeedbackReport" f;

-- DropTable
DROP TABLE "FeedbackReport";
