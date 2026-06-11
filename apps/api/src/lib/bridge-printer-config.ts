/**
 * Sync assigned printer config to a connected bridge runtime.
 */
import { bridgeSessionManager } from './bridge-session-manager.js'
import { rootPrisma } from './prisma.js'
import { toPrinterDto } from './printer-record.js'

export async function syncBridgePrinterConfig(bridgeId: string | null | undefined): Promise<void> {
  if (!bridgeId || !bridgeSessionManager.isConnected(bridgeId)) return

  const printers = await rootPrisma.printer.findMany({
    where: { bridgeId },
    orderBy: { position: 'asc' }
  })

  bridgeSessionManager.sendMessage(bridgeId, {
    type: 'bridge.printers.config',
    printers: printers.map((printer) => toPrinterDto(printer))
  })
}