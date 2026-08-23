/**
 * Turning an OpenCASCADE (occt-import-js) STEP read into a staged-import mesh.
 *
 * The WASM module itself is NOT loaded here: it is ~7 MB and each host loads it differently: the
 * api imports the npm package directly, the web app code-splits it and points it at a bundled
 * `.wasm` asset. What both hosts must agree on is the tessellation QUALITY and how OCCT's per-solid
 * output becomes one import, so those live here and neither surface can drift into producing a
 * different mesh from the same file.
 *
 * Counterparts: `apps/api/src/lib/mesh-import.ts` and
 * `apps/web/src/plugins/model-studio/lib/localStepImport.ts`.
 */
import { assertImportTriangleBudget, computeMeshBounds, mergeImportedMeshes, weldImportedMeshVertices } from './mesh-stl.js'
import type { ImportedMesh, ImportedMeshPart } from './imported-mesh.js'

/**
 * STEP triangulation quality, matched to BambuStudio's defaults so an imported STEP looks identical
 * to opening the same file in BambuStudio. BambuStudio meshes each STEP solid with
 * `BRepMesh_IncrementalMesh(solid, linear_deflection, isRelative=false, angle_deflection, inParallel=true)`
 * where `load_step` defaults `linear_deflection = 0.003` and `angle_deflection = 0.5` (BambuStudio
 * `src/libslic3r/Format/STEP.{hpp,cpp}`): an ABSOLUTE 0.003 mm chord error and a 0.5 rad angular
 * deflection on a shape expressed in millimetres. occt-import-js loads STEP geometry already scaled
 * to `linearUnit`, so `absolute_value` + `millimeter` applies the chord error in mm exactly as
 * BambuStudio does. Its `null`-params default (a 0.001 bounding-box ratio ~ 0.03-0.3 mm chord error
 * for typical parts) visibly facets curved surfaces; these values fix that.
 *
 * Typed structurally rather than as `OcctTriangulationParams` so this module carries no dependency
 * on the occt package, only the hosts that actually load the WASM do.
 */
export const STEP_TESSELLATION: {
  linearUnit: 'millimeter'
  linearDeflectionType: 'absolute_value'
  linearDeflection: number
  angularDeflection: number
} = {
  linearUnit: 'millimeter',
  linearDeflectionType: 'absolute_value',
  linearDeflection: 0.003,
  angularDeflection: 0.5
}

/** The shape of one mesh in an occt-import-js read result. */
export interface OcctResultMesh {
  name?: string
  attributes: { position: { array: number[] | Float32Array } }
  index: { array: number[] | Uint32Array } | null
}

/** The shape of an occt-import-js `ReadStepFile` result. */
export interface OcctReadResult {
  success: boolean
  meshes: OcctResultMesh[]
}

/**
 * Fold an OCCT read into one import. OCCT returns one mesh per solid; each is kept as a named
 * {@link ImportedMeshPart} (so a multi-solid assembly imports as one object with many parts,
 * matching BambuStudio) AND merged (used for bounds, triangle count, and the single-mesh
 * render/bake path). `parts` is populated only when more than one solid is present.
 *
 * @throws {Error} when the read failed or produced no geometry, and when the tessellated output
 *   exceeds the shared import triangle budget: checked BEFORE the arrays are amplified into JS.
 */
export function stepMeshFromOcctResult(result: OcctReadResult): ImportedMesh {
  if (!result.success || result.meshes.length === 0) throw new Error('STEP file could not be tessellated')

  const totalTriangles = result.meshes.reduce((sum, mesh) => sum + Math.floor((mesh.index?.array?.length ?? 0) / 3), 0)
  assertImportTriangleBudget(totalTriangles)

  const parts: ImportedMeshPart[] = result.meshes
    .map((mesh, index) => ({ name: (mesh.name ?? '').trim() || `Part ${index + 1}`, mesh: occtMeshToImportedMesh(mesh) }))
    .filter((part) => part.mesh.indices.length > 0)
  if (parts.length === 0) throw new Error('STEP file produced no geometry')

  const merged = mergeImportedMeshes(parts.map((part) => part.mesh))
  return parts.length > 1 ? { ...merged, parts } : merged
}

/** Convert a single OCCT mesh (positions + index arrays) into an {@link ImportedMesh}. */
function occtMeshToImportedMesh(mesh: OcctResultMesh): ImportedMesh {
  const positions = Array.from(mesh.attributes.position.array)
  const indices = mesh.index ? Array.from(mesh.index.array) : []
  return weldImportedMeshVertices({ positions, indices, bounds: computeMeshBounds(positions) })
}
