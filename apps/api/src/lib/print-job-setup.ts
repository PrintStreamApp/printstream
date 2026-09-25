/**
 * Freezes the selected 3MF plate's print setup for durable job history.
 * The plate type is the slicer's requested bed type, not a physical-plate sensor reading.
 * Material types and presets come only from filaments used by this plate; a project-wide
 * filament list would wrongly attribute unused materials to a print.
 */
import {
  canonicalCurrBedType,
  parsePreservedSliceSettings,
  type BridgeLibraryThreeMfIndex,
  type PrintJobSetup
} from '@printstream/shared'

/** Build a setup snapshot from an inspected file and the job's frozen slice settings. */
export function buildPrintJobSetup(input: {
  index: BridgeLibraryThreeMfIndex
  plate: number
  printerModel: string | null
  sliceSettingsJson: string | null
}): PrintJobSetup | null {
  const plate = input.index.plates.find((entry) => entry.index === input.plate)
  if (!plate) return null

  const projectFilaments = new Map(input.index.projectFilaments.map((filament) => [filament.id, filament]))
  const materialTypes = new Set<string>()
  const materialPresets: PrintJobSetup['materialPresets'] = []
  const seenPresets = new Set<string>()

  for (const filament of plate.filaments) {
    const projectFilament = projectFilaments.get(filament.id)
    const materialType = (filament.filamentType ?? projectFilament?.filamentType)?.trim() || null
    if (materialType) materialTypes.add(materialType)

    const presetName = projectFilament?.filamentPresetName?.trim()
    if (presetName && !seenPresets.has(presetName)) {
      materialPresets.push({ materialType, presetName })
      seenPresets.add(presetName)
    }
  }

  const sliceSettings = parsePreservedSliceSettings(input.sliceSettingsJson)
  return {
    printerModel: input.printerModel,
    slicedPlateType: canonicalCurrBedType(plate.plateType),
    materialTypes: [...materialTypes].sort((left, right) => left.localeCompare(right)),
    materialPresets,
    printerProfileName: input.index.printerProfileName,
    processProfileName: input.index.processProfileName,
    nozzleSizes: [...plate.nozzleSizes],
    printSequence: plate.printSequence ?? null,
    slicerName: sliceSettings?.slicerName ?? null,
    slicerVersion: sliceSettings?.slicerVersion ?? null,
    projectVersion: input.index.projectVersion
  }
}
