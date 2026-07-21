/**
 * Classification of a 3MF part's `subtype` (BambuStudio's `ModelVolumeType`) — the single source
 * of truth for the three questions every consumer asks about a part: which type is it really,
 * does it print, and does it carry a filament?
 *
 * Kept in the main `@printstream/shared` barrel rather than the `three-mf` subpath because the web
 * editor needs it and must not pull the index parser into its bundle. The API 3MF reader
 * (`apps/api/src/lib/three-mf-reader.ts`), the geometry extractor, and the editor sidebar
 * (`apps/web/src/plugins/model-studio/editorPanels.tsx`) all classify through here so a helper
 * volume can never be treated as printed geometry on one side and printed material on the other.
 *
 * The inputs are RAW 3MF strings, not the {@link SceneEditPartSubtype} enum: `model_settings.config`
 * writes `support_blocker` while older/foreign files write `volume_type` values like
 * `ParameterModifier`, so every comparison canonicalizes first.
 */
import type { SceneEditPartSubtype } from './slicing.js'

/** Case/punctuation-insensitive key for a raw 3MF subtype string (`Parameter Modifier` -> `parametermodifier`). */
function normalizeKey(subtype: string): string {
  return subtype.trim().toLowerCase().replace(/[^a-z0-9]+/g, '')
}

const SUBTYPE_BY_KEY = new Map<string, SceneEditPartSubtype>([
  ['normalpart', 'normal_part'],
  ['modelpart', 'normal_part'],
  ['part', 'normal_part'],
  ['negativepart', 'negative_part'],
  ['negativevolume', 'negative_part'],
  ['modifierpart', 'modifier_part'],
  ['parametermodifier', 'modifier_part'],
  ['supportblocker', 'support_blocker'],
  ['supportenforcer', 'support_enforcer']
])

/** Helper volumes: present in the scene, never printed as geometry of their own. */
const HELPER_SUBTYPES = new Set<SceneEditPartSubtype>([
  'negative_part',
  'modifier_part',
  'support_blocker',
  'support_enforcer'
])

/**
 * The {@link SceneEditPartSubtype} a raw 3MF `subtype`/`volume_type` string means. An absent or
 * unrecognized value is a normal part — the 3MF default, and the safe reading for a file written
 * by a tool whose vocabulary we don't know.
 */
export function canonicalThreeMfPartSubtype(subtype: string | null | undefined): SceneEditPartSubtype {
  if (!subtype) return 'normal_part'
  return SUBTYPE_BY_KEY.get(normalizeKey(subtype)) ?? 'normal_part'
}

/**
 * Whether a part subtype is a helper volume (negative/modifier/support blocker/enforcer) rather
 * than printed geometry. Used by the 3MF geometry-import extractor, which mirrors the STL
 * exporter's rule: helper volumes are never part of imported geometry.
 */
export function isNonRenderableThreeMfPartSubtype(subtype: string | null): boolean {
  return HELPER_SUBTYPES.has(canonicalThreeMfPartSubtype(subtype))
}

/**
 * Whether a part of this subtype can be assigned a filament — true for normal parts and for
 * modifiers, false for support blockers/enforcers and negative volumes. Mirrors BambuStudio, which
 * draws the extruder swatch for `MODEL_PART` and `PARAMETER_MODIFIER` only
 * (`ObjectDataViewModelNode::set_extruder_icon`): a modifier region can change the filament printed
 * inside it, so its extruder is meaningful; the other helpers' is not, and Studio writes 0 there.
 *
 * A part that answers false must never show a material swatch, never inherit its object's filament,
 * and never have an `extruder` written back to its `<part>` metadata.
 */
export function threeMfPartSubtypeCarriesFilament(subtype: string | null): boolean {
  const canonical = canonicalThreeMfPartSubtype(subtype)
  return canonical === 'normal_part' || canonical === 'modifier_part'
}
