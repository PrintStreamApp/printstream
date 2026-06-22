/**
 * Reconcile LAN discovery data with already-adopted printers.
 *
 * Discovery packets are keyed by serial number and may surface a new host after a
 * DHCP change or printer reboot. When that happens for an adopted printer, update
 * the persisted record(s) **owned by the bridge that observed the change** and
 * hand each refreshed record back through the printer manager so reconnect logic
 * stays centralized in one place.
 *
 * Scoping the update to the reporting `bridgeId` is a security boundary, not just
 * a nicety: printer serials are only unique per tenant (`@@unique([tenantId,
 * serial])`), so a serial-only match would let one bridge's discovery rewrite the
 * host of a same-serial printer in another tenant — pointing its MQTT/FTPS
 * traffic at an attacker-chosen address while it still carries its access code. A
 * bridge may only ever refresh the host of printers assigned to it.
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
  findMany(args: { where: { serial: string; bridgeId: string } }): Promise<PrinterRowLike[]>
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
  discovered: { serial: string; host: string; bridgeId: string },
  deps: DiscoveryReconcileDeps = defaultDeps
): Promise<boolean> {
  const existing = await deps.printerStore.findMany({
    where: { serial: discovered.serial, bridgeId: discovered.bridgeId }
  })
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
    + `entr${updated.length === 1 ? 'y' : 'ies'} for serial ${discovered.serial} -> ${discovered.host} `
    + `(bridge ${discovered.bridgeId})`
  )
  return true
}