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

type SlicingMetadataFields = NonNullable<SlicingMetadata>

/** Parse and aggregate the per-plate filament records in a finished `slice_info.config`. */
export function parseSlicedOutputUsage(sliceInfoXml: string): SlicingMetadataFields | null {
  const index = buildThreeMfIndex(sliceInfoXml, null)
  const byMaterial = new Map<number, SlicingMaterialUsage>()
  let plateWeightGrams = 0
  let hasPlateWeight = false

  for (const plate of index.plates) {
    if (plate.weight != null) {
      plateWeightGrams += plate.weight
      hasPlateWeight = true
    }
    for (const filament of plate.filaments) {
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
    ...(materials.length > 0 ? { materials } : {})
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
    materials: mergedMaterials.length > 0 ? mergedMaterials : packagedUsage.materials
  }
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0)
}
