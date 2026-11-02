/**
 * Owns file and library staging for add and replace gestures in the mounted editor. Every path
 * enters through the same loading/error boundary, then hands a staged model to the geometry or
 * source-colour commit owner. EditorView still owns picker routing and the geometry commit ref.
 */
import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import type { StagedImport } from '@printstream/shared'
import { toast } from '../../lib/toast'
import type { EditorImportStore } from './lib/editorImportStore'
import type { SourceColorPaintCommit } from './lib/editorGeometryReplacement'
import type { ImportFileSelection } from './lib/importFileSelection'

type ModelSource =
  | { kind: 'file'; file: File; companionFiles: readonly File[] }
  | { kind: 'library'; fileId: string }

type ModelTarget = { kind: 'add' } | { kind: 'replace'; key: string }

interface ModelImportOptions {
  importStore: EditorImportStore
  setImporting: Dispatch<SetStateAction<boolean>>
  setLibraryPickerOpen: Dispatch<SetStateAction<boolean>>
  clearModelRequest: () => void
  addOrMapStagedImport: (staged: StagedImport) => Promise<boolean>
  queueSourceColorMapping: (staged: StagedImport, target: ModelTarget) => Promise<boolean>
  replaceWithStagedRef: MutableRefObject<(
    key: string,
    staged: StagedImport,
    sourceColorPaint?: SourceColorPaintCommit,
    options?: { recordHistory?: boolean }
  ) => boolean>
}

/** Return add and replace actions for the editor's file input and library picker. */
export function useEditorModelImportActions(options: ModelImportOptions) {
  const {
    importStore, setImporting, setLibraryPickerOpen, clearModelRequest,
    addOrMapStagedImport, queueSourceColorMapping, replaceWithStagedRef
  } = options

  /** Stage sequentially to bound parser memory; a failed file must not discard the rest of a pick. */
  const stageAndCommit = useCallback(async (sources: readonly ModelSource[], target: ModelTarget) => {
    setImporting(true)
    try {
      const importedNames: string[] = []
      const failures: string[] = []
      for (const source of sources) {
        try {
          const staged = source.kind === 'file'
            ? await importStore.stageFile(source.file, 'object', undefined, source.companionFiles)
            : await importStore.stageFromLibrary(source.fileId, 'object', undefined)
          if (target.kind === 'add') {
            if (await addOrMapStagedImport(staged)) importedNames.push(staged.name)
            continue
          }
          if (await queueSourceColorMapping(staged, target)) continue
          if (replaceWithStagedRef.current(target.key, staged)) toast.success(`Replaced with ${staged.name}`)
        } catch (error) {
          let fallback = 'Unable to import the model file.'
          if (target.kind === 'replace') fallback = 'Unable to replace the model.'
          else if (source.kind === 'library') fallback = 'Unable to import the selected model.'
          const message = error instanceof Error ? error.message : fallback
          // Report immediately even if a later model is slow; the user-facing batch summary
          // appears after staging finishes. Keep file contents and transport details out of logs.
          console.warn('Model Studio import failed', { source: source.kind, operation: target.kind })
          failures.push(sources.length > 1 && source.kind === 'file' ? `${source.file.name}: ${message}` : message)
        }
      }
      if (importedNames.length > 0) {
        toast.success(sources.length === 1 ? `Imported ${importedNames[0]}` : `Imported ${importedNames.length} models.`)
      }
      if (failures.length > 0) toast.error(failures.join('\n'))
    } finally {
      setImporting(false)
    }
  }, [addOrMapStagedImport, importStore, queueSourceColorMapping, replaceWithStagedRef, setImporting])

  const handleImportFromLibrary = useCallback(async (fileId: string) => {
    setLibraryPickerOpen(false)
    await stageAndCommit([{ kind: 'library', fileId }], { kind: 'add' })
  }, [setLibraryPickerOpen, stageAndCommit])

  const handleImportFiles = useCallback(async (selections: readonly ImportFileSelection[]) => {
    await stageAndCommit(selections.map((selection) => ({ kind: 'file', ...selection })), { kind: 'add' })
  }, [stageAndCommit])

  const handleReplaceFromLibrary = useCallback(async (key: string, fileId: string) => {
    setLibraryPickerOpen(false)
    clearModelRequest()
    await stageAndCommit([{ kind: 'library', fileId }], { kind: 'replace', key })
  }, [clearModelRequest, setLibraryPickerOpen, stageAndCommit])

  const handleReplaceFromFile = useCallback(async (
    key: string,
    file: File,
    companionFiles: readonly File[] = []
  ) => {
    await stageAndCommit([{ kind: 'file', file, companionFiles }], { kind: 'replace', key })
  }, [stageAndCommit])

  return { handleImportFromLibrary, handleImportFiles, handleReplaceFromLibrary, handleReplaceFromFile }
}
