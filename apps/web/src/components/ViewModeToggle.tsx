/**
 * Connected list/icon view-mode buttonset.
 *
 * A single Joy `ToggleButtonGroup` (segmented control) replacing the two separate
 * `IconButton`s the directory toolbars used to render side by side. Joy owns the
 * selected state, `aria-pressed`, and the connected corner radii, so callers only
 * pass the current mode + a change handler.
 */
import { Box, IconButton, ToggleButtonGroup } from '@mui/joy'
import type { DirectoryViewMode } from './DirectoryControls'

export function ViewModeToggle({
  viewMode,
  onViewModeChange
}: {
  viewMode: DirectoryViewMode
  onViewModeChange: (mode: DirectoryViewMode) => void
}) {
  return (
    <ToggleButtonGroup
      size="sm"
      variant="soft"
      color="neutral"
      value={viewMode}
      onChange={(_event, value) => {
        // Joy returns null when the active segment is re-clicked; keep the current
        // mode in that case (a view mode is always selected).
        if (value) onViewModeChange(value as DirectoryViewMode)
      }}
      aria-label="View mode"
      sx={{ flexShrink: 0 }}
    >
      <IconButton value="list" aria-label="List view" title="List view"><ListViewIcon /></IconButton>
      <IconButton value="icon" aria-label="Icon view" title="Icon view"><IconViewIcon /></IconButton>
    </ToggleButtonGroup>
  )
}

function ListViewIcon() {
  return (
    <Box component="svg" viewBox="0 0 24 24" aria-hidden sx={{ width: '1.1em', height: '1.1em', fill: 'currentColor' }}>
      <path d="M3 5h18v2H3V5zm0 6h18v2H3v-2zm0 6h18v2H3v-2z" />
    </Box>
  )
}

function IconViewIcon() {
  return (
    <Box component="svg" viewBox="0 0 24 24" aria-hidden sx={{ width: '1.1em', height: '1.1em', fill: 'currentColor' }}>
      <path d="M4 4h7v7H4V4zm9 0h7v7h-7V4zM4 13h7v7H4v-7zm9 0h7v7h-7v-7z" />
    </Box>
  )
}
