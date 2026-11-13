/**
 * The final process writer for editor saves. Machine authoring cannot gate a process selection;
 * the callback reads the FINAL machine for compatibility and writes identity, values and native
 * metadata together. Resolution failures reject the save so it cannot mark unsaved edits as saved.
 */
import { applyProcessProfileToProjectSettings, firstProfileString, parseBuiltinSlicingPresetId,
  processPresetFitsMachine, type ProfileRecord, type SaveArrangedThreeMf } from '@printstream/shared'
import type { EditorBakePassOptions } from './editorBakePasses'
import type { ProcessSettingsPassContext } from './clientBakeSettingsPasses'

export function processSettingsForSave(
  target: NonNullable<SaveArrangedThreeMf['retarget']>,
  targetId: string | null,
  options: EditorBakePassOptions
): (settings: ProfileRecord, context?: ProcessSettingsPassContext) => Promise<ProfileRecord> {
  return async (settings, context) => {
    const id = target.processProfileId!
    const current = firstProfileString(settings.print_settings_id)
    const builtin = parseBuiltinSlicingPresetId(id)?.name
    if (!context?.machineRetargeted && !target.processProfileChosen && builtin && builtin === current) return settings
    options.signal?.throwIfAborted()
    if (!options.resolvers.canResolve(id)) throw new Error('The selected process preset is unavailable. Your changes have not been saved.')
    const resolved = await options.resolvers.process(id, targetId, { signal: options.signal })
    options.signal?.throwIfAborted()
    if (resolved.baselineOrigin?.kind === 'partial') throw new Error('The selected process preset has an unresolved parent. Your changes have not been saved.')
    const name = resolved.preset?.name ?? firstProfileString(resolved.config.name) ?? firstProfileString(resolved.config.print_settings_id)
    if (!name) throw new Error('The selected process preset has no identity. Your changes have not been saved.')
    const machine = firstProfileString(settings.printer_settings_id)
    if (machine && !processPresetFitsMachine(resolved.config, machine)) {
      throw new Error(`The selected process preset is incompatible with ${machine}. Your changes have not been saved.`)
    }
    if (!target.processProfileChosen && current === name) return settings
    return applyProcessProfileToProjectSettings(settings, resolved.config, target.processSettingOverrides ?? {}, {
      name, parentName: resolved.preset?.parentName ?? null, parentConfig: resolved.parentConfig
    }, context?.machineRetargeted ? { overridesLayout: context.sourceProcessLayout ?? null } : {})
  }
}
