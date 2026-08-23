/**
 * The buttons that switch a dialog between its size modes (`lib/dialogPresentation.ts`).
 *
 * Shared so the icons keep ONE meaning across dialogs. They did not: the editor used the
 * open-in-full pair for its full-screen toggle while the 3D preview used that same pair for
 * "maximize" and the fullscreen pair for full screen, so the same glyph did two different things in
 * two dialogs a click apart.
 *
 * Placement is the caller's, not this module's, but it follows one rule: **a toggle goes on the thing
 * it resizes.** Maximize resizes the whole dialog, so it belongs in the dialog's header; full screen
 * usually enlarges one content area (the 3D viewport) rather than revealing more dialog, so its
 * toggle belongs ON that area: the editor's viewport toolbar and the preview's viewport corner both
 * carry it there. Each button owns its tooltip, `aria-label` and pressed state so a caller cannot get
 * those subtly different.
 */
import { IconButton, Tooltip, type IconButtonProps } from '@mui/joy'
import CloseFullscreenRoundedIcon from '@mui/icons-material/CloseFullscreenRounded'
import FullscreenExitRoundedIcon from '@mui/icons-material/FullscreenExitRounded'
import FullscreenRoundedIcon from '@mui/icons-material/FullscreenRounded'
import OpenInFullRoundedIcon from '@mui/icons-material/OpenInFullRounded'

type ToggleButtonProps = Pick<IconButtonProps, 'variant' | 'color' | 'size' | 'sx'> & {
  active: boolean
  onToggle: (next: boolean) => void
}

/** Grow the dialog to the screen bar a gutter, and back to its normal footprint. */
export function MaximizeDialogButton({ active, onToggle, size = 'sm', variant = 'plain', color = 'neutral', sx }: ToggleButtonProps) {
  const label = active ? 'Shrink dialog' : 'Maximize dialog'
  return (
    <Tooltip title={label}>
      <IconButton
        aria-label={label}
        aria-pressed={active}
        variant={variant}
        color={color}
        size={size}
        onClick={() => onToggle(!active)}
        sx={sx}
      >
        {active ? <CloseFullscreenRoundedIcon fontSize="small" /> : <OpenInFullRoundedIcon fontSize="small" />}
      </IconButton>
    </Tooltip>
  )
}

/**
 * Drop every piece of chrome and take the whole screen. `contentLabel` names what is left ("3D
 * only"), since that is what the user is choosing between, not the dialog's dimensions.
 */
export function FullScreenDialogButton({
  active,
  onToggle,
  contentLabel,
  size = 'sm',
  variant = 'plain',
  color = 'neutral',
  sx
}: ToggleButtonProps & { contentLabel?: string }) {
  const label = active
    ? 'Exit full screen'
    : contentLabel ? `Full screen (${contentLabel})` : 'Full screen'
  return (
    <Tooltip title={label}>
      <IconButton
        aria-label={label}
        aria-pressed={active}
        variant={variant}
        color={color}
        size={size}
        onClick={() => onToggle(!active)}
        sx={sx}
      >
        {active ? <FullscreenExitRoundedIcon fontSize="small" /> : <FullscreenRoundedIcon fontSize="small" />}
      </IconButton>
    </Tooltip>
  )
}
