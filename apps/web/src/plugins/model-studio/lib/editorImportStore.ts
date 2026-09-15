/**
 * The editor's staged-geometry seam.
 *
 * Everything the editor places on a plate that did not come out of the project file, an imported
 * STL/STEP/3MF, a cut half, a split shell, an added primitive, is "staged" first and referenced by
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
import { importFormatExtensions } from '@printstream/shared'
import type { ImportedObjectInput } from '@printstream/shared/three-mf'
import type { ImportNormalization, SceneEdit, StagedImport, StagedImportFormat } from '@printstream/shared'

export type { ImportNormalization }

/**
 * The `accept` attribute for a file input staging into `store`.
 *
 * Derived from the store rather than hardcoded because a host's capabilities are its own to state:
 * both stores stage every format today, but the api converts server-side while the local one parses
 * in the tab, and either could narrow. A fixed list once offered the public editor's users two
 * formats it then refused AFTER the picker closed, which reads as a broken import rather than an
 * unsupported one.
 *
 * The format-to-extensions map itself is `importFormatExtensions` in the shared catalogue, not a
 * local one. It used to live here, which meant the picker's idea of which extensions name a format
 * and `detectImportFormat`'s idea of the same thing were two lists maintained by hand -- and a
 * picker that offers an extension the detector does not recognise refuses the file after the dialog
 * closes, which is the exact failure this function's own doc comment already warned about.
 */
export function importFileAccept(store: EditorImportStore): string {
  return importFormatExtensions(store.importableFormats).join(',')
}

export interface EditorImportStore {
  /**
   * Stage a model the user picked from disk. `companions` carries selected sidecars such as an
   * OBJ's `.mtl` libraries; stores ignore none silently and validate them at their host boundary.
   */
  stageFile(
    file: File,
    normalize: ImportNormalization,
    signal?: AbortSignal,
    companions?: readonly File[]
  ): Promise<StagedImport>
  /**
   * Formats {@link EditorImportStore.stageFile} can actually handle on this host. Callers must
   * narrow their file pickers to these (see {@link importFileAccept}) rather than offering every
   * format the editor supports somewhere; `stageFile` still rejects the rest as a backstop.
   *
   * Non-empty by type: an empty list would render `accept=""`, which browsers treat as NO filter:
   * the store would then offer every file type, the exact failure this field exists to prevent, and
   * silently. A host that can stage nothing has no business owning a file picker.
   */
  readonly importableFormats: readonly [StagedImportFormat, ...StagedImportFormat[]]
  /**
   * Stage geometry from an existing library file (optionally one object of it). Hosts with no
   * library reject this: callers must not offer the library entry points when
   * {@link EditorImportStore.supportsLibrarySource} is false.
   */
  stageFromLibrary(libraryFileId: string, normalize: ImportNormalization, objectId?: number, signal?: AbortSignal): Promise<StagedImport>
  /** Whether {@link EditorImportStore.stageFromLibrary} is available at all on this host. */
  readonly supportsLibrarySource: boolean
  /** A URL `STLLoader` can load the staged mesh from. Pass `partIndex` for one solid of an assembly. */
  meshUrl(importId: string, partIndex?: number): string
  /** The staged mesh as binary STL, for the geometry paths that read bytes rather than a URL. */
  fetchMesh(importId: string, partIndex?: number, signal?: AbortSignal): Promise<ArrayBuffer>
  /**
   * Source RGBA in triangle-corner order, or null when the import carried no colour sidecar.
   * Returns a copy because callers quantize asynchronously and must not mutate staged geometry.
   */
  fetchSourceColors(importId: string, partIndex?: number, signal?: AbortSignal): Promise<Float32Array | null>
  /**
   * Staged geometry to hand the bake directly, which every host must now answer: the bake runs in
   * the BROWSER on both, so nobody else is left to resolve an `importId`.
   *
   * Async because a host need not already hold the meshes. The local store parsed them in the tab
   * and returns what it kept; the api store staged them server-side and fetches them back, which is
   * why this cannot be a getter.
   *
   * `referencedIds` narrows the answer to what the edit still refers to. A store accumulates imports
   * the session has since discarded (every cut stages halves and connector volumes the next cut
   * replaces), and a host that fetches its geometry pays a round trip for each one. Omitted means
   * "everything staged", which is what a host holding its own meshes can afford.
   */
  importsForBake(signal?: AbortSignal, referencedIds?: ReadonlySet<string>): Promise<ImportedObjectInput[]>
  /** Release anything the store is holding (object URLs, cached meshes). */
  dispose(): void
}

/**
 * The staged imports a `SceneEdit` still refers to.
 *
 * Mirrors the api's `resolveSceneEditImports`, which walked the same two places: an instance's own
 * `importId`, and a part added onto an object (`meshImportId`). Anything else in a store is left
 * over from an edit the session has since replaced.
 */
export function importIdsReferencedBy(edit: SceneEdit): Set<string> {
  const ids = new Set<string>()
  for (const instance of edit.instances ?? []) {
    if (instance.importId) ids.add(instance.importId)
  }
  for (const added of Object.values(edit.addedParts ?? {})) {
    for (const part of Array.isArray(added) ? added : [added]) {
      if (part.meshImportId) ids.add(part.meshImportId)
      // An added part may itself be hosted on an import rather than on a base object.
      if (part.importId) ids.add(part.importId)
    }
  }
  return ids
}
