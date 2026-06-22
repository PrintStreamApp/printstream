/**
 * Startup reconcile + reconnect cleanup for interrupted dispatches.
 *
 * On boot, any dispatch the previous process life left in a pre-publish state is marked
 * `interrupted` in the journal (it provably never started a print). Then, as each printer
 * comes back online, we best-effort delete any orphaned bytes those interrupted uploads
 * left on the printer's SD card and drop the handled journal rows. This is the connectivity-
 * gated half of durable dispatch: the SD delete needs a live bridge/printer link, which
 * isn't available at boot.
 *
 * Safety: only `interrupted` rows are cleaned, and a row only becomes `interrupted` if it
 * never crossed the rob-1 start boundary — so deleting its SD file can never remove a file
 * a real print is using. We also skip a printer that has an active dispatch to avoid racing
 * a fresh upload of the same file name.
 */
import type { PrinterStatus } from '@printstream/shared'
import { printerEvents } from './printer-events.js'
import { printerManager } from './printer-manager.js'
import { deletePrinterFile } from './printer-ftp.js'
import { printDispatcher } from './print-dispatcher.js'
import { deleteDispatchJournalRows, listInterruptedDispatchUploads, reconcileInterruptedDispatches } from './dispatch-journal.js'

/** Printers whose orphaned uploads we've already swept this process life. */
const sweptPrinters = new Set<string>()
let started = false

export async function startDispatchReconcile(): Promise<void> {
  if (started) return
  started = true
  sweptPrinters.clear()
  const interrupted = await reconcileInterruptedDispatches().catch((error) => {
    console.error('[dispatch-reconcile] boot reconcile failed', (error as Error).message)
    return 0
  })
  if (interrupted > 0) {
    console.log(`[dispatch-reconcile] marked ${interrupted} interrupted dispatch(es) from a prior server life`)
  }
  printerEvents.on('status', onStatus)
}

export function stopDispatchReconcile(): void {
  if (!started) return
  started = false
  printerEvents.off('status', onStatus)
  sweptPrinters.clear()
}

const onStatus = (status: PrinterStatus): void => {
  if (!status.online || sweptPrinters.has(status.printerId)) return
  void sweepInterruptedUploads(status.printerId)
}

async function sweepInterruptedUploads(printerId: string): Promise<void> {
  // Don't race a fresh dispatch that may be re-uploading the same remote file name;
  // leave this printer unswept so a later (idle) status retries it.
  if (printDispatcher.hasActiveDispatchForPrinter(printerId)) return
  const printer = printerManager.getPrinter(printerId)
  if (!printer) return
  // Mark before the awaits so a burst of status frames doesn't launch redundant sweeps.
  sweptPrinters.add(printerId)

  const orphans = await listInterruptedDispatchUploads(printerId).catch(() => [])
  if (orphans.length === 0) return
  for (const orphan of orphans) {
    try {
      await deletePrinterFile(printer, `/${orphan.remoteName}`)
    } catch {
      // Best-effort: the file may never have landed (a queued-origin row) or already be gone.
    }
  }
  await deleteDispatchJournalRows(orphans.map((orphan) => orphan.id))
}
