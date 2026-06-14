import type { PrintDispatchStatus, PrinterStatus } from '@printstream/shared'

type StatusTone = Pick<PrinterStatus, 'stage'>
type StatusToneWithOnline = Pick<PrinterStatus, 'online' | 'stage'>

export function stageLabelColor(
  status: StatusToneWithOnline | null | undefined
): 'neutral' | 'primary' | 'success' | 'warning' | 'danger' {
  if (!status || !status.online) return 'neutral'
  switch (status.stage) {
    case 'paused':
      return 'warning'
    case 'failed':
      return 'danger'
    case 'printing':
      return 'success'
    case 'preparing':
    case 'heating':
      return 'primary'
    case 'finished':
    case 'idle':
    case 'unknown':
    default:
      return 'neutral'
  }
}

export function secondaryStageTextColor(status: StatusToneWithOnline | null | undefined): string {
  if (!status || !status.online) return 'text.tertiary'

  switch (status.stage) {
    case 'paused':
      return 'warning.300'
    case 'failed':
      return 'danger.300'
    case 'printing':
    case 'preparing':
    case 'heating':
      return 'primary.300'
    case 'finished':
    case 'idle':
    case 'unknown':
    default:
      return 'text.tertiary'
  }
}

export function progressBarColor(
  status: StatusTone
): 'primary' | 'success' | 'warning' | 'danger' {
  switch (status.stage) {
    case 'paused':
      return 'warning'
    case 'failed':
      return 'danger'
    case 'finished':
      return 'success'
    case 'printing':
    case 'preparing':
    case 'heating':
    default:
      return 'primary'
  }
}

export function progressBarFill(status: StatusTone): string {
  switch (status.stage) {
    case 'paused':
      return 'var(--joy-palette-warning-300)'
    case 'failed':
      return 'var(--joy-palette-danger-400)'
    case 'finished':
      return 'var(--joy-palette-success-400)'
    case 'printing':
    case 'preparing':
    case 'heating':
    default:
      return '#81A6D6'
  }
}

export function progressBarTrack(status: StatusTone): string | undefined {
  switch (status.stage) {
    case 'paused':
    case 'failed':
    case 'finished':
      return undefined
    case 'printing':
    case 'preparing':
    case 'heating':
    default:
      return 'rgba(129, 166, 214, 0.22)'
  }
}

export function dispatchProgressColor(_status: PrintDispatchStatus): 'neutral' {
  return 'neutral'
}

export function dispatchProgressFill(status: PrintDispatchStatus): string {
  switch (status) {
    case 'queued':
      return 'rgba(214, 219, 229, 0.88)'
    case 'uploading':
      return 'rgba(255, 255, 255, 0.94)'
    case 'sent':
      return 'rgba(255, 255, 255, 0.84)'
    case 'cancelled':
      return 'rgba(214, 219, 229, 0.72)'
    case 'failed':
      return 'rgba(232, 184, 184, 0.86)'
    default:
      return 'rgba(255, 255, 255, 0.94)'
  }
}

export function dispatchProgressTrack(status: PrintDispatchStatus): string {
  switch (status) {
    case 'failed':
      return 'rgba(130, 72, 72, 0.28)'
    case 'cancelled':
      return 'rgba(142, 149, 163, 0.24)'
    case 'queued':
      return 'rgba(142, 149, 163, 0.18)'
    case 'uploading':
    case 'sent':
    default:
      return 'rgba(142, 149, 163, 0.22)'
  }
}