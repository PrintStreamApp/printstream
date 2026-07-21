/**
 * Save / apply / close flows for the 3MF project editor.
 *
 * Owns the "is a save in flight" and Save-As dialog state and the handlers that turn the live
 * scene into a persisted 3MF (new version, Save-As, or the single-object "Export as 3MF" —
 * which saves a filtered copy WITHOUT adopting it as the editor's saved state), hand a built
 * SceneEdit back to the host at slice time ("Use this layout"), and guard closing while there
 * are unsaved edits. Pulled out of EditorView so the component body keeps to scene wiring and
 * rendering.
 *
 * The scene-output producers (`buildSceneEditOut`, `captureAllPlateThumbnails`) stay in the
 * component because the slice flow shares them; they are passed in here. Marking the project
 * clean after a successful save goes through `markSaved` (from useEditorHistory).
 */
import { useCallback, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { type ExportArrangedThreeMf, type SaveArrangedThreeMf, type SceneEdit } from '@printstream/shared'
import { apiFetch } from '../../lib/apiClient'
import { buildApiUrl } from '../../lib/apiUrl'
import { downloadBlob } from '../../lib/downloadBlob'
import { toast } from '../../lib/toast'
import { invalidateLibraryQueries } from '../../lib/libraryQueryInvalidation'
import { readWorkspaceContextHeader } from '../../lib/workspaceContext'
import { type ConfirmDialogOptions } from '../../components/PromptDialogProvider'
import { type SliceSettingsController } from '../../components/library/SliceSettingsPanel'
import { buildSingleObjectExportState, type EditorState } from './lib/editorModel'
import { fetchModelBytes } from './lib/modelFetch'

type PlateThumbnail = { plateIndex: number; png: string }

export interface EditorSaveParams {
  stateRef: MutableRefObject<EditorState | null>
  sliceConfigRef: MutableRefObject<SliceSettingsController | undefined>
  dirtyRef: MutableRefObject<boolean>
  /** Adopt the current state as the saved baseline (from useEditorHistory). */
  markSaved: () => void
  buildSceneEditOut: (current: EditorState, options?: { thumbnails?: PlateThumbnail[] }) => SceneEdit
  captureAllPlateThumbnails: (current: EditorState, options?: { force?: boolean; updateLive?: boolean }) => Promise<PlateThumbnail[]>
  /**
   * The rendered XY footprint centre (plate coordinates, helper volumes excluded) of an instance,
   * or null when it has no group in the live scene. Only the scene owner can answer this, and the
   * single-object export needs it to centre the exported object on its plate.
   */
  worldFootprintCenterFor: (key: string) => { x: number; y: number } | null
  seededProcessOverrideObjectIdsRef: MutableRefObject<Set<number>>
  baseFileId: string | null
  baseVersionId: string | null | undefined
  saveAsBridgeId: string | null | undefined
  /**
   * This project was CREATED in the editor (a new-project scaffold or a fileless start) rather
   * than opened from a library file. Such a project keeps its instances import-backed for the
   * whole session, so its saves bake from the editor state alone — see {@link EditorSave.savedFile}.
   */
  editorBorn: boolean
  /** Slice-time apply (only present when launched from the slice dialog). */
  onApply: ((edit: SceneEdit) => void) | undefined
  onSaved: ((file: { id: string; name: string }) => void) | undefined
  /** Called after a SAVE AS (a new file) so the host can re-open the editor on it. */
  onSavedAs: ((file: { id: string; name: string }) => void) | undefined
  onClose: () => void
  confirm: (options: ConfirmDialogOptions) => Promise<boolean>
}

export interface EditorSave {
  /**
   * The library file an editor-born project was saved into, once it has been saved. The editor
   * ADOPTS that file in place — it keeps its scene and stays open rather than re-mounting on the
   * saved file, so a plain Save no longer looks like the project reloaded. Null until the first
   * save (and always null for a project opened from a file, which already has its own base).
   */
  savedFile: { id: string; name: string } | null
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
  /** Export ONE object as its own new 3MF project file (keeps the editor on the source project). */
  handleExportObjectAs3mf: (key: string, name: string, destinationFolderId: string | null) => void
  /** Same single-object 3MF bake, streamed back as a browser download — nothing lands in the library. */
  handleExportObjectAs3mfDownload: (key: string, fileName: string) => void
}

export function useEditorSave({
  stateRef,
  sliceConfigRef,
  dirtyRef,
  markSaved,
  buildSceneEditOut,
  captureAllPlateThumbnails,
  worldFootprintCenterFor,
  seededProcessOverrideObjectIdsRef,
  baseFileId,
  baseVersionId,
  saveAsBridgeId,
  editorBorn,
  onApply,
  onSaved,
  onSavedAs,
  onClose,
  confirm
}: EditorSaveParams): EditorSave {
  const queryClient = useQueryClient()
  const [saving, setSaving] = useState(false)
  const [saveAsOpen, setSaveAsOpen] = useState(false)
  const [savedFile, setSavedFile] = useState<{ id: string; name: string } | null>(null)
  // Saves of an editor-born project target the adopted file once it exists, and always bake from
  // the editor state — never from the bytes of the save before them (see `ignoreBaseContent`).
  const effectiveBaseFileId = savedFile?.id ?? baseFileId
  const effectiveBaseVersionId = savedFile ? null : baseVersionId

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
  // `asProject: false` (the single-object export) still saves through the same
  // endpoint but must NOT adopt the result as the editor's saved state: the source
  // project's unsaved edits were not persisted to ITS file, so the dirty flag stays,
  // and the host is not told its file was saved.
  const runSave = useCallback(
    async (
      payload: SaveArrangedThreeMf,
      successMessage: string,
      options?: { asProject?: boolean }
    ): Promise<{ id: string; name: string } | null> => {
      // BambuStudio parity: a project must have a material before it can be saved.
      if ((sliceConfigRef.current?.projectFilaments?.length ?? 0) === 0) {
        toast.error('Add a material to the project before saving.')
        return null
      }
      const asProject = options?.asProject !== false
      setSaving(true)
      try {
        const { file } = await apiFetch<{ file: { id: string; name: string } }>('/api/editor/save', {
          method: 'POST',
          body: payload
        })
        if (asProject) {
          markSaved()
          // The saved 3MF bakes the session's material add/removes as its filament list;
          // tell the controller so it rebases its overlay once the refetched index lands
          // (otherwise an added material renders twice until the editor is reopened).
          //
          // MUST be armed BEFORE the invalidation below. The controller detects the refetch by
          // watching its base material list change, so arming after `invalidateLibraryQueries`
          // resolves loses the race whenever the refetch lands inside that await: the change it
          // was waiting for has already happened, the overlay is never folded in, and the added
          // material renders twice — then bakes into the NEXT save as a real duplicate slot,
          // taking its per-slot colour/preset/nozzle state (keyed by the pre-save id) with it.
          sliceConfigRef.current?.onProjectSaved()
        }
        await invalidateLibraryQueries(queryClient)
        toast.success(successMessage)
        if (asProject) onSaved?.(file)
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
  const collectObjectProcessOverrides = useCallback((scope?: EditorState): Record<string, Record<string, string | string[]>> | undefined => {
    const value = sliceConfigRef.current?.perObjectSettings?.value
    if (!value) return undefined
    // Object identities currently placed: a real objectId, or an import's synthetic id.
    // `scope` narrows "placed" to a synthetic state (the single-object export), so only
    // that object's overrides ride along.
    const placed = new Set<number>()
    for (const plate of (scope ?? stateRef.current)?.plates ?? []) {
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
    if (!current || effectiveBaseFileId === null) return
    void (async () => {
      const thumbnails = await captureAllPlateThumbnails(current)
      const retarget = sliceConfigRef.current?.retargetTarget ?? undefined
      await runSave(
        {
          baseFileId: effectiveBaseFileId, baseVersionId: effectiveBaseVersionId,
          mode: 'newVersion', ignoreBaseContent: editorBorn,
          sceneEdit: buildSceneEditOut(current, { thumbnails }),
          objectProcessOverrides: collectObjectProcessOverrides(),
          processSettingOverrides: collectProcessSettingOverrides(),
          retarget,
          slicerTargetId: retarget ? sliceConfigRef.current?.selectedSlicerTargetId : undefined
        },
        retarget ? `Saved a new version for ${retarget.printerModel}` : 'Saved a new version'
      )
    })()
  }, [effectiveBaseFileId, effectiveBaseVersionId, editorBorn, runSave, buildSceneEditOut, captureAllPlateThumbnails, collectObjectProcessOverrides, collectProcessSettingOverrides, stateRef, sliceConfigRef])

  const handleSaveAs = useCallback((name: string, destinationFolderId: string | null) => {
    const current = stateRef.current
    if (!current) return
    setSaveAsOpen(false)
    void (async () => {
      const thumbnails = await captureAllPlateThumbnails(current)
      const retarget = sliceConfigRef.current?.retargetTarget ?? undefined
      // A project born in the editor has never been persisted, so its first save is a "save as"
      // only mechanically — there is no earlier file to strand the user on, and its own scaffold
      // holds nothing the editor state doesn't model. Bake from the state so the editor can adopt
      // the result instead of re-mounting on it.
      const firstSaveOfEditorBornProject = editorBorn && savedFile === null
      const saved = await runSave(
        {
          baseFileId: effectiveBaseFileId, baseVersionId: effectiveBaseVersionId,
          mode: 'saveAs', name, folderId: destinationFolderId, bridgeId: saveAsBridgeId,
          ignoreBaseContent: firstSaveOfEditorBornProject,
          sceneEdit: buildSceneEditOut(current, { thumbnails }),
          objectProcessOverrides: collectObjectProcessOverrides(),
          processSettingOverrides: collectProcessSettingOverrides(),
          retarget,
          slicerTargetId: retarget ? sliceConfigRef.current?.selectedSlicerTargetId : undefined
        },
        `Saved “${name}”`
      )
      if (!saved) return
      if (firstSaveOfEditorBornProject) {
        // Adopt the new file in place: the editor keeps its scene and its (still import-backed)
        // state, and later saves become ordinary new-version saves against it. Re-mounting here
        // is what made a plain Save look like the project reloaded.
        setSavedFile(saved)
        return
      }
      // A real "save as" DOES make a new file while an older one stays behind, so leaving the
      // editor on the old project would silently send further edits to the wrong file. Re-open
      // on the new one — and re-reading it is also what turns this session's staged imports into
      // in-project objects, which an adopted project deliberately skips.
      onSavedAs?.(saved)
    })()
  }, [effectiveBaseFileId, effectiveBaseVersionId, editorBorn, savedFile, saveAsBridgeId, runSave, buildSceneEditOut, captureAllPlateThumbnails, collectObjectProcessOverrides, collectProcessSettingOverrides, stateRef, sliceConfigRef, onSavedAs])

  /**
   * "Export object as 3MF": bake ONLY the given object into a new single-plate 3MF library
   * file through the normal save pipeline, so its parts, per-part materials/types, paint,
   * added volumes, and per-object process overrides all survive (everything an STL export
   * flattens away). Unlike Save-As, the editor stays on the source project and its dirty
   * state is untouched — the export is a copy, not a save of the project.
   */
  const handleExportObjectAs3mf = useCallback((key: string, name: string, destinationFolderId: string | null) => {
    const current = stateRef.current
    if (!current) return
    const exportState = buildSingleObjectExportState(current, key, worldFootprintCenterFor(key) ?? undefined)
    if (!exportState) return
    void (async () => {
      // Fresh thumbnail of the exported object alone; force (the synthetic plate has no
      // live strip entry) and don't repaint the live plate strip with it.
      const thumbnails = await captureAllPlateThumbnails(exportState, { force: true, updateLive: false })
      const retarget = sliceConfigRef.current?.retargetTarget ?? undefined
      await runSave(
        {
          baseFileId, baseVersionId, mode: 'saveAs', name, folderId: destinationFolderId, bridgeId: saveAsBridgeId,
          sceneEdit: buildSceneEditOut(exportState, { thumbnails }),
          objectProcessOverrides: collectObjectProcessOverrides(exportState),
          processSettingOverrides: collectProcessSettingOverrides(),
          retarget,
          slicerTargetId: retarget ? sliceConfigRef.current?.selectedSlicerTargetId : undefined,
          // Marker: the library treats the export as a reusable model (preview on click),
          // not an openable project — see the shared index parser's model-kind doc.
          objectExport: true
        },
        `Exported “${name}”`,
        { asProject: false }
      )
    })()
  }, [baseFileId, baseVersionId, saveAsBridgeId, runSave, buildSceneEditOut, captureAllPlateThumbnails, worldFootprintCenterFor, collectObjectProcessOverrides, collectProcessSettingOverrides, stateRef, sliceConfigRef])

  /**
   * "Download 3MF project": the same single-object bake as {@link handleExportObjectAs3mf}
   * but streamed straight back as a download (`POST /api/editor/export-3mf` — see the route's
   * doc for the no-persist contract). Uses the stall-guarded model fetch because the baked
   * 3MF is a large body on the same web→API path as model downloads.
   */
  const handleExportObjectAs3mfDownload = useCallback((key: string, fileName: string) => {
    const current = stateRef.current
    if (!current) return
    const exportState = buildSingleObjectExportState(current, key, worldFootprintCenterFor(key) ?? undefined)
    if (!exportState) return
    // Same BambuStudio parity rule as saving: a project needs a material.
    if ((sliceConfigRef.current?.projectFilaments?.length ?? 0) === 0) {
      toast.error('Add a material to the project before exporting.')
      return
    }
    void (async () => {
      setSaving(true)
      try {
        const thumbnails = await captureAllPlateThumbnails(exportState, { force: true, updateLive: false })
        const retarget = sliceConfigRef.current?.retargetTarget ?? undefined
        const payload: ExportArrangedThreeMf = {
          baseFileId,
          baseVersionId,
          name: fileName,
          sceneEdit: buildSceneEditOut(exportState, { thumbnails }),
          objectProcessOverrides: collectObjectProcessOverrides(exportState),
          processSettingOverrides: collectProcessSettingOverrides(),
          retarget,
          slicerTargetId: retarget ? sliceConfigRef.current?.selectedSlicerTargetId : undefined,
          // Marker: re-uploaded downloads classify as reusable models, not projects.
          objectExport: true
        }
        const workspaceContext = readWorkspaceContextHeader()
        const bytes = await fetchModelBytes(buildApiUrl('/api/editor/export-3mf'), {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
            ...(workspaceContext ? { 'X-PrintStream-Tenant': workspaceContext } : {})
          },
          body: JSON.stringify(payload)
        })
        downloadBlob(new Blob([bytes as BlobPart], { type: 'model/3mf' }), fileName)
        toast.success(`Exported ${fileName}.`)
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'Unable to export the object.')
      } finally {
        setSaving(false)
      }
    })()
  }, [baseFileId, baseVersionId, buildSceneEditOut, captureAllPlateThumbnails, worldFootprintCenterFor, collectObjectProcessOverrides, collectProcessSettingOverrides, stateRef, sliceConfigRef])

  return {
    savedFile,
    saving,
    saveAsOpen,
    setSaveAsOpen,
    handleApply,
    handleCloseRequest,
    handleSaveVersion,
    handleSaveAs,
    handleExportObjectAs3mf,
    handleExportObjectAs3mfDownload
  }
}
