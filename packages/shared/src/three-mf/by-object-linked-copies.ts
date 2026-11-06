/**
 * Predicts how a Bambu Studio engine mishandles LINKED copies (several instances of one object)
 * on a plate printed "by object", so the editor and the slice pipeline can warn before a print
 * comes out wrong. This module owns the engine rule and the list of engine versions it is known
 * to hold for; every surface that warns asks it, so the editor and the server cannot disagree.
 *
 * What the engine does (Bambu Studio 2.8.2.61 source, reproduced by slicing on that build):
 *
 * - `print_objects_from_model_object` (`PrintApply.cpp`) merges a model object's printable
 *   instances whose transforms are identical once the XY translation is zeroed into ONE
 *   `PrintObject`. A copy that only differs in position is the same print object; a copy at a
 *   different rotation, scale, mirror or height is a separate one.
 * - `Print::is_sequential_print()` is `print_sequence == ByObject && m_objects.size() > 1`. With
 *   exactly one print object the by-object path is skipped and every copy prints together, layer
 *   by layer, while the G-code header still says "by object" (defect `printsTogether`).
 * - The sequential export loop in `GCode::_do_export` skips an instance whose print object equals
 *   the previous instance's (`if(object == prev_object) continue;`) and prints one instance per
 *   pass, so on a plate with more than one print object, every consecutive copy after the first
 *   is left out of the G-code entirely (defect `copiesDropped`).
 *
 * Instance order is the model's: objects in turn, each object's instances in order. Different
 * objects are always different print objects, so only the order WITHIN one object matters.
 *
 * Versions are listed explicitly rather than as an open range. Each entry was checked against
 * that tag's source (`git show <tag>:src/libslic3r/GCode.cpp`, `PrintApply.cpp`, `Print.hpp`);
 * 2.8.2.61 was also confirmed by slicing. An engine missing from the list (a newer Bambu Studio,
 * OrcaSlicer, a legacy target with no version) gets no warning until someone verifies it, because
 * claiming a defect we have not seen is its own kind of wrong. `apps/slicer`'s engine-assets test
 * fails when a shipped Bambu Studio build is not classified here, so vendoring one forces the check.
 */
import { threeMfTransformFromTRS } from './bake-placement.js'
import { formatThreeMfTransformValue } from './bake-xml-format.js'
import { parseModelSettingsPlates } from './index-parser.js'
import { parseModelSettingsScene, parseRootBuildItemPrintable, parseRootBuildItemTransforms } from './scene-parser.js'

/** The two ways an affected engine mishandles linked copies printed by object. */
export type ByObjectLinkedCopyDefect = 'printsTogether' | 'copiesDropped'

/**
 * Bambu Studio versions verified to have each defect. `printsTogether` arrived with the
 * `objects().size() > 1` gate in 2.4.0.70 (absent in 2.3.0.70); `copiesDropped` with the
 * `prev_object` skip in 2.6.0.51 (absent in 2.5.0.66). Both are still present on upstream master
 * as of 2026-11-06.
 */
export const BY_OBJECT_LINKED_COPY_DEFECT_VERSIONS: Readonly<Record<ByObjectLinkedCopyDefect, readonly string[]>> = {
  printsTogether: [
    '2.4.0.70', '2.5.0.66',
    '2.6.0.51', '2.6.1.55', '2.7.0.55', '2.7.1.57', '2.7.1.62', '2.8.0.50', '2.8.1.55', '2.8.2.60', '2.8.2.61', '2.8.4.57'
  ],
  copiesDropped: [
    '2.6.0.51', '2.6.1.55', '2.7.0.55', '2.7.1.57', '2.7.1.62', '2.8.0.50', '2.8.1.55', '2.8.2.60', '2.8.2.61', '2.8.4.57'
  ]
}

/**
 * Bambu Studio versions verified NOT to have either defect. Empty today; a build that fixes them
 * belongs here once checked, so the engine-assets classification test stays satisfied.
 */
export const BY_OBJECT_LINKED_COPY_UNAFFECTED_VERSIONS: readonly string[] = []

/** The engine a plate will be sliced with, as a slicer target descriptor names it. */
export interface ByObjectLinkedCopyEngine {
  family: string
  version: string
}

/** One placed instance, in model order. */
export interface ByObjectLinkedCopyPlacement {
  /**
   * The object the instance is a copy of. Two placements with the same key are linked copies; the
   * caller supplies whatever identity becomes ONE object in the engine's input.
   */
  objectKey: string
  /** 12-element 3MF transform (column-major 3x3, then translation), plate-local or global. */
  transform: readonly number[]
  /** False for an instance switched to non-printable, which the engine never sees. */
  printable: boolean
}

/** A linked-copy problem on one object. Indexes refer to the caller's placement array. */
export interface ByObjectLinkedCopyIssue {
  defect: ByObjectLinkedCopyDefect
  objectKey: string
  /** Every printable placement of the object that shares the affected print object. */
  placementIndexes: number[]
  /** For `copiesDropped`: the placements missing from the G-code. Empty for `printsTogether`. */
  droppedPlacementIndexes: number[]
}

/** Whether a verified engine version has the given defect. Unknown engines never do. */
export function engineHasByObjectLinkedCopyDefect(
  engine: ByObjectLinkedCopyEngine | null | undefined,
  defect: ByObjectLinkedCopyDefect
): boolean {
  if (!engine || engine.family !== 'bambustudio') return false
  return BY_OBJECT_LINKED_COPY_DEFECT_VERSIONS[defect].includes(engine.version.trim())
}

/**
 * Predict the linked-copy problems for one plate.
 *
 * `printSequence` is the plate's EFFECTIVE sequence (its own override, else the project's), null
 * when unknown, which reports nothing. Returns an empty list when the plate prints correctly, the
 * engine is unaffected or unverified, or the sequence is not "by object".
 */
export function assessByObjectLinkedCopies(input: {
  engine: ByObjectLinkedCopyEngine | null | undefined
  printSequence: string | null | undefined
  placements: readonly ByObjectLinkedCopyPlacement[]
}): ByObjectLinkedCopyIssue[] {
  if (input.printSequence !== 'by object') return []

  const groups = groupIntoPrintObjects(input.placements)

  if (groups.length === 1) {
    const only = groups[0]!
    if (only.indexes.length < 2) return []
    if (!engineHasByObjectLinkedCopyDefect(input.engine, 'printsTogether')) return []
    return [{ defect: 'printsTogether', objectKey: only.objectKey, placementIndexes: only.indexes, droppedPlacementIndexes: [] }]
  }

  if (!engineHasByObjectLinkedCopyDefect(input.engine, 'copiesDropped')) return []
  return findDroppedCopies(input.placements, groups)
}

/** A print object as the engine forms it: one model object at one transform, ignoring XY. */
interface PrintObjectGroup {
  objectKey: string
  signature: string
  indexes: number[]
}

/**
 * Group printable placements the way `print_objects_from_model_object` does.
 *
 * The comparison is on the transform AS THE 3MF WRITES IT (six decimals), because the engine
 * compares the doubles it parses from those strings; comparing the editor's unrounded values would
 * call two copies different that the engine merges.
 */
function groupIntoPrintObjects(placements: readonly ByObjectLinkedCopyPlacement[]): PrintObjectGroup[] {
  const groups = new Map<string, PrintObjectGroup>()

  placements.forEach((placement, index) => {
    if (!placement.printable) return

    const signature = transformSignatureIgnoringXy(placement.transform)
    const key = `${placement.objectKey}\u0000${signature}`
    const existing = groups.get(key)

    if (existing) {
      existing.indexes.push(index)
    } else {
      groups.set(key, { objectKey: placement.objectKey, signature, indexes: [index] })
    }
  })

  return [...groups.values()]
}

/**
 * Mirror the export loop's `prev_object` skip: walking each object's printable instances in
 * order, an instance that lands on the same print object as the one before it is not printed.
 */
function findDroppedCopies(
  placements: readonly ByObjectLinkedCopyPlacement[],
  groups: readonly PrintObjectGroup[]
): ByObjectLinkedCopyIssue[] {
  const groupOf = new Map<number, PrintObjectGroup>()
  for (const group of groups) {
    for (const index of group.indexes) groupOf.set(index, group)
  }

  const dropped = new Map<PrintObjectGroup, number[]>()
  let previous: PrintObjectGroup | null = null

  for (const index of modelOrder(placements)) {
    const group = groupOf.get(index)
    if (!group) continue

    if (group === previous) {
      const list = dropped.get(group) ?? []
      list.push(index)
      dropped.set(group, list)
    }

    previous = group
  }

  return [...dropped.entries()].map(([group, droppedIndexes]) => ({
    defect: 'copiesDropped' as const,
    objectKey: group.objectKey,
    placementIndexes: group.indexes,
    droppedPlacementIndexes: droppedIndexes
  }))
}

/**
 * Placement indexes in the engine's instance order: objects in order of first appearance, each
 * object's instances in the order given. The bake writes build items grouped this way.
 */
function modelOrder(placements: readonly ByObjectLinkedCopyPlacement[]): number[] {
  const byObject = new Map<string, number[]>()

  placements.forEach((placement, index) => {
    const list = byObject.get(placement.objectKey) ?? []
    list.push(index)
    byObject.set(placement.objectKey, list)
  })

  return [...byObject.values()].flat()
}

/** The transform's linear part and Z, formatted as the 3MF writes them. XY is what copies vary. */
function transformSignatureIgnoringXy(transform: readonly number[]): string {
  const kept = [0, 1, 2, 3, 4, 5, 6, 7, 8, 11].map((index) => formatThreeMfTransformValue(transform[index] ?? 0))
  return kept.join(' ')
}

/**
 * The 3MF transform a decomposed placement bakes to, for callers holding editor-style
 * position/rotation/scale. A full `matrix`, when present, is used verbatim exactly as the bake does.
 */
export function byObjectPlacementTransform(placement: {
  position: { x: number; y: number; z: number }
  rotation: { x: number; y: number; z: number }
  scale: { x: number; y: number; z: number }
  matrix?: readonly number[] | null
}): number[] {
  if (placement.matrix && placement.matrix.length === 12) return [...placement.matrix]
  return threeMfTransformFromTRS(placement.position, placement.rotation, placement.scale)
}

/**
 * The issue as a short phrase for a compact list that already names the object (the editor's
 * viewport issue sheet). {@link describeByObjectLinkedCopyIssue} is the full sentence.
 */
export function summarizeByObjectLinkedCopyIssue(issue: ByObjectLinkedCopyIssue): string {
  if (issue.defect === 'printsTogether') {
    return 'linked copies will not print by object'
  }

  const missing = issue.droppedPlacementIndexes.length
  return missing === 1 ? '1 linked copy will not print' : `${missing} linked copies will not print`
}

/**
 * User-facing description of an issue, shared by the editor and the slice result so the wording
 * cannot drift. `name` is the object's display name.
 */
export function describeByObjectLinkedCopyIssue(issue: ByObjectLinkedCopyIssue, name: string): string {
  if (issue.defect === 'printsTogether') {
    return `${name}: its ${issue.placementIndexes.length} linked copies will print together layer by layer, not one at a time. Make the copies independent to print them by object.`
  }

  const missing = issue.droppedPlacementIndexes.length
  const copies = missing === 1 ? '1 linked copy' : `${missing} linked copies`
  return `${name}: ${copies} will be left out of the print. Make the copies independent so every copy prints.`
}

/** One object's linked-copy problem found in a project archive. */
export interface ThreeMfByObjectLinkedCopyWarning {
  plateIndex: number
  objectId: number
  issue: ByObjectLinkedCopyIssue
  /** {@link describeByObjectLinkedCopyIssue} with the object's display name. */
  message: string
}

/**
 * Assess a project archive exactly as the engine will read it: plates and instances from
 * `model_settings.config`, transforms and printability from the root build items, and each plate's
 * effective sequence (its own `print_sequence`, else the project's).
 *
 * For a check run on the engine's real input; the editor asks
 * {@link assessByObjectLinkedCopies} directly with its live state. `plates` limits the check to
 * the plates being sliced (all plates when omitted). Never throws on a malformed archive: it
 * reports what it can read, and nothing for what it cannot.
 */
export function assessThreeMfByObjectLinkedCopies(input: {
  modelXml: string
  modelSettingsXml: string
  projectSettingsJson: string | null
  engine: ByObjectLinkedCopyEngine | null | undefined
  plates?: readonly number[]
}): ThreeMfByObjectLinkedCopyWarning[] {
  const engineAffected = engineHasByObjectLinkedCopyDefect(input.engine, 'printsTogether')
    || engineHasByObjectLinkedCopyDefect(input.engine, 'copiesDropped')
  if (!engineAffected) return []

  const transforms = parseRootBuildItemTransforms(input.modelXml)
  const printable = parseRootBuildItemPrintable(input.modelXml)
  const scene = parseModelSettingsScene(input.modelSettingsXml)
  const sequences = effectiveThreeMfPrintSequences(input.modelSettingsXml, input.projectSettingsJson)

  const warnings: ThreeMfByObjectLinkedCopyWarning[] = []

  for (const plate of scene.plates) {
    if (input.plates && !input.plates.includes(plate.index)) continue

    const placements = plate.instances.flatMap((instance) => {
      const transform = transforms.get(instance.objectId)?.[instance.instanceId]
      if (!transform) return []
      return [{
        objectId: instance.objectId,
        placement: {
          objectKey: String(instance.objectId),
          transform,
          printable: printable.get(instance.objectId)?.[instance.instanceId] ?? true
        }
      }]
    })

    const issues = assessByObjectLinkedCopies({
      engine: input.engine,
      printSequence: sequences.plates.get(plate.index) ?? sequences.project,
      placements: placements.map((entry) => entry.placement)
    })

    for (const issue of issues) {
      const objectId = Number(issue.objectKey)
      const name = scene.objectNamesById.get(objectId) ?? `Object ${objectId}`
      warnings.push({ plateIndex: plate.index, objectId, issue, message: describeByObjectLinkedCopyIssue(issue, name) })
    }
  }

  return warnings
}

/**
 * Each plate's own `print_sequence` (absent when it inherits) and the project's, as the engine
 * resolves them: a plate's value wins over the project's. Exposed so a caller can skip reading the
 * (possibly large) root model when no plate it slices prints by object.
 */
export function effectiveThreeMfPrintSequences(modelSettingsXml: string, projectSettingsJson: string | null): {
  plates: Map<number, 'by layer' | 'by object'>
  project: string | null
} {
  const plates = new Map<number, 'by layer' | 'by object'>()
  for (const plate of parseModelSettingsPlates(modelSettingsXml)) {
    if (plate.printSequence) plates.set(plate.index, plate.printSequence)
  }
  return { plates, project: readProjectPrintSequence(projectSettingsJson) }
}

/** The project-wide `print_sequence`, null when the settings are absent or unreadable. */
function readProjectPrintSequence(projectSettingsJson: string | null): string | null {
  if (!projectSettingsJson) return null

  try {
    const value = (JSON.parse(projectSettingsJson) as Record<string, unknown>).print_sequence
    const raw = Array.isArray(value) ? value[0] : value
    return typeof raw === 'string' && raw.trim() ? raw.trim() : null
  } catch {
    return null
  }
}
