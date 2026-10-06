/**
 * Owns one added-part mesh drag from pointer press through release.
 *
 * The pointer lands in world bed coordinates, while an added part's position belongs to its
 * rotor. Studio permits dragging a volume by its mesh, so the viewport must route that hit here
 * instead of treating it as an object drag. Convert each point into the rotor's frame, keep the
 * original height, and record undo on the first move so a selection click leaves no checkpoint.
 */
import * as THREE from 'three'

export interface EditorPartDragOptions {
  recordHistory: () => void
  writeBackPartMesh: (mesh: THREE.Object3D) => void
  reseatPivot: () => void
}

/** Return per-mount drag state; pointer capture and final panel sync stay in the viewport. */
export function createEditorPartDrag(options: EditorPartDragOptions) {
  const { recordHistory, writeBackPartMesh, reseatPivot } = options
  let mesh: THREE.Object3D | null = null
  let rotor: THREE.Object3D | null = null
  let recorded = false
  const offset = new THREE.Vector3()

  return {
    get active() { return mesh !== null },

    /** Capture the grab offset after converting the bed-plane press into rotor coordinates. */
    begin(nextMesh: THREE.Object3D, nextRotor: THREE.Object3D, point: THREE.Vector3) {
      mesh = nextMesh
      rotor = nextRotor
      recorded = false
      offset.copy(nextMesh.position).sub(nextRotor.worldToLocal(point.clone()))
    },

    /** Apply a pointer move in the rotor frame; return false without an active part. */
    move(point: THREE.Vector3): boolean {
      if (!mesh || !rotor) return false
      if (!recorded) {
        recordHistory()
        recorded = true
      }
      const local = rotor.worldToLocal(point.clone())
      mesh.position.x = local.x + offset.x
      mesh.position.y = local.y + offset.y
      writeBackPartMesh(mesh)
      reseatPivot()
      return true
    },

    /** End the drag and return its mesh for final panel sync. */
    finish(): THREE.Object3D | null {
      const completed = mesh
      mesh = null
      rotor = null
      return completed
    }
  }
}
