/**
 * BambuStudio's per-material-combination support recommendations — the vendored table from
 * `resources/profiles/BBL/filament/support_recommended_params.json` (v3.0) plus the lookup that
 * mirrors `query_support_recommended_params_for_combination` (ConfigManipulation.cpp) and
 * `PresetBundle::load_support_recommended_params`.
 *
 * This module owns only the DATA and the raw pairing lookup. Deciding whether a lookup should
 * run at all (homogeneous model materials, an interface actually selected) and filtering the
 * result against a live config belong to `support-recommendations.ts`, the one caller.
 *
 * How Studio actually matches — the JSON is more decorative than it looks:
 * - Entries declare `model_material_type`/`support_material_type` (`name` vs `type`) and a
 *   `priority`, but the LOOKUP consults neither: load flattens every entry into a map keyed
 *   `"<support>|<model>"`, and the query probes four key combinations in a fixed order —
 *   interface name+model name, interface type+model name, interface name+model type, interface
 *   type+model type — taking the first hit. That probe order IS the precedence; the declared
 *   kinds are kept here as documentation of each entry's intent, and `priority` is omitted
 *   because Studio loads it and never reads it.
 * - Studio gates the whole table on `printer_model == "Bambu Lab X2D"` (Tab.cpp). We deliberately
 *   do NOT: the entries encode material pairings (what releases cleanly from what), not printer
 *   geometry, and the prompt is confirm-only — so every printer gets the suggestion.
 *
 * Name normalization: Studio matches its preset ALIAS (the name minus the `@printer` suffix)
 * case-sensitively. Our classification names arrive less uniformly — a 3MF carries the full
 * preset name with the suffix, while picker labels drop the vendor prefix (see
 * `formatSlicingPresetDisplayName`, which strips it because those pickers group by vendor). So
 * keys here are compared case-insensitively with the `@printer` suffix stripped, and a candidate
 * missing the `Bambu` prefix is also tried with it. That is slightly broader than Studio (a
 * non-Bambu "ASA"-named preset can reach the "Bambu ASA" entry), which we accept: the
 * recommendation is about the material pairing, and the user still confirms.
 *
 * Values are serialized process-config scalars in our catalogue's encoding (`tree(auto)`,
 * `rectilinear_interlaced`, `1`/`0` bools). `support_interface_speed` is a per-extruder vector
 * in real configs; the table's uniform `[50,50,50,50]` is expressed as the scalar `50` and
 * spread across the vector at apply time (`applySupportRecommendationChanges`).
 */
import { serializeProcessBool } from './process-settings.js'

/** One vendored combination: "when <supportMaterials> supports <modelMaterial>, recommend this". */
export interface SupportRecommendedCombination {
  modelMaterial: string
  /** How Studio's JSON declares the model side is meant to match (not consulted — see header). */
  modelMatch: 'name' | 'type'
  supportMaterials: readonly string[]
  /** How Studio's JSON declares the support side is meant to match (not consulted — see header). */
  supportMatch: 'name' | 'type'
  /** Recommended values as serialized process-config scalars, unfiltered. */
  changes: Readonly<Record<string, string>>
}

/**
 * The full tree-hybrid conversion recommended for PLA<->PETG pairings: turn support on, switch
 * to hybrid tree, zero the interface gaps, and slow the interface passes.
 */
const TREE_HYBRID_FULL_CHANGES: Readonly<Record<string, string>> = {
  enable_support: serializeProcessBool(true),
  support_type: 'tree(auto)',
  support_style: 'tree_hybrid',
  support_threshold_angle: '35',
  support_on_build_plate_only: serializeProcessBool(false),
  raft_first_layer_expansion: '5',
  support_top_z_distance: '0',
  support_interface_pattern: 'rectilinear_interlaced',
  support_interface_spacing: '0',
  tree_support_branch_diameter: '3',
  tree_support_branch_diameter_angle: '7',
  support_interface_speed: '50'
}

/** Tree support with every gap zeroed, including the side walls (soluble-like interfaces). */
const TREE_ZERO_GAP_CHANGES: Readonly<Record<string, string>> = {
  enable_support: serializeProcessBool(true),
  support_type: 'tree(auto)',
  support_on_build_plate_only: serializeProcessBool(false),
  support_top_z_distance: '0',
  support_interface_pattern: 'rectilinear_interlaced',
  support_interface_spacing: '0',
  support_object_xy_distance: '0'
}

/** Tree support with the vertical interface gaps zeroed (dedicated support materials). */
const TREE_INTERFACE_CHANGES: Readonly<Record<string, string>> = {
  enable_support: serializeProcessBool(true),
  support_type: 'tree(auto)',
  support_on_build_plate_only: serializeProcessBool(false),
  support_top_z_distance: '0',
  support_interface_pattern: 'rectilinear_interlaced',
  support_interface_spacing: '0'
}

/** {@link TREE_INTERFACE_CHANGES} plus the hybrid tree style (the PA pairings). */
const TREE_HYBRID_INTERFACE_CHANGES: Readonly<Record<string, string>> = {
  ...TREE_INTERFACE_CHANGES,
  support_style: 'tree_hybrid'
}

/** Interface-contact keys only — no support enablement (the engineering-filament pairings). */
const INTERFACE_CONTACT_CHANGES: Readonly<Record<string, string>> = {
  support_top_z_distance: '0',
  support_interface_pattern: 'rectilinear_interlaced',
  support_interface_spacing: '0'
}

/**
 * The table, transcribed 1:1 from Studio's `support_recommended_params.json` combinations
 * (including its inconsistent "For"/"for" casing — matching is case-insensitive anyway).
 * Keep the order and content diffable against the vendored JSON when re-vendoring.
 */
export const SUPPORT_RECOMMENDED_COMBINATIONS: readonly SupportRecommendedCombination[] = [
  {
    modelMaterial: 'PLA',
    modelMatch: 'type',
    supportMaterials: ['Bambu Support For PLA/PETG', 'Bambu Support For PLA'],
    supportMatch: 'name',
    changes: TREE_HYBRID_FULL_CHANGES
  },
  { modelMaterial: 'PLA', modelMatch: 'type', supportMaterials: ['PETG'], supportMatch: 'type', changes: TREE_HYBRID_FULL_CHANGES },
  { modelMaterial: 'PLA', modelMatch: 'type', supportMaterials: ['PVA'], supportMatch: 'type', changes: TREE_ZERO_GAP_CHANGES },
  {
    modelMaterial: 'PETG',
    modelMatch: 'type',
    supportMaterials: ['Bambu Support For PLA/PETG'],
    supportMatch: 'name',
    changes: TREE_HYBRID_FULL_CHANGES
  },
  { modelMaterial: 'PETG', modelMatch: 'type', supportMaterials: ['PLA'], supportMatch: 'type', changes: TREE_HYBRID_FULL_CHANGES },
  { modelMaterial: 'ABS', modelMatch: 'type', supportMaterials: ['Bambu Support for ABS'], supportMatch: 'name', changes: TREE_INTERFACE_CHANGES },
  {
    modelMaterial: 'PA',
    modelMatch: 'type',
    supportMaterials: ['Bambu Support For PA/PET', 'Bambu ASA', 'Bambu ABS'],
    supportMatch: 'name',
    changes: TREE_HYBRID_INTERFACE_CHANGES
  },
  { modelMaterial: 'TPU', modelMatch: 'type', supportMaterials: ['PLA'], supportMatch: 'type', changes: TREE_ZERO_GAP_CHANGES },
  { modelMaterial: 'Bambu PA6-GF', modelMatch: 'name', supportMaterials: ['ABS'], supportMatch: 'type', changes: INTERFACE_CONTACT_CHANGES },
  { modelMaterial: 'Bambu PET-CF', modelMatch: 'name', supportMaterials: ['ASA'], supportMatch: 'type', changes: INTERFACE_CONTACT_CHANGES },
  { modelMaterial: 'Bambu PPA-CF', modelMatch: 'name', supportMaterials: ['ASA'], supportMatch: 'type', changes: INTERFACE_CONTACT_CHANGES },
  { modelMaterial: 'Bambu PAHT-CF', modelMatch: 'name', supportMaterials: ['ASA'], supportMatch: 'type', changes: INTERFACE_CONTACT_CHANGES },
  { modelMaterial: 'Bambu PA6-CF', modelMatch: 'name', supportMaterials: ['ASA'], supportMatch: 'type', changes: INTERFACE_CONTACT_CHANGES }
]

export interface SupportCombinationQuery {
  /** The chosen interface material's preset/display name, as full as the host has it. */
  interfaceName: string | null
  /** The chosen interface material's `filament_type`. */
  interfaceType: string | null
  /** The plate's one model-material NAME, when the model materials share one; else null. */
  modelName: string | null
  /** The plate's one model-material TYPE, when the model materials share one; else null. */
  modelType: string | null
}

export interface SupportCombinationMatch {
  /** Recommended values as serialized scalars, NOT yet filtered against any config. */
  changes: Readonly<Record<string, string>>
  /** Which model-side key matched, so prompt copy can name the material the same way. */
  matchedModel: 'name' | 'type'
}

/** Drop a preset name's `@printer` compatibility suffix ("Bambu ASA @BBL H2D" -> "Bambu ASA"). */
export function stripPresetPrinterSuffix(name: string): string {
  const at = name.indexOf('@')
  return (at === -1 ? name : name.slice(0, at)).trim()
}

/**
 * The comparison key material names/types are matched under: `@printer` suffix stripped,
 * whitespace collapsed, case folded. Also what callers should use to COMPARE material names
 * (e.g. the homogeneity check), so "the same name" means the same thing on both sides.
 */
export function normalizeMaterialNameKey(value: string): string {
  return stripPresetPrinterSuffix(value).replace(/\s+/g, ' ').trim().toLowerCase()
}

/** A name candidate also tries the `Bambu`-prefixed form — see the header on vendor stripping. */
function nameKeyCandidates(name: string | null | undefined): string[] {
  if (!name) return []
  const key = normalizeMaterialNameKey(name)
  if (!key) return []
  return key.startsWith('bambu ') ? [key] : [key, `bambu ${key}`]
}

function typeKeyCandidates(type: string | null | undefined): string[] {
  if (!type) return []
  const key = normalizeMaterialNameKey(type)
  return key ? [key] : []
}

/** Studio's flattened `"<support>|<model>"` map, built once from the table. */
let combinationMap: Map<string, SupportRecommendedCombination> | null = null

function lookupMap(): Map<string, SupportRecommendedCombination> {
  if (combinationMap) return combinationMap
  combinationMap = new Map()
  for (const combination of SUPPORT_RECOMMENDED_COMBINATIONS) {
    for (const supportMaterial of combination.supportMaterials) {
      combinationMap.set(`${normalizeMaterialNameKey(supportMaterial)}|${normalizeMaterialNameKey(combination.modelMaterial)}`, combination)
    }
  }
  return combinationMap
}

/**
 * The recommendation for an interface/model material pairing, or null when the table has none.
 * Probes Studio's four key combinations in its order — interface name+model name, type+name,
 * name+type, type+type — so a name pairing always beats a type pairing.
 *
 * Callers own the preconditions Studio checks before querying (a real interface selection,
 * homogeneous model materials) and the filtering of `changes` against the live config.
 */
export function querySupportRecommendedCombination(query: SupportCombinationQuery): SupportCombinationMatch | null {
  const interfaceNames = nameKeyCandidates(query.interfaceName)
  const interfaceTypes = typeKeyCandidates(query.interfaceType)
  const modelNames = nameKeyCandidates(query.modelName)
  const modelTypes = typeKeyCandidates(query.modelType)

  const probes: Array<{ interfaceKeys: string[]; modelKeys: string[]; matchedModel: 'name' | 'type' }> = [
    { interfaceKeys: interfaceNames, modelKeys: modelNames, matchedModel: 'name' },
    { interfaceKeys: interfaceTypes, modelKeys: modelNames, matchedModel: 'name' },
    { interfaceKeys: interfaceNames, modelKeys: modelTypes, matchedModel: 'type' },
    { interfaceKeys: interfaceTypes, modelKeys: modelTypes, matchedModel: 'type' }
  ]
  const map = lookupMap()
  for (const probe of probes) {
    for (const interfaceKey of probe.interfaceKeys) {
      for (const modelKey of probe.modelKeys) {
        const combination = map.get(`${interfaceKey}|${modelKey}`)
        if (combination) return { changes: combination.changes, matchedModel: probe.matchedModel }
      }
    }
  }
  return null
}
