/**
 * Place edited instances on BambuStudio's global plate grid and write root build items.
 * The reader removes the same grid offsets when it exposes plate-local editor positions.
 * Reject sparse plate ids and degenerate transforms before writing an archive.
 */
import type { SceneEdit } from '../slicing.js'
import { extractPlateType } from './index-parser.js'
import { extractSceneBed, LOGICAL_PART_PLATE_GAP } from './scene-parser.js'
import { groupArrangedByObject, type ArrangedInstance } from './bake-arranged-model-settings.js'
import { degenerateTransformMessage, findDegenerateTransformColumn } from './transform-validity.js'
import { formatThreeMfTransformValue, productionUuidAttr } from './bake-xml-format.js'

/**
 * Compose a 12-element 3MF transform (column-major 3x3 followed by translation) from a decomposed
 * translation/rotation/scale, matching three.js' `Matrix4 = T · R(euler 'XYZ') · S`. This is the
 * exact inverse of how the editor decomposes {@link ThreeMfSceneInstance.transform} into its gizmo
 * state, so an unedited round-trip reproduces the source placement.
 */
export function threeMfTransformFromTRS(
  position: { x: number; y: number; z: number },
  rotation: { x: number; y: number; z: number },
  scale: { x: number; y: number; z: number }
): number[] {
  const a = Math.cos(rotation.x)
  const b = Math.sin(rotation.x)
  const c = Math.cos(rotation.y)
  const d = Math.sin(rotation.y)
  const e = Math.cos(rotation.z)
  const f = Math.sin(rotation.z)
  const ae = a * e
  const af = a * f
  const be = b * e
  const bf = b * f

  // Rotation columns (column-major), per three.js makeRotationFromEuler order 'XYZ'.
  const r00 = c * e
  const r10 = af + be * d
  const r20 = bf - ae * d
  const r01 = -c * f
  const r11 = ae - bf * d
  const r21 = be + af * d
  const r02 = d
  const r12 = -b * c
  const r22 = a * c

  return [
    r00 * scale.x, r10 * scale.x, r20 * scale.x,
    r01 * scale.y, r11 * scale.y, r21 * scale.y,
    r02 * scale.z, r12 * scale.z, r22 * scale.z,
    position.x, position.y, position.z
  ].map((value) => (value === 0 ? 0 : value))
}

/**
 * Reproduce BambuStudio's plate-grid layout so the writer maps each plate's plate-local
 * placements back to the exact global build coordinates BambuStudio expects for that plate.
 *
 * BambuStudio (`PartPlateList::compute_shape_position`/`compute_colum_count`, PartPlate.cpp) lays
 * plates out row-major in a square-ish grid: the column count is `round(sqrt(n))` (rounded up when
 * the root isn't clean), and the plate at 0-based position `i` sits at column `i % cols`, row
 * `i / cols`, each cell offset by a per-axis stride of `bed * (1 + 1/5)` (rows grow toward −Y).
 * Slicing a plate checks its objects fall inside that plate's grid cell, so an origin that does not
 * match the grid pushes later plates outside the print volume (slicer exit 206): the previous
 * single-row layout did exactly that for the 3rd+ plate. The scene reader removes this same offset
 * (see {@link resolveProjectPlateOrigin}) to give the editor plate-local coordinates.
 */
function computePlateOrigins(
  plates: SceneEdit['plates'],
  plateWidth: number,
  plateDepth: number
): Map<number, { x: number; y: number }> {
  // BambuStudio indexes `plate_data_list` by `plater_id - 1` and refuses the whole project when any
  // id exceeds the plate COUNT (`bbs_3mf.cpp:2323-2329`, and the same guard again at `:1633-1639`
  // for a printer-stored `.gcode.3mf`). Sorting alone does not make `[1, 3]` safe. Refused rather
  // than renumbered: the editor already reindexes every plate mutation to 1..N, so a sparse set is a
  // caller that disagrees with us about which plate is which, and silently moving its plate 3 to
  // position 2 would attach that plate's thumbnails and gcode pointers to different work.
  assertDensePlateIndexes(plates)
  const ordered = [...plates].sort((left, right) => left.index - right.index)
  const cols = computePlateColumnCount(ordered.length)
  const strideX = plateWidth * (1 + LOGICAL_PART_PLATE_GAP)
  const strideY = plateDepth * (1 + LOGICAL_PART_PLATE_GAP)
  const origins = new Map<number, { x: number; y: number }>()
  ordered.forEach((plate, position) => {
    const col = position % cols
    const row = Math.floor(position / cols)
    origins.set(plate.index, { x: col * strideX, y: -row * strideY })
  })
  return origins
}

/**
 * BambuStudio's `compute_colum_count`: arrange plates in a square-ish grid, rounding the column
 * count up when the plate count isn't a perfect square (e.g. 1→1, 2→2, 4→2, 5→3, 9→3, 36→6).
 */
function computePlateColumnCount(count: number): number {
  if (count <= 1) return 1
  const value = Math.sqrt(count)
  const rounded = Math.round(value)
  return value > rounded ? rounded + 1 : rounded
}

/** A scene-edit instance whose geometry reference has been resolved to a concrete object id. */
interface ResolvedEditInstance {
  objectId: number
  plateIndex: number
  position: { x: number; y: number; z: number }
  rotation: { x: number; y: number; z: number }
  scale: { x: number; y: number; z: number }
  /** Full local transform (12 numbers); used verbatim when present. */
  matrix?: number[]
  /** BambuStudio "Printable" flag; false → written as `printable="0"` on the build item. */
  printable?: boolean
}

function assignArrangedInstances(instances: ResolvedEditInstance[], origins: Map<number, { x: number; y: number }>): ArrangedInstance[] {
  const instanceCounters = new Map<number, number>()
  const arranged: ArrangedInstance[] = []
  for (const instance of instances) {
    const instanceId = instanceCounters.get(instance.objectId) ?? 0
    instanceCounters.set(instance.objectId, instanceId + 1)
    const origin = origins.get(instance.plateIndex) ?? { x: 0, y: 0 }
    // A full matrix (world-space scale can shear) takes precedence over T*R*S.
    const local = instance.matrix && instance.matrix.length === 12
      ? [...instance.matrix]
      : threeMfTransformFromTRS(instance.position, instance.rotation, instance.scale)
    // Held to the same rule whichever form it arrived in. A zero scale axis makes the importer
    // return before `set_transformation` (`bbs_3mf.cpp:4299-4307`), so the object loses its position
    // and rotation too and reappears unrotated at the plate origin, with no error anywhere.
    const degenerate = findDegenerateTransformColumn(local)
    if (degenerate) {
      throw new Error(`Scene edit places object ${instance.objectId} with a degenerate transform: ${degenerateTransformMessage(degenerate).toLowerCase()}`)
    }
    local[9] = (local[9] ?? 0) + origin.x
    local[10] = (local[10] ?? 0) + origin.y
    arranged.push({ objectId: instance.objectId, instanceId, plateIndex: instance.plateIndex, transform: local, printable: instance.printable })
  }
  return arranged
}

export function renderArrangedBuildItems(arranged: ArrangedInstance[], genUuid: (() => string) | null): string {
  const lines: string[] = []
  for (const instance of groupArrangedByObject(arranged)) {
    const transform = instance.transform.map(formatThreeMfTransformValue).join(' ')
    // BambuStudio's per-object "Printable" toggle: a skipped instance is kept in the 3MF
    // (re-enableable) but marked printable="0", which greys it and excludes it from the slice.
    const printable = instance.printable === false ? '0' : '1'
    lines.push(`    <item objectid="${instance.objectId}"${productionUuidAttr(genUuid)} transform="${transform}" printable="${printable}"/>`)
  }
  return lines.join('\n')
}

export function replaceThreeMfBuildSection(modelXml: string, buildItemsXml: string): string {
  const body = buildItemsXml ? `\n${buildItemsXml}\n  ` : ''
  if (/<build\b[^>]*>[\s\S]*?<\/build>/.test(modelXml)) {
    return modelXml.replace(/<build\b([^>]*)>[\s\S]*?<\/build>/, (_full, attrs: string) => `<build${attrs}>${body}</build>`)
  }
  // No build section (rare): insert one before the closing model tag.
  return modelXml.replace(/<\/model>\s*$/, `  <build>${body}</build>\n</model>\n`)
}

/** Plate ids must be exactly 1..N, or BambuStudio refuses the project outright. */
function assertDensePlateIndexes(plates: ReadonlyArray<{ index: number }>): void {
  const seen = [...plates].map((plate) => plate.index).sort((left, right) => left - right)
  const dense = seen.every((index, position) => index === position + 1)
  if (!dense) {
    throw new Error(`Scene edit numbers its plates ${seen.join(', ')}; plates must be numbered 1 to ${seen.length} with no gaps`)
  }
}

/**
 * Resolve imported instance ids, then place all instances on the edited bed.
 * A printer change uses the target bed stride; older edits without a target
 * bed retain the source dimensions and their existing placement.
 */
export function arrangeEditedInstances(
  edit: SceneEdit,
  importIdToObjectId: ReadonlyMap<string, number>,
  projectSettingsJson: string | null
): ArrangedInstance[] {
  const resolved: ResolvedEditInstance[] = edit.instances.map((instance) => {
    const objectId = instance.objectId ?? (instance.importId != null ? importIdToObjectId.get(instance.importId) : undefined)
    if (objectId == null) {
      throw new Error('Scene edit references an unknown imported model')
    }
    return {
      objectId,
      plateIndex: instance.plateIndex,
      position: instance.position,
      rotation: instance.rotation,
      scale: instance.scale,
      matrix: instance.matrix,
      printable: instance.printable
    }
  })

  const plateType = extractPlateType(projectSettingsJson)
  const sourceBed = extractSceneBed(projectSettingsJson, plateType)
  // A printer change translates the live editor state into the TARGET bed's plate-local frame.
  // Build the global plate grid with that same stride. Falling back to the source dimensions keeps
  // edits from older clients byte-compatible and remains the right answer without a printer change.
  const width = edit.placementBedSize?.width ?? sourceBed.width
  const depth = edit.placementBedSize?.depth ?? sourceBed.depth
  const origins = computePlateOrigins(edit.plates, width, depth)
  const arranged = assignArrangedInstances(resolved, origins)

  return arranged
}
