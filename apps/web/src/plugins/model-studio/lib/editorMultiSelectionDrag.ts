/**
 * Owns one viewport multi-selection transform from gizmo press to release.
 * Every frame derives member poses from the press snapshot, and release rests and writes back
 * each member before reseating the pivot for the next gesture. `editorTransformInteraction`
 * owns the history checkpoint and guide/readout updates; `useEditorScene` owns scene disposal.
 */
import * as THREE from 'three'
import { printableMeshBox, restObjectOnBed, rotorOf } from '../editorGeometry'
import {
  applySelectionDelta,
  selectionDeltaFromProxy,
  selectionPivot,
  type MultiTransformMode,
  type SelectionDelta,
  type SelectionMemberPose
} from './multiSelectionTransform'

interface DragMember {
  group: THREE.Group
  start: SelectionMemberPose
}

interface DragSnapshot {
  pivot: THREE.Vector3
  proxyStart: SelectionMemberPose
  members: DragMember[]
}

interface MultiSelectionDragContext {
  proxy: THREE.Group
  selectedKeys: () => readonly string[]
  groupFor: (key: string) => THREE.Group | null
  bakeExactMatrix: (group: THREE.Group) => void
  writeBack: (group: THREE.Group) => void
}

function poseOf(object: THREE.Object3D): SelectionMemberPose {
  return {
    position: object.position.clone(),
    quaternion: rotorOf(object).quaternion.clone(),
    scale: object.scale.clone()
  }
}

/** Create the viewport's per-mount multi-selection drag controller. */
export function createEditorMultiSelectionDrag(context: MultiSelectionDragContext) {
  const { proxy, selectedKeys, groupFor, bakeExactMatrix, writeBack } = context
  let snapshot: DragSnapshot | null = null

  /** Re-seat after either a gizmo drag or a body drag of the selected members. */
  function reseatPivot(mode: MultiTransformMode): void {
    const boxes: THREE.Box3[] = []
    for (const key of selectedKeys()) {
      const group = groupFor(key)
      if (group) boxes.push(printableMeshBox(group, false))
    }
    const pivot = selectionPivot(boxes, mode)
    if (pivot) proxy.position.copy(pivot)
    proxy.quaternion.identity()
    proxy.scale.set(1, 1, 1)
  }

  return {
    /** Take one press snapshot after converting exact-matrix members into editable transforms. */
    begin(): void {
      snapshot = null
      const members: DragMember[] = []
      for (const key of selectedKeys()) {
        const group = groupFor(key)
        if (!group) continue
        bakeExactMatrix(group)
        members.push({ group, start: poseOf(group) })
      }
      if (members.length === 0) return
      snapshot = {
        pivot: proxy.position.clone(),
        proxyStart: poseOf(proxy),
        members
      }
    },

    /** Return the press pivot for guides, or null outside a multi-selection drag. */
    pivot(): THREE.Vector3 | null {
      return snapshot?.pivot ?? null
    },

    /** Apply the proxy's current delta to every member from its original pose. */
    apply(mode: MultiTransformMode): SelectionDelta | null {
      if (!snapshot) return null
      const delta = selectionDeltaFromProxy(poseOf(proxy), snapshot.proxyStart)
      for (const member of snapshot.members) {
        const pose = applySelectionDelta(mode, member.start, delta, snapshot.pivot)
        member.group.position.copy(pose.position)
        rotorOf(member.group).quaternion.copy(pose.quaternion)
        member.group.scale.copy(pose.scale)
        if (mode === 'scale') restObjectOnBed(member.group)
        writeBack(member.group)
      }
      return delta
    },

    /** Finish member writeback and prepare a clean proxy for the next drag. */
    finish(mode: MultiTransformMode): void {
      if (!snapshot) return
      for (const member of snapshot.members) {
        restObjectOnBed(member.group)
        writeBack(member.group)
      }
      reseatPivot(mode)
      snapshot = null
    },

    reseatPivot,

    /** Release references during viewport teardown. */
    reset(): void {
      snapshot = null
    }
  }
}
