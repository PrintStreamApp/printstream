/**
 * Bridge assignment recovery.
 *
 * When a bridge is replaced, printers may still point at the old bridge row.
 * Recovery is deliberately conservative: it only moves orphaned printers when
 * the tenant has a single bridge, or printers currently rediscovered by the
 * connected bridge from disconnected bridge assignments.
 *
 * When that reassignment *fully drains* a disconnected sibling bridge (every one
 * of its printers now lives on the connected bridge), we treat it as the same
 * physical install returning under a new identity — the exact situation a
 * corrupt/reset state file produces — and re-home its bridge-owned library too.
 * The files sit on the same disk at unchanged `storedPath`s, so only ownership
 * (`ownerBridgeId`) needs to move for them to become reachable again.
 */
import { bridgeSessionManager } from './bridge-session-manager.js'
import { printerDiscovery } from './printer-discovery.js'
import { printerManager } from './printer-manager.js'
import { toPrinterDto } from './printer-record.js'
import { rootPrisma } from './prisma.js'
import { broadcastLibraryChanged } from './ws-resource-events.js'

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

  const supersededBridgeIds = new Set<string>()
  for (const printer of recoveredPrinters) {
    // Log a transfer that takes a printer off a *different* (disconnected) sibling
    // bridge — this is the path that, on a spoofed/over-broad discovery snapshot,
    // can flap ownership of a temporarily-offline sibling's printer. Logging keeps
    // the reassignment auditable/diagnosable. (Reachability-gating the transfer is
    // deferred: it intersects the bridge-replacement re-pairing flow — rob-2.)
    if (printer.bridgeId && printer.bridgeId !== input.bridgeId) {
      supersededBridgeIds.add(printer.bridgeId)
      console.warn(`[bridge-recovery] reassigned printer ${printer.id} (serial ${printer.serial}) from bridge ${printer.bridgeId} to ${input.bridgeId} after rediscovery`)
    }
    printerManager.update(toPrinterDto({ ...printer, bridgeId: input.bridgeId }), input.tenantId, input.bridgeId)
  }

  await reAdoptLibraryFromDrainedBridges({
    tenantId: input.tenantId,
    bridgeId: input.bridgeId,
    sourceBridgeIds: supersededBridgeIds
  })

  return recoveredPrinters
}

/**
 * Re-parents the bridge-owned library (files, folders, and archived versions)
 * from each disconnected sibling that this recovery *fully drained* onto the
 * connected bridge. Draining every printer off a sibling is our signal that the
 * connected bridge is that sibling's physical replacement, so its library — which
 * physically lives on the same disk under unchanged `storedPath`s — should follow.
 *
 * Gated on the sibling having zero printers left so a printer that merely roamed
 * between two live machines never drags an unrelated library with it.
 */
async function reAdoptLibraryFromDrainedBridges(input: {
  tenantId: string
  bridgeId: string
  sourceBridgeIds: Set<string>
}): Promise<void> {
  for (const sourceBridgeId of input.sourceBridgeIds) {
    const remainingPrinters = await rootPrisma.printer.count({
      where: { tenantId: input.tenantId, bridgeId: sourceBridgeId }
    })
    if (remainingPrinters > 0) continue

    const scope = { tenantId: input.tenantId, ownerBridgeId: sourceBridgeId }
    const data = { ownerBridgeId: input.bridgeId }
    const [files, folders, versions] = await rootPrisma.$transaction([
      rootPrisma.libraryFile.updateMany({ where: scope, data }),
      rootPrisma.libraryFolder.updateMany({ where: scope, data }),
      rootPrisma.libraryFileVersion.updateMany({ where: scope, data })
    ])

    if (files.count + folders.count + versions.count > 0) {
      console.warn(`[bridge-recovery] re-homed library (${files.count} files, ${folders.count} folders, ${versions.count} versions) from drained bridge ${sourceBridgeId} to ${input.bridgeId} after rediscovery`)
      broadcastLibraryChanged(input.tenantId)
    }
  }
}
