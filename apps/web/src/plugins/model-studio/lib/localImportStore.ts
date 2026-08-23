/**
 * Staged imports, held in the browser.
 *
 * The counterpart of the api's `import-store.ts`. In the signed-in app a foreign model is uploaded
 * to `POST /api/editor/imports`, parsed server-side, kept in a workspace-keyed LRU, and referenced by
 * `importId` until the bake resolves it. None of that can happen in the public editor: there is no
 * session, and the file is not supposed to leave the machine.
 *
 * It also removes a round-trip that was always wasteful. Cut halves, split shells, and added
 * primitives are GENERATED in the browser, serialized to binary STL, uploaded, and then downloaded
 * back as STL purely so the server could hold them. Here they never leave.
 *
 * Parsing and welding come from `@printstream/shared/three-mf`, the same code the api runs: the
 * weld especially, since an unwelded import reaches the slicer as triangle soup and mangles small
 * features.
 *
 * It stages every format the api does. STL parses inline; a 3MF's geometry is extracted by the
 * SHARED extractor over an in-tab archive (`localThreeMfImport.ts`) and a STEP is tessellated by the
 * same OpenCASCADE build the api runs, loaded lazily in the tab (`localStepImport.ts`). Only the
 * byte source and the WASM loading differ from the api, never the resulting mesh, which is the
 * point: a file must import identically whichever host opened it.
 *
 * `importableFormats` still exists because a host's capabilities are not assumed: the picker's
 * `accept` is derived from it, so a store that loses a format cannot go on advertising it.
 */
import {
  ThreeMfImportError,
  computeMeshBounds,
  detectImportFormat,
  meshToBinaryStl,
  parseStlMesh,
  rebaseImportedMesh,
  type ImportedMesh
} from '@printstream/shared/three-mf'
import type { ImportNormalization, StagedImport, StagedImportFormat } from '@printstream/shared'
import type { EditorImportStore } from './editorImportStore'
import { ThreeMfArchiveError } from './threeMfArchive'
import { ImportStagingDataError, disposeImportStagingWorker, stageImportGeometry } from './importStagingClient'
import { extractThreeMfImportFromFile } from './localThreeMfImport'
import { tessellateStepInBrowser } from './localStepImport'

export class LocalImportError extends Error {}

/**
 * The name an import is listed and SAVED under, matching the api's `path.parse(originalname).name`.
 *
 * Only the final extension is dropped, so "Bracket v1.2.stl" stays "Bracket v1.2" rather than losing
 * the version. A name with no extension is returned unchanged.
 */
function importDisplayName(fileName: string): string {
  const cut = fileName.lastIndexOf('.')
  return cut > 0 ? fileName.slice(0, cut) : fileName
}

/**
 * What to tell the user when a 3MF or STEP import fails.
 *
 * A {@link ThreeMfImportError} is the shared extractor's considered refusal ("no importable
 * geometry", "too many triangles") and is already user-facing, so it passes through verbatim.
 * Anything else is a parse or WASM-load failure, where the raw message is noise, but the FORMAT is
 * worth naming, because a STEP failure is usually the ~7 MB tessellator failing to load rather than
 * anything wrong with the file.
 */
function importFailureMessage(format: StagedImportFormat, error: unknown): string {
  // Both of these are considered, user-facing refusals ("no importable geometry", "this file is
  // 300 MB…"), so they pass through verbatim; wrapping them buried the real reason mid-sentence.
  if (error instanceof ThreeMfImportError || error instanceof ThreeMfArchiveError) return error.message
  const detail = error instanceof Error && error.message ? ` (${error.message})` : ''
  return format === 'step'
    ? `This STEP file could not be converted${detail}.`
    : `This 3MF's geometry could not be read${detail}.`
}

export interface LocalImportStore extends EditorImportStore {
  /**
   * Stage geometry the editor generated itself, a cut half, a split shell, an added primitive.
   * These are already binary STL because that is what the upload path needed; keeping the same
   * entry point means the cut/split/primitive callers do not care which store they are talking to.
   */
  stageStlBytes(name: string, bytes: Uint8Array): StagedImport
  /** The staged mesh bytes, synchronously, this store already holds them. */
  meshBytes(importId: string, partIndex?: number): Uint8Array
}

interface StagedEntry {
  descriptor: StagedImport
  mesh: ImportedMesh
  /** The STL bytes as staged, so rendering never has to re-serialize. */
  stl: Uint8Array
  parts: Array<{ name: string; mesh: ImportedMesh; stl: Uint8Array; subtype?: string | null }>
}

/**
 * Geometry for one picked file, preferring the staging worker.
 *
 * A DATA failure (the file has no geometry, is over the triangle cap, is not a ZIP) is re-thrown as
 * is: re-running it on the main thread would freeze the tab on the way to the identical message.
 * Anything else means the worker MECHANISM is unavailable, no `Worker` (every node test takes this
 * path), a module that would not load, a wedged task, and the same work runs inline, because a
 * brief freeze beats an import that cannot happen at all.
 */
async function stageGeometry(
  format: StagedImportFormat,
  file: File,
  bytes: Uint8Array,
  normalize: ImportNormalization
): Promise<{ mesh: ImportedMesh; stl: Uint8Array; partStls: Uint8Array[] }> {
  try {
    return await stageImportGeometry(format, bytes, normalize)
  } catch (error) {
    if (error instanceof ImportStagingDataError) throw new LocalImportError(error.message)
    if (typeof Worker !== 'undefined') {
      console.warn('[import] staging worker unavailable; parsing on the main thread', error)
    }
    // The fallback leaves `partStls` empty; `stage` then serializes each part inline, which is the
    // freeze this whole path exists to avoid: acceptable only because it is the last resort.
    const mesh = format === 'stl'
      ? parseStlMesh(bytes)
      : format === '3mf'
        ? await extractThreeMfImportFromFile(file)
        : await tessellateStepInBrowser(bytes)
    // The same normalisation the worker applies, and the reason the STL branch can no longer hand
    // the picked bytes back untouched as its STL: rebasing the mesh but not the bytes would render
    // the model at its file coordinates while baking it at the origin.
    if (normalize === 'object') rebaseImportedMesh(mesh)
    return { mesh, stl: meshToBinaryStl(mesh), partStls: [] }
  }
}

export function createLocalImportStore(): LocalImportStore {
  const entries = new Map<string, StagedEntry>()
  const urls = new Map<string, string>()
  let nextId = 1

  /**
   * `partStls` come from whoever produced the mesh, aligned with `mesh.parts`. Serializing them here
   * instead put an assembly's whole triangle set through a SECOND pass on the main thread, in the
   * middle of the import, so the staging worker does it, and only the fallback pays for it inline.
   */
  const stage = (name: string, mesh: ImportedMesh, stl: Uint8Array, format: StagedImportFormat, partStls: Uint8Array[] = []): StagedImport => {
    const importId = `local-${nextId++}`
    const parts = (mesh.parts ?? []).map((part, index) => ({
      name: part.name,
      mesh: part.mesh,
      stl: partStls[index] ?? meshToBinaryStl(part.mesh),
      ...(part.subtype !== undefined ? { subtype: part.subtype } : {})
    }))
    const descriptor: StagedImport = {
      importId,
      name,
      // The SOURCE format, matching what the api records for the same file. Everything is held as
      // STL bytes here regardless, but the descriptor is a shared DTO and must not misreport it.
      format,
      triangleCount: Math.floor(mesh.indices.length / 3),
      bounds: mesh.bounds,
      parts: (mesh.parts ?? [{ name, mesh, subtype: null }]).map((part) => ({
        name: part.name,
        triangleCount: Math.floor(part.mesh.indices.length / 3),
        bounds: part.mesh.bounds,
        // A helper volume's subtype survives a 3MF geometry import; STL and generated geometry
        // have no volume concept, so null.
        subtype: part.subtype ?? null
      }))
    }
    entries.set(importId, { descriptor, mesh, stl, parts })
    return descriptor
  }

  // Closure-scoped rather than `this.meshBytes`: `meshUrl` is passed around as a bare function
  // reference (EditorView hands it to `instanceFromStagedImport`), so a `this`-dependent method
  // would break the moment it is detached from the store object.
  const meshBytesOf = (importId: string, partIndex?: number): Uint8Array => {
    const entry = entryOrThrow(importId)
    if (partIndex == null) return entry.stl
    const part = entry.parts[partIndex]
    if (!part) throw new LocalImportError(`This model has no part ${partIndex}.`)
    return part.stl
  }

  const entryOrThrow = (importId: string): StagedEntry => {
    const entry = entries.get(importId)
    if (!entry) throw new LocalImportError(`This model is no longer staged (${importId}).`)
    return entry
  }

  return {
    // There is no library on a host that stages locally; the caller must not offer those entries.
    supportsLibrarySource: false,

    // Every format the api stages, now that the 3MF extraction and the STEP fold are shared and the
    // OCCT WASM loads in the tab. STEP costs a ~7 MB lazy chunk on FIRST use only.
    importableFormats: ['stl', 'step', '3mf'],

    async stageFromLibrary(): Promise<StagedImport> {
      throw new LocalImportError('This editor has no library to import from. Choose a file instead.')
    },

    async fetchMesh(importId, partIndex) {
      const bytes = meshBytesOf(importId, partIndex)
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    },

    async stageFile(file, normalize, signal) {
      const format = detectImportFormat(file.name)
      if (!format) throw new LocalImportError(`${file.name} is not a model this editor can import.`)
      // The api names an import `path.parse(originalname).name`; matching it is what makes the same
      // file import under the same object name on both hosts. The name is baked into the saved 3MF,
      // so a mismatch is not cosmetic, and it reached added primitives too, which arrive here as
      // `cube.stl` and were listed as "cube.stl" on one host and "cube" on the other.
      const name = importDisplayName(file.name)
      const bytes = new Uint8Array(await file.arrayBuffer())
      try {
        // Off the main thread: OCCT tessellation and a 3MF's mesh parse + STL serialization are
        // seconds of work on a real assembly, and inline they freeze the tab with a spinner that
        // never paints. The STL the viewport loads is serialized FROM the same mesh the bake writes,
        // paint lands per triangle INDEX, so the two orderings have to be the one ordering.
        const { mesh, stl, partStls } = await stageGeometry(format, file, bytes, normalize)
        // Staging is slow enough that the caller may have given up meanwhile (dialog closed, editor
        // unmounted). Check before inserting: `stage` mutates the store, and an abandoned entry
        // would otherwise sit in `entries`, and in `importsForBake()`, until dispose.
        signal?.throwIfAborted()
        return stage(name, mesh, stl, format, partStls)
      } catch (error) {
        // The shared extractor and the OCCT loader raise their own error types; the editor's import
        // handler only knows how to present a LocalImportError. An abort is the caller's own doing
        // and must stay an abort rather than becoming a user-facing "could not be read".
        if (error instanceof LocalImportError) throw error
        if (error instanceof DOMException && error.name === 'AbortError') throw error
        throw new LocalImportError(importFailureMessage(format, error))
      }
    },

    stageStlBytes(name, bytes) {
      return stage(name, parseStlMesh(bytes), bytes, 'stl')
    },

    meshUrl: (importId, partIndex) => {
      const key = `${importId}:${partIndex ?? 'merged'}`
      const existing = urls.get(key)
      if (existing) return existing
      const url = URL.createObjectURL(new Blob([new Uint8Array(meshBytesOf(importId, partIndex))], { type: 'model/stl' }))
      urls.set(key, url)
      return url
    },

    meshBytes: meshBytesOf,

    importsForBake() {
      return [...entries.values()].map((entry) => ({
        importId: entry.descriptor.importId,
        name: entry.descriptor.name,
        mesh: entry.mesh,
        ...(entry.parts.length > 0
          ? { parts: entry.parts.map(({ name, mesh, subtype }) => ({ name, mesh, ...(subtype !== undefined ? { subtype } : {}) })) }
          : {})
      }))
    },

    dispose() {
      // Releases the staging worker with its instantiated OCCT runtime (~7 MB), an editor that has
      // closed has no use for it, and the next import starts a fresh one.
      disposeImportStagingWorker()
      for (const url of urls.values()) URL.revokeObjectURL(url)
      urls.clear()
      entries.clear()
    }
  }
}

/** Bounds for geometry the editor generated as raw positions (primitives, cut caps). */
export { computeMeshBounds }
