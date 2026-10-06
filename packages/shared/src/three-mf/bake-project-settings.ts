/**
 * Ordered project-settings authoring for the shared 3MF bake.
 * Filament identity and nozzle mapping lead; plate type, tower position, and
 * purge volumes follow; staged repairs run last so unsafe shapes cannot ship.
 */
import { canonicalCurrBedType } from '../plate-types.js'
import {
  defaultFlushMultiplierFor,
  flushMultiplierKeyForPrimeVolumeMode,
  repairFlushMultiplier,
  writeFlushVolumesMatrixBlocks
} from '../flush-volumes-matrix.js'
import type { SceneEdit, SceneEditFlushVolumes } from '../slicing.js'
import { applyFilamentList, applyNozzleAssignmentToProjectSettings } from './bake-filament-settings.js'
import { repairProjectSettingsDocument } from './bake-project-settings-finishing.js'

/**
 * The ordered `project_settings.config` rewrites a SceneEdit calls for: the filament set
 * (add/remove materials) and per-slot dual-nozzle assignment, the plate type, per-plate
 * prime-tower corners, and, last, so authoring always wins first, the staged settings repairs.
 * Empty when the edit touches none of them.
 */
export function buildProjectSettingsTransforms(
  edit: SceneEdit,
  sourcePlateMap?: ReadonlyMap<number, number> | null
): Array<(json: string) => string> {
  const transforms: Array<(json: string) => string> = []
  if (edit.filaments && edit.filaments.length > 0) {
    const filaments = edit.filaments
    transforms.push((json) => applyFilamentList(json, filaments))
    transforms.push((json) => applyNozzleAssignmentToProjectSettings(json, filaments))
  }
  // The edit's own global. The fallback is ONLY for a client from before per-plate bed types, which
  // stamped the global onto every plate: there the plates ARE the global, and reading it back out
  // of them is the only way to keep it. It must not run for a current client that simply has no
  // global to state, or the first plate's OVERRIDE gets promoted to the project-wide value.
  const plateType = edit.plateType !== undefined
    ? edit.plateType
    : edit.plates.find((plate) => plate.plateType)?.plateType
  if (plateType) {
    transforms.push((json) => applyProjectPlateType(json, plateType))
  }
  if (edit.plates.some((plate) => plate.primeTower) || sourcePlateMap != null) {
    // An identity map still carries information: plates absent from it were deleted or newly
    // added. Remapping also conforms the positional arrays to the current plate count, preventing
    // a new plate from inheriting a deleted plate's stale tower corner.
    transforms.push((json) => applyPrimeTowerSettings(json, edit, sourcePlateMap))
  }
  // AFTER the filament list (which remaps the matrix for the new material set) so the user's own
  // numbers win, and BEFORE the repair pass so a stale edit is still caught by it rather than
  // riding through as the exact shape the engine segfaults on.
  if (edit.flushVolumes) {
    const flushVolumes = edit.flushVolumes
    transforms.push((json) => applyFlushVolumes(json, flushVolumes))
  }
  if (edit.repairSettings) {
    transforms.push(repairProjectSettingsDocument)
  }
  return transforms
}

function applyProjectPlateType(projectSettingsJson: string, plateType: string): string {
  const canonical = canonicalCurrBedType(plateType)
  if (!canonical) return projectSettingsJson
  let parsed: unknown
  try {
    parsed = JSON.parse(projectSettingsJson)
  } catch {
    return projectSettingsJson
  }
  if (!parsed || typeof parsed !== 'object') return projectSettingsJson
  const record = parsed as Record<string, unknown>
  record.curr_bed_type = canonical
  return JSON.stringify(record)
}

/**
 * Write the editor's purge volumes into `flush_volumes_matrix` and the mode's multiplier key.
 *
 * The edit is checked against the topology of the document it is landing in, the filament set
 * this very bake just wrote, and DROPPED if it does not match, leaving the matrix
 * {@link applyFilamentList} already remapped. That is deliberate: a matrix authored for a
 * different material list describes purges between filaments that no longer exist, and forcing it
 * to fit would either scramble the numbers or write the out-of-bounds shape that segfaults the
 * engine mid-slice. Dropping loses an edit the user can redo; writing it loses the slice.
 *
 * The multiplier is per-EXTRUDER and independent of the filament set, so a stale one is conformed
 * rather than dropped.
 */
function applyFlushVolumes(projectSettingsJson: string, flushVolumes: SceneEditFlushVolumes): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(projectSettingsJson)
  } catch {
    return projectSettingsJson
  }
  if (!parsed || typeof parsed !== 'object') return projectSettingsJson
  const record = parsed as Record<string, unknown>
  // Same sources as `inspectProjectFlushVolumesMatrix`: filaments from `filament_colour`, extruders
  // from the NON-deduplicated `nozzle_diameter` (one entry per nozzle).
  const filamentCount = Array.isArray(record.filament_colour) ? record.filament_colour.length : 0
  const extruderCount = Array.isArray(record.nozzle_diameter) ? Math.max(record.nozzle_diameter.length, 1) : 1
  if (filamentCount <= 0) return projectSettingsJson

  const blocks = flushVolumes.matrix
  const shapeMatches = blocks !== null
    && blocks.length === extruderCount
    && blocks.every((block) => block.length === filamentCount && block.every((row) => row.length === filamentCount))
  if (blocks !== null && shapeMatches) {
    record.flush_volumes_matrix = writeFlushVolumesMatrixBlocks(blocks)
  }

  if (flushVolumes.primeVolumeMode) {
    record.prime_volume_mode = flushVolumes.primeVolumeMode
  }

  const multiplierKey = flushMultiplierKeyForPrimeVolumeMode(flushVolumes.primeVolumeMode ?? record.prime_volume_mode)
  const multiplier = flushVolumes.multiplier.map((value) => String(value))
  record[multiplierKey] = repairFlushMultiplier(multiplier, extruderCount, defaultFlushMultiplierFor(multiplierKey))
    ?? multiplier
  return JSON.stringify(record)
}

/**
 * Write each plate's edited prime-tower corner into the per-plate `wipe_tower_x`/
 * `wipe_tower_y` arrays of `project_settings.config` (string-valued, like Bambu).
 */
function remapPerPlateValues(
  values: readonly string[],
  plateMap: ReadonlyMap<number, number>,
  plateCount: number,
  fallback: string
): string[] {
  const moved = new Array<string | undefined>(plateCount)
  for (const [source, saved] of plateMap) {
    if (saved < 1 || saved > plateCount) continue
    const value = values[source - 1]
    if (value !== undefined) moved[saved - 1] = value
  }
  const out: string[] = []
  for (let index = 0; index < plateCount; index += 1) {
    out.push(moved[index] ?? out[out.length - 1] ?? fallback)
  }
  return out
}

function applyPrimeTowerSettings(
  projectSettingsJson: string,
  edit: SceneEdit,
  plateMap?: ReadonlyMap<number, number> | null
): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(projectSettingsJson)
  } catch {
    return projectSettingsJson
  }
  if (!parsed || typeof parsed !== 'object') return projectSettingsJson
  const record = parsed as Record<string, unknown>
  let xs = Array.isArray(record.wipe_tower_x) ? record.wipe_tower_x.map(String) : []
  let ys = Array.isArray(record.wipe_tower_y) ? record.wipe_tower_y.map(String) : []
  if (plateMap) {
    if (xs.length > 0) xs = remapPerPlateValues(xs, plateMap, edit.plates.length, '15')
    if (ys.length > 0) ys = remapPerPlateValues(ys, plateMap, edit.plates.length, '220')
  }
  for (const plate of edit.plates) {
    if (!plate.primeTower) continue
    const index = plate.index - 1
    while (xs.length <= index) xs.push(xs[xs.length - 1] ?? '15')
    while (ys.length <= index) ys.push(ys[ys.length - 1] ?? '220')
    xs[index] = String(plate.primeTower.x)
    ys[index] = String(plate.primeTower.y)
  }
  record.wipe_tower_x = xs
  record.wipe_tower_y = ys
  return JSON.stringify(record)
}
