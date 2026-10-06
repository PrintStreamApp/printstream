/**
 * Resolves which Text record an editor tool opening should adopt. Standalone objects, saved baked
 * parts, and session-added parts have different identities, but each loads its existing panel value
 * before the live rebuild runs. A new session starts with the default word and remembered settings.
 */
import { canonicalThreeMfPartSubtype } from '@printstream/shared'
import type { EditorAddedPart, EditorInstance, EditorInstancePart } from './editorModel'
import { DEFAULT_TEXT, textToolValueFromInfo, type TextToolValue } from './textToolValue'

interface BakedTextCandidate {
  part: EditorInstancePart
  instance: EditorInstance
  hostId: number
  partIndex: number
}

interface AddedTextCandidate {
  part: EditorAddedPart
  hostInstanceKey: string
}

export type EditorTextSession =
  | { kind: 'standalone'; objectKey: string; value: TextToolValue }
  | { kind: 'baked'; hostKey: string; hostId: number; partIndex: number; transform: number[]; value: TextToolValue }
  | { kind: 'added'; hostKey: string; partKey: string; value: TextToolValue }
  | { kind: 'new'; value: TextToolValue }

/** Choose the existing Text identity before any panel state or scene geometry changes. */
export function resolveEditorTextSession(options: {
  current: TextToolValue
  selectedInstance: EditorInstance | null
  baked: BakedTextCandidate | null
  added: AddedTextCandidate | null
}): EditorTextSession {
  const { current, selectedInstance, baked, added } = options
  if (selectedInstance?.textInfo) {
    return {
      kind: 'standalone',
      objectKey: selectedInstance.key,
      value: textToolValueFromInfo(selectedInstance.textInfo, 'normal_part', current)
    }
  }
  if (baked?.part.textInfo) {
    return {
      kind: 'baked',
      hostKey: baked.instance.key,
      hostId: baked.hostId,
      partIndex: baked.partIndex,
      transform: [...baked.part.transform],
      value: textToolValueFromInfo(
        baked.part.textInfo,
        canonicalThreeMfPartSubtype(baked.part.subtype),
        current
      )
    }
  }
  if (added?.part.textInfo) {
    return {
      kind: 'added',
      hostKey: added.hostInstanceKey,
      partKey: added.part.key,
      value: textToolValueFromInfo(added.part.textInfo, added.part.subtype, current)
    }
  }
  return { kind: 'new', value: { ...current, text: DEFAULT_TEXT } }
}
