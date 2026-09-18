/**
 * Data-access helpers for calibration runs and saved results.
 *
 * Every function takes an explicit `db` (the workspace-scoped request client, or
 * `rootPrisma` for event/startup code) and `workspaceId`, and filters by workspace on
 * every operation. Single-row writes use `updateMany`/`deleteMany` scoped by
 * `{ id, workspaceId }` so the workspace filter is enforced atomically.
 *
 * Saving a result de-dupes in code (not via a DB unique across nullable identity
 * columns): a save for the same target (kind + hardware target + nozzle + scope +
 * spool/identity) updates the existing row instead of accumulating duplicates.
 */
import { Prisma } from '@prisma/client'
import { calibrationPrinterTargetSchema, calibrationMatchesPrinter, type CalibrationPrinterTarget } from '@printstream/shared'
import type { CalibrationResult as CalibrationResultRow, CalibrationRun as CalibrationRunRow } from '@prisma/client'
import type { CalibrationKind, CalibrationMeasurement, CalibrationParameters, CalibrationRunStatus, CalibrationScope } from '@printstream/shared'
import type { AnyPrismaClient } from '../../lib/prisma.js'
import type { ResolvableCalibrationResult } from './resolution.js'

export interface FilamentIdentity {
  brand: string | null
  filamentType: string | null
  materialSubtype: string | null
  colorName: string | null
}

export interface CreateRunInput extends FilamentIdentity {
  status?: CalibrationRunStatus
  kind: CalibrationKind
  printerId: string | null
  printerModel: string
  nozzleDiameter: string
  amsId: number | null
  slotId: number | null
  spoolId: string | null
  parameters: CalibrationParameters
}

export async function createRun(db: AnyPrismaClient, workspaceId: string, input: CreateRunInput): Promise<CalibrationRunRow> {
  return db.calibrationRun.create({
    data: {
      workspaceId,
      kind: input.kind,
      status: input.status ?? 'slicing',
      printerId: input.printerId,
      printerModel: input.printerModel,
      nozzleDiameter: input.nozzleDiameter,
      amsId: input.amsId,
      slotId: input.slotId,
      spoolId: input.spoolId,
      brand: input.brand,
      filamentType: input.filamentType,
      materialSubtype: input.materialSubtype,
      colorName: input.colorName,
      parametersJson: input.parameters as unknown as Prisma.InputJsonValue
    }
  })
}

export async function getRun(db: AnyPrismaClient, workspaceId: string, id: string): Promise<CalibrationRunRow | null> {
  return db.calibrationRun.findFirst({ where: { id, workspaceId } })
}

export async function listRuns(db: AnyPrismaClient, workspaceId: string): Promise<CalibrationRunRow[]> {
  return db.calibrationRun.findMany({ where: { workspaceId }, orderBy: { createdAt: 'desc' } })
}

export interface RunPatch {
  parameters?: CalibrationParameters
  status?: CalibrationRunStatus
  slicingJobId?: string | null
  outputFileId?: string | null
  errorMessage?: string | null
  measurement?: CalibrationMeasurement | null
  resultValue?: number | null
  brand?: string | null
  filamentType?: string | null
  materialSubtype?: string | null
  colorName?: string | null
}

export async function updateRun(db: AnyPrismaClient, workspaceId: string, id: string, patch: RunPatch): Promise<void> {
  const data: Prisma.CalibrationRunUpdateManyMutationInput = {}
  if (patch.parameters !== undefined) data.parametersJson = patch.parameters as Prisma.InputJsonValue
  if (patch.status !== undefined) data.status = patch.status
  if (patch.slicingJobId !== undefined) data.slicingJobId = patch.slicingJobId
  if (patch.outputFileId !== undefined) data.outputFileId = patch.outputFileId
  if (patch.errorMessage !== undefined) data.errorMessage = patch.errorMessage
  if (patch.measurement !== undefined) data.measuredJson = (patch.measurement ?? Prisma.DbNull) as Prisma.InputJsonValue | typeof Prisma.DbNull
  if (patch.resultValue !== undefined) data.resultValue = patch.resultValue
  if (patch.brand !== undefined) data.brand = patch.brand
  if (patch.filamentType !== undefined) data.filamentType = patch.filamentType
  if (patch.materialSubtype !== undefined) data.materialSubtype = patch.materialSubtype
  if (patch.colorName !== undefined) data.colorName = patch.colorName
  await db.calibrationRun.updateMany({ where: { id, workspaceId }, data })
}

export async function deleteRun(db: AnyPrismaClient, workspaceId: string, id: string): Promise<void> {
  await db.calibrationRun.deleteMany({ where: { id, workspaceId } })
}

/** Find a run currently linked to a slicing job (used by the slice-completion listener). */
export async function findRunBySlicingJob(db: AnyPrismaClient, workspaceId: string, slicingJobId: string): Promise<CalibrationRunRow | null> {
  return db.calibrationRun.findFirst({ where: { workspaceId, slicingJobId } })
}

export interface SaveResultInput extends FilamentIdentity {
  printerTarget?: CalibrationPrinterTarget
  pressureAdvanceMode?: 'native' | 'linear'
  kind: CalibrationKind
  value: number
  printerModel: string
  nozzleDiameter: string
  scope: CalibrationScope
  spoolId: string | null
  runId: string | null
}

/**
 * Upsert a saved result: one row per target. For `scope: 'spool'` the target is
 * the spool; for `scope: 'identity'` it is the exact identity tuple stored (a
 * null field is a distinct target from a set field).
 */
export async function saveResult(db: AnyPrismaClient, workspaceId: string, input: SaveResultInput): Promise<CalibrationResultRow> {
  const target: Prisma.CalibrationResultWhereInput = {
    workspaceId,
    kind: input.kind,
    ...(input.printerTarget
      ? { OR: [
          { printerTargetJson: { equals: input.printerTarget } },
          ...(input.printerTarget.scope === 'models' && input.printerTarget.models.length === 1
            ? [{ printerTargetJson: { equals: Prisma.DbNull }, printerModel: input.printerTarget.models[0] }]
            : [])
        ] }
      : { printerModel: input.printerModel, printerTargetJson: { equals: Prisma.DbNull } }),
    nozzleDiameter: input.nozzleDiameter,
    scope: input.scope,
    ...(input.scope === 'spool'
      ? { spoolId: input.spoolId }
      : {
        brand: input.brand,
        filamentType: input.filamentType,
        materialSubtype: input.materialSubtype,
        colorName: input.colorName
      })
  }
  const existing = await db.calibrationResult.findFirst({ where: target })
  if (existing) {
    return db.calibrationResult.update({
      where: { id: existing.id },
      data: {
        value: input.value, runId: input.runId, printerModel: input.printerModel,
        pressureAdvanceMode: input.pressureAdvanceMode ?? 'native', printerTargetJson: input.printerTarget
      }
    })
  }
  return db.calibrationResult.create({
    data: {
      workspaceId,
      kind: input.kind,
      value: input.value,
      printerTargetJson: input.printerTarget,
      pressureAdvanceMode: input.pressureAdvanceMode ?? 'native',
      printerModel: input.printerModel,
      nozzleDiameter: input.nozzleDiameter,
      scope: input.scope,
      spoolId: input.scope === 'spool' ? input.spoolId : null,
      brand: input.scope === 'identity' ? input.brand : null,
      filamentType: input.scope === 'identity' ? input.filamentType : null,
      materialSubtype: input.scope === 'identity' ? input.materialSubtype : null,
      colorName: input.scope === 'identity' ? input.colorName : null,
      runId: input.runId
    }
  })
}

export async function listResults(db: AnyPrismaClient, workspaceId: string): Promise<CalibrationResultRow[]> {
  return db.calibrationResult.findMany({ where: { workspaceId }, orderBy: { updatedAt: 'desc' } })
}

export async function deleteResult(db: AnyPrismaClient, workspaceId: string, id: string): Promise<void> {
  await db.calibrationResult.deleteMany({ where: { id, workspaceId } })
}

/** Remove results still owned by one run before replacing that run's target set. */
export async function deleteResultsForRun(db: AnyPrismaClient, workspaceId: string, runId: string): Promise<void> {
  await db.calibrationResult.deleteMany({ where: { workspaceId, runId } })
}

/**
 * Candidate results for resolution: everything of one kind for a printer model +
 * nozzle. The caller ({@link ./resolution.js}) applies spool/identity precedence.
 */
export async function findResolvableResults(
  db: AnyPrismaClient,
  workspaceId: string,
  kind: CalibrationKind,
  printerModel: string,
  nozzleDiameter: string,
  printerId?: string | null
): Promise<ResolvableCalibrationResult[]> {
  const rows = await db.calibrationResult.findMany({
    where: { workspaceId, kind, nozzleDiameter }, orderBy: { updatedAt: 'desc' }
  })
  return rows.map((row) => ({
    printerModel: row.printerModel,
    nozzleDiameter: row.nozzleDiameter,
    printerTarget: row.printerTargetJson == null ? undefined : calibrationPrinterTargetSchema.parse(row.printerTargetJson),
    pressureAdvanceMode: row.pressureAdvanceMode === 'linear' ? 'linear' as const : 'native' as const,
    kind: row.kind as CalibrationKind,
    value: row.value,
    scope: row.scope as CalibrationScope,
    spoolId: row.spoolId,
    brand: row.brand,
    filamentType: row.filamentType,
    materialSubtype: row.materialSubtype,
    colorName: row.colorName
  })).filter((row) => calibrationMatchesPrinter(row, { printerId, printerModel, nozzleDiameter }))
}
