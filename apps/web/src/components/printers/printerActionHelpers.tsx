/**
 * Shared printer-action UI helpers extracted from `pages/PrintersView.tsx`:
 * `withDisabledActionReason` wraps a control with a reason tooltip when it is
 * disabled, and `usePendingFilamentActionLabel` tracks an in-flight
 * load/unload label until live filament-change progress or a fresh idle
 * observation supersedes it.
 */
import { useCallback, useEffect, useState } from 'react'
import { Box, Tooltip } from '@mui/joy'
import { isPrinterIdleCompatibleStage, type PrinterStatus } from '@printstream/shared'

export function usePendingFilamentActionLabel(status: PrinterStatus | undefined) {
  const [pendingActionLabel, setPendingActionLabelState] = useState<string | null>(null)
  const [requestedAtObservation, setRequestedAtObservation] = useState<string | null>(null)
  const [sawLiveProgress, setSawLiveProgress] = useState(false)

  const setPendingActionLabel = useCallback((label: string | null) => {
    setPendingActionLabelState(label)
    setRequestedAtObservation(label ? status?.observedAt ?? null : null)
    setSawLiveProgress(false)
  }, [status?.observedAt])

  useEffect(() => {
    if (!pendingActionLabel) return

    const hasLiveProgress = Boolean(status?.filamentChange.currentStepLabel)
      || (status?.filamentChange.steps.length ?? 0) > 0

    if (hasLiveProgress) {
      if (!sawLiveProgress) setSawLiveProgress(true)
      return
    }

    const hasFreshObservation = Boolean(
      requestedAtObservation
      && status?.observedAt
      && status.observedAt !== requestedAtObservation
    )

    if (sawLiveProgress || (hasFreshObservation && isPrinterIdleCompatibleStage(status?.stage))) {
      setPendingActionLabelState(null)
      setRequestedAtObservation(null)
      setSawLiveProgress(false)
    }
  }, [pendingActionLabel, requestedAtObservation, sawLiveProgress, status])

  return [pendingActionLabel, setPendingActionLabel] as const
}

export function withDisabledActionReason(content: JSX.Element, reason: string | null, options?: { fill?: boolean }): JSX.Element {
  if (!reason) return content

  const fill = options?.fill ?? false

  return (
    <Tooltip title={reason} variant="soft" size="sm">
      <Box
        sx={{
          display: fill ? 'flex' : 'inline-flex',
          width: fill ? '100%' : 'fit-content',
          maxWidth: '100%',
          minWidth: 0,
          '& > *': {
            flex: fill ? 1 : '0 1 auto',
            minWidth: 0
          }
        }}
      >
        {content}
      </Box>
    </Tooltip>
  )
}
