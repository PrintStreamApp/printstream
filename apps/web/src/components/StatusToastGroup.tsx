/**
 * One toast for a batch of like jobs — the answer to "send four prints, get four
 * screen-filling toasts".
 *
 * Owns the collapsed/expanded presentation so every job surface (dispatch,
 * slicing, deletes) reads as one system: a batch collapses to a headline plus a
 * single line per item, with per-item cancel/retry as icons on the row and the
 * fuller detail one chevron away. A group holding a single item skips the
 * headline entirely and renders that item expanded, so the everyday one-job case
 * is not made taller by chrome describing a batch of one.
 *
 * Callers supply presentation, not behaviour: each item carries its own labels,
 * actions and dismiss. Aggregate tone/headline come from `lib/statusToastGroup`.
 */
import { useState } from 'react'
import ExpandLessRoundedIcon from '@mui/icons-material/ExpandLessRounded'
import ExpandMoreRoundedIcon from '@mui/icons-material/ExpandMoreRounded'
import { Stack, Typography } from '@mui/joy'
import type { ReactNode } from 'react'
import {
  formatStatusToastGroupHeadline,
  summarizeStatusToastGroup,
  type StatusToastGroupWording
} from '../lib/statusToastGroup'
import { ProgressBar } from './ProgressBar'
import { ProgressSpinner } from './ProgressSpinner'
import { StatusToast, StatusToastDismissButton, StatusToastIconAction, StatusToastStatusDot } from './StatusToast'
import { StatusToastGroupRow, type StatusToastGroupItem } from './StatusToastGroupRow'

/** How tall the row list may grow before it scrolls inside the toast. */
const ROWS_MAX_HEIGHT = 260

export type { StatusToastGroupItem } from './StatusToastGroupRow'

export function StatusToastGroup({
  items,
  wording,
  headerActions,
  onDismissAll,
  dismissAllLabel
}: {
  items: readonly StatusToastGroupItem[]
  wording: StatusToastGroupWording
  /** Actions that apply to the whole batch (e.g. "open Jobs"), as icons. */
  headerActions?: ReactNode
  onDismissAll: () => void
  dismissAllLabel: string
}) {
  const [expanded, setExpanded] = useState(false)

  if (items.length === 0) return null

  const summary = summarizeStatusToastGroup(items)
  const role = summary.color === 'danger' ? 'alert' : 'status'
  const decorator = summary.busy
    ? <ProgressSpinner size="sm" value={summary.progress} />
    : <StatusToastStatusDot color={summary.color} />

  // A batch of one is just that job: no headline, no toggle, detail already open.
  const soleItem = items.length === 1 ? items[0] : undefined
  if (soleItem) {
    return (
      <StatusToast color={summary.color} role={role} startDecorator={decorator}>
        <StatusToastGroupRow item={soleItem} expanded trailing={headerActions} />
      </StatusToast>
    )
  }

  return (
    <StatusToast color={summary.color} role={role} startDecorator={decorator}>
      <Stack spacing={0.75} sx={{ minWidth: 0 }}>
        <Stack direction="row" spacing={0.5} alignItems="center" sx={{ minWidth: 0 }}>
          <Typography level="title-sm" noWrap sx={{ minWidth: 0, flex: 1 }}>
            {formatStatusToastGroupHeadline(summary, wording)}
          </Typography>
          {headerActions}
          <StatusToastIconToggle expanded={expanded} onToggle={() => setExpanded((current) => !current)} />
          <StatusToastDismissButton ariaLabel={dismissAllLabel} onClick={onDismissAll} />
        </Stack>

        {/* Always the working colour: this bar reports how far the batch has
            got, and painting it danger because one item failed reads as though
            the progress itself is the failure. Tone lives on the toast. */}
        {summary.busy && (
          <ProgressBar
            color="primary"
            value={summary.progress}
            sx={{ '--LinearProgress-thickness': '4px' }}
          />
        )}

        <Stack
          // Scrolls rather than growing: a ten-item batch must not refill the
          // screen the grouping exists to clear.
          sx={{
            minWidth: 0,
            maxHeight: ROWS_MAX_HEIGHT,
            overflowY: 'auto',
            overscrollBehavior: 'contain',
            scrollbarGutter: 'stable',
            '& > :not(:first-of-type)': { borderTop: '1px solid', borderColor: 'neutral.700' }
          }}
        >
          {items.map((item) => (
            <StatusToastGroupRow key={item.id} item={item} expanded={expanded} />
          ))}
        </Stack>
      </Stack>
    </StatusToast>
  )
}

function StatusToastIconToggle({ expanded, onToggle }: { expanded: boolean; onToggle: () => void }) {
  return (
    <StatusToastIconAction
      label={expanded ? 'Hide details' : 'Show details'}
      ariaExpanded={expanded}
      onClick={onToggle}
    >
      {expanded ? <ExpandLessRoundedIcon /> : <ExpandMoreRoundedIcon />}
    </StatusToastIconAction>
  )
}
