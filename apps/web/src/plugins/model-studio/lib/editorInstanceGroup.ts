/**
 * Builds one editor instance group around the saved-project and staged-import mesh builders.
 * The group owns placement, empty-object disposal, and the two session overlays. Live getters
 * preserve material and state reads without rebuilding geometry after every swatch change.
 */
import * as THREE from 'three'
import {
  effectiveAddedParts,
  effectiveBrimEars,
  type EditorBrimEar,
  type EditorInstance,
  type EditorState
} from './editorModel'
import { createThreeMfMatrix, disposeObject3D } from './threeMfScene'
import type { LayerBandUniforms } from '../editorGeometry'
import { buildImportedInstanceMeshes } from './editorImportedInstanceMeshes'
import { buildSavedInstanceMeshes } from './editorSavedInstanceMeshes'

interface InstanceGroupBuilderOptions {
  getState: () => EditorState | null
  resolveColorFilamentId: (id: number | null) => number | null
  getFilamentColors: () => Readonly<Record<number, string>> | null
  getLayerBandUniforms: () => LayerBandUniforms
  fetchGeometry: (entryPath: string) => Promise<Map<number, THREE.BufferGeometry>>
  fetchImportGeometry: (importId: string, partIndex?: number) => Promise<THREE.BufferGeometry>
  seedPaintOverlays: (mesh: THREE.Mesh, paintKey: string, instanceKey: string) => void
  addBrimEarMarkers: (group: THREE.Group, ears: EditorBrimEar[]) => void
  addSessionPartMeshes: (group: THREE.Group, instance: EditorInstance) => void
}

/**
 * Return an async group builder. A saved object with no source or session-added geometry
 * returns null after disposing its empty group; a staged import may have a removed body.
 */
export function createEditorInstanceGroupBuilder(options: InstanceGroupBuilderOptions) {
  const {
    getState,
    resolveColorFilamentId,
    getFilamentColors,
    getLayerBandUniforms,
    fetchGeometry,
    fetchImportGeometry,
    seedPaintOverlays,
    addBrimEarMarkers,
    addSessionPartMeshes
  } = options

  return async (instance: EditorInstance): Promise<THREE.Group | null> => {
    const group = new THREE.Group()
    group.userData.instanceKey = instance.key
    // Rotation belongs inside the outer scale so gizmo scaling follows bed axes.
    const rotor = new THREE.Group()
    group.add(rotor)
    group.userData.rotor = rotor

    const meshFilamentId = resolveColorFilamentId(instance.filamentId)
    const meshColor = (meshFilamentId != null && getFilamentColors()?.[meshFilamentId]) || instance.color
    // The part builders need the complete world transform to choose bed clearance materials.
    const placement = instance.exactMatrix
      ? createThreeMfMatrix(instance.exactMatrix)
      : new THREE.Matrix4().compose(
        instance.position,
        new THREE.Quaternion().setFromEuler(instance.rotation),
        instance.scale
      )

    if (instance.source.kind === 'import') {
      await buildImportedInstanceMeshes({
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
      })
    } else {
      const placedParts = await buildSavedInstanceMeshes({
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
      })
      // Session-added volumes can be an object's only geometry. A helper-only object must
      // remain visible so the user can fix it, even though it has no printed part.
      if (placedParts === 0 && effectiveAddedParts(getState(), instance).length === 0) {
        disposeObject3D(group)
        return null
      }
    }

    if (instance.exactMatrix) {
      // A shearing foreign matrix cannot be reconstructed from editable T * R * S. The first
      // transform edit deliberately bakes it to TRS in the editor session.
      group.matrixAutoUpdate = false
      group.matrix.copy(placement)
      group.matrixWorldNeedsUpdate = true
    } else {
      group.matrixAutoUpdate = true
      group.position.copy(instance.position)
      group.scale.copy(instance.scale)
      rotor.rotation.copy(instance.rotation)
    }

    addBrimEarMarkers(group, effectiveBrimEars(getState(), instance))
    addSessionPartMeshes(group, instance)
    return group
  }
}
