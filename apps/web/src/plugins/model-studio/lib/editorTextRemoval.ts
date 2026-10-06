/**
 * Owns removal of the Text session's standalone object or hosted part. The editor supplies the
 * pinned session identities; standalone removal uses the plate updater's one history checkpoint,
 * while hosted removal stays inside the checkpoint recorded when the Text tool opened.
 */
import type { EditorPlate, EditorState } from './editorModel'

interface TextRemovalOptions {
  objectKey: string | null
  partKey: string | null
  activePlateIndex: number
  stateRef: { current: EditorState | null }
  settleRef: { current: number | undefined }
  updatePlates: (updater: (plates: EditorPlate[]) => EditorPlate[]) => void
  setEditingObject: (key: string | null) => void
  setEditingPartKey: (key: string | null) => void
  selectObject: (key: string | null) => void
  clearSelectedPart: () => void
  refreshAddedPartMeshes: () => void
  regenerateThumbnail: () => void
}

/** Remove the current Text result without allowing a pending settle to recreate it. */
export function removeEditorText(options: TextRemovalOptions): void {
  window.clearTimeout(options.settleRef.current)

  if (options.objectKey) {
    // updatePlates records the only history frame for this removal.
    options.updatePlates((plates) => plates.map((plate) =>
      plate.index === options.activePlateIndex
        ? { ...plate, instances: plate.instances.filter((item) => item.key !== options.objectKey) }
        : plate
    ))
    options.setEditingObject(null)
    options.selectObject(null)
    options.regenerateThumbnail()
    return
  }

  const state = options.stateRef.current
  if (!state?.addedParts || !options.partKey) return
  for (const [hostId, parts] of Object.entries(state.addedParts)) {
    const kept = parts.filter((part) => part.key !== options.partKey)
    if (kept.length !== parts.length) state.addedParts[Number(hostId)] = kept
  }
  options.setEditingPartKey(null)
  options.clearSelectedPart()
  options.refreshAddedPartMeshes()
  options.regenerateThumbnail()
}
