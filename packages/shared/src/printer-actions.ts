/**
 * Printer action-availability business logic: functions that decide whether a
 * user-facing action (resume, pause, stop, load filament, recovery actions, ...)
 * is allowed and, when blocked, return the English reason string the UI shows.
 * Also owns the recovery/paused action-list shapes with their UI label unions.
 *
 * Top layer of the printer contract: depends on the wire contracts and the
 * capability/stage helpers, and is never imported by either of them.
 */
import type { PrinterStage, PrinterStatus } from './printer-contracts.js'
import { isPrinterActiveJobStage } from './printer-capabilities.js'

export type PrinterActionAvailability = {
  allowed: boolean
  reason: string | null
}

type PrinterFilamentActionStatus = Pick<
  PrinterStatus,
  'online' | 'stage' | 'subStage' | 'deviceError' | 'hmsErrors' | 'filamentChange' | 'ams' | 'externalSpools'
>

type PrinterPausedActionStatus = Pick<
  PrinterStatus,
  'online' | 'stage' | 'subStage' | 'deviceError' | 'hmsErrors' | 'filamentChange' | 'jobId'
>

type PrinterRecoveryActionStatus = Pick<
  PrinterStatus,
  'online' | 'stage' | 'subStage' | 'deviceError' | 'hmsErrors' | 'filamentChange' | 'jobId' | 'ams' | 'externalSpools'
>

export type PausedPrinterActionId =
  | 'resume'
  | 'ignoreHmsError'
  | 'retryAmsFilamentChange'
  | 'confirmAmsFilamentExtruded'

export interface PausedPrinterAction {
  id: PausedPrinterActionId
  label: 'Resume' | 'Continue' | 'Retry'
}

export type PrinterRecoveryActionId = PausedPrinterActionId | 'loadFilament' | 'checkAssistant' | 'jumpToLiveView'

export interface PrinterRecoveryAction {
  id: PrinterRecoveryActionId
  label: 'Resume' | 'Continue' | 'Retry' | 'Load filament' | 'Check assistant' | 'Live view'
}

const FILAMENT_RUNOUT_SUB_STAGE_CODE = '6'
const FILAMENT_CONFIRM_EXTRUDED_STEP_LABEL = 'Confirm extruded'
const FILAMENT_RUNOUT_MESSAGE_FRAGMENTS = [
  'filament ran out',
  'filament has run out'
]

function allowPrinterAction(): PrinterActionAvailability {
  return { allowed: true, reason: null }
}

function blockPrinterAction(reason: string): PrinterActionAvailability {
  return { allowed: false, reason }
}

function isStagePauseable(stage: PrinterStage | null | undefined): boolean {
  return stage === 'printing' || stage === 'preparing' || stage === 'heating'
}

function filamentActionBusyReason(
  status: Pick<PrinterStatus, 'filamentChange'> | null | undefined
): string | null {
  return status?.filamentChange.currentStepLabel != null || status?.filamentChange.currentStepIndex != null
    ? 'Current extruder is busy changing filament'
    : null
}

function hasConfiguredFilamentDetails(
  source:
    | Pick<PrinterStatus['ams'][number]['slots'][number], 'trayInfoIdx' | 'filamentType'>
    | Pick<PrinterStatus['externalSpools'][number], 'trayInfoIdx' | 'filamentType'>
): boolean {
  return Boolean(
    (typeof source.trayInfoIdx === 'string' && source.trayInfoIdx.trim() !== '')
    || (typeof source.filamentType === 'string' && source.filamentType.trim() !== '')
  )
}

function hasConfiguredFilamentRecoverySource(status: Pick<PrinterStatus, 'ams' | 'externalSpools'> | null | undefined): boolean {
  const hasConfiguredAmsSlot = status?.ams.some((unit) => unit.slots.some((slot) => !slot.active && hasConfiguredFilamentDetails(slot)))
  if (hasConfiguredAmsSlot) return true
  return status?.externalSpools.some((spool) => !spool.active && hasConfiguredFilamentDetails(spool)) ?? false
}

export function isPausedFilamentRunout(
  status: (Pick<PrinterStatus, 'stage'> & Partial<Pick<PrinterStatus, 'subStage'>>) | null | undefined
): boolean {
  return status?.stage === 'paused' && status.subStage === FILAMENT_RUNOUT_SUB_STAGE_CODE
}

export function isPausedFilamentRunoutWarning(
  status: (Pick<PrinterStatus, 'stage' | 'deviceError'> & Partial<Pick<PrinterStatus, 'subStage' | 'hmsErrors'>>) | null | undefined
): boolean {
  if (isPausedFilamentRunout(status)) return true
  if (status?.stage !== 'paused') return false

  const messages = [
    status.deviceError?.message,
    ...(status.hmsErrors ?? []).map((entry) => entry.message)
  ]

  return messages.some((message) => {
    const normalizedMessage = message?.toLocaleLowerCase()
    return normalizedMessage != null
      && FILAMENT_RUNOUT_MESSAGE_FRAGMENTS.some((fragment) => normalizedMessage.includes(fragment))
  })
}

export function isWaitingForFilamentExtrusionConfirmation(
  status: Pick<PrinterStatus, 'stage' | 'filamentChange'> | null | undefined
): boolean {
  return status?.stage === 'paused'
    && status.filamentChange.currentStepLabel === FILAMENT_CONFIRM_EXTRUDED_STEP_LABEL
}

export function getLoadFilamentAvailability(
  status: Pick<PrinterStatus, 'online' | 'stage' | 'subStage' | 'ams' | 'externalSpools'> | null | undefined
): PrinterActionAvailability {
  if (status?.online !== true) return blockPrinterAction('Load filament is only available while the printer is connected')
  if (!isPausedFilamentRunout(status)) {
    return blockPrinterAction('Load filament is only available while the printer is paused on filament runout')
  }
  if (!hasConfiguredFilamentRecoverySource(status)) {
    return blockPrinterAction('No configured AMS slot or external spool is ready to load')
  }
  return allowPrinterAction()
}

export function getCheckAssistantAvailability(
  status: Pick<PrinterStatus, 'online' | 'stage' | 'deviceError' | 'hmsErrors'> | null | undefined
): PrinterActionAvailability {
  if (status?.online !== true) return blockPrinterAction('Check assistant is only available while the printer is connected')
  if (status.stage !== 'paused' && status.stage !== 'failed') {
    return blockPrinterAction('Check assistant is only available while the printer needs attention')
  }
  if (status.deviceError == null && status.hmsErrors.length === 0) {
    return blockPrinterAction('Check assistant is only available while the printer reports a warning or HMS alert')
  }
  return allowPrinterAction()
}

export function getJumpToLiveViewAvailability(
  status: Pick<PrinterStatus, 'online' | 'stage' | 'deviceError' | 'hmsErrors'> | null | undefined
): PrinterActionAvailability {
  if (status?.online !== true) return blockPrinterAction('Live view is only available while the printer is connected')
  if (status.stage !== 'paused' && status.stage !== 'failed') {
    return blockPrinterAction('Live view is only available while the printer needs attention')
  }
  if (status.deviceError == null && status.hmsErrors.length === 0) {
    return blockPrinterAction('Live view is only available while the printer reports a warning or HMS alert')
  }
  return allowPrinterAction()
}

export function getPrinterRecoveryActions(
  status: PrinterRecoveryActionStatus | null | undefined
): PrinterRecoveryAction[] {
  const actions: PrinterRecoveryAction[] = []

  if (getRetryAmsFilamentChangeAvailability(status).allowed) {
    actions.push(
      { id: 'retryAmsFilamentChange', label: 'Retry' },
      { id: 'confirmAmsFilamentExtruded', label: 'Continue' }
    )
  } else {
    if (getResumeAvailability(status).allowed) {
      actions.push({ id: 'resume', label: 'Resume' })
    }

    if (getLoadFilamentAvailability(status).allowed) {
      actions.push({ id: 'loadFilament', label: 'Load filament' })
    }

    if (!isPausedFilamentRunoutWarning(status) && getIgnoreHmsErrorAvailability(status).allowed) {
      actions.push({ id: 'ignoreHmsError', label: 'Continue' })
    }
  }

  if (getCheckAssistantAvailability(status).allowed) {
    actions.push({ id: 'checkAssistant', label: 'Check assistant' })
  }

  if (getJumpToLiveViewAvailability(status).allowed) {
    actions.push({ id: 'jumpToLiveView', label: 'Live view' })
  }

  return actions
}

export function getPauseAvailability(
  status: Pick<PrinterStatus, 'online' | 'stage'> | null | undefined
): PrinterActionAvailability {
  if (status?.online !== true) return blockPrinterAction('Pause is only available while the printer is connected')
  if (!isStagePauseable(status.stage)) return blockPrinterAction('Pause is only available while a print is active')
  return allowPrinterAction()
}

export function getResumeAvailability(
  status: (Pick<PrinterStatus, 'online' | 'stage' | 'deviceError' | 'filamentChange' | 'jobId'> & Partial<Pick<PrinterStatus, 'subStage' | 'hmsErrors'>>) | null | undefined
): PrinterActionAvailability {
  if (status?.online !== true) return blockPrinterAction('Resume is only available while the printer is connected')
  if (status.stage !== 'paused') return blockPrinterAction('Resume is only available while the printer is paused')
  const busyReason = filamentActionBusyReason(status)
  if (busyReason) return blockPrinterAction(busyReason)
  return allowPrinterAction()
}

export function getIgnoreHmsErrorAvailability(
  status: Pick<PrinterStatus, 'online' | 'stage' | 'subStage' | 'deviceError' | 'hmsErrors' | 'filamentChange' | 'jobId'> | null | undefined
): PrinterActionAvailability {
  if (status?.online !== true) return blockPrinterAction('Continue is only available while the printer is connected')
  if (status.stage !== 'paused') return blockPrinterAction('Continue is only available while the printer is paused')
  if (status.deviceError == null) return blockPrinterAction('Continue is only available while the printer is paused on a warning')
  if (isPausedFilamentRunoutWarning(status)) {
    return blockPrinterAction('Continue is not available while the printer is paused on filament runout')
  }
  if (!status.jobId) return blockPrinterAction('Continue is only available when the printer reports a resumable warning id')
  if (isWaitingForFilamentExtrusionConfirmation(status)) {
    return blockPrinterAction('Continue is handled by the filament change confirmation controls')
  }
  const busyReason = filamentActionBusyReason(status)
  if (busyReason) return blockPrinterAction(busyReason)
  return allowPrinterAction()
}

export function getRetryAmsFilamentChangeAvailability(
  status: Pick<PrinterStatus, 'online' | 'stage' | 'filamentChange'> | null | undefined
): PrinterActionAvailability {
  if (status?.online !== true) return blockPrinterAction('Retry is only available while the printer is connected')
  if (status.stage !== 'paused') return blockPrinterAction('Retry is only available while the printer is paused')
  if (!isWaitingForFilamentExtrusionConfirmation(status)) {
    return blockPrinterAction('Retry is only available while the printer is waiting for extrusion confirmation')
  }
  return allowPrinterAction()
}

export function getConfirmAmsFilamentExtrudedAvailability(
  status: Pick<PrinterStatus, 'online' | 'stage' | 'filamentChange'> | null | undefined
): PrinterActionAvailability {
  if (status?.online !== true) return blockPrinterAction('Continue is only available while the printer is connected')
  if (status.stage !== 'paused') return blockPrinterAction('Continue is only available while the printer is paused')
  if (!isWaitingForFilamentExtrusionConfirmation(status)) {
    return blockPrinterAction('Continue is only available while the printer is waiting for extrusion confirmation')
  }
  return allowPrinterAction()
}

export function getPausedPrinterActions(
  status: PrinterPausedActionStatus | null | undefined
): PausedPrinterAction[] {
  if (!status) return []

  return getPrinterRecoveryActions({
    ...status,
    ams: [],
    externalSpools: []
  }).filter((action): action is PausedPrinterAction => (
    action.id === 'resume'
    || action.id === 'ignoreHmsError'
    || action.id === 'retryAmsFilamentChange'
    || action.id === 'confirmAmsFilamentExtruded'
  ))
}

export function getStopAvailability(
  status: Pick<PrinterStatus, 'online' | 'stage'> | null | undefined
): PrinterActionAvailability {
  if (status?.online !== true) return blockPrinterAction('Stop is only available while the printer is connected')
  if (!isPrinterActiveJobStage(status.stage)) return blockPrinterAction('Stop is only available while a print is active')
  return allowPrinterAction()
}

export function getAmsLoadFilamentAvailability(
  status: PrinterFilamentActionStatus | null | undefined,
  amsId: number,
  slotId: number
): PrinterActionAvailability {
  if (status?.online !== true) return blockPrinterAction('Load filament is only available while the printer is connected')

  const slot = status.ams.find((unit) => unit.unitId === amsId)?.slots.find((entry) => entry.slot === slotId)
  if (!slot) return blockPrinterAction('Selected AMS slot is unavailable')

  const busyReason = isPausedFilamentRunout(status) ? null : filamentActionBusyReason(status)
  if (busyReason) return blockPrinterAction(busyReason)
  if (!hasConfiguredFilamentDetails(slot)) {
    return blockPrinterAction('Filament type is unknown. Set the slot filament details before loading.')
  }
  if (slot.active) return blockPrinterAction('Selected filament source is already loaded')

  return allowPrinterAction()
}

export function getAmsUnloadFilamentAvailability(
  status: PrinterFilamentActionStatus | null | undefined,
  amsId: number,
  slotId: number
): PrinterActionAvailability {
  if (status?.online !== true) return blockPrinterAction('Unload filament is only available while the printer is connected')

  const slot = status.ams.find((unit) => unit.unitId === amsId)?.slots.find((entry) => entry.slot === slotId)
  if (!slot) return blockPrinterAction('Selected AMS slot is unavailable')

  const busyReason = filamentActionBusyReason(status)
  if (busyReason) return blockPrinterAction(busyReason)

  return allowPrinterAction()
}

export function getExternalSpoolLoadAvailability(
  status: PrinterFilamentActionStatus | null | undefined,
  amsId: number
): PrinterActionAvailability {
  if (status?.online !== true) return blockPrinterAction('Load filament is only available while the printer is connected')

  const spool = status.externalSpools.find((entry) => entry.amsId === amsId)
  if (!spool) return blockPrinterAction('Selected external spool is unavailable')

  const busyReason = isPausedFilamentRunout(status) ? null : filamentActionBusyReason(status)
  if (busyReason) return blockPrinterAction(busyReason)
  if (!hasConfiguredFilamentDetails(spool)) {
    return blockPrinterAction('Filament type is unknown. Set the slot filament details before loading.')
  }
  if (spool.active) return blockPrinterAction('Selected filament source is already loaded')

  return allowPrinterAction()
}

export function getExternalSpoolUnloadAvailability(
  status: PrinterFilamentActionStatus | null | undefined,
  amsId: number
): PrinterActionAvailability {
  if (status?.online !== true) return blockPrinterAction('Unload filament is only available while the printer is connected')

  const spool = status.externalSpools.find((entry) => entry.amsId === amsId)
  if (!spool) return blockPrinterAction('Selected external spool is unavailable')

  const busyReason = filamentActionBusyReason(status)
  if (busyReason) return blockPrinterAction(busyReason)

  return allowPrinterAction()
}
