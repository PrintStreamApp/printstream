/**
 * Materializes a staged import's body or original solids inside an editor instance rotor.
 * Part identities retain their source indices, even after an in-session deletion. Live
 * state and colour getters preserve the editor's behavior across asynchronous mesh reads.
 */
import { isNonRenderableThreeMfPartSubtype } from '@printstream/shared'
import * as THREE from 'three'
import {
  addedPartHostId,
  bodyPaintHostId,
  bodyPartSubtype,
  effectivePartFilamentId,
  partSlotKey,
  supportPaintKey,
  type EditorInstance,
  type EditorState
} from './editorModel'
import { createThreeMfPartObject } from './threeMfScene'
import type { LayerBandUniforms } from '../editorGeometry'
import { applyEditorMeshLiveState } from './editorMeshLiveState'

interface ImportedInstanceMeshOptions {
  instance: EditorInstance
  rotor: THREE.Group
  placement: THREE.Matrix4
  meshColor: string | null
  meshFilamentId: number | null
  getState: () => EditorState | null
  resolveColorFilamentId: (id: number | null) => number | null
  getFilamentColors: () => Readonly<Record<number, string>> | null
  getLayerBandUniforms: () => LayerBandUniforms
  fetchImportGeometry: (importId: string, partIndex?: number) => Promise<THREE.BufferGeometry>
  seedPaintOverlays: (mesh: THREE.Mesh, paintKey: string, instanceKey: string) => void
}

/** Add visible imported meshes and paint tags, preserving original solid-index identity. */
export async function buildImportedInstanceMeshes({
  instance,
  rotor,
  placement,
  meshColor,
  meshFilamentId,
  getState,
  resolveColorFilamentId,
  getFilamentColors,
  getLayerBandUniforms,
  fetchImportGeometry,
  seedPaintOverlays
}: ImportedInstanceMeshOptions): Promise<void> {
  if (instance.source.kind !== 'import') {
    throw new Error('Imported instance mesh builder requires a staged import.')
  }
  const importId = instance.source.importId
  const importHostId = addedPartHostId(instance)
  // The original solid count controls the branch: a removed solid must not reappear via the
  // merged body mesh when only one survivor remains.
  const removedSolidCount = importHostId != null
    ? getState()?.removedParts?.[importHostId]?.length ?? 0
    : 0

  if (instance.parts.length + removedSolidCount > 1) {
    const partGeometries = await Promise.all(instance.parts.map(async (part) => {
      const replacementId = importHostId != null
        ? getState()?.partMeshReplacements?.[partSlotKey(importHostId, part.partIndex)]
        : undefined
      return {
        part,
        geometry: replacementId
          ? await fetchImportGeometry(replacementId)
          : await fetchImportGeometry(importId, part.partIndex)
      }
    }))

    for (const { part, geometry } of partGeometries) {
      const partFilamentId = resolveColorFilamentId(effectivePartFilamentId(part, instance.filamentId))
      const partColor = (partFilamentId != null && getFilamentColors()?.[partFilamentId]) || part.color || meshColor
      const partGroup = createThreeMfPartObject(geometry, {
        color: partColor,
        clearanceTransform: placement,
        subtype: part.subtype
      })
      // Import solids use their staged index for paint/export, never a baked partRef. The latter
      // addresses a real 3MF object and would write an unsaved import under the wrong identity.
      partGroup.userData.importPartRef = { componentObjectId: part.componentObjectId, partIndex: part.partIndex }
      if (!isNonRenderableThreeMfPartSubtype(part.subtype)) {
        const partMesh = partGroup.children.find((child): child is THREE.Mesh => (child as THREE.Mesh).isMesh === true)
        if (partMesh) {
          const paintHostId = addedPartHostId(instance)
          // The staged import's synthetic host and source component identify this paint until
          // the bake maps it back to (importId, partIndex).
          applyEditorMeshLiveState({
            mesh: partMesh,
            filamentId: partFilamentId,
            fallbackColor: part.color || instance.color,
            layerBandUniforms: getLayerBandUniforms(),
            paint: paintHostId == null ? null : {
              target: { objectId: paintHostId, componentObjectId: part.componentObjectId },
              key: supportPaintKey(paintHostId, part.componentObjectId)
            },
            instanceKey: instance.key,
            seedPaintOverlays
          })
        }
      }
      rotor.add(partGroup)
    }
    return
  }

  // A removed body contributes no geometry; its added volumes are attached separately.
  if (instance.bodyRemoved) return

  const geometry = await fetchImportGeometry(importId)
  // The body's type lives in partTypeChanges before a save promotes it into part zero.
  const bodySubtype = bodyPartSubtype(getState(), instance)
  const importGroup = createThreeMfPartObject(geometry, {
    color: meshColor,
    clearanceTransform: placement,
    subtype: bodySubtype === 'normal_part' ? null : bodySubtype
  })
  const importMesh = importGroup.children.find((child): child is THREE.Mesh => (child as THREE.Mesh).isMesh === true)
  if (importMesh) {
    // A single-solid import has no part rows; its body is paint solid zero.
    const paintHostId = bodyPaintHostId(getState(), instance)
    applyEditorMeshLiveState({
      mesh: importMesh,
      filamentId: meshFilamentId,
      fallbackColor: instance.color,
      layerBandUniforms: getLayerBandUniforms(),
      paint: paintHostId == null ? null : {
        target: { objectId: paintHostId, componentObjectId: 0 },
        key: supportPaintKey(paintHostId, 0)
      },
      instanceKey: instance.key,
      seedPaintOverlays
    })
  }
  rotor.add(importGroup)
}
