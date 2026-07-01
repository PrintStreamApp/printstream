/**
 * Typed event bus for printer-domain events.
 *
 * The printer manager is the only emitter; routes, the WebSocket
 * broadcaster, and plugins are subscribers. Keeping this in its own
 * module avoids a circular import between the manager and the WS layer
 * and gives plugins a stable subscription surface.
 */
import { EventEmitter } from 'node:events'
import type { DiscoveredPrinter, Printer, PrinterStatus } from '@printstream/shared'

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
  'printer.removed': (event: { printerId: string; tenantId: string }) => void
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
  'order-print.queued': (event: { tenantId: string; orderPrintId: string }) => void
  'order-print.unqueued': (event: { tenantId: string; orderPrintId: string }) => void
  'order-print.dispatched': (event: {
    tenantId: string
    orderPrintId: string
    printerId: string
    fileName: string
    plate: number
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
