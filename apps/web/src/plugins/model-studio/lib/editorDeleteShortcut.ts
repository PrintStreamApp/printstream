/**
 * Routes Delete to the editor selection the user can see.
 * A measurement owns Delete while it has picks; part selection takes precedence
 * over an object key. The printable-geometry guard may refuse part removal, in
 * which case only that part selection is cleared. No action records history here;
 * each accepted removal owns its own checkpoint.
 */
import type { GizmoMode } from '../editorGeometry'
import type { PartMember, PartRef, PartSelection } from './selectionModel'

interface EditorDeleteShortcutOptions {
  key: string | null
  mode: GizmoMode
  measurePickCount: number
  clearMeasurement: () => void
  bulkSelection: PartSelection | null
  selectedPart: PartRef | null
  partSelectionRemovable: (objectId: number, members: ReadonlyArray<PartMember>) => boolean
  removeParts: (objectId: number, members: ReadonlyArray<PartMember>) => void
  clearBulkSelection: () => void
  clearSelectedPart: () => void
  deleteObject: (key: string) => void
}

/** Apply one Delete press to measurement, bulk parts, one part, or an object in that order. */
export function performEditorDeleteShortcut({
  key,
  mode,
  measurePickCount,
  clearMeasurement,
  bulkSelection,
  selectedPart,
  partSelectionRemovable,
  removeParts,
  clearBulkSelection,
  clearSelectedPart,
  deleteObject
}: EditorDeleteShortcutOptions): void {
  // Measure can leave an object selected underneath. Delete restarts the measurement first.
  if (mode === 'measure' && measurePickCount > 0) {
    clearMeasurement()
    return
  }

  // A bulk part selection nulls the primary object key, but still names visible parts.
  if (bulkSelection) {
    if (partSelectionRemovable(bulkSelection.objectId, bulkSelection.members)) {
      removeParts(bulkSelection.objectId, bulkSelection.members)
    } else {
      clearBulkSelection()
    }
    return
  }

  if (selectedPart) {
    if (partSelectionRemovable(selectedPart.objectId, [selectedPart.member])) {
      removeParts(selectedPart.objectId, [selectedPart.member])
    } else {
      clearSelectedPart()
    }
    return
  }

  if (key !== null) deleteObject(key)
}
