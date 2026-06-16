-- Bridges are identified for lockstep updates by a release fingerprint
-- (content hash of the bridge-relevant sources) instead of a version number.
ALTER TABLE "Bridge" ADD COLUMN "releaseFingerprint" TEXT;
