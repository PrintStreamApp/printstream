/** Shared directory selection: select-all follows filtered items; disappearing items are pruned. */
import { useCallback, useEffect, useMemo, useState } from 'react'

export interface DirectorySelection<T extends { id: string }> {
  selectionMode: boolean
  setSelectionMode: (on: boolean) => void
  selectedIds: Set<string>
  selectedItems: T[]
  toggle: (item: T) => void
  setAllSelected: (selected: boolean) => void
}

export function useDirectorySelection<T extends { id: string }>(visibleItems: T[]): DirectorySelection<T> {
  const [selectionMode, setSelectionModeState] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())

  // Drop ids no longer visible (recycled, deleted, or filtered out), keeping the
  // same Set identity when nothing changed so this never loops.
  useEffect(() => {
    setSelectedIds((current) => {
      if (current.size === 0) return current
      const next = new Set<string>()
      for (const item of visibleItems) {
        if (current.has(item.id)) next.add(item.id)
      }
      return next.size === current.size ? current : next
    })
  }, [visibleItems])

  const selectedItems = useMemo(
    () => visibleItems.filter((item) => selectedIds.has(item.id)),
    [visibleItems, selectedIds]
  )

  const toggle = useCallback((item: T) => {
    setSelectedIds((current) => {
      const next = new Set(current)
      if (next.has(item.id)) next.delete(item.id)
      else next.add(item.id)
      return next
    })
  }, [])

  const setAllSelected = useCallback((selected: boolean) => {
    setSelectedIds(selected ? new Set(visibleItems.map((item) => item.id)) : new Set())
  }, [visibleItems])

  const setSelectionMode = useCallback((on: boolean) => {
    setSelectionModeState(on)
    if (!on) setSelectedIds(new Set())
  }, [])

  return { selectionMode, setSelectionMode, selectedIds, selectedItems, toggle, setAllSelected }
}
