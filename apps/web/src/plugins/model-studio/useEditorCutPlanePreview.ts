/**
 * Owns the Cut tool's scene plane and its model-derived range, size, and triangle soup.
 * The companion `useEditorCutConnectorOverlay` reads the published plane and soup; neither
 * rebuilds world triangles for each pointer click. Teardown clears those targets before disposal.
 */
import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import * as THREE from 'three'
import { printableMeshBox, type GizmoMode } from './editorGeometry'
import { collectWorldTriangles, grooveDefaultsForSize, type CutAxis, type GrooveCut } from './lib/meshCut'

interface CutPlanePreviewOptions {
  gizmoMode: GizmoMode
  selectedKey: string | null
  cutAxis: CutAxis
  clampedCutOffset: number
  rebuildToken: number
  sceneRef: MutableRefObject<THREE.Scene | null>
  groupByKeyRef: MutableRefObject<Map<string, THREE.Group>>
  cutConnectorTargetsRef: MutableRefObject<{ plane: THREE.Object3D | null }>
  cutPlaneMeshRef: MutableRefObject<THREE.Mesh | null>
  grooveSizedForRef: MutableRefObject<string | null>
  setCutRange: Dispatch<SetStateAction<{ min: number; max: number } | null>>
  setCutOffset: Dispatch<SetStateAction<number>>
  setCutObjectSize: Dispatch<SetStateAction<{ x: number; y: number; z: number } | null>>
  setGroove: Dispatch<SetStateAction<GrooveCut>>
  setCutSoup: Dispatch<SetStateAction<Float32Array | null>>
}

/** Make a translucent world-space plane sized to the selected model's in-plane extent. */
function createCutPlane(box: THREE.Box3, axis: CutAxis): THREE.Mesh {
  const margin = 6
  const size = new THREE.Vector3().subVectors(box.max, box.min)
  let planeWidth: number
  let planeHeight: number
  switch (axis) {
    case 'x':
      planeWidth = size.z + margin * 2
      planeHeight = size.y + margin * 2
      break
    case 'y':
      planeWidth = size.x + margin * 2
      planeHeight = size.z + margin * 2
      break
    case 'z':
      planeWidth = size.x + margin * 2
      planeHeight = size.y + margin * 2
      break
  }
  const geometry = new THREE.PlaneGeometry(planeWidth, planeHeight)
  const plane = new THREE.Mesh(
    geometry,
    new THREE.MeshBasicMaterial({
      color: 0x7fb8ff,
      transparent: true,
      opacity: 0.28,
      side: THREE.DoubleSide,
      depthWrite: false
    })
  )
  if (axis === 'x') plane.rotation.y = Math.PI / 2
  if (axis === 'y') plane.rotation.x = Math.PI / 2
  plane.position.set(
    (box.min.x + box.max.x) / 2,
    (box.min.y + box.max.y) / 2,
    (box.min.z + box.max.z) / 2
  )
  plane.renderOrder = 4
  return plane
}

/** Publish one cut plane and geometry snapshot for the active selected model. */
export function useEditorCutPlanePreview(options: CutPlanePreviewOptions): void {
  const {
    gizmoMode,
    selectedKey,
    cutAxis,
    clampedCutOffset,
    rebuildToken,
    sceneRef,
    groupByKeyRef,
    cutConnectorTargetsRef,
    cutPlaneMeshRef,
    grooveSizedForRef,
    setCutRange,
    setCutOffset,
    setCutObjectSize,
    setGroove,
    setCutSoup
  } = options

  useEffect(() => {
    // Reopening the tool on the same object sizes its groove afresh. Changing axis does not.
    if (gizmoMode !== 'cut' || !selectedKey) {
      setCutRange(null)
      grooveSizedForRef.current = null
      return undefined
    }
    const scene = sceneRef.current
    const group = groupByKeyRef.current.get(selectedKey)
    if (!scene || !group) {
      setCutRange(null)
      return undefined
    }
    const box = printableMeshBox(group)
    if (box.isEmpty()) {
      setCutRange(null)
      return undefined
    }

    const targets = cutConnectorTargetsRef.current
    const size = new THREE.Vector3().subVectors(box.max, box.min)
    setCutRange({ min: box.min[cutAxis], max: box.max[cutAxis] })
    setCutOffset((box.min[cutAxis] + box.max[cutAxis]) / 2)
    setCutObjectSize({ x: size.x, y: size.y, z: size.z })
    if (grooveSizedForRef.current !== selectedKey) {
      grooveSizedForRef.current = selectedKey
      setGroove((current) => ({ ...current, ...grooveDefaultsForSize(size) }))
    }

    const plane = createCutPlane(box, cutAxis)
    scene.add(plane)
    cutPlaneMeshRef.current = plane
    targets.plane = plane
    setCutSoup(collectWorldTriangles(group))
    return () => {
      targets.plane = null
      setCutSoup(null)
      scene.remove(plane)
      plane.geometry.dispose()
      ;(plane.material as THREE.Material).dispose()
      if (cutPlaneMeshRef.current === plane) cutPlaneMeshRef.current = null
    }
  }, [gizmoMode, selectedKey, cutAxis, rebuildToken, sceneRef, groupByKeyRef,
    cutConnectorTargetsRef, cutPlaneMeshRef, grooveSizedForRef, setCutRange,
    setCutOffset, setCutObjectSize, setGroove, setCutSoup])

  useEffect(() => {
    if (cutPlaneMeshRef.current) cutPlaneMeshRef.current.position[cutAxis] = clampedCutOffset
  }, [clampedCutOffset, cutAxis, cutPlaneMeshRef])
}
