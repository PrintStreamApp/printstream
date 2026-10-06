/**
 * Re-homes an independent copy's staged model and added volumes after the synchronous clone.
 * `EditorView` owns the plate mutation and history checkpoint. This controller re-reads live
 * state after each await so undo or deletion cannot attach a late import to a removed copy.
 */
import { stageAddedPartGeometry } from './addedParts'
import type { EditorImportStore } from './editorImportStore'
import type { EditorInstance, EditorState } from './editorModel'

type EditorStateRef = { current: EditorState | null }

interface PerObjectSettings {
  value: Record<string, Record<string, string | string[]>>
  onChange: (next: Record<string, Record<string, string | string[]>>) => void
}

interface IndependentCopyImportsContext {
  stateRef: EditorStateRef
  importStore: EditorImportStore
  getPerObjectSettings: () => PerObjectSettings | null | undefined
  onImportsChanged: () => void
}

/**
 * Keep independent copies' process overrides and mesh imports separate from their sources.
 * Staging failures are logged and leave the source import in place rather than dropping geometry.
 */
export function createEditorIndependentCopyImports(context: IndependentCopyImportsContext) {
  const { stateRef, importStore, getPerObjectSettings, onImportsChanged } = context

  /** Read the current instance again after asynchronous staging, never a captured plate snapshot. */
  function findInstance(key: string): EditorInstance | null {
    return stateRef.current?.plates.flatMap((plate) => plate.instances)
      .find((entry) => entry.key === key) ?? null
  }

  return {
    /** Copy unsaved per-object process overrides to the new object identity. */
    copyProcessOverrides(sourceObjectId: number, cloneObjectId: number): void {
      const perObjectSettings = getPerObjectSettings()
      const existing = perObjectSettings?.value[String(sourceObjectId)]
      if (!perObjectSettings || !existing || Object.keys(existing).length === 0) return
      perObjectSettings.onChange({
        ...perObjectSettings.value,
        [String(cloneObjectId)]: { ...existing }
      })
    },

    /** Give a committed independent import its own mesh without moving its placed geometry. */
    async restageMesh(instanceKey: string): Promise<void> {
      const instance = findInstance(instanceKey)
      if (!instance || instance.source.kind !== 'import') return
      const sourceImportId = instance.source.importId

      let staged: { importId: string }
      try {
        const bytes = await importStore.fetchMesh(sourceImportId)
        staged = await importStore.stageFile(
          new File([bytes], `${instance.name || 'copy'}.stl`, { type: 'application/octet-stream' }),
          'part'
        )
      } catch (error) {
        console.warn('[editor] could not re-stage an independent copy\'s mesh', error)
        return
      }

      const live = findInstance(instanceKey)
      if (!live || live.source.kind !== 'import' || live.source.importId !== sourceImportId) return
      live.source = {
        ...live.source,
        importId: staged.importId,
        meshUrl: importStore.meshUrl(staged.importId)
      }
      onImportsChanged()
    },

    /** Re-stage each added volume so copied paint cannot alter the source's import. */
    async restageVolumes(cloneObjectId: number): Promise<void> {
      const parts = stateRef.current?.addedParts?.[cloneObjectId]
      if (!parts || parts.length === 0) return

      const restaged = await Promise.all(parts.map(async (part) => {
        try {
          const staged = await stageAddedPartGeometry(
            importStore,
            { kind: 'soup', soup: part.soup, name: part.name },
            0
          )
          return { key: part.key, importId: staged.importId }
        } catch (error) {
          console.warn('[editor] could not re-stage an independent copy\'s volume', error)
          return null
        }
      }))
      const byKey = new Map(restaged
        .filter((entry): entry is { key: string; importId: string } => entry !== null)
        .map((entry) => [entry.key, entry.importId]))
      if (byKey.size === 0) return

      const live = stateRef.current?.addedParts?.[cloneObjectId]
      if (!live) return
      // Follow the editor's existing in-place addedParts mutation and announce it to the mesh
      // builder and memoized sidebar through the version signal.
      stateRef.current!.addedParts![cloneObjectId] = live.map((part) => {
        const importId = byKey.get(part.key)
        return importId ? { ...part, importId } : part
      })
      onImportsChanged()
    }
  }
}
