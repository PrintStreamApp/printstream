/**
 * Owns selection-to-transform-gizmo attachment. Object and body selection pivot on printable
 * geometry, while an added or baked volume attaches to its own scene node. The editor supplies
 * current groups and readout callbacks; this policy never changes the selection itself.
 */
import * as THREE from 'three'
import type { TransformControls } from 'three-stdlib'
import {
  isTransformGizmoMode,
  partGroupRef,
  printableMeshBox,
  rotorOf,
  type GizmoMode,
  type SelectedTransform
} from '../editorGeometry'
import type { PartRef } from './selectionModel'
import { selectionPivot } from './multiSelectionTransform'

interface GizmoAttachmentOptions {
  transform: TransformControls | null
  selectedKey: string | null
  groups: Map<string, THREE.Group>
  part: PartRef | null
  mode: GizmoMode
  pivotProxy: THREE.Object3D | null
  allSelectedKeys: () => Iterable<string>
  setSelectionHighlight: (group: THREE.Group | null) => void
  computeSelectedTransform: (object: THREE.Object3D) => SelectedTransform | null
  setSelectedTransform: (value: SelectedTransform | null) => void
}

/** Seat the transform gizmo and seed the manual transform readout for the current selection. */
export function attachEditorGizmo(options: GizmoAttachmentOptions): void {
  const { transform } = options
  if (!transform) return
  const group = options.selectedKey ? options.groups.get(options.selectedKey) : null
  options.setSelectionHighlight(options.part ? null : group ?? null)
  if (!group) {
    transform.detach()
    options.setSelectedTransform(null)
    return
  }

  let panelTarget: THREE.Object3D = group
  const attachToSelectionPivot = (boxes: THREE.Box3[]): void => {
    const pivot = selectionPivot(boxes, isTransformGizmoMode(options.mode) ? options.mode : 'translate')
    if (options.pivotProxy && pivot) {
      options.pivotProxy.position.copy(pivot)
      options.pivotProxy.quaternion.identity()
      options.pivotProxy.scale.set(1, 1, 1)
      transform.attach(options.pivotProxy)
    } else {
      // During mount or for an empty box, use the object's origin instead of guessing a centre.
      transform.attach(options.mode === 'rotate' ? rotorOf(group) : group)
    }
  }

  // Text, painting, Cut, and other non-transform tools have no transform gizmo.
  if (!isTransformGizmoMode(options.mode)) {
    transform.detach()
  } else if (options.part) {
    const member = options.part.member
    if (member.kind === 'body') {
      // The body has no separate placement: selecting its row still moves the whole object.
      attachToSelectionPivot([printableMeshBox(group, false)])
      transform.setMode(options.mode)
      const seededBody = options.computeSelectedTransform(group)
      if (seededBody) options.setSelectedTransform(seededBody)
      return
    }

    let partNode: THREE.Object3D | null = null
    group.traverse((node) => {
      if (partNode) return
      if (member.kind === 'added') {
        if (node.userData.addedPartKey === member.key) partNode = node
        return
      }
      const ref = partGroupRef(node)
      if (ref && ref.partIndex === member.partIndex) partNode = node
    })
    if (partNode) {
      transform.attach(partNode)
      transform.setMode(options.mode)
      panelTarget = partNode
    } else {
      transform.attach(options.mode === 'rotate' ? rotorOf(group) : group)
      transform.setMode(options.mode)
    }
  } else {
    // Both one object and a multi-selection pivot at geometry centre, never an exporter origin.
    const boxes: THREE.Box3[] = []
    for (const key of options.allSelectedKeys()) {
      const memberGroup = options.groups.get(key)
      if (memberGroup) boxes.push(printableMeshBox(memberGroup, false))
    }
    attachToSelectionPivot(boxes)
    transform.setMode(options.mode)
  }

  // Selection changes seed React state once; drag frames use the separate live readout path.
  const seeded = options.computeSelectedTransform(panelTarget)
  if (seeded) options.setSelectedTransform(seeded)
}
