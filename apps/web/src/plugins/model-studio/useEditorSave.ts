/**
 * Save / apply / close flows for the 3MF project editor.
 *
 * Owns the "is a save in flight" and Save-As dialog state and the handlers that turn the live
 * scene into a persisted 3MF (new version, Save-As, or the single-object "Export as 3MF",
 * which saves a filtered copy WITHOUT adopting it as the editor's saved state), hand a built
 * SceneEdit back to the host at slice time ("Use this layout"), and guard closing while there
 * are unsaved edits. Pulled out of EditorView so the component body keeps to scene wiring and
 * rendering.
 *
 * The scene-output producers (`buildSceneEditOut`, `captureAllPlateThumbnails`) stay in the
 * component because the slice flow shares them; they are passed in here. Marking the project
 * clean after a successful save goes through `markSaved` (from useEditorHistory).
 */
import { useCallback, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { type ExportArrangedThreeMf, type SaveArrangedThreeMf, type SceneEdit } from '@printstream/shared'
import { afterNextPaint } from '../../lib/afterNextPaint'
import { apiFetch } from '../../lib/apiClient'
import { downloadBlob } from '../../lib/downloadBlob'
import { toast } from '../../lib/toast'
import { invalidateLibraryQueries } from '../../lib/libraryQueryInvalidation'
import { type ConfirmDialogOptions } from '../../components/PromptDialogProvider'
import { type SliceSettingsController } from '../../components/library/SliceSettingsPanel'
import { buildSessionFilamentIdRemap, buildSingleObjectExportState, type EditorState } from './lib/editorModel'
import { objectIdsAcceptingOverrides, selectObjectProcessOverridesForSave } from './lib/sceneEditIdentity'
import { createApiSaveTarget, type EditorSaveTarget } from './lib/editorSaveTarget'
import { initialContentBasePin, nextContentBasePin, type EditorContentBasePin } from './lib/contentBasePin'

type PlateThumbnail = { plateIndex: number; png: string }

export interface EditorSaveParams {
  stateRef: MutableRefObject<EditorState | null>
  sliceConfigRef: MutableRefObject<SliceSettingsController | undefined>
  dirtyRef: MutableRefObject<boolean>
  /** Adopt the current state as the saved baseline (from useEditorHistory). */
  markSaved: () => void
  buildSceneEditOut: (current: EditorState, options?: { thumbnails?: PlateThumbnail[] }) => SceneEdit
  /**
   * Fills in each filament slot's resolved preset config before the edit is persisted, so the saved
   * project carries the material's own physics rather than only its name (see
   * `lib/filamentConfigAuthoring.ts`). Async because resolving a preset is a request; best-effort, so
   * it must never reject. Omitted leaves the edit untouched.
   */
  authorFilamentConfigs?: (edit: SceneEdit) => Promise<SceneEdit>
  captureAllPlateThumbnails: (current: EditorState, options?: { force?: boolean; updateLive?: boolean }) => Promise<PlateThumbnail[]>
  /**
   * The rendered XY footprint centre (plate coordinates, helper volumes excluded) of an instance,
   * or null when it has no group in the live scene. Only the scene owner can answer this, and the
   * single-object export needs it to centre the exported object on its plate.
   */
  worldFootprintCenterFor: (key: string) => { x: number; y: number } | null
  baseFileId: string | null
  baseVersionId: string | null | undefined
  /**
   * The base file's version counter when this session opened it, once known. Establishes the
   * baseline for the concurrent-save warning; null disables the check, which is right for a
   * session editing an ARCHIVED version (its head has moved by definition, so warning is noise).
   */
  openedVersionNumber?: number | null
  saveAsBridgeId: string | null | undefined
  /**
   * This project was CREATED in the editor (a new-project scaffold or a fileless start) rather
   * than opened from a library file. Such a project keeps its instances import-backed for the
   * whole session, so its saves bake from the editor state alone: see {@link EditorSave.savedFile}.
   */
  editorBorn: boolean
  /** Slice-time apply (only present when launched from the slice dialog). */
  onApply: ((edit: SceneEdit) => void) | undefined
  onSaved: ((file: { id: string; name: string }) => void) | undefined
  /** Called after a SAVE AS (a new file) so the host can re-open the editor on it. */
  onSavedAs: ((file: { id: string; name: string }) => void) | undefined
  onClose: () => void
  confirm: (options: ConfirmDialogOptions) => Promise<boolean>
  /** Where a save goes. Defaults to the library-backed api target. */
  saveTarget?: EditorSaveTarget
  /**
   * Whether the project has a material yet: BambuStudio parity, a project must have one before it
   * can be saved. Defaults to reading the slice controller; a host without one (the public editor)
   * answers from its own materials, or the gate would reject every save.
   */
  hasMaterials?: () => boolean
  /**
   * A project save baked the session's filament ids renumbered by this SESSION->SAVED map (the
   * emit-side translation in `buildSceneEditOut`): the live editor state must follow, or its
   * instances keep pointing at ids the saved project no longer has (mesh colours fall back to the
   * originally-seeded scene colours, and the NEXT save re-translates already-stale ids). Called
   * only for project-adopting saves (never the single-object export) and only when the map is not
   * identity. See `rebaseEditorStateFilamentIds`.
   */
  onFilamentsRenumbered?: (remap: Map<number, number>) => void
  /**
   * The save rewrote the file's slot order, so anything still holding pre-save `sourceIndex`
   * values (the undo frames) must re-point at the new base. Distinct from the id renumbering
   * above: ids move the LIVE session forward, this moves what history refers OUT to.
   */
  onFilamentSourcesRemapped?: (sourceRemap: Map<number, number>) => void
}

export interface EditorSave {
  /**
   * The library file an editor-born project was saved into, once it has been saved. The editor
   * ADOPTS that file in place, it keeps its scene and stays open rather than re-mounting on the
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
  /** Same single-object 3MF bake, streamed back as a browser download, nothing lands in the library. */
  handleExportObjectAs3mfDownload: (key: string, fileName: string) => void
}

export function useEditorSave({
  stateRef,
  sliceConfigRef,
  dirtyRef,
  markSaved,
  buildSceneEditOut,
  authorFilamentConfigs,
  captureAllPlateThumbnails,
  worldFootprintCenterFor,
  baseFileId,
  baseVersionId,
  openedVersionNumber,
  saveAsBridgeId,
  editorBorn,
  onApply,
  onSaved,
  onSavedAs,
  onClose,
  confirm,
  saveTarget = createApiSaveTarget(),
  hasMaterials,
  onFilamentsRenumbered,
  onFilamentSourcesRemapped
}: EditorSaveParams): EditorSave {
  const queryClient = useQueryClient()
  /** Author the resolved filament configs onto an edit, or hand it back untouched. */
  const authorEdit = useCallback(
    async (edit: SceneEdit): Promise<SceneEdit> => (authorFilamentConfigs ? await authorFilamentConfigs(edit) : edit),
    [authorFilamentConfigs]
  )
  const [saving, setSaving] = useState(false)
  const [saveAsOpen, setSaveAsOpen] = useState(false)
  const [savedFile, setSavedFile] = useState<{ id: string; name: string } | null>(null)
  // Saves of an editor-born project target the adopted file once it exists, and always bake from
  // the editor state, never from the bytes of the save before them (see `ignoreBaseContent`).
  const effectiveBaseFileId = savedFile?.id ?? baseFileId
  const effectiveBaseVersionId = savedFile ? null : baseVersionId

  // The bytes every save in this session authors FROM: what we opened, never what we last wrote.
  // The move-exactly-once rule lives in `contentBasePin.ts`; this only holds the state.
  const [pinnedContentBase, setPinnedContentBase] = useState<EditorContentBasePin | null>(
    () => initialContentBasePin(baseFileId, baseVersionId)
  )
  const contentBase = pinnedContentBase ?? undefined
  const adoptArchivedVersion = useCallback((savedFileId: string, archivedVersionId: string | null | undefined) => {
    setPinnedContentBase((current) => nextContentBasePin(current, savedFileId, archivedVersionId))
  }, [])

  /**
   * The file's version counter as this session last knew it: at open, then one higher after each
   * of our own saves. Tracking OUR saves is what makes the check meaningful: comparing against a
   * fixed open-time value would flag our second save as somebody else's work.
   */
  const expectedVersionNumberRef = useRef<number | null>(null)
  // Seeded once, when the base file's DTO lands (it arrives after mount). Guarded so our own
  // saves, which move the counter deliberately, never reset the baseline back to open time.
  if (expectedVersionNumberRef.current === null && openedVersionNumber != null) {
    expectedVersionNumberRef.current = openedVersionNumber
  }

  /**
   * Ask before superseding a save someone else made while this session was open.
   *
   * We author from the bytes we opened (see the content-base pin), so their version stays in
   * history but is NOT an ancestor of ours, that is the decision, and it is exactly the thing a
   * user should get to see rather than discover later in the version list. Read fresh, never
   * through the query cache, or the check answers from whatever this session last saw.
   *
   * Best-effort: a failed read must not block a save. Being unable to check is not evidence of a
   * conflict, and turning a transient GET failure into a blocked save would be worse than the
   * race it guards.
   */
  const confirmOverwritingConcurrentSave = useCallback(async (fileId: string | null): Promise<boolean> => {
    if (!saveTarget.isLibraryBacked || !fileId) return true
    let current: number | null = null
    try {
      const { file } = await apiFetch<{ file: { currentVersionNumber?: number } }>(`/api/library/${fileId}`)
      current = file.currentVersionNumber ?? null
    } catch {
      return true
    }
    if (current === null) return true

    const expected = expectedVersionNumberRef.current
    // Our save adds one, whatever we found, so the baseline is right even if we let a conflict through.
    expectedVersionNumberRef.current = current + 1
    if (expected === null || current === expected) return true

    return await confirm({
      title: 'This project changed since you opened it',
      description: `Someone saved version ${current} while you had this open. Saving adds version ${current + 1} with your work; their changes stay in the version history but are not carried into yours.`,
      confirmLabel: 'Save anyway',
      cancelLabel: 'Cancel',
      color: 'warning'
    })
  }, [confirm, saveTarget])

  const handleApply = useCallback(() => {
    const current = stateRef.current
    if (!current || !onApply) return
    // Busy BEFORE the thumbnail capture, not after: capture + scene build take seconds on a big
    // project, and until this flips the button looks unclicked. See `afterNextPaint`.
    setSaving(true)
    void (async () => {
      try {
          await afterNextPaint()
          const thumbnails = await captureAllPlateThumbnails(current)
          onApply(buildSceneEditOut(current, { thumbnails }))
      } finally {
        setSaving(false)
      }
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
      const materialsPresent = hasMaterials
        ? hasMaterials()
        : (sliceConfigRef.current?.projectFilaments?.length ?? 0) > 0
      if (!materialsPresent) {
        toast.error('Add a material to the project before saving.')
        return null
      }
      const asProject = options?.asProject !== false
      setSaving(true)
      try {
          const file = await saveTarget.persist(payload)
          // Null means the user backed out (a dismissed destination picker), not a failure: leave the
          // project dirty and say nothing, rather than reporting a save that did not happen.
          if (!file) return null
          // Before anything else: the bytes we authored from now live at an archived id. Pinning is
          // not conditional on `asProject`, a single-object export writes a real version too, and
          // leaving the pin on a head that has moved would silently re-chain the next save.
          adoptArchivedVersion(file.id, file.archivedVersionId)
          if (asProject) {
            markSaved()
            // The save renumbered the session's filament ids to the desired list's 1..N (the
            // emit-side translation in buildSceneEditOut); the live editor state must follow: see
            // onFilamentsRenumbered. Computed HERE, from the same controller list the bake used,
            // so the two sides of the invariant can never disagree about the map.
            if (onFilamentsRenumbered) {
              const sessionIds = sliceConfigRef.current?.projectFilaments.map((filament) => filament.projectFilamentId)
              const remap = sessionIds && sessionIds.length > 0 ? buildSessionFilamentIdRemap(sessionIds) : null
              if (remap) onFilamentsRenumbered(remap)
            }
            // The saved 3MF bakes the session's material list as its filament list; tell the
            // controller so it renumbers to match. It does that IN MEMORY and immediately, it wrote
            // the list, so it does not need the refetched index to tell it what it just saved, which
            // is why there is no ordering constraint here any more. This call used to have to happen
            // BEFORE the invalidation below, because the controller detected the save by watching its
            // base material list change; arming late lost the race and an added material rendered
            // twice, then baked into the NEXT save as a real duplicate slot.
            const sourceRemap = sliceConfigRef.current?.onProjectSaved() ?? null
            if (sourceRemap) onFilamentSourcesRemapped?.(sourceRemap)
          }
          // Library bookkeeping only: a local target has no cached listings to refresh.
          if (saveTarget.isLibraryBacked) await invalidateLibraryQueries(queryClient)
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
    [onSaved, queryClient, markSaved, sliceConfigRef, saveTarget, hasMaterials, onFilamentsRenumbered, onFilamentSourcesRemapped, adoptArchivedVersion]
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
    // Identities that can carry per-object settings: placed objects PLUS the retained identity of
    // every replaced object (see objectIdsAcceptingOverrides). `scope` narrows that to a synthetic
    // state (the single-object export), so only that object's overrides ride along.
    const source = scope ?? stateRef.current
    const placed = source ? objectIdsAcceptingOverrides(source) : new Set<number>()
    // The selection rule (and the reason absence must not read as a delete) lives in
    // `selectObjectProcessOverridesForSave`, where it is tested.
    return selectObjectProcessOverridesForSave(value, placed)
  }, [sliceConfigRef, stateRef])

  // Global (project-wide) process overrides authored in the editor. Sent with every save so they
  // persist into the saved 3MF's project_settings.config (not just a one-off slice). Empty ⇒ omit,
  // leaving the base project settings untouched.
  const collectProcessSettingOverrides = useCallback((): Record<string, string | string[]> | undefined => {
    const overrides = sliceConfigRef.current?.processSettingOverrides
    return overrides && Object.keys(overrides).length > 0 ? overrides : undefined
  }, [sliceConfigRef])

  /**
   * The project's own machine settings. Sent even when EMPTY, unlike its process sibling: an empty
   * map is how "I reset every printer override" is expressed, and omitting it made that save a
   * no-op that the next open then undid. The server no-ops on its own when the project records
   * nothing either, so an untouched printer still writes nothing.
   *
   * OMITTED, though, until the file's own overrides are KNOWN. Empty means "reset them all", so
   * sending it while the re-hydration lookup has not answered would erase overrides the user still
   * has and never saw: the API answers "unknown" for a bridge that was briefly offline or a history
   * version it cannot find, and the map is legitimately empty until an answer arrives. Omitting
   * leaves the project's record untouched, which is the only safe reading of "I do not know".
   */
  const collectMachineSettingOverrides = useCallback((): Record<string, string | string[]> | undefined => {
    const config = sliceConfigRef.current
    if (!config) return undefined
    const overrides = config.machineSettingOverrides
    if (overrides && Object.keys(overrides).length > 0) return overrides
    return config.machineSettingOverridesKnown ? overrides : undefined
  }, [sliceConfigRef])

  // Per-MATERIAL tune overrides ("Save in this 3MF"), keyed by the material's 1-based SAVED slot
  // position, the position in the desired list the save bakes as slots 1..N, never its session
  // id, which a material add/remove renumbers (audit invariant I4). Empty ⇒ omit.
  const collectFilamentSettingOverrides = useCallback((): Record<string, Record<string, string | string[]>> | undefined => {
    const config = sliceConfigRef.current
    if (!config) return undefined
    const out: Record<string, Record<string, string | string[]>> = {}
    config.projectFilaments.forEach((filament, index) => {
      const overrides = config.filamentSettingOverridesById[filament.projectFilamentId]
      if (overrides && Object.keys(overrides).length > 0) out[String(index + 1)] = overrides
    })
    return Object.keys(out).length > 0 ? out : undefined
  }, [sliceConfigRef])

  const handleSaveVersion = useCallback(() => {
    const current = stateRef.current
    if (!current) return
    // A library save needs a file to version. A local one does not have (or need) an id at all:
    // requiring one here made Save a no-op for a project opened from disk.
    if (saveTarget.isLibraryBacked && effectiveBaseFileId === null) return
    // Busy from the click, not from `runSave`: the concurrent-save check is a network read and the
    // thumbnail capture is seconds of main-thread work, all of it BEFORE `runSave` would have shown
    // anything. See `afterNextPaint` for why the yield is needed for the spinner to paint.
    setSaving(true)
    void (async () => {
      try {
        await afterNextPaint()
        if (!await confirmOverwritingConcurrentSave(effectiveBaseFileId)) return
        const thumbnails = await captureAllPlateThumbnails(current)
        const retarget = sliceConfigRef.current?.retargetTarget ?? undefined
        await runSave(
          {
            baseFileId: effectiveBaseFileId, baseVersionId: effectiveBaseVersionId, contentBase,
            mode: 'newVersion', ignoreBaseContent: editorBorn,
            sceneEdit: await authorEdit(buildSceneEditOut(current, { thumbnails })),
            objectProcessOverrides: collectObjectProcessOverrides(),
            processSettingOverrides: collectProcessSettingOverrides(),
            machineSettingOverrides: collectMachineSettingOverrides(),
            filamentSettingOverrides: collectFilamentSettingOverrides(),
            retarget,
            slicerTargetId: retarget ? sliceConfigRef.current?.selectedSlicerTargetId : undefined
          },
          retarget ? `Saved a new version for ${retarget.printerModel}` : 'Saved a new version'
        )
      } finally {
        setSaving(false)
      }
    })()
  }, [effectiveBaseFileId, effectiveBaseVersionId, editorBorn, runSave, buildSceneEditOut, authorEdit, captureAllPlateThumbnails, collectObjectProcessOverrides, collectProcessSettingOverrides, collectMachineSettingOverrides, collectFilamentSettingOverrides, stateRef, sliceConfigRef, saveTarget, confirmOverwritingConcurrentSave, contentBase])

  const handleSaveAs = useCallback((name: string, destinationFolderId: string | null) => {
    const current = stateRef.current
    if (!current) return
    setSaveAsOpen(false)
    // Busy before the capture: same reason as `handleSaveVersion`.
    setSaving(true)
    void (async () => {
      try {
        await afterNextPaint()
        const thumbnails = await captureAllPlateThumbnails(current)
        const retarget = sliceConfigRef.current?.retargetTarget ?? undefined
        // A project born in the editor has never been persisted, so its first save is a "save as"
        // only mechanically, there is no earlier file to strand the user on, and its own scaffold
        // holds nothing the editor state doesn't model. Bake from the state so the editor can adopt
        // the result instead of re-mounting on it.
        const firstSaveOfEditorBornProject = editorBorn && savedFile === null
        const saved = await runSave(
          {
            baseFileId: effectiveBaseFileId, baseVersionId: effectiveBaseVersionId, contentBase,
            mode: 'saveAs', name, folderId: destinationFolderId, bridgeId: saveAsBridgeId,
            ignoreBaseContent: firstSaveOfEditorBornProject,
            sceneEdit: await authorEdit(buildSceneEditOut(current, { thumbnails })),
            objectProcessOverrides: collectObjectProcessOverrides(),
            processSettingOverrides: collectProcessSettingOverrides(),
            machineSettingOverrides: collectMachineSettingOverrides(),
            filamentSettingOverrides: collectFilamentSettingOverrides(),
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
        // on the new one, and re-reading it is also what turns this session's staged imports into
        // in-project objects, which an adopted project deliberately skips.
        onSavedAs?.(saved)
      } finally {
        setSaving(false)
      }
    })()
  }, [effectiveBaseFileId, effectiveBaseVersionId, editorBorn, savedFile, saveAsBridgeId, runSave, buildSceneEditOut, authorEdit, captureAllPlateThumbnails, collectObjectProcessOverrides, collectProcessSettingOverrides, collectMachineSettingOverrides, collectFilamentSettingOverrides, stateRef, sliceConfigRef, onSavedAs, contentBase])

  /**
   * "Export object as 3MF": bake ONLY the given object into a new single-plate 3MF library
   * file through the normal save pipeline, so its parts, per-part materials/types, paint,
   * added volumes, and per-object process overrides all survive (everything an STL export
   * flattens away). Unlike Save-As, the editor stays on the source project and its dirty
   * state is untouched: the export is a copy, not a save of the project.
   */
  const handleExportObjectAs3mf = useCallback((key: string, name: string, destinationFolderId: string | null) => {
    const current = stateRef.current
    if (!current) return
    const exportState = buildSingleObjectExportState(current, key, worldFootprintCenterFor(key) ?? undefined)
    if (!exportState) return
    setSaving(true)
    void (async () => {
      try {
        await afterNextPaint()
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
            machineSettingOverrides: collectMachineSettingOverrides(),
            filamentSettingOverrides: collectFilamentSettingOverrides(),
            retarget,
            slicerTargetId: retarget ? sliceConfigRef.current?.selectedSlicerTargetId : undefined,
            // Marker: the library treats the export as a reusable model (preview on click),
            // not an openable project: see the shared index parser's model-kind doc.
            objectExport: true
          },
          `Exported “${name}”`,
          { asProject: false }
        )
      } finally {
        setSaving(false)
      }
    })()
  }, [baseFileId, baseVersionId, saveAsBridgeId, runSave, buildSceneEditOut, captureAllPlateThumbnails, worldFootprintCenterFor, collectObjectProcessOverrides, collectProcessSettingOverrides, collectMachineSettingOverrides, collectFilamentSettingOverrides, stateRef, sliceConfigRef])

  /**
   * "Download 3MF project": the same single-object bake as {@link handleExportObjectAs3mf}
   * but streamed straight back as a download (`POST /api/editor/export-3mf`: see the route's
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
          await afterNextPaint()
          const thumbnails = await captureAllPlateThumbnails(exportState, { force: true, updateLive: false })
          const retarget = sliceConfigRef.current?.retargetTarget ?? undefined
          const payload: ExportArrangedThreeMf = {
            baseFileId,
            baseVersionId,
            name: fileName,
            sceneEdit: buildSceneEditOut(exportState, { thumbnails }),
            objectProcessOverrides: collectObjectProcessOverrides(exportState),
            processSettingOverrides: collectProcessSettingOverrides(),
            machineSettingOverrides: collectMachineSettingOverrides(),
            filamentSettingOverrides: collectFilamentSettingOverrides(),
            retarget,
            slicerTargetId: retarget ? sliceConfigRef.current?.selectedSlicerTargetId : undefined,
            // Marker: re-uploaded downloads classify as reusable models, not projects.
            objectExport: true
          }
          const bytes = await saveTarget.exportBytes(payload)
          downloadBlob(new Blob([bytes as BlobPart], { type: 'model/3mf' }), fileName)
          toast.success(`Exported ${fileName}.`)
        } catch (error) {
          toast.error(error instanceof Error ? error.message : 'Unable to export the object.')
      } finally {
        setSaving(false)
      }
    })()
  }, [baseFileId, baseVersionId, buildSceneEditOut, captureAllPlateThumbnails, worldFootprintCenterFor, collectObjectProcessOverrides, collectProcessSettingOverrides, collectMachineSettingOverrides, collectFilamentSettingOverrides, stateRef, sliceConfigRef, saveTarget])

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
