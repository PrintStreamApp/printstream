/**
 * Owns the material boundary shared by editor Save and Slice. Session filament ids
 * become baked slot ids in the emitted edit; after Save, live state adopts the saved
 * ids and waits to recolour until the slice controller exposes those same ids.
 * Both output paths attach preset physics in the browser because a material-list bake
 * can drop the source configs. A repair pinned during this session wins over a later
 * catalogue lookup, which might return different values from what the user accepted.
 */
import { useCallback, useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import type { SceneEdit } from '@printstream/shared'
import type { FilamentConfigResolver } from '../../components/library/FilamentSettingsDialog'
import type { SliceSettingsController } from '../../components/library/SliceSettingsPanel'
import { resolvableMaterialProfileId } from '../../lib/slicingPresetMatching'
import { applyRepairedFilamentConfigs, attachResolvedFilamentConfigs, rekeyByBakedSlot } from './lib/filamentConfigAuthoring'
import { rebaseEditorStateFilamentIds, type EditorState } from './lib/editorModel'
import type { EditorMaterials } from './lib/editorMaterials'

interface FilamentSaveAuthoringOptions {
  stateRef: MutableRefObject<EditorState | null>
  setState: Dispatch<SetStateAction<EditorState | null>>
  sliceConfigRef: MutableRefObject<SliceSettingsController | undefined>
  materials: EditorMaterials
  setMaterialSyncToken: Dispatch<SetStateAction<number>>
  resolveFilamentConfig?: FilamentConfigResolver
  baseFileId: string | null
}

/** Return the callbacks used by Save and Slice to author and rebase filament state. */
export function useEditorFilamentSaveAuthoring(options: FilamentSaveAuthoringOptions) {
  const {
    stateRef,
    setState,
    sliceConfigRef,
    materials,
    setMaterialSyncToken,
    resolveFilamentConfig,
    baseFileId
  } = options
  const pendingRenumberIdsRef = useRef<number[] | null>(null)

  const handleFilamentsRenumbered = useCallback((remap: Map<number, number>) => {
    // A saved-id migration changes representation, not user intent, so it skips history.
    setState((current) => (current ? rebaseEditorStateFilamentIds(current, remap) : current))
    // Recolouring before the controller rebases its options makes every new id look deleted.
    pendingRenumberIdsRef.current = [...new Set(remap.values())]
  }, [setState])

  useEffect(() => {
    const pending = pendingRenumberIdsRef.current
    if (!pending) return
    const available = new Set(materials.options.map((option) => option.id))
    if (!pending.every((id) => available.has(id))) return
    pendingRenumberIdsRef.current = null
    setMaterialSyncToken((token) => token + 1)
  }, [materials, setMaterialSyncToken])

  /** Attach session repair pins and live preset physics to the baked slot order. */
  const authorFilamentConfigs = useCallback(async (edit: SceneEdit, authoringOptions?: { signal?: AbortSignal }) => {
    const controller = sliceConfigRef.current
    const orderedSessionIds = (controller?.projectFilaments ?? []).map((filament) => filament.projectFilamentId)
    const profileIdBySessionId = Object.fromEntries(Object.entries(controller?.filamentMaterialOptionIds ?? {}).map(
      ([filamentId, optionId]) => [
        filamentId,
        resolvableMaterialProfileId(controller?.materialOptions.find((option) => option.id === optionId)) ?? undefined
      ]
    ))
    return attachResolvedFilamentConfigs(
      applyRepairedFilamentConfigs(edit, rekeyByBakedSlot(stateRef.current?.repairedFilamentConfigs, orderedSessionIds)),
      resolveFilamentConfig,
      {
        targetId: controller?.selectedSlicerTargetId ?? null,
        sourceFileId: baseFileId,
        profileIdByFilamentId: rekeyByBakedSlot(profileIdBySessionId, orderedSessionIds),
        signal: authoringOptions?.signal
      }
    )
  }, [resolveFilamentConfig, stateRef, sliceConfigRef, baseFileId])

  return { handleFilamentsRenumbered, authorFilamentConfigs }
}
