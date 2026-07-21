/**
 * User-invoked repair of a saved project's embedded `project_settings.config`.
 *
 * OWNS: rewriting a stored 3MF whose settings contradict its own machine topology into a
 * consistent one. Today that is the `flush_volumes_matrix` sizing invariant — a matrix left at
 * the source machine's extruder count by a retarget onto a dual-nozzle printer, which BambuStudio
 * reads out of bounds and dies on mid-slice (see `flush-volumes-matrix.ts` in the shared package
 * for the invariant and the failure).
 *
 * CONTRACT. Nothing here runs on its own: repairing is an explicit user action, surfaced by the
 * `needsSettingsRepair` flag on the 3MF index / library DTO and invoked from the editor banner and
 * the slice dialog. Stored files are NEVER rewritten as a side effect of opening, listing, or
 * slicing them — a silent heal-at-rest would mutate a user's project without their say-so and make
 * the next such bug undiagnosable. The route persists the result as a NEW library version, so the
 * pre-repair bytes stay restorable.
 *
 * Detection and repair share one implementation (`inspectProjectFlushVolumesMatrix` /
 * `repairFlushVolumesMatrix`) so a file can never be flagged as broken by one rule and left
 * untouched by another.
 */
import { readEntry, rewriteThreeMfEntries } from './three-mf-internal.js'
import { inspectProjectFlushVolumesMatrix, repairFlushVolumesMatrix } from '@printstream/shared'

const PROJECT_SETTINGS_ENTRY = 'Metadata/project_settings.config'

export interface ProjectSettingsRepairResult {
  /** False when the project was already consistent (or has no readable settings) — no file written. */
  repaired: boolean
  /** Entry count before and after, for the audit trail. Null when nothing was inspected. */
  matrix: { before: number; after: number; filaments: number; extruders: number } | null
}

/**
 * Repair `sourcePath` into `outputPath`.
 *
 * Returns `repaired: false` WITHOUT writing `outputPath` when there is nothing to fix, so callers
 * must check the flag before persisting. Never throws for an unreadable/settings-less project —
 * that is reported as "nothing to repair" rather than failing the user's action, since those files
 * are not affected by this defect.
 */
export async function repairProjectSettingsThreeMf(
  sourcePath: string,
  outputPath: string
): Promise<ProjectSettingsRepairResult> {
  const raw = await readEntry(sourcePath, PROJECT_SETTINGS_ENTRY).catch(() => null)
  if (!raw || raw.length === 0) return { repaired: false, matrix: null }
  const json = raw.toString('utf8')

  const inspection = inspectProjectFlushVolumesMatrix(json)
  if (!inspection || !inspection.inconsistent) return { repaired: false, matrix: null }

  let record: Record<string, unknown>
  try {
    record = JSON.parse(json) as Record<string, unknown>
  } catch (error) {
    // Contradiction: the inspection above parsed the same JSON to decide it was inconsistent, so a
    // failure here means the two disagree. Report "nothing to repair" rather than fail the user's
    // action, but make the inconsistency visible instead of losing it.
    console.warn(`[library-settings-repair] settings parsed for inspection but not for repair (${sourcePath}): ${(error as Error).message}`)
    return { repaired: false, matrix: null }
  }
  const repairedMatrix = repairFlushVolumesMatrix(
    Array.isArray(record.flush_volumes_matrix) ? record.flush_volumes_matrix : null,
    inspection.filamentCount,
    inspection.extruderCount
  )
  // The inspection said inconsistent, so a null here would mean the two disagree — bail rather
  // than write an unchanged file and report it as repaired.
  if (!repairedMatrix) {
    console.warn(
      `[library-settings-repair] inspection flagged ${sourcePath} (matrix ${inspection.actualLength}, expected ${inspection.expectedLength}) but the repair produced no change`
    )
    return { repaired: false, matrix: null }
  }
  record.flush_volumes_matrix = repairedMatrix

  const nextJson = JSON.stringify(record)
  await rewriteThreeMfEntries(sourcePath, outputPath, { [PROJECT_SETTINGS_ENTRY]: () => nextJson })
  return {
    repaired: true,
    matrix: {
      before: inspection.actualLength,
      after: repairedMatrix.length,
      filaments: inspection.filamentCount,
      extruders: inspection.extruderCount
    }
  }
}
