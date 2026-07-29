/**
 * Foreign-geometry import: parse STL and tessellate STEP into a plain triangle mesh that the 3MF
 * builder can inject as a new `<object><mesh>` and the editor can render. Output is intentionally
 * minimal — flat `positions` (3 floats/vertex) and `indices` (3 ints/triangle) plus an axis-aligned
 * bounding box — so it maps 1:1 onto 3MF `<vertices>`/`<triangles>` and onto a Three.js geometry.
 * A multi-solid STEP additionally carries its individual named solids as `parts`, so the editor
 * imports it as one object with many parts (rather than collapsing the assembly into one blob).
 *
 * STEP tessellation uses `occt-import-js` (OpenCASCADE compiled to WASM); the ~7 MB module is loaded
 * lazily on first STEP import so STL-only installs never pay for it. The tessellation quality is
 * pinned to BambuStudio's defaults (`STEP_TESSELLATION`) so an imported STEP matches what the same
 * file looks like opened in BambuStudio.
 */
import type { StagedImportFormat } from '@printstream/shared'
import type { OcctTriangulationParams } from 'occt-import-js'

// The mesh SHAPE moved to `@printstream/shared/three-mf` when the bake became dual-surface: the
// writer consumes these types and now runs in both Node and the browser. Producing them stays
// here (STL parse + STEP tessellation via occt WASM). Re-exported so api call sites are unchanged.
import {
  assertImportTriangleBudget,
  computeMeshBounds,
  mergeImportedMeshes,
  parseStlMesh,
  weldImportedMeshVertices,
  type ImportedMesh,
  type ImportedMeshBounds,
  type ImportedMeshPart
} from '@printstream/shared/three-mf'

// STL parsing/welding/merging and the binary-STL writer moved to the shared module when imports
// became dual-surface (the browser parses a file the user picked, with nothing uploaded). Only STEP
// stays here: it needs the OpenCASCADE WASM build. Re-exported so api call sites are unchanged.
export {
  MAX_IMPORT_TRIANGLES,
  assertImportTriangleBudget,
  detectImportFormat,
  meshToBinaryStl,
  parseStlMesh,
  weldImportedMeshVertices
} from '@printstream/shared/three-mf'
export type { ImportedMesh, ImportedMeshBounds, ImportedMeshPart }

/**
 * Parse a staged import by format. STL is shared code; STEP needs the OpenCASCADE WASM build, which
 * is why this dispatcher stays in the api.
 */
export async function parseImportedMesh(buffer: Buffer, format: StagedImportFormat): Promise<ImportedMesh> {
  return format === 'step' ? tessellateStepMesh(buffer) : parseStlMesh(buffer)
}

type OcctInstance = Awaited<ReturnType<typeof import('occt-import-js').default>>
let occtInstancePromise: Promise<OcctInstance> | null = null

/**
 * STEP triangulation quality, matched to BambuStudio's defaults so an imported STEP looks identical
 * to opening the same file in BambuStudio. BambuStudio meshes each STEP solid with
 * `BRepMesh_IncrementalMesh(solid, linear_deflection, isRelative=false, angle_deflection, inParallel=true)`
 * where `load_step` defaults `linear_deflection = 0.003` and `angle_deflection = 0.5` (BambuStudio
 * `src/libslic3r/Format/STEP.{hpp,cpp}`): an ABSOLUTE 0.003 mm chord error and a 0.5 rad angular
 * deflection on a shape expressed in millimetres. occt-import-js loads STEP geometry already scaled
 * to `linearUnit`, so `absolute_value` + `millimeter` applies the chord error in mm exactly as
 * BambuStudio does. Its `null`-params default (a 0.001 bounding-box ratio ≈ 0.03–0.3 mm chord error
 * for typical parts) visibly facets curved surfaces; these values fix that.
 */
export const STEP_TESSELLATION: OcctTriangulationParams = {
  linearUnit: 'millimeter',
  linearDeflectionType: 'absolute_value',
  linearDeflection: 0.003,
  angularDeflection: 0.5
}

/**
 * Tessellate a STEP file via OpenCASCADE (WASM), loaded lazily. OCCT returns one mesh per solid;
 * we keep each as a named {@link ImportedMeshPart} (so a multi-solid assembly imports as one object
 * with many parts, matching BambuStudio) AND a merged mesh (used for bounds, triangle count, and the
 * single-mesh render/bake path). Only when more than one solid is present is `parts` populated.
 */
export async function tessellateStepMesh(buffer: Buffer): Promise<ImportedMesh> {
  const { default: occtimportjs } = await import('occt-import-js')
  if (!occtInstancePromise) occtInstancePromise = occtimportjs()
  const occt = await occtInstancePromise
  const result = occt.ReadStepFile(new Uint8Array(buffer), STEP_TESSELLATION)
  if (!result.success || result.meshes.length === 0) throw new Error('STEP file could not be tessellated')

  // Bound the tessellated output before amplifying it into JS arrays below.
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
function occtMeshToImportedMesh(mesh: { attributes: { position: { array: number[] } }; index: { array: number[] } }): ImportedMesh {
  const positions = [...mesh.attributes.position.array]
  return weldImportedMeshVertices({ positions, indices: [...mesh.index.array], bounds: computeMeshBounds(positions) })
}

/** Concatenate meshes into one (re-basing each mesh's indices), recomputing the combined bounds. */
