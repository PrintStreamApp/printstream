/**
 * Validates the bytes behind a browser-prepared-v1 slicing proof.
 *
 * The browser owns project authoring. This server boundary therefore limits untrusted archives,
 * verifies the required package/settings shape, and checks the explicitly submitted target. It
 * deliberately does not resolve preset bodies, weld meshes, or rebuild the browser's output.
 */
import {
  canonicalBambuModelKey,
  canonicalCurrBedType,
  collectSettingsRepairReasons,
  dropEngineHostileOverrides,
  filamentKeyWidth,
  filamentSlotCount,
  filamentVariantRowsPerSlot,
  isFilamentVariantOption,
  parseSlicingPresetId,
  type SlicingTarget
} from '@printstream/shared'
import {
  buildManualNozzleAssignment,
  modelSettingsCarriesManualFilamentMap,
  readAuthoredManualFilamentMap,
  THREE_MF_MODEL_ENTRY,
  THREE_MF_MODEL_RELS_ENTRY,
  THREE_MF_MODEL_SETTINGS_ENTRY,
  THREE_MF_PROJECT_SETTINGS_ENTRY
} from '@printstream/shared/three-mf'
import { badRequest } from './http-error.js'
import { readEntry, validateZipArchiveLimits } from './three-mf-internal.js'

const REQUIRED_PACKAGE_ENTRIES = ['[Content_Types].xml', '_rels/.rels', THREE_MF_MODEL_RELS_ENTRY] as const
const MAX_MODEL_ENTRY_BYTES = 64 * 1024 * 1024
export const MAX_PREPARED_ARCHIVE_ENTRIES = 4_096
export const MAX_PREPARED_ARCHIVE_UNCOMPRESSED_BYTES = 2 * 1024 * 1024 * 1024
export const MAX_PREPARED_ARCHIVE_ENTRY_BYTES = 256 * 1024 * 1024

export interface PreparedSlicingValidationInput {
  projectPath: string
  target: SlicingTarget
  /** Current server-owned model for a real-printer target. */
  printerModel?: string | null
  /** Optional tighter host-specific archive budget, such as the anonymous queue's limit. */
  maxUncompressedBytes?: number
}

/** Fail closed unless `projectPath` is a complete, target-consistent browser-prepared-v1 project. */
export async function validatePreparedSlicingProject(input: PreparedSlicingValidationInput): Promise<void> {
  let rootModelXml: string
  let modelSettingsXml: string
  let projectSettingsJson: string
  try {
    await validateZipArchiveLimits(input.projectPath, {
      maxEntries: MAX_PREPARED_ARCHIVE_ENTRIES,
      maxUncompressedBytes: input.maxUncompressedBytes ?? MAX_PREPARED_ARCHIVE_UNCOMPRESSED_BYTES,
      maxEntryBytes: MAX_PREPARED_ARCHIVE_ENTRY_BYTES
    })
    const [rootModel, modelSettings, projectSettings, ...packageEntries] = await Promise.all([
      readEntry(input.projectPath, THREE_MF_MODEL_ENTRY, undefined, MAX_MODEL_ENTRY_BYTES),
      readEntry(input.projectPath, THREE_MF_MODEL_SETTINGS_ENTRY),
      readEntry(input.projectPath, THREE_MF_PROJECT_SETTINGS_ENTRY),
      ...REQUIRED_PACKAGE_ENTRIES.map((entry) => readEntry(input.projectPath, entry))
    ])
    // Keep the package reads load-bearing: Promise.all must establish every required entry.
    void packageEntries
    rootModelXml = rootModel.toString('utf8')
    modelSettingsXml = modelSettings.toString('utf8')
    projectSettingsJson = projectSettings.toString('utf8')
  } catch {
    fail('The prepared project is incomplete or unreadable. Prepare it again.')
  }

  if (!/<metadata\s+name="Application"[^>]*>BambuStudio-[^<]+<\/metadata>/.test(rootModelXml)) {
    fail('The prepared project is missing its BambuStudio application marker. Prepare it again.')
  }
  if (!/<model\b[\s\S]*<\/model>/.test(rootModelXml)
    || !/<resources\b[\s\S]*<\/resources>/.test(rootModelXml)
    || !/<build\b[\s\S]*<\/build>/.test(rootModelXml)
    || !/<item\b/.test(rootModelXml)) {
    fail('The prepared project has an incomplete root model. Prepare it again.')
  }
  if (!/<config\b[\s\S]*<\/config>/.test(modelSettingsXml)) {
    fail('The prepared project has unreadable model settings. Prepare it again.')
  }

  let settings: Record<string, unknown>
  try {
    const parsed = JSON.parse(projectSettingsJson) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
    settings = parsed as Record<string, unknown>
  } catch {
    fail('The prepared project has unreadable project settings. Prepare it again.')
  }

  assertCompleteProjectSettings(settings, projectSettingsJson, modelSettingsXml)
  assertNoPostProcessingScripts(settings)
  assertFrozenTarget(settings, modelSettingsXml, input.target, input.printerModel)
}

/** Host commands can never inherit the public caller's consent, so they must be absent server-side. */
function assertNoPostProcessingScripts(settings: Record<string, unknown>): void {
  const value = settings.post_process
  const present = typeof value === 'string'
    ? value.trim().length > 0
    : Array.isArray(value) && value.some((entry) => typeof entry === 'string' && entry.trim().length > 0)
  if (present) fail('Post-processing scripts cannot run on the public slicing server.')
}

function assertCompleteProjectSettings(
  settings: Record<string, unknown>,
  projectSettingsJson: string,
  modelSettingsXml: string
): void {
  for (const key of ['printer_settings_id', 'printer_model', 'print_settings_id'] as const) {
    if (!firstString(settings[key])) fail(`The prepared project is missing ${key}. Prepare it again.`)
  }

  const slotCount = filamentSlotCount(settings)
  if (slotCount < 1) fail('The prepared project has no authoritative filament slots. Prepare it again.')
  for (const key of ['filament_settings_id', 'filament_type', 'filament_colour', 'filament_diameter'] as const) {
    const values = strictStringArray(settings[key])
    if (!values || values.length !== slotCount || values.some((value) => !value.trim())) {
      fail(`The prepared project's ${key} does not describe every filament slot. Prepare it again.`)
    }
  }

  const repairs = collectSettingsRepairReasons(projectSettingsJson, modelSettingsXml)
  if (repairs.length > 0) {
    fail(`The prepared project still has invalid settings (${repairs.join(', ')}). Prepare it again.`)
  }
}

function assertFrozenTarget(
  settings: Record<string, unknown>,
  modelSettingsXml: string,
  target: SlicingTarget,
  printerModel?: string | null
): void {
  const machineProfileId = target.printerProfileId
  if (!machineProfileId) fail('The prepared slicing target does not identify a printer preset.')
  assertPresetIdentity(settings, 'printer_settings_id', machineProfileId, 'machine')
  if (target.processProfileId) assertPresetIdentity(settings, 'print_settings_id', target.processProfileId, 'process')

  const expectedPrinterModel = target.mode === 'manualProfile' ? target.printerModel : printerModel
  if (expectedPrinterModel) {
    const expectedModel = canonicalBambuModelKey(expectedPrinterModel)
    const actualModel = canonicalBambuModelKey(firstString(settings.printer_model) ?? '')
    if (expectedModel && actualModel ? expectedModel !== actualModel : !sameText(firstString(settings.printer_model), expectedPrinterModel)) {
      fail('The prepared project does not match the selected printer model.')
    }
  }

  const plateType = canonicalCurrBedType(target.plateType ?? null)
  if (plateType && canonicalCurrBedType(firstString(settings.curr_bed_type)) !== plateType) {
    fail('The prepared project does not match the selected build plate.')
  }

  assertTopLevelOverrides(settings, dropEngineHostileOverrides(target.processSettingOverrides ?? {}), 'process')
  assertTopLevelOverrides(settings, target.machineSettingOverrides ?? {}, 'machine')
  assertFilamentMappings(settings, modelSettingsXml, target)
}

function assertPresetIdentity(
  settings: Record<string, unknown>,
  key: 'printer_settings_id' | 'print_settings_id',
  profileId: string,
  kind: 'machine' | 'process'
): void {
  const parsed = parseSlicingPresetId(profileId)
  if (parsed?.kind && parsed.kind !== kind) fail(`The selected ${kind} preset has the wrong preset kind.`)
  if (parsed?.name && !sameText(firstString(settings[key]), parsed.name)) {
    fail(`The prepared project does not contain the selected ${kind} preset.`)
  }
}

function assertTopLevelOverrides(
  settings: Record<string, unknown>,
  overrides: Record<string, string | string[]>,
  domain: 'machine' | 'process'
): void {
  for (const [key, expected] of Object.entries(overrides)) {
    if (!sameConfigValue(settings[key], expected)) {
      fail(`The prepared project is missing the selected ${domain} setting ${key}.`)
    }
  }
}

function assertFilamentMappings(
  settings: Record<string, unknown>,
  modelSettingsXml: string,
  target: SlicingTarget
): void {
  const mappings = target.filamentMappings ?? []
  const slotCount = filamentSlotCount(settings)
  const names = strictStringArray(settings.filament_settings_id) ?? []
  const materials = strictStringArray(settings.filament_type) ?? []
  const colors = strictStringArray(settings.filament_colour) ?? []
  const nozzleMap = strictStringArray(settings.filament_nozzle_map)
  const seen = new Set<number>()

  if (Object.keys(target.filamentSettingOverrides ?? {}).length > 0 && mappings.length === 0) {
    fail('The prepared project cannot match the selected material settings to project materials.')
  }

  for (const mapping of mappings) {
    const slot = mapping.projectFilamentId
    if (slot < 1 || slot > slotCount || seen.has(slot)) {
      fail('The prepared project does not have a unique slot for every selected material.')
    }
    seen.add(slot)

    if (mapping.profileId) {
      const parsed = parseSlicingPresetId(mapping.profileId)
      if (parsed?.kind && parsed.kind !== 'filament') fail('A selected material preset has the wrong preset kind.')
      if (parsed?.name && !sameText(names[slot - 1], parsed.name)) {
        fail(`Material ${slot} does not contain the selected preset.`)
      }
    }
    if (mapping.materialType && !sameTextCaseInsensitive(materials[slot - 1], mapping.materialType)) {
      fail(`Material ${slot} is ${materials[slot - 1] ?? 'unknown'}, but ${mapping.materialType} was selected.`)
    }
    if (mapping.color && !sameTextCaseInsensitive(colors[slot - 1], mapping.color)) {
      fail(`Material ${slot} no longer matches the selected colour.`)
    }

    const nozzleId = parseToolheadNozzleId(mapping.toolheadId)
    if (nozzleId != null && Number.parseInt(nozzleMap?.[slot - 1] ?? '', 10) !== nozzleId) {
      fail(`Material ${slot} is not assigned to the selected nozzle.`)
    }

    const effectiveOverrides = {
      ...(target.filamentSettingOverrides ?? {}),
      ...(mapping.settingOverrides ?? {})
    }
    assertFilamentOverrides(settings, slot, slotCount, effectiveOverrides)
  }

  const expectedManual = buildManualNozzleAssignment(settings, mappings)
  let actualManual: string[] | null
  try {
    actualManual = readAuthoredManualFilamentMap(settings)
  } catch {
    fail('The prepared project has an invalid manual filament mapping.')
  }
  if (expectedManual) {
    if (!actualManual || !sameStringArray(actualManual, expectedManual.filament_map)) {
      fail('The prepared project does not contain the selected nozzle assignments.')
    }
  } else if (actualManual !== null || modelSettingsCarriesManualFilamentMap(modelSettingsXml)) {
    fail('The prepared project contains a manual nozzle assignment that was not selected.')
  }
}

function assertFilamentOverrides(
  settings: Record<string, unknown>,
  slot: number,
  slotCount: number,
  overrides: Record<string, string | string[]>
): void {
  const variantRows = filamentVariantRowsPerSlot(settings, slotCount)
  for (const [key, expected] of Object.entries(dropEngineHostileOverrides(overrides))) {
    if (!variantRows && isFilamentVariantOption(key)) {
      fail('The prepared project has an unreadable material-variant layout.')
    }
    const actual = strictStringArray(settings[key])
    if (!actual) fail(`Material ${slot} is missing the selected setting ${key}.`)
    const widths = variantRows
      ? variantRows.map((rows) => filamentKeyWidth(key, rows))
      : Array.from({ length: slotCount }, () => 1)
    const offset = widths.slice(0, slot - 1).reduce((sum, width) => sum + width, 0)
    const width = widths[slot - 1]!
    const expectedValues = Array.isArray(expected) ? expected : [expected]
    for (let variant = 0; variant < Math.min(width, expectedValues.length); variant += 1) {
      if (actual[offset + variant] !== expectedValues[variant]) {
        fail(`Material ${slot} is missing the selected setting ${key}.`)
      }
    }
  }
}

function parseToolheadNozzleId(value: string | null | undefined): number | null {
  const match = value?.match(/^nozzle-(\d+)$/)
  const parsed = Number.parseInt(match?.[1] ?? '', 10)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null
}

function firstString(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0].trim() || null
  return null
}

function strictStringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? value : null
}

function sameText(left: string | null | undefined, right: string | null | undefined): boolean {
  return left?.trim() === right?.trim()
}

function sameTextCaseInsensitive(left: string | null | undefined, right: string | null | undefined): boolean {
  return left?.trim().toLowerCase() === right?.trim().toLowerCase()
}

function sameConfigValue(actual: unknown, expected: string | string[]): boolean {
  if (typeof expected === 'string') return actual === expected
  return strictStringArray(actual) != null && sameStringArray(actual as string[], expected)
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function fail(message: string): never {
  throw badRequest(message)
}
