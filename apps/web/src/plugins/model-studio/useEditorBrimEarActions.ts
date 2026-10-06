/**
 * Owns brim-ear marker meshes and edits to their object-local first-layer positions. The scene
 * builder calls setGroupBrimEarMarkers for each rebuilt group; Undo calls refreshBrimEarMarkers
 * after cloned state replaces the live map. Each user edit records one history frame.
 */
import { useCallback, type MutableRefObject } from 'react'
import * as THREE from 'three'
import { disposeObject3D } from './lib/threeMfScene'
import {
  addedPartHostId,
  effectiveBrimEars,
  type EditorBrimEar,
  type EditorPlate,
  type EditorState
} from './lib/editorModel'
import {
  BRIM_EAR_MARKER_COLOR,
  BRIM_EAR_MARKER_NAME,
  syncBrimEarMarkerMatrices
} from './editorGeometry'

export type BrimEarEdit =
  | { kind: 'add'; group: THREE.Group; worldPoint: THREE.Vector3 }
  | { kind: 'remove'; index: number }
  | { kind: 'clear' }

interface BrimEarActionOptions {
  stateRef: MutableRefObject<EditorState | null>
  activePlateRef: MutableRefObject<EditorPlate | null>
  groupByKeyRef: MutableRefObject<Map<string, THREE.Group>>
  selectedKeyRef: MutableRefObject<string | null>
  brimEarDiameterRef: MutableRefObject<number>
  recordHistoryRef: MutableRefObject<(() => void) | null>
  regenerateThumbnailRef: MutableRefObject<(() => void) | null>
}

/** Return stable marker and edit actions for the editor scene and pointer tool. */
export function useEditorBrimEarActions(options: BrimEarActionOptions) {
  const {
    stateRef,
    activePlateRef,
    groupByKeyRef,
    selectedKeyRef,
    brimEarDiameterRef,
    recordHistoryRef,
    regenerateThumbnailRef
  } = options

  /** Replace a group's translucent markers after its saved or session state changes. */
  const setGroupBrimEarMarkers = useCallback((group: THREE.Group, ears: EditorBrimEar[]) => {
    const rotor = (group.userData.rotor as THREE.Group | undefined) ?? group
    for (const child of rotor.children.filter((entry) => entry.name === BRIM_EAR_MARKER_NAME)) {
      rotor.remove(child)
      disposeObject3D(child)
    }

    ears.forEach((ear, index) => {
      const marker = new THREE.Mesh(
        new THREE.CylinderGeometry(ear.radius, ear.radius, 1, 24),
        new THREE.MeshStandardMaterial({
          color: BRIM_EAR_MARKER_COLOR,
          transparent: true,
          opacity: 0.75,
          roughness: 0.5,
          metalness: 0,
          depthWrite: false
        })
      )
      marker.name = BRIM_EAR_MARKER_NAME
      marker.userData.brimEarIndex = index
      marker.userData.brimEarLocal = { x: ear.x, y: ear.y, z: ear.z }
      marker.renderOrder = 2
      // The sync helper owns the complete matrix, with each disc flat on the bed.
      marker.matrixAutoUpdate = false
      rotor.add(marker)
    })
    syncBrimEarMarkerMatrices(group)
  }, [])

  /** Rebuild markers for built groups from the current state, including an Undo replacement. */
  const refreshBrimEarMarkers = useCallback(() => {
    for (const [key, group] of groupByKeyRef.current) {
      const instance = activePlateRef.current?.instances.find((entry) => entry.key === key)
      if (!instance) continue
      setGroupBrimEarMarkers(group, effectiveBrimEars(stateRef.current, instance))
    }
  }, [activePlateRef, groupByKeyRef, setGroupBrimEarMarkers, stateRef])

  /** Add at the selected object's bed projection, remove one ordinal, or clear its ears. */
  const editSelectedBrimEars = useCallback((edit: BrimEarEdit) => {
    const state = stateRef.current
    const instance = activePlateRef.current?.instances.find((entry) => entry.key === selectedKeyRef.current)
    const hostId = instance ? addedPartHostId(instance) : null
    if (!state || !instance || hostId == null) return

    recordHistoryRef.current?.()
    const current = effectiveBrimEars(state, instance)
    let next: EditorBrimEar[]
    if (edit.kind === 'add') {
      const rotor = (edit.group.userData.rotor as THREE.Group | undefined) ?? edit.group
      rotor.updateWorldMatrix(true, false)
      // Brim ears are first-layer features, so a side-wall click projects down to the bed.
      const world = edit.worldPoint.clone()
      world.z = -0.0001
      const local = rotor.worldToLocal(world)
      next = [...current, { x: local.x, y: local.y, z: local.z, radius: brimEarDiameterRef.current / 2 }]
    } else if (edit.kind === 'remove') {
      next = current.filter((_, index) => index !== edit.index)
    } else {
      next = []
    }

    if (!state.brimEars) state.brimEars = {}
    state.brimEars[hostId] = next
    refreshBrimEarMarkers()
    regenerateThumbnailRef.current?.()
  }, [activePlateRef, brimEarDiameterRef, recordHistoryRef, refreshBrimEarMarkers,
    regenerateThumbnailRef, selectedKeyRef, stateRef])

  return { setGroupBrimEarMarkers, refreshBrimEarMarkers, editSelectedBrimEars }
}
