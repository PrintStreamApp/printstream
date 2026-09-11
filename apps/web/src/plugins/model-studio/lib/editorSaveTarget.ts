/**
 * Where a saved project goes.
 *
 * BOTH hosts bake in the tab now. What differs is where the finished bytes land: the library host
 * uploads them and the server writes a `LibraryFile` version, while a host with only a local file
 * writes them back to the user's disk, persists nothing, and has no library to invalidate or slice
 * controller to notify.
 *
 * The bake moved off the server because the server had to be TOLD which bytes a `SceneEdit` was a
 * diff against, and that answer could be wrong: the file's head moves when the session saves, so a
 * later bake re-applied the edit over its own output. `partOrder` and `removedParts` are not
 * idempotent under that, and a re-applied reorder permutes an object's volumes while the positional
 * per-part `extruder` writes stay put, so parts trade materials silently. The browser holds the
 * bytes it opened, so the question has no way to be answered wrongly.
 *
 * That last part is why {@link EditorSaveTarget.isLibraryBacked} exists rather than the hook
 * sniffing for a controller: the post-save choreography around a library save is order-sensitive
 * (see `useEditorSave`) and must be skipped wholesale, not partially, when there is no library.
 */
import type { ExportArrangedThreeMf, SaveArrangedThreeMf, SceneEdit, SlicingPresetSummary, SlicingTarget } from '@printstream/shared'
import { apiFetch } from '../../../lib/apiClient'
import {
  uploadLibraryFileInChunks,
  type ChunkedLibraryUploadProgress
} from '../../../lib/chunkedLibraryUpload'
import { bakeClientThreeMf } from './clientThreeMfBake'
import { WORKSPACE_RETARGET_RESOLVERS } from './browserMachineRetarget'
import { bakeOptionsFor, bakePassesFor } from './editorBakePasses'
import { importIdsReferencedBy, type EditorImportStore } from './editorImportStore'
import type { ThreeMfArchive } from './threeMfArchive'

/** What a completed save reports back. */
export interface EditorSavedFile {
  id: string
  name: string
  /**
   * The version row this save archived: the content that was current until now, i.e. the bytes
   * this save authored FROM. The caller pins it so the NEXT save authors from the same original
   * rather than from this save's output (see `contentBase` in the shared save schema).
   *
   * Null when nothing was archived (a save that created a new file, or a target with no version
   * history at all), which the caller reads as "keep the pin you already have".
   */
  archivedVersionId?: string | null
}

/** Named lifecycle hooks shared by save and upload transports. */
export interface EditorPersistenceLifecycle {
  signal?: AbortSignal
  /** Browser work before bytes exist and upload progress can be measured. */
  onLocalPhase?: (phase: 'checking' | 'creating') => void
  onProgress?: (progress: ChunkedLibraryUploadProgress) => void
  onCommitStart?: () => void
  onReconciliationStart?: (stopWaiting: () => void) => void
  onReconciliationRequired?: (retry: () => void, message: string, stopWaiting: () => void) => void
  /** Keeps an interactive save failure in the progress dialog instead of reducing it to a toast. */
  onError?: (message: string) => void
}

export interface EditorSaveTarget {
  /**
   * Persist an edited project.
   *
   * @returns the saved file's identity, or null when the save did not happen for a reason the user
   *   already knows about (they dismissed a destination picker). A FAILURE throws instead, so the
   *   caller can surface it, a silent null would look like a successful save that saved nothing.
   *   An aborted signal stops browser work and the chunked upload at its next cancellation point.
   */
  persist(payload: SaveArrangedThreeMf, lifecycle?: EditorPersistenceLifecycle): Promise<EditorSavedFile | null>
  /** Bake without persisting, for the "download a copy" paths. */
  exportBytes(payload: ExportArrangedThreeMf): Promise<Uint8Array>
  /**
   * Bake and stage the bytes so something server-side can read them, WITHOUT saving the project.
   *
   * How a slice of unsaved editor work reaches the slicer. The row is hidden, content-deduped and
   * reclaimed when nothing references it, so the user's project gains no version and nothing
   * appears in their library. Absent on a host with no library to stage into, which is also a host
   * that cannot slice.
   *
   * @returns the staged file's id.
   * @throws AbortError when the caller cancels before staging commits.
   */
  stageSnapshot?(input: StageSnapshotInput, signal?: AbortSignal): Promise<string>
  /**
   * True when a save lands in the library, so the caller should invalidate library queries and tell
   * the slice controller to rebase its material overlay. False for a local file.
   */
  readonly isLibraryBacked: boolean
}

/**
 * What to bake and stage for a slice.
 *
 * Deliberately NOT a save payload. `configurationBaseFileId` is not a bake target and must not
 * read like one: nothing is written to that file, it lends its bridge and identifies the bytes
 * this editor session opened. `sourceFileId` independently preserves the project this slice is
 * about after Save As changes its library lineage.
 *
 * The complete frozen target is carried because this snapshot is the final engine-ready project,
 * not a save and not an intermediate for another authoring pass on the server.
 */
export interface StageSnapshotInput {
  sceneEdit: SceneEdit
  sourceFileId: string
  configurationBaseFileId: string
  configurationBaseVersionId: string | null
  objectProcessOverrides?: Record<string, Record<string, string | string[]>> | undefined
  /** The frozen target the host is about to submit with this prepared source. */
  target: SlicingTarget
  slicerTargetId: string | null
  onPhase?: (phase: 'applying' | 'uploading' | 'finalizing' | 'reconciling') => void
  onProgress?: (progress: ChunkedLibraryUploadProgress) => void
  onReconciliationStart?: (stopWaiting: () => void) => void
  onReconciliationRequired?: (retry: () => void, message: string, stopWaiting: () => void) => void
}

export interface ApiSaveTargetOptions {
  /** The bytes this session opened, which every bake authors from. See `editorProjectSource.ts`. */
  archive: () => ThreeMfArchive | null
  /** Staged geometry the `SceneEdit` refers to. */
  importStore: EditorImportStore
  /** The open project's name, for the upload session. See `persist` for why it is cosmetic. */
  projectName: () => string
}

/**
 * The workspace's filament catalogue, fetched once per editor session and AWAITED before it is read.
 *
 * Only a machine retarget reads it, to pick each slot's rebind target, so it is fetched on the
 * first save that needs one rather than on open, and the promise is cached so later saves reuse it.
 *
 * Awaited deliberately. Firing the request and reading a mutable array through a getter looks
 * equivalent and is not: a save issued while the request is in flight sees an EMPTY catalogue, no
 * slot finds a rebind target, and the retargeted project silently keeps the source machine's
 * filament presets. That is a save the user made deliberately, answered wrongly, with nothing
 * reported.
 *
 * An unreachable catalogue answers EMPTY rather than throwing: a rebind is an improvement pass, and
 * the save it rides must not fail because the list could not be read. Cancellation is different: it
 * rejects and is never cached, so Cancel stops this save and a later retry gets a fresh request.
 */
function createFilamentCatalogue(): (signal?: AbortSignal) => Promise<readonly SlicingPresetSummary[]> {
  let pending: Promise<readonly SlicingPresetSummary[]> | null = null
  return (signal) => {
    signal?.throwIfAborted()
    pending ??= apiFetch<{ profiles: SlicingPresetSummary[] }>('/api/slicing/profiles', signal ? { signal } : undefined)
      .then((body) => body.profiles as readonly SlicingPresetSummary[])
      .catch((error) => {
        pending = null
        signal?.throwIfAborted()
        if (error instanceof Error && error.name === 'AbortError') throw error
        return []
      })
    return pending
  }
}

/**
 * The library-backed target: bake in the tab, upload the bytes, let the server write the version.
 */
export function createApiSaveTarget(options: ApiSaveTargetOptions): EditorSaveTarget {
  const filamentPresets = createFilamentCatalogue()
  const bake = async (
    payload: SaveArrangedThreeMf | ExportArrangedThreeMf,
    signal?: AbortSignal
  ): Promise<Uint8Array> => {
    signal?.throwIfAborted()
    const archive = options.archive()
    // A null archive means `bakeClientThreeMf` writes a from-scratch project: correct for a brand-new
    // one, and correct for an `ignoreBaseContent` save, which says outright that it carries none of
    // the base. It is CATASTROPHIC for anything else, because the upload addresses an existing row
    // by id, so the near-empty result lands as a new VERSION of the user's project. The source can
    // legitimately be released while the editor is still open (its `dispose` nulls the handle, and
    // React StrictMode fires effect cleanups spuriously), so this is reachable without a bug
    // upstream. Refuse rather than bake: the save fails loudly and the project stays intact.
    if (!archive && payload.baseFileId != null && !('ignoreBaseContent' in payload && payload.ignoreBaseContent)) {
      throw new Error('The project this edit was opened from is no longer available; reopen it and save again.')
    }
    const { bytes } = await bakeClientThreeMf(
      archive,
      payload.sceneEdit,
      await options.importStore.importsForBake(signal, importIdsReferencedBy(payload.sceneEdit)),
      bakeOptionsFor(payload),
      // The WORKSPACE resolvers, which reach this workspace's own presets as well as the built-ins.
      // That is the whole difference from the public host.
      bakePassesFor(payload, { resolvers: WORKSPACE_RETARGET_RESOLVERS, filamentPresets, signal }),
      signal
    )
    signal?.throwIfAborted()
    return bytes
  }

  return {
    isLibraryBacked: true,

    async persist(payload, lifecycle = {}) {
      const bytes = await bake(payload, lifecycle.signal)
      // For a new VERSION the name is cosmetic: the addressed row keeps its own, precisely because
      // this session's copy of it may be stale. It still has to be a `.3mf` for the upload to
      // classify the kind correctly.
      const name = ensureThreeMfName(payload.name ?? options.projectName())
      const uploaded = await uploadLibraryFileInChunks(new File([bytes as BlobPart], name), {
        signal: lifecycle.signal,
        onProgress: lifecycle.onProgress,
        onCommitStart: lifecycle.onCommitStart,
        onReconciliationStart: lifecycle.onReconciliationStart,
        onReconciliationRequired: lifecycle.onReconciliationRequired,
        // A new VERSION addresses the row by id, never by name: the project may have been renamed
        // or moved since this session opened it, and a name match would then quietly write a second
        // file instead of a version. A saveAs is a new file and names its destination instead.
        ...(payload.mode === 'saveAs'
          ? { folderId: payload.folderId ?? null, bridgeId: payload.bridgeId ?? null }
          : { targetFileId: payload.baseFileId }),
      })
      return {
        id: uploaded.file.id,
        name: uploaded.file.name,
        archivedVersionId: uploaded.archivedVersionId
      }
    },

    async exportBytes(payload) {
      return bake(payload)
    },

    async stageSnapshot(input, signal) {
      signal?.throwIfAborted()
      const archive = options.archive()
      if (!archive) {
        throw new Error('The project this edit was opened from is no longer available; reopen it and slice again.')
      }
      input.onPhase?.('applying')
      const { bytes } = await bakeClientThreeMf(
        archive,
        input.sceneEdit,
        await options.importStore.importsForBake(signal, importIdsReferencedBy(input.sceneEdit)),
        input.objectProcessOverrides ? { objectProcessOverrides: input.objectProcessOverrides } : {},
        {
          sliceTarget: {
            target: input.target,
            slicerTargetId: input.slicerTargetId,
            resolvers: WORKSPACE_RETARGET_RESOLVERS,
            ...(signal ? { signal } : {})
          }
        },
        signal
      )
      signal?.throwIfAborted()
      input.onPhase?.('uploading')
      const uploaded = await uploadLibraryFileInChunks(
        new File([bytes as BlobPart], ensureThreeMfName(options.projectName())),
        {
          snapshot: true,
          targetFileId: input.configurationBaseFileId,
          preparedSlicing: {
            contractVersion: 1,
            sourceFileId: input.sourceFileId,
            target: input.target,
            slicerTargetId: input.slicerTargetId,
            configurationBaseVersionId: input.configurationBaseVersionId
          },
          signal,
          onProgress: input.onProgress,
          onCommitStart: () => input.onPhase?.('finalizing'),
          onReconciliationStart: (stopWaiting) => {
            input.onPhase?.('reconciling')
            input.onReconciliationStart?.(stopWaiting)
          },
          onReconciliationRequired: input.onReconciliationRequired
        }
      )
      if (!uploaded.preparedSourceId) {
        throw new Error('The server did not confirm the prepared slicing project.')
      }
      return uploaded.preparedSourceId
    }
  }
}

/** A project must be named `.3mf`, whichever path produced the name. */
function ensureThreeMfName(name: string | null | undefined): string {
  const trimmed = (name ?? '').trim() || 'project.3mf'
  return trimmed.toLowerCase().endsWith('.3mf') ? trimmed : `${trimmed}.3mf`
}
