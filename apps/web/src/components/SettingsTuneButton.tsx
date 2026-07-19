/**
 * Tune (settings-editor) icon button with a corner Badge showing how many values differ from the
 * preset — the single "open settings, N changed" control shared by every slice surface: materials,
 * per-object, and per-part.
 *
 * One component so all of them indicate changes the SAME way — a count in a corner badge — rather
 * than the older `variant`/`color` flip, which was invisible on a lone row with no unchanged
 * sibling to compare against. A corner Badge (not an inline chip) keeps the button width — and
 * each row's column alignment — constant whether or not there are changes. Joy hides the badge at
 * a zero count (no `showZero`), so an unchanged row shows a plain icon.
 */
import { Badge, IconButton, Tooltip } from '@mui/joy'
import TuneRoundedIcon from '@mui/icons-material/TuneRounded'

export function SettingsTuneButton({ changedCount, title, ariaLabel, disabled, onClick }: {
  /** Number of values overridden vs the preset; the badge is hidden when 0. */
  changedCount: number
  title: string
  ariaLabel: string
  disabled?: boolean
  onClick: () => void
}): JSX.Element {
  return (
    <Tooltip title={title}>
      {/* span wrapper so the tooltip still shows when the button is disabled. */}
      <span>
        <Badge badgeContent={changedCount} size="sm" color="primary" badgeInset="15%">
          <IconButton
            size="sm"
            variant="plain"
            color="neutral"
            disabled={disabled}
            onClick={onClick}
            aria-label={ariaLabel}
          >
            <TuneRoundedIcon fontSize="small" />
          </IconButton>
        </Badge>
      </span>
    </Tooltip>
  )
}
