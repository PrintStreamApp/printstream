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
 * (the vendored source under `tmp/bambustudio-src`). Two deliberate omissions:
 *
 * - Studio first consults a JSON table of per-material-combination recommendations
 *   (`query_support_recommended_params_for_combination`), which only applies to one printer
 *   model (X2D) and needs vendor profile data we do not ship. We implement only Studio's own
 *   hard-coded fallback sets. Revisit if we ever vendor that table.
 * - Studio has a parallel prompt on the support BASE filament (`support_filament`), including
 *   a "non-soluble material as support base" warning. Not ported; this module is scoped to
 *   the interface change the UI asks about.
 *
 * Counterpart: `ProcessSettingsDialog` (apps/web) calls this from its scalar-change handler
 * and applies the result through the same config commit path as a manual edit, so the
 * proposal rides the existing modified/reset/undo wiring.
 */
import { serializeProcessBool, type ProcessConfig, type ProcessConfigValue } from './process-settings.js'

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
  /** The effective process config the change would land on. */
  config: ProcessConfig
}

/** Which of BambuStudio's three hard-coded cases matched. */
export type SupportRecommendationCase = 'supportTpu' | 'solubleInterface' | 'supportMaterial'

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
 * The four settings every case recommends. Case 3 stops here; cases 1 and 2 additionally
 * zero `support_object_xy_distance` (see {@link recommendSupportSettingsForInterfaceFilament}).
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
 * Cases are evaluated in BambuStudio's order, and only the first match applies:
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

  const changes: Record<string, string> = {}
  for (const [key, value] of Object.entries(matched.changes)) {
    if (!processValueMatches(config[key], value)) changes[key] = value
  }
  if (Object.keys(changes).length === 0) return null
  return { ...matched, changes }
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
