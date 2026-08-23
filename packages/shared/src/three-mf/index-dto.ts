/**
 * Parsed 3MF index -> the shape the web consumes.
 *
 * The parser's `BridgeLibraryThreeMfIndex` names the archive entries it found
 * (`thumbnailFile`, `gcodeFile`, `pickFile`); the browser has no use for entry names and wants to
 * know only whether a plate HAS a thumbnail, since it fetches it by plate number.
 *
 * Shared because two surfaces now produce this DTO: the api's `/plates` route, and the browser
 * reading a file the user opened locally. Mapping it in one place is what stops a plate looking
 * thumbnail-less on one surface and not the other, a cast between the two shapes silently drops
 * `hasThumbnail`, which is the kind of difference nothing fails on and a user just sees.
 */
import type { BridgeLibraryThreeMfIndex } from '../bridge-runtime.js'
import type { ThreeMfIndex } from '../printer-contracts.js'

export function toThreeMfIndexDto(index: BridgeLibraryThreeMfIndex): ThreeMfIndex {
  return {
    plates: index.plates.map((plate) => ({
      index: plate.index,
      name: plate.name,
      hasThumbnail: plate.thumbnailFile != null,
      plateType: plate.plateType,
      nozzleSizes: plate.nozzleSizes,
      filaments: plate.filaments,
      objects: plate.objects,
      prediction: plate.prediction ?? null,
      weight: plate.weight ?? null,
      filamentChanges: plate.filamentChanges,
      pauses: plate.pauses
    })),
    projectFilaments: index.projectFilaments,
    compatiblePrinterModels: index.compatiblePrinterModels,
    supportFilamentIds: index.supportFilamentIds,
    printerProfileName: index.printerProfileName,
    processProfileName: index.processProfileName,
    // The repair flags belong to the VERSION whose bytes were parsed, this DTO is how an editor
    // opened on an archived version learns that version is defective (the library DTO's flags
    // describe the file's head, which may already be repaired).
    needsSettingsRepair: index.needsSettingsRepair,
    settingsRepairReasons: index.settingsRepairReasons
  }
}
