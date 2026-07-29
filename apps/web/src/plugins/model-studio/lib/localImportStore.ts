/**
 * Staged imports, held in the browser.
 *
 * The counterpart of the api's `import-store.ts`. In the signed-in app a foreign model is uploaded
 * to `POST /api/editor/imports`, parsed server-side, kept in a tenant-keyed LRU, and referenced by
 * `importId` until the bake resolves it. None of that can happen in the public editor: there is no
 * session, and the file is not supposed to leave the machine.
 *
 * It also removes a round-trip that was always wasteful. Cut halves, split shells, and added
 * primitives are GENERATED in the browser, serialized to binary STL, uploaded, and then downloaded
 * back as STL purely so the server could hold them. Here they never leave.
 *
 * Parsing and welding come from `@printstream/shared/three-mf`, the same code the api runs — the
 * weld especially, since an unwelded import reaches the slicer as triangle soup and mangles small
 * features. STEP is the one format this cannot stage: it needs the OpenCASCADE WASM build, which
 * only the api loads today.
 */
import {
  computeMeshBounds,
  detectImportFormat,
  meshToBinaryStl,
  parseStlMesh,
  type ImportedMesh
} from '@printstream/shared/three-mf'
import type { StagedImport } from '@printstream/shared'
import type { EditorImportStore } from './editorImportStore'

export class LocalImportError extends Error {}

export interface LocalImportStore extends EditorImportStore {
  /**
   * Stage geometry the editor generated itself — a cut half, a split shell, an added primitive.
   * These are already binary STL because that is what the upload path needed; keeping the same
   * entry point means the cut/split/primitive callers do not care which store they are talking to.
   */
  stageStlBytes(name: string, bytes: Uint8Array): StagedImport
  /** The staged mesh bytes, synchronously — this store already holds them. */
  meshBytes(importId: string, partIndex?: number): Uint8Array
}

interface StagedEntry {
  descriptor: StagedImport
  mesh: ImportedMesh
  /** The STL bytes as staged, so rendering never has to re-serialize. */
  stl: Uint8Array
  parts: Array<{ name: string; mesh: ImportedMesh; stl: Uint8Array; subtype?: string | null }>
}

export function createLocalImportStore(): LocalImportStore {
  const entries = new Map<string, StagedEntry>()
  const urls = new Map<string, string>()
  let nextId = 1

  const stage = (name: string, mesh: ImportedMesh, stl: Uint8Array): StagedImport => {
    const importId = `local-${nextId++}`
    const parts = (mesh.parts ?? []).map((part) => ({
      name: part.name,
      mesh: part.mesh,
      stl: meshToBinaryStl(part.mesh),
      ...(part.subtype !== undefined ? { subtype: part.subtype } : {})
    }))
    const descriptor: StagedImport = {
      importId,
      name,
      format: 'stl',
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

    async stageFromLibrary(): Promise<StagedImport> {
      throw new LocalImportError('This editor has no library to import from. Choose a file instead.')
    },

    async fetchMesh(importId, partIndex) {
      const bytes = meshBytesOf(importId, partIndex)
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    },

    async stageFile(file) {
      const format = detectImportFormat(file.name)
      if (format === 'step') {
        throw new LocalImportError('STEP files need the desktop app or a signed-in workspace to convert. Try an STL or 3MF instead.')
      }
      if (format !== 'stl') {
        throw new LocalImportError(`${file.name} is not a model this editor can import.`)
      }
      const bytes = new Uint8Array(await file.arrayBuffer())
      // parseStlMesh welds; do not swap in a bare STLLoader parse here.
      const mesh = parseStlMesh(bytes)
      return stage(file.name, mesh, bytes)
    },

    stageStlBytes(name, bytes) {
      return stage(name, parseStlMesh(bytes), bytes)
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
      for (const url of urls.values()) URL.revokeObjectURL(url)
      urls.clear()
      entries.clear()
    }
  }
}

/** Bounds for geometry the editor generated as raw positions (primitives, cut caps). */
export { computeMeshBounds }
