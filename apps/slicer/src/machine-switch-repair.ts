type ProfileRecord = Record<string, unknown>

const PROFILE_COPY_KEYS = [
  'change_filament_gcode',
  'default_nozzle_volume_type',
  'extruder_colour',
  'extruder_max_nozzle_count',
  'extruder_offset',
  'extruder_printable_height',
  'extruder_type',
  'extruder_variant_list',
  'machine_end_gcode',
  'machine_load_filament_time',
  'machine_start_gcode',
  'machine_unload_filament_time',
  'physical_extruder_map'
] as const

const PROFILE_DELETE_IF_MISSING_KEYS = [
  'enable_filament_dynamic_map',
  'filament_extruder_compatibility',
  'filament_map_2'
] as const

const NOZZLE_VOLUME_TYPE_INDEX: Record<string, string> = {
  standard: '0',
  'high flow': '1',
  'tpu high flow': '2'
}

export function mergeInheritedMachineProfile(profileName: string, profileRecords: ReadonlyMap<string, ProfileRecord>): ProfileRecord {
  const profile = profileRecords.get(profileName)
  if (!profile) {
    throw new Error(`Missing machine profile ${profileName}`)
  }

  const inherits = typeof profile.inherits === 'string' && profile.inherits.trim().length > 0
    ? profile.inherits.trim()
    : null

  const merged = inherits
    ? {
      ...mergeInheritedMachineProfile(inherits, profileRecords),
      ...profile
    }
    : { ...profile }

  for (const includeName of stringArray(profile.include)) {
    const includeProfile = mergeInheritedMachineProfile(includeName, profileRecords)
    mergeMissingProfileFields(merged, includeProfile)
  }

  return merged
}

export function repairEstimateModeProjectSettings(settings: ProfileRecord, machineProfile: ProfileRecord): ProfileRecord {
  const next: ProfileRecord = { ...settings }

  for (const key of PROFILE_COPY_KEYS) {
    const value = cloneValue(machineProfile[key])
    if (value !== undefined) next[key] = value
  }

  const volumeTypes = stringArray(next.default_nozzle_volume_type)
  const maxNozzleCounts = stringArray(next.extruder_max_nozzle_count)
  const physicalExtruderMap = stringArray(next.physical_extruder_map)
  const derivedPrinterVariants = buildPrinterExtruderVariants(stringArray(next.extruder_variant_list))
  const printerExtruderVariants = derivedPrinterVariants.length > 0
    ? derivedPrinterVariants
    : stringArray(next.printer_extruder_variant)

  if (derivedPrinterVariants.length > 0) {
    next.printer_extruder_variant = derivedPrinterVariants
    next.printer_extruder_id = buildPrinterExtruderIds(stringArray(next.extruder_variant_list))
  }

  if (printerExtruderVariants.length > 0) {
    next.filament_extruder_variant = buildFilamentExtruderVariants(
      printerExtruderVariants,
      stringArray(next.filament_type)
    )
  }

  if (physicalExtruderMap.length > 0) {
    next.filament_nozzle_map = physicalExtruderMap
  }

  if (volumeTypes.length > 0) {
    next.filament_volume_map = volumeTypes.map(mapNozzleVolumeTypeToIndex)
  }

  if (volumeTypes.length > 0 && maxNozzleCounts.length > 0) {
    next.extruder_nozzle_stats = maxNozzleCounts.map((count, index) => {
      const volumeType = volumeTypes[Math.min(index, volumeTypes.length - 1)] ?? 'Standard'
      return `${volumeType}#${count}`
    })
  }

  if (physicalExtruderMap.length > 1) {
    next.extruder_ams_count = buildExtruderAmsCount(stringArray(next.extruder_ams_count), physicalExtruderMap.length)
  }

  for (const key of PROFILE_DELETE_IF_MISSING_KEYS) {
    if (machineProfile[key] === undefined) {
      delete next[key]
    }
  }

  return next
}

function mapNozzleVolumeTypeToIndex(value: string): string {
  return NOZZLE_VOLUME_TYPE_INDEX[value.trim().toLowerCase()] ?? '0'
}

function buildExtruderAmsCount(existingValues: string[], extruderCount: number): string[] {
  if (existingValues.length === extruderCount) {
    return existingValues.map((value) => value.endsWith('|4#0') ? `${value.slice(0, -4)}|4#1` : value || '1#0|4#1')
  }
  return Array.from({ length: extruderCount }, () => '1#0|4#1')
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : typeof value === 'string' && value.trim().length > 0
      ? [value.trim()]
      : []
}

function buildPrinterExtruderVariants(variantList: string[]): string[] {
  return variantList.flatMap((value) => value.split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0))
}

function buildPrinterExtruderIds(variantList: string[]): string[] {
  return variantList.flatMap((value, index) => {
    const variants = value.split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0)
    return Array.from({ length: variants.length }, () => String(index + 1))
  })
}

function buildFilamentExtruderVariants(printerExtruderVariants: string[], filamentTypes: string[]): string[] {
  const sharedVariants = uniqueVariants(printerExtruderVariants.filter((variant) => !/\btpu\b/i.test(variant)))
  const fallbackVariants = sharedVariants.length > 0 ? sharedVariants : uniqueVariants(printerExtruderVariants)
  if (filamentTypes.length === 0) return fallbackVariants

  return filamentTypes.flatMap((filamentType) => {
    if (/\btpu\b/i.test(filamentType)) return uniqueVariants(printerExtruderVariants)
    return fallbackVariants
  })
}

function uniqueVariants(variants: string[]): string[] {
  const ordered = new Set<string>()
  for (const variant of variants) {
    if (variant.trim().length > 0) ordered.add(variant)
  }
  return Array.from(ordered)
}

function mergeMissingProfileFields(target: ProfileRecord, source: ProfileRecord): void {
  for (const [key, value] of Object.entries(source)) {
    if (!hasMeaningfulProfileValue(target[key]) && hasMeaningfulProfileValue(value)) {
      target[key] = cloneValue(value)
    }
  }
}

function hasMeaningfulProfileValue(value: unknown): boolean {
  if (value == null) return false
  if (typeof value === 'string') return value.trim().length > 0
  if (Array.isArray(value)) return value.length > 0
  return true
}

function cloneValue(value: unknown): unknown {
  if (Array.isArray(value)) return [...value]
  return value
}