/**
 * Author a slice's settings INTO the project being sliced.
 *
 * A slice carries more than the 3MF: the process preset, the per-slot filament presets, the
 * per-slice and per-material setting overrides, and the plate type all travel beside the file as
 * resolved profile files and reach the CLI on the command line. The project itself never learned
 * about them, which left two problems: the project we preserve for "slice again" reopened showing
 * its ORIGINAL presets and dropped every dialog override, and a project's own settings could
 * silently outrank the chosen preset on the compatibility-fallback retry (the residual of "picked
 * Extra Fine, silently got the project's 0.20mm").
 *
 * So this runs as a step of the rewrite chain, on the project the engine is about to slice —
 * upholding the pipeline's rule that PrintStream authors the 3MF and the CLI only slices it. The
 * file we keep is then literally the file that was sliced, not a reconstruction of it.
 *
 * This is the same operation `save-retarget.ts` performs for "save for a different printer", and it
 * deliberately reuses that operation's shared pieces (`applyProcessProfileToProjectSettings`,
 * `rebindProjectFilamentPhysics`, `applyFilamentSlotOverrides`) rather than restating what each
 * setting kind means. Order is fixed by that shared composition: the machine must already be
 * authored (`authorProjectMachineFromProfile`) because the process and filament steps index the
 * topology maps it rebuilds — so this must run AFTER the machine step in the chain.
 *
 * INVARIANT, and the reason this is safe to run before the engine rather than after: the authored
 * config must describe what the engine actually did, so authoring cannot change a slice's output.
 * MEASURED, not assumed — the same project sliced with and without this pass produced identical
 * process settings in the G-code (`grid/5/monotonicline`). What that A/B also established is which
 * side wins: a process preset passed on the command line OVERRIDES the project's embedded process
 * values, so a project's `different_settings_to_system` deltas are inert once a preset is loaded.
 * This module therefore lets the preset win rather than restoring those deltas — restoring them
 * would leave the kept project describing a print that never happened (it declared
 * `3dhoneycomb/4/monotonic` while the engine used the preset's values).
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  applyFilamentSlotOverrides,
  applyProcessProfileToProjectSettings,
  canonicalCurrBedType,
  rebindProjectFilamentPhysics,
  type FilamentSlotRebind,
  type ProcessConfig,
  type SlicingFilamentMapping,
  type SlicingTarget
} from '@printstream/shared'
import { slicerClient } from './slicer-client.js'
import { resolveSlicingPresetFiles } from './slicing-presets.js'
import { readEntry, rewriteThreeMfEntries } from './three-mf-internal.js'

const PROJECT_SETTINGS_ENTRY = 'Metadata/project_settings.config'

export interface AuthorSliceSettingsInput {
  tenantId: string
  slicerTargetId: string | null | undefined
  target: SlicingTarget
  /** The project so far in the rewrite chain. Not modified; a new file is written. */
  projectPath: string
  fileName: string
}

/**
 * Write a slice's process preset, filament presets, setting overrides, and plate type into a copy of
 * the project. Returns the new path, or null when there was nothing to author (so the caller keeps
 * the file it had) or the project's settings could not be read.
 *
 * Best-effort by design and never throws: every step is independently skippable, and a slice that
 * would have worked before must still work. An unresolvable preset — notably a `project:` preset,
 * which has no separate file — leaves the project's own embedded value alone, correct because that
 * value IS the preset in that case.
 *
 * The process step lets the resolved preset win over the project's declared deltas (see the module
 * header: the engine does the same). The FILAMENT step is deliberately the other way round —
 * `rebindProjectFilamentPhysics` preserves a slot's declared keys by contract, which is right there
 * because a filament preset binds per slot rather than being loaded wholesale over the project.
 */
export async function authorSliceSettingsIntoProject(input: AuthorSliceSettingsInput): Promise<string | null> {
  const raw = await readEntry(input.projectPath, PROJECT_SETTINGS_ENTRY).catch(() => null)
  if (!raw || raw.length === 0) return null
  let settings: Record<string, unknown>
  try {
    settings = JSON.parse(raw.toString('utf8')) as Record<string, unknown>
  } catch (error) {
    // Silent here would be indistinguishable from "nothing to author": the slice still runs, but
    // the project it preserves silently keeps whatever presets it was saved with.
    console.warn(`[slice-authoring] ${input.fileName}: embedded project settings are unreadable; keeping the project as-is`, (error as Error).message)
    return null
  }

  const before = JSON.stringify(settings)

  const processConfig = await resolveProcessConfig(input)
  if (processConfig) {
    // The preset WINS over whatever the project declared, because that is what the engine did:
    // an A/B of the same project sliced with and without this pass produced identical G-code
    // (`grid/5/monotonicline`) even though the project declared `3dhoneycomb/4/monotonic` — a
    // loaded process preset overrides the project's embedded process values outright. Carrying
    // the project's deltas forward here would leave the kept project describing a print that
    // never happened, and they would be equally inert on a re-slice.
    settings = applyProcessProfileToProjectSettings(settings, processConfig, input.target.processSettingOverrides ?? {})
  } else if (input.target.processSettingOverrides) {
    // No resolvable preset (a project preset), but the overrides still happened — write them over
    // the project's own process values so they are not silently lost with the preset.
    for (const [key, value] of Object.entries(input.target.processSettingOverrides)) settings[key] = value
  }

  settings = await applyFilamentSelection(settings, input)

  const plateType = canonicalCurrBedType(input.target.plateType ?? null)
  if (plateType) settings.curr_bed_type = plateType

  const authored = JSON.stringify(settings)
  if (authored === before) return null

  const outDir = await mkdtemp(path.join(tmpdir(), 'printstream-slice-authored-'))
  const outPath = path.join(outDir, path.basename(input.fileName) || 'project.3mf')
  await rewriteThreeMfEntries(
    input.projectPath,
    outPath,
    { [PROJECT_SETTINGS_ENTRY]: () => authored },
    [{ name: PROJECT_SETTINGS_ENTRY, content: authored }]
  )
  return outPath
}

/**
 * Bind each project filament slot to the preset the slice used, then record that slice's filament
 * overrides on top.
 *
 * Two steps in this order for the same reason the retarget uses it: the rebind writes preset
 * values (and preserves anything the project already declared as a user override), and the override
 * pass then writes the session's own values AND records them in `different_settings_to_system` —
 * which is what makes them reopen as user changes rather than as invisible drift.
 */
async function applyFilamentSelection(
  settings: Record<string, unknown>,
  input: AuthorSliceSettingsInput
): Promise<Record<string, unknown>> {
  const mappings = input.target.filamentMappings ?? []
  if (mappings.length === 0) return settings

  const slotCount = Math.max(...mappings.map((mapping) => mapping.projectFilamentId))
  const configs: Array<ProcessConfig | null> = new Array(slotCount).fill(null)
  const rebinds: FilamentSlotRebind[] = new Array(slotCount).fill(null).map(() => ({ config: null }))
  const slotOverrides: Record<number, ProcessConfig> = {}

  for (const mapping of mappings) {
    const index = mapping.projectFilamentId - 1
    if (index < 0) continue
    const resolved = await resolveFilamentConfig(input, mapping)
    if (resolved) {
      configs[index] = resolved.config
      rebinds[index] = { config: resolved.config, settingsId: resolved.name }
    }
    // Slot overrides win over the slice-wide map, matching how the slicer merges them.
    const merged: ProcessConfig = { ...(input.target.filamentSettingOverrides ?? {}), ...(mapping.settingOverrides ?? {}) }
    if (Object.keys(merged).length > 0) slotOverrides[mapping.projectFilamentId] = merged
  }

  let next = settings
  if (rebinds.some((rebind) => rebind.config != null)) {
    next = rebindProjectFilamentPhysics(next, rebinds)
  }
  if (Object.keys(slotOverrides).length > 0) {
    next = applyFilamentSlotOverrides(next, slotOverrides, configs)
  }
  return next
}

async function resolveProcessConfig(input: AuthorSliceSettingsInput): Promise<ProcessConfig | null> {
  if (!input.target.processProfileId) return null
  try {
    // Skips `project:` presets, which have no separate file — those fall through to null so the
    // project keeps the embedded process that IS the preset.
    const [file] = await resolveSlicingPresetFiles(input.tenantId, [
      { id: input.target.processProfileId, kind: 'process' }
    ])
    if (!file) return null
    return await slicerClient.resolveProcessConfig(input.slicerTargetId, {
      source: file.source,
      name: file.name,
      content: file.content
    })
  } catch (error) {
    // A resolve failure costs fidelity, not the slice — the kept project keeps its own process. Worth
    // a line, because the symptom (re-slicing shows the wrong preset) is otherwise unexplainable.
    console.warn(`[slice-authoring] could not resolve process preset ${input.target.processProfileId}`, (error as Error).message)
    return null
  }
}

async function resolveFilamentConfig(
  input: AuthorSliceSettingsInput,
  mapping: SlicingFilamentMapping
): Promise<{ config: ProcessConfig; name: string } | null> {
  if (!mapping.profileId) return null
  try {
    const [file] = await resolveSlicingPresetFiles(input.tenantId, [
      { id: mapping.profileId, kind: 'filament' }
    ])
    if (!file) return null
    const config = await slicerClient.resolveFilamentConfig(input.slicerTargetId, {
      source: file.source,
      name: file.name,
      content: file.content
    })
    return config ? { config, name: file.name } : null
  } catch (error) {
    // Per SLOT, and once per slice — not a hot loop. Same reasoning as the process preset above.
    console.warn(`[slice-authoring] could not resolve filament preset ${mapping.profileId} for slot ${mapping.projectFilamentId}`, (error as Error).message)
    return null
  }
}
