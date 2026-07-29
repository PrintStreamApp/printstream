/**
 * The editor's staged-geometry seam.
 *
 * Everything the editor places on a plate that did not come out of the project file — an imported
 * STL/STEP/3MF, a cut half, a split shell, an added primitive — is "staged" first and referenced by
 * `importId` until the bake resolves it. Where that staging happens differs by host, and this is the
 * one interface both answers implement:
 *
 *  - {@link createApiImportStore} (`editorImports.ts`) uploads to `POST /api/editor/imports`, which
 *    parses server-side and keeps the mesh in a tenant-keyed LRU. The bake resolves ids from there,
 *    so {@link EditorImportStore.importsForBake} has nothing to hand over.
 *  - `createLocalImportStore` (`localImportStore.ts`) parses in the tab and holds the geometry
 *    itself, because the public editor has no session and the file must not leave the machine. Its
 *    `importsForBake` IS how the meshes reach the bake.
 *
 * That difference is the whole reason this is an interface rather than a module: one host resolves
 * geometry by id on a server, the other carries it in memory, and `EditorView` should not know which.
 */
import type { ImportedObjectInput } from '@printstream/shared/three-mf'
import type { StagedImport } from '@printstream/shared'

export interface EditorImportStore {
  /** Stage a model the user picked from disk. */
  stageFile(file: File, signal?: AbortSignal): Promise<StagedImport>
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
