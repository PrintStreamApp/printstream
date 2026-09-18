/**
 * Exact physical-material versus hardware-preset validation, shared by slot editors and the API.
 * Known composites cannot be downgraded to their base polymer. Unrecognized physical names
 * require an explicit catalog preset; they never silently acquire PLA defaults.
 */
import { BAMBU_FILAMENT_PRESETS, FILAMENT_PRESETS } from './filament-setup-catalog.js'

/** Canonical known material type, or null for a free-entry material we cannot classify. */
export function knownSlotMaterialType(type: string | null | undefined): string | null {
  const normalized = type?.trim().toUpperCase()
  return FILAMENT_PRESETS.find((preset) => preset.type === normalized)?.type ?? null
}

/** Filter candidate presets by physical identity, including when reopening a saved assignment. */
export function slotMaterialAllowsPreset(physicalType: string | null | undefined, presetType: string): boolean {
  const known = knownSlotMaterialType(physicalType)
  return known == null || known === knownSlotMaterialType(presetType)
}

/**
 * Null means compatible; otherwise returns a user-facing reason to disable/reject Save.
 * Unknown custom preset IDs remain usable for known matching types because the catalog is
 * not exhaustive. A known preset ID must always agree with the submitted hardware type.
 * A null physical type is for legacy clients without manual identity or a tracked spool.
 */
export function slotMaterialCompatibilityError(
  physicalType: string | null | undefined,
  hardwareType: string,
  presetId: string
): string | null {
  const hardware = knownSlotMaterialType(hardwareType)
  const preset = BAMBU_FILAMENT_PRESETS.find((entry) => entry.id === presetId)
  if (preset && preset.type !== hardwareType.trim().toUpperCase()) {
    return 'The printer material preset does not match the printer material type.'
  }

  if (physicalType == null) return null
  if (!hardware) return 'Choose a compatible printer material preset before saving.'
  if (!physicalType.trim()) return 'Enter a material type before saving.'
  const physical = knownSlotMaterialType(physicalType)
  if (physical && physical !== hardware) {
    return `Choose a ${physical} printer material preset. The compatibility preset must preserve the material type.`
  }
  if (!physical && !preset) {
    return 'Choose a compatible printer material preset for this custom material type.'
  }
  return null
}
