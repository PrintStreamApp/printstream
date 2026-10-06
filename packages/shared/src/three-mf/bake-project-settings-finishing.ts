/**
 * Final project-settings transforms for a shared 3MF bake.
 * Repair runs after authored edits; model-kind and global process markers keep their
 * existing byte-preserving behavior when the input cannot be parsed.
 */
import { inspectProjectFilamentIds, repairFilamentIds } from '../repairs/filament-ids.js'
import { inspectProjectInheritsGroup, repairInheritsGroup } from '../repairs/inherits-group.js'
import { inspectProjectFlushVolumesMatrix, repairFlushMultiplier, repairFlushVolumesMatrix } from '../flush-volumes-matrix.js'
import { inspectProjectFilamentSelfIndex, repairFilamentSelfIndex } from '../filament-variant-index.js'
import { dropEngineHostileOverrides } from '../settings-value-guard.js'
import { PRINTSTREAM_MODEL_KIND_KEY, PRINTSTREAM_MODEL_KIND_OBJECT_EXPORT } from './index-parser.js'

/**
 * Apply the settings-level shared repairs to a `project_settings.config` document: flush sizing
 * (`flush_volumes_matrix` + `flush_multiplier`), `filament_self_index`, `filament_ids`, and
 * `inherits_group`, each defect's single
 * repair implementation from `repairs/`, so detection and repair can never disagree. Every step is
 * inspect-gated, so a healthy document rides through byte-identical. `inherits_group` runs last
 * because it reads the filament slot count the other steps do not change. The model_settings half
 * of the staged repair (object-level extruders) is applied by `buildEditedThreeMfDocuments`
 * in `bake-documents.ts`.
 */
export function repairProjectSettingsDocument(projectSettingsJson: string): string {
  let record: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(projectSettingsJson)
    if (!parsed || typeof parsed !== 'object') return projectSettingsJson
    record = parsed as Record<string, unknown>
  } catch {
    return projectSettingsJson
  }
  const flushInspection = inspectProjectFlushVolumesMatrix(projectSettingsJson)
  if (flushInspection?.matrixInconsistent) {
    const repaired = repairFlushVolumesMatrix(
      Array.isArray(record.flush_volumes_matrix) ? record.flush_volumes_matrix : null,
      flushInspection.filamentCount,
      flushInspection.extruderCount
    )
    if (repaired) record.flush_volumes_matrix = repaired
  }
  if (flushInspection?.multiplierInconsistent) {
    const repaired = repairFlushMultiplier(record.flush_multiplier, flushInspection.extruderCount)
    if (repaired) record.flush_multiplier = repaired
  }
  if (inspectProjectFilamentSelfIndex(projectSettingsJson)?.inconsistent) {
    const repaired = repairFilamentSelfIndex(record)
    if (repaired) record.filament_self_index = repaired
  }
  if (inspectProjectFilamentIds(projectSettingsJson)?.inconsistent) {
    repairFilamentIds(record)
  }
  if (inspectProjectInheritsGroup(JSON.stringify(record))?.inconsistent) {
    const repaired = repairInheritsGroup(record)
    if (repaired) record.inherits_group = repaired
  }
  return JSON.stringify(record)
}

/**
 * Stamp `project_settings.config` as a single-object model export. Reader counterpart:
 * the shared index parser's `PRINTSTREAM_MODEL_KIND_KEY` extraction.
 */
export function applyModelKindMarker(projectSettingsJson: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(projectSettingsJson)
  } catch {
    return projectSettingsJson
  }
  if (!parsed || typeof parsed !== 'object') return projectSettingsJson
  const record = parsed as Record<string, unknown>
  record[PRINTSTREAM_MODEL_KIND_KEY] = PRINTSTREAM_MODEL_KIND_OBJECT_EXPORT
  return JSON.stringify(record)
}

/**
 * Merge global process overrides into `project_settings.config` using BambuStudio's
 * serialized string or string-array values. Unparseable JSON is left unchanged.
 */
export function applyGlobalProcessOverrides(projectSettingsJson: string, overrides: Record<string, string | string[]>): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(projectSettingsJson)
  } catch {
    return projectSettingsJson
  }
  if (!parsed || typeof parsed !== 'object') return projectSettingsJson
  const record = parsed as Record<string, unknown>
  // A cleared numeric field arrives as "", which BambuStudio's scalar deserialisers fail on, and the
  // resulting throw abandons every key it had not yet applied (`settings-value-guard.ts` has the
  // full trace). Dropping loses nothing: an empty value says only that the box is empty, and
  // omitting the override leaves the setting at whatever it already was.
  for (const [key, value] of Object.entries(dropEngineHostileOverrides(overrides))) record[key] = value
  return JSON.stringify(record)
}
