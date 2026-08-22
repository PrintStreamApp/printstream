/**
 * Cached, on-the-row 3MF display data for the library listing.
 *
 * Rendering a library folder needs each file's plate count and plate-type /
 * nozzle / filament / compatible-model chips. Deriving those means parsing the
 * 3MF (a bridge `inspect3mf` RPC for bridge-owned files), so doing it per row at
 * list time is the scalability problem in review `xc-scalability:scale-2`.
 *
 * The chips are instead persisted on `LibraryFile.derivedChipsJson` (+
 * `derivedChipsVersion`, the parser version they were built with) so the list
 * reads them straight off the row it already fetched — O(1) per row, no parse, no
 * RPC. Rows are populated lazily: the list warms any file whose cache is missing
 * or stale in the background, so the next listing is fully served from the row.
 */
import type { ThreeMfSettingsRepairReason } from '@printstream/shared'
import type { LibraryFile } from '@printstream/shared'
import { THREE_MF_INDEX_PARSER_VERSION } from '@printstream/shared/three-mf'

/** Parser version the persisted chips were built with; a bump invalidates them. */
export const LIBRARY_DERIVED_CHIPS_VERSION = THREE_MF_INDEX_PARSER_VERSION

export interface DerivedChips {
  plateCount: number
  compatiblePrinterModels: LibraryFile['compatiblePrinterModels']
  plateTypeChips: LibraryFile['plateTypeChips']
  nozzleSizeChips: LibraryFile['nozzleSizeChips']
  projectFilamentChips: LibraryFile['projectFilamentChips']
  /** Geometry-only 3MF (no Bambu project metadata) — the web treats it like STL/STEP. */
  geometryOnly?: boolean
  /** Editor single-object export (marker-stamped) — model-like default treatment. */
  objectExport?: boolean
  /** Embedded settings contradict the project's machine topology; the user can repair it. */
  needsSettingsRepair?: boolean
  /** Which invariants failed, so the repair prompt names the user's actual problem. */
  settingsRepairReasons?: ThreeMfSettingsRepairReason[]
  /** Bambu Studio version that saved the project, for the newer-than-the-engine check. */
  projectVersion?: string | null
  /** Sliced for a Filament Track Switch machine; must not print on one without it. */
  slicedWithFilamentTrackSwitch?: boolean
}

/**
 * Persisted envelope: the chips PLUS the file version they describe.
 *
 * The source path is part of the cache key, not decoration. `storedPath` is per-VERSION, so
 * comparing it is what makes a new version invalidate the chips — see {@link parseDerivedChips}.
 * Legacy rows hold a bare `DerivedChips` object with no envelope; those parse as stale and re-warm.
 */
interface PersistedDerivedChips {
  sourcePath: string
  chips: DerivedChips
}

export function serializeDerivedChips(chips: DerivedChips, sourcePath: string): string {
  return JSON.stringify({ sourcePath, chips } satisfies PersistedDerivedChips)
}

/**
 * Parse persisted chips, returning null when absent, built by an older parser version, or derived
 * from a DIFFERENT version of the file.
 *
 * The version stamp alone is NOT a sufficient staleness test, and treating it as one was a real
 * bug: saving a new version (a settings repair, a re-upload) leaves `derivedChipsVersion` equal to
 * the current constant, so every `cacheOnly` surface kept serving the PREVIOUS version's chips
 * indefinitely — a repaired project still advertising `needsSettingsRepair`, so the repair looked
 * like it had failed. Nothing clears this cache on write, by design: the test is what must be
 * blunt, so a writer that forgets cannot reintroduce the staleness.
 */
export function parseDerivedChips(
  json: string | null | undefined,
  version: number | null | undefined,
  sourcePath: string
): DerivedChips | null {
  if (!json || version !== LIBRARY_DERIVED_CHIPS_VERSION) return null
  try {
    const parsed = JSON.parse(json) as Partial<PersistedDerivedChips>
    if (typeof parsed?.sourcePath !== 'string' || !parsed.chips) return null
    return parsed.sourcePath === sourcePath ? parsed.chips : null
  } catch {
    return null
  }
}

/** Files with a warm already running, to dedupe concurrent list-triggered warms. */
const inFlightDerivations = new Set<string>()

export interface WarmDerivedChipsDeps {
  /** Inspect the file and derive its chips (the expensive parse/RPC path). */
  deriveChips: (file: { ownerBridgeId?: string | null; storedPath: string }) => Promise<DerivedChips>
  /** Persist the derived chips onto the file's row. */
  persist: (fileId: string, json: string, version: number) => Promise<void>
  log?: (message: string, error: unknown) => void
}

/**
 * Fire-and-forget: derive a file's chips and persist them on its row. Deduped per
 * file id and error-swallowing, so the list path can trigger it on a cache miss
 * without blocking or risking an unhandled rejection. Only 3MF/gcode files carry
 * chips; others are skipped.
 */
export function warmLibraryFileDerivedChips(
  file: { id: string; kind: string; ownerBridgeId?: string | null; storedPath: string },
  deps: WarmDerivedChipsDeps
): void {
  if (file.kind !== '3mf' && file.kind !== 'gcode') return
  if (inFlightDerivations.has(file.id)) return
  inFlightDerivations.add(file.id)
  void Promise.resolve()
    .then(() => deps.deriveChips(file))
    // Stamped with the path the chips were DERIVED from, not whatever the row says afterwards: a
    // version saved while this warm was in flight must invalidate the result, not inherit its id.
    .then((chips) => deps.persist(file.id, serializeDerivedChips(chips, file.storedPath), LIBRARY_DERIVED_CHIPS_VERSION))
    .catch((error) => deps.log?.(`[library] failed to warm derived chips for ${file.id}`, error))
    .finally(() => inFlightDerivations.delete(file.id))
}
