/**
 * Owns Split to objects and Split to parts for one editor session. Both prepare the same printable
 * shells, discard ambiguous helper volumes, and stage through the import store. A staged result
 * applies only while the source editor state is still current, so a late response cannot revive
 * a deleted or edited object.
 */
import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import type { StagedImport } from '@printstream/shared'
import * as THREE from 'three'
import { toast } from '../../lib/toast'
import { discardedHelperVolumeNotice } from './lib/editorGeometryActionMessages'
import type { SourceColorPaintCommit } from './lib/editorGeometryReplacement'
import type { EditorImportStore } from './lib/editorImportStore'
import { instanceFromStagedImport, type EditorInstance, type EditorPlate,
  type EditorState } from './lib/editorModel'
import { prepareEditorShellSplit, stageEditorObjectShells,
  stageEditorPartShells } from './lib/editorShellSplit'

interface ShellSplitOptions {
  activePlateIndex: number
  stateRef: MutableRefObject<EditorState | null>
  groupByKeyRef: MutableRefObject<Map<string, THREE.Group>>
  importStore: EditorImportStore
  countHelperVolumes: (instance: EditorInstance, group: THREE.Group) => number
  updatePlates: (updater: (plates: EditorPlate[]) => EditorPlate[]) => void
  setSelectedKey: Dispatch<SetStateAction<string | null>>
  setImporting: Dispatch<SetStateAction<boolean>>
  replaceWithStagedRef: MutableRefObject<(
    key: string,
    staged: StagedImport,
    sourceColorPaint?: SourceColorPaintCommit,
    options?: { recordHistory?: boolean }
  ) => boolean>
}

/** Return the two Split actions, bound to the current plate and live scene. */
export function useEditorShellSplit(options: ShellSplitOptions) {
  const {
    activePlateIndex, stateRef, groupByKeyRef, importStore, countHelperVolumes,
    updatePlates, setSelectedKey, setImporting, replaceWithStagedRef
  } = options

  /** Split each connected shell into its own import-backed object. */
  const handleSplitToObjects = useCallback(async (key: string) => {
    const sourceState = stateRef.current
    const plate = sourceState?.plates.find((entry) => entry.index === activePlateIndex)
    const instance = plate?.instances.find((entry) => entry.key === key)
    const group = groupByKeyRef.current.get(key)
    if (!plate || !instance || !group) return
    const discardedHelpers = countHelperVolumes(instance, group)
    const prepared = prepareEditorShellSplit(group, instance.name, 'objects')
    if (prepared.shells === null) {
      toast.error(prepared.error)
      return
    }

    setImporting(true)
    try {
      const staged = await stageEditorObjectShells(prepared.shells, instance.name, importStore)
      if (stateRef.current !== sourceState || groupByKeyRef.current.get(key) !== group) return
      const replacements = staged.map(({ import: stagedImport, offset }) => {
        const next = instanceFromStagedImport(stagedImport, importStore.meshUrl)
        next.position.set(offset.x, offset.y, 0)
        next.filamentId = instance.filamentId
        next.printable = instance.printable
        return next
      })
      updatePlates((plates) => plates.map((entry) =>
        entry.index === activePlateIndex
          ? { ...entry, instances: [...entry.instances.filter((item) => item.key !== key), ...replacements] }
          : entry
      ))
      setSelectedKey(replacements[0]!.key)
      toast.success(`Split ${instance.name} into ${replacements.length} objects.`
        + discardedHelperVolumeNotice(discardedHelpers))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Unable to split the model.')
    } finally {
      setImporting(false)
    }
  }, [activePlateIndex, countHelperVolumes, groupByKeyRef, importStore,
    setImporting, setSelectedKey, stateRef, updatePlates])

  /** Split the shells into separate parts of the same model identity. */
  const handleSplitToParts = useCallback(async (key: string) => {
    const sourceState = stateRef.current
    const plate = sourceState?.plates.find((entry) => entry.index === activePlateIndex)
    const instance = plate?.instances.find((entry) => entry.key === key)
    const group = groupByKeyRef.current.get(key)
    if (!plate || !instance || !group) return
    const discardedHelpers = countHelperVolumes(instance, group)
    const prepared = prepareEditorShellSplit(group, instance.name, 'parts')
    if (prepared.shells === null) {
      toast.error(prepared.error)
      return
    }

    setImporting(true)
    try {
      const staged = await stageEditorPartShells(prepared.shells, instance.name, importStore)
      if (stateRef.current !== sourceState || groupByKeyRef.current.get(key) !== group) return
      if (!replaceWithStagedRef.current(key, staged)) return
      toast.success(`Split ${instance.name} into ${prepared.shells.length} parts.`
        + discardedHelperVolumeNotice(discardedHelpers))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Unable to split the model into parts.')
    } finally {
      setImporting(false)
    }
  }, [activePlateIndex, countHelperVolumes, groupByKeyRef, importStore,
    replaceWithStagedRef, setImporting, stateRef])

  return { handleSplitToObjects, handleSplitToParts }
}
