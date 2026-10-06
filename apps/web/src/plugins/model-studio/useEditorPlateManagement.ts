/**
 * Owns plate creation, removal, naming, settings, and strip reordering for one editor session.
 *
 * `updatePlates` remains the session's history and scene-sync boundary. IDs and target indexes
 * are chosen before its updater runs, so a deferred or repeated React update cannot mint extra
 * IDs or focus the wrong plate. Naming and settings are inert edits; reorder skips no-op drops.
 */
import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import type { TextPromptDialogOptions } from '../../components/PromptDialogProvider'
import type { PlateSettingsDraft } from './PlateSettingsDialog'
import {
  INHERITED_PLATE_SETTINGS,
  mintPlateId,
  movePlate,
  reindexPlates,
  type EditorPlate,
  type EditorState
} from './lib/editorModel'
import { defaultPlateName, plateDisplayName, resolvePlateRename } from './lib/plateName'

interface PlateManagementOptions {
  stateRef: MutableRefObject<EditorState | null>
  updatePlates: (updater: (plates: EditorPlate[]) => EditorPlate[], kind?: 'structure' | 'transform' | 'inert') => void
  setActivePlateIndex: Dispatch<SetStateAction<number>>
  setSelectedKey: Dispatch<SetStateAction<string | null>>
  setPlateSettingsId: Dispatch<SetStateAction<number | null>>
  promptText: (options: TextPromptDialogOptions) => Promise<string | null>
}

/** Return the plate strip and settings actions for the mounted editor session. */
export function useEditorPlateManagement({
  stateRef,
  updatePlates,
  setActivePlateIndex,
  setSelectedKey,
  setPlateSettingsId,
  promptText
}: PlateManagementOptions) {
  const handleAddPlate = useCallback(() => {
    const newIndex = (stateRef.current?.plates.length ?? 0) + 1
    const plateId = mintPlateId()
    updatePlates((plates) => {
      const template = plates[plates.length - 1]
      const bed = template ? { ...template.bed } : { minX: -128, maxX: 128, minY: -128, maxY: 128, maxZ: null, excludeAreas: [] }
      // The bed follows the project printer; per-plate overrides do not spread to the next plate.
      return reindexPlates([
        ...plates,
        { index: plates.length + 1, plateId, sourcePlateIndex: null, name: null, ...INHERITED_PLATE_SETTINGS, bed, instances: [], primeTower: null }
      ])
    })
    setActivePlateIndex(newIndex)
    setSelectedKey(null)
  }, [setActivePlateIndex, setSelectedKey, stateRef, updatePlates])

  const handleRemovePlate = useCallback((index: number) => {
    // Capture the old count before the updater: a synchronous state mirror must not make the
    // focus calculation subtract the removed plate twice.
    const remaining = Math.max((stateRef.current?.plates.length ?? 1) - 1, 1)
    updatePlates((plates) => {
      if (plates.length <= 1) return plates
      return reindexPlates(plates.filter((plate) => plate.index !== index))
    })
    setSelectedKey(null)
    setActivePlateIndex((current) => {
      if (current > remaining) return Math.max(remaining, 1)
      if (current >= index) return Math.max(current - 1, 1)
      return current
    })
  }, [setActivePlateIndex, setSelectedKey, stateRef, updatePlates])

  const handleRenamePlate = useCallback(async (index: number) => {
    const plate = stateRef.current?.plates.find((entry) => entry.index === index)
    if (!plate) return
    const name = await promptText({
      title: `Rename plate ${index}`,
      label: 'Plate name',
      placeholder: defaultPlateName(index),
      initialValue: plateDisplayName(plate.name, index),
      confirmLabel: 'Rename'
    })
    if (name === null) return
    const nextName = resolvePlateRename(name, index)
    if (nextName === (plate.name?.trim() || null)) return
    // The plate strip reads this name from React state; no 3D rebuild is needed.
    updatePlates((plates) => plates.map((entry) => entry.index === index ? { ...entry, name: nextName } : entry), 'inert')
  }, [promptText, stateRef, updatePlates])

  /** Settings are history-worthy but leave scene geometry in place. */
  const handleApplyPlateSettings = useCallback((plateId: number, settings: PlateSettingsDraft) => {
    updatePlates(
      (plates) => plates.map((entry) => entry.plateId === plateId ? { ...entry, ...settings } : entry),
      'inert'
    )
    setPlateSettingsId(null)
  }, [setPlateSettingsId, updatePlates])

  /** Move a plate into a 0-based insertion gap without remapping plate-ID thumbnail caches. */
  const handleReorderPlate = useCallback((fromIndex: number, insertAt: number) => {
    const plates = stateRef.current?.plates ?? []
    const from = plates.findIndex((plate) => plate.index === fromIndex)
    if (from < 0) return
    const gap = Math.max(0, Math.min(plates.length, insertAt))
    const target = gap > from ? gap - 1 : gap
    if (target === from) return
    updatePlates((current) => movePlate(current, fromIndex, insertAt))
    setActivePlateIndex(target + 1)
  }, [setActivePlateIndex, stateRef, updatePlates])

  return {
    handleAddPlate,
    handleRemovePlate,
    handleRenamePlate,
    handleApplyPlateSettings,
    handleReorderPlate
  }
}
