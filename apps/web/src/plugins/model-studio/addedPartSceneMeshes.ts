/**
 * Replace the live meshes for session-added 3MF part volumes on one instance.
 * Old meshes and paint overlays are disposed before rebuilding. Printed parts
 * carry live filament colour, layer bands, and paint identity; helper volumes
 * stay translucent and excluded from printed-geometry readers.
 */
import * as THREE from 'three'
import { addedPartPaintKey, effectiveAddedParts, type EditorInstance, type EditorState } from './lib/editorModel.js'
import { helperVolumeSpec } from './lib/helperVolumes.js'
import { disposeObject3D } from './lib/threeMfScene.js'
import { applyEditorMeshLiveState } from './lib/editorMeshLiveState.js'
import { ADDED_PART_MESH_NAME, rotorOf, type LayerBandUniforms } from './editorGeometry.js'

type Options = {
  group: THREE.Group
  instance: EditorInstance
  state: EditorState | null
  resolveColorFilamentId: (id: number | null) => number | null
  filamentColors: Readonly<Record<number, string>> | null
  layerBandUniforms: LayerBandUniforms
  seedPaintOverlays: (mesh: THREE.Mesh, paintKey: string, instanceKey: string) => void
}

/** Dispose and rebuild one instance's added-part meshes from current session state. */
export function replaceAddedPartSceneMeshes({
  group,
  instance,
  state,
  resolveColorFilamentId,
  filamentColors,
  layerBandUniforms,
  seedPaintOverlays
}: Options): void {
  const rotor = rotorOf(group)
  for (const child of rotor.children.filter((entry) => entry.name === ADDED_PART_MESH_NAME)) {
    rotor.remove(child)
    disposeObject3D(child)
  }
  for (const part of effectiveAddedParts(state, instance)) {
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(part.soup.slice(), 3))
    geometry.computeVertexNormals()
    // A normal part IS printed geometry: it renders opaque in its own filament colour and must
    // count toward bed-rest, the selection box, footprints, thumbnails, and STL export. Only the
    // helper volumes are the translucent aids that all of those deliberately skip.
    const helper = helperVolumeSpec(part.subtype)
    const partFilamentId = resolveColorFilamentId(part.filamentId ?? instance.filamentId)
    const liveColor = (partFilamentId != null && filamentColors?.[partFilamentId]) || instance.color
    const mesh = new THREE.Mesh(
      geometry,
      helper
        ? new THREE.MeshStandardMaterial({
          color: helper.color,
          transparent: true,
          opacity: 0.45,
          roughness: 0.5,
          metalness: 0,
          depthWrite: false
        })
        : new THREE.MeshStandardMaterial({ color: liveColor ?? '#D3DDE7', roughness: 0.55, metalness: 0 })
    )
    mesh.name = ADDED_PART_MESH_NAME
    mesh.position.copy(part.position)
    mesh.rotation.copy(part.rotation)
    mesh.scale.copy(part.scale)
    mesh.userData.addedPartKey = part.key
    if (helper) {
      // Aids, not printed geometry: excluded from bed-rest, selection box, footprints.
      mesh.userData.isHelperVolume = true
      mesh.renderOrder = 3
    } else {
      // Follows live swatch edits like every other printed mesh. No part ref: the recolour
      // effect finds none and falls back to the instance's filament, which is the right answer
      // for a part that inherited it, and `refreshAddedPartMeshes` rebuilds on an explicit
      // per-part reassignment anyway.
      // A normal added volume IS printed geometry, so it takes the plate's layer-change colour
      // bands and pause stripes through the shared live-state helper. Without it a filament
      // change at height H recoloured everything on
      // the plate except the volume, which reports the print as doing something it will not.
      // PAINTABLE, like every other printed mesh. This one tag is what the brush needs: the hit
      // test builds its raycast set from it, so an untagged volume was not even a candidate and
      // the brush painted straight THROUGH it onto the body behind (brim ears landed there too).
      // Keyed by the volume's own mesh import, which is what its `importPaint` entry names.
      applyEditorMeshLiveState({
        mesh,
        filamentId: partFilamentId,
        fallbackColor: instance.color ?? undefined,
        layerBandUniforms,
        paint: {
          target: { addedPartImportId: part.importId },
          key: addedPartPaintKey(part.importId)
        },
        instanceKey: instance.key,
        seedPaintOverlays
      })
    }
    rotor.add(mesh)
  }
}
