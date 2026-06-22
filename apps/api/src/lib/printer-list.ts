/**
 * Shared printer-list loader for API routes and plugins.
 *
 * Reads persisted printers in UI order and maps them to the browser-safe DTO
 * (LAN access code redacted via `toPublicPrinterDto`). This loader feeds HTTP
 * responses and the Home Assistant plugin; neither needs the access code, and the
 * browser must never receive it. Transport/manager paths that need the secret use
 * `toPrinterDto` directly against the row.
 */
import type { Printer } from '@printstream/shared'
import type { AnyPrismaClient } from './prisma.js'
import { toPublicPrinterDto } from './printer-record.js'

export async function listPrinters(prisma: AnyPrismaClient, tenantId?: string): Promise<Printer[]> {
  const rows = await prisma.printer.findMany({
    where: tenantId ? { tenantId } : undefined,
    orderBy: { position: 'asc' }
  })
  return rows.map(toPublicPrinterDto)
}