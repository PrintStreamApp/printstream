/**
 * Rolling a project's per-plate slice statistics up into whole-project totals (#92).
 *
 * Pure, so the aggregation rules can be tested without rendering the window that shows them
 * (`AllPlatesStatsDialog.tsx`). No new data is fetched: the `/plates` response already carries
 * every plate, and the per-plate panel simply only ever read one of them.
 */
import type { ThreeMfIndex } from '@printstream/shared'

/** One material's usage summed over every plate that prints it. */
export interface AggregatedPlateFilament {
  /** The 1-based PROJECT filament slot. */
  id: number
  label: string
  /**
   * The material type ("PLA"), kept as the label's last fallback before the slot number.
   *
   * Accumulated separately from `label` so a later plate can fill in a name an earlier one left
   * null without a type ever outranking a real name.
   */
  materialType: string
  color: string | null
  grams: number
  meters: number
  /**
   * Money for the material used, or null when the project priced this slot at nothing.
   *
   * Null rather than 0 so the window can drop the column entirely instead of reporting a
   * confident zero for a project that never recorded prices.
   */
  cost: number | null
}

/**
 * Sum each filament's usage across plates, keyed by the PROJECT slot id.
 *
 * Keyed on the slot rather than on the label, because two slots can legitimately hold the same
 * material and are still separate spools that must stay separate rows, while one slot used on
 * five plates is one row. An unsliced plate carries no `usedGrams`, so it contributes nothing
 * rather than being counted as zero-weight usage of something.
 */
export function aggregatePlateFilaments(
  plates: ThreeMfIndex['plates'],
  projectFilaments: ThreeMfIndex['projectFilaments']
): AggregatedPlateFilament[] {
  // Indexed once: a `find` per plate-filament is O(plates x slots x projectFilaments), and on the
  // merge path (the common one, a slot used on every plate) its result was not even read.
  const projectById = new Map(projectFilaments.map((entry) => [entry.id, entry]))
  const byId = new Map<number, AggregatedPlateFilament>()
  for (const plate of plates) {
    for (const filament of plate.filaments) {
      const existing = byId.get(filament.id)
      if (existing) {
        existing.grams += filament.usedGrams ?? 0
        existing.meters += filament.usedMeters ?? 0
        // A LATER plate may name a slot an earlier one left null, so keep filling the gaps rather
        // than freezing whatever the first plate happened to carry.
        existing.label ||= filament.filamentName ?? ''
        existing.materialType ||= filament.filamentType ?? ''
        existing.color ??= filament.color ?? null
        continue
      }
      byId.set(filament.id, {
        id: filament.id,
        label: filament.filamentName ?? '',
        materialType: filament.filamentType ?? '',
        color: filament.color ?? null,
        grams: filament.usedGrams ?? 0,
        meters: filament.usedMeters ?? 0,
        cost: null
      })
    }
  }
  for (const entry of byId.values()) {
    const project = projectById.get(entry.id)
    // The PROJECT slot is asked FIRST, because it is the one description that does not vary from
    // plate to plate. Reading a plate's own name first made the label depend on which plate
    // happened to mention the slot earliest, so merely reordering plates renamed a material.
    entry.label = project?.filamentName || entry.label || entry.materialType || `Filament ${entry.id}`
    entry.color = project?.color ?? entry.color
    // `costPerKg` is BambuStudio's `filament_cost`, priced per KILOGRAM against grams used.
    const costPerKg = project?.costPerKg
    entry.cost = costPerKg != null && costPerKg > 0 ? (entry.grams / 1000) * costPerKg : null
  }
  return [...byId.values()].sort((left, right) => left.id - right.id)
}

/**
 * What ONE plate weighs, from whichever of the two independent `slice_info.config` records it kept.
 *
 * The plate's own `weight` and its per-filament `usedGrams` come from different metadata keys and
 * are separately nullable, so a plate can carry either, both, or neither. The per-plate table must
 * render this and total THIS, or its Weight column does not add up to its own footer: a project
 * with plate weights but no per-filament grams showed real numbers per row under a 0.0 g total, and
 * the inverse showed "-" in every row under a non-zero one.
 *
 * Per-filament grams are preferred so the figure agrees with the Material table above, which can
 * only be built from them; `weight` is the fallback that keeps a plate recording only that from
 * dropping out. Null means the plate recorded neither, which the table shows as "-".
 */
export function platePrintedGrams(plate: ThreeMfIndex['plates'][number]): number | null {
  const used = plate.filaments.reduce<number | null>(
    (sum, filament) => (filament.usedGrams == null ? sum : (sum ?? 0) + filament.usedGrams),
    null
  )
  return used ?? plate.weight ?? null
}

/** Whole-project totals, over whatever the plates actually recorded. */
export interface AllPlatesTotals {
  grams: number
  meters: number
  seconds: number
  /**
   * Sum of {@link platePrintedGrams}, i.e. exactly what the per-plate table's Weight column shows.
   * Separate from `grams` because that one totals the FILAMENT table and cannot see a plate that
   * recorded only a plate-level weight.
   */
  plateGrams: number
  /** Total money, or null when nothing in the project carried a price. */
  cost: number | null
  /** Plates with no slice result, which contribute nothing and are called out in the UI. */
  unslicedPlates: number
}

export function summarizeAllPlates(
  plates: ThreeMfIndex['plates'],
  filaments: AggregatedPlateFilament[]
): AllPlatesTotals {
  const priced = filaments.filter((entry) => entry.cost != null)
  return {
    grams: filaments.reduce((sum, entry) => sum + entry.grams, 0),
    plateGrams: plates.reduce((sum, plate) => sum + (platePrintedGrams(plate) ?? 0), 0),
    meters: filaments.reduce((sum, entry) => sum + entry.meters, 0),
    seconds: plates.reduce((sum, plate) => sum + (plate.prediction ?? 0), 0),
    cost: priced.length > 0 ? priced.reduce((sum, entry) => sum + (entry.cost ?? 0), 0) : null,
    unslicedPlates: plates.filter((plate) => plate.prediction == null).length
  }
}
