-- Platform-team triage status on suggestion board posts ('open' | 'investigating'
-- | 'planned' | 'in-progress' | 'completed' | 'declined' | 'not-possible').
ALTER TABLE "Suggestion" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'open';
