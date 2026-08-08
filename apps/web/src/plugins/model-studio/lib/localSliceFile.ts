/**
 * Adapts a locally-opened 3MF ({@link ClientThreeMfProject}) to the two shapes the slice-settings
 * machinery expects: a `ThreeMfIndex` (the "baked index") and a `LibraryFile`.
 *
 * The library builds both from server data; the public editor has neither a server nor a library
 * row, but it HAS parsed the file in the tab, so the same information is already in hand. This is a
 * pure mapping — no fetch, no I/O.
 *
 * Why the synthesized `LibraryFile` carries EMPTY chips: every slice helper that reads project
 * materials / plate type / nozzle (`buildSliceDialogProjectFilaments`, `resolveInitialPlateType`,
 * `resolveInitialNozzleDiameter`, `buildInitialFilamentColorSelection`, ...) prefers the baked index
 * and treats `file.*Chips` only as the no-index fallback. The local controller always passes the
 * baked index, so that fallback never fires and the chips would be dead data. Deriving them here
 * would duplicate the server's `library-derived-chips` logic for no observable effect.
 */
import type { LibraryFile, ThreeMfIndex } from '@printstream/shared'
import { toThreeMfIndexDto } from '@printstream/shared/three-mf'
import { LOCAL_SLICE_FILE_ID } from '../../../lib/localSliceFileId'
import type { ClientThreeMfProject } from './clientThreeMfProject'

// Re-exported, not defined here: core hooks must be able to recognise this id and core cannot
// import from a plugin. See `lib/localSliceFileId.ts` for why the distinction is load-bearing.
export { LOCAL_SLICE_FILE_ID } from '../../../lib/localSliceFileId'

/** The baked index the slice helpers read, mapped from the in-tab parse. */
export function localBakedIndex(project: ClientThreeMfProject): ThreeMfIndex {
  return toThreeMfIndexDto(project.index)
}

/**
 * A `LibraryFile` view of the open local project. Core identity/topology fields are real; chips are
 * empty by design (see the module note); the library-only lifecycle fields take their neutral
 * defaults since a local file has no versions, stars, or print history.
 *
 * `uploadedAt` is stamped from the current time — it is display-only and not read by any slice
 * helper, so a non-deterministic value here is harmless (and this runs only in the browser).
 */
export function localSliceLibraryFile(project: ClientThreeMfProject): LibraryFile {
  const index = project.index
  return {
    id: LOCAL_SLICE_FILE_ID,
    name: project.fileName,
    sizeBytes: project.sizeBytes,
    uploadedAt: new Date().toISOString(),
    kind: '3mf',
    thumbnailPath: null,
    folderId: null,
    compatiblePrinterModels: index.compatiblePrinterModels,
    plateTypeChips: [],
    nozzleSizeChips: [],
    projectFilamentChips: [],
    plateCount: index.plates.length,
    geometryOnly: index.geometryOnly,
    objectExport: index.objectExport,
    needsSettingsRepair: index.needsSettingsRepair,
    projectVersion: index.projectVersion,
    createdByName: null,
    restoredFromVersionNumber: null,
    favorite: false,
    printCount: 0,
    lastPrintedAt: null
  }
}
