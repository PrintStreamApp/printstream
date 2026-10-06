/**
 * Keeps the active plate's prime tower present and sized to current printable geometry.
 * The active plate builder uses the same live refs while staging a new plate, and the mounted
 * scene is swept before insertion so an overlapping asynchronous build leaves no duplicate.
 */
import { useCallback, useEffect, type MutableRefObject } from 'react'
import * as THREE from 'three'
import { createPrimeTowerObject, removePrimeTowers } from './editorGeometry'
import type { EditorState } from './lib/editorModel'
import { computeEditorPrimeTowerHeight, shouldShowEditorPrimeTower } from './lib/editorPrimeTowerHeight'

interface PrimeTowerSyncOptions {
  state: EditorState | null
  stateRef: MutableRefObject<EditorState | null>
  activePlateIndex: number
  projectFilamentCount: number
  bakedPlates?: ReadonlyArray<{ index: number; filaments: ReadonlyArray<{ id: number }> }>
  sceneReady: boolean
  rebuildToken: number
  plateRootRef: MutableRefObject<THREE.Group | null>
  groupByKeyRef: MutableRefObject<Map<string, THREE.Group>>
  primeTowerObjRef: MutableRefObject<THREE.Object3D | null>
  towerRequiredRef: MutableRefObject<boolean>
  projectFilamentCountRef: MutableRefObject<number>
  computePrimeTowerHeightRef: MutableRefObject<(groups: Map<string, THREE.Group>, plateIndex: number) => number>
}

/** Update the builder's live inputs and keep the mounted tower in step with material edits. */
export function useEditorPrimeTowerSync(options: PrimeTowerSyncOptions): void {
  const {
    state,
    stateRef,
    activePlateIndex,
    projectFilamentCount,
    bakedPlates,
    sceneReady,
    rebuildToken,
    plateRootRef,
    groupByKeyRef,
    primeTowerObjRef,
    towerRequiredRef,
    projectFilamentCountRef,
    computePrimeTowerHeightRef
  } = options

  const activeTower = state?.plates.find((plate) => plate.index === activePlateIndex)?.primeTower ?? null
  const towerRequired = shouldShowEditorPrimeTower(activeTower, projectFilamentCount)
  towerRequiredRef.current = towerRequired
  projectFilamentCountRef.current = projectFilamentCount

  const computePrimeTowerHeight = useCallback((groups: Map<string, THREE.Group>, plateIndex: number): number => {
    return computeEditorPrimeTowerHeight(stateRef.current, groups, plateIndex, bakedPlates)
  }, [stateRef, bakedPlates])
  computePrimeTowerHeightRef.current = computePrimeTowerHeight

  useEffect(() => {
    const plateRoot = plateRootRef.current
    if (!plateRoot || !sceneReady) return

    // Material edits skip a full plate rebuild, so the tower must be updated in place.
    // Sweep every tower because the asynchronous builder can also add one.
    removePrimeTowers(plateRoot)
    primeTowerObjRef.current = null
    if (!activeTower || !towerRequired) return

    const printHeight = computePrimeTowerHeight(groupByKeyRef.current, activePlateIndex)
    const tower = createPrimeTowerObject(activeTower, projectFilamentCount, printHeight || 30)
    plateRoot.add(tower)
    primeTowerObjRef.current = tower
  }, [activeTower, towerRequired, projectFilamentCount, computePrimeTowerHeight, activePlateIndex, sceneReady, rebuildToken,
    plateRootRef, groupByKeyRef, primeTowerObjRef])
}
