/**
 * The flushing dialog's machine context, for the printer the user has SELECTED.
 *
 * `readProjectFlushContext` reads the project's stored settings, which describe the machine the
 * file was saved for. After a printer switch that is the wrong machine: a P1P project switched to
 * an H2D showed one purge grid computed from the P1P's dead volume, and the bake then silently
 * dropped the edit because its block count no longer matched the new extruder count. Bambu Studio
 * recomputes flushing for the printer that is selected, so this previews the same retarget the
 * save and slice will write (`retargetProjectSettingsToMachine`, which also re-derives the matrix
 * sizing) and reads the context from that.
 *
 * Pure. The machine is resolved by the caller through the editor's save target, so this sees the
 * exact config the bake will use.
 */
import {
  firstProfileString,
  readProjectFlushContext,
  retargetProjectSettingsToMachine,
  type ProfileRecord,
  type ProjectFlushContext
} from '@printstream/shared'

/**
 * @param projectSettingsJson the opened project's `project_settings.config`
 * @param machine the selected printer preset, resolved; null while unresolved or unresolvable,
 *   which reads the project as stored (the pre-fix behaviour, and right when nothing was switched)
 */
export function flushContextForSelectedMachine(
  projectSettingsJson: string | null | undefined,
  machine: { config: ProfileRecord; name: string } | null
): ProjectFlushContext | null {
  if (!projectSettingsJson || !machine) return readProjectFlushContext(projectSettingsJson)

  let settings: ProfileRecord
  try {
    settings = JSON.parse(projectSettingsJson) as ProfileRecord
  } catch {
    return readProjectFlushContext(projectSettingsJson)
  }
  // The project's own printer: nothing to preview, and a no-op retarget could still normalise
  // values the user never touched.
  if (firstProfileString(settings.printer_settings_id) === machine.name) return readProjectFlushContext(projectSettingsJson)

  const retargeted = retargetProjectSettingsToMachine(settings, machine.config, {
    printerSettingsId: machine.name,
    printerModel: firstProfileString(machine.config.printer_model) ?? machine.name
  })
  return readProjectFlushContext(JSON.stringify(retargeted))
}
