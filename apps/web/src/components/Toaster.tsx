/**
 * Global toast renderer. Subscribes to the {@link toast} bus and shows
 * a stack of Joy `Alert`s near the bottom-right corner (or full-width
 * along the bottom edge on phones). Auto-dismisses
 * each entry after its `durationMs` and exposes a manual dismiss button.
 *
 * Visual style matches the grouped job toasts (`StatusToastGroup`) so the
 * stacks look like one system. Repeated identical toasts arrive here already
 * folded into one entry by the bus; this renders the repeat count beside the
 * message and restarts that entry's dwell time on each new occurrence.
 */
import { useEffect, useRef, useState } from 'react'
import { Button, Chip, CircularProgress, Stack, Typography } from '@mui/joy'
import { toast, type ToastEntry } from '../lib/toast'
import { StatusToast } from './StatusToast'
import { ProgressBar } from './ProgressBar'

const MAX_VISIBLE = 5

/** A scheduled auto-dismiss, tagged with the repeat count it was scheduled for. */
interface ToastTimeout {
  timeoutId: number
  count: number
}

export function Toaster() {
  const [entries, setEntries] = useState<ToastEntry[]>([])
  const timeoutsRef = useRef(new Map<number, ToastTimeout>())

  useEffect(() => {
    return toast.subscribe((nextEntries) => {
      setEntries(nextEntries)
    })
  }, [])

  useEffect(() => {
    const timeouts = timeoutsRef.current
    for (const [id, timeout] of timeouts.entries()) {
      // A repeat folded into this entry (count bumped) restarts the clock, so the
      // dwell time is measured from the LAST occurrence rather than the first.
      const entry = entries.find((candidate) => candidate.id === id)
      if (entry && entry.durationMs > 0 && entry.count === timeout.count) continue
      window.clearTimeout(timeout.timeoutId)
      timeouts.delete(id)
    }

    for (const entry of entries) {
      if (entry.durationMs <= 0 || timeouts.has(entry.id)) continue
      const timeoutId = window.setTimeout(() => {
        timeouts.delete(entry.id)
        toast.dismiss(entry.id, 'timeout')
      }, entry.durationMs)
      timeouts.set(entry.id, { timeoutId, count: entry.count })
    }
  }, [entries])

  useEffect(() => () => {
    for (const timeout of timeoutsRef.current.values()) window.clearTimeout(timeout.timeoutId)
    timeoutsRef.current.clear()
  }, [])

  if (entries.length === 0) return null

  const visibleEntries = entries.slice(-MAX_VISIBLE)

  return (
    <>
      {visibleEntries.map((entry) => (
        <StatusToast
          key={entry.id}
          color={entry.tone}
          role={entry.tone === 'danger' || entry.tone === 'warning' ? 'alert' : 'status'}
          startDecorator={entry.loading ? <CircularProgress size="sm" variant="soft" /> : undefined}
          endDecorator={
            <Stack direction="row" spacing={0.5} alignItems="center">
              {entry.action ? (
                <Button
                  size="sm"
                  variant="soft"
                  color="primary"
                  onClick={() => {
                    void entry.action?.onClick()
                    toast.dismiss(entry.id, 'action')
                  }}
                  sx={{ minWidth: 'auto', flexShrink: 0 }}
                >
                  {entry.action.label}
                </Button>
              ) : null}
              <Button
                size="sm"
                variant="plain"
                color={entry.tone}
                onClick={() => toast.dismiss(entry.id, 'dismiss')}
                sx={{ minWidth: 'auto', px: 0.5, flexShrink: 0 }}
              >
                Dismiss
              </Button>
            </Stack>
          }
          sx={{ p: 1.5, alignItems: 'center' }}
        >
          <Stack spacing={0.75} sx={{ minWidth: 0, flex: 1 }}>
            <Typography
              level="body-sm"
              sx={{ minWidth: 0, lineHeight: 1.5 }}
              // `component="span"`: the count sits inside the message paragraph,
              // and Chip's default <div> root is invalid inside a <p>.
              endDecorator={entry.count > 1 ? (
                <Chip component="span" size="sm" variant="soft" color={entry.tone}>{`x${entry.count}`}</Chip>
              ) : undefined}
            >
              {entry.message}
            </Typography>
            {entry.progress != null && (
              <ProgressBar
                color={entry.tone}
                value={entry.progress}
                sx={{ '--LinearProgress-thickness': '4px' }}
              />
            )}
          </Stack>
        </StatusToast>
      ))}
    </>
  )
}
