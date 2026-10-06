/**
 * Materialize CLI profile files and build complete positional filament arguments.
 *
 * `--load-settings` presets override embedded project values, so explicit machine/process
 * overrides are written into their files. `--load-filaments` has exactly one entry per project
 * slot or is omitted entirely; a short list can silently replace materials and crash the engine.
 * Prepared projects can skip request filament profiles to keep authored settings authoritative.
 */
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ProcessConfig, SlicingPresetFile } from '@printstream/shared'
import { buildFilamentSlotCoverage, type FilamentSlotRequest } from './filament-slot-coverage.js'
import { materializePortableBedAssets } from './portable-bed-assets.js'
import { sanitizeProfileFileName } from './profile-file-name.js'
import { sanitizeBuiltinSlicerProfileJson } from './profile-json.js'
import { resolveCustomProfileConfig } from './custom-profile-resolve.js'
import { readThreeMfProjectSettings } from './three-mf-project-settings.js'

/** Build CLI settings arguments, preserving complete per-slot filament coverage. */
export async function prepareProfileArgs(input: {
  profileFiles: SlicingPresetFile[]
  workDir: string
  profileDir: string
  /**
   * The 3MF the CLI will actually load, already carrying the request's per-slot
   * choices in `filament_settings_id` (the pre-slice metadata rewrite ran in
   * `prepareInputThreeMf`). It is the authority for the filament slot COUNT.
   */
  inputPath: string
  /** The request's filament mappings, one per project filament slot. */
  filamentSlots: readonly FilamentSlotRequest[]
  processSettingOverrides?: Record<string, string | string[]>
  machineSettingOverrides?: Record<string, string | string[]>
  filamentSettingOverrides?: Record<string, string | string[]>
  /** Per-material "tune" overrides keyed by 1-based project filament slot. */
  perMaterialFilamentOverrides?: Record<number, Record<string, string | string[]>>
  /** False for prepared input, whose embedded filament settings must remain authoritative. */
  includeFilamentProfiles?: boolean
  /** Surfaces slot-coverage decisions into the job's output so they are not invisible. */
  log?: (message: string) => void
}): Promise<string[]> {
  const settingsPaths: string[] = []
  const customDir = path.join(input.workDir, 'profiles')
  const processSettingOverrides = input.processSettingOverrides ?? {}
  const machineSettingOverrides = input.machineSettingOverrides ?? {}
  const filamentSettingOverrides = input.filamentSettingOverrides ?? {}
  const perMaterialFilamentOverrides = input.perMaterialFilamentOverrides ?? {}

  // Non-filament presets materialize once each; filaments materialize PER SLOT below,
  // because two slots may share a preset yet carry different per-material tunes.
  const filamentFilesById = new Map<string, SlicingPresetFile>()
  for (const profile of input.profileFiles) {
    if (profile.kind === 'filament') {
      filamentFilesById.set(profile.id, profile)
      continue
    }
    // `--load-settings` presets WIN over the project's embedded values, so a project-local
    // override has to be baked into the preset file the CLI loads, not just into the 3MF. That is
    // already why the process preset is materialized with its overrides; the machine preset needs
    // it for the same reason, or an edited printer is silently reverted to stock at slice time.
    const presetOverrides = profile.kind === 'process'
      ? processSettingOverrides
      : profile.kind === 'machine' ? machineSettingOverrides : undefined
    settingsPaths.push(await materializeProfileFile(profile, customDir, input.profileDir, presetOverrides))
  }

  if (input.includeFilamentProfiles === false) {
    return settingsPaths.length > 0 ? ['--load-settings', settingsPaths.join(';')] : []
  }

  // `--load-filaments` is POSITIONAL: one entry per project slot, or none at all.
  // Pushing only the presets the request resolved to a file sent a short list
  // whenever a slot stayed on the project's own preset, which BambuStudio then
  // broadcast across every slot before segfaulting (issue #66).
  const embeddedSettings = await readThreeMfProjectSettings(input.inputPath).catch((error: unknown) => {
    // Not fatal, the request's own mappings still give a slot count, but it costs us
    // the per-slot preset names, so say so rather than silently degrading coverage.
    console.warn('[slicer] could not read embedded project settings for filament slot coverage', (error as Error).message)
    return null
  })
  const embeddedPresetNames = stringArrayValue(embeddedSettings?.filament_settings_id)
  // Supplied filament files indexed by their preset NAME, so a slot that stayed on the project's
  // own preset can still be covered by it: the API sends the workspace presets a project names, and
  // those are reachable here only by name, never by a profile id the request did not carry.
  const suppliedProfileIdsByName = new Map<string, string>()
  for (const [profileId, profile] of filamentFilesById) {
    const name = profile.name?.trim()
    // First writer wins: two files of one name is a catalogue problem, and picking the later one
    // would make coverage depend on map order rather than on anything the user can see.
    if (name && !suppliedProfileIdsByName.has(name)) suppliedProfileIdsByName.set(name, profileId)
  }
  const slotSources = await buildFilamentSlotCoverage({
    slots: input.filamentSlots,
    requestedProfileIds: new Set(filamentFilesById.keys()),
    suppliedProfileIdsByName,
    embeddedPresetNames,
    hasBuiltinPreset: (name) => builtinFilamentPresetExists(input.profileDir, name)
  })
  const slotCount = Math.max(input.filamentSlots.length, embeddedPresetNames.length)
  if (!slotSources && slotCount > 0) {
    // The invariant chose "no filament presets" over a short list. Record it: an
    // unexplained absence here is what made the out-of-bounds crash opaque before.
    input.log?.(`No filament preset covers all ${slotCount} project slots: slicing from the project's own embedded settings instead.`)
  }

  const filamentPaths: string[] = []
  for (const [index, source] of (slotSources ?? []).entries()) {
    const slotNumber = index + 1
    // Slot-scoped overrides on a slot-unique output path: materializing by profile id
    // let two slots sharing a preset clobber each other's tune.
    const overrides = { ...filamentSettingOverrides, ...(perMaterialFilamentOverrides[slotNumber] ?? {}) }
    const profile: SlicingPresetFile = source.origin === 'requested'
      ? { ...(filamentFilesById.get(source.profileId) as SlicingPresetFile), id: `filament-slot-${slotNumber}` }
      : { id: `filament-slot-${slotNumber}`, source: 'builtin', kind: 'filament', name: source.name }
    filamentPaths.push(await materializeProfileFile(profile, customDir, input.profileDir, overrides))
  }

  const args: string[] = []
  if (settingsPaths.length > 0) args.push('--load-settings', settingsPaths.join(';'))
  if (filamentPaths.length > 0) args.push('--load-filaments', filamentPaths.join(';'))
  return args
}

/** Trimmed non-empty strings of a `ConfigOptionStrings` value, preserving slot order. */
function stringArrayValue(value: unknown): string[] {
  return Array.isArray(value) ? value.map((entry) => typeof entry === 'string' ? entry : '') : []
}

/** Whether a bundled builtin filament preset of this name exists in the catalogue. */
async function builtinFilamentPresetExists(profileDir: string, name: string): Promise<boolean> {
  const filePath = path.join(profileDir, 'filament_full', `${sanitizeProfileFileName(name)}.json`)
  return access(filePath).then(() => true, () => false)
}

async function materializeProfileFile(
  profile: SlicingPresetFile,
  outputDir: string,
  profileDir: string,
  overrides?: Record<string, string | string[]>
): Promise<string> {
  await mkdir(outputDir, { recursive: true })
  const profilePath = path.join(outputDir, `${sanitizeProfileFileName(profile.id)}.json`)

  if (profile.source === 'builtin') {
    const builtinContent = await readFile(
      path.join(profileDir, `${profile.kind}_full`, `${sanitizeProfileFileName(profile.name)}.json`),
      'utf8'
    )
    const sanitized = sanitizeBuiltinSlicerProfileJson(builtinContent)
    if (overrides && Object.keys(overrides).length > 0) {
      await writeFile(profilePath, applyProfileSettingOverrides(sanitized, overrides))
      return profilePath
    }
    await writeFile(profilePath, sanitized)
    return profilePath
  }

  if (!profile.content) {
    throw new Error(`Custom ${profile.kind} profile ${profile.name} is missing content`)
  }

  // Custom (User) presets are sparse diffs and the BambuStudio CLI does not resolve a
  // process/machine profile's `inherits` chain on --load-settings, so merge the diff onto its
  // system base before handing it to the CLI.
  let resolved = await resolveCustomProfileConfig(profile.content, profile.kind, profileDir) as ProcessConfig
  if (overrides && Object.keys(overrides).length > 0) {
    for (const [key, value] of Object.entries(overrides)) resolved[key] = value
  }
  if (profile.kind === 'machine') {
    resolved = await materializePortableBedAssets(resolved, outputDir)
  }
  await writeFile(profilePath, `${JSON.stringify(resolved, null, 2)}\n`)
  return profilePath
}

/** Apply verbatim override values to serialized builtin profile JSON. */
function applyProfileSettingOverrides(profileJson: string, overrides: Record<string, string | string[]>): string {
  const parsed = JSON.parse(profileJson) as Record<string, unknown>
  for (const [key, value] of Object.entries(overrides)) parsed[key] = value
  return `${JSON.stringify(parsed, null, 2)}\n`
}
