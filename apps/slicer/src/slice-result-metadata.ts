/**
 * Read a slicer CLI result JSON into the shared slicing-metadata contract.
 *
 * The CLI may name its JSON independently of the requested output. Keep one entry per sliced
 * plate even when its timing is absent, and treat unreadable or unrecognized JSON as optional
 * metadata rather than a failed slice. The caller merges these estimates with packaged output.
 */
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import type { SlicingMaterialUsage, SlicingMetadata } from '@printstream/shared'

// The slicer PRODUCES these by mutation; the API parses them back with the
// shared `slicingMetadataSchema`. Reuse the shared inferred types so the
// producer and the schema cannot drift. `SlicingMetadata` is optional at the
// schema level (the field may be absent on a job), so strip the `| undefined`
// for the concrete object this builds.
type SlicingMetadataFields = NonNullable<SlicingMetadata>

/** Find the first recognizable CLI result JSON and return optional slice estimates. */
export async function tryReadSlicingMetadata(workDir: string, outputFileName: string): Promise<SlicingMetadataFields | null> {
  // BambuStudio's --export-json output name isn't guaranteed to match the gcode base
  // name, so try the expected name first and then any other *.json the slice dropped in
  // the work dir, returning the first that carries recognizable slice estimate fields.
  const outputBaseName = outputFileName.replace(/\.[^.]+$/, '')
  const candidates = [`${outputBaseName}.json`]
  try {
    for (const entry of await readdir(workDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.json') && !candidates.includes(entry.name)) {
        candidates.push(entry.name)
      }
    }
  } catch { /* work dir unreadable: fall back to the expected name only */ }
  for (const candidate of candidates) {
    const parsed = await readSlicingMetadataFile(path.join(workDir, candidate))
    if (parsed) return parsed
  }
  return null
}

async function readSlicingMetadataFile(jsonPath: string): Promise<SlicingMetadataFields | null> {
  try {
    const content = await readFile(jsonPath, 'utf8')
    const data = JSON.parse(content)

    // Map common BambuStudio JSON fields to our metadata schema
    const metadata: SlicingMetadataFields = {}

    // BambuStudio's actual CLI output (result.json): per-plate `total_predication`
    // (print time, seconds) and `filaments[].total_used_g` (weight, incl. flush). Sum
    // across sliced plates so a single-plate or all-plate slice both report totals.
    if (Array.isArray(data.sliced_plates) && data.sliced_plates.length > 0) {
      let timeSeconds = 0
      let weightGrams = 0
      // Aggregate per-material usage across plates, keyed by filament id so the same
      // material on multiple plates sums into one row. Length is reported in metres in
      // result.json (`total_used_m`); convert to mm to match estimatedFilamentLengthMm.
      const byMaterial = new Map<number, SlicingMaterialUsage>()
      const plates: NonNullable<SlicingMetadataFields['plates']> = []
      for (const [position, plate] of data.sliced_plates.entries()) {
        if (plate && typeof plate.total_predication === 'number') timeSeconds += plate.total_predication
        // Keep one entry per output position even when timing is absent. Dropping a
        // position would attach the next plate's time to the wrong packaged plate.
        plates.push({
          index: position + 1,
          ...(plate && typeof plate.total_predication === 'number'
            ? { estimatedPrintTimeSeconds: Math.round(plate.total_predication) }
            : {})
        })
        if (plate && Array.isArray(plate.filaments)) {
          for (const filament of plate.filaments) {
            if (!filament || typeof filament !== 'object') continue
            const usedG = typeof filament.total_used_g === 'number' ? filament.total_used_g : null
            if (usedG != null) weightGrams += usedG
            const idRaw = filament.id ?? filament.filament_id
            const id = typeof idRaw === 'number' ? idRaw : Number.parseInt(String(idRaw ?? ''), 10)
            if (!Number.isInteger(id)) continue
            const usedM = typeof filament.total_used_m === 'number' ? filament.total_used_m
              : typeof filament.used_m === 'number' ? filament.used_m : null
            const existing = byMaterial.get(id) ?? { id, type: null, color: null, weightGrams: 0, lengthMm: 0 }
            if (typeof filament.type === 'string' && !existing.type) existing.type = filament.type
            if (typeof filament.color === 'string' && !existing.color) existing.color = filament.color
            if (usedG != null) existing.weightGrams = (existing.weightGrams ?? 0) + usedG
            if (usedM != null) existing.lengthMm = (existing.lengthMm ?? 0) + usedM * 1000
            byMaterial.set(id, existing)
          }
        }
      }
      if (timeSeconds > 0) metadata.estimatedPrintTimeSeconds = Math.round(timeSeconds)
      if (plates.length > 0) metadata.plates = plates
      // NOTE: prepare time deliberately does NOT come from result.json. Its `prepare_time` is the
      // CLI's own wall clock in MILLISECONDS (`BambuStudio.cpp:6201`), not a print estimate, so it
      // measured this container rather than the printer and inflated by 1000x on the way. It is
      // read from the finished G-code header instead; see `readSlicedOutputTiming`.
      if (weightGrams > 0) metadata.estimatedFilamentWeightGrams = weightGrams
      if (byMaterial.size > 0) {
        metadata.materials = [...byMaterial.values()].sort((a, b) => (a.id ?? 0) - (b.id ?? 0))
      }
    }

    // Print time in seconds (fallback shapes from other slicer JSON formats)
    if (metadata.estimatedPrintTimeSeconds == null && typeof data.time_cost === 'number') {
      metadata.estimatedPrintTimeSeconds = data.time_cost
    } else if (metadata.estimatedPrintTimeSeconds == null && typeof data.time_cost_str === 'string') {
      // Parse time string like "2h 30m 45s"
      const timeStr = data.time_cost_str
      let totalSeconds = 0
      const hoursMatch = timeStr.match(/(\d+)\s*h/)
      const minsMatch = timeStr.match(/(\d+)\s*m/)
      const secsMatch = timeStr.match(/(\d+)\s*s/)
      if (hoursMatch) totalSeconds += parseInt(hoursMatch[1]) * 3600
      if (minsMatch) totalSeconds += parseInt(minsMatch[1]) * 60
      if (secsMatch) totalSeconds += parseInt(secsMatch[1])
      if (totalSeconds > 0) {
        metadata.estimatedPrintTimeSeconds = totalSeconds
      }
    }

    // Filament length in mm (fallback)
    if (metadata.estimatedFilamentLengthMm == null && typeof data.length === 'number') {
      metadata.estimatedFilamentLengthMm = data.length
    }

    // Filament weight in grams (fallback)
    if (metadata.estimatedFilamentWeightGrams == null && typeof data.weight === 'number') {
      metadata.estimatedFilamentWeightGrams = data.weight
    }

    // Filament cost (fallback)
    if (metadata.estimatedFilamentCost == null && typeof data.money_cost === 'number') {
      metadata.estimatedFilamentCost = data.money_cost
    } else if (metadata.estimatedFilamentCost == null && typeof data.money_cost_str === 'string') {
      // Parse cost string like "$1.50" or "£2.00"
      const costMatch = data.money_cost_str.match(/[\d.]+/)
      if (costMatch) {
        metadata.estimatedFilamentCost = parseFloat(costMatch[0])
      }
    }

    return Object.keys(metadata).length > 0 ? metadata : null
  } catch {
    // Silently ignore metadata read errors - slicing succeeded, just no metadata
    return null
  }
}
