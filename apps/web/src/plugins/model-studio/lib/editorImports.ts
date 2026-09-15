/**
 * Client helpers for the editor's foreign-model staging endpoints.
 *
 * Imports are staged server-side: a foreign model is parsed (and STEP
 * tessellated) into a mesh keyed by `importId`. An import-backed editor instance
 * then references that `importId` in the `SceneEdit` it emits; the backend bakes
 * the staged mesh into the output 3MF at save/slice time, so no extra upload is
 * needed later.
 *
 * `apiFetch` is JSON-only, so the multipart upload here uses a raw `fetch` that
 * mirrors `apiFetch`'s credentials + workspace-context header handling. The mesh
 * itself is fetched as a binary STL (rendered with `STLLoader.parse`) rather than
 * shipped as JSON. Source colours travel in a separate byte RGBA sidecar because STL cannot
 * represent them; the editor normalizes and quantizes that sidecar into ordinary 3MF colour paint.
 */
import { STAGED_IMPORT_FORMATS, extractErrorMessage, type ImportNormalization, type StagedImport } from '@printstream/shared'
import { parseStlMesh, type ImportedMesh, type ImportedObjectInput } from '@printstream/shared/three-mf'
import type { EditorImportStore } from './editorImportStore'
import { buildApiUrl } from '../../../lib/apiUrl'
import { apiFetchRaw } from '../../../lib/apiFetchRaw'
import { readWorkspaceContextHeader } from '../../../lib/workspaceContext'
import { fetchModelBytes } from './modelFetch'

/**
 * Build the credentialed binary-mesh URL for a staged import (rendered by `STLLoader.parse`).
 * Pass `partIndex` to fetch one solid of a multi-solid import; omit it for the merged mesh.
 */
export function importMeshUrl(importId: string, partIndex?: number): string {
  const base = buildApiUrl(`/api/editor/imports/${encodeURIComponent(importId)}/mesh`)
  if (partIndex == null) return base
  // buildApiUrl may already have added a query (e.g. ?workspace=…), so use the right separator,
  // a second `?` makes the server read `part` as part of the workspace value, so every solid would
  // wrongly fetch the full merged mesh (7× the bytes → the "model download stalled" the user hit).
  const separator = base.includes('?') ? '&' : '?'
  return `${base}${separator}part=${encodeURIComponent(String(partIndex))}`
}

/** Credentialed binary source-colour URL, with the same optional part addressing as the mesh. */
export function importSourceColorsUrl(importId: string, partIndex?: number): string {
  const base = buildApiUrl(`/api/editor/imports/${encodeURIComponent(importId)}/source-colors`)
  if (partIndex == null) return base
  return `${base}${base.includes('?') ? '&' : '?'}part=${encodeURIComponent(String(partIndex))}`
}

/**
 * The workspace-context header on its own, for the ONE call that cannot use {@link apiFetchRaw}:
 * `fetchImportMesh` reads through the stall-guarded `fetchModelBytes`, which owns its own transport
 * and takes an init rather than returning a `Response`. Everything else here goes through the helper.
 */
function workspaceHeaders(): Record<string, string> {
  const workspaceContext = readWorkspaceContextHeader()
  return workspaceContext ? { 'X-PrintStream-Workspace': workspaceContext } : {}
}

async function readImportResponse(response: Response): Promise<StagedImport> {
  const contentType = response.headers.get('content-type') ?? ''
  const payload = contentType.includes('application/json')
    ? await response.json()
    : await response.text()
  if (!response.ok) {
    throw new Error(extractErrorMessage(payload, `Import failed (${response.status})`))
  }
  return (payload as { import: StagedImport }).import
}

/** Stage a foreign model from the user's filesystem (multipart, field `file`). */
export async function stageImportFromFile(
  file: File,
  normalize: ImportNormalization,
  signal?: AbortSignal,
  companions: readonly File[] = []
): Promise<StagedImport> {
  const form = new FormData()
  form.append('file', file)
  for (const companion of companions) form.append('companion', companion)
  // A multipart text field beside the file; the server rebases only an `object` (see
  // `ImportNormalization`), so an added part must reach it as `part` or its Z gets floored.
  form.append('normalize', normalize)
  const response = await apiFetchRaw('/api/editor/imports', {
    method: 'POST',
    headers: { Accept: 'application/json' },
    body: form,
    signal
  })
  return readImportResponse(response)
}

/** Stage a foreign model from an existing library file (optionally a single object). */
export async function stageImportFromLibrary(
  libraryFileId: string,
  normalize: ImportNormalization,
  objectId: number | undefined,
  signal?: AbortSignal
): Promise<StagedImport> {
  const response = await apiFetchRaw('/api/editor/imports/from-library', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(objectId == null ? { libraryFileId, normalize } : { libraryFileId, objectId, normalize }),
    signal
  })
  return readImportResponse(response)
}

/**
 * Fetch a staged import's binary STL mesh with credentials (for `STLLoader.parse`). Pass
 * `partIndex` for one solid of a multi-solid import; omit it for the merged mesh.
 */
export async function fetchImportMesh(importId: string, partIndex?: number, signal?: AbortSignal): Promise<ArrayBuffer> {
  // Stall-guarded so a transport that hangs mid-body surfaces an error instead of freezing
  // the editor's geometry build (see `modelFetch`).
  const bytes = await fetchModelBytes(importMeshUrl(importId, partIndex), {
    method: 'GET',
    credentials: 'include',
    headers: workspaceHeaders(),
    signal
  })
  // `fetchModelBytes` returns a tightly-sized Uint8Array backed by a fresh ArrayBuffer.
  return bytes.buffer as ArrayBuffer
}

/** Fetch an API-staged import's optional byte-RGBA sidecar as normalized floats. */
export async function fetchImportSourceColors(
  importId: string,
  partIndex?: number,
  signal?: AbortSignal
): Promise<Float32Array | null> {
  const bytes = await fetchModelBytes(importSourceColorsUrl(importId, partIndex), {
    method: 'GET',
    credentials: 'include',
    headers: workspaceHeaders(),
    signal
  })
  if (bytes.byteLength === 0) return null
  if (bytes.byteLength % 4 !== 0) {
    throw new Error('Imported source colours are corrupt.')
  }
  return Float32Array.from(bytes, (value) => value / 255)
}

/**
 * Rebuild one staged import as the bake's input, from the mesh the server holds.
 *
 * The geometry makes a ROUND TRIP: parsed server-side at stage time, written out as binary STL by
 * `/mesh`, and parsed back here. Two consequences, and only one of them is benign.
 *
 * Benign: STL carries float32, so a STEP or 3MF import is quantised on the way back. At ~7
 * significant digits that is 0.00002mm on a 200mm part, far below anything a printer resolves, and
 * an STL import loses nothing at all because STL is what it already was.
 *
 * NOT benign, and why the triangle count is checked: `weldImportedMeshVertices` merges on an EXACT
 * coordinate match and DROPS any triangle whose vertices coincide once merged. Two vertices that
 * were distinct as doubles can quantise to one float32, collapsing a sliver triangle. Every
 * triangle after it then shifts down one index, and `importPaint` is keyed BY triangle index, so
 * the user's support and seam painting would silently move onto different faces. Staging already
 * reported the count, so a lossy round trip is detectable, and this refuses rather than baking a
 * mesh whose paint no longer describes it.
 */
function meshFromStagedStl(bytes: ArrayBuffer, expectedTriangles: number, label: string): ImportedMesh {
  const mesh = parseStlMesh(new Uint8Array(bytes))
  const triangles = Math.floor(mesh.indices.length / 3)
  if (triangles !== expectedTriangles) {
    throw new Error(
      `Could not prepare “${label}” for saving: its geometry changed on load `
      + `(${expectedTriangles} triangles staged, ${triangles} read back). Re-import the model and try again.`
    )
  }
  return mesh
}

/**
 * The api-backed {@link EditorImportStore}: geometry is uploaded and parsed server-side, then read
 * BACK for the bake, which now runs in the browser.
 *
 * Stateful, so one instance per editor session (`createApiImportStore`): it remembers the descriptor
 * of everything it staged, because that is the only record of which imports this session's bake has
 * to resolve, and it carries the triangle counts the round trip is checked against.
 */
function createStore(): EditorImportStore {
  const staged = new Map<string, StagedImport>()
  const remember = (descriptor: StagedImport): StagedImport => {
    staged.set(descriptor.importId, descriptor)
    return descriptor
  }

  return {
    supportsLibrarySource: true,
    // Every catalogued format: the server parses STL/OBJ/glTF/AMF/FBX directly, converts STEP through
    // OpenCASCADE and extracts 3MF geometry, so all of them reach the bake. Derived rather than
    // listed because a hand-copied list on each of the two stores is precisely how one host comes to
    // offer a format the other refuses. A host that genuinely CANNOT stage one still narrows here.
    importableFormats: STAGED_IMPORT_FORMATS,
    async stageFile(file, normalize, signal, companions) {
      return remember(await stageImportFromFile(file, normalize, signal, companions))
    },
    async stageFromLibrary(libraryFileId, normalize, objectId, signal) {
      return remember(await stageImportFromLibrary(libraryFileId, normalize, objectId, signal))
    },
    meshUrl: importMeshUrl,
    fetchMesh: fetchImportMesh,
    fetchSourceColors: fetchImportSourceColors,

    async importsForBake(signal, referencedIds) {
      // Sequential rather than concurrent: a staged assembly is one request PER SOLID, and a project
      // with several of them would otherwise open a burst of large downloads at the moment of a save.
      // These are served from the browser cache in the common case (`max-age=300`), so the ordering
      // costs little, and a save is already an operation the user waits on.
      const imports: ImportedObjectInput[] = []
      for (const descriptor of staged.values()) {
        // Only what the EDIT still refers to, matching what the api resolved (`resolveSceneEditImports`
        // walked the edit, never the whole store). A session accumulates staged imports it has since
        // discarded: every cut stages two halves plus its connector volumes, and the next cut
        // replaces them. Fetching those back costs a round trip each on every save, and a stale one
        // failing its triangle check would refuse a save of a project it is no longer part of.
        if (referencedIds && !referencedIds.has(descriptor.importId)) continue
        const mesh = meshFromStagedStl(
          await fetchImportMesh(descriptor.importId, undefined, signal),
          descriptor.triangleCount,
          descriptor.name
        )
        // `parts` only for a genuine assembly, matching the server's own gate: a single-solid import
        // gets a synthesized one-entry summary, and passing that through would send the bake down its
        // multi-component path for a model that has exactly one.
        if (descriptor.parts.length <= 1) {
          imports.push({ importId: descriptor.importId, name: descriptor.name, mesh })
          continue
        }
        const parts: NonNullable<ImportedObjectInput['parts']> = []
        for (const [index, part] of descriptor.parts.entries()) {
          parts.push({
            name: part.name,
            mesh: meshFromStagedStl(
              await fetchImportMesh(descriptor.importId, index, signal),
              part.triangleCount,
              part.name
            ),
            ...(part.subtype !== undefined ? { subtype: part.subtype } : {})
          })
        }
        imports.push({ importId: descriptor.importId, name: descriptor.name, mesh, parts })
      }
      return imports
    },

    dispose() {
      staged.clear()
    }
  }
}

/** @returns a store for one editor session. Stateful, so sessions must not share one. */
export function createApiImportStore(): EditorImportStore {
  return createStore()
}
