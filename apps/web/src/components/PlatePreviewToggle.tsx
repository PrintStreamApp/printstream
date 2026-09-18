/**
 * Shared thumbnail visibility toggle for library plate pickers and Model Studio.
 * Keeps the control centered across the strip and trailing along its scrolling axis.
 */
import { IconButton, Tooltip } from '@mui/joy'
import UnfoldLessRoundedIcon from '@mui/icons-material/UnfoldLessRounded'
import UnfoldMoreRoundedIcon from '@mui/icons-material/UnfoldMoreRounded'

/** Callers own visibility state and pass the orientation of the containing flex strip. */
export function PlatePreviewToggle({
  collapsed,
  orientation,
  onToggle
}: {
  collapsed: boolean
  orientation: 'horizontal' | 'vertical'
  onToggle: () => void
}) {
  const label = collapsed ? 'Show plate previews' : 'Hide plate previews'

  return (
    <Tooltip title={label}>
      <IconButton
        size="sm"
        variant="plain"
        color="neutral"
        onClick={onToggle}
        aria-label={label}
        sx={{
          flex: '0 0 auto',
          alignSelf: 'center',
          // Auto margins must follow the strip axis; a left auto margin defeats centering
          // in a vertical rail. Important overrides Joy Stack's sibling spacing rule.
          ...(orientation === 'vertical'
            ? { mt: 'auto !important' }
            : { ml: 'auto !important' })
        }}
      >
        {collapsed ? <UnfoldMoreRoundedIcon fontSize="small" /> : <UnfoldLessRoundedIcon fontSize="small" />}
      </IconButton>
    </Tooltip>
  )
}
