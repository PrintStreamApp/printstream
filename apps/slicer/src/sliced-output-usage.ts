/**
 * Material usage recovered from the slicer's finished 3MF artifact.
 *
 * BambuStudio's `result.json` is useful for timing, but some releases emit
 * `total_used_m: 0` even when the G-code and packaged `slice_info.config` carry the real length.
 * The packaged metadata describes the artifact that will actually print, so it is authoritative
 * for per-material and aggregate filament usage whenever present.
 */
import type { SlicingMaterialUsage, SlicingMetadata } from '@printstream/shared'
import { buildThreeMfIndex } from '@printstream/shared/three-mf'
import type { SlicedOutputTiming } from './gcode-header.js'

type SlicingMetadataFields = NonNullable<SlicingMetadata>

/** Parse and aggregate the per-plate filament records in a finished `slice_info.config`. */
export function parseSlicedOutputUsage(sliceInfoXml: string): SlicingMetadataFields | null {
  const index = buildThreeMfIndex(sliceInfoXml, null)
  const byMaterial = new Map<number, SlicingMaterialUsage>()
  let plateWeightGrams = 0
  let hasPlateWeight = false
  const plates: NonNullable<SlicingMetadataFields['plates']> = []

  for (const plate of index.plates) {
    const plateMaterials: SlicingMaterialUsage[] = []
    if (plate.weight != null) {
      plateWeightGrams += plate.weight
      hasPlateWeight = true
    }
    for (const filament of plate.filaments) {
      plateMaterials.push({
        id: filament.id,
        type: filament.filamentType,
        color: filament.color,
        weightGrams: filament.usedGrams,
        lengthMm: filament.usedMeters == null ? null : filament.usedMeters * 1000
      })
      const existing = byMaterial.get(filament.id) ?? {
        id: filament.id,
        type: null,
        color: null,
        weightGrams: null,
        lengthMm: null
      }
      existing.type ??= filament.filamentType
      existing.color ??= filament.color
      if (filament.usedGrams != null) {
        existing.weightGrams = (existing.weightGrams ?? 0) + filament.usedGrams
      }
      if (filament.usedMeters != null) {
        existing.lengthMm = (existing.lengthMm ?? 0) + filament.usedMeters * 1000
      }
      byMaterial.set(filament.id, existing)
    }
    const knownWeights = plateMaterials.flatMap((material) => material.weightGrams == null ? [] : [material.weightGrams])
    const knownLengths = plateMaterials.flatMap((material) => material.lengthMm == null ? [] : [material.lengthMm])
    plates.push({
      index: plate.index,
      ...(plate.prediction != null ? { estimatedPrintTimeSeconds: plate.prediction } : {}),
      ...(knownWeights.length > 0 || plate.weight != null
        ? { estimatedFilamentWeightGrams: knownWeights.length > 0 ? sum(knownWeights) : plate.weight }
        : {}),
      ...(knownLengths.length > 0 ? { estimatedFilamentLengthMm: sum(knownLengths) } : {}),
      ...(plateMaterials.length > 0 ? { materials: plateMaterials } : {})
    })
  }

  const materials = [...byMaterial.values()].sort((left, right) => (left.id ?? 0) - (right.id ?? 0))
  if (materials.length === 0 && !hasPlateWeight) return null

  const weights = materials.flatMap((material) => material.weightGrams == null ? [] : [material.weightGrams])
  const lengths = materials.flatMap((material) => material.lengthMm == null ? [] : [material.lengthMm])
  return {
    ...(weights.length > 0 || hasPlateWeight
      ? { estimatedFilamentWeightGrams: weights.length > 0 ? sum(weights) : plateWeightGrams }
      : {}),
    ...(lengths.length > 0 ? { estimatedFilamentLengthMm: sum(lengths) } : {}),
    ...(materials.length > 0 ? { materials } : {}),
    ...(plates.length > 0 ? { plates } : {})
  }
}

/** Overlay authoritative artifact usage while retaining JSON-only estimates such as print time. */
export function mergeSlicedOutputUsage(
  metadata: SlicingMetadata | null,
  packagedUsage: SlicingMetadataFields | null
): SlicingMetadata {
  if (!packagedUsage) return metadata ?? undefined
  if (!metadata) return packagedUsage

  const packagedById = new Map(
    (packagedUsage.materials ?? []).flatMap((material) => material.id == null ? [] : [[material.id, material] as const])
  )
  const mergedMaterials = (metadata.materials ?? []).map((material) => {
    const packaged = material.id == null ? null : packagedById.get(material.id)
    if (!packaged) return material
    packagedById.delete(material.id as number)
    return {
      ...material,
      type: packaged.type ?? material.type,
      color: packaged.color ?? material.color,
      weightGrams: packaged.weightGrams ?? material.weightGrams,
      lengthMm: packaged.lengthMm ?? material.lengthMm
    }
  })
  mergedMaterials.push(...packagedById.values())

  return {
    ...metadata,
    ...packagedUsage,
    plates: mergePlateUsage(metadata.plates, packagedUsage.plates),
    materials: mergedMaterials.length > 0 ? mergedMaterials : packagedUsage.materials
  }
}

/** Keep JSON print times while taking each plate's material usage from the finished artifact. */
function mergePlateUsage(
  reported: SlicingMetadataFields['plates'],
  packaged: SlicingMetadataFields['plates']
): SlicingMetadataFields['plates'] {
  if (!packaged?.length) return reported
  // result.json lists sliced plates in output order but does not give a stable plate id.
  // slice_info supplies the actual index, which may be sparse after selecting plates.
  return packaged.map((plate, position) => ({
    ...reported?.[position],
    ...plate,
    estimatedPrintTimeSeconds: reported?.[position]?.estimatedPrintTimeSeconds
      ?? plate.estimatedPrintTimeSeconds,
    index: plate.index
  }))
}

/** Prefer times from each printable G-code; suppress plate estimates that contradict the total. */
export function mergeSlicedOutputTiming(
  metadata: SlicingMetadata,
  timing: SlicedOutputTiming
): SlicingMetadata {
  if (!metadata && timing.totalSeconds == null && timing.prepareSeconds == null) return undefined

  const result: SlicingMetadataFields = { ...metadata }
  if (timing.totalSeconds != null) result.estimatedPrintTimeSeconds = timing.totalSeconds
  if (timing.prepareSeconds != null && timing.prepareSeconds >= 1) {
    result.estimatedPrepareTimeSeconds = Math.round(timing.prepareSeconds)
  }

  const byIndex = new Map(timing.plates.map((plate) => [plate.index, plate.totalSeconds]))
  if (result.plates?.length) {
    const singlePlate = result.plates.length === 1
    result.plates = result.plates.map((plate) => {
      const headerTime = byIndex.get(plate.index)
      if (headerTime != null) return { ...plate, estimatedPrintTimeSeconds: headerTime }
      if (singlePlate && timing.totalSeconds != null) {
        return { ...plate, estimatedPrintTimeSeconds: timing.totalSeconds }
      }
      return plate
    })
  } else if (timing.plates.length > 0) {
    result.plates = timing.plates.map((plate) => ({
      index: plate.index,
      estimatedPrintTimeSeconds: plate.totalSeconds
    }))
  }

  const plates = result.plates ?? []
  const reportedTotal = result.estimatedPrintTimeSeconds
  if (plates.length > 1 && reportedTotal != null) {
    const plateTimes = plates.map((plate) => plate.estimatedPrintTimeSeconds)
    const allKnown = plateTimes.every((time) => time != null)
    const sum = plateTimes.reduce<number>((total, time) => total + (time ?? 0), 0)
    // Packaged slice_info can repeat the whole-job prediction on every plate.
    // If individual G-code headers are unavailable, hide that false breakdown.
    if (allKnown && Math.abs(sum - reportedTotal) > plates.length) {
      result.plates = plates.map(({ estimatedPrintTimeSeconds: _unused, ...plate }) => plate)
    }
  }

  return result
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0)
}
