/**
 * Owns the Library view's multi-select concern, extracted verbatim from
 * `pages/LibraryView.tsx`: the selection mode flag, the set of selected file
 * ids, and the pending "move selection" target. From those it derives the
 * `selectedVisibleFiles` (the currently-selected files that are still visible
 * under the active filter) and exposes the toggle / select-all handlers the
 * browser and selection toolbar drive.
 *
 * Inputs are the already-filtered `filteredFiles` (so select-all and the derived
 * selection track what the user can actually see) plus the raw `visibleFiles`
 * for the current folder, the `currentFolderId` that resets selection on
 * navigation, and `canManageLibrary` which clears selection when the permission
 * is lost.
 *
 * Invariant: behavior-preserving — the bodies below are moved unchanged from
 * LibraryView. Bulk-action handlers (recycle, move) stay in the view and read
 * this hook's return; the context-menu reset effect also stays in the view and
 * reads `selectionMode` from here.
 */
import { useEffect, useMemo, useState } from 'react'
import type { LibraryFile } from '@printstream/shared'

export interface LibrarySelectionParams {
  filteredFiles: LibraryFile[]
  visibleFiles: LibraryFile[]
  currentFolderId: string | null
  canManageLibrary: boolean
}

export interface LibrarySelection {
  selectionMode: boolean
  setSelectionMode: React.Dispatch<React.SetStateAction<boolean>>
  selectedFileIds: string[]
  setSelectedFileIds: React.Dispatch<React.SetStateAction<string[]>>
  moveSelectionTarget: LibraryFile[] | null
  setMoveSelectionTarget: React.Dispatch<React.SetStateAction<LibraryFile[] | null>>
  selectedVisibleFiles: LibraryFile[]
  toggleSelectedFile: (file: LibraryFile) => void
  setAllVisibleFilesSelected: (selected: boolean) => void
}

export function useLibrarySelection(params: LibrarySelectionParams): LibrarySelection {
  const { filteredFiles, visibleFiles, currentFolderId, canManageLibrary } = params

  const [moveSelectionTarget, setMoveSelectionTarget] = useState<LibraryFile[] | null>(null)
  const [selectionMode, setSelectionMode] = useState(false)
  const [selectedFileIds, setSelectedFileIds] = useState<string[]>([])

  const selectedVisibleFiles = useMemo(
    () => filteredFiles.filter((file) => selectedFileIds.includes(file.id)),
    [filteredFiles, selectedFileIds]
  )

  useEffect(() => {
    setSelectedFileIds((current) => {
      const next = current.filter((id) => visibleFiles.some((file) => file.id === id))
      return next.length === current.length ? current : next
    })
  }, [visibleFiles])

  useEffect(() => {
    setSelectionMode(false)
    setSelectedFileIds([])
  }, [currentFolderId])

  useEffect(() => {
    if (canManageLibrary) return
    setSelectionMode(false)
    setSelectedFileIds([])
  }, [canManageLibrary])

  const toggleSelectedFile = (file: LibraryFile) => {
    setSelectedFileIds((current) => current.includes(file.id)
      ? current.filter((id) => id !== file.id)
      : [...current, file.id])
  }

  const setAllVisibleFilesSelected = (selected: boolean) => {
    setSelectedFileIds(selected ? filteredFiles.map((file) => file.id) : [])
  }

  return {
    selectionMode,
    setSelectionMode,
    selectedFileIds,
    setSelectedFileIds,
    moveSelectionTarget,
    setMoveSelectionTarget,
    selectedVisibleFiles,
    toggleSelectedFile,
    setAllVisibleFilesSelected
  }
}
