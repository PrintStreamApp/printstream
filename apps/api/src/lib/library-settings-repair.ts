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
import {
  inspectProjectFilamentIds,
  inspectProjectFilamentSelfIndex,
  inspectProjectFlushVolumesMatrix,
  repairFilamentIds,
  repairFilamentSelfIndex,
  repairFlushVolumesMatrix
} from '@printstream/shared'

const PROJECT_SETTINGS_ENTRY = 'Metadata/project_settings.config'

export interface ProjectSettingsRepairResult {
  /** False when the project was already consistent (or has no readable settings) — no file written. */
  repaired: boolean
  /** Entry count before and after, for the audit trail. Null when nothing was inspected. */
  matrix: { before: number; after: number; filaments: number; extruders: number } | null
  /** Variant-index entry count before and after. Null when that invariant was already satisfied. */
  variantIndex: { before: number; after: number; variantRows: number } | null
  /**
   * Slots whose `filament_ids` entry named a different material from their preset. `corrected`
   * lists what changed; `unresolved` lists contradictory slots whose preset the catalogue could not
   * match, which are deliberately LEFT ALONE — callers surface them so the user knows the repair
   * was partial rather than assuming the project is now clean.
   */
  filamentIds: {
    corrected: Array<{ slot: number; from: string; to: string }>
    unresolved: Array<{ slot: number; id: string; presetName: string }>
  } | null
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
  if (!raw || raw.length === 0) return { repaired: false, matrix: null, variantIndex: null, filamentIds: null }
  const json = raw.toString('utf8')

  // NO early return on the flush matrix alone. It used to gate the whole function, which silently
  // made this a no-op for a project whose ONLY defect is the variant index — the banner offered a
  // repair that reported "nothing to do". Each invariant is decided on its own below.
  let record: Record<string, unknown>
  try {
    record = JSON.parse(json) as Record<string, unknown>
  } catch (error) {
    // Unparseable settings are "nothing to repair", not a failed user action — but say so rather
    // than lose it, since the caller only got here because something flagged this file.
    console.warn(`[library-settings-repair] settings parsed for inspection but not for repair (${sourcePath}): ${(error as Error).message}`)
    return { repaired: false, matrix: null, variantIndex: null, filamentIds: null }
  }
  // Two independent invariants share this one user action, so repair whichever actually apply and
  // write the file ONCE. Either alone is enough to make the project unusable — a bad matrix kills
  // the slice, a bad variant index stops Bambu Studio opening it at all.
  const matrixInspection = inspectProjectFlushVolumesMatrix(json)
  const repairedMatrix = matrixInspection?.inconsistent
    ? repairFlushVolumesMatrix(
      Array.isArray(record.flush_volumes_matrix) ? record.flush_volumes_matrix : null,
      matrixInspection.filamentCount,
      matrixInspection.extruderCount
    )
    : null
  if (repairedMatrix) record.flush_volumes_matrix = repairedMatrix

  const indexInspection = inspectProjectFilamentSelfIndex(json)
  const repairedIndex = indexInspection?.inconsistent ? repairFilamentSelfIndex(record) : null
  if (repairedIndex) record.filament_self_index = repairedIndex

  // A slot naming one material while its id claims another: BambuStudio binds on the ID, so it
  // fabricates a defaults-only project preset for the slot instead of opening it. Only slots whose
  // preset resolves to a catalogue id EXACTLY are corrected (see `repairs/filament-ids.ts`).
  const idInspection = inspectProjectFilamentIds(json)
  const correctedIds = idInspection?.inconsistent ? repairFilamentIds(record) : []

  // The caller only got here because something was flagged, so producing NO change means the
  // detection and the repair disagree. Say so rather than write an unchanged file and call it
  // repaired — that is how a defect becomes undiagnosable.
  if (!repairedMatrix && !repairedIndex && correctedIds.length === 0) {
    console.warn(
      `[library-settings-repair] inspection flagged ${sourcePath} but neither repair produced a change ` +
      `(matrix ${matrixInspection?.actualLength ?? 'n/a'}/${matrixInspection?.expectedLength ?? 'n/a'}, ` +
      `variant index ${indexInspection?.actualLength ?? 'n/a'}/${indexInspection?.variantRows ?? 'n/a'}, ` +
      `filament ids ${idInspection?.repairable.length ?? 0} repairable / ${idInspection?.unresolved.length ?? 0} unresolved)`
    )
    return { repaired: false, matrix: null, variantIndex: null, filamentIds: null }
  }

  const nextJson = JSON.stringify(record)
  await rewriteThreeMfEntries(sourcePath, outputPath, { [PROJECT_SETTINGS_ENTRY]: () => nextJson })
  return {
    repaired: true,
    matrix: repairedMatrix && matrixInspection
      ? {
        before: matrixInspection.actualLength,
        after: repairedMatrix.length,
        filaments: matrixInspection.filamentCount,
        extruders: matrixInspection.extruderCount
      }
      : null,
    variantIndex: repairedIndex && indexInspection
      ? { before: indexInspection.actualLength, after: repairedIndex.length, variantRows: indexInspection.variantRows }
      : null,
    filamentIds: correctedIds.length > 0 || (idInspection?.unresolved.length ?? 0) > 0
      ? {
        corrected: correctedIds.map((slot) => ({ slot: slot.index + 1, from: slot.currentId, to: slot.expectedId ?? '' })),
        unresolved: (idInspection?.unresolved ?? []).map((slot) => ({ slot: slot.index + 1, id: slot.currentId, presetName: slot.presetName }))
      }
      : null
  }
}
