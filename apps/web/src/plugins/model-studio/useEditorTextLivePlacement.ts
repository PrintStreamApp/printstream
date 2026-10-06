/**
 * Owns live hosted Text movement for both the transform gizmo and surface pointer. The scene mesh
 * stays mounted while a drag is active; a delayed commit stages its final geometry for saving.
 * EditorView supplies the current scene and text session refs, and useEditorScene drives pointer hits.
 */
import { useCallback, useEffect, useRef } from 'react'
import * as THREE from 'three'
import { rotorOf, type GizmoMode } from './editorGeometry'
import type { EditorState } from './lib/editorModel'
import type { TextToolValue } from './lib/textToolValue'

type TextPlacement = NonNullable<Awaited<ReturnType<typeof import('./lib/textPlacement').buildTextPlacement>>>
type SurfacePoint = { point: THREE.Vector3; normal: THREE.Vector3 }

interface TextLivePlacementOptions {
  modeRef: { current: GizmoMode }
  surfaceMode: TextToolValue['surfaceMode']
  partKeyRef: { current: string | null }
  hostKeyRef: { current: string | null }
  selectedKeyRef: { current: string | null }
  groupByKeyRef: { current: Map<string, THREE.Group> }
  stateRef: { current: EditorState | null }
  pointedRef: { current: SurfacePoint | null }
  settleRef: { current: number | undefined }
  commitRef: { current: (() => Promise<void>) | null }
  buildPlacement: (
    group: THREE.Object3D,
    anchor?: THREE.Vector3 | null,
    normal?: THREE.Vector3 | null
  ) => Promise<TextPlacement | null>
}

/** Update the session part and its mounted mesh without detaching the drag gizmo. */
function showLivePlacement(
  state: EditorState | null,
  partKey: string,
  mesh: THREE.Mesh,
  placement: TextPlacement,
  moveMesh: boolean
): void {
  for (const parts of Object.values(state?.addedParts ?? {})) {
    const part = parts.find((entry) => entry.key === partKey)
    if (!part) continue
    part.soup = placement.soup
    if (moveMesh) {
      part.position.copy(placement.position)
      part.rotation.copy(placement.rotation)
      part.scale.copy(placement.scale)
    }
    break
  }

  if (moveMesh) {
    mesh.position.copy(placement.position)
    mesh.rotation.copy(placement.rotation)
    mesh.scale.copy(placement.scale)
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(placement.soup.slice(), 3))
  geometry.computeVertexNormals()
  mesh.geometry.dispose()
  mesh.geometry = geometry
}

/** Keep live Text responsive and stage only after the final drag frame settles. */
export function useEditorTextLivePlacement(options: TextLivePlacementOptions) {
  const busyRef = useRef(false)
  const grabOffsetRef = useRef<THREE.Vector3 | null>(null)
  const pendingRef = useRef<SurfacePoint | null>(null)
  const mountedRef = useRef(true)
  const placeRef = useRef<(
    point: THREE.Vector3,
    normal: THREE.Vector3,
    phase: 'start' | 'move'
  ) => void>(() => {})

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      pendingRef.current = null
      window.clearTimeout(options.settleRef.current)
    }
  }, [options.settleRef])

  const scheduleCommit = useCallback(() => {
    window.clearTimeout(options.settleRef.current)
    options.settleRef.current = window.setTimeout(() => {
      void options.commitRef.current?.()
    }, 300)
  }, [options.settleRef, options.commitRef])

  const reseatDraggedText = useCallback((object: THREE.Object3D) => {
    if (options.modeRef.current !== 'text' || options.surfaceMode === 'horizontal') return
    const partKey = options.partKeyRef.current
    if (!partKey || object.userData.addedPartKey !== partKey || busyRef.current) return
    const key = options.hostKeyRef.current ?? options.selectedKeyRef.current
    const group = key ? options.groupByKeyRef.current.get(key) : null
    const mesh = object as THREE.Mesh
    if (!group || !mesh.isMesh) return

    busyRef.current = true
    const anchor = mesh.getWorldPosition(new THREE.Vector3())
    void options.buildPlacement(group, anchor)
      .then((placement) => {
        if (!mountedRef.current || !placement || object.userData.addedPartKey !== options.partKeyRef.current) return
        // The gizmo has already moved the mesh. Only its surface-shaped geometry changes here.
        showLivePlacement(options.stateRef.current, partKey, mesh, placement, false)
      })
      .catch((error) => { console.warn('[editor] text re-seat failed', error) })
      .finally(() => {
        busyRef.current = false
        if (mountedRef.current) scheduleCommit()
      })
  }, [options, scheduleCommit])

  const placeTextAt = useCallback((
    point: THREE.Vector3,
    normal: THREE.Vector3,
    phase: 'start' | 'move'
  ) => {
    if (options.modeRef.current !== 'text') return
    const partKey = options.partKeyRef.current
    if (!partKey) return
    // A pending commit would replace the grabbed mesh during this drag.
    window.clearTimeout(options.settleRef.current)
    if (busyRef.current) {
      pendingRef.current = { point: point.clone(), normal: normal.clone() }
      return
    }
    const key = options.hostKeyRef.current ?? options.selectedKeyRef.current
    const group = key ? options.groupByKeyRef.current.get(key) : null
    if (!group) return
    const found: THREE.Mesh[] = []
    rotorOf(group).traverse((node) => {
      if (node.userData.addedPartKey === partKey) found.push(node as THREE.Mesh)
    })
    const mesh = found[0]
    if (!mesh?.isMesh) return

    // Pressing records a world-space grab offset so the text does not jump under the cursor.
    if (phase === 'start') {
      grabOffsetRef.current = mesh.getWorldPosition(new THREE.Vector3()).sub(point)
      return
    }
    const seatPoint = grabOffsetRef.current ? point.clone().add(grabOffsetRef.current) : point
    busyRef.current = true
    options.pointedRef.current = { point: seatPoint.clone(), normal: normal.clone() }
    void options.buildPlacement(group, seatPoint, normal)
      .then((placement) => {
        if (!mountedRef.current || !placement || options.partKeyRef.current !== partKey) return
        showLivePlacement(options.stateRef.current, partKey, mesh, placement, true)
      })
      .catch((error) => { console.warn('[editor] text placement failed', error) })
      .finally(() => {
        busyRef.current = false
        if (!mountedRef.current) return
        const pending = pendingRef.current
        if (pending) {
          pendingRef.current = null
          placeRef.current(pending.point, pending.normal, 'move')
          return
        }
        scheduleCommit()
      })
  }, [options, scheduleCommit])
  placeRef.current = placeTextAt

  return { reseatDraggedText, placeTextAt }
}
