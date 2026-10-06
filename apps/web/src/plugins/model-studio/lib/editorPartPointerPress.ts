/**
 * Handles volume drill-down on a press over an already selected object. Added volumes select
 * immediately and own their direct drag; baked volumes defer selection until release so an
 * object drag does not turn into a part selection. The viewport owns the live scene and drag
 * controllers passed into this helper.
 */
import * as THREE from 'three'
import type { OrbitControls } from 'three-stdlib'
import {
  allowsSelectionPicking,
  BRIM_EAR_MARKER_NAME,
  isAddedPartMesh,
  partGroupRef,
  rotorOf,
  type GizmoMode
} from '../editorGeometry'
import type { EditorInstance } from './editorModel'
import type { PartRef } from './selectionModel'

interface PartPointerPressOptions {
  group: THREE.Group
  instanceKey: unknown
  event: PointerEvent
  mode: GizmoMode
  raycaster: THREE.Raycaster
  bedPlane: THREE.Plane
  dragPoint: THREE.Vector3
  canvas: Pick<HTMLCanvasElement, 'setPointerCapture'>
  orbit: Pick<OrbitControls, 'enabled'>
  findInstance: (key: unknown) => EditorInstance | undefined
  extraSelectionCount: number
  selectedPart: PartRef | null
  selectPart: (part: PartRef | null) => void
  beginBakedPart: (part: PartRef, event: PointerEvent) => void
  beginAddedPartDrag: (mesh: THREE.Object3D, rotor: THREE.Object3D, point: THREE.Vector3) => void
}

/** Return true when an added volume owns the press and object dragging must stop. */
export function handleEditorPartPointerPress(options: PartPointerPressOptions): boolean {
  const {
    group, instanceKey, event, mode, raycaster, bedPlane, dragPoint,
    canvas, orbit, findInstance, extraSelectionCount, selectedPart,
    selectPart, beginBakedPart, beginAddedPartDrag
  } = options
  if (!allowsSelectionPicking(mode)) return false

  const hits = raycaster.intersectObject(group, true)
  const firstMesh = hits.find((hit) => (hit.object as THREE.Mesh).isMesh && hit.object.name !== BRIM_EAR_MARKER_NAME)
  const partKey = firstMesh?.object.userData.addedPartKey
  const instance = findInstance(instanceKey)
  const ownerId = instance
    ? (instance.source.kind === 'object' ? instance.objectId : instance.source.replacedObjectId ?? null)
    : null

  if (typeof partKey === 'string') {
    if (ownerId != null) selectPart({ objectId: ownerId, member: { kind: 'added', key: partKey } })

    // Paint overlays are children of the tagged volume mesh. Capture the volume's transform,
    // then derive the grab offset from this press, never a bed hit left by an earlier gesture.
    const picked = firstMesh?.object ?? null
    const grabbed = picked && isAddedPartMesh(picked)
      ? (typeof picked.userData.addedPartKey === 'string' ? picked : picked.parent)
      : null
    if (grabbed && mode === 'translate' && raycaster.ray.intersectPlane(bedPlane, dragPoint)) {
      beginAddedPartDrag(grabbed, rotorOf(group), dragPoint)
      orbit.enabled = false
      canvas.setPointerCapture(event.pointerId)
    }
    return true
  }

  // Baked-part selection is deferred until pointer-up, while a click on the body steps out
  // of an added-volume selection immediately. A baked selection must not flicker off on press.
  if (selectedPart?.member.kind === 'added') selectPart(null)
  const partRef = firstMesh?.object.parent ? partGroupRef(firstMesh.object.parent) : null
  if (partRef && extraSelectionCount === 0 && instance && ownerId != null && instance.parts.length > 1) {
    beginBakedPart({ objectId: ownerId, member: { kind: 'baked', partIndex: partRef.partIndex } }, event)
  }
  return false
}
