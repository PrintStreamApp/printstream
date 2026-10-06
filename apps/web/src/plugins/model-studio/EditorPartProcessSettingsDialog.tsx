/**
 * Adapts a mixed selection of baked, body, and added volumes to the shared
 * process-settings dialog. The heavy catalog stays behind LazyProcessSettingsDialog.
 */
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import { PER_OBJECT_PROCESS_KEYS } from '@printstream/shared'
import type { ProcessSettingsDialogProps } from '../../components/ProcessSettingsDialog'
import type { SliceSettingsController } from '../../components/library/SliceSettingsPanel'
import { LazyProcessSettingsDialog } from './LazyProcessSettingsDialog'
import type { EditorState } from './lib/editorModel'
import {
  applyEditorPartProcessOverrides,
  readEditorPartProcessOverrides,
  type EditorPartProcessSettingsTarget
} from './lib/editorPartProcessSettings'

interface EditorPartProcessSettingsDialogProps {
  target: EditorPartProcessSettingsTarget
  perObject: NonNullable<SliceSettingsController['perObjectSettings']>
  stateRef: MutableRefObject<EditorState | null>
  setState: Dispatch<SetStateAction<EditorState | null>>
  recordHistory: () => void
  resolveConfig: ProcessSettingsDialogProps['resolveConfig']
  onClose: () => void
}

/** Apply one dialog result to every selected part in one history step. */
export function EditorPartProcessSettingsDialog(props: EditorPartProcessSettingsDialogProps) {
  const { target, perObject, stateRef, setState, recordHistory, resolveConfig, onClose } = props
  const memberOverrides = readEditorPartProcessOverrides(stateRef.current, target)
  const objectOverrides = perObject.value[String(target.objectId)] ?? {}

  return (
    <LazyProcessSettingsDialog
      open
      applyScope="project"
      onClose={onClose}
      slicerTargetId={perObject.slicerTargetId}
      processProfileId={perObject.processProfileId}
      processProfileName={target.name}
      sourceFileId={perObject.sourceFileId}
      initialOverrides={memberOverrides[0] ?? {}}
      initialOverridesByMember={memberOverrides}
      visibilityContext={{ ...perObject.visibilityContext, isGlobalConfig: false }}
      allowedKeys={PER_OBJECT_PROCESS_KEYS}
      baseOverlay={{ ...perObject.globalOverrides, ...objectOverrides }}
      resolveConfig={resolveConfig}
      titlePrefix="Part settings"
      onApply={(overrides, { clearedKeys }) => {
        recordHistory()
        setState((current) => current
          ? applyEditorPartProcessOverrides(current, target, overrides, clearedKeys)
          : current)
        onClose()
      }}
    />
  )
}
