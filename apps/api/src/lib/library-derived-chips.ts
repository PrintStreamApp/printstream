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
}

export function serializeDerivedChips(chips: DerivedChips): string {
  return JSON.stringify(chips)
}

/** Parse persisted chips, returning null when absent or built by an older parser version. */
export function parseDerivedChips(json: string | null | undefined, version: number | null | undefined): DerivedChips | null {
  if (!json || version !== LIBRARY_DERIVED_CHIPS_VERSION) return null
  try {
    return JSON.parse(json) as DerivedChips
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
    .then((chips) => deps.persist(file.id, serializeDerivedChips(chips), LIBRARY_DERIVED_CHIPS_VERSION))
    .catch((error) => deps.log?.(`[library] failed to warm derived chips for ${file.id}`, error))
    .finally(() => inFlightDerivations.delete(file.id))
}
