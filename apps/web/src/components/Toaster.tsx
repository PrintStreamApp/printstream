/**
 * Global toast renderer. Subscribes to the {@link toast} bus and shows
 * a stack of Joy `Alert`s near the bottom-right corner (or full-width
 * along the bottom edge on phones). Auto-dismisses
 * each entry after its `durationMs` and exposes a manual dismiss button.
 *
 * Visual style matches the `DispatchToasts` component (and the
 * game-is-up reference) so the two stacks look like one system.
 */
import { useEffect, useRef, useState } from 'react'
import { Button, CircularProgress, LinearProgress, Stack, Typography } from '@mui/joy'
import { toast, type ToastEntry } from '../lib/toast'
import { StatusToast } from './StatusToast'

const MAX_VISIBLE = 5

export function Toaster() {
  const [entries, setEntries] = useState<ToastEntry[]>([])
  const timeoutIdsRef = useRef(new Map<number, number>())

  useEffect(() => {
    return toast.subscribe((nextEntries) => {
      setEntries(nextEntries)
    })
  }, [])

  useEffect(() => {
    for (const [id, timeoutId] of timeoutIdsRef.current.entries()) {
      if (entries.some((entry) => entry.id === id && entry.durationMs > 0)) continue
      window.clearTimeout(timeoutId)
      timeoutIdsRef.current.delete(id)
    }

    for (const entry of entries) {
      if (entry.durationMs <= 0 || timeoutIdsRef.current.has(entry.id)) continue
      const timeoutId = window.setTimeout(() => {
        timeoutIdsRef.current.delete(entry.id)
        toast.dismiss(entry.id, 'timeout')
      }, entry.durationMs)
      timeoutIdsRef.current.set(entry.id, timeoutId)
    }
  }, [entries])

  useEffect(() => () => {
    for (const timeoutId of timeoutIdsRef.current.values()) window.clearTimeout(timeoutId)
    timeoutIdsRef.current.clear()
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
            <Typography level="body-sm" sx={{ minWidth: 0, lineHeight: 1.5 }}>
              {entry.message}
            </Typography>
            {entry.progress != null && (
              <LinearProgress
                determinate
                color={entry.tone}
                value={Math.max(0, Math.min(100, entry.progress))}
                sx={{ '--LinearProgress-thickness': '4px' }}
              />
            )}
          </Stack>
        </StatusToast>
      ))}
    </>
  )
}
