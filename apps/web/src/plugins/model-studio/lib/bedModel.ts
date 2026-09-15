/**
 * The optional 3D build-plate render (BambuStudio's modelled bed) for the editor viewport.
 *
 * The mesh is fetched from the slicer's bundled BambuStudio resources through the API
 * (`GET /api/slicing/bed-model`) rather than shipped in this bundle: see
 * `apps/slicer/src/bed-model.ts` for why. On by default, switchable per device from the editor
 * settings dialog; printers with no bundled mesh fall back to the plain millimetre grid.
 *
 * Rendering notes:
 * - The meshes are authored IN BED COORDINATES: mesh (0,0) is the printable area's origin and the
 *   top face sits at z = 0 (verified across the X1/A1M/H2D beds). So the mesh is translated to the
 *   printable area's origin, never centred and never scaled. Centring is actively wrong: every
 *   bed extends further in -Y for the front handle (H2D: -18.5 vs +8), so centring skews it (5.25mm
 *   on the H2D) and the plate stops lining up with the print area the way BambuStudio shows it.
 * - The plate fades out as the camera drops below it, so looking up from underneath still shows
 *   the models: the plain grid is see-through by nature and a solid plate is not. This rides on
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

/** Lowest opacity when fully below: kept non-zero so the plate still reads as present. */
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
  /** Selected workspace preset, so its portable custom model can outrank bundled resources. */
  machineProfileId?: string | null
  signal?: AbortSignal
  /**
   * Endpoint to fetch the bed mesh from. Defaults to the workspace route; the public 3MF editor passes
   * the anonymous catalogue route (`/api/public/slicing/bed-model`), which needs no workspace.
   */
  basePath?: string
}): Promise<THREE.BufferGeometry | null> {
  const params = new URLSearchParams({ printerModel: input.printerModel })
  if (input.slicerTargetId) params.set('targetId', input.slicerTargetId)
  if (input.machineProfileId) params.set('machineProfileId', input.machineProfileId)
  const bytes = await fetchModelBytes(buildApiUrl(`${input.basePath ?? '/api/slicing/bed-model'}?${params.toString()}`), { signal: input.signal })
    .catch(() => null)
  if (!bytes || bytes.byteLength === 0) return null
  try {
    // fetchModelBytes yields a Uint8Array that may view a larger buffer; copy to an exact one.
    const geometry = new STLLoader().parse(new Uint8Array(bytes).buffer)
    // The renderer frees the CPU-side arrays after upload, which requires bounds to already be
    // computed: see the three onUpload invariant in apps/web/the development notes's sibling notes.
    geometry.computeBoundingBox()
    geometry.computeBoundingSphere()
    return geometry
  } catch {
    return null
  }
}

/** Load the selected custom preset's optional PNG/SVG bed texture. */
export async function loadBedTexture(input: {
  machineProfileId: string | null
  signal?: AbortSignal
}): Promise<THREE.Texture | null> {
  if (!input.machineProfileId) return null
  const params = new URLSearchParams({ machineProfileId: input.machineProfileId })
  try {
    const response = await fetch(buildApiUrl(`/api/slicing/bed-texture?${params.toString()}`), {
      credentials: 'include',
      signal: input.signal
    })
    if (!response.ok) return null
    const objectUrl = URL.createObjectURL(await response.blob())
    try {
      const texture = await new THREE.TextureLoader().loadAsync(objectUrl)
      texture.colorSpace = THREE.SRGBColorSpace
      texture.needsUpdate = true
      return texture
    } finally {
      URL.revokeObjectURL(objectUrl)
    }
  } catch {
    return null
  }
}

/**
 * Build the optional bed mesh and texture at the printable area's origin. The texture covers the
 * printable rectangle while a model may extend around it for handles or the printer frame.
 */
export function createBedModelObject(input: {
  geometry?: THREE.BufferGeometry | null
  texture?: THREE.Texture | null
  /** Scene X of the printable area's origin (its minimum corner), which mesh x=0 maps onto. */
  originX: number
  /** Scene Y of the printable area's origin. */
  originY: number
  /** Printable dimensions used to place a custom texture over the build surface. */
  width?: number
  depth?: number
}): THREE.Object3D {
  const group = new THREE.Group()
  group.name = BED_MODEL_OBJECT_NAME

  const fadeWithCamera = (mesh: THREE.Mesh, material: THREE.Material & { opacity: number; depthWrite: boolean }) => {
    mesh.onBeforeRender = (_renderer, _scene, camera) => {
      const opacity = bedOpacityForCameraHeight(camera.position.z - mesh.getWorldPosition(WORLD_POSITION).z)
      if (material.opacity !== opacity) {
        material.opacity = opacity
        // While see-through it must not occlude the models above it, which is the whole point.
        material.depthWrite = opacity >= 1
        material.needsUpdate = true
      }
    }
  }

  if (input.geometry) {
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
    const topZ = input.geometry.boundingBox?.max.z ?? 0
    mesh.position.set(input.originX, input.originY, -topZ)
    mesh.receiveShadow = true
    mesh.renderOrder = -1
    fadeWithCamera(mesh, material)
    group.add(mesh)
  }

  if (input.texture && input.width && input.depth) {
    const material = new THREE.MeshBasicMaterial({
      map: input.texture.clone(),
      transparent: true,
      opacity: 1,
      side: THREE.DoubleSide
    })
    const surface = new THREE.Mesh(new THREE.PlaneGeometry(input.width, input.depth), material)
    surface.position.set(input.originX + input.width / 2, input.originY + input.depth / 2, 0.02)
    surface.renderOrder = -0.5
    fadeWithCamera(surface, material)
    group.add(surface)
  }

  return group
}

/** Release the bed mesh's GPU resources; call when the bed is replaced or the scene torn down. */
export function disposeBedModelObject(bed: THREE.Object3D | null): void {
  if (!bed) return
  bed.traverse((child) => {
    const mesh = child as THREE.Mesh
    mesh.geometry?.dispose()
    const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : []
    for (const material of materials) {
      for (const value of Object.values(material as unknown as Record<string, unknown>)) {
        if (value && (value as THREE.Texture).isTexture) (value as THREE.Texture).dispose()
      }
      material.dispose()
    }
  })
}
