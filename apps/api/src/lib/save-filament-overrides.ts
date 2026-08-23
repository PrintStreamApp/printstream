/**
 * Persists the material tune dialog's "Save in this 3MF" overrides into a freshly-baked project:
 * the save-side half the feature was missing (the overrides previously lived only in controller
 * state and rode slice requests; a save/reopen silently lost them).
 *
 * Runs on the baked 3MF BEFORE the machine retarget in the save route: the shared writer
 * (`applyFilamentSlotOverrides`) records every written key in `different_settings_to_system`,
 * which is exactly what makes `retargetSavedProjectMachine`'s fossil rebind PRESERVE the edit on
 * a later (or same-save) machine switch instead of rebinding it away.
 *
 * Best-effort like the other save-side improvement passes: returns null (caller keeps the input
 * path) when there is nothing to write, the settings are unreadable, or preset resolution fails,
 * a save must never fail because an override could not be persisted; the override still rides the
 * slice request either way.
 *
 * Counterparts: `FilamentSettingsDialog` (authors the overrides), `cli-profile-selection.ts` in
 * apps/slicer (the slice-time collapse of the same data).
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { applyFilamentSlotOverrides, type ProcessConfig } from '@printstream/shared'
import { resolveFilamentSlotRebinds } from './save-retarget.js'
import { readEntry, rewriteThreeMfEntries } from './three-mf-internal.js'

const PROJECT_SETTINGS_ENTRY = 'Metadata/project_settings.config'

export async function persistFilamentSettingOverrides(input: {
  workspaceId: string
  arrangedPath: string
  fileName: string
  slicerTargetId: string | null | undefined
  /** 1-based SAVED slot position -> sparse filament-config overrides (see the save schema). */
  overrides: Record<string, ProcessConfig>
}): Promise<string | null> {
  const byPosition: Record<number, ProcessConfig> = {}
  for (const [key, value] of Object.entries(input.overrides)) {
    const position = Number(key)
    if (Number.isInteger(position) && position >= 1 && value && Object.keys(value).length > 0) byPosition[position] = value
  }
  if (Object.keys(byPosition).length === 0) return null

  const raw = await readEntry(input.arrangedPath, PROJECT_SETTINGS_ENTRY).catch(() => null)
  if (!raw || raw.length === 0) return null
  let record: Record<string, unknown>
  try {
    record = JSON.parse(raw.toString('utf8')) as Record<string, unknown>
  } catch {
    return null
  }

  // The slot preset configs fill non-overridden slots when a written key's column set must be
  // created from scratch. Resolved against the project's OWN machine (this pass never switches
  // it); a failed resolution degrades to "only keys already present can be written".
  const targetModel = firstString(record.printer_model) ?? firstString(record.printer_settings_id) ?? ''
  const rebinds = targetModel
    ? await resolveFilamentSlotRebinds({
        workspaceId: input.workspaceId,
        slicerTargetId: input.slicerTargetId,
        record,
        targetModel,
        nozzleHint: firstString(record.printer_settings_id) ?? targetModel
      })
    : null
  const slotConfigs = Array.isArray(record.filament_settings_id)
    ? record.filament_settings_id.map((_name, index) => rebinds?.[index]?.config ?? null)
    : []

  const next = applyFilamentSlotOverrides(record, byPosition, slotConfigs)
  if (next === record) return null

  const outDir = await mkdtemp(path.join(tmpdir(), 'printstream-filament-overrides-'))
  const outPath = path.join(outDir, path.basename(input.fileName) || 'overrides.3mf')
  const nextJson = JSON.stringify(next)
  await rewriteThreeMfEntries(
    input.arrangedPath,
    outPath,
    { [PROJECT_SETTINGS_ENTRY]: () => nextJson },
    [{ name: PROJECT_SETTINGS_ENTRY, content: nextJson }]
  )
  return outPath
}

function firstString(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (Array.isArray(value)) {
    const first = value.find((entry) => typeof entry === 'string' && entry.trim())
    return typeof first === 'string' ? first.trim() : null
  }
  return null
}
