/**
 * Foreign-geometry import: parse STL and tessellate STEP into a plain triangle mesh that the 3MF
 * builder can inject as a new `<object><mesh>` and the editor can render. Output is intentionally
 * minimal — flat `positions` (3 floats/vertex) and `indices` (3 ints/triangle) plus an axis-aligned
 * bounding box — so it maps 1:1 onto 3MF `<vertices>`/`<triangles>` and onto a Three.js geometry.
 * A multi-solid STEP additionally carries its individual named solids as `parts`, so the editor
 * imports it as one object with many parts (rather than collapsing the assembly into one blob).
 *
 * STEP tessellation uses `occt-import-js` (OpenCASCADE compiled to WASM); the ~7 MB module is loaded
 * lazily on first STEP import so STL-only installs never pay for it. LOADING it is all this module
 * still owns for STEP: the quality settings (`STEP_TESSELLATION`, pinned to BambuStudio's defaults
 * so an import matches what the same file looks like in BambuStudio) and the per-solid fold are
 * shared with the browser host — see `@printstream/shared/three-mf` `step-mesh.ts`.
 */
import type { StagedImportFormat } from '@printstream/shared'

import {
  STEP_TESSELLATION,
  parseStlMesh,
  stepMeshFromOcctResult,
  type ImportedMesh,
  type ImportedMeshBounds,
  type ImportedMeshPart,
  type OcctReadResult
} from '@printstream/shared/three-mf'

// STL parsing/welding/merging, the binary-STL writer, and the STEP tessellation QUALITY + fold all
// live in the shared module: both hosts import geometry, and only the WASM LOADING differs.
// Re-exported so api call sites keep one import path.
export {
  MAX_IMPORT_TRIANGLES,
  STEP_TESSELLATION,
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
 * Tessellate a STEP file via OpenCASCADE (WASM), loaded lazily so STL-only installs never pay for
 * the ~7 MB module. Loading is all this owns: the tessellation QUALITY and how OCCT's per-solid
 * output folds into one import are shared with the browser host (`step-mesh.ts`), so the same file
 * imports identically whether it was uploaded or opened in the public editor.
 */
export async function tessellateStepMesh(buffer: Buffer): Promise<ImportedMesh> {
  const { default: occtimportjs } = await import('occt-import-js')
  if (!occtInstancePromise) occtInstancePromise = occtimportjs()
  const occt = await occtInstancePromise
  return stepMeshFromOcctResult(occt.ReadStepFile(new Uint8Array(buffer), STEP_TESSELLATION) as OcctReadResult)
}

