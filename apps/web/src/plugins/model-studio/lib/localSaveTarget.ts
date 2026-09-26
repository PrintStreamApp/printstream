/**
 * Saving to the user's own disk.
 *
 * The local {@link EditorSaveTarget}: bake the `SceneEdit` in the tab with the shared bake, then
 * write the bytes back through the file handle the user opened (or a download where the browser has
 * no File System Access). Nothing is persisted server-side and there is no library to invalidate.
 *
 * Per-object process overrides ride the save REQUEST rather than the `SceneEdit`, so they are only
 * visible here, they are handed to the bake explicitly. The api applies the same transform in its
 * own later pass while preparing a slice; the browser folds it into its single bake.
 *
 * The MACHINE RETARGET rides the request the same way (`payload.retarget`) and is applied here for
 * the same reason: the api runs it as a post-bake pass over the file it just wrote, so the browser
 * runs it as a post-bake pass over the file it just wrote. Both call the same shared rewrite: see
 * `lib/browserMachineRetarget.ts`. Without it a printer switch was simply lost on save: the bake
 * preserves the project's embedded machine, so reopening showed the original printer again.
 */
import type { ExportArrangedThreeMf, SaveArrangedThreeMf, SlicingPresetSummary } from '@printstream/shared'
import { bakeClientThreeMf, bakeCompleteProjectThreeMf } from './clientThreeMfBake'
import { PUBLIC_RETARGET_RESOLVERS } from './browserMachineRetarget'
import { bakeOptionsFor, bakePassesFor } from './editorBakePasses'
import { importIdsReferencedBy, type EditorImportStore } from './editorImportStore'
import type { EditorSaveTarget } from './editorSaveTarget'
import type { ThreeMfArchive } from './threeMfArchive'
import { saveLocalProjectAs, suggestedSaveName, type LocalProjectFile } from './localProjectFile'

export interface LocalSaveTargetOptions {
  /** The opened project's archive, or null for a project built from scratch in the editor. */
  archive: () => ThreeMfArchive | null
  /** Staged geometry to bake in: the local store holds the meshes the `SceneEdit` refers to. */
  importStore: EditorImportStore
  /** The file being edited, or null before the project has ever been written to disk. */
  projectFile: () => LocalProjectFile | null
  /** Called after a save writes somewhere new, so the host can adopt the handle for later saves. */
  onProjectFileChanged: (file: LocalProjectFile) => void
  /**
   * The filament catalogue a machine retarget picks its slot rebinds from: built-ins plus the
   * user's browser-stored presets, read live because it settles asynchronously after open.
   */
  filamentPresets: () => readonly SlicingPresetSummary[]
}

export function createLocalSaveTarget(options: LocalSaveTargetOptions): EditorSaveTarget {
  const bake = async (
    payload: SaveArrangedThreeMf | ExportArrangedThreeMf,
    signal?: AbortSignal,
    requireCompleteMaterials = false
  ): Promise<Uint8Array> => {
    signal?.throwIfAborted()
    const bakeArgs = [
      options.archive(),
      payload.sceneEdit,
      await options.importStore.importsForBake(signal, importIdsReferencedBy(payload.sceneEdit)),
      bakeOptionsFor(payload),
      // The anonymous resolvers: this host reaches the built-in catalogue only, which is what makes
      // it decline a retarget onto a preset it cannot see rather than author half a machine.
      bakePassesFor(payload, {
        resolvers: PUBLIC_RETARGET_RESOLVERS,
        // Already in hand on this host: its catalogue is browser-stored plus the builtin list.
        filamentPresets: async () => options.filamentPresets(),
        signal
      })
    ] as const
    const { bytes } = requireCompleteMaterials
      ? await bakeCompleteProjectThreeMf(...bakeArgs, 'save', signal)
      : await bakeClientThreeMf(...bakeArgs, signal)
    signal?.throwIfAborted()
    return bytes
  }

  return {
    isLibraryBacked: false,

    async persist(payload, lifecycle = {}) {
      const signal = lifecycle.signal
      const bytes = await bake(payload, signal, true)
      const current = options.projectFile()
      // Branch on the save MODE, not on whether a name came along: "Save" means write back to the
      // file the user opened, "Save as" always asks where to put it. Keying off the name instead
      // made a nameless Save-as silently overwrite the original.
      if (payload.mode !== 'saveAs' && current?.saveInPlace) {
        signal?.throwIfAborted()
        lifecycle.onCommitStart?.()
        await current.saveInPlace(bytes)
        // Once the file write resolves, the save committed. A cancellation racing that boundary
        // must report the real outcome so the editor does not stay dirty against updated bytes.
        return { id: current.name, name: current.name }
      }
      signal?.throwIfAborted()
      const saved = await saveLocalProjectAs(suggestedSaveName(payload.name || current?.name || 'project.3mf'), bytes)
      // Null is a dismissed picker: the caller leaves the project dirty and stays quiet.
      if (!saved) return null
      options.onProjectFileChanged(saved)
      return { id: saved.name, name: saved.name }
    },

    exportBytes: bake,

    /** Bake the complete engine-ready project in the tab; the public job client uploads it later. */
    async stageSnapshot(input, signal) {
      signal?.throwIfAborted()
      const archive = options.archive()
      if (!archive) throw new Error('The open project is no longer available; reopen it and slice again.')
      input.onPhase?.('applying')
      const { bytes } = await bakeCompleteProjectThreeMf(
        archive,
        input.sceneEdit,
        await options.importStore.importsForBake(signal, importIdsReferencedBy(input.sceneEdit)),
        input.objectProcessOverrides ? { objectProcessOverrides: input.objectProcessOverrides } : {},
        {
          stripHostScripts: true,
          sliceTarget: {
            target: input.target,
            slicerTargetId: input.slicerTargetId,
            resolvers: PUBLIC_RETARGET_RESOLVERS,
            ...(signal ? { signal } : {})
          }
        },
        'slice',
        signal
      )
      signal?.throwIfAborted()
      return bytes
    }
  }
}
