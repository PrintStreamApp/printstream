/**
 * Foreign-geometry import: turn every model format the editor stages into a plain triangle mesh that
 * the 3MF builder can inject as a new `<object><mesh>` and the editor can render. Output is
 * intentionally minimal, flat `positions` (3 floats/vertex) and `indices` (3 ints/triangle) plus an
 * axis-aligned bounding box, so it maps 1:1 onto 3MF `<vertices>`/`<triangles>` and onto a Three.js
 * geometry. A source holding several solids (a STEP assembly, an AMF's volumes, a glTF scene's
 * meshes) additionally carries them as `parts`, so the editor imports it as one object with many
 * parts rather than collapsing the assembly into one blob.
 *
 * WHAT THIS MODULE STILL OWNS is only what cannot be shared: the per-host LOADING. Every geometry
 * conversion lives in `@printstream/shared/three-mf`, because the browser runs the same work for
 * the public editor, where nothing is uploaded, and a file must not import differently depending
 * on which host opened it. Four things are host-shaped:
 *
 *  - STEP needs `occt-import-js` (OpenCASCADE compiled to WASM), loaded lazily on first STEP import
 *    so installs that never open one do not pay the ~7 MB. The quality settings
 *    (`STEP_TESSELLATION`, pinned to BambuStudio's defaults) and the per-solid fold are shared.
 *  - A zipped AMF needs a ZIP layer, which the shared package deliberately has none of; the api
 *    unzips with yauzl and the browser with fflate, exactly as they already do either side of
 *    `mesh-extract.ts`.
 *  - FBX needs Three.js's maintained format loader. Each host loads it lazily, then hands the
 *    structural scene to the shared converter for transforms, units, validation, and part folding.
 *  - PNG/JPEG texture bytes are decoded with host-native codecs, then handed to the shared sampler
 *    as plain RGBA pixels.
 */
import yauzl, { type Entry } from 'yauzl'

import type { StagedImportFormat } from '@printstream/shared'
import { parseFbxMesh } from './fbx-import.js'
import { decodeTextureImage } from './texture-image.js'

import {
  MAX_AMF_SOURCE_BYTES,
  ModelImportError,
  STEP_TESSELLATION,
  decodeGltfTextureImages,
  isZippedAmf,
  parseAmfMesh,
  parseGltfMesh,
  parseObjMesh,
  parseStlMesh,
  resolveObjMaterials,
  stepMeshFromOcctResult,
  type ImportedMesh,
  type ImportedMeshBounds,
  type ImportedMeshPart,
  type OcctReadResult
} from '@printstream/shared/three-mf'

// Every geometry conversion, the welding/merging, the binary-STL writer, and the STEP tessellation
// QUALITY + fold live in the shared module: both hosts import geometry, and only loading differs.
// Re-exported so api call sites keep one import path.
export {
  MAX_IMPORT_TRIANGLES,
  MAX_AMF_SOURCE_BYTES,
  STEP_TESSELLATION,
  assertImportTriangleBudget,
  meshToBinaryStl,
  parseStlMesh,
  weldImportedMeshVertices
} from '@printstream/shared/three-mf'
// `detectImportFormat` sits in the main barrel rather than the 3MF one: it is the format CATALOGUE
// (see `import-formats.ts`), which the web's file pickers and capability lists derive from too, and
// which has nothing to do with 3MF parsing.
export { describeImportFormats, detectImportFormat } from '@printstream/shared'
export type { ImportedMesh, ImportedMeshBounds, ImportedMeshPart }

/**
 * Parse a staged import by format.
 *
 * Exhaustive over `StagedImportFormat` by construction: the switch has no `default`, so adding a
 * format to the shared table without teaching this dispatcher about it fails the typecheck rather
 * than shipping a format the file picker offers and the upload then refuses.
 *
 * `3mf` is absent deliberately -- it is object-aware (the caller may name which object to extract)
 * and so is dispatched by the routes through `three-mf-mesh-extract.ts` instead.
 */
export async function parseImportedMesh(
  buffer: Buffer,
  format: Exclude<StagedImportFormat, '3mf'>,
  companions: ReadonlyArray<{ name: string; bytes: Uint8Array }> = [],
  options: { sourceAppearance?: boolean } = {}
): Promise<ImportedMesh> {
  switch (format) {
    case 'stl': return parseStlMesh(buffer)
    case 'step': return tessellateStepMesh(buffer)
    case 'obj': {
      return parseObjMesh(buffer, { materials: await resolveObjMaterials(buffer, companions, decodeTextureImage) })
    }
    case 'gltf': return options.sourceAppearance === false
      ? parseGltfMesh(buffer)
      : parseGltfMesh(buffer, { decodedImages: await decodeGltfTextureImages(buffer, decodeTextureImage) })
    case 'fbx': return parseFbxMesh(buffer, options)
    case 'amf': {
      if (!isZippedAmf(buffer) && buffer.byteLength > MAX_AMF_SOURCE_BYTES) {
        throw new ModelImportError('AMF is too large to import')
      }
      return parseAmfMesh(isZippedAmf(buffer) ? await readZippedAmf(buffer) : buffer.toString('utf8'))
    }
  }
}

/**
 * Largest AMF document to read out of an archive. The uncompressed size is DECLARED by the archive
 * rather than measured, so an unbounded read here is a zip bomb: a few KB of input expanding until
 * the process dies, reachable by any authenticated user through `/imports`.
 */
/**
 * The XML document inside a zipped AMF.
 *
 * Prefers an entry named `*.amf`, falling back to the first non-directory entry. The browser's
 * counterpart (`localAmfImport.ts`, fflate) applies the SAME preference deliberately: an archive
 * carrying the document beside a resource file must not resolve to different entries on the two
 * hosts, or the same file imports as different geometry depending on where it was opened.
 *
 * ONE pass. yauzl streams entries and the preferred one may come last, so the walk RETAINS the best
 * candidate seen so far and reads it at `end`, rather than opening the archive a second time to go
 * and fetch it. The two-pass version needed two copies of this promise plumbing, which is two places
 * for the error handling to drift.
 */
function readZippedAmf(buffer: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (openError, zipFile) => {
      if (openError || !zipFile) {
        reject(openError ?? new ModelImportError('AMF archive could not be read'))
        return
      }
      let settled = false
      let chosen: Entry | null = null
      const finish = (error: Error | null, value?: string) => {
        if (settled) return
        settled = true
        zipFile.close()
        if (error || value == null) reject(error ?? new ModelImportError('AMF archive contained no document'))
        else resolve(value)
      }
      const fail = (error: unknown) =>
        finish(error instanceof Error ? error : new ModelImportError('AMF archive could not be read'))

      zipFile.on('error', fail)
      zipFile.on('entry', (entry: Entry) => {
        // Prefer a `*.amf`; otherwise keep the first ordinary entry as the fallback.
        if (!entry.fileName.endsWith('/')) {
          const preferred = entry.fileName.toLowerCase().endsWith('.amf')
          const chosenIsPreferred = chosen?.fileName.toLowerCase().endsWith('.amf') ?? false
          if (chosen == null || (preferred && !chosenIsPreferred)) chosen = entry
        }
        zipFile.readEntry()
      })
      zipFile.on('end', () => {
        if (!chosen) {
          finish(new ModelImportError('AMF archive contained no document'))
          return
        }
        const entry: Entry = chosen
        // A fast reject on the DECLARED size; the measured check below is the real guarantee,
        // because a crafted archive can understate `uncompressedSize`.
        if (entry.uncompressedSize > MAX_AMF_SOURCE_BYTES) {
          finish(new ModelImportError('AMF is too large to import'))
          return
        }
        zipFile.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            fail(streamError ?? new ModelImportError('AMF archive could not be read'))
            return
          }
          const chunks: Buffer[] = []
          let total = 0
          stream.on('data', (chunk: Buffer) => {
            total += chunk.length
            if (total > MAX_AMF_SOURCE_BYTES) {
              stream.destroy()
              finish(new ModelImportError('AMF is too large to import'))
              return
            }
            chunks.push(chunk)
          })
          stream.on('end', () => finish(null, Buffer.concat(chunks).toString('utf8')))
          stream.on('error', fail)
        })
      })
      zipFile.readEntry()
    })
  })
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
