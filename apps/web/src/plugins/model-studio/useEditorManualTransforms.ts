/**
 * Owns the editor's manual object and part transforms.
 *
 * A selected part writes its object-local placement through the shared part callback; a body
 * or whole-object selection falls through to the instance transform. History, scene persistence,
 * and thumbnail ownership stay with the editor session.
 */
import { useCallback, type MutableRefObject } from 'react'
import * as THREE from 'three'
import { partGroupRef, plateDeltaToPartLocal, rotorOf } from './editorGeometry'
import type { PartRef } from './lib/selectionModel'

interface ManualTransformOptions {
  selectedKeyRef: MutableRefObject<string | null>
  groupByKeyRef: MutableRefObject<Map<string, THREE.Group>>
  gizmoPartRef: MutableRefObject<PartRef | null>
  uniformScale: boolean
  recordHistory: () => void
  writeBackPart: (part: THREE.Object3D) => void
  syncSelectedTransform: (part: THREE.Object3D) => void
  regenerateActivePlateThumbnail: () => void
  mutateSelectedGroup: (mutate: (group: THREE.Group) => void) => void
  nudgeSelection: (dx: number, dy: number) => void
}

/** Return manual-field and keyboard callbacks while reading the live selected scene object. */
export function useEditorManualTransforms({
  selectedKeyRef,
  groupByKeyRef,
  gizmoPartRef,
  uniformScale,
  recordHistory,
  writeBackPart,
  syncSelectedTransform,
  regenerateActivePlateThumbnail,
  mutateSelectedGroup,
  nudgeSelection
}: ManualTransformOptions) {
  /** Find the currently selected part without confusing an added part with a baked volume. */
  const selectedPartObject = useCallback((): THREE.Object3D | null => {
    const key = selectedKeyRef.current
    const group = key ? groupByKeyRef.current.get(key) : null
    if (!group) return null
    const gizmo = gizmoPartRef.current
    if (!gizmo) return null
    const member = gizmo.member
    // The body is the object's geometry, so its placement belongs to the instance.
    if (member.kind === 'body') return group
    let found: THREE.Object3D | null = null
    group.traverse((node) => {
      if (found) return
      if (member.kind === 'added') {
        if (node.userData.addedPartKey === member.key) found = node
        return
      }
      const ref = partGroupRef(node)
      if (ref && ref.partIndex === member.partIndex) found = node
    })
    return found
  }, [gizmoPartRef, groupByKeyRef, selectedKeyRef])

  /** Persist one part placement; return false when the object transform must handle it. */
  const mutateSelectedPart = useCallback((mutate: (trs: {
    position: THREE.Vector3
    rotation: THREE.Euler
    scale: THREE.Vector3
  }) => void): boolean => {
    if (gizmoPartRef.current?.member.kind === 'body') return false
    const part = selectedPartObject()
    if (!part) return false
    recordHistory()
    if (typeof part.userData.addedPartKey === 'string') {
      mutate({ position: part.position, rotation: part.rotation as THREE.Euler, scale: part.scale })
      writeBackPart(part)
    } else {
      const mesh = part.children.find((child) => (child as THREE.Mesh).isMesh === true)
      if (!mesh) return true
      part.updateMatrix()
      mesh.updateMatrix()
      const effective = new THREE.Matrix4().multiplyMatrices(part.matrix, mesh.matrix)
      const position = new THREE.Vector3()
      const quaternion = new THREE.Quaternion()
      const scale = new THREE.Vector3()
      effective.decompose(position, quaternion, scale)
      const rotation = new THREE.Euler().setFromQuaternion(quaternion, 'XYZ')
      mutate({ position, rotation, scale })
      const desired = new THREE.Matrix4().compose(position, new THREE.Quaternion().setFromEuler(rotation), scale)
      const delta = desired.multiply(mesh.matrix.clone().invert())
      delta.decompose(part.position, part.quaternion, part.scale)
      writeBackPart(part)
    }
    syncSelectedTransform(part)
    regenerateActivePlateThumbnail()
    return true
  }, [gizmoPartRef, recordHistory, regenerateActivePlateThumbnail, selectedPartObject,
    syncSelectedTransform, writeBackPart])

  const applyManualPosition = useCallback((axis: 'x' | 'y' | 'z', value: number) => {
    if (!Number.isFinite(value)) return
    if (mutateSelectedPart(({ position }) => { position[axis] = value })) return
    mutateSelectedGroup((group) => { group.position[axis] = value })
  }, [mutateSelectedPart, mutateSelectedGroup])

  const applyManualRotation = useCallback((axis: 'x' | 'y' | 'z', degrees: number) => {
    if (!Number.isFinite(degrees)) return
    if (mutateSelectedPart(({ rotation }) => { rotation[axis] = THREE.MathUtils.degToRad(degrees) })) return
    mutateSelectedGroup((group) => { rotorOf(group).rotation[axis] = THREE.MathUtils.degToRad(degrees) })
  }, [mutateSelectedPart, mutateSelectedGroup])

  const applyManualScale = useCallback((axis: 'x' | 'y' | 'z', percent: number) => {
    if (!Number.isFinite(percent) || percent <= 0) return
    const factor = percent / 100
    const scaleAxes = (scale: THREE.Vector3) => {
      if (uniformScale) scale.set(factor, factor, factor)
      else scale[axis] = factor
    }
    if (mutateSelectedPart(({ scale }) => scaleAxes(scale))) return
    mutateSelectedGroup((group) => scaleAxes(group.scale))
  }, [mutateSelectedPart, mutateSelectedGroup, uniformScale])

  /** Arrow keys move parts in their object-local frame, but whole objects in plate coordinates. */
  const nudgeTransform = useCallback((dx: number, dy: number) => {
    const part = selectedPartObject()
    if (part) {
      const rotor = part.parent
      rotor?.updateWorldMatrix(true, false)
      const local = rotor
        ? plateDeltaToPartLocal(rotor.matrixWorld, dx, dy)
        : new THREE.Vector3(dx, dy, 0)
      if (mutateSelectedPart(({ position }) => { position.add(local) })) return
    }
    nudgeSelection(dx, dy)
  }, [mutateSelectedPart, nudgeSelection, selectedPartObject])

  /** Rotate the selected part when present, otherwise rotate the selected object. */
  const rotateTransformZ = useCallback((radians: number) => {
    if (mutateSelectedPart(({ rotation }) => { rotation.z += radians })) return
    mutateSelectedGroup((group) => { rotorOf(group).rotation.z += radians })
  }, [mutateSelectedGroup, mutateSelectedPart])

  return { applyManualPosition, applyManualRotation, applyManualScale, nudgeTransform, rotateTransformZ }
}
