/**
 * Tells genuine printer faults apart from cancellation records and intentional
 * pauses. UI grading, recovery actions and API notifications share this policy.
 *
 * Bambu reports a cancellation exactly the way it reports a jam: `gcode_state`
 * goes to FAILED and a `print_error` code is set. Read literally, that makes
 * every cancelled print look like a broken one -- the fleet view sorted the
 * printer under "needs attention", the card offered a recovery assistant for a
 * print nobody wants recovered, and history recorded the job as Failed. The only
 * thing separating the two cases is the error code, so the question is answered
 * here once and every surface asks it the same way.
 *
 * Owns: cancellation and intentional-pause classification, plus the fault
 * predicates shared by action gates (`printer-actions.js`), fleet-view grading
 * (`apps/web/src/lib/printersViewHelpers.ts`), notifications
 * (`apps/api/src/lib/notification-format.ts`) and the job recorder
 * (`apps/api/src/lib/printer-manager.ts`).
 *
 * Vendor note: the codes are Bambu `device_error` identifiers. When the printer
 * driver boundary lands this table
 * belongs to the Bambu driver; the predicates stay generic.
 *
 * Depends only on the wire contracts; `printer-capabilities.js` and
 * `printer-actions.js` sit above it.
 */
import type { PrinterStatus } from './printer-contracts.js'

type PrinterErrorReport = PrinterStatus['deviceError']

type PrinterErrorReportStatus = Pick<PrinterStatus, 'deviceError' | 'hmsErrors'>

type PrinterErrorStateStatus = Pick<PrinterStatus, 'stage' | 'deviceError' | 'hmsErrors'>

/**
 * Bambu `device_error` codes that mean "this print ended because it was
 * cancelled", in the canonical 8-hex-character form `formatPrintErrorCode`
 * produces. Both are published in Bambu's own dictionary
 * (https://e.bambulab.com/query.php?lang=en) as "The task was canceled." and
 * "Printing was cancelled." respectively; which one a machine reports varies by
 * model and by where the cancellation came from (PrintStream, the printer's own
 * screen, or Bambu Handy), so both are recognized.
 *
 * A code missing from this list is treated as a real fault, which is the safe
 * direction to be wrong in: an unrecognized cancellation still shows a recovery
 * surface nobody needs, where a misfiled fault would hide a broken printer.
 */
export const PRINT_CANCELLATION_DEVICE_ERROR_CODES: readonly string[] = [
  '0300400C',
  '0500400E'
]

/** Whether a reported device error is a cancellation record rather than a fault. */
export function isPrintCancellationError(error: PrinterErrorReport | null | undefined): boolean {
  if (!error) return false
  return PRINT_CANCELLATION_DEVICE_ERROR_CODES.includes(error.code.toUpperCase())
}

/**
 * A user/file-requested pause is important, but is not a printer fault. Match
 * only the canonical device code, never localized message text or all pauses.
 * BambuStudio's resources/hms/hms_en_094.json names 03008013 as a user pause.
 * Other pause causes (door open, fan failure, etc.) remain faults.
 */
export function isIntentionalPrintPause(error: PrinterErrorReport | null | undefined): boolean {
  return error?.code.toUpperCase() === '03008013'
}

/** Whether a device report names a fault; unknown codes fail toward attention. */
export function isPrinterDeviceFault(error: PrinterErrorReport | null | undefined): boolean {
  return error != null && !isPrintCancellationError(error) && !isIntentionalPrintPause(error)
}

/**
 * Whether the printer's terminal state is a cancelled print.
 *
 * Gated on the FAILED stage as well as the code so a stale cancellation error --
 * `deviceError` only changes when the printer sends a new `print_error`, so it
 * survives into the next job -- cannot make a healthy print look cancelled.
 */
export function wasPrintCancelled(
  status: Pick<PrinterStatus, 'stage' | 'deviceError'> | null | undefined
): boolean {
  return status?.stage === 'failed' && isPrintCancellationError(status.deviceError)
}

/**
 * Whether the printer is reporting something wrong RIGHT NOW: any HMS alert, or
 * a device error that is neither a cancellation record nor an intentional pause.
 *
 * This is the "is there anything to act on?" question. It deliberately ignores
 * the stage, so it stays true for a fault the printer raised without pausing.
 */
export function hasPrinterErrorReport(
  status: PrinterErrorReportStatus | null | undefined
): boolean {
  if (!status) return false
  if (status.hmsErrors.length > 0) return true
  return isPrinterDeviceFault(status.deviceError)
}

/**
 * Whether the printer should read as being in an error state in the fleet view:
 * it is reporting a fault, or its last job ended badly for a reason it did not
 * name.
 *
 * A FAILED stage with no error code at all still counts -- the printer said the
 * job failed and offered no explanation, which is exactly when the user most
 * needs to see it.
 */
export function isPrinterErrorState(
  status: PrinterErrorStateStatus | null | undefined
): boolean {
  if (!status) return false
  if (hasPrinterErrorReport(status)) return true
  return status.stage === 'failed' && !isPrintCancellationError(status.deviceError)
}
