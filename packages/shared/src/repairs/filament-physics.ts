/**
 * The invariant that a project which NAMES filament presets also carries their values.
 *
 * OWNS detecting a project whose per-filament physics is absent. BambuStudio always writes ~100
 * per-filament keys beside the names (temperatures, flow, cooling, retraction, plate temps). A
 * project that names presets but carries none of them cannot be opened meaningfully: BambuStudio has
 * no values to bind a slot to and no base to name a preset after, so it shows each slot as an unnamed
 * `(<project>.3mf)` preset of bare config defaults. PROVEN on a real file — restoring exactly these
 * keys made BambuStudio show every material correctly.
 *
 * HOW IT HAPPENED: a material change used to DROP every non-identity filament array and rely on our
 * slicer re-deriving them from the names at slice time. True for our slicer, false for BambuStudio.
 * The save path now authors the new material's values instead (`applyFilamentList`), so this detects
 * files saved before that.
 *
 * WHY SENTINELS RATHER THAN A PER-KEY DIFF: "which VALUES should be here?" is only answerable
 * against the resolved preset, which a pure inspector cannot reach. But which KEYS a complete
 * BambuStudio save carries is fixed (the sentinels below are unconditional), and each key's WIDTH
 * is a property of the option (`variant-options.ts`) — so absence and wrong width are both
 * decidable from the file alone. The original rule required ALL sentinels absent, reasoning the
 * drop was all-or-nothing; a real damaged file disproved that — the drop had run at a smaller
 * filament count, stale 3-wide arrays survived into the 5-filament project, and one surviving
 * sentinel made the file read as healthy while every slice quietly tripped the slicer service's
 * scaffold completion. Detection is now blunt: any missing sentinel, or any filament array at a
 * width matching neither `slots` nor `slots x variants`, flags the project.
 *
 * REPAIRED BY SAVING, not by the API repair route. `rebindProjectFilamentPhysics` cannot do it: it
 * only rewrites keys still PRESENT, and here they are gone entirely. Writing them from scratch needs
 * the variant WIDTH per key, and `filament_extruder_variant` — the column that records it — was
 * dropped too; guessing one width risks the `slots x variants` under-sizing that makes BambuStudio
 * read out of bounds and die (see `flush-volumes-matrix.ts`). `restore-filament-physics.ts` avoids the
 * guess by taking each key's width from the resolved preset itself, which is why this is a user-facing
 * reason: the editor's save path resolves the presets and restores the values, so the banner points at
 * Save rather than at the Repair button the other reasons use.
 */
import { FILAMENT_PRESET_OPTIONS } from '../generated/preset-options.generated.js'
import { filamentKeyWidth, filamentVariantsPerSlot, isFilamentVariantOption } from '../variant-options.js'

/**
 * Keys BambuStudio writes for every filament in every project it saves. Chosen because they are
 * unconditional — not gated on a material type, a plate, a machine capability, or a user setting —
 * so the absence of ANY of them is evidence of the drop rather than of an unusual project.
 */
const FILAMENT_PHYSICS_SENTINELS = [
  'nozzle_temperature',
  'nozzle_temperature_initial_layer',
  'filament_flow_ratio',
  'filament_density',
  'filament_diameter'
] as const

/**
 * Whether a per-filament value already in the project sits at a width BambuStudio accepts —
 * `slots`, `slots x variants` for a variant-scoped key, or a length-1 broadcast (a single value
 * applying to every slot, measured on real printer-written files). Shared by this inspector's
 * stale-width check and the restore's preserve-present rule (`restore-filament-physics.ts`), so a
 * key can never be counted healthy by one and rewritten — or left flagged — by the other.
 */
export function isAcceptableFilamentValueWidth(
  key: string,
  length: number,
  slotCount: number,
  variantsPerSlot: number
): boolean {
  return length === 1 || length === slotCount || length === slotCount * filamentKeyWidth(key, variantsPerSlot)
}

export interface FilamentPhysicsInspection {
  /** True when the project names filament presets but its physics is incomplete or malformed. */
  inconsistent: boolean
  /** Number of filament slots the project declares. */
  slotCount: number
  /** Which sentinel keys are present. */
  presentKeys: string[]
  /** Sentinel keys the project is missing — an incomplete block, whatever else survived. */
  missingKeys: string[]
  /**
   * Filament-option arrays whose length matches neither `slots` nor `slots x variants` — stale
   * leftovers from a save made at a DIFFERENT filament count (e.g. a 3-wide `filament_density` in
   * a 5-filament project). BambuStudio reads these positionally, so a wrong width mis-attributes
   * values across slots.
   */
  staleWidthKeys: string[]
}

/**
 * Inspect whether a project carries its complete filament physics.
 *
 * DELIBERATELY BLUNT (an invalidation predicate): any missing sentinel or any wrong-width filament
 * array flags the project, not only the all-dropped shape. The original all-five-absent rule
 * missed the real damaged file it was written for — the drop ran when the project had fewer
 * filaments, so stale 3-wide `filament_density`/`filament_diameter` arrays survived into the
 * 5-filament project and one surviving sentinel read as "still carries its physics", while every
 * slice quietly tripped the slicer service's scaffold completion. The repair
 * (`restore-filament-physics.ts`, invoked by the editor's save) rewrites the whole catalogue
 * block, so both failure shapes are repaired by the same action that detection points at.
 *
 * Returns null when there is nothing to judge — unparseable settings, or a project that declares no
 * filament slots at all. Those are unaffected rather than broken.
 */
export function inspectProjectFilamentPhysics(
  projectSettingsJson: string | null | undefined
): FilamentPhysicsInspection | null {
  if (!projectSettingsJson) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(projectSettingsJson)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const record = parsed as Record<string, unknown>

  const names = Array.isArray(record.filament_settings_id) ? record.filament_settings_id : null
  // No named presets means nothing claims to have values — e.g. a geometry-only export.
  if (!names || names.length === 0) return null
  const slotCount = names.length

  const present = (key: string): boolean => {
    const value = record[key]
    return Array.isArray(value) ? value.length > 0 : typeof value === 'string' && value !== ''
  }
  const presentKeys = FILAMENT_PHYSICS_SENTINELS.filter(present)
  const missingKeys = FILAMENT_PHYSICS_SENTINELS.filter((key) => !present(key))

  // Width is judged ONLY for keys whose width is decidable from the option table
  // (`variant-options.ts`): variant-scoped keys carry `slots x variants` entries and the plain
  // sentinels carry `slots`. Both also legitimately appear as a LENGTH-1 broadcast (a single value
  // applying to every slot — measured on real printer-written files), and variant keys as plain
  // `slots` (a pre-variant-aware save BambuStudio still reads). The rest of the catalogue is
  // deliberately not judged: BambuStudio declares those as free vectors whose per-slot column
  // count is option-specific (the AMS drying tables carry 4 columns per slot), so a width test
  // there convicts every healthy file.
  const variantsPerSlot = filamentVariantsPerSlot(record, slotCount)
  const staleWidthKeys: string[] = []
  const widthJudged = new Set<string>([...FILAMENT_PHYSICS_SENTINELS, ...FILAMENT_PRESET_OPTIONS].filter(
    (key) => isFilamentVariantOption(key) || (FILAMENT_PHYSICS_SENTINELS as readonly string[]).includes(key)
  ))
  for (const key of widthJudged) {
    const value = record[key]
    if (!Array.isArray(value) || value.length === 0) continue
    if (!isAcceptableFilamentValueWidth(key, value.length, slotCount, variantsPerSlot)) staleWidthKeys.push(key)
  }

  return {
    inconsistent: missingKeys.length > 0 || staleWidthKeys.length > 0,
    slotCount,
    presentKeys,
    missingKeys,
    staleWidthKeys
  }
}
