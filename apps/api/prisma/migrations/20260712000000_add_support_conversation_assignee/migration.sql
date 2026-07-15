-- Support conversations can be claimed by a platform operator. Unclaimed
-- conversations notify every operator; claimed ones notify only the assignee.
ALTER TABLE "SupportConversation" ADD COLUMN "assignedToUserId" TEXT;
ALTER TABLE "SupportConversation" ADD COLUMN "assignedToName" TEXT;
