/**
 * Save / apply / close flows for the 3MF project editor.
 *
 * Owns the "is a save in flight" and Save-As dialog state and the handlers that turn the live
 * scene into a persisted 3MF (new version or Save-As), hand a built SceneEdit back to the host
 * at slice time ("Use this layout"), and guard closing while there are unsaved edits. Pulled out
 * of EditorView so the component body keeps to scene wiring and rendering.
 *
 * The scene-output producers (`buildSceneEditOut`, `captureAllPlateThumbnails`) stay in the
 * component because the slice flow shares them; they are passed in here. Marking the project
 * clean after a successful save goes through `markSaved` (from useEditorHistory).
 */
import { useCallback, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { type SaveArrangedThreeMf, type SceneEdit } from '@printstream/shared'
import { apiFetch } from '../../lib/apiClient'
import { toast } from '../../lib/toast'
import { invalidateLibraryQueries } from '../../lib/libraryQueryInvalidation'
import { type ConfirmDialogOptions } from '../../components/PromptDialogProvider'
import { type SliceSettingsController } from '../../components/library/SliceSettingsPanel'
import { type EditorState } from './lib/editorModel'

type PlateThumbnail = { plateIndex: number; png: string }

export interface EditorSaveParams {
  stateRef: MutableRefObject<EditorState | null>
  sliceConfigRef: MutableRefObject<SliceSettingsController | undefined>
  dirtyRef: MutableRefObject<boolean>
  /** Adopt the current state as the saved baseline (from useEditorHistory). */
  markSaved: () => void
  buildSceneEditOut: (current: EditorState, options?: { thumbnails?: PlateThumbnail[] }) => SceneEdit
  captureAllPlateThumbnails: (current: EditorState) => Promise<PlateThumbnail[]>
  seededProcessOverrideObjectIdsRef: MutableRefObject<Set<number>>
  baseFileId: string | null
  baseVersionId: string | null | undefined
  saveAsBridgeId: string | null | undefined
  /** Slice-time apply (only present when launched from the slice dialog). */
  onApply: ((edit: SceneEdit) => void) | undefined
  onSaved: ((file: { id: string; name: string }) => void) | undefined
  onClose: () => void
  confirm: (options: ConfirmDialogOptions) => Promise<boolean>
}

export interface EditorSave {
  /** A save is in flight (drives the disabled/loading state of Save/Slice/Close). */
  saving: boolean
  saveAsOpen: boolean
  setSaveAsOpen: Dispatch<SetStateAction<boolean>>
  /** Slice-time "Use this layout": hands the built SceneEdit to the host (no persistence). */
  handleApply: () => void
  /** Close the editor, warning first if there are unsaved edits. */
  handleCloseRequest: () => Promise<void>
  /** Save a new version of the source file. */
  handleSaveVersion: () => void
  /** Save the arrangement as a new file at the given name/folder. */
  handleSaveAs: (name: string, destinationFolderId: string | null) => void
}

export function useEditorSave({
  stateRef,
  sliceConfigRef,
  dirtyRef,
  markSaved,
  buildSceneEditOut,
  captureAllPlateThumbnails,
  seededProcessOverrideObjectIdsRef,
  baseFileId,
  baseVersionId,
  saveAsBridgeId,
  onApply,
  onSaved,
  onClose,
  confirm
}: EditorSaveParams): EditorSave {
  const queryClient = useQueryClient()
  const [saving, setSaving] = useState(false)
  const [saveAsOpen, setSaveAsOpen] = useState(false)

  const handleApply = useCallback(() => {
    const current = stateRef.current
    if (!current || !onApply) return
    void (async () => {
      const thumbnails = await captureAllPlateThumbnails(current)
      onApply(buildSceneEditOut(current, { thumbnails }))
    })()
  }, [onApply, buildSceneEditOut, captureAllPlateThumbnails, stateRef])

  // Persist the arrangement as a 3MF. Staged imports are already on the server,
  // so the SceneEdit's importId references are all the backend needs to bake them.
  const runSave = useCallback(
    async (payload: SaveArrangedThreeMf, successMessage: string): Promise<{ id: string; name: string } | null> => {
      // BambuStudio parity: a project must have a material before it can be saved.
      if ((sliceConfigRef.current?.projectFilaments?.length ?? 0) === 0) {
        toast.error('Add a material to the project before saving.')
        return null
      }
      setSaving(true)
      try {
        const { file } = await apiFetch<{ file: { id: string; name: string } }>('/api/editor/save', {
          method: 'POST',
          body: payload
        })
        await invalidateLibraryQueries(queryClient)
        markSaved()
        toast.success(successMessage)
        onSaved?.(file)
        // Keep the editor open after saving so the user can keep arranging/printing.
        return file
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'Unable to save the project.')
        return null
      } finally {
        setSaving(false)
      }
    },
    [onSaved, queryClient, markSaved, sliceConfigRef]
  )

  // Closing the editor warns first if there are unsaved edits (drags, imports, etc.).
  const handleCloseRequest = useCallback(async () => {
    if (dirtyRef.current) {
      const discard = await confirm({
        title: 'Discard unsaved changes?',
        description: 'This project has changes that have not been saved. Closing now will lose them.',
        confirmLabel: 'Discard changes',
        cancelLabel: 'Keep editing',
        color: 'danger'
      })
      if (!discard) return
    }
    onClose()
  }, [confirm, onClose, dirtyRef])

  // Per-object PROCESS overrides authored in the editor (keyed by baked object id or a fresh
  // import's synthetic id). Sent with every save so they persist into the saved 3MF rather than
  // only applying to a one-off slice. Prunes overrides for objects that no longer exist, and emits
  // an empty `{}` for a re-hydrated object whose overrides were CLEARED so the save strips the now
  // stale baked overrides (rather than leaving them to resurrect on the next reopen).
  const collectObjectProcessOverrides = useCallback((): Record<string, Record<string, string | string[]>> | undefined => {
    const value = sliceConfigRef.current?.perObjectSettings?.value
    if (!value) return undefined
    // Object identities currently placed: a real objectId, or an import's synthetic id.
    const placed = new Set<number>()
    for (const plate of stateRef.current?.plates ?? []) {
      for (const instance of plate.instances) {
        if (instance.source.kind === 'object') placed.add(instance.objectId)
        else if (instance.source.replacedObjectId != null) placed.add(instance.source.replacedObjectId)
      }
    }
    const out: Record<string, Record<string, string | string[]>> = {}
    for (const [key, overrides] of Object.entries(value)) {
      if (placed.has(Number(key)) && Object.keys(overrides).length > 0) out[key] = overrides
    }
    for (const id of seededProcessOverrideObjectIdsRef.current) {
      const key = String(id)
      if (placed.has(id) && !out[key]) out[key] = {} // re-hydrated then cleared → strip on save
    }
    return Object.keys(out).length > 0 ? out : undefined
  }, [sliceConfigRef, stateRef, seededProcessOverrideObjectIdsRef])

  // Global (project-wide) process overrides authored in the editor. Sent with every save so they
  // persist into the saved 3MF's project_settings.config (not just a one-off slice). Empty ⇒ omit,
  // leaving the base project settings untouched.
  const collectProcessSettingOverrides = useCallback((): Record<string, string | string[]> | undefined => {
    const overrides = sliceConfigRef.current?.processSettingOverrides
    return overrides && Object.keys(overrides).length > 0 ? overrides : undefined
  }, [sliceConfigRef])

  const handleSaveVersion = useCallback(() => {
    const current = stateRef.current
    if (!current || baseFileId === null) return
    void (async () => {
      const thumbnails = await captureAllPlateThumbnails(current)
      const retarget = sliceConfigRef.current?.retargetTarget ?? undefined
      await runSave(
        {
          baseFileId, baseVersionId, mode: 'newVersion', sceneEdit: buildSceneEditOut(current, { thumbnails }),
          objectProcessOverrides: collectObjectProcessOverrides(),
          processSettingOverrides: collectProcessSettingOverrides(),
          retarget,
          slicerTargetId: retarget ? sliceConfigRef.current?.selectedSlicerTargetId : undefined
        },
        retarget ? `Saved a new version for ${retarget.printerModel}` : 'Saved a new version'
      )
    })()
  }, [baseFileId, baseVersionId, runSave, buildSceneEditOut, captureAllPlateThumbnails, collectObjectProcessOverrides, collectProcessSettingOverrides, stateRef, sliceConfigRef])

  const handleSaveAs = useCallback((name: string, destinationFolderId: string | null) => {
    const current = stateRef.current
    if (!current) return
    setSaveAsOpen(false)
    void (async () => {
      const thumbnails = await captureAllPlateThumbnails(current)
      const retarget = sliceConfigRef.current?.retargetTarget ?? undefined
      await runSave(
        {
          baseFileId, baseVersionId, mode: 'saveAs', name, folderId: destinationFolderId, bridgeId: saveAsBridgeId,
          sceneEdit: buildSceneEditOut(current, { thumbnails }),
          objectProcessOverrides: collectObjectProcessOverrides(),
          processSettingOverrides: collectProcessSettingOverrides(),
          retarget,
          slicerTargetId: retarget ? sliceConfigRef.current?.selectedSlicerTargetId : undefined
        },
        `Saved “${name}”`
      )
    })()
  }, [baseFileId, baseVersionId, saveAsBridgeId, runSave, buildSceneEditOut, captureAllPlateThumbnails, collectObjectProcessOverrides, collectProcessSettingOverrides, stateRef, sliceConfigRef])

  return {
    saving,
    saveAsOpen,
    setSaveAsOpen,
    handleApply,
    handleCloseRequest,
    handleSaveVersion,
    handleSaveAs
  }
}
