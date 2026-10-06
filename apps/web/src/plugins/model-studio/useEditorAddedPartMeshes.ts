/**
 * Owns live session-added part mesh replacement and its invalidation signal.
 * The version covers in-place added-part edits as well as mesh identity changes:
 * the sidebar reads mutable part state, while the gizmo can hold a replaced mesh.
 * EditorView owns the scene and decides when to call refresh or invalidate.
 */
import { useCallback, useRef, useState, type MutableRefObject } from 'react'
import type * as THREE from 'three'
import { replaceAddedPartSceneMeshes } from './addedPartSceneMeshes'
import type { LayerBandUniforms } from './editorGeometry'
import type { EditorInstance, EditorPlate, EditorState } from './lib/editorModel'

interface EditorAddedPartMeshesOptions {
  stateRef: MutableRefObject<EditorState | null>
  groupsRef: MutableRefObject<Map<string, THREE.Group>>
  activePlateRef: MutableRefObject<EditorPlate | null>
  resolveColorFilamentIdRef: MutableRefObject<(id: number | null) => number | null>
  filamentColorsRef: MutableRefObject<Record<number, string> | null>
  layerBandUniformsRef: MutableRefObject<LayerBandUniforms>
  seedPaintOverlays: (mesh: THREE.Mesh, paintKey: string, instanceKey: string) => void
}

/** Return the scene writer, refresh action, and one version signal for added-part changes. */
export function useEditorAddedPartMeshes({
  stateRef,
  groupsRef,
  activePlateRef,
  resolveColorFilamentIdRef,
  filamentColorsRef,
  layerBandUniformsRef,
  seedPaintOverlays
}: EditorAddedPartMeshesOptions) {
  const [version, setVersion] = useState(0)

  const setGroupAddedPartMeshes = useCallback((group: THREE.Group, instance: EditorInstance) => {
    replaceAddedPartSceneMeshes({
      group,
      instance,
      state: stateRef.current,
      resolveColorFilamentId: resolveColorFilamentIdRef.current,
      filamentColors: filamentColorsRef.current,
      layerBandUniforms: layerBandUniformsRef.current,
      seedPaintOverlays
    })
  }, [stateRef, resolveColorFilamentIdRef, filamentColorsRef, layerBandUniformsRef, seedPaintOverlays])
  const setGroupAddedPartMeshesRef = useRef(setGroupAddedPartMeshes)
  setGroupAddedPartMeshesRef.current = setGroupAddedPartMeshes

  /** Rebuild the active plate's parts, then publish one change for both gizmo and sidebar. */
  const refreshAddedPartMeshes = useCallback(() => {
    for (const [key, group] of groupsRef.current) {
      const instance = activePlateRef.current?.instances.find((entry) => entry.key === key)
      if (instance) setGroupAddedPartMeshes(group, instance)
    }
    setVersion((current) => current + 1)
  }, [groupsRef, activePlateRef, setGroupAddedPartMeshes])
  const refreshAddedPartMeshesRef = useRef(refreshAddedPartMeshes)
  refreshAddedPartMeshesRef.current = refreshAddedPartMeshes

  return {
    addedPartMeshVersion: version,
    setAddedPartMeshVersion: setVersion,
    setGroupAddedPartMeshesRef,
    refreshAddedPartMeshes,
    refreshAddedPartMeshesRef
  }
}
