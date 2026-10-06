/**
 * Resolves paint hits on the selected instance for one editor viewport mount.
 *
 * The viewport owns the camera, shared raycaster, and scene groups. Each hit leaves that raycaster
 * aimed at the sample so `useEditorScene` can pass its direction into the paint operation. BVHs
 * are created lazily only for the selected instance's printable meshes.
 */
import * as THREE from 'three'
import { ensureMeshBvh } from './meshBvh'
import type { PaintHit } from './editorPaintStroke'

interface PaintPickingOptions {
  canvas: HTMLCanvasElement
  camera: THREE.PerspectiveCamera
  pointer: THREE.Vector2
  raycaster: THREE.Raycaster
  getSelectedGroup: () => THREE.Group | null
}

/** Create live target collection and raycast helpers for the paint stroke and cursor. */
export function createEditorPaintPicker({
  canvas,
  camera,
  pointer,
  raycaster,
  getSelectedGroup
}: PaintPickingOptions) {
  /** Collect once per pointer event, not for every interpolated stroke sample. */
  const targets = (): THREE.Mesh[] => {
    const selectedGroup = getSelectedGroup()
    if (!selectedGroup) return []
    const meshes: THREE.Mesh[] = []
    selectedGroup.traverse((node) => {
      const mesh = node as THREE.Mesh
      if (mesh.isMesh && mesh.userData.supportPaintPart) meshes.push(mesh)
    })
    // A dense plate should pay the indexing cost only for the instance being painted.
    for (const mesh of meshes) ensureMeshBvh(mesh)
    return meshes
  }

  /** Raycast a viewport position, leaving the shared raycaster aimed at this sample. */
  const hitAt = (clientX: number, clientY: number, meshes: THREE.Mesh[]): PaintHit | null => {
    if (meshes.length === 0) return null
    const rect = canvas.getBoundingClientRect()
    pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1
    pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1
    raycaster.setFromCamera(pointer, camera)
    const hit = raycaster.intersectObjects(meshes, false).find((entry) => entry.face)
    if (!hit?.face) return null
    const normal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld).normalize()
    return { mesh: hit.object as THREE.Mesh, point: hit.point, normal, faceIndex: hit.faceIndex ?? null }
  }

  /** Pick from the selected instance's printable parts for a pointer event. */
  const hitOnSelected = (event: PointerEvent): PaintHit | null =>
    hitAt(event.clientX, event.clientY, targets())

  return { targets, hitAt, hitOnSelected }
}
