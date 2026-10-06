/**
 * Owns object-level selection actions used by the editor's keyboard and context menu.
 * The session still owns plate updates, history, live selection, and scene rebuilds; these
 * callbacks apply one user action to the whole current object selection. Move-to-plate and
 * printability changes use the same selection boundary as Delete and Paste.
 */
import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import { findFreePlatePosition, placeInstanceAt, type EditorInstance, type EditorPlate } from './lib/editorModel'
import type { PartRef, PartSelection } from './lib/selectionModel'

interface InstanceSelectionActionOptions {
  activePlateIndex: number
  activePlateRef: MutableRefObject<EditorPlate | null>
  selectionFor: (key: string) => string[]
  updatePlates: (update: (plates: EditorPlate[]) => EditorPlate[], kind?: 'structure' | 'visibility') => void
  selectExclusive: (key: string | null) => void
  setSelectedKey: Dispatch<SetStateAction<string | null>>
  setExtraSelectedKeys: Dispatch<SetStateAction<readonly string[]>>
  setPartSelection: Dispatch<SetStateAction<PartSelection | null>>
  setGizmoPart: Dispatch<SetStateAction<PartRef | null>>
  objectAnchorKeyRef: MutableRefObject<string | null>
}

/** Return delete, select-all, and paste actions for the mounted editor session. */
export function useEditorInstanceSelectionActions({
  activePlateIndex,
  activePlateRef,
  selectionFor,
  updatePlates,
  selectExclusive,
  setSelectedKey,
  setExtraSelectedKeys,
  setPartSelection,
  setGizmoPart,
  objectAnchorKeyRef
}: InstanceSelectionActionOptions) {
  const handleDelete = useCallback((key: string) => {
    // Deleting any member of a multi-selection deletes the whole selection.
    const keySet = new Set(selectionFor(key))
    updatePlates((plates) =>
      plates.map((plate) =>
        plate.index === activePlateIndex
          ? { ...plate, instances: plate.instances.filter((entry) => !keySet.has(entry.key)) }
          : plate
      )
    )
    setSelectedKey((current) => (current && keySet.has(current) ? null : current))
    setExtraSelectedKeys((current) => current.filter((entry) => !keySet.has(entry)))
  }, [activePlateIndex, updatePlates, selectionFor, setSelectedKey, setExtraSelectedKeys])

  /** Move the current selection to another plate, placing each object at a free spot. */
  const handleMoveToPlate = useCallback((key: string, targetIndex: number) => {
    const keySet = new Set(selectionFor(key))
    updatePlates((plates) => {
      const source = plates.find((plate) => plate.index === activePlateIndex)
      const target = plates.find((plate) => plate.index === targetIndex)
      const moving = source?.instances.filter((entry) => keySet.has(entry.key)) ?? []
      if (!target || moving.length === 0) return plates

      let nextTarget = target
      for (const instance of moving) {
        const spot = findFreePlatePosition(nextTarget)
        const moved: EditorInstance = { ...instance, position: instance.position.clone() }
        moved.position.x = spot.x
        moved.position.y = spot.y
        nextTarget = { ...nextTarget, instances: [...nextTarget.instances, moved] }
      }

      return plates.map((plate) => {
        if (plate.index === activePlateIndex) {
          return { ...plate, instances: plate.instances.filter((entry) => !keySet.has(entry.key)) }
        }
        if (plate.index === targetIndex) return nextTarget
        return plate
      })
    })
    setSelectedKey((current) => (current && keySet.has(current) ? null : current))
    setExtraSelectedKeys((current) => current.filter((entry) => !keySet.has(entry)))
  }, [activePlateIndex, selectionFor, setExtraSelectedKeys, setSelectedKey, updatePlates])

  /** Set, rather than toggle, Printable for the context menu's object selection. */
  const handleSetPrintableSelection = useCallback((keys: ReadonlyArray<string>, printable: boolean) => {
    const keySet = new Set(keys)
    updatePlates((plates) => plates.map((plate) => ({
      ...plate,
      instances: plate.instances.map((entry) =>
        keySet.has(entry.key) && entry.printable !== printable ? { ...entry, printable } : entry)
    })), 'visibility')
  }, [updatePlates])

  /** Toggle only the clicked instance, so linked copies can have different printability. */
  const handleTogglePrintable = useCallback((key: string) => {
    updatePlates((plates) => plates.map((plate) => ({
      ...plate,
      instances: plate.instances.map((entry) =>
        entry.key === key ? { ...entry, printable: !entry.printable } : entry)
    })), 'visibility')
  }, [updatePlates])

  /** Select every object on the active plate (Ctrl/Cmd+A): object mode, so part selection clears. */
  const handleSelectAllObjects = useCallback(() => {
    const keys = activePlateRef.current?.instances.map((instance) => instance.key) ?? []
    if (keys.length === 0) return
    setSelectedKey(keys[0]!)
    setExtraSelectedKeys(keys.slice(1))
    setPartSelection((current) => (current ? null : current))
    setGizmoPart((current) => (current ? null : current))
    objectAnchorKeyRef.current = keys[0]!
  }, [activePlateRef, setSelectedKey, setExtraSelectedKeys, setPartSelection, setGizmoPart, objectAnchorKeyRef])

  /** Paste cloned instances onto the active plate at free spots, selecting them, one undoable step. */
  const handlePasteInstances = useCallback((instances: EditorInstance[]) => {
    if (instances.length === 0) return
    let lastKey: string | null = null
    updatePlates((plates) =>
      plates.map((plate) => {
        if (plate.index !== activePlateIndex) return plate
        let next = plate
        for (const instance of instances) {
          const spot = findFreePlatePosition(next)
          placeInstanceAt(instance, spot.x, spot.y)
          lastKey = instance.key
          next = { ...next, instances: [...next.instances, instance] }
        }
        return next
      })
    )
    if (lastKey) selectExclusive(lastKey)
  }, [activePlateIndex, updatePlates, selectExclusive])

  return {
    handleDelete,
    handleMoveToPlate,
    handleSetPrintableSelection,
    handleTogglePrintable,
    handleSelectAllObjects,
    handlePasteInstances
  }
}
