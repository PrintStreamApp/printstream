/**
 * Lazy loader for the OpenCASCADE (occt-import-js) WASM build.
 *
 * Used from BOTH contexts that tessellate STEP in the browser: the import-staging worker (the normal
 * path) and the main-thread fallback in `localStepImport.ts`. Module state is per-context, so each
 * keeps its own instance, which is what we want: the worker's stays warm across imports, and the
 * fallback only ever loads if a worker was unavailable.
 *
 * Two things this exists to get right, both easy to lose:
 *
 *  - **Nothing here may be reachable from the entry chunk.** The module is ~7 MB of WASM plus its JS
 *    glue, so the package AND the `.wasm` URL are both DYNAMIC imports, resolved on first STEP
 *    import only. A static `?url` import would additionally put the asset on this module's graph,
 *    and the node test runner then fails to load any test that transitively imports it
 *    ("Unknown file extension .wasm").
 *  - **The `.wasm` must be resolved by the bundler.** Vite fingerprints assets, so the URL comes
 *    from `?url` and is handed to Emscripten's `locateFile`; without it the glue asks for
 *    `occt-import-js.wasm` relative to the document and 404s on every deployment.
 */
import { STEP_TESSELLATION, type OcctReadResult } from '@printstream/shared/three-mf'

/** Reads a STEP file at the shared tessellation quality. */
export type OcctStepReader = (bytes: Uint8Array) => OcctReadResult

/**
 * One instance per context, shared by every import.
 *
 * Held as the PROMISE, not the resolved module, so two imports started before the first finished
 * loading share one download instead of instantiating the runtime twice (~7 MB each).
 */
let occtPromise: Promise<OcctStepReader> | null = null

async function instantiate(): Promise<OcctStepReader> {
  const [{ default: occtimportjs }, { default: wasmUrl }] = await Promise.all([
    import('occt-import-js'),
    import('occt-import-js/dist/occt-import-js.wasm?url')
  ])
  const occt = await occtimportjs({ locateFile: () => wasmUrl })
  // Narrowed here rather than in the ambient stub, so the result shape has ONE definition (shared).
  return (bytes) => occt.ReadStepFile(bytes, STEP_TESSELLATION) as OcctReadResult
}

/** Load (or reuse) the tessellator for this context. */
export function loadOcctReader(): Promise<OcctStepReader> {
  if (!occtPromise) {
    // Do not cache a failure: a transient chunk/network error must not make STEP import
    // permanently unavailable for the rest of the session.
    occtPromise = instantiate().catch((error: unknown) => { occtPromise = null; throw error })
  }
  return occtPromise
}
