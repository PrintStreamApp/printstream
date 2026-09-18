-- Existing values were measured without forcing linear compensation. Preserve that behaviour.
ALTER TABLE "CalibrationResult" ADD COLUMN "pressureAdvanceMode" TEXT NOT NULL DEFAULT 'native';
