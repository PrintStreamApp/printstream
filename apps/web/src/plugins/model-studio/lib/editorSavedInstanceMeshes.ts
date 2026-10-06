/**
 * Materializes a saved 3MF object's parts in stable source order for the editor viewport.
 * Geometry reads run concurrently; state and colour getters remain live across those reads.
 * The caller owns the instance group and decides whether an empty result can survive through
 * session-added volumes.
 */
import { isNonRenderableThreeMfPartSubtype } from '@printstream/shared'
import * as THREE from 'three'
import {
  effectivePartFilamentId,
  partSlotKey,
  supportPaintKey,
  type EditorInstance,
  type EditorState
} from './editorModel'
import { createThreeMfMatrix, createThreeMfPartObject } from './threeMfScene'
import type { LayerBandUniforms } from '../editorGeometry'
import { applyEditorMeshLiveState } from './editorMeshLiveState'

interface SavedInstanceMeshOptions {
  instance: EditorInstance
  rotor: THREE.Group
  placement: THREE.Matrix4
  meshColor: string | null
  getState: () => EditorState | null
  resolveColorFilamentId: (id: number | null) => number | null
  getFilamentColors: () => Readonly<Record<number, string>> | null
  getLayerBandUniforms: () => LayerBandUniforms
  fetchGeometry: (entryPath: string) => Promise<Map<number, THREE.BufferGeometry>>
  fetchImportGeometry: (importId: string) => Promise<THREE.BufferGeometry>
  seedPaintOverlays: (mesh: THREE.Mesh, paintKey: string, instanceKey: string) => void
}

/** Add the saved object's visible parts and return how many source parts had geometry. */
export async function buildSavedInstanceMeshes({
  instance,
  rotor,
  placement,
  meshColor,
  getState,
  resolveColorFilamentId,
  getFilamentColors,
  getLayerBandUniforms,
  fetchGeometry,
  fetchImportGeometry,
  seedPaintOverlays
}: SavedInstanceMeshOptions): Promise<number> {
  if (instance.source.kind !== 'object') {
    throw new Error('Saved instance mesh builder requires a project object.')
  }

  // The cache deduplicates shared entries. Promise.all keeps source part order even when
  // replacements or large model entries finish in a different order.
  const partEntries = await Promise.all(instance.parts.map(async (part) => {
    const replacementId = getState()?.partMeshReplacements?.[
      partSlotKey(instance.objectId, part.partIndex)
    ]
    return {
      part,
      geometries: replacementId
        ? new Map([[part.componentObjectId, await fetchImportGeometry(replacementId)]])
        : await fetchGeometry(part.entryPath)
    }
  }))

  let placedParts = 0
  for (const { part, geometries } of partEntries) {
    const geometry = geometries.get(part.componentObjectId)
    if (!geometry) continue
    const partTransform = createThreeMfMatrix(part.transform)
    const partFilamentId = resolveColorFilamentId(effectivePartFilamentId(part, instance.filamentId))
    const partColor = (partFilamentId != null && getFilamentColors()?.[partFilamentId]) || part.color || meshColor
    const partGroup = createThreeMfPartObject(geometry, {
      color: partColor,
      clearanceTransform: placement.clone().multiply(partTransform),
      subtype: part.subtype
    })
    // The gizmo attaches to this part group; children stay part-local, and writeback reads
    // the group's transform together with its child's geometry transform.
    partGroup.applyMatrix4(partTransform)
    partGroup.userData.partRef = { componentObjectId: part.componentObjectId, partIndex: part.partIndex }

    if (!isNonRenderableThreeMfPartSubtype(part.subtype)) {
      const paintableMesh = partGroup.children.find(
        (child): child is THREE.Mesh => (child as THREE.Mesh).isMesh === true
      )
      if (paintableMesh) {
        applyEditorMeshLiveState({
          mesh: paintableMesh,
          filamentId: partFilamentId,
          fallbackColor: part.color || instance.color,
          layerBandUniforms: getLayerBandUniforms(),
          paint: {
            target: { objectId: instance.objectId, componentObjectId: part.componentObjectId },
            key: supportPaintKey(instance.objectId, part.componentObjectId)
          },
          instanceKey: instance.key,
          seedPaintOverlays
        })
      }
    }
    rotor.add(partGroup)
    placedParts += 1
  }
  return placedParts
}
