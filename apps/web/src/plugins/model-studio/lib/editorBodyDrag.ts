/**
 * Owns one editor object-body drag across pointer press, move, and release.
 *
 * The viewport resolves pointer hits and pointer capture. This controller holds the press
 * offsets, one undo checkpoint, and the co-dragged selection so moves stay rigid.
 */
import * as THREE from 'three'

export interface EditorBodyDragOptions {
  getSelectedKeys: () => readonly string[]
  groupFor: (key: string) => THREE.Group | null
  bakeExactMatrix: (group: THREE.Group) => void
  recordHistory: () => void
  writeBackGroupTransform: (group: THREE.Group) => void
  reseatPivot: () => void
  throttledPanelSync: (group: THREE.Group) => void
  markTranslationDrag: () => void
}

/**
 * Create per-mount body-drag state. A selection click with no move creates no undo step;
 * each moved member is written through before the gizmo pivot is re-seated.
 */
export function createEditorBodyDrag(options: EditorBodyDragOptions) {
  const {
    getSelectedKeys, groupFor, bakeExactMatrix, recordHistory,
    writeBackGroupTransform, reseatPivot, throttledPanelSync, markTranslationDrag
  } = options
  const offset = new THREE.Vector3()
  let dragged: THREE.Group | null = null
  let recorded = false
  let extras: Array<{ group: THREE.Group; offsetX: number; offsetY: number }> = []

  return {
    get active() { return dragged !== null },

    /** Begin with the current bed-plane point, before any pointer movement. */
    begin(group: THREE.Group, point: THREE.Vector3) {
      bakeExactMatrix(group)
      offset.set(group.position.x - point.x, group.position.y - point.y, 0)
      dragged = group
      recorded = false
      extras = []
      markTranslationDrag()
    },

    /** Capture selected peers' offsets from the same press point as the grabbed group. */
    beginCoDrag(grabbedKey: string, point: THREE.Vector3) {
      extras = getSelectedKeys()
        .filter((key) => key !== grabbedKey)
        .map((key) => groupFor(key))
        .filter((group): group is THREE.Group => Boolean(group))
        .map((group) => {
          // A shearing exact matrix must be converted before its editable position is read.
          bakeExactMatrix(group)
          return { group, offsetX: group.position.x - point.x, offsetY: group.position.y - point.y }
        })
    },

    /** Apply a pointer move; returns false if no body drag is active. */
    move(point: THREE.Vector3): boolean {
      if (!dragged) return false
      if (!recorded) {
        recordHistory()
        recorded = true
      }
      dragged.position.x = point.x + offset.x
      dragged.position.y = point.y + offset.y
      writeBackGroupTransform(dragged)
      for (const extra of extras) {
        extra.group.position.x = point.x + extra.offsetX
        extra.group.position.y = point.y + extra.offsetY
        writeBackGroupTransform(extra.group)
      }
      // The gizmo hangs from a proxy, so moving only the meshes would leave it behind.
      reseatPivot()
      throttledPanelSync(dragged)
      return true
    },

    /** Clear peer offsets after any pointer release, including a non-body tool gesture. */
    clearPeers() { extras = [] },

    /** End the body drag and return its group for the caller's final panel sync. */
    finish(): THREE.Group | null {
      const group = dragged
      dragged = null
      extras = []
      return group
    }
  }
}
