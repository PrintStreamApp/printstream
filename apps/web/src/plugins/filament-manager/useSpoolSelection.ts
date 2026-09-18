/** Spool-facing adapter for the shared directory selection policy. */
import type { FilamentSpool } from '@printstream/shared'
import { useDirectorySelection, type DirectorySelection } from '../../hooks/useDirectorySelection'

export type SpoolSelection = Omit<DirectorySelection<FilamentSpool>, 'selectedItems'> & { selectedSpools: FilamentSpool[] }

export function useSpoolSelection(visibleSpools: FilamentSpool[]): SpoolSelection {
  const { selectedItems, ...selection } = useDirectorySelection(visibleSpools)
  return { ...selection, selectedSpools: selectedItems }
}
