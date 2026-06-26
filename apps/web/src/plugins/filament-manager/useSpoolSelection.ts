/**
 * Owns the Filament tab's multi-select concern, mirroring `useLibrarySelection`:
 * a selection-mode flag plus the set of selected spool ids. From the visible
 * (search/filter-narrowed) spools it derives the `selectedSpools` the bulk
 * actions operate on, and exposes the toggle / select-all helpers the list, grid,
 * and selection toolbar drive.
 *
 * Selection tracks what the user can actually see: ids that drop out of
 * `visibleSpools` (deleted, recycled, or filtered away) are pruned, and
 * select-all targets the visible set. Leaving selection mode clears the set.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { FilamentSpool } from '@printstream/shared'

export interface SpoolSelection {
  selectionMode: boolean
  setSelectionMode: (on: boolean) => void
  selectedIds: Set<string>
  selectedSpools: FilamentSpool[]
  toggle: (spool: FilamentSpool) => void
  setAllSelected: (selected: boolean) => void
}

export function useSpoolSelection(visibleSpools: FilamentSpool[]): SpoolSelection {
  const [selectionMode, setSelectionModeState] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())

  // Drop ids no longer visible (recycled, deleted, or filtered out), keeping the
  // same Set identity when nothing changed so this never loops.
  useEffect(() => {
    setSelectedIds((current) => {
      if (current.size === 0) return current
      const next = new Set<string>()
      for (const spool of visibleSpools) {
        if (current.has(spool.id)) next.add(spool.id)
      }
      return next.size === current.size ? current : next
    })
  }, [visibleSpools])

  const selectedSpools = useMemo(
    () => visibleSpools.filter((spool) => selectedIds.has(spool.id)),
    [visibleSpools, selectedIds]
  )

  const toggle = useCallback((spool: FilamentSpool) => {
    setSelectedIds((current) => {
      const next = new Set(current)
      if (next.has(spool.id)) next.delete(spool.id)
      else next.add(spool.id)
      return next
    })
  }, [])

  const setAllSelected = useCallback((selected: boolean) => {
    setSelectedIds(selected ? new Set(visibleSpools.map((spool) => spool.id)) : new Set())
  }, [visibleSpools])

  const setSelectionMode = useCallback((on: boolean) => {
    setSelectionModeState(on)
    if (!on) setSelectedIds(new Set())
  }, [])

  return { selectionMode, setSelectionMode, selectedIds, selectedSpools, toggle, setAllSelected }
}
