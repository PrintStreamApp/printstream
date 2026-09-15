/**
 * Confirmation for printer-setting commands.
 *
 * Sending a command to the bridge proves only that it entered the LAN transport;
 * it does not prove that printer firmware accepted it. This observer waits for
 * the normalized status value to reach the requested value, so the settings UI
 * never reports an update that the printer silently ignored.
 */
import type { PrinterCommand, PrinterStatus } from '@printstream/shared'
import { printerEvents } from './printer-events.js'
import { printerManager } from './printer-manager.js'

const SETTING_CONFIRMATION_TIMEOUT_MS = 6_000

export interface PrinterSettingConfirmation {
  promise: Promise<boolean>
  cancel: () => void
}

/** Return whether a setting status matches its command, or null for commands that are not settings. */
export function printerSettingMatchesCommand(
  status: PrinterStatus | undefined,
  command: PrinterCommand
): boolean | null {
  switch (command.type) {
    case 'setAirductMode':
      return status ? status.ductMode === command.mode : false
    case 'setPrintOption': {
      if (!status) return false
      const option = status.printOptions[command.option]
      if (option.enabled !== command.enabled) return false
      if (!command.sensitivity) return true
      return 'sensitivity' in option && option.sensitivity === command.sensitivity
    }
    case 'setPurifyAirAtPrintEnd':
      return status ? status.printOptions.purifyAirAtPrintEnd.current === command.mode : false
    case 'setOpenDoorDetection':
      return status ? status.printOptions.openDoorDetection.current === command.mode : false
    case 'setSmartNozzleBlobDetection':
      return status ? status.printOptions.smartNozzleBlobDetection.current === command.mode : false
    case 'setCameraResolution':
      return status ? status.printOptions.cameraResolution.current === command.resolution : false
    default:
      return null
  }
}

/**
 * Start observing before a command is published, avoiding a race with a fast
 * printer report. A false result means no confirming state arrived in time.
 */
export function observePrinterSettingConfirmation(
  printerId: string,
  command: PrinterCommand,
  timeoutMs = SETTING_CONFIRMATION_TIMEOUT_MS
): PrinterSettingConfirmation | null {
  const currentMatch = printerSettingMatchesCommand(printerManager.getStatus(printerId), command)
  if (currentMatch === null) return null
  if (currentMatch) {
    return { promise: Promise.resolve(true), cancel: () => undefined }
  }

  let settled = false
  let resolvePromise: (confirmed: boolean) => void = () => undefined
  const finish = (confirmed: boolean) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    printerEvents.off('status', onStatus)
    resolvePromise(confirmed)
  }
  const onStatus = (status: PrinterStatus) => {
    if (status.printerId !== printerId) return
    if (printerSettingMatchesCommand(status, command)) finish(true)
  }
  const promise = new Promise<boolean>((resolve) => {
    resolvePromise = resolve
  })
  const timer = setTimeout(() => finish(false), timeoutMs)
  printerEvents.on('status', onStatus)

  return { promise, cancel: () => finish(false) }
}
