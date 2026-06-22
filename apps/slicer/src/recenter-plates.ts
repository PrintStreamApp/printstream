/**
 * Re-position a multi-plate project's objects onto a larger target bed, in the 3MF, before slicing.
 *
 * When a project authored for a smaller printer (e.g. a P1S, 256×256) is sliced on a larger one
 * (e.g. an H2D, 350×320), BambuStudio lays the plates out in a grid whose stride is the *bed* size,
 * so plate 2+'s objects — which carry the source bed's per-plate global offset — land outside the
 * target plate's region. The CLI then reports `CLI_NO_SUITABLE_OBJECTS` (exit 206, "no object fully
 * inside the plate").
 *
 * BambuStudio's CLI only auto-fixes this (`translate_models`) when it treats the load as a forced
 * machine switch — which it does NOT when a target-compatible process is loaded (the normal case).
 * Rather than coax the CLI, we apply the same shift ourselves: for each plate `i` we move its objects
 * by the difference between the target and source plate centers, which is the closed form below.
 * Derived from BambuStudio's `compute_origin_using_new_size` (`origin = col·W·(1+GAP)`,
 * `GAP = 1/5`) and its `translate_models` centering; validated to reproduce the CLI's own output
 * byte-for-byte on a P1S→H2D plate-2 case (446.8→606.6, 114.6→146.6).
 */

const LOGICAL_PART_PLATE_GAP = 1 / 5

/** BambuStudio's plate-grid column count for `count` plates: `ceil`-ish of `sqrt(count)`. */
export function plateColumnCount(count: number): number {
  const value = Math.sqrt(count)
  const rounded = Math.round(value)
  return value > rounded ? rounded + 1 : rounded
}

/** Bed dimensions (mm), width × depth. */
export interface BedSize { width: number; depth: number }

/**
 * The (dx, dy) to add to every object on plate `plateIndex` (0-based) when re-centering from `source`
 * to `target` bed, given the project's total `plateCount`. Zero when the beds match.
 */
export function plateRecenterOffset(plateIndex: number, plateCount: number, source: BedSize, target: BedSize): [number, number] {
  const cols = plateColumnCount(plateCount)
  const col = plateIndex % cols
  const row = Math.floor(plateIndex / cols)
  const stride = 1 + LOGICAL_PART_PLATE_GAP
  const dx = (target.width - source.width) * (col * stride + 0.5)
  // BambuStudio lays rows out in -Y, so the row term is subtracted.
  const dy = (target.depth - source.depth) * (0.5 - row * stride)
  return [dx, dy]
}

/**
 * Rewrite a `3D/3dmodel.model` XML so every build `<item>`'s translation is shifted by its plate's
 * {@link plateRecenterOffset}. `objectPlateIndex` maps each build-item `objectid` to its 0-based plate
 * (built from `model_settings.config` — see {@link buildObjectPlateIndex}). Items whose object has no
 * known plate, and the rest of the document, are left untouched. A no-op when the beds match.
 */
export function recenterBuildItemsXml(
  modelXml: string,
  objectPlateIndex: Map<number, number>,
  plateCount: number,
  source: BedSize,
  target: BedSize
): string {
  if (target.width === source.width && target.depth === source.depth) return modelXml
  return modelXml.replace(/<build\b[^>]*>[\s\S]*?<\/build>/g, (build) =>
    build.replace(/<item\b[^>]*\/>/g, (item) => {
      const objectId = Number(/\bobjectid="(\d+)"/.exec(item)?.[1])
      const plateIndex = objectPlateIndex.get(objectId)
      if (plateIndex === undefined) return item
      const [dx, dy] = plateRecenterOffset(plateIndex, plateCount, source, target)
      if (dx === 0 && dy === 0) return item
      return item.replace(/\btransform="([^"]*)"/, (_full, transform: string) => {
        const values = transform.trim().split(/\s+/).map(Number)
        const tx = values[9]
        const ty = values[10]
        if (tx === undefined || ty === undefined || values.some((v) => !Number.isFinite(v))) return `transform="${transform}"`
        values[9] = tx + dx
        values[10] = ty + dy
        return `transform="${values.join(' ')}"`
      })
    })
  )
}

/** Map each `object_id` to its 0-based plate index, plus the total plate count, from model_settings. */
export function buildObjectPlateIndex(settingsXml: string): { objectPlateIndex: Map<number, number>; plateCount: number } {
  const objectPlateIndex = new Map<number, number>()
  let plateCount = 0
  for (const plate of settingsXml.matchAll(/<plate\b[^>]*>[\s\S]*?<\/plate>/g)) {
    const platerId = Number(/plater_id"\s+value="(\d+)"/.exec(plate[0])?.[1])
    if (!Number.isInteger(platerId)) continue
    plateCount = Math.max(plateCount, platerId)
    for (const instance of plate[0].matchAll(/<model_instance\b[^>]*>[\s\S]*?<\/model_instance>/g)) {
      const objectId = Number(/object_id"\s+value="(\d+)"/.exec(instance[0])?.[1])
      if (Number.isInteger(objectId)) objectPlateIndex.set(objectId, platerId - 1) // 0-based
    }
  }
  return { objectPlateIndex, plateCount }
}

/** Parse a Bambu `printable_area` (e.g. `["0x0","350x0","350x320","0x320"]`) into a {@link BedSize}. */
export function bedSizeFromPrintableArea(printableArea: unknown): BedSize | null {
  if (!Array.isArray(printableArea) || printableArea.length < 4) return null
  const point = (s: unknown): [number, number] | null => {
    if (typeof s !== 'string') return null
    const parts = s.split('x')
    const x = Number(parts[0])
    const y = Number(parts[1])
    return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null
  }
  const min = point(printableArea[0])
  const max = point(printableArea[2])
  if (!min || !max) return null
  return { width: max[0] - min[0], depth: max[1] - min[1] }
}
