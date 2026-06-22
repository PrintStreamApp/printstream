/**
 * Builds the printer-card footer action list — the recovery/control buttons (pause, resume, load
 * filament, retry, continue, check assistant, skip object, stop) plus any plugin-contributed
 * `printer.card.actions`. Each action carries both an inline button and an overflow menu item so
 * {@link useFooterActionOverflow} can move it between the row and the "more" menu. Pure transform
 * from already-resolved availability/visibility flags to descriptors; extracted from PrinterCard.
 */
import { useMemo } from 'react'
import { Button, MenuItem } from '@mui/joy'
import AddIcon from '@mui/icons-material/Add'
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined'
import PauseRoundedIcon from '@mui/icons-material/PauseRounded'
import PlayArrowRoundedIcon from '@mui/icons-material/PlayArrowRounded'
import MoveUpRoundedIcon from '@mui/icons-material/MoveUpRounded'
import StopRoundedIcon from '@mui/icons-material/StopRounded'
import RefreshRoundedIcon from '@mui/icons-material/RefreshRounded'
import WarningAmberRoundedIcon from '@mui/icons-material/WarningAmberRounded'
import TaskAltRoundedIcon from '@mui/icons-material/TaskAltRounded'
import type { PrinterActionAvailability, PrinterCommand } from '@printstream/shared'
import { withDisabledActionReason } from './printerActionHelpers'
import type { PrinterCardFooterAction } from './useFooterActionOverflow'
import type { RegisteredWebPluginSlot } from '../../plugin/registry'

export interface UsePrinterCardFooterActionsOptions {
  footerPluginSlots: RegisteredWebPluginSlot[]
  printerId: string
  printerName: string
  canControlPrinter: boolean
  canSkipObjects: boolean
  submitting: boolean
  onCommand: (command: PrinterCommand) => void
  onSkipObjects: () => void
  showPauseAction: boolean
  showResumeAction: boolean
  showLoadFilamentAction: boolean
  showRetryAmsFilamentChangeAction: boolean
  showIgnoreHmsContinueAction: boolean
  showCheckAssistantAction: boolean
  showConfirmAmsFilamentExtrudedAction: boolean
  showStopAction: boolean
  pauseAvailability: PrinterActionAvailability
  resumeAvailability: PrinterActionAvailability
  loadFilamentAvailability: PrinterActionAvailability
  retryAmsFilamentChangeAvailability: PrinterActionAvailability
  ignoreHmsErrorAvailability: PrinterActionAvailability
  checkAssistantAvailability: PrinterActionAvailability
  confirmAmsFilamentExtrudedAvailability: PrinterActionAvailability
  stopAvailability: PrinterActionAvailability
  onResume: () => void
  onLoadFilament: () => void
  onRetryAmsFilamentChange: () => void
  onIgnoreHmsError: () => void
  onCheckAssistant: () => void
  onConfirmAmsFilamentExtruded: () => void
  onStop: () => void
}

export function usePrinterCardFooterActions({
  footerPluginSlots,
  printerId,
  printerName,
  canControlPrinter,
  canSkipObjects,
  submitting,
  onCommand,
  onSkipObjects,
  showPauseAction,
  showResumeAction,
  showLoadFilamentAction,
  showRetryAmsFilamentChangeAction,
  showIgnoreHmsContinueAction,
  showCheckAssistantAction,
  showConfirmAmsFilamentExtrudedAction,
  showStopAction,
  pauseAvailability,
  resumeAvailability,
  loadFilamentAvailability,
  retryAmsFilamentChangeAvailability,
  ignoreHmsErrorAvailability,
  checkAssistantAvailability,
  confirmAmsFilamentExtrudedAvailability,
  stopAvailability,
  onResume,
  onLoadFilament,
  onRetryAmsFilamentChange,
  onIgnoreHmsError,
  onCheckAssistant,
  onConfirmAmsFilamentExtruded,
  onStop
}: UsePrinterCardFooterActionsOptions): PrinterCardFooterAction[] {
  return useMemo<PrinterCardFooterAction[]>(() => {
    const actions: PrinterCardFooterAction[] = []

    footerPluginSlots.forEach((slot, index) => {
      const Component = slot.component
      actions.push({
        key: `plugin:${slot.name}:${slot.order ?? 0}:${index}`,
        optional: true,
        inline: <Component printerId={printerId} printerName={printerName} presentation="inline" />,
        overflow: <Component printerId={printerId} printerName={printerName} presentation="menu" />
      })
    })

    if (canControlPrinter && showPauseAction) {
      actions.push({
        key: 'pause',
        fill: true,
        inline: withDisabledActionReason(
          <Button
            size="sm"
            variant="soft"
            startDecorator={<PauseRoundedIcon />}
            disabled={submitting || !pauseAvailability.allowed}
            onClick={() => onCommand({ type: 'pause' })}
          >
            Pause
          </Button>,
          submitting ? null : pauseAvailability.reason,
          { fill: true }
        ),
        overflow: <MenuItem disabled={submitting || !pauseAvailability.allowed} onClick={() => onCommand({ type: 'pause' })}>Pause</MenuItem>
      })
    }

    if (canControlPrinter && showResumeAction) {
      actions.push({
        key: 'resume',
        fill: true,
        inline: withDisabledActionReason(
          <Button
            size="sm"
            variant="soft"
            startDecorator={<PlayArrowRoundedIcon />}
            disabled={submitting || !resumeAvailability.allowed}
            onClick={onResume}
          >
            Resume
          </Button>,
          submitting ? null : resumeAvailability.reason,
          { fill: true }
        ),
        overflow: <MenuItem disabled={submitting || !resumeAvailability.allowed} onClick={onResume}>Resume</MenuItem>
      })
    }

    if (showLoadFilamentAction) {
      actions.push({
        key: 'load-filament',
        fill: true,
        inline: withDisabledActionReason(
          <Button
            size="sm"
            variant="soft"
            color="neutral"
            startDecorator={<AddIcon />}
            disabled={submitting || !loadFilamentAvailability.allowed}
            onClick={onLoadFilament}
          >
            Load filament
          </Button>,
          submitting ? null : loadFilamentAvailability.reason,
          { fill: true }
        ),
        overflow: <MenuItem disabled={submitting || !loadFilamentAvailability.allowed} onClick={onLoadFilament}>Load filament</MenuItem>
      })
    }

    if (canControlPrinter && showRetryAmsFilamentChangeAction) {
      actions.push({
        key: 'retry-ams-filament-change',
        fill: true,
        inline: withDisabledActionReason(
          <Button
            size="sm"
            variant="soft"
            color="neutral"
            startDecorator={<RefreshRoundedIcon />}
            disabled={submitting || !retryAmsFilamentChangeAvailability.allowed}
            onClick={onRetryAmsFilamentChange}
          >
            Retry
          </Button>,
          submitting ? null : retryAmsFilamentChangeAvailability.reason,
          { fill: true }
        ),
        overflow: <MenuItem disabled={submitting || !retryAmsFilamentChangeAvailability.allowed} onClick={onRetryAmsFilamentChange}>Retry</MenuItem>
      })
    }

    if (canControlPrinter && showIgnoreHmsContinueAction) {
      actions.push({
        key: 'ignore-hms-error',
        fill: true,
        inline: withDisabledActionReason(
          <Button
            size="sm"
            variant="soft"
            color="warning"
            startDecorator={<WarningAmberRoundedIcon />}
            disabled={submitting || !ignoreHmsErrorAvailability.allowed}
            onClick={onIgnoreHmsError}
          >
            Continue
          </Button>,
          submitting ? null : ignoreHmsErrorAvailability.reason,
          { fill: true }
        ),
        overflow: <MenuItem disabled={submitting || !ignoreHmsErrorAvailability.allowed} onClick={onIgnoreHmsError}>Continue</MenuItem>
      })
    }

    if (showCheckAssistantAction) {
      actions.push({
        key: 'check-assistant',
        inline: withDisabledActionReason(
          <Button
            size="sm"
            variant="soft"
            color="warning"
            startDecorator={<InfoOutlinedIcon />}
            disabled={!checkAssistantAvailability.allowed}
            onClick={onCheckAssistant}
          >
            Check assistant
          </Button>,
          checkAssistantAvailability.reason
        ),
        overflow: <MenuItem disabled={!checkAssistantAvailability.allowed} onClick={onCheckAssistant}>Check assistant</MenuItem>
      })
    }

    if (canControlPrinter && showConfirmAmsFilamentExtrudedAction) {
      actions.push({
        key: 'confirm-ams-filament-extruded',
        fill: true,
        inline: withDisabledActionReason(
          <Button
            size="sm"
            variant="soft"
            startDecorator={<TaskAltRoundedIcon />}
            disabled={submitting || !confirmAmsFilamentExtrudedAvailability.allowed}
            onClick={onConfirmAmsFilamentExtruded}
          >
            Continue
          </Button>,
          submitting ? null : confirmAmsFilamentExtrudedAvailability.reason,
          { fill: true }
        ),
        overflow: <MenuItem disabled={submitting || !confirmAmsFilamentExtrudedAvailability.allowed} onClick={onConfirmAmsFilamentExtruded}>Continue</MenuItem>
      })
    }

    if (canControlPrinter && canSkipObjects) {
      actions.push({
        key: 'skip-objects',
        fill: true,
        inline: <Button size="sm" variant="soft" color="warning" startDecorator={<MoveUpRoundedIcon style={{ transform: 'rotate(90deg)' }} />} disabled={submitting} onClick={onSkipObjects}>Skip object</Button>,
        overflow: <MenuItem disabled={submitting} onClick={onSkipObjects}>Skip object</MenuItem>
      })
    }

    if (canControlPrinter && showStopAction) {
      actions.push({
        key: 'stop',
        fill: true,
        inline: withDisabledActionReason(
          <Button
            size="sm"
            variant="soft"
            color="danger"
            startDecorator={<StopRoundedIcon />}
            disabled={submitting || !stopAvailability.allowed}
            onClick={onStop}
          >
            Stop
          </Button>,
          submitting ? null : stopAvailability.reason,
          { fill: true }
        ),
        overflow: <MenuItem disabled={submitting || !stopAvailability.allowed} onClick={onStop}>Stop</MenuItem>
      })
    }

    return actions
  }, [
    canControlPrinter,
    canSkipObjects,
    checkAssistantAvailability.allowed,
    checkAssistantAvailability.reason,
    confirmAmsFilamentExtrudedAvailability.allowed,
    confirmAmsFilamentExtrudedAvailability.reason,
    footerPluginSlots,
    ignoreHmsErrorAvailability.allowed,
    ignoreHmsErrorAvailability.reason,
    loadFilamentAvailability.allowed,
    loadFilamentAvailability.reason,
    onCheckAssistant,
    onCommand,
    onConfirmAmsFilamentExtruded,
    onIgnoreHmsError,
    onLoadFilament,
    onResume,
    onRetryAmsFilamentChange,
    onSkipObjects,
    onStop,
    pauseAvailability.allowed,
    pauseAvailability.reason,
    printerId,
    printerName,
    resumeAvailability.allowed,
    resumeAvailability.reason,
    retryAmsFilamentChangeAvailability.allowed,
    retryAmsFilamentChangeAvailability.reason,
    showCheckAssistantAction,
    showConfirmAmsFilamentExtrudedAction,
    showIgnoreHmsContinueAction,
    showLoadFilamentAction,
    showPauseAction,
    showResumeAction,
    showRetryAmsFilamentChangeAction,
    showStopAction,
    stopAvailability.allowed,
    stopAvailability.reason,
    submitting
  ])
}
