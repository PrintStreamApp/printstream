/** Saves calibration values independently of run history, without issuing printer commands. */
import type { ManualCalibrationResult } from '@printstream/shared'
import type { AnyPrismaClient } from '../../lib/prisma.js'
import { badRequest } from '../../lib/http-error.js'
import { saveResult } from './store.js'
import { validateCalibrationPrinterTarget } from './printer-target.js'

/** Validate targets before saving. An optional source run is provenance only and is never modified. */
export async function saveManualResult(db: AnyPrismaClient, workspaceId: string, input: ManualCalibrationResult, runId: string | null = null) {
  const { target } = input
  const printerTarget = await validateCalibrationPrinterTarget(db, workspaceId, target.printerTarget, input.printerModel)
  const identity = {
    brand: target.match?.brand ? target.identity?.brand?.trim() || null : null,
    filamentType: target.match?.filamentType ? target.identity?.filamentType?.trim() || null : null,
    materialSubtype: target.match?.materialSubtype ? target.identity?.materialSubtype?.trim() || null : null,
    colorName: target.match?.colorName ? target.identity?.colorName?.trim() || null : null
  }
  const spoolIds = [...new Set(target.spoolIds ?? [])]
  if (target.scope === 'identity' && (Object.keys(identity) as Array<keyof typeof identity>)
    .some((field) => target.match?.[field] && !identity[field])) {
    throw badRequest('Enter a value for every checked filament detail')
  }
  if (target.scope === 'spool' && spoolIds.length === 0) throw badRequest('Choose at least one spool')
  if (target.scope === 'identity' && Object.values(identity).every((value) => value == null)) {
    throw badRequest('Enter and select at least one filament detail')
  }
  const results = []
  for (const spoolId of target.scope === 'spool' ? spoolIds : [null]) {
    results.push(await saveResult(db, workspaceId, {
      ...input.calibration,
      printerModel: input.printerModel,
      printerTarget,
      nozzleDiameter: input.nozzleDiameter,
      scope: target.scope,
      spoolId,
      runId,
      ...identity
    }))
  }
  return results
}
