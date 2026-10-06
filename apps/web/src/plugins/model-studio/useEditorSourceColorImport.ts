/**
 * Owns the pause and commit of a staged model with retained source colours. Geometry, colour
 * paint, and appended project filaments form one user gesture and therefore one history frame.
 * EditorView supplies the geometry commit functions and renders SourceColorImportDialog.
 */
import { useCallback, useState, type MutableRefObject } from 'react'
import type { StagedImport } from '@printstream/shared'
import { buildImportedColorPaint, parseStlMesh } from '@printstream/shared/three-mf'
import type { FilamentOption } from '../../components/library/PlateGcodeSections'
import type { SliceSettingsController } from '../../components/library/SliceSettingsPanel'
import { toast } from '../../lib/toast'
import type { EditorImportStore } from './lib/editorImportStore'
import type { SourceColorPaintCommit } from './lib/editorGeometryReplacement'
import { planSourceColorImport, shouldMapSourceColors,
  type SourceColorImportChoice } from './lib/sourceColorImport'

export interface PendingSourceColorImport {
  staged: StagedImport
  mesh: ReturnType<typeof parseStlMesh>
  sourceColors: Float32Array
  sourceColorMode: NonNullable<StagedImport['sourceColorMode']>
  target: { kind: 'add' } | { kind: 'replace'; key: string }
}

type CommitImport = (
  staged: StagedImport,
  sourceColorPaint?: SourceColorPaintCommit,
  options?: { recordHistory?: boolean }
) => boolean

type CommitReplacement = (
  key: string,
  staged: StagedImport,
  sourceColorPaint?: SourceColorPaintCommit,
  options?: { recordHistory?: boolean }
) => boolean

interface SourceColorImportOptions {
  importStore: EditorImportStore
  filaments: readonly FilamentOption[]
  materialOptionIds: Readonly<Record<number, string>> | null
  onAddFilament?: SliceSettingsController['onAddFilament']
  recordCombinedHistory: () => void
  addStagedImport: CommitImport
  replaceWithStagedRef: MutableRefObject<CommitReplacement>
}

/** Return the pending dialog data and its source-colour staging and commit actions. */
export function useEditorSourceColorImport(options: SourceColorImportOptions) {
  const {
    importStore, filaments, materialOptionIds, onAddFilament,
    recordCombinedHistory, addStagedImport, replaceWithStagedRef
  } = options
  const [pending, setPending] = useState<PendingSourceColorImport | null>(null)
  const canAppend = Boolean(onAddFilament && filaments.some((option) => materialOptionIds?.[option.id] != null))

  /** Pause a staged model for mapping when it carries source appearance. */
  const queueSourceColorMapping = useCallback(async (
    staged: StagedImport,
    target: PendingSourceColorImport['target']
  ): Promise<boolean> => {
    const sourceColorMode = staged.sourceColorMode
    if (!shouldMapSourceColors(sourceColorMode)) return false
    const [sourceColors, meshBytes] = await Promise.all([
      importStore.fetchSourceColors(staged.importId),
      importStore.fetchMesh(staged.importId)
    ])
    if (!sourceColors) return false
    setPending({
      staged,
      sourceColors,
      sourceColorMode,
      mesh: parseStlMesh(new Uint8Array(meshBytes)),
      target
    })
    return true
  }, [importStore])

  /** Commit the mapped geometry and paint before appending predicted filament slots. */
  const applySourceColors = useCallback((choice: SourceColorImportChoice) => {
    if (!pending) return
    const plan = planSourceColorImport(choice, filaments, materialOptionIds)
    if (!plan.ok) {
      toast.error(plan.error)
      return
    }
    const colorPaint = buildImportedColorPaint(
      pending.mesh,
      choice.quantized.labels,
      plan.filamentIds,
      plan.baseFilamentId
    )
    const sourceColorPaint = { filamentId: plan.baseFilamentId, colorPaint }
    if (plan.appended.length > 0) recordCombinedHistory()
    const historyOptions = plan.appended.length > 0 ? { recordHistory: false } : undefined
    const committed = pending.target.kind === 'add'
      ? addStagedImport(pending.staged, sourceColorPaint, historyOptions)
      : replaceWithStagedRef.current(pending.target.key, pending.staged, sourceColorPaint, historyOptions)
    if (!committed) return
    // The controller allocates the predicted ids in order. React batches these filament writes
    // with the geometry and paint, while the combined frame restores both ownership domains.
    for (const filament of plan.appended) onAddFilament?.(filament)
    setPending(null)
    toast.success(`${pending.target.kind === 'add' ? 'Imported' : 'Replaced with'} ${pending.staged.name} with ${choice.quantized.clusters.length} source colours`)
  }, [addStagedImport, filaments, materialOptionIds, onAddFilament, pending,
    recordCombinedHistory, replaceWithStagedRef])

  /** Import the staged geometry while deliberately discarding its source appearance. */
  const skipSourceColors = useCallback(() => {
    if (!pending) return
    const committed = pending.target.kind === 'add'
      ? addStagedImport(pending.staged)
      : replaceWithStagedRef.current(pending.target.key, pending.staged)
    if (!committed) return
    toast.success(`${pending.target.kind === 'add' ? 'Imported' : 'Replaced with'} ${pending.staged.name} without source colours`)
    setPending(null)
  }, [addStagedImport, pending, replaceWithStagedRef])

  const cancelSourceColors = useCallback(() => setPending(null), [])

  return { pending, canAppend, queueSourceColorMapping,
    applySourceColors, skipSourceColors, cancelSourceColors }
}
