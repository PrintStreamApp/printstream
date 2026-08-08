/**
 * A 3MF project opened entirely in the browser — the client-side counterpart of the API's
 * `readPlateIndex` / `readSceneManifest`.
 *
 * Everywhere else a 3MF is parsed on the server because the bytes live on a bridge. The public
 * 3MF viewer has no server copy on purpose: the user picks a file from their disk and it never
 * leaves the machine. So this module pairs the browser ZIP reader (`threeMfArchive.ts`) with the
 * SAME shared parsers the API uses (`@printstream/shared/three-mf`) — the parse is identical, only
 * the byte source differs, which is what keeps the two surfaces from drifting.
 *
 * Contract: {@link openClientThreeMfProject} resolves once the archive is inflated and the index is
 * parsed (fast — metadata only); per-plate scenes and mesh bytes are pulled lazily from the already
 * inflated archive. The caller MUST call {@link ClientThreeMfProject.dispose} to release the object
 * URLs handed out for plate thumbnails.
 */
import { buildSceneManifest, buildThreeMfIndex, parseModelSettingsPlates } from '@printstream/shared/three-mf'
import type { BridgeLibraryThreeMfIndex, LibraryThreeMfScene, PrinterModel } from '@printstream/shared'
import { openThreeMfArchive, type ThreeMfArchive } from './threeMfArchive'
import type { ThreeMfEntryBytesLoader } from './threeMfSceneStream'

export interface ClientThreeMfProject {
  fileName: string
  sizeBytes: number
  index: BridgeLibraryThreeMfIndex
  /**
   * The inflated archive behind this project. Exposed because SAVING needs it: the bake copies
   * every entry it does not rewrite, and baking without it would silently produce a 3MF containing
   * only the scaffold — every mesh and all vendor metadata gone.
   */
  archive: ThreeMfArchive
  /**
   * The plated scene for a 1-based plate index, or null when the project carries no plated scene
   * metadata (a geometry-only 3MF — a vanilla CAD export). Callers fall back to a plain mesh view,
   * exactly as the library does for those files.
   */
  sceneForPlate(plateIndex: number, overrideModel?: PrinterModel | null): LibraryThreeMfScene | null
  /** Mesh-entry loader for `streamThreeMfSceneParts`, served from the in-memory archive. */
  loadEntryBytes: ThreeMfEntryBytesLoader
  /** Object URL for a plate's embedded PNG preview, or null when the plate has none. */
  plateThumbnailUrl(plateIndex: number): string | null
  /** Release every object URL this project handed out. Safe to call twice. */
  dispose(): void
}

export async function openClientThreeMfProject(file: File): Promise<ClientThreeMfProject> {
  const archive = await openThreeMfArchive(file)
  return createProject(file, archive)
}

/**
 * Same project, opened from bytes the caller already has rather than a picked `File`.
 *
 * This is how the LIBRARY editor opens a project: it downloads the whole 3MF from
 * `/api/library/:id/archive` and parses it here, so the workspace and public editors run one
 * parser over one byte source instead of two (see `createArchiveProjectSource`). `fileName` is
 * internal bookkeeping — the library host names files from its own DTO, not from this.
 */
export async function openClientThreeMfProjectFromBytes(
  fileName: string,
  bytes: Uint8Array
): Promise<ClientThreeMfProject> {
  const blob = new Blob([bytes as BlobPart])
  const archive = await openThreeMfArchive(blob)
  return createProject({ name: fileName, size: blob.size }, archive)
}

function createProject(file: { name: string; size: number }, archive: ThreeMfArchive): ClientThreeMfProject {
  const entries = archive.indexEntries()
  const index = buildThreeMfIndex(
    entries.sliceInfoXml,
    entries.projectSettingsJson,
    // The API feeds the pre-parsed plate metadata rather than the raw XML (`readPlateIndex`);
    // match it so both surfaces take the identical code path through the parser.
    entries.modelSettingsXml ? parseModelSettingsPlates(entries.modelSettingsXml, entries.projectSettingsJson) : [],
    entries.thumbnailPlateFiles,
    entries.customGcodeXml,
    entries.modelSettingsXml
  )

  // Scenes are re-requested on every plate switch and re-parsing the root model XML is the
  // expensive part of opening a project, so memoize exactly like the API's scene cache. Keyed on
  // the override model too, since that changes the bed the scene is placed against.
  const sceneCache = new Map<string, LibraryThreeMfScene | null>()
  const thumbnailUrls = new Map<number, string>()
  let disposed = false

  return {
    fileName: file.name,
    sizeBytes: file.size,
    index,
    archive,

    sceneForPlate(plateIndex, overrideModel) {
      const cacheKey = `${plateIndex}:${overrideModel ?? ''}`
      const cached = sceneCache.get(cacheKey)
      if (cached !== undefined) return cached

      const sceneEntries = archive.sceneEntries()
      let scene: LibraryThreeMfScene | null = null
      if (sceneEntries) {
        try {
          scene = buildSceneManifest(sceneEntries, plateIndex, overrideModel) as LibraryThreeMfScene
        } catch {
          // The parser throws when there is no plated scene metadata at all. That is a shape of
          // 3MF we support (geometry-only CAD exports), not a failure to report.
          scene = null
        }
      }
      sceneCache.set(cacheKey, scene)
      return scene
    },

    loadEntryBytes: async (entryPath) => {
      const bytes = archive.entryBytes(entryPath)
      if (!bytes) throw new Error(`This project is missing one of its mesh entries (${entryPath}).`)
      return bytes
    },

    plateThumbnailUrl(plateIndex) {
      if (disposed) return null
      const existing = thumbnailUrls.get(plateIndex)
      if (existing) return existing

      const entryPath = archive.plateThumbnailEntries().get(plateIndex)
      const bytes = entryPath ? archive.entryBytes(entryPath) : null
      if (!bytes) return null

      // Copy into a fresh buffer: the archive's view may be a slice of a larger backing
      // ArrayBuffer, which Blob would otherwise capture whole.
      const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'image/png' }))
      thumbnailUrls.set(plateIndex, url)
      return url
    },

    dispose() {
      if (disposed) return
      disposed = true
      for (const url of thumbnailUrls.values()) URL.revokeObjectURL(url)
      thumbnailUrls.clear()
      sceneCache.clear()
    }
  }
}
