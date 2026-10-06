/**
 * Writes a dragged part's live transform back to the editor scene. Added volumes own their local
 * transform; baked volumes share one ordinal-scoped placement across linked copies. The editor
 * still owns drag history and calls this only after a committed transform gesture.
 */
import * as THREE from 'three'
import { partGroupRef } from '../editorGeometry'
import { addedPartHostId, partSlotKey, type EditorPlate, type EditorState } from './editorModel'
import type { PartRef } from './selectionModel'
import { threeMfTransformFromMatrix } from './threeMfScene'

interface PartTransformWriteBackContext {
  state: EditorState | null
  selectedPart: PartRef | null
  activePlate: EditorPlate | null
  groupByKey: ReadonlyMap<string, THREE.Group>
  reseatDraggedText: ((mesh: THREE.Object3D) => void) | null
}

/** Persist a dragged added volume or baked part, including live linked-copy groups. */
export function writeBackEditorPartTransform(
  object: THREE.Object3D,
  context: PartTransformWriteBackContext
): void {
  if (typeof object.userData.addedPartKey === 'string') {
    writeBackAddedPart(object, context)
  } else if (partGroupRef(object)) {
    writeBackBakedPart(object, context)
  }
}

/** Added volumes store their placement on the session part record. */
function writeBackAddedPart(mesh: THREE.Object3D, context: PartTransformWriteBackContext): void {
  const key = mesh.userData.addedPartKey
  if (!context.state?.addedParts || typeof key !== 'string') return
  for (const parts of Object.values(context.state.addedParts)) {
    const part = parts.find((entry) => entry.key === key)
    if (!part) continue
    part.position.copy(mesh.position)
    part.rotation.copy(mesh.rotation)
    part.scale.copy(mesh.scale)
    // Surface text rebuilds around its new location instead of merely translating its old mesh.
    context.reseatDraggedText?.(mesh)
    return
  }
}

/** Baked placements use the part's ordinal, never its reusable component mesh ID. */
function writeBackBakedPart(partGroup: THREE.Object3D, context: PartTransformWriteBackContext): void {
  const gizmo = context.selectedPart
  if (gizmo?.member.kind !== 'baked' || !context.state) return
  const selected = { objectId: gizmo.objectId, partIndex: gizmo.member.partIndex }
  const ref = partGroupRef(partGroup)
  if (!ref || ref.partIndex !== selected.partIndex) return
  const mesh = partGroup.children.find((child) => (child as THREE.Mesh).isMesh === true)
  if (!mesh) return

  partGroup.updateMatrix()
  mesh.updateMatrix()
  const effective = new THREE.Matrix4().multiplyMatrices(partGroup.matrix, mesh.matrix)
  const matrix = threeMfTransformFromMatrix(effective)
  if (!context.state.partTransforms) context.state.partTransforms = {}
  context.state.partTransforms[partSlotKey(selected.objectId, selected.partIndex)] = matrix

  // Linked copies and multi-solid imports share placement by object ID and part ordinal.
  const ownsSelectedPart = (instance: EditorPlate['instances'][number]) =>
    addedPartHostId(instance) === selected.objectId
  for (const plate of context.state.plates) {
    for (const instance of plate.instances) {
      if (!ownsSelectedPart(instance)) continue
      const part = instance.parts.find((entry) => entry.partIndex === selected.partIndex)
      if (part) part.transform = [...matrix]
    }
  }

  // Mirror the drag delta to visible copies without rebuilding the active plate.
  for (const instance of context.activePlate?.instances ?? []) {
    if (!ownsSelectedPart(instance)) continue
    const group = context.groupByKey.get(instance.key)
    if (!group) continue
    group.traverse((node) => {
      if (node === partGroup) return
      const nodeRef = partGroupRef(node)
      if (nodeRef?.partIndex !== selected.partIndex) return
      node.position.copy(partGroup.position)
      node.quaternion.copy(partGroup.quaternion)
      node.scale.copy(partGroup.scale)
    })
  }
}
