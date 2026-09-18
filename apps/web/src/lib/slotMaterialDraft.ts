/** Shared manual/inventory draft conversion and exact-type hardware fallback for slot editors. */
import { resolveFilamentIdentity, knownSlotMaterialType, slotMaterialAllowsPreset, type SlotMaterialIdentity } from '@printstream/shared'
import { BAMBU_FILAMENT_PRESETS } from '../data/filamentSetupCatalog'

/** Retain the physical name independently from whatever compatibility preset the printer reports. */
export function slotMaterialDraft(tray: Parameters<typeof resolveFilamentIdentity>[0]): SlotMaterialIdentity {
  const identity = resolveFilamentIdentity(tray)
  return { brand: identity.brand, filamentType: identity.type ?? 'PLA', materialSubtype: identity.subtype, colorName: identity.colorName }
}

/** Unknown types require an explicit compatibility choice; reinforced materials never fall back to a base polymer. */
export function genericSlotMaterial(type: string): { type: string; presetId: string } | null {
  const supported = knownSlotMaterialType(type)
  if (!supported) return null
  const preset = BAMBU_FILAMENT_PRESETS.find((entry) => entry.name === `Generic ${supported}`)
  return { type: supported, presetId: preset?.id ?? '' }
}

/** Preserve an explicit compatibility preset for an unusual inventory material, otherwise use its exact generic type. */
export function inventorySlotMaterial(type: string, presetId?: string | null): { type: string; presetId: string } | null {
  const generic = genericSlotMaterial(type)
  const chosen = BAMBU_FILAMENT_PRESETS.find((preset) => preset.id === presetId)
  if (chosen && slotMaterialAllowsPreset(type, chosen.type)) {
    return { type: chosen.type, presetId: chosen.id }
  }
  return generic
}

/** Select a branded product only on an exact identity match, otherwise preserve the generic material type. */
export function automaticSlotMaterial(identity: Pick<SlotMaterialIdentity, 'brand' | 'filamentType' | 'materialSubtype'>): { type: string; presetId: string } | null {
  const normalize = (value: string) => value.trim().toLowerCase().replace(/^bambu lab\b/, 'bambu')
  const brand = normalize(identity.brand ?? '')
  const product = normalize(identity.materialSubtype ?? '')
  const names = new Set(product ? [product, `${brand} ${product}`] : [`${brand} ${normalize(identity.filamentType)}`])
  const exact = BAMBU_FILAMENT_PRESETS.find((preset) =>
    brand !== '' && normalize(preset.brand) === brand
    && slotMaterialAllowsPreset(identity.filamentType, preset.type)
    && names.has(normalize(preset.name))
  )
  if (exact) return { type: exact.type, presetId: exact.id }
  return genericSlotMaterial(identity.filamentType)
}
