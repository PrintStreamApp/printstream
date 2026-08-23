/**
 * The browser's ONE way to build a 3MF index from an open archive.
 *
 * `buildThreeMfIndex` takes six positional arguments and one of them is a conditional
 * (`parseModelSettingsPlates` only when the model settings exist, to match how the api feeds it
 * pre-parsed plate metadata rather than raw XML). Two call sites had that call copied out, the
 * project open path and the geometry-import path, and the index decides which PLATE an import is
 * extracted from, so a drift between them would not error, it would silently import different
 * geometry. The parser's own checklist (the API development notes) anticipates new index inputs,
 * which is exactly when a second copy gets missed.
 *
 * Counterpart: `readPlateIndex` in `apps/api/src/lib/three-mf-reader.ts` (the same parse, Node ZIP).
 */
import { buildThreeMfIndex, parseModelSettingsPlates } from '@printstream/shared/three-mf'
import type { ThreeMfArchive } from './threeMfArchive'

/** Parse the archive's index entries into the shared 3MF index. */
export function threeMfIndexFromArchive(archive: ThreeMfArchive): ReturnType<typeof buildThreeMfIndex> {
  const entries = archive.indexEntries()
  return buildThreeMfIndex(
    entries.sliceInfoXml,
    entries.projectSettingsJson,
    // The API feeds the pre-parsed plate metadata rather than the raw XML (`readPlateIndex`);
    // match it so both surfaces take the identical code path through the parser.
    entries.modelSettingsXml ? parseModelSettingsPlates(entries.modelSettingsXml, entries.projectSettingsJson) : [],
    entries.thumbnailPlateFiles,
    entries.customGcodeXml,
    entries.modelSettingsXml
  )
}
