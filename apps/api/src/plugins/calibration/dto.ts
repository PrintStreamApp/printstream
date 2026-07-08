/**
 * Row → wire DTO mapping for the calibration plugin. The `parametersJson` /
 * `measuredJson` JSON columns are validated back into their typed shapes with the
 * shared schemas so a malformed row surfaces as an error rather than leaking
 * untyped JSON to the client.
 */
import type { CalibrationRun as CalibrationRunRow, CalibrationResult as CalibrationResultRow } from '@prisma/client'
import {
  calibrationKindSchema,
  calibrationMeasurementSchema,
  calibrationParametersSchema,
  calibrationRunStatusSchema,
  calibrationScopeSchema,
  type CalibrationParameters,
  type CalibrationResult,
  type CalibrationRun
} from '@printstream/shared'

/** Parse a run row's stored `parametersJson` back into its typed shape. */
export function toCalibrationRunParameters(row: CalibrationRunRow): CalibrationParameters {
  return calibrationParametersSchema.parse(row.parametersJson)
}

export function toCalibrationRunDto(row: CalibrationRunRow): CalibrationRun {
  return {
    id: row.id,
    kind: calibrationKindSchema.parse(row.kind),
    status: calibrationRunStatusSchema.parse(row.status),
    printerId: row.printerId,
    printerModel: row.printerModel,
    nozzleDiameter: row.nozzleDiameter,
    amsId: row.amsId,
    slotId: row.slotId,
    spoolId: row.spoolId,
    brand: row.brand,
    filamentType: row.filamentType,
    materialSubtype: row.materialSubtype,
    colorName: row.colorName,
    parameters: calibrationParametersSchema.parse(row.parametersJson),
    slicingJobId: row.slicingJobId,
    outputFileId: row.outputFileId,
    errorMessage: row.errorMessage,
    measurement: row.measuredJson == null ? null : calibrationMeasurementSchema.parse(row.measuredJson),
    resultValue: row.resultValue,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  }
}

export function toCalibrationResultDto(row: CalibrationResultRow): CalibrationResult {
  return {
    id: row.id,
    kind: calibrationKindSchema.parse(row.kind),
    value: row.value,
    printerModel: row.printerModel,
    nozzleDiameter: row.nozzleDiameter,
    scope: calibrationScopeSchema.parse(row.scope),
    spoolId: row.spoolId,
    brand: row.brand,
    filamentType: row.filamentType,
    materialSubtype: row.materialSubtype,
    colorName: row.colorName,
    runId: row.runId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  }
}
