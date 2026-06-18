/**
 * Tenant-safe resolution of a live printer for request handlers.
 *
 * `printerManager.getPrinter()` is an in-memory map keyed by printer id ALONE — it
 * performs no tenant check, so trusting it directly for authorization lets one tenant
 * read/mutate/print on another tenant's connected printer by id. Printer ids are CUIDs
 * but leak across tenants (shared bridges, logs, support flows), so id secrecy is not an
 * authorization boundary.
 *
 * Every printer-targeting route must authorize through the tenant-scoped Prisma client
 * first (which returns null for a cross-tenant id) before touching the live record. This
 * helper centralizes that gate so no route can forget it.
 */
import type { Printer } from '@printstream/shared'
import { notFound } from './http-error.js'
import { prisma } from './prisma.js'
import { printerManager } from './printer-manager.js'

/**
 * Resolve the live printer for `printerId`, but only if it belongs to the request's
 * tenant. Throws 404 (indistinguishable from "unknown id") when the printer is not owned
 * by the caller's tenant or is not currently connected/managed. Use this instead of
 * `printerManager.getPrinter()` in any handler that reads or acts on a specific printer.
 */
export async function requireTenantOwnedConnectedPrinter(printerId: string): Promise<Printer> {
  // The tenant-scoped client returns null for an id owned by another tenant.
  const owned = await prisma.printer.findUnique({ where: { id: printerId }, select: { id: true } })
  if (!owned) throw notFound('Printer not found or not connected')
  const printer = printerManager.getPrinter(printerId)
  if (!printer) throw notFound('Printer not found or not connected')
  return printer
}

/**
 * Tenant-ownership check without requiring the printer to be live/connected. Returns true
 * only when the printer exists and belongs to the request's tenant. For handlers that act
 * via cached manager state (status/bridge id) rather than the live `Printer` record.
 */
export async function assertTenantOwnsPrinter(printerId: string): Promise<void> {
  const owned = await prisma.printer.findUnique({ where: { id: printerId }, select: { id: true } })
  if (!owned) throw notFound('Printer not found or not connected')
}
