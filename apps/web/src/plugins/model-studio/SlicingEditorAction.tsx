/**
 * Slot button for the `slicing.editor` extension point.
 *
 * Renders an "Open full editor" button in the slicing dialog's footer and, when
 * clicked, opens the heavy interactive editor (lazy-loaded) — the "full" slicer
 * mode. The editor renders the SAME slice settings (via `sliceConfig`) and can
 * save the project or slice+print a plate directly; the host keeps the slice
 * dialog mounted so the print flow layers above the editor.
 *
 * Self-contained so the slot renders nothing harmful when the plugin is absent
 * (the host's `<PluginSlot>` already renders nothing in that case). Mounted by
 * `SliceFileModal` in `LibraryView.tsx`.
 */
import { Suspense, lazy, useState } from 'react'
import { Button } from '@mui/joy'
import ViewInArRoundedIcon from '@mui/icons-material/ViewInArRounded'
import type { SceneEdit } from '@printstream/shared'
import type { SliceSettingsController } from '../../components/library/SliceSettingsPanel'

const EditorView = lazy(() => import('./EditorView'))

export function SlicingEditorAction(props: Record<string, unknown>) {
  const fileId = typeof props.fileId === 'string' ? props.fileId : null
  const baseVersionId = typeof props.baseVersionId === 'string' && props.baseVersionId ? props.baseVersionId : null
  // A brand-new project (hidden scaffold): the editor saves via "Save as new" so the user is
  // prompted for a name + destination instead of silently overwriting the throwaway scaffold.
  const isNewProject = props.isNewProject === true
  const bridgeId = typeof props.bridgeId === 'string' ? props.bridgeId : null
  const folderId = typeof props.folderId === 'string' ? props.folderId : null
  const onApply = typeof props.onApply === 'function'
    ? (props.onApply as (edit: SceneEdit) => void)
    : null
  const currentEdit = (props.currentEdit as SceneEdit | null | undefined) ?? null
  const initialPlateIndex = typeof props.initialPlateIndex === 'number' && Number.isInteger(props.initialPlateIndex) && props.initialPlateIndex > 0
    ? props.initialPlateIndex
    : undefined
  const targetPrinterModel = typeof props.targetPrinterModel === 'string' && props.targetPrinterModel ? props.targetPrinterModel : undefined
  // Full slice settings shared with the slim dialog (single source of truth).
  const sliceConfig = (props.sliceConfig as SliceSettingsController | undefined) ?? undefined
  const canSlice = props.canSlice === true
  const sliceDisabledReason = typeof props.sliceDisabledReason === 'string' && props.sliceDisabledReason ? props.sliceDisabledReason : undefined
  const slicing = props.slicing === true
  const onSlice = typeof props.onSlice === 'function'
    ? (props.onSlice as (opts: { plate: number; sceneEdit: SceneEdit }) => void)
    : undefined
  // Per-object overrides still open the host's dialog (stacked above the editor).
  const objectOverrideCount = typeof props.objectOverrideCount === 'number' ? props.objectOverrideCount : 0
  const hasPlateObjects = props.hasPlateObjects === true
  const canEditSettings = props.canEditSettings === true
  const onEditObjectSettings = typeof props.onEditObjectSettings === 'function'
    ? (props.onEditObjectSettings as () => void)
    : undefined
  // When the editor IS the slice UI (simple mode removed), the host opens it
  // directly: no button, and closing the editor closes the host dialog.
  const autoOpen = props.autoOpen === true
  const hostOnClose = typeof props.onClose === 'function' ? (props.onClose as () => void) : undefined
  const [open, setOpen] = useState(autoOpen)

  if (!fileId || !onApply) return null

  const closeEditor = () => {
    setOpen(false)
    if (autoOpen) hostOnClose?.()
  }

  return (
    <>
      {!autoOpen && (
        <Button
          type="button"
          variant="outlined"
          color="neutral"
          startDecorator={<ViewInArRoundedIcon />}
          onClick={() => setOpen(true)}
          sx={{ width: { xs: '100%', sm: 'auto' } }}
        >
          Open full editor
        </Button>
      )}
      {open && (
        <Suspense fallback={null}>
          <EditorView
            // Re-mount on a different file/version so all per-file state and one-shot guards
            // (seeded scene, re-hydration set, frozen preferred plate) reset cleanly.
            key={`${fileId}:${baseVersionId ?? 'current'}`}
            baseFileId={fileId}
            baseVersionId={baseVersionId}
            isNewProject={isNewProject}
            bridgeId={bridgeId}
            folderId={folderId}
            currentEdit={currentEdit}
            initialPlateIndex={initialPlateIndex}
            targetPrinterModel={targetPrinterModel}
            onApply={(edit) => { onApply(edit); closeEditor() }}
            onClose={closeEditor}
            sliceConfig={sliceConfig}
            canSlice={canSlice}
            sliceDisabledReason={sliceDisabledReason}
            slicing={slicing}
            onSlice={onSlice}
            objectOverrideCount={objectOverrideCount}
            hasPlateObjects={hasPlateObjects}
            canEditSettings={canEditSettings}
            onEditObjectSettings={onEditObjectSettings}
          />
        </Suspense>
      )}
    </>
  )
}
