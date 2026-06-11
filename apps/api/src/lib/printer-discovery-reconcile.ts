/**
 * Reconcile LAN discovery data with already-adopted printers.
 *
 * Discovery packets are keyed by serial number and may surface a new
 * host after a DHCP change or printer reboot. When that happens for an
 * adopted printer, update every persisted copy that shares the serial
 * and hand each refreshed record back through the printer manager so
 * reconnect logic stays centralized in one place.
 */
import type { Printer } from '@printstream/shared'
import { printerManager } from './printer-manager.js'
import { rootPrisma } from './prisma.js'
import { toPrinterDto } from './printer-record.js'

interface PrinterRowLike {
  id: string
  name: string
  host: string
  serial: string
  accessCode: string
  model: string
  currentPlateType: string | null
  currentNozzleDiameters: string | null
  position: number
  createdAt: Date
  updatedAt: Date
}

interface PrinterStore {
  findMany(args: { where: { serial: string } }): Promise<PrinterRowLike[]>
  update(args: { where: { id: string }; data: { host: string } }): Promise<PrinterRowLike>
}

interface ManagedPrinterUpdater {
  update(printer: Printer): void
}

interface DiscoveryReconcileDeps {
  printerStore: PrinterStore
  manager: ManagedPrinterUpdater
}

const defaultDeps: DiscoveryReconcileDeps = {
  printerStore: rootPrisma.printer,
  manager: printerManager
}

export async function reconcileAdoptedPrinterHost(
  discovered: { serial: string; host: string },
  deps: DiscoveryReconcileDeps = defaultDeps
): Promise<boolean> {
  const existing = await deps.printerStore.findMany({ where: { serial: discovered.serial } })
  const stale = existing.filter((row) => row.host !== discovered.host)
  if (stale.length === 0) return false

  const updated = await Promise.all(stale.map(async (row) => await deps.printerStore.update({
    where: { id: row.id },
    data: { host: discovered.host }
  })))

  for (const row of updated) {
    deps.manager.update(toPrinterDto(row))
  }
  console.log(
    `[discovery] refreshed ${updated.length} adopted printer host `
    + `entr${updated.length === 1 ? 'y' : 'ies'} for serial ${discovered.serial} -> ${discovered.host}`
  )
  return true
}