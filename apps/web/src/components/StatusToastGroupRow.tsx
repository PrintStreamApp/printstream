/**
 * One item inside a `StatusToastGroup`: collapsed it is a single line: name,
 * status word, its own actions, and a hairline progress bar while it runs;
 * expanded it adds the secondary line, the error, and whatever detail node the
 * surface passed.
 *
 * The dismiss control is always the row's own, never a cancel in disguise:
 * losing a stuck toast must not mean cancelling the work behind it, so cancel
 * (where a surface offers it) is a separate icon in `item.actions`.
 *
 * Owns the item shape too, so the group can depend on the row and not the other
 * way round; `StatusToastGroup` re-exports it for callers.
 */
import CloseRoundedIcon from '@mui/icons-material/CloseRounded'
import { Chip, Stack, Typography } from '@mui/joy'
import type { ReactNode } from 'react'
import type { StatusToastColor } from '../lib/statusToastGroup'
import { ProgressBar } from './ProgressBar'
import { StatusToastIconAction } from './StatusToast'

export interface StatusToastGroupItem {
  id: string
  /** Primary one-line label: usually the file name. */
  title: string
  /** Short status word rendered beside the title (`Sending`, `Failed`). */
  statusLabel: string
  color: StatusToastColor
  /** Still running; drives the row's progress bar and the group's spinner. */
  active: boolean
  /** Percent 0-100, or `null` while running with no reported extent. */
  progress: number | null
  /** Secondary line (printer, bytes, phase): shown when the item is expanded. */
  summary?: string
  error?: string | null
  /** Compact icon actions for the row (cancel, retry); always visible. */
  actions?: ReactNode
  /** Extra content revealed when the item is expanded. */
  detail?: ReactNode
  onDismiss: () => void
  /** Accessible name for this item's dismiss control. */
  dismissLabel: string
}

export function StatusToastGroupRow({
  item,
  expanded,
  trailing
}: {
  item: StatusToastGroupItem
  expanded: boolean
  /** Group-level controls folded into the row when the group holds one item. */
  trailing?: ReactNode
}) {
  const hasDetail = expanded && (item.summary || item.error || item.detail)

  return (
    <Stack spacing={0.25} sx={{ minWidth: 0, py: 0.25 }}>
      <Stack direction="row" spacing={0.5} alignItems="center" sx={{ minWidth: 0 }}>
        {/* Collapsed, a row is one line and the name is clipped to keep it that
            way; expanded is where the full name has to be readable, since there
            is nowhere else in the toast to see it. */}
        <Typography level={expanded ? 'title-sm' : 'body-sm'} noWrap={!expanded} sx={{ minWidth: 0, flex: 1 }}>
          {item.title}
        </Typography>
        <Chip size="sm" variant="soft" color={item.color} sx={{ flexShrink: 0 }}>
          {item.statusLabel}
        </Chip>
        {item.actions}
        {trailing}
        <StatusToastIconAction label={item.dismissLabel} onClick={item.onDismiss}>
          <CloseRoundedIcon />
        </StatusToastIconAction>
      </Stack>

      {item.active && (
        <ProgressBar
          color={item.color}
          value={item.progress}
          sx={{ '--LinearProgress-thickness': expanded ? '6px' : '3px' }}
        />
      )}

      {hasDetail && (
        <Stack spacing={0.25} sx={{ minWidth: 0 }}>
          {item.summary && (
            <Typography level="body-xs" textColor="text.tertiary" noWrap>{item.summary}</Typography>
          )}
          {item.error && <Typography level="body-xs" color="danger">{item.error}</Typography>}
          {item.detail}
        </Stack>
      )}
    </Stack>
  )
}
