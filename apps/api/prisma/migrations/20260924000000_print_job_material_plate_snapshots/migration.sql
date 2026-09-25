ALTER TABLE "PrintJob"
  ADD COLUMN "slicedPlateType" TEXT,
  ADD COLUMN "materialTypesJson" TEXT,
  ADD COLUMN "printSetupJson" TEXT;

CREATE INDEX "PrintJob_workspaceId_slicedPlateType_result_idx"
  ON "PrintJob"("workspaceId", "slicedPlateType", "result")
  WHERE "finishedAt" IS NOT NULL AND "slicedPlateType" IS NOT NULL;

CREATE INDEX "PrintJob_workspace_material_snapshot_date_idx"
  ON "PrintJob"("workspaceId", "finishedAt", "result")
  WHERE "finishedAt" IS NOT NULL AND "materialTypesJson" IS NOT NULL;
