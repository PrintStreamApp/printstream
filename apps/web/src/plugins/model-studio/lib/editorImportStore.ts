/**
 * The editor's staged-geometry seam.
 *
 * Everything the editor places on a plate that did not come out of the project file — an imported
 * STL/STEP/3MF, a cut half, a split shell, an added primitive — is "staged" first and referenced by
 * `importId` until the bake resolves it. Where that staging happens differs by host, and this is the
 * one interface both answers implement:
 *
 *  - {@link createApiImportStore} (`editorImports.ts`) uploads to `POST /api/editor/imports`, which
 *    parses server-side and keeps the mesh in a workspace-keyed LRU. The bake resolves ids from there,
 *    so {@link EditorImportStore.importsForBake} has nothing to hand over.
 *  - `createLocalImportStore` (`localImportStore.ts`) parses in the tab and holds the geometry
 *    itself, because the public editor has no session and the file must not leave the machine. Its
 *    `importsForBake` IS how the meshes reach the bake.
 *
 * That difference is the whole reason this is an interface rather than a module: one host resolves
 * geometry by id on a server, the other carries it in memory, and `EditorView` should not know which.
 */
import type { ImportedObjectInput } from '@printstream/shared/three-mf'
import type { StagedImport, StagedImportFormat } from '@printstream/shared'

/** Extension(s) a file picker should offer for each staged-import format. */
const FORMAT_EXTENSIONS: Record<StagedImportFormat, readonly string[]> = {
  stl: ['.stl'],
  step: ['.step', '.stp'],
  '3mf': ['.3mf']
}

/**
 * The `accept` attribute for a file input staging into `store`.
 *
 * Derived from the store rather than hardcoded because a host's capabilities are its own to state:
 * both stores stage STL/STEP/3MF today, but the api converts server-side while the local one parses
 * in the tab, and either could narrow. A fixed list once offered the public editor's users two
 * formats it then refused AFTER the picker closed, which reads as a broken import rather than an
 * unsupported one.
 */
export function importFileAccept(store: EditorImportStore): string {
  return store.importableFormats.flatMap((format) => FORMAT_EXTENSIONS[format]).join(',')
}

export interface EditorImportStore {
  /** Stage a model the user picked from disk. */
  stageFile(file: File, signal?: AbortSignal): Promise<StagedImport>
  /**
   * Formats {@link EditorImportStore.stageFile} can actually handle on this host. Callers must
   * narrow their file pickers to these (see {@link importFileAccept}) rather than offering every
   * format the editor supports somewhere; `stageFile` still rejects the rest as a backstop.
   *
   * Non-empty by type: an empty list would render `accept=""`, which browsers treat as NO filter —
   * the store would then offer every file type, the exact failure this field exists to prevent, and
   * silently. A host that can stage nothing has no business owning a file picker.
   */
  readonly importableFormats: readonly [StagedImportFormat, ...StagedImportFormat[]]
  /**
   * Stage geometry from an existing library file (optionally one object of it). Hosts with no
   * library reject this — callers must not offer the library entry points when
   * {@link EditorImportStore.supportsLibrarySource} is false.
   */
  stageFromLibrary(libraryFileId: string, objectId?: number, signal?: AbortSignal): Promise<StagedImport>
  /** Whether {@link EditorImportStore.stageFromLibrary} is available at all on this host. */
  readonly supportsLibrarySource: boolean
  /** A URL `STLLoader` can load the staged mesh from. Pass `partIndex` for one solid of an assembly. */
  meshUrl(importId: string, partIndex?: number): string
  /** The staged mesh as binary STL, for the geometry paths that read bytes rather than a URL. */
  fetchMesh(importId: string, partIndex?: number, signal?: AbortSignal): Promise<ArrayBuffer>
  /**
   * Staged geometry to hand the bake directly. Empty for the api store, whose server resolves
   * `importId`s from its own LRU; populated for a local store, where nothing else holds the meshes.
   */
  importsForBake(): ImportedObjectInput[]
  /** Release anything the store is holding (object URLs, cached meshes). */
  dispose(): void
}
