/**
 * Two-option segmented toggle for the library/print-picker search scope: "This folder" vs
 * "All folders", with the active option lit (solid). Both options are always shown so the control
 * reads as a switch, not a single state label.
 */
import { Chip, Stack } from '@mui/joy'

export interface SearchScopeToggleProps {
  allFolders: boolean
  onChange: (allFolders: boolean) => void
}

export function SearchScopeToggle({ allFolders, onChange }: SearchScopeToggleProps) {
  return (
    <Stack direction="row" spacing={0.5} sx={{ flexShrink: 0 }} role="group" aria-label="Search scope">
      <Chip
        size="sm"
        variant={allFolders ? 'solid' : 'soft'}
        color="neutral"
        onClick={() => onChange(true)}
      >
        All folders
      </Chip>
      <Chip
        size="sm"
        variant={allFolders ? 'soft' : 'solid'}
        color="neutral"
        onClick={() => onChange(false)}
      >
        This folder
      </Chip>
    </Stack>
  )
}
