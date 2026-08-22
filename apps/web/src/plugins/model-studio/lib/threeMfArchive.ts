/**
 * Client-side 3MF archive reader — unzips a 3MF the browser already holds and exposes its entries
 * to the shared parsers.
 *
 * A 3MF is a ZIP. Everywhere else in the product a 3MF is unzipped server-side (the API's
 * `three-mf-internal.ts` / the bridge's `library-3mf.ts`) because the bytes live on a bridge. The
 * public 3MF editor has no server copy on purpose: the user's file is read straight from their
 * disk, so the unzip has to happen here. Counterpart of the API's `readSceneManifest` /
 * `readPlateIndex` ZIP I/O — the parsing itself is the SAME shared code
 * (`@printstream/shared/three-mf`), only the byte source differs.
 *
 * Contract: {@link openThreeMfArchive} decompresses the whole archive once, up front, and every
 * accessor after that is synchronous and allocation-cheap. That is the right trade for the editor
 * (the user is about to look at every plate anyway) but means peak memory is roughly the
 * uncompressed project — hence {@link MAX_CLIENT_THREE_MF_BYTES}.
 */
import { unzipArchiveBytes } from './zipArchiveClient'
import { CUSTOM_GCODE_PER_LAYER_ENTRY, THREE_MF_SLICE_INFO_ENTRY as SLICE_INFO_ENTRY, type ThreeMfSceneEntries } from '@printstream/shared/three-mf'

const ROOT_MODEL_ENTRY = '3D/3dmodel.model'
const MODEL_SETTINGS_ENTRY = 'Metadata/model_settings.config'
const PROJECT_SETTINGS_ENTRY = 'Metadata/project_settings.config'

const BRIM_EAR_POINTS_ENTRY = 'Metadata/brim_ear_points.txt'

/** `Metadata/plate_3.png` → plate 3. Bambu also writes `plate_3_small.png`, which this rejects. */
const PLATE_THUMBNAIL_PATTERN = /^Metadata\/plate_(\d+)\.png$/

/**
 * Refuse archives above this size. Everything is held decompressed in memory here, and a browser
 * tab that runs out of heap dies with no recoverable error — a clear "too large, open it in the
 * app" message is strictly better. Comfortably above any hand-authored project.
 */
export const MAX_CLIENT_THREE_MF_BYTES = 256 * 1024 * 1024

export interface ThreeMfArchive {
  /**
   * Every entry name in the archive, in no particular order. The bake's copy pass needs this to
   * carry through the entries it does not rewrite (meshes, thumbnails, vendor metadata) — a 3MF
   * holds far more than the editor models, and dropping the rest would corrupt the project.
   */
  entryNames(): string[]
  /** Raw entry bytes, or null when the archive has no such entry. */
  entryBytes(entryPath: string): Uint8Array | null
  /** Entry decoded as UTF-8 text, or null when absent. */
  entryText(entryPath: string): string | null
  /** The five entries the shared scene parser consumes, ready to pass to `buildSceneManifest`. */
  sceneEntries(): ThreeMfSceneEntries | null
  /** Entry names of the embedded per-plate PNG previews, keyed by 1-based plate index. */
  plateThumbnailEntries(): Map<number, string>
  /** Entries the shared index parser consumes, ready to pass to `buildThreeMfIndex`. */
  indexEntries(): {
    sliceInfoXml: string | null
    projectSettingsJson: string | null
    modelSettingsXml: string | null
    customGcodeXml: string | null
    thumbnailPlateFiles: Map<number, string>
  }
}

export class ThreeMfArchiveError extends Error {}

/**
 * Decompress a 3MF the user picked from disk.
 *
 * @throws {ThreeMfArchiveError} when the file is too large, is not a ZIP, or carries no
 *   `3D/3dmodel.model` — i.e. every case where the caller should show "this is not a 3MF we can
 *   open" rather than a broken editor.
 */
export async function openThreeMfArchive(file: Blob): Promise<ThreeMfArchive> {
  assertThreeMfSizeWithinLimit(file.size)

  const bytes = new Uint8Array(await file.arrayBuffer())
  const entries = await inflateArchive(bytes)
  return threeMfArchiveFromEntries(entries)
}

/** The same refusal `openThreeMfArchive` raises for an over-size file, without reading it. */
export function assertThreeMfSizeWithinLimit(byteLength: number): void {
  if (byteLength > MAX_CLIENT_THREE_MF_BYTES) {
    throw new ThreeMfArchiveError(
      `This file is ${Math.round(byteLength / (1024 * 1024))} MB. The editor can open projects up to ${Math.round(MAX_CLIENT_THREE_MF_BYTES / (1024 * 1024))} MB.`
    )
  }
}

/**
 * Wrap already-decompressed entries as an archive.
 *
 * Exported so a WORKER that unzipped synchronously (it is already off the main thread, so fflate's
 * sync codec is the right one there) gets the identical accessors — entry decoding, the text cache,
 * the scene/index entry selection — rather than a second implementation of them. The import-staging
 * worker takes this path; `openThreeMfArchive` is the main-thread one.
 *
 * @throws {ThreeMfArchiveError} when the entries carry no `3D/3dmodel.model`.
 */
export function threeMfArchiveFromEntries(entries: Record<string, Uint8Array>): ThreeMfArchive {
  if (!entries[ROOT_MODEL_ENTRY]) {
    throw new ThreeMfArchiveError('This file does not look like a 3MF project (no 3D/3dmodel.model inside).')
  }
  return createArchive(entries)
}

function createArchive(entries: Record<string, Uint8Array>): ThreeMfArchive {
  // One decoder for the whole archive: these entries are megabytes of XML and a fresh
  // TextDecoder per read shows up in the profile.
  const decoder = new TextDecoder('utf-8')
  const textCache = new Map<string, string | null>()

  const entryBytes = (entryPath: string): Uint8Array | null => entries[entryPath] ?? null

  const entryText = (entryPath: string): string | null => {
    const cached = textCache.get(entryPath)
    if (cached !== undefined) return cached
    const raw = entries[entryPath]
    const text = raw ? decoder.decode(raw) : null
    textCache.set(entryPath, text)
    return text
  }

  const plateThumbnailEntries = (): Map<number, string> => {
    const found = new Map<number, string>()
    for (const entryPath of Object.keys(entries)) {
      const match = PLATE_THUMBNAIL_PATTERN.exec(entryPath)
      const plateIndex = match ? Number.parseInt(match[1] ?? '', 10) : Number.NaN
      if (Number.isFinite(plateIndex) && plateIndex > 0) found.set(plateIndex, entryPath)
    }
    return found
  }

  return {
    entryNames: () => Object.keys(entries),
    entryBytes,
    entryText,
    plateThumbnailEntries,
    sceneEntries: () => {
      const rootModelXml = entryText(ROOT_MODEL_ENTRY)
      const modelSettingsXml = entryText(MODEL_SETTINGS_ENTRY)
      // Both are required by the scene parse. A geometry-only 3MF (a vanilla CAD export) has no
      // model_settings at all — that is not an error, it simply has no plated scene, and the
      // caller falls back to the mesh preview exactly as the library does.
      if (rootModelXml == null || modelSettingsXml == null) return null
      return {
        rootModelXml,
        modelSettingsXml,
        projectSettingsJson: entryText(PROJECT_SETTINGS_ENTRY),
        brimEarPointsText: entryText(BRIM_EAR_POINTS_ENTRY),
        customGcodeText: entryText(CUSTOM_GCODE_PER_LAYER_ENTRY)
      }
    },
    indexEntries: () => ({
      sliceInfoXml: entryText(SLICE_INFO_ENTRY),
      projectSettingsJson: entryText(PROJECT_SETTINGS_ENTRY),
      modelSettingsXml: entryText(MODEL_SETTINGS_ENTRY),
      customGcodeXml: entryText(CUSTOM_GCODE_PER_LAYER_ENTRY),
      thumbnailPlateFiles: plateThumbnailEntries()
    })
  }
}

async function inflateArchive(bytes: Uint8Array): Promise<Record<string, Uint8Array>> {
  // Off the main thread via the dedicated zip worker (a large project would otherwise freeze the
  // page for seconds mid-open), and guaranteed to settle — fflate's own async API could wedge
  // without erroring, which is exactly the never-resolving open this call must not produce.
  try {
    return await unzipArchiveBytes(bytes)
  } catch {
    throw new ThreeMfArchiveError('This file could not be opened as a 3MF archive.')
  }
}
