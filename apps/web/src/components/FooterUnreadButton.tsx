/** Neutral footer action with an inline unread count, shared by version notes and announcements. */
import type { ReactNode } from 'react'
import { Button, Chip, Tooltip } from '@mui/joy'

/** Compact inline count stays beside the label instead of overlapping text or adjacent actions. */
export function FooterUnreadCount({ count }: { count: number }) {
  if (count <= 0) return null

  return (
    <Chip
      component="span"
      size="sm"
      variant="solid"
      color="primary"
      aria-hidden="true"
      sx={{ minWidth: 18, minHeight: 18, fontSize: 'xs', fontFamily: 'body', pointerEvents: 'none' }}
    >
      {count}
    </Chip>
  )
}

/** Hides zero counts; the accessible button label announces positive counts. */
export function FooterUnreadButton({ children, unreadCount, tooltip, ariaLabel, title, monospace = false, onClick }: {
  children: ReactNode
  unreadCount: number
  tooltip: string
  ariaLabel: string
  title?: string
  monospace?: boolean
  onClick: () => void
}) {
  const accessibleLabel = unreadCount > 0 ? `${ariaLabel}, ${unreadCount} unread` : ariaLabel

  return (
    <Tooltip title={tooltip} variant="soft">
      <Button
        size="sm"
        variant="plain"
        color="neutral"
        aria-label={accessibleLabel}
        title={title}
        onClick={onClick}
        endDecorator={<FooterUnreadCount count={unreadCount} />}
        sx={{ minHeight: 24, fontFamily: monospace ? 'code' : undefined, fontSize: 'xs' }}
      >
        {children}
      </Button>
    </Tooltip>
  )
}
