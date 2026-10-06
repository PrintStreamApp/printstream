/**
 * Owns the temporary convex-hull picker for Place on Face. The editor keeps
 * scene groups and the current hull ref; switching tools, objects, or rebuilt
 * geometry detaches and disposes the old viewport aid.
 */
import { useEffect, type MutableRefObject } from 'react'
import type * as THREE from 'three'
import { buildFaceHullOverlay, type GizmoMode } from './editorGeometry'
import { disposeObject3D } from './lib/threeMfScene'

interface PlaceOnFaceOverlayOptions {
  mode: GizmoMode
  selectedKey: string | null
  groupsRef: MutableRefObject<Map<string, THREE.Group>>
  faceHullRef: MutableRefObject<THREE.Mesh | null>
  rebuildToken: number
  faceHullToken: number
}

/** Attach a pickable hull only while Place on Face has a built target. */
export function useEditorPlaceOnFaceOverlay({
  mode,
  selectedKey,
  groupsRef,
  faceHullRef,
  rebuildToken,
  faceHullToken
}: PlaceOnFaceOverlayOptions): void {
  useEffect(() => {
    if (mode !== 'layFace' || !selectedKey) return undefined
    const group = groupsRef.current.get(selectedKey)
    if (!group) return undefined
    const hull = buildFaceHullOverlay(group)
    if (!hull) return undefined
    group.add(hull)
    faceHullRef.current = hull

    return () => {
      group.remove(hull)
      // This recurses through the hovered-face fill and outline children too.
      disposeObject3D(hull)
      if (faceHullRef.current === hull) faceHullRef.current = null
    }
  }, [mode, selectedKey, rebuildToken, faceHullToken, groupsRef, faceHullRef])
}
