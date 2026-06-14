/**
 * Bridge assignment recovery.
 *
 * When a bridge is replaced, printers may still point at the old bridge row.
 * Recovery is deliberately conservative: it only moves orphaned printers when
 * the tenant has a single bridge, or printers currently rediscovered by the
 * connected bridge from disconnected bridge assignments.
 */
import { bridgeSessionManager } from './bridge-session-manager.js'
import { printerDiscovery } from './printer-discovery.js'
import { printerManager } from './printer-manager.js'
import { toPrinterDto } from './printer-record.js'
import { rootPrisma } from './prisma.js'

interface RecoverablePrinterRow {
  id: string
  tenantId: string
  bridgeId: string | null
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

export async function recoverBridgePrinterAssignments(input: {
  tenantId: string
  bridgeId: string
}): Promise<RecoverablePrinterRow[]> {
  const [tenantBridges, candidatePrinters] = await Promise.all([
    rootPrisma.bridge.findMany({
      where: { tenantId: input.tenantId },
      select: { id: true }
    }),
    rootPrisma.printer.findMany({
      where: {
        tenantId: input.tenantId,
        OR: [
          { bridgeId: null },
          { bridgeId: { not: input.bridgeId } }
        ]
      },
      orderBy: { position: 'asc' }
    })
  ])

  if (candidatePrinters.length === 0) return []

  const discoveredSerials = new Set(
    printerDiscovery.list({ bridgeIds: [input.bridgeId] }).map((printer) => printer.serial)
  )
  const disconnectedBridgeIds = new Set(
    tenantBridges
      .map((bridge) => bridge.id)
      .filter((bridgeId) => bridgeId !== input.bridgeId && !bridgeSessionManager.isConnected(bridgeId))
  )
  const onlyTenantBridge = tenantBridges.length === 1
  const recoveredPrinters = candidatePrinters.filter((printer) => {
    if (printer.bridgeId === input.bridgeId) return false
    if (printer.bridgeId === null) return onlyTenantBridge || discoveredSerials.has(printer.serial)
    return disconnectedBridgeIds.has(printer.bridgeId) && discoveredSerials.has(printer.serial)
  })

  if (recoveredPrinters.length === 0) return []

  await rootPrisma.printer.updateMany({
    where: {
      tenantId: input.tenantId,
      id: { in: recoveredPrinters.map((printer) => printer.id) }
    },
    data: { bridgeId: input.bridgeId }
  })

  for (const printer of recoveredPrinters) {
    printerManager.update(toPrinterDto({ ...printer, bridgeId: input.bridgeId }), input.tenantId, input.bridgeId)
  }

  return recoveredPrinters
}
