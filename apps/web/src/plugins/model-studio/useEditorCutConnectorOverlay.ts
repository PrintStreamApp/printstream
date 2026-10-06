/**
 * Owns the Cut tool's connector placement overlay. It clips the selected model to expose the
 * drilled cross-section, mounts a movable connector ghost, and redraws the placed markers.
 * Every material clip and scene object is restored or disposed when the tool or inputs change.
 */
import { useEffect, useMemo, type MutableRefObject } from 'react'
import * as THREE from 'three'
import { disposeObject3D } from './lib/threeMfScene'
import { capSoupForHalf, cutHalfForSide, type CutAxis } from './lib/meshCut'
import {
  connectorBoresForSide,
  connectorSoup,
  connectorVolumes,
  type ConnectorSettings,
  type CutConnector
} from './lib/cutConnectors'
import type { GizmoMode } from './editorGeometry'

interface CutConnectorTargets {
  plane: THREE.Object3D | null
  section: THREE.Object3D | null
  markers: THREE.Object3D[]
}

interface CutConnectorOverlayOptions {
  sceneRef: MutableRefObject<THREE.Scene | null>
  groupByKeyRef: MutableRefObject<Map<string, THREE.Group>>
  selectedKey: string | null
  gizmoMode: GizmoMode
  cutSoup: Float32Array | null
  placingConnectors: boolean
  cutAxis: CutAxis
  clampedCutOffset: number
  cutConnectorFace: 'lower' | 'upper'
  cutConnectors: ReadonlyArray<CutConnector>
  connectorSettings: ConnectorSettings
  activeProblems: ReadonlyMap<string, unknown>
  cutConnectorTargetsRef: MutableRefObject<CutConnectorTargets>
  cutPlaneMeshRef: MutableRefObject<THREE.Mesh | null>
  connectorGhostRef: MutableRefObject<THREE.Mesh | null>
}

/** Clip the selected model to the visible cut half and return its exact material restore. */
function clipSelectedGroup(group: THREE.Group, cutAxis: CutAxis, offset: number, face: 'lower' | 'upper') {
  // The side facing the user stays visible so the eye and pointer can both reach the section.
  const towards = face === 'lower' ? -1 : 1
  const normal = new THREE.Vector3(
    cutAxis === 'x' ? towards : 0,
    cutAxis === 'y' ? towards : 0,
    cutAxis === 'z' ? towards : 0
  )
  const clip = new THREE.Plane(normal, -towards * offset)
  const restore: Array<{ material: THREE.Material; planes: THREE.Plane[] | null }> = []
  group.traverse((node) => {
    const mesh = node as THREE.Mesh
    if (!mesh.isMesh) return
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      restore.push({ material, planes: material.clippingPlanes })
      material.clippingPlanes = [clip]
      material.needsUpdate = true
    }
  })
  return () => {
    for (const entry of restore) {
      entry.material.clippingPlanes = entry.planes
      entry.material.needsUpdate = true
    }
  }
}

/** Build the pointer ghost once in the cut frame; hover moves it without a React render. */
function createConnectorGhost(settings: ConnectorSettings, cutAxis: CutAxis): THREE.Mesh {
  const soup = connectorSoup({ ...settings, id: 'ghost', x: 0, y: 0, z: 0 }, cutAxis, { grown: false })
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(soup, 3))
  geometry.computeVertexNormals()
  geometry.computeBoundingSphere()
  const ghost = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({
    color: 0x9fd0ff,
    emissive: 0x2a4c6e,
    transparent: true,
    opacity: 0.45,
    depthWrite: false,
    roughness: 0.5
  }))
  ghost.visible = false
  ghost.renderOrder = 6
  return ghost
}

/** Build the drilled section, with bounds so a connector click ray can hit it. */
function createCutSection(cap: Float32Array): THREE.Mesh {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(cap, 3))
  geometry.computeVertexNormals()
  geometry.computeBoundingSphere()
  geometry.computeBoundingBox()
  const section = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({
    color: 0x7fb8ff,
    emissive: 0x14304a,
    side: THREE.DoubleSide,
    roughness: 0.6,
    metalness: 0,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2
  }))
  section.renderOrder = 3
  return section
}

/** Draw a placed peg or bore with its removal id and a bounded raycast shape. */
function createConnectorMarker(
  connector: CutConnector,
  cutAxis: CutAxis,
  face: 'lower' | 'upper',
  invalid: boolean
): THREE.Mesh {
  const volumes = connectorVolumes(connector, cutAxis)
  const here = face === 'upper' ? volumes.upper : volumes.lower
  const isBore = here.subtype === 'negative_part'
  const soup = isBore ? here.soup.slice() : connectorSoup(connector, cutAxis, { grown: false })
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(soup, 3))
  geometry.computeVertexNormals()
  geometry.computeBoundingSphere()
  geometry.computeBoundingBox()
  const marker = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({
    // A bore reads as a recess, darker and behind the surface.
    color: invalid ? 0xff4d4d : isBore ? 0x24405c : 0x7fb8ff,
    transparent: true,
    opacity: invalid ? 0.75 : isBore ? 0.85 : 0.55,
    roughness: isBore ? 0.9 : 0.4,
    metalness: 0,
    depthWrite: false
  }))
  marker.userData.connectorId = connector.id
  marker.renderOrder = 5
  return marker
}

/** Mount and release the cut-face and connector markers for the active editor scene. */
export function useEditorCutConnectorOverlay(options: CutConnectorOverlayOptions): void {
  const {
    sceneRef,
    groupByKeyRef,
    selectedKey,
    gizmoMode,
    cutSoup,
    placingConnectors,
    cutAxis,
    clampedCutOffset,
    cutConnectorFace,
    cutConnectors,
    connectorSettings,
    activeProblems,
    cutConnectorTargetsRef,
    cutPlaneMeshRef,
    connectorGhostRef
  } = options

  /**
   * While connectors are being placed, show the CUT FACE: clip the near half of the selected object
   * away and draw the real cross-section in its place.
   *
   * Without this the tool is unusable rather than merely awkward. The cut plane preview is a
   * translucent quad passing through a solid model, so the section it describes is hidden INSIDE the
   * geometry -- a user aiming at it is guessing, and the only way to get a face worth clicking was
   * to perform the cut first, which defeats the point. BambuStudio clips the object at the plane
   * (`ObjectClipper`) for exactly this reason, and this is that.
   *
   * The cap is also what a connector click hits, so a click is EXACT: anything landing on it is
   * inside the cross-section by construction, rather than being projected onto an unbounded plane
   * and validated afterwards.
   *
   * The CUT itself is held across connector edits. It is a full cut of the whole object and depends
   * only on the plane, while the effect below re-runs on every connector placed and every drag of a
   * size slider -- so recomputing it there re-cut a dense model on each React commit and made the
   * sliders unusable. Only the drill and the ghost belong on that path.
   */
  const cutPreviewHalf = useMemo(
    () => (cutSoup && gizmoMode === 'cut' && placingConnectors
      ? cutHalfForSide(cutSoup, cutAxis, clampedCutOffset, cutConnectorFace)
      : null),
    [cutSoup, gizmoMode, placingConnectors, cutAxis, clampedCutOffset, cutConnectorFace]
  )
  useEffect(() => {
    const scene = sceneRef.current
    const group = selectedKey ? groupByKeyRef.current.get(selectedKey) : null
    if (!scene || !group || !cutPreviewHalf) return undefined

    const targets = cutConnectorTargetsRef.current
    // The face as the cut will leave it: the visible half, with its bores already taken out. Showing
    // an undrilled face instead means the preview disagrees with the result, which is the whole
    // reason to show a face at all. Same derivation the cut itself runs, so the two cannot drift.
    const previewBores = connectorBoresForSide(cutConnectors, cutAxis, cutConnectorFace)
      .map((bore) => bore.soup)
    const cap = capSoupForHalf(cutPreviewHalf, cutAxis, clampedCutOffset, cutConnectorFace, previewBores)
    const restoreMaterials = clipSelectedGroup(group, cutAxis, clampedCutOffset, cutConnectorFace)

    // The plane preview and this face occupy the SAME plane, which is what made the face shimmer:
    // two coplanar surfaces with nothing to separate them in the depth buffer. The face replaces the
    // quad while it is up, and the material's polygon offset keeps it clear of the model's own cut
    // face where the clip leaves one.
    const planeQuad = cutPlaneMeshRef.current
    const planeWasVisible = planeQuad?.visible ?? false

    const ghost = createConnectorGhost(connectorSettings, cutAxis)
    scene.add(ghost)
    connectorGhostRef.current = ghost

    let section: THREE.Mesh | null = null
    if (cap.length > 0) {
      if (planeQuad) planeQuad.visible = false
      section = createCutSection(cap)
      scene.add(section)
      targets.section = section
    }
    return () => {
      restoreMaterials()
      if (section) {
        scene.remove(section)
        disposeObject3D(section)
      }
      if (planeQuad) planeQuad.visible = planeWasVisible
      scene.remove(ghost)
      disposeObject3D(ghost)
      connectorGhostRef.current = null
      targets.section = null
    }
  }, [cutPreviewHalf, cutConnectorFace, cutConnectors, connectorSettings, cutAxis,
    clampedCutOffset, selectedKey, connectorGhostRef, cutConnectorTargetsRef,
    cutPlaneMeshRef, groupByKeyRef, sceneRef])

  // Connector markers: one mesh per connector on the SCENE, beside the cut plane, drawn as the peg
  // will actually be made so the size controls mean something before the cut runs. Invalid ones are
  // tinted, matching Studio's own red (`CONNECTOR_ERR_COLOR`).
  useEffect(() => {
    const scene = sceneRef.current
    if (!scene || gizmoMode !== 'cut') return undefined
    const targets = cutConnectorTargetsRef.current
    const markers: THREE.Object3D[] = []
    for (const connector of cutConnectors) {
      const marker = createConnectorMarker(
        connector,
        cutAxis,
        cutConnectorFace,
        activeProblems.has(connector.id)
      )
      scene.add(marker)
      markers.push(marker)
    }
    targets.markers = markers
    // No explicit repaint request: `useEditorScene` already asks for one per React commit.
    return () => {
      targets.markers = []
      for (const marker of markers) {
        scene.remove(marker)
        disposeObject3D(marker)
      }
    }
  }, [cutConnectors, activeProblems, cutAxis, cutConnectorFace, gizmoMode,
    cutConnectorTargetsRef, sceneRef])

}
