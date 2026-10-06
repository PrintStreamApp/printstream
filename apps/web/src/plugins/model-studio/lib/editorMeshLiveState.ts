/**
 * Applies live material and optional paint state shared by saved, imported, and added meshes.
 * A helper-typed import body retains its live material callback but has no paint target.
 */
import * as THREE from 'three'
import { applyLayerBandOverlays, type LayerBandUniforms } from '../editorGeometry'

type PaintTarget =
  | { objectId: number; componentObjectId: number }
  | { addedPartImportId: string }

interface PrintedMeshOptions {
  mesh: THREE.Mesh
  filamentId: number | null
  fallbackColor: string | null | undefined
  layerBandUniforms: LayerBandUniforms
  paint: { target: PaintTarget; key: string } | null
  instanceKey: string
  seedPaintOverlays: (mesh: THREE.Mesh, paintKey: string, instanceKey: string) => void
}

/** Tag a mesh for live recolouring, layer bands, and its paint store when paintable. */
export function applyEditorMeshLiveState({
  mesh,
  filamentId,
  fallbackColor,
  layerBandUniforms,
  paint,
  instanceKey,
  seedPaintOverlays
}: PrintedMeshOptions): void {
  applyLayerBandOverlays(mesh.material as THREE.Material, layerBandUniforms)
  mesh.userData.recolor = { filamentId, fallbackColor }
  if (paint) {
    mesh.userData.supportPaintPart = paint.target
    seedPaintOverlays(mesh, paint.key, instanceKey)
  }
}
