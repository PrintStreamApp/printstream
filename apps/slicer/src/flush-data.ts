/**
 * Reads BambuStudio's measured flush tables out of the bundled slicer resources.
 *
 * WHY THIS IS SERVED RATHER THAN VENDORED. Studio's "Re-calculate" for the flushing-volumes grid
 * does not trust its own colour formula where it has measurements: it ships tables of real purge
 * volumes between Bambu's filament colours and prefers a table hit. The gap is large (a mean 80 mm3
 * and up to +286 mm3 on the standard table, always over-purging), so a calculator without them
 * would quietly tell users to waste filament while disagreeing with the numbers Bambu Studio shows
 * for the same project. Serving them from the slicer image — where they already sit under the
 * engine's AGPL attribution and corresponding-source offer (`THIRD-PARTY-SLICERS.md`) — keeps them
 * out of our source tree AND means they track whichever BambuStudio actually slices, instead of
 * going stale at whatever version someone copied. Same reasoning as `bed-model.ts`.
 *
 * The text is returned UNPARSED on purpose: `parseFlushVolumeDataset` in `@printstream/shared` is
 * the one parser, shared by the API and the browser, so the format cannot be understood two ways.
 *
 * Counterpart: the API proxies this (`/api/slicing/flush-data`, `/api/public/slicing/flush-data`)
 * to the editor's flushing-volumes dialog.
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { FLUSH_DATASET_FILES } from '@printstream/shared'

/** Raw table text keyed by `nozzle_flush_dataset` code. Absent codes simply have no table. */
export type FlushDatasetTexts = Record<string, string>

/**
 * The dataset filenames come from the generated model rather than a literal here, so a BambuStudio
 * release that renames or adds one is picked up by re-running the generator. They are still checked
 * against a strict basename pattern: they end up joined onto a filesystem path, and a generator
 * reading a future source shape must not be able to turn that into a traversal.
 */
const SAFE_DATASET_PATH = /^flush\/[A-Za-z0-9._-]+\.txt$/

/**
 * Read every measured table this slicer image ships.
 *
 * Returns an empty record when the engine has no resources directory or ships no tables — a
 * supported state, not an error: the calculator falls back to Studio's colour formula, exactly as
 * Studio does when its own data file is missing.
 */
export async function readFlushDatasets(appDir: string | null | undefined): Promise<FlushDatasetTexts> {
  if (!appDir) return {}
  const out: FlushDatasetTexts = {}
  await Promise.all(Object.entries(FLUSH_DATASET_FILES).map(async ([code, relativePath]) => {
    if (!SAFE_DATASET_PATH.test(relativePath)) return
    try {
      out[code] = await readFile(path.join(appDir, 'resources', relativePath), 'utf8')
    } catch {
      // A missing table is normal — older engines ship fewer of them.
    }
  }))
  return out
}
