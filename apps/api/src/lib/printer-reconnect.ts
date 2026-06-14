/**
 * Explicit printer reconnect helpers.
 *
 * Most reconnects happen inside the MQTT client's automatic retry loop,
 * but callers like the manual Refresh action need a deterministic way to
 * kick an offline printer immediately. If discovery already knows the
 * printer came back on a new host, update persistence first; otherwise
 * recycle the existing MQTT client on the saved host.
 */
import type { Printer } from '@printstream/shared'
import { printerDiscovery } from './printer-discovery.js'
import { reconcileAdoptedPrinterHost } from './printer-discovery-reconcile.js'
import { printerManager } from './printer-manager.js'

export type PrinterReconnectResult = 'updated-host' | 'reconnecting'

interface PrinterReconnectDeps {
  discovery: {
    get(serial: string): { host: string } | undefined
  }
  reconcileHost: (discovered: { serial: string; host: string }) => Promise<boolean>
  manager: {
    reconnect(printerId: string): boolean
  }
}

const defaultDeps: PrinterReconnectDeps = {
  discovery: printerDiscovery,
  reconcileHost: reconcileAdoptedPrinterHost,
  manager: printerManager
}

export async function reconnectPrinter(
  printer: Printer,
  deps: PrinterReconnectDeps = defaultDeps
): Promise<PrinterReconnectResult> {
  const discovered = deps.discovery.get(printer.serial)
  if (discovered && discovered.host !== printer.host) {
    const updated = await deps.reconcileHost({ serial: printer.serial, host: discovered.host })
    if (updated) return 'updated-host'
  }

  deps.manager.reconnect(printer.id)
  return 'reconnecting'
}