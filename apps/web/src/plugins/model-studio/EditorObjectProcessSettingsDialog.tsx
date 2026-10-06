/**
 * Adapts a single or bulk object selection to the lazy process-settings catalog.
 * The borrowed slice controller owns the maps; its history records the apply.
 */
import { PER_OBJECT_PROCESS_KEYS } from '@printstream/shared'
import type { ProcessSettingsDialogProps } from '../../components/ProcessSettingsDialog'
import type { SliceSettingsController } from '../../components/library/SliceSettingsPanel'
import { LazyProcessSettingsDialog } from './LazyProcessSettingsDialog'
import {
  applyEditorObjectProcessOverrides,
  readEditorObjectProcessOverrides,
  type EditorObjectProcessSettingsTarget
} from './lib/editorObjectProcessSettings'

interface EditorObjectProcessSettingsDialogProps {
  target: EditorObjectProcessSettingsTarget
  perObject: NonNullable<SliceSettingsController['perObjectSettings']>
  recordSliceConfigHistory: () => void
  resolveConfig: ProcessSettingsDialogProps['resolveConfig']
  onClose: () => void
}

/** Apply the dialog's shared values to each selected object in one history step. */
export function EditorObjectProcessSettingsDialog(props: EditorObjectProcessSettingsDialogProps) {
  const { target, perObject, recordSliceConfigHistory, resolveConfig, onClose } = props
  const memberOverrides = readEditorObjectProcessOverrides(perObject.value, target)

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
      baseOverlay={perObject.globalOverrides}
      resolveConfig={resolveConfig}
      titlePrefix="Object settings"
      onApply={(overrides, { clearedKeys }) => {
        recordSliceConfigHistory()
        perObject.onChange(applyEditorObjectProcessOverrides(
          perObject.value, target, overrides, clearedKeys
        ))
        onClose()
      }}
    />
  )
}
