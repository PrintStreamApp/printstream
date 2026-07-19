/**
 * The optional 3D build-plate render (BambuStudio's modelled bed) for the editor viewport.
 *
 * The mesh is fetched from the slicer's bundled BambuStudio resources through the API
 * (`GET /api/slicing/bed-model`) rather than shipped in this bundle — see
 * `apps/slicer/src/bed-model.ts` for why. On by default, switchable per device from the editor
 * settings dialog; printers with no bundled mesh fall back to the plain millimetre grid.
 *
 * Rendering notes:
 * - The meshes are authored IN BED COORDINATES: mesh (0,0) is the printable area's origin and the
 *   top face sits at z = 0 (verified across the X1/A1M/H2D beds). So the mesh is translated to the
 *   printable area's origin — never centred and never scaled. Centring is actively wrong: every
 *   bed extends further in -Y for the front handle (H2D: -18.5 vs +8), so centring skews it (5.25mm
 *   on the H2D) and the plate stops lining up with the print area the way BambuStudio shows it.
 * - The plate fades out as the camera drops below it, so looking up from underneath still shows
 *   the models — the plain grid is see-through by nature and a solid plate is not. This rides on
 *   three's per-mesh `onBeforeRender` (which receives the camera) rather than a hook in the
 *   editor's animate loop, so the behaviour stays self-contained here and costs nothing per frame
 *   for anyone not rendering a plate.
 */
import * as THREE from 'three'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import { buildApiUrl } from '../../../lib/apiUrl'
import { fetchModelBytes } from './modelFetch'

/** Scratch vector for the per-frame world-position read; avoids allocating each draw. */
const WORLD_POSITION = new THREE.Vector3()

/** Height (mm) below the plate over which it fades from opaque to nearly clear. */
const BED_FADE_DEPTH_MM = 40

/** Lowest opacity when fully below — kept non-zero so the plate still reads as present. */
const BED_MIN_OPACITY = 0.12

/**
 * Plate opacity for a camera `height` mm above its top face: fully opaque at or above the
 * plate, ramping to {@link BED_MIN_OPACITY} once the camera is {@link BED_FADE_DEPTH_MM} below.
 * Exported for tests.
 */
export function bedOpacityForCameraHeight(height: number): number {
  if (height >= 0) return 1
  const faded = 1 + height / BED_FADE_DEPTH_MM
  return Math.min(1, Math.max(BED_MIN_OPACITY, faded))
}

/** Marks the bed mesh so scene teardown/lookup can find it without a name collision. */
export const BED_MODEL_OBJECT_NAME = 'printstreamBedModel'

/**
 * Fetch + parse the bed mesh for a printer model. Returns null when this printer has no
 * bundled bed (a 404 from the API is the normal "not available" answer, not an error), so the
 * caller simply keeps the grid.
 */
export async function loadBedModelGeometry(input: {
  printerModel: string
  slicerTargetId: string | null
  signal?: AbortSignal
}): Promise<THREE.BufferGeometry | null> {
  const params = new URLSearchParams({ printerModel: input.printerModel })
  if (input.slicerTargetId) params.set('targetId', input.slicerTargetId)
  const bytes = await fetchModelBytes(buildApiUrl(`/api/slicing/bed-model?${params.toString()}`), { signal: input.signal })
    .catch(() => null)
  if (!bytes || bytes.byteLength === 0) return null
  try {
    // fetchModelBytes yields a Uint8Array that may view a larger buffer; copy to an exact one.
    const geometry = new STLLoader().parse(new Uint8Array(bytes).buffer)
    // The renderer frees the CPU-side arrays after upload, which requires bounds to already be
    // computed — see the three onUpload invariant in apps/web/the development notes's sibling notes.
    geometry.computeBoundingBox()
    geometry.computeBoundingSphere()
    return geometry
  } catch {
    return null
  }
}

/**
 * Build the bed object from a parsed geometry, positioned for a plate of `width` x `depth`
 * centred on (`centerX`, `centerY`). Materials are semi-matte so the plate reads as a surface
 * without competing with the models; `renderOrder`/`depthWrite` keep the grid drawn on top.
 */
export function createBedModelObject(input: {
  geometry: THREE.BufferGeometry
  /** Scene X of the printable area's origin (its minimum corner), which mesh x=0 maps onto. */
  originX: number
  /** Scene Y of the printable area's origin. */
  originY: number
}): THREE.Object3D {
  const material = new THREE.MeshStandardMaterial({
    color: 0x2a3242,
    roughness: 0.85,
    metalness: 0.1,
    transparent: true,
    opacity: 1
  })
  // Clone: the caller caches one parsed geometry across rebuilds, and each bed group is
  // disposed wholesale when the plate is rebuilt.
  const mesh = new THREE.Mesh(input.geometry.clone(), material)
  mesh.name = BED_MODEL_OBJECT_NAME
  // Straight translation to the printable origin — the mesh's own coordinates place the plate
  // (and its overhanging frame/handle) correctly around it. `-max.z` keeps the top face flush
  // with the model plane for any bed authored above z=0.
  const topZ = input.geometry.boundingBox?.max.z ?? 0
  mesh.position.set(input.originX, input.originY, -topZ)
  mesh.receiveShadow = true
  // Drawn before the grid/models so the grid lines stay legible on the plate surface.
  mesh.renderOrder = -1
  // Fade with the camera's height above the plate. Called just before this mesh draws, so it
  // costs nothing when no plate is rendered and needs no per-frame scene traversal.
  mesh.onBeforeRender = (_renderer, _scene, camera) => {
    const opacity = bedOpacityForCameraHeight(camera.position.z - mesh.getWorldPosition(WORLD_POSITION).z)
    if (material.opacity !== opacity) {
      material.opacity = opacity
      // While see-through it must not occlude the models above it, which is the whole point.
      material.depthWrite = opacity >= 1
      material.needsUpdate = true
    }
  }
  return mesh
}

/** Release the bed mesh's GPU resources; call when the bed is replaced or the scene torn down. */
export function disposeBedModelObject(bed: THREE.Object3D | null): void {
  if (!bed) return
  const mesh = bed as THREE.Mesh
  mesh.geometry?.dispose()
  const material = mesh.material
  if (Array.isArray(material)) material.forEach((entry) => entry.dispose())
  else material?.dispose()
}
