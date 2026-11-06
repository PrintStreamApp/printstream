/**
 * Predicts problems in a slice's output from the EXACT project the engine is about to receive, so
 * the slice result can warn before anyone prints it. Owns the archive I/O; the rules live in
 * `@printstream/shared/three-mf` (today `by-object-linked-copies.ts`), which the editor also uses
 * to warn before slicing. The counterpart that shows these is the web's slice result
 * (`SlicingJob.metadata.warnings`).
 *
 * Runs on the final engine input rather than the library file because, on the legacy path, the
 * loaded process preset and plate settings are authored into the project after the request
 * arrives, so only the final bytes say what sequence the engine will use.
 *
 * Best-effort by contract: a prediction that cannot be made logs and returns nothing. It must never
 * fail or delay a slice that would otherwise run.
 */
import {
  assessThreeMfByObjectLinkedCopies,
  effectiveThreeMfPrintSequences,
  engineHasByObjectLinkedCopyDefect,
  parseModelSettingsPlates,
  type ByObjectLinkedCopyEngine
} from '@printstream/shared/three-mf'
import { readEntry } from './three-mf.js'
import { THREE_MF_MODEL_ENTRY_MAX_BYTES } from './three-mf-reader.js'

/**
 * The warnings for slicing `plate` (0 = every plate) of the archive at `sourcePath` on `engine`.
 * Returns an empty list when nothing is predicted, the engine is not a verified-affected build, or
 * the archive cannot be read (the reason is logged at `warn`).
 */
export async function predictSliceInputWarnings(input: {
  sourcePath: string
  plate: number
  engine: ByObjectLinkedCopyEngine | null
  signal?: AbortSignal
}): Promise<string[]> {
  // No I/O at all for an engine with no verified defect (another slicer, or an unverified build).
  const engineAffected = engineHasByObjectLinkedCopyDefect(input.engine, 'printsTogether')
    || engineHasByObjectLinkedCopyDefect(input.engine, 'copiesDropped')
  if (!engineAffected) return []

  try {
    const [modelSettingsXml, projectSettingsJson] = await Promise.all([
      // Absent from a plain mesh project, which has no copies for the engine to mishandle.
      readEntry(input.sourcePath, 'Metadata/model_settings.config', input.signal)
        .then((buffer) => buffer.toString('utf8'))
        .catch(() => null),
      readEntry(input.sourcePath, 'Metadata/project_settings.config', input.signal)
        .then((buffer) => buffer.toString('utf8'))
        .catch(() => null)
    ])
    if (modelSettingsXml == null) return []

    // The root model can be hundreds of megabytes, so it is read only when a sliced plate prints
    // by object, which is the only case any current rule reports on.
    if (!slicesAnyPlateByObject(modelSettingsXml, projectSettingsJson, input.plate)) return []
    const modelXml = (await readEntry(input.sourcePath, '3D/3dmodel.model', input.signal, THREE_MF_MODEL_ENTRY_MAX_BYTES)).toString('utf8')

    const warnings = assessThreeMfByObjectLinkedCopies({
      modelXml,
      modelSettingsXml,
      projectSettingsJson,
      engine: input.engine,
      ...(input.plate > 0 ? { plates: [input.plate] } : {})
    })

    return warnings.map((warning) => warning.message)
  } catch (error) {
    console.warn(`[slicing] Could not check the slice input for linked-copy problems: ${error instanceof Error ? error.message : String(error)}`)
    return []
  }
}

/** Whether any plate in scope (0 = all) prints by object under the engine's resolution order. */
function slicesAnyPlateByObject(modelSettingsXml: string, projectSettingsJson: string | null, plate: number): boolean {
  const sequences = effectiveThreeMfPrintSequences(modelSettingsXml, projectSettingsJson)
  const plateIndexes = plate > 0 ? [plate] : parseModelSettingsPlates(modelSettingsXml).map((entry) => entry.index)
  return plateIndexes.some((index) => (sequences.plates.get(index) ?? sequences.project) === 'by object')
}
