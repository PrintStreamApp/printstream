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
 * WHY A SENTINEL RATHER THAN A PER-KEY DIFF: "which keys should be here?" is only answerable against
 * the resolved preset, which a pure inspector cannot reach. But the defect is ALL-OR-NOTHING — the
 * drop removed every non-identity filament array at once — so the presence of any of these keys is
 * enough to tell a dropped project from a complete one. That keeps detection a pure function of the
 * file, like the other invariants, and available to every host including the browser.
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

/**
 * Keys BambuStudio writes for every filament in every project it saves. Any one of them present
 * means the project still carries its per-filament physics. Chosen because they are unconditional —
 * not gated on a material type, a plate, a machine capability, or a user setting — so their absence
 * is evidence of the drop rather than of an unusual project.
 */
const FILAMENT_PHYSICS_SENTINELS = [
  'nozzle_temperature',
  'nozzle_temperature_initial_layer',
  'filament_flow_ratio',
  'filament_density',
  'filament_diameter'
] as const

export interface FilamentPhysicsInspection {
  /** True when the project names filament presets but carries none of their values. */
  inconsistent: boolean
  /** Number of filament slots the project declares. */
  slotCount: number
  /** Which sentinel keys are present (empty when the physics was dropped). */
  presentKeys: string[]
}

/**
 * Inspect whether a project carries its filament physics.
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

  const presentKeys = FILAMENT_PHYSICS_SENTINELS.filter((key) => {
    const value = record[key]
    return Array.isArray(value) ? value.length > 0 : typeof value === 'string' && value !== ''
  })

  return { inconsistent: presentKeys.length === 0, slotCount: names.length, presentKeys }
}
