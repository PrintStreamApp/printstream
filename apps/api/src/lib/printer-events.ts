/**
 * Typed event bus for printer-domain events.
 *
 * The printer manager is the only emitter; routes, the WebSocket
 * broadcaster, and plugins are subscribers. Keeping this in its own
 * module avoids a circular import between the manager and the WS layer
 * and gives plugins a stable subscription surface.
 */
import { EventEmitter } from 'node:events'
import type { DiscoveredPrinter, NotificationMessage, Printer, PrinterStatus } from '@printstream/shared'

export interface PrinterEvents {
  'status': (status: PrinterStatus) => void
  'job.started': (event: { printer: Printer; jobName: string }) => void
  'job.finished': (event: { printer: Printer; jobName: string; result: 'success' | 'failed' | 'cancelled' }) => void
  'print-job.started': (event: { jobId: string; printer: Printer; jobName: string }) => void
  'print-job.finished': (event: {
    jobId: string
    printer: Printer
    jobName: string
    result: 'success' | 'failed' | 'cancelled'
    snapshotPath: string | null
  }) => void
  'printer.added': (printer: Printer) => void
  'printer.updated': (printer: Printer) => void
  'printer.removed': (event: { printerId: string; workspaceId: string }) => void
  /**
   * Emitted when the LAN discovery listener's known set changes
   * (a printer was first seen, an attribute changed, or an entry
   * aged out). Carries the full current snapshot.
   */
  'printer.discovered': (printers: DiscoveredPrinter[]) => void
  /**
   * Emitted just before PrintStream sends a print-start command for a tracked
   * job. Lets plugins (e.g. plate-clearing) differentiate app-initiated
   * starts from prints started externally.
   */
  'print.job.starting': (event: { printerId: string; jobId: string; taskId: string | null; fileName: string }) => void
  /**
   * Cross-plugin lifecycle for a queue item linked to an order print (the
   * print-queue emits; the orders plugin listens). Keeps the plugins decoupled —
   * neither imports the other — while letting queuing/dispatch advance the order:
   * - `order-print.queued`     — the print was added to the queue (mark it queued).
   * - `order-print.unqueued`   — removed from the queue before dispatch (revert).
   * - `order-print.dispatched` — dispatched from the queue onto `printerId` as
   *   `fileName`/`plate` (orders records the started print and then syncs its result).
   */
  'order-print.queued': (event: { workspaceId: string; orderPrintId: string }) => void
  'order-print.unqueued': (event: { workspaceId: string; orderPrintId: string }) => void
  'order-print.dispatched': (event: {
    workspaceId: string
    orderPrintId: string
    printerId: string
    fileName: string
    plate: number
  }) => void
  /**
   * A bridge reported that its previous run crashed (restarted without a clean
   * shutdown). Emitted by the bridge-crash-report ingest after it has decided the
   * crash warrants a user notification (rate-limited); the notification formatter
   * turns it into a `bridge.crashed` message on every channel. `workspaceId` is null
   * for an unpaired bridge (no one to notify).
   */
  'bridge.crashed': (event: {
    bridgeId: string
    bridgeName: string
    workspaceId: string | null
    recentCrashCount: number
  }) => void
  /**
   * A pre-rendered platform-scope notification (operator events: no owning
   * workspace). Emitted by `lib/platform-notification-events.ts`; the channel
   * plugins deliver it through their platform-scope configuration. The
   * message's `workspaceId` is intentionally unset.
   */
  'platform.notification': (event: { message: NotificationMessage }) => void
  /**
   * Ask notification surfaces to retract an already-delivered notification,
   * matched by its collapse `tag` (e.g. the user read the support thread, so
   * the thread's notification is stale on every device). With
   * `targetUserIds` the dismissal addresses only those users' devices
   * (cross-scope when `workspaceId` is null, mirroring the targeted-delivery
   * contract); without it every subscription in the given scope is asked.
   * Channels that cannot retract (email, webhooks) ignore it.
   */
  'notification.dismiss': (event: { tag: string; workspaceId: string | null; targetUserIds?: string[] }) => void
  /**
   * A filament spool became loaded in an AMS slot (the `filament-manager` plugin
   * emits on RFID auto-association and manual slot assignment). Carries the
   * spool's identity so a listener (the `calibration` plugin) can look up and
   * apply a saved calibration for that filament without importing filament-manager.
   */
  'ams-slot.filament-loaded': (event: {
    workspaceId: string
    printerId: string
    amsId: number
    slotId: number
    spoolId: string
    brand: string | null
    filamentType: string | null
    materialSubtype: string | null
    colorName: string | null
  }) => void
}

export class PrinterEventBus extends EventEmitter {
  override on<E extends keyof PrinterEvents>(event: E, listener: PrinterEvents[E]): this {
    return super.on(event, listener as (...args: unknown[]) => void)
  }

  override off<E extends keyof PrinterEvents>(event: E, listener: PrinterEvents[E]): this {
    return super.off(event, listener as (...args: unknown[]) => void)
  }

  override emit<E extends keyof PrinterEvents>(event: E, ...args: Parameters<PrinterEvents[E]>): boolean {
    return super.emit(event, ...args)
  }
}

export const printerEvents = new PrinterEventBus()
