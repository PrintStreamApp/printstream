/**
 * Empty-state placeholder for the library file pickers (print-from-library, library
 * file picker, orders), mirroring the library view's placeholders. Favorites-aware:
 * shows a "no favorites" message when the favorites filter is on, a "no matches" message
 * while searching, and a generic "no files" message otherwise.
 */
import InventoryRoundedIcon from '@mui/icons-material/Inventory2Rounded'
import SearchRoundedIcon from '@mui/icons-material/SearchRounded'
import StarBorderRoundedIcon from '@mui/icons-material/StarBorderRounded'
import { EmptyState } from './EmptyState'

export function LibraryPickerEmptyState({
  favoritesOnly = false,
  searching = false
}: {
  favoritesOnly?: boolean
  searching?: boolean
}) {
  if (favoritesOnly) {
    return (
      <EmptyState
        icon={<StarBorderRoundedIcon />}
        title="No favorite files yet"
        description="Open a file's ⋮ menu and choose Favorite to keep it here for quick access."
      />
    )
  }
  if (searching) {
    return (
      <EmptyState
        icon={<SearchRoundedIcon />}
        title="No matching files"
        description="Try a different search, or use the breadcrumb to look in another folder."
      />
    )
  }
  return (
    <EmptyState
      icon={<InventoryRoundedIcon />}
      title="No files here"
      description="Open a subfolder or use the breadcrumb to find a file to pick."
    />
  )
}
