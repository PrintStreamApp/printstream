/**
 * Where the editor reads a project FROM.
 *
 * The third and last facet of the editor backend seam (after `EditorImportStore` and
 * `EditorSaveTarget`). BOTH implementations now read the project out of an archive inflated in the
 * tab; they differ only in how the archive got there — a host with the file in hand (the public
 * editor) already has it, while the library host downloads it from `/api/library/:id/archive`.
 *
 * Every read therefore runs the SAME parsers — `@printstream/shared/three-mf` — over the SAME
 * bytes. That is the property worth protecting here: while the library host read a server-parsed
 * index and per-plate scenes, the two editors could sit on subtly different scenes for one file,
 * and did (a missing process seed on the public side, a mis-seeded nozzle on the library side).
 * It is also what makes the editor self-sufficient after open: the session holds the project, so
 * nothing it does mid-session needs the server to re-read the file.
 *
 * Deliberately NOT covered: React Query wiring. The source is a plain async interface, and the
 * caller owns the caching, keys, and abort signals.
 */
import type { LibraryThreeMfScene, PrinterModel, ThreeMfIndex } from '@printstream/shared'
import { readEmbeddedProjectPresets, type EmbeddedProjectPreset } from './embeddedProjectPresets'
import { toThreeMfIndexDto } from '@printstream/shared/three-mf'
import { buildApiUrl } from '../../../lib/apiUrl'
import { MODEL_FETCH_HEADERS_MS, fetchModelBytes } from './modelFetch'
import { openClientThreeMfProjectFromBytes, type ClientThreeMfProject } from './clientThreeMfProject'

/**
 * Body-stall budget for the archive, deliberately far above the mesh-entry default, and no retry.
 *
 * A mesh entry is small and comes from a file the API already holds, so 20s of silence there means
 * a wedged transport. The archive's first read is legitimately silent much longer: a bridge-owned
 * file is pulled to the API, read, and compressed IN FULL before a byte reaches the browser, so
 * time-to-first-byte scales with the whole project on a cold open. Retrying is also the wrong
 * trade at this size — a re-download costs more than the transient stall it recovers, unlike a
 * mesh entry.
 */
const ARCHIVE_STALL_MS = 90_000

// Dev used to fork here (an 8s budget + one retry) because Vite's http-proxy-based `/api` proxy
// wedged a share of requests that follow an aborted large response. That wedge is fixed at the
// source — dev `/api` traffic now flows through the hand-rolled `devApiProxy` middleware (see
// apps/web/devApiProxy.ts for the measurements) — so dev shares production's single long attempt.

export interface EditorProjectSource {
  /** The project's parsed plate index — plates, filaments, objects, predictions. */
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
   * answer for a project that has none. Not part of the 3MF INDEX on purpose — the index is cached
   * per file version, so a field there costs a parser-version bump and a re-parse of every stored
   * project, for data only an open editor can act on.
   */
  loadEmbeddedPresets?(): Promise<EmbeddedProjectPreset[]>
  /**
   * Release what the source holds (object URLs, the inflated archive). Only the creator of a
   * source may call this — a host that supplies its own owns its lifetime.
   */
  dispose?(): void
}

/**
 * The library source: downloads the whole 3MF once, then answers every read from it.
 *
 * @param resourceBase `/api/library/:id` or `/api/library/versions/:versionId`.
 * @param fileName internal only — see `openClientThreeMfProjectFromBytes`.
 */
export function createArchiveProjectSource(resourceBase: string, fileName = 'project.3mf'): EditorProjectSource {
  let opening: Promise<ClientThreeMfProject> | null = null
  let opened: ClientThreeMfProject | null = null
  /**
   * Bumped by `dispose`. Releasing must NOT latch a permanent "disposed" flag: the caller disposes
   * from an effect cleanup, and React runs that cleanup spuriously (StrictMode remounts every
   * component in dev). A latch made the source look healthy — index, scenes and mesh entries all
   * resolve through `open()` — while `opened` stayed null forever, so ONLY plate thumbnails broke,
   * silently, and only in dev. Releasing to a re-openable state costs one revalidated refetch in
   * that case and nothing in production.
   */
  let generation = 0

  const open = (): Promise<ClientThreeMfProject> => {
    const openedFor = generation
    // One download shared by every read. Deliberately NOT given a caller's abort signal: the
    // readers abort independently (a plate switch, a re-key), and the first one to give up would
    // otherwise cancel the archive out from under all the others.
    // One attempt: a stalled retry re-downloads the WHOLE project, which costs more than the
    // transient stall it recovers from (the mesh-entry default retries because an entry is small).
    opening ??= fetchModelBytes(
      buildApiUrl(`${resourceBase}/archive`),
      { method: 'GET', credentials: 'include' },
      ARCHIVE_STALL_MS,
      MODEL_FETCH_HEADERS_MS,
      1
    )
      .then(async (bytes) => {
        const project = await openClientThreeMfProjectFromBytes(fileName, bytes)
        // Released while this download was in flight: hand the project back to the caller that
        // asked for it, but drop it rather than adopting it as the source's live archive.
        if (openedFor !== generation) project.dispose()
        else opened = project
        return project
      })
      .catch((error: unknown) => {
        // Clear the memo so a retry re-downloads; a cached rejection would make the editor
        // permanently unopenable after one transient failure.
        opening = null
        throw error
      })
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
    // archive is open. Null means "not yet" — the strip shows its loading tile and asks again on
    // the next render, which the index landing already triggers.
    plateThumbnailUrl: (plateIndex) => opened?.plateThumbnailUrl(plateIndex) ?? null,

    loadEmbeddedPresets: async () => readEmbeddedProjectPresets((await open()).archive),

    // Releases the archive and revokes its object URLs, and leaves the source RE-OPENABLE on
    // purpose — see `generation`.
    dispose: () => {
      generation += 1
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
    loadEmbeddedPresets: async () => readEmbeddedProjectPresets(project.archive)
  }
}
