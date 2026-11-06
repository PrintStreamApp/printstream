/**
 * Adapts one editor plate to the shared by-object linked-copy prediction
 * (`@printstream/shared/three-mf` `by-object-linked-copies.ts`), which owns the engine rule and the
 * affected versions. This module only decides what an editor instance IS to that rule: its linked
 * identity (`instanceLinkageKey`, the same identity the bake turns into one 3MF object) and the
 * transform the bake will write for it.
 */
import {
  assessByObjectLinkedCopies,
  byObjectPlacementTransform,
  describeByObjectLinkedCopyIssue,
  summarizeByObjectLinkedCopyIssue,
  type ByObjectLinkedCopyDefect,
  type ByObjectLinkedCopyEngine
} from '@printstream/shared/three-mf'
import type { SliceSettingsController } from '../../../components/library/SliceSettingsPanel'
import { instanceLinkageKey, type EditorPlate } from './editorModel'

/** One object's linked-copy problem, phrased and keyed for the editor. */
export interface EditorByObjectLinkedCopyIssue {
  defect: ByObjectLinkedCopyDefect
  /** The first affected copy: what a click selects, and the copy the fix leaves linked. */
  key: string
  name: string
  /** Every affected copy, first one included, in plate order. */
  instanceKeys: string[]
  /** Short phrase for the viewport issue sheet, which names the object itself. */
  summary: string
  /** Full sentence for a dialog. */
  message: string
}

/**
 * Predict the linked-copy problems on `plate`, or an empty list when it will print as arranged.
 *
 * `printSequence` must be the plate's EFFECTIVE sequence (its override, else the project's); null
 * means not yet known and reports nothing rather than guessing.
 */
export function assessEditorPlateByObjectLinkedCopies(input: {
  plate: Pick<EditorPlate, 'instances'>
  engine: ByObjectLinkedCopyEngine | null | undefined
  printSequence: string | null | undefined
}): EditorByObjectLinkedCopyIssue[] {
  const instances = input.plate.instances

  const placements = instances.map((instance) => ({
    // An instance with no shareable identity is linked to nothing, so it gets a key of its own.
    objectKey: instanceLinkageKey(instance) ?? `unlinked:${instance.key}`,
    transform: byObjectPlacementTransform({
      position: instance.position,
      rotation: instance.rotation,
      scale: instance.scale,
      matrix: instance.exactMatrix ?? null
    }),
    printable: instance.printable
  }))

  const issues = assessByObjectLinkedCopies({
    engine: input.engine,
    printSequence: input.printSequence,
    placements
  })

  return issues.map((issue) => {
    const affected = issue.placementIndexes.map((index) => instances[index]!)
    const first = affected[0]!

    return {
      defect: issue.defect,
      key: first.key,
      name: first.name,
      instanceKeys: affected.map((instance) => instance.key),
      summary: summarizeByObjectLinkedCopyIssue(issue),
      message: describeByObjectLinkedCopyIssue(issue, first.name)
    }
  })
}

/**
 * Whether the plate holds any linked copies at all, the cheap test that decides whether resolving
 * the project's print sequence is worth a request.
 */
export function plateHasLinkedCopies(plate: Pick<EditorPlate, 'instances'>): boolean {
  const seen = new Set<string>()

  for (const instance of plate.instances) {
    const identity = instanceLinkageKey(instance)
    if (identity == null) continue
    if (seen.has(identity)) return true
    seen.add(identity)
  }

  return false
}

/** The engine the slice will run on, from the slice controller's selected target. */
export function selectedSliceEngine(sliceConfig: Pick<SliceSettingsController, 'slicerTargets' | 'selectedSlicerTargetId'> | undefined): ByObjectLinkedCopyEngine | null {
  if (!sliceConfig) return null
  const target = sliceConfig.slicerTargets.find((entry) => entry.id === sliceConfig.selectedSlicerTargetId)
  return target ? { family: target.family, version: target.version } : null
}
