/**
 * Support-settings recommendations for a change of support INTERFACE material.
 *
 * Owns BambuStudio's "Suggestion" behaviour: when the user points
 * `support_interface_filament` at a material that calls for a different support geometry
 * (soluble interface, a dedicated support material, or PLA interfacing a TPU print), Studio
 * offers to apply a small fixed set of process settings. This module is the pure decision
 * half of that — it classifies the chosen interface material and returns the settings that
 * should change, or null when there is nothing worth asking about.
 *
 * Contract for callers: pass the *pending* interface filament id (the value the user just
 * picked, not the one still in `config`) together with the config those changes would land
 * on. The returned `changes` are already filtered against `config`, so a non-null result
 * always means at least one value would really move — callers can prompt unconditionally.
 *
 * Ported from `Tab.cpp`'s `opt_key == "support_interface_filament"` branch in BambuStudio
 * (the vendored source under `tmp/bambustudio-src`). Like Studio, the per-combination table
 * (`support-recommended-combinations.ts`, vendored from `support_recommended_params.json`) is
 * consulted FIRST — a table hit decides the outcome outright, even when every table value is
 * already configured and a fallback case would still move keys — and the three hard-coded
 * cases run only when it misses. The table needs to know which materials the plate's model
 * objects print with (`modelFilamentIds`), and only fires when they are homogeneous (all one
 * type or all one preset name), mirroring Studio's current-plate volume scan; a host that
 * cannot supply that context simply gets the fallback-only behaviour.
 *
 * One deliberate omission remains: Studio has a parallel prompt on the support BASE filament
 * (`support_filament`), including a "non-soluble material as support base" warning. Not
 * ported; this module is scoped to the interface change the UI asks about. And one deliberate
 * divergence: Studio gates the table on the X2D printer model — we offer it everywhere (see
 * the combinations module header).
 *
 * Counterpart: `ProcessSettingsDialog` (apps/web) calls this from its scalar-change handler
 * and applies the result through the same config commit path as a manual edit
 * (via {@link applySupportRecommendationChanges}), so the proposal rides the existing
 * modified/reset/undo wiring.
 */
import { serializeProcessBool, type ProcessConfig, type ProcessConfigValue } from './process-settings.js'
import { normalizeMaterialNameKey, querySupportRecommendedCombination, stripPresetPrinterSuffix } from './support-recommended-combinations.js'

/** One project material, as much of it as the classification needs. */
export interface SupportRecommendationFilament {
  /** 1-based slot index — the value `support_interface_filament` stores. */
  id: number
  /** `filament_type` (e.g. `PLA`, `TPU`, `PLA-S`). */
  filamentType: string | null
  /** Preset/display name (e.g. `Bambu Support For PLA/PETG`). */
  filamentName: string | null
  /** The project's `filament_is_support` flag for this slot, when the 3MF carried one. */
  isSupport?: boolean | null
  /** The project's `filament_soluble` flag for this slot, when the 3MF carried one. */
  isSoluble?: boolean | null
}

export interface SupportRecommendationInput {
  /** 1-based interface filament slot the user just chose; 0 is BambuStudio's "Default". */
  interfaceFilamentId: number
  /** 1-based support BASE filament slot currently configured; 0 is "Default". */
  supportFilamentId: number
  /** Every material the plate/project carries — the TPU check scans these. */
  filaments: readonly SupportRecommendationFilament[]
  /**
   * Ids (into `filaments`) of the materials the target plate's MODEL OBJECTS print with — the
   * model-material side of the combination-table lookup, mirroring Studio's scan of the current
   * plate's volumes. Dedicated support materials do not belong here (they are not model
   * geometry). Omit when the host has no plate context: the table path is skipped and only the
   * hard-coded fallback cases run.
   */
  modelFilamentIds?: readonly number[]
  /** The effective process config the change would land on. */
  config: ProcessConfig
}

/** The vendored combination table, or one of BambuStudio's three hard-coded fallback cases. */
export type SupportRecommendationCase = 'combination' | 'supportTpu' | 'solubleInterface' | 'supportMaterial'

export interface SupportRecommendation {
  case: SupportRecommendationCase
  /** One sentence naming the material situation, for the prompt copy. */
  reason: string
  /** Recommended values, already narrowed to the keys that would actually change. */
  changes: Record<string, string>
}

/**
 * Filament types treated as soluble when the project carries no `filament_soluble` flag.
 * Deliberately short: these are the only water-soluble families Bambu ships profiles for,
 * and a wrong guess here silently rewrites five support settings.
 */
const SOLUBLE_FILAMENT_TYPES: ReadonlySet<string> = new Set(['PVA', 'BVOH'])

/** Filament types that make the plate a TPU print for the PLA-interface case. */
const TPU_FILAMENT_TYPES: ReadonlySet<string> = new Set(['TPU', 'TPU-AMS'])

/** Enum value from the generated process catalogue (`support_interface_pattern`). */
const RECTILINEAR_INTERLACED = 'rectilinear_interlaced'

/**
 * The four settings every hard-coded FALLBACK case recommends (the combination table carries
 * its own sets). Case 3 stops here; cases 1 and 2 additionally zero
 * `support_object_xy_distance` (see {@link recommendSupportSettingsForInterfaceFilament}).
 */
const SHARED_RECOMMENDED_CHANGES: Readonly<Record<string, string>> = {
  support_top_z_distance: '0',
  support_interface_spacing: '0',
  support_interface_pattern: RECTILINEAR_INTERLACED,
  independent_support_layer_height: serializeProcessBool(false)
}

function normalizeType(filamentType: string | null | undefined): string {
  return (filamentType ?? '').trim().toUpperCase()
}

/**
 * Whether a material is a dedicated support material. The project's `filament_is_support`
 * flag wins when present; otherwise fall back to Bambu's naming, where support materials
 * carry a `-S` type suffix (`PLA-S`) or a "Support" preset name
 * ("Bambu Support For PLA/PETG"). The flag is authoritative because the fallbacks would
 * also match a user-renamed ordinary filament.
 */
export function isSupportMaterialFilament(filament: SupportRecommendationFilament): boolean {
  if (filament.isSupport != null) return filament.isSupport
  const type = normalizeType(filament.filamentType)
  if (type.endsWith('-S')) return true
  return (filament.filamentName ?? '').toUpperCase().includes('SUPPORT')
}

/**
 * Whether a material dissolves away. `filament_soluble` wins when the project carried it;
 * otherwise fall back to the soluble filament families ({@link SOLUBLE_FILAMENT_TYPES}).
 */
export function isSolubleFilament(filament: SupportRecommendationFilament): boolean {
  if (filament.isSoluble != null) return filament.isSoluble
  return SOLUBLE_FILAMENT_TYPES.has(normalizeType(filament.filamentType))
}

/**
 * Propose the support settings BambuStudio would recommend for a newly-chosen support
 * interface material, or null when it would recommend nothing — no case matched, no
 * interface material is selected, or the config already holds every recommended value.
 *
 * The combination table is consulted first and a hit is DECISIVE (see the module header).
 * On a miss, the fallback cases are evaluated in BambuStudio's order, and only the first
 * match applies:
 *
 * 1. `supportTpu` — a PLA interface on a plate that prints TPU.
 * 2. `solubleInterface` — a soluble interface over a non-soluble support base. (A soluble
 *    base needs no special geometry, which is why the base is excluded.)
 * 3. `supportMaterial` — a dedicated support material as the interface. This case
 *    deliberately leaves `support_object_xy_distance` alone: support material releases
 *    cleanly from the side walls, so Studio only closes the vertical gap.
 */
export function recommendSupportSettingsForInterfaceFilament(
  input: SupportRecommendationInput
): SupportRecommendation | null {
  const { interfaceFilamentId, supportFilamentId, filaments, config } = input
  if (interfaceFilamentId <= 0) return null

  const interfaceFilament = filaments.find((filament) => filament.id === interfaceFilamentId)
  if (!interfaceFilament) return null
  const baseFilament = filaments.find((filament) => filament.id === supportFilamentId) ?? null

  const combination = matchCombinationRecommendation(interfaceFilament, input.modelFilamentIds, filaments)
  if (combination) {
    // A table hit decides the outcome outright, matching Tab.cpp: `found_recommendation` is
    // set before the config filter runs, so the fallback cases are never consulted — even
    // when every table value is already in place and a fallback set would still move keys.
    const changes = filterAgainstConfig(combination.changes, config)
    if (Object.keys(changes).length === 0) return null
    return { case: 'combination', reason: combination.reason, changes }
  }

  const plateHasTpu = filaments.some((filament) => TPU_FILAMENT_TYPES.has(normalizeType(filament.filamentType)))

  let matched: SupportRecommendation | null = null
  if (normalizeType(interfaceFilament.filamentType) === 'PLA' && plateHasTpu) {
    matched = {
      case: 'supportTpu',
      reason: 'PLA is being used to support a TPU print.',
      changes: { ...SHARED_RECOMMENDED_CHANGES, support_object_xy_distance: '0' }
    }
  } else if (isSolubleFilament(interfaceFilament) && !(baseFilament && isSolubleFilament(baseFilament))) {
    matched = {
      case: 'solubleInterface',
      reason: 'The support interface uses a soluble material over a non-soluble support base.',
      changes: { ...SHARED_RECOMMENDED_CHANGES, support_object_xy_distance: '0' }
    }
  } else if (isSupportMaterialFilament(interfaceFilament)) {
    matched = {
      case: 'supportMaterial',
      // Case 3 omits support_object_xy_distance on purpose — see the doc comment above.
      reason: 'The support interface uses a dedicated support material.',
      changes: { ...SHARED_RECOMMENDED_CHANGES }
    }
  }
  if (!matched) return null

  const changes = filterAgainstConfig(matched.changes, config)
  if (Object.keys(changes).length === 0) return null
  return { ...matched, changes }
}

/** Narrow a recommended set to the keys whose value would actually move. */
function filterAgainstConfig(recommended: Readonly<Record<string, string>>, config: ProcessConfig): Record<string, string> {
  const changes: Record<string, string> = {}
  for (const [key, value] of Object.entries(recommended)) {
    if (!processValueMatches(config[key], value)) changes[key] = value
  }
  return changes
}

/**
 * The combination-table half of the decision: resolve the plate's model materials, require
 * them to be homogeneous (all one type, or all one preset name — Studio's precondition for
 * "the" model material being well-defined), and query the vendored table. Returns the
 * unfiltered recommended set plus the prompt sentence naming both materials.
 */
function matchCombinationRecommendation(
  interfaceFilament: SupportRecommendationFilament,
  modelFilamentIds: readonly number[] | undefined,
  filaments: readonly SupportRecommendationFilament[]
): { changes: Readonly<Record<string, string>>; reason: string } | null {
  if (!modelFilamentIds || modelFilamentIds.length === 0) return null
  const modelFilaments = modelFilamentIds
    .map((id) => filaments.find((filament) => filament.id === id))
    .filter((filament): filament is SupportRecommendationFilament => filament != null)
  if (modelFilaments.length === 0) return null

  const modelType = homogeneousValue(modelFilaments.map((filament) => filament.filamentType), normalizeType)
  const modelName = homogeneousValue(modelFilaments.map((filament) => filament.filamentName), normalizeMaterialNameKey)
  if (!modelType && !modelName) return null

  const match = querySupportRecommendedCombination({
    interfaceName: interfaceFilament.filamentName,
    interfaceType: interfaceFilament.filamentType,
    modelName,
    modelType
  })
  if (!match) return null

  const interfaceLabel = interfaceFilament.filamentName
    ? stripPresetPrinterSuffix(interfaceFilament.filamentName)
    : interfaceFilament.filamentType ?? 'This material'
  const modelLabel = match.matchedModel === 'name' && modelName
    ? stripPresetPrinterSuffix(modelName)
    : modelType ?? modelName ?? 'the model material'
  return { changes: match.changes, reason: `${interfaceLabel} is being used to support ${modelLabel}.` }
}

/**
 * The one value every entry shares under `keyOf`, or null when any entry is missing/empty or
 * they disagree. Returns the FIRST raw value (not the comparison key), for display.
 */
function homogeneousValue(values: ReadonlyArray<string | null>, keyOf: (value: string) => string): string | null {
  if (values.length === 0) return null
  let firstRaw: string | null = null
  let firstKey: string | null = null
  for (const value of values) {
    if (value == null || value.trim() === '') return null
    const key = keyOf(value)
    if (firstKey === null) {
      firstRaw = value
      firstKey = key
    } else if (key !== firstKey) {
      return null
    }
  }
  return firstRaw
}

/**
 * Merge an accepted recommendation into a config the way the settings dialog would. A vector
 * value (e.g. `support_interface_speed`, per-extruder `coFloats`) gets the scalar written to
 * EVERY element — Studio's table expresses these uniformly, and keeping a stale second element
 * would leave one extruder on the old speed. Scalars replace as-is.
 */
export function applySupportRecommendationChanges(
  config: ProcessConfig,
  changes: Readonly<Record<string, string>>
): ProcessConfig {
  const next: ProcessConfig = { ...config }
  for (const [key, value] of Object.entries(changes)) {
    const current = config[key]
    next[key] = Array.isArray(current) ? current.map(() => value) : value
  }
  return next
}

/**
 * Whether a config entry already holds the recommended value. Numeric settings compare
 * numerically so a config carrying "0.00" is not proposed a change to "0"; anything else
 * compares as a string. Vectors compare through their first element, matching how the
 * settings dialog edits scalar-presented vector options.
 */
function processValueMatches(current: ProcessConfigValue | undefined, recommended: string): boolean {
  if (current === undefined) return false
  const scalar = Array.isArray(current) ? current[0] ?? '' : current
  const currentNumber = Number(scalar)
  const recommendedNumber = Number(recommended)
  if (scalar.trim() !== '' && Number.isFinite(currentNumber) && Number.isFinite(recommendedNumber)) {
    return currentNumber === recommendedNumber
  }
  return scalar === recommended
}
