/**
 * Where the editor reads a project FROM.
 *
 * The third and last facet of the editor backend seam (after `EditorImportStore` and
 * `EditorSaveTarget`). BOTH implementations now read the project out of an archive inflated in the
 * tab; they differ only in how the archive got there, a host with the file in hand (the public
 * editor) already has it, while the library host downloads it from `/api/library/:id/archive`.
 *
 * Every read therefore runs the SAME parsers, `@printstream/shared/three-mf`, over the SAME
 * bytes. That is the property worth protecting here: while the library host read a server-parsed
 * index and per-plate scenes, the two editors could sit on subtly different scenes for one file,
 * and did (a missing process seed on the public side, a mis-seeded nozzle on the library side).
 * It is also what makes the editor self-sufficient after open: the session holds the project, so
 * nothing it does mid-session needs the server to re-read the file.
 *
 * Deliberately NOT covered: React Query wiring. The source is a plain async interface, and the
 * caller owns the caching, keys, and abort signals.
 */
import type { LibraryThreeMfScene, PrinterModel, ProjectAuxiliaries, ThreeMfIndex } from '@printstream/shared'
import { readEmbeddedProjectPresets, type EmbeddedProjectPreset } from './embeddedProjectPresets'
import { toThreeMfIndexDto } from '@printstream/shared/three-mf'
import { buildApiUrl } from '../../../lib/apiUrl'
import { MODEL_FETCH_HEADERS_MS, fetchModelBytes, type ModelFetchProgress } from './modelFetch'
import { openClientThreeMfProjectFromBytes, type ClientThreeMfProject } from './clientThreeMfProject'
import type { ThreeMfArchive } from './threeMfArchive'
import { readProjectAuxiliariesFromArchive } from './projectAuxiliaries'

/**
 * Body-stall budget for the archive, deliberately far above the mesh-entry default, and no retry.
 *
 * A mesh entry is small and comes from a file the API already holds, so 20s of silence there means
 * a wedged transport. The archive's first read is legitimately silent much longer: a bridge-owned
 * file is pulled to the API, read, and compressed IN FULL before a byte reaches the browser, so
 * time-to-first-byte scales with the whole project on a cold open. Retrying is also the wrong
 * trade at this size, a re-download costs more than the transient stall it recovers, unlike a
 * mesh entry.
 */
const ARCHIVE_STALL_MS = 90_000

// Dev used to fork here (an 8s budget + one retry) because Vite's http-proxy-based `/api` proxy
// wedged a share of requests that follow an aborted large response. That wedge is fixed at the
// source, dev `/api` traffic now flows through the hand-rolled `devApiProxy` middleware (see
// apps/web/devApiProxy.ts for the measurements), so dev shares production's single long attempt.

export interface EditorProjectSource {
  /** The project's parsed plate index: plates, filaments, objects, predictions. */
  loadIndex(signal?: AbortSignal): Promise<ThreeMfIndex>
  /**
   * One plate's scene: where every object sits, and the bed it sits on. `printerModel` re-places
   * the scene against a different machine's bed, which is how the editor previews a retarget.
   *
   * Null when the project carries no plated scene metadata (a geometry-only CAD export); callers
   * fall back to a plain mesh view rather than treating it as a failure.
   */
  loadScene(plateIndex: number, printerModel: string | null, signal?: AbortSignal): Promise<LibraryThreeMfScene | null>
  /** Raw bytes of a model entry (`3D/3dmodel.model` or a `3D/Objects/*.model` sub-model). */
  loadEntry(entryPath: string, signal?: AbortSignal): Promise<Uint8Array>
  /** A plate's embedded PNG preview, or null when the plate has none. */
  plateThumbnailUrl(plateIndex: number): string | null
  /**
   * The filament presets this project carries INSIDE itself, each flagged used or not.
   *
   * Optional: a source that cannot enumerate archive entries returns none, which is also the right
   * answer for a project that has none. Not part of the 3MF INDEX on purpose: the index is cached
   * per file version, so a field there costs a parser-version bump and a re-parse of every stored
   * project, for data only an open editor can act on.
   */
  loadEmbeddedPresets?(): Promise<EmbeddedProjectPreset[]>
  /**
   * The project's own `project_settings.config`, raw.
   *
   * For settings the editor edits WHOLE rather than key-by-key, today the purge volumes, which
   * need the machine's dead volumes and flush datasets alongside the stored matrix. Like
   * {@link loadEmbeddedPresets} this is deliberately not on the 3MF index: the index is cached per
   * file version, so putting a settings blob there would cost a parser-version bump and a re-parse
   * of every stored project for data only an open editor uses.
   *
   * Optional, and null when the project carries no settings entry (a from-scratch scaffold).
   */
  loadProjectSettings?(): Promise<string | null>
  /** BambuStudio-compatible attachments and descriptive project metadata. */
  loadProjectAuxiliaries?(): Promise<ProjectAuxiliaries>
  /**
   * Every entry name the opened archive holds.
   *
   * Needed to name a NEW archive entry without colliding: the names already in use are only fully
   * visible here. Deriving them from the records that reference them misses an ORPHAN (artwork whose
   * parts were all deleted, whose entry the copy pass still carries), and an appended entry never
   * displaces one the copy pass already wrote, so reusing an orphan's name silently discards the new
   * bytes and leaves the new part reopening as the old drawing.
   */
  listEntries?(): Promise<readonly string[]>
  /**
   * The inflated archive itself, for the BAKE.
   *
   * A save diffs its `SceneEdit` against the bytes the session opened, and this source is the only
   * thing holding them. Null before the project has finished opening, which a save cannot reach:
   * there is nothing to save until it has.
   *
   * Deliberately not an async open. A bake must author from the archive this session has been
   * reading all along; re-fetching here would silently author from whatever the file holds NOW,
   * which after an earlier save is this session's own output.
   */
  archive(): ThreeMfArchive | null
  /**
   * Release what the source holds (object URLs, the inflated archive). Only the creator of a
   * source may call this, a host that supplies its own owns its lifetime.
   */
  dispose?(): void
}

export type ArchiveProjectOpenPhase = 'loading-file' | 'reading-project'

export interface ArchiveProjectSourceOptions {
  /** Reports the two potentially long parts of the first open without exposing ZIP internals. */
  onOpenPhase?: (phase: ArchiveProjectOpenPhase) => void
  /** Reports decoded project bytes received by the browser. */
  onDownloadProgress?: (progress: ModelFetchProgress) => void
}

/**
 * The library source: downloads the whole 3MF once, then answers every read from it.
 *
 * @param resourceBase `/api/library/:id` or `/api/library/versions/:versionId`.
 * @param fileName internal only: see `openClientThreeMfProjectFromBytes`.
 */
export function createArchiveProjectSource(
  resourceBase: string,
  fileName = 'project.3mf',
  options: ArchiveProjectSourceOptions = {}
): EditorProjectSource {
  let opening: Promise<ClientThreeMfProject> | null = null
  let opened: ClientThreeMfProject | null = null
  let openingAbort: AbortController | null = null
  /**
   * Bumped by `dispose`. Releasing must NOT latch a permanent "disposed" flag: the caller disposes
   * from an effect cleanup, and React runs that cleanup spuriously (StrictMode remounts every
   * component in dev). A latch made the source look healthy, index, scenes and mesh entries all
   * resolve through `open()`, while `opened` stayed null forever, so ONLY plate thumbnails broke,
   * silently, and only in dev. Releasing to a re-openable state costs one revalidated refetch in
   * that case and nothing in production.
   */
  let generation = 0

  const open = (): Promise<ClientThreeMfProject> => {
    if (opening) return opening
    const openedFor = generation
    const controller = new AbortController()
    openingAbort = controller
    // One download shared by every read. Deliberately NOT given a reader's abort signal: readers
    // abort independently (a plate switch, a re-key), and the first one to give up must not cancel
    // the archive out from under all the others. The source owns this controller instead, so
    // closing the editor through `dispose` still stops the otherwise orphaned large transfer.
    // One attempt: a stalled retry re-downloads the WHOLE project, which costs more than the
    // transient stall it recovers from (the mesh-entry default retries because an entry is small).
    options.onOpenPhase?.('loading-file')
    const currentOpening = fetchModelBytes(
      buildApiUrl(`${resourceBase}/archive`),
      { method: 'GET', credentials: 'include', signal: controller.signal },
      ARCHIVE_STALL_MS,
      MODEL_FETCH_HEADERS_MS,
      1,
      options.onDownloadProgress
    )
      .then(async (bytes) => {
        controller.signal.throwIfAborted()
        options.onOpenPhase?.('reading-project')
        const project = await openClientThreeMfProjectFromBytes(fileName, bytes)
        if (controller.signal.aborted) {
          project.dispose()
          controller.signal.throwIfAborted()
        }
        // Released while this download was in flight: hand the project back to the caller that
        // asked for it, but drop it rather than adopting it as the source's live archive.
        if (openedFor !== generation) project.dispose()
        else opened = project
        return project
      })
      .catch((error: unknown) => {
        // Clear the memo so a retry re-downloads; a cached rejection would make the editor
        // permanently unopenable after one transient failure.
        if (opening === currentOpening) opening = null
        throw error
      })
      .finally(() => {
        if (openingAbort === controller) openingAbort = null
      })
    opening = currentOpening
    return opening
  }

  return {
    loadIndex: async () => toThreeMfIndexDto((await open()).index),

    // The model is a plain string because it comes from the slice target, which is not narrowed to
    // `PrinterModel` upstream. The scene parser falls back to a generic bed for anything it does
    // not recognise, so an unknown value degrades rather than throws.
    loadScene: async (plateIndex, printerModel) =>
      (await open()).sceneForPlate(plateIndex, printerModel as PrinterModel | null),

    loadEntry: async (entryPath) => await (await open()).loadEntryBytes(entryPath),

    // Sync by interface (the plate strip reads it during render), so it can only answer once the
    // archive is open. Null means "not yet": the strip shows its loading tile and asks again on
    // the next render, which the index landing already triggers.
    plateThumbnailUrl: (plateIndex) => opened?.plateThumbnailUrl(plateIndex) ?? null,

    archive: () => opened?.archive ?? null,
    loadEmbeddedPresets: async () => readEmbeddedProjectPresets((await open()).archive),

    loadProjectSettings: async () => (await open()).archive.indexEntries().projectSettingsJson,
    loadProjectAuxiliaries: async () => readProjectAuxiliariesFromArchive((await open()).archive),
    listEntries: async () => (await open()).archive.entryNames(),

    // Releases the archive and revokes its object URLs, and leaves the source RE-OPENABLE on
    // purpose: see `generation`.
    dispose: () => {
      generation += 1
      openingAbort?.abort(new DOMException('The editor was closed.', 'AbortError'))
      openingAbort = null
      opened?.dispose()
      opened = null
      opening = null
    }
  }
}

/**
 * The local source: everything comes out of an archive already inflated in the tab, so every read
 * is synchronous underneath and only wrapped in a promise to match the interface.
 */
export function createLocalProjectSource(project: ClientThreeMfProject): EditorProjectSource {
  return {
    loadIndex: async () => toThreeMfIndexDto(project.index),
    // The model is a plain string here because it comes from the slice target, which is not
    // narrowed to `PrinterModel` upstream. The scene parser falls back to a generic bed for
    // anything it does not recognise, so an unknown value degrades rather than throws.
    loadScene: async (plateIndex, printerModel) => project.sceneForPlate(plateIndex, printerModel as PrinterModel | null),
    loadEntry: (entryPath) => project.loadEntryBytes(entryPath),
    plateThumbnailUrl: (plateIndex) => project.plateThumbnailUrl(plateIndex),
    archive: () => project.archive,
    loadEmbeddedPresets: async () => readEmbeddedProjectPresets(project.archive),
    loadProjectSettings: async () => project.archive.indexEntries().projectSettingsJson,
    loadProjectAuxiliaries: async () => readProjectAuxiliariesFromArchive(project.archive),
    listEntries: async () => project.archive.entryNames()
  }
}
