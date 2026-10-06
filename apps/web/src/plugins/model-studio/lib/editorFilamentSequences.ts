/**
 * Reconcile a scene edit's per-plate custom print orders at the save/slice
 * emission boundary. The editor can change materials without reopening Plate
 * Settings, so every emitted sequence must match the current physical slots.
 */
import { reconcilePlateFilamentSequence, type SceneEdit } from '@printstream/shared'

type ProjectFilamentSequenceItem = {
  projectFilamentId: number
  mixedFilament?: unknown
}

/**
 * Reconciles per-plate custom print orders with the current project materials.
 * Material edits can occur without reopening Plate Settings, so this emission
 * boundary drops removed ids and appends new physical ids in project order.
 * Virtual mixed slots are excluded because the slicer sequences their physical
 * components, not the virtual slot itself.
 */
export function reconcileSceneEditFilamentSequences(
  edit: SceneEdit,
  projectFilaments: readonly ProjectFilamentSequenceItem[]
): SceneEdit {
  const physicalFilamentIds = projectFilaments
    .filter((filament) => !filament.mixedFilament)
    .map((filament) => filament.projectFilamentId)

  if (physicalFilamentIds.length === 0) {
    return edit
  }

  return {
    ...edit,
    plates: edit.plates.map((plate) => ({
      ...plate,
      firstLayerFilamentSequence: plate.firstLayerFilamentSequence
        ? reconcilePlateFilamentSequence(
            plate.firstLayerFilamentSequence,
            physicalFilamentIds
          )
        : plate.firstLayerFilamentSequence,
      otherLayerFilamentSequences: plate.otherLayerFilamentSequences?.map((range) => ({
        ...range,
        filamentIds: reconcilePlateFilamentSequence(
          range.filamentIds,
          physicalFilamentIds
        )
      })) ?? plate.otherLayerFilamentSequences
    }))
  }
}
