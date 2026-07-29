/**
 * Saving to the user's own disk.
 *
 * The local {@link EditorSaveTarget}: bake the `SceneEdit` in the tab with the shared bake, then
 * write the bytes back through the file handle the user opened (or a download where the browser has
 * no File System Access). Nothing is persisted server-side and there is no library to invalidate.
 *
 * Per-object process overrides ride the save REQUEST rather than the `SceneEdit`, so they are only
 * visible here — they are handed to the bake explicitly. The api applies the same transform in its
 * own later pass while preparing a slice; the browser folds it into its single bake.
 */
import type { ExportArrangedThreeMf, SaveArrangedThreeMf } from '@printstream/shared'
import type { ThreeMfBakeOptions } from '@printstream/shared/three-mf'
import { bakeClientThreeMf } from './clientThreeMfBake'
import type { EditorImportStore } from './editorImportStore'
import type { EditorSaveTarget } from './editorSaveTarget'
import type { ThreeMfArchive } from './threeMfArchive'
import { saveLocalProjectAs, suggestedSaveName, type LocalProjectFile } from './localProjectFile'

export interface LocalSaveTargetOptions {
  /** The opened project's archive, or null for a project built from scratch in the editor. */
  archive: () => ThreeMfArchive | null
  /** Staged geometry to bake in — the local store holds the meshes the `SceneEdit` refers to. */
  importStore: EditorImportStore
  /** The file being edited, or null before the project has ever been written to disk. */
  projectFile: () => LocalProjectFile | null
  /** Called after a save writes somewhere new, so the host can adopt the handle for later saves. */
  onProjectFileChanged: (file: LocalProjectFile) => void
}

export function createLocalSaveTarget(options: LocalSaveTargetOptions): EditorSaveTarget {
  const bake = async (payload: SaveArrangedThreeMf | ExportArrangedThreeMf): Promise<Uint8Array> => {
    const objectOverrides = (payload as SaveArrangedThreeMf).objectProcessOverrides
    const bakeOptions: ThreeMfBakeOptions = {
      ...(payload.processSettingOverrides ? { globalProcessOverrides: payload.processSettingOverrides } : {}),
      ...(payload.objectExport ? { objectExportMarker: true } : {}),
      ...(objectOverrides ? { objectProcessOverrides: objectOverrides } : {})
    }
    const { bytes } = await bakeClientThreeMf(
      options.archive(),
      payload.sceneEdit,
      options.importStore.importsForBake(),
      bakeOptions
    )
    return bytes
  }

  return {
    isLibraryBacked: false,

    async persist(payload) {
      const bytes = await bake(payload)
      const current = options.projectFile()
      // Branch on the save MODE, not on whether a name came along: "Save" means write back to the
      // file the user opened, "Save as" always asks where to put it. Keying off the name instead
      // made a nameless Save-as silently overwrite the original.
      if (payload.mode !== 'saveAs' && current?.saveInPlace) {
        await current.saveInPlace(bytes)
        return { id: current.name, name: current.name }
      }
      const saved = await saveLocalProjectAs(suggestedSaveName(payload.name || current?.name || 'project.3mf'), bytes)
      // Null is a dismissed picker: the caller leaves the project dirty and stays quiet.
      if (!saved) return null
      options.onProjectFileChanged(saved)
      return { id: saved.name, name: saved.name }
    },

    exportBytes: bake
  }
}
