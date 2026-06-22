/**
 * Resolves a printer's recovery/control action surface from its live status: per-action
 * availability (allowed + reason), which actions to show (driven by the printer's reported recovery
 * actions and stage), and the request handlers that fire each command — some behind a confirm
 * prompt. Extracted from PrinterCard so the card body isn't dominated by recovery wiring; the card
 * feeds the results into the footer-action builder and the assistant/recovery dialogs.
 */
import { useCallback } from 'react'
import {
  getCheckAssistantAvailability,
  getConfirmAmsFilamentExtrudedAvailability,
  getIgnoreHmsErrorAvailability,
  getJumpToLiveViewAvailability,
  getLoadFilamentAvailability,
  getPauseAvailability,
  getPrinterRecoveryActions,
  getRetryAmsFilamentChangeAvailability,
  getResumeAvailability,
  getStopAvailability,
  isPrinterActiveJobStage,
  type PrinterActionAvailability,
  type PrinterCommand,
  type PrinterStatus
} from '@printstream/shared'
import { getPrinterCommandPrompt } from '../../lib/printerCommandWarnings'
import type { ConfirmDialogOptions } from '../PromptDialogProvider'

/** The slice of the command mutation the recovery handlers need. */
interface CommandSender {
  isPending: boolean
  mutate: (command: PrinterCommand) => void
}

export interface UsePrinterRecoveryActionsOptions {
  status: PrinterStatus | undefined
  printerName: string
  canManagePrinter: boolean
  canViewCamera: boolean
  cameraSupported: boolean
  sendCommand: CommandSender
  confirm: (options: ConfirmDialogOptions) => Promise<boolean>
  onOpenFilamentRecovery: () => void
  onOpenAssistant: () => void
}

export interface PrinterRecoveryActions {
  pauseAvailability: PrinterActionAvailability
  resumeAvailability: PrinterActionAvailability
  loadFilamentAvailability: PrinterActionAvailability
  ignoreHmsErrorAvailability: PrinterActionAvailability
  checkAssistantAvailability: PrinterActionAvailability
  jumpToLiveViewAvailability: PrinterActionAvailability
  retryAmsFilamentChangeAvailability: PrinterActionAvailability
  confirmAmsFilamentExtrudedAvailability: PrinterActionAvailability
  stopAvailability: PrinterActionAvailability
  showPauseAction: boolean
  showResumeAction: boolean
  showLoadFilamentAction: boolean
  showIgnoreHmsContinueAction: boolean
  showCheckAssistantAction: boolean
  canOpenAssistantLiveView: boolean
  showRetryAmsFilamentChangeAction: boolean
  showConfirmAmsFilamentExtrudedAction: boolean
  showStopAction: boolean
  requestStopPrint: () => void
  requestResumePrint: () => void
  requestIgnoreHmsError: () => void
  requestLoadFilament: () => void
  requestCheckAssistant: () => void
  requestRetryAmsFilamentChange: () => void
  requestConfirmAmsFilamentExtruded: () => void
}

export function usePrinterRecoveryActions({
  status,
  printerName,
  canManagePrinter,
  canViewCamera,
  cameraSupported,
  sendCommand,
  confirm,
  onOpenFilamentRecovery,
  onOpenAssistant
}: UsePrinterRecoveryActionsOptions): PrinterRecoveryActions {
  const stage = status?.stage
  const pauseAvailability = getPauseAvailability(status)
  const resumeAvailability = getResumeAvailability(status)
  const loadFilamentAvailability = getLoadFilamentAvailability(status)
  const ignoreHmsErrorAvailability = getIgnoreHmsErrorAvailability(status)
  const checkAssistantAvailability = getCheckAssistantAvailability(status)
  const jumpToLiveViewAvailability = getJumpToLiveViewAvailability(status)
  const retryAmsFilamentChangeAvailability = getRetryAmsFilamentChangeAvailability(status)
  const confirmAmsFilamentExtrudedAvailability = getConfirmAmsFilamentExtrudedAvailability(status)
  const stopAvailability = getStopAvailability(status)
  const recoveryActionIds = getPrinterRecoveryActions(status).map((action) => action.id)
  const showPauseAction = stage === 'printing' || stage === 'preparing' || stage === 'heating'
  const showResumeAction = recoveryActionIds.includes('resume')
  const showLoadFilamentAction = recoveryActionIds.includes('loadFilament')
    && canManagePrinter
    && loadFilamentAvailability.allowed
  const showIgnoreHmsContinueAction = recoveryActionIds.includes('ignoreHmsError')
  const showCheckAssistantAction = recoveryActionIds.includes('checkAssistant')
  const canOpenAssistantLiveView = recoveryActionIds.includes('jumpToLiveView')
    && canViewCamera
    && cameraSupported
  const showRetryAmsFilamentChangeAction = recoveryActionIds.includes('retryAmsFilamentChange')
  const showConfirmAmsFilamentExtrudedAction = recoveryActionIds.includes('confirmAmsFilamentExtruded')
  const showStopAction = isPrinterActiveJobStage(stage)

  const requestStopPrint = useCallback(() => {
    const run = async () => {
      if (sendCommand.isPending || !stopAvailability.allowed) return
      const confirmed = await confirm({
        title: 'Stop active print?',
        description: `Stop the active print on ${printerName}?`,
        confirmLabel: 'Stop print',
        color: 'danger'
      })
      if (!confirmed) return
      sendCommand.mutate({ type: 'stop' })
    }

    void run()
  }, [confirm, printerName, sendCommand, stopAvailability.allowed])

  const requestResumePrint = useCallback(() => {
    if (sendCommand.isPending || !resumeAvailability.allowed) return

    sendCommand.mutate({ type: 'resume' })
  }, [resumeAvailability.allowed, sendCommand])

  const requestIgnoreHmsError = useCallback(() => {
    const run = async () => {
      if (sendCommand.isPending || !ignoreHmsErrorAvailability.allowed || status?.deviceError == null) return

      const prompt = getPrinterCommandPrompt(
        {
          stage: status?.stage ?? 'unknown',
          ductMode: status?.ductMode ?? null,
          chamberLightOffRequiresConfirm: status?.chamberLightOffRequiresConfirm ?? false,
          deviceError: status?.deviceError ?? null
        },
        { type: 'ignoreHmsError' }
      )
      if (prompt?.kind === 'confirm') {
        const confirmed = await confirm({
          title: prompt.title ?? 'Continue print?',
          description: prompt.message,
          confirmLabel: prompt.confirmLabel,
          cancelLabel: prompt.cancelLabel,
          color: prompt.color ?? 'primary'
        })
        if (!confirmed) return
      }

      sendCommand.mutate({ type: 'ignoreHmsError' })
    }

    void run()
  }, [confirm, ignoreHmsErrorAvailability.allowed, sendCommand, status])

  const requestLoadFilament = useCallback(() => {
    if (sendCommand.isPending || !loadFilamentAvailability.allowed) return
    onOpenFilamentRecovery()
  }, [loadFilamentAvailability.allowed, onOpenFilamentRecovery, sendCommand.isPending])

  const requestCheckAssistant = useCallback(() => {
    if (!checkAssistantAvailability.allowed) return
    onOpenAssistant()
  }, [checkAssistantAvailability.allowed, onOpenAssistant])

  const requestRetryAmsFilamentChange = useCallback(() => {
    if (sendCommand.isPending || !retryAmsFilamentChangeAvailability.allowed) return

    sendCommand.mutate({ type: 'retryAmsFilamentChange' })
  }, [retryAmsFilamentChangeAvailability.allowed, sendCommand])

  const requestConfirmAmsFilamentExtruded = useCallback(() => {
    if (sendCommand.isPending || !confirmAmsFilamentExtrudedAvailability.allowed) return

    sendCommand.mutate({ type: 'confirmAmsFilamentExtruded' })
  }, [confirmAmsFilamentExtrudedAvailability.allowed, sendCommand])

  return {
    pauseAvailability,
    resumeAvailability,
    loadFilamentAvailability,
    ignoreHmsErrorAvailability,
    checkAssistantAvailability,
    jumpToLiveViewAvailability,
    retryAmsFilamentChangeAvailability,
    confirmAmsFilamentExtrudedAvailability,
    stopAvailability,
    showPauseAction,
    showResumeAction,
    showLoadFilamentAction,
    showIgnoreHmsContinueAction,
    showCheckAssistantAction,
    canOpenAssistantLiveView,
    showRetryAmsFilamentChangeAction,
    showConfirmAmsFilamentExtrudedAction,
    showStopAction,
    requestStopPrint,
    requestResumePrint,
    requestIgnoreHmsError,
    requestLoadFilament,
    requestCheckAssistant,
    requestRetryAmsFilamentChange,
    requestConfirmAmsFilamentExtruded
  }
}
