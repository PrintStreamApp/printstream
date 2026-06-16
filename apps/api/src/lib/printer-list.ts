/**
 * Shared printer-list loader for API routes and plugins.
 *
 * Reads persisted printers in UI order and maps them to the shared DTO used
 * across the API, web app, and plugin snapshots.
 */
import type { Printer } from '@printstream/shared'
import type { AnyPrismaClient } from './prisma.js'
import { toPrinterDto } from './printer-record.js'

export async function listPrinters(prisma: AnyPrismaClient, tenantId?: string): Promise<Printer[]> {
  const rows = await prisma.printer.findMany({
    where: tenantId ? { tenantId } : undefined,
    orderBy: { position: 'asc' }
  })
  return rows.map(toPrinterDto)
}