/**
 * Applies one process-settings dialog to an object selection. Every selected
 * object's map remains explicit, including a cleared map, so a later save can
 * remove settings inherited from the source archive.
 */
import type { ProcessSettingOverrides } from '@printstream/shared'
import { applyBulkOverridesToMember } from '../../../lib/processBulkOverrides'
import type { EditorInstance } from './editorModel'

export interface EditorObjectProcessSettingsTarget {
  ids: ReadonlyArray<number>
  name: string
}

export type EditorObjectProcessOverrides = Record<string, ProcessSettingOverrides>

/** Build the dialog target from the clicked object's current selection on the active plate. */
export function editorObjectProcessSettingsTarget(
  instances: ReadonlyArray<EditorInstance>,
  selectedKeys: ReadonlyArray<string>
): EditorObjectProcessSettingsTarget | null {
  const keys = new Set(selectedKeys)
  const ids: number[] = []
  let firstName = ''
  for (const instance of instances) {
    if (!keys.has(instance.key)) continue
    const ownerId = instance.source.kind === 'object' ? instance.objectId : instance.source.replacedObjectId
    if (ownerId == null || ids.includes(ownerId)) continue
    ids.push(ownerId)
    if (!firstName) firstName = instance.name
  }
  if (ids.length === 0) return null
  return { ids, name: ids.length > 1 ? `${ids.length} objects` : firstName }
}

/** Return one override map per selected object, preserving selection order. */
export function readEditorObjectProcessOverrides(
  current: EditorObjectProcessOverrides,
  target: EditorObjectProcessSettingsTarget
): ProcessSettingOverrides[] {
  return target.ids.map((id) => current[String(id)] ?? {})
}

/** Merge uniform values while leaving untouched mixed keys with their own members. */
export function applyEditorObjectProcessOverrides(
  current: EditorObjectProcessOverrides,
  target: EditorObjectProcessSettingsTarget,
  overrides: ProcessSettingOverrides,
  clearedKeys: readonly string[]
): EditorObjectProcessOverrides {
  const next = { ...current }
  for (const id of target.ids) {
    next[String(id)] = applyBulkOverridesToMember(current[String(id)], overrides, clearedKeys)
  }
  return next
}
