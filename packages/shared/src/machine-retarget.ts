/**
 * Retargeting a 3MF project's `project_settings.config` to a different Bambu machine —
 * the "change the project's printer" operation, done by rewriting settings rather than
 * re-slicing. Pure functions (no I/O), shared by the API (the editor's save-as-a-different-
 * printer flow) and the slicer (the estimate-mode cross-model switch's topology repair).
 *
 * Update resilience: {@link retargetProjectSettingsToMachine} overwrites **every** key the
 * resolved machine profile defines (minus profile metadata), so when BambuStudio adds new
 * machine fields in a version bump they are carried over automatically — there is no
 * per-field allow-list to maintain here. The only BambuStudio-coupled logic is the
 * dependent-map derivation below (`repairEstimateModeProjectSettings`), which reconstructs
 * the runtime maps that depend on BOTH the machine topology and the project's filaments
 * (`filament_nozzle_map`, extruder variants, …). See docs/project-printer-retarget.md.
 */
export type ProfileRecord = Record<string, unknown>

/** Profile-level metadata keys that are NOT slice settings and must not leak into project_settings. */
const NON_SETTING_PROFILE_KEYS = new Set([
  'name',
  'type',
  'from',
  'inherits',
  'include',
  'instantiation',
  'setting_id',
  'version',
  'is_custom_defined',
  'filament_id',
  // Profile compatibility *declarations* (which printers/prints a preset is for) — not settings.
  'compatible_printers',
  'compatible_printers_condition',
  'compatible_prints',
  'compatible_prints_condition'
])

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

/**
 * Retargets `projectSettings` to `machineProfile` (a fully-resolved machine preset, with its
 * `inherits`/`include` chain already merged). Overwrites every machine-owned key, sets the
 * printer identity, then re-derives the topology-dependent runtime maps. The project's layout
 * (`model_settings.config`/build items) and filament selection are untouched.
 */
export function retargetProjectSettingsToMachine(
  projectSettings: ProfileRecord,
  machineProfile: ProfileRecord,
  target: { printerSettingsId: string; printerModel: string }
): ProfileRecord {
  const next: ProfileRecord = { ...projectSettings }
  for (const [key, value] of Object.entries(machineProfile)) {
    if (NON_SETTING_PROFILE_KEYS.has(key)) continue
    next[key] = cloneValue(value)
  }
  next.printer_settings_id = target.printerSettingsId
  next.printer_model = target.printerModel
  // Re-declare the project's printer-compatibility for the target. The source printer's
  // declarations (e.g. an A1 mini project's `print_compatible_printers: ["… @BBL A1M …"]`)
  // are NOT machine-profile settings, so the overwrite above leaves them untouched — and they
  // then surface as stale compatibility chips (an A1/A1 mini chip on an H2D project). BambuStudio
  // writes the target machine here, so we match it: set `print_compatible_printers` and, when the
  // project carries one, `compatible_printers` to the target machine preset.
  next.print_compatible_printers = [target.printerSettingsId]
  if (next.compatible_printers !== undefined) next.compatible_printers = [target.printerSettingsId]
  return repairEstimateModeProjectSettings(next, machineProfile)
}

/**
 * Brings a project's **process** (print/quality) settings over to the target printer's process
 * preset — the companion to {@link retargetProjectSettingsToMachine}. Overwrites every process-owned
 * key from the resolved process profile, sets `print_settings_id`, then applies the user's per-slice
 * overrides on top. Process keys are disjoint from machine keys, so this composes after the machine
 * retarget without clobbering it. The project's filament selection and layout are untouched.
 */
export function applyProcessProfileToProjectSettings(
  projectSettings: ProfileRecord,
  processProfile: ProfileRecord,
  overrides: Record<string, string | string[]> = {}
): ProfileRecord {
  const next: ProfileRecord = { ...projectSettings }
  for (const [key, value] of Object.entries(processProfile)) {
    if (NON_SETTING_PROFILE_KEYS.has(key)) continue
    next[key] = cloneValue(value)
  }
  const name = typeof processProfile.name === 'string' ? processProfile.name.trim() : ''
  if (name) next.print_settings_id = name
  for (const [key, value] of Object.entries(overrides)) {
    next[key] = cloneValue(value)
  }
  return next
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
