/**
 * Printer quota hook. Core exposes a single optional registration point that a
 * deployment surface (the cloud billing module) fills to cap printers per tenant
 * by plan and to report count changes for usage metering. When nothing is
 * registered — self-hosted / OSS, or an unconfigured cloud — printers are
 * unlimited and count changes are ignored, so core behaviour is unchanged.
 */
import { conflict } from './http-error.js'
import { prisma } from './prisma.js'

interface PrinterQuotaRegistration {
  /** Max printers allowed for a tenant, or null for unlimited. */
  getLimit?: (tenantId: string) => Promise<number | null>
  /** Fired (best-effort) after a tenant's printer count changes, for usage metering. */
  onCountChanged?: (tenantId: string) => void | Promise<void>
}

let registration: PrinterQuotaRegistration | null = null

export function registerPrinterQuota(next: PrinterQuotaRegistration): void {
  registration = next
}

/** Throw a 409 when creating another printer would exceed the tenant's plan limit. */
export async function assertPrinterQuotaOrThrow(tenantId: string): Promise<void> {
  const limit = await registration?.getLimit?.(tenantId)
  if (limit == null) return
  const count = await prisma.printer.count({ where: { tenantId } })
  if (count >= limit) {
    throw conflict(`Your plan is limited to ${limit} printer${limit === 1 ? '' : 's'}. Upgrade your plan to add more.`)
  }
}

/** Notify the registered surface that a tenant's printer count changed (metering). Best-effort. */
export function notifyPrinterCountChanged(tenantId: string): void {
  const handler = registration?.onCountChanged
  if (!handler) return
  void Promise.resolve(handler(tenantId)).catch((error) => {
    console.warn('[printer-quota] onCountChanged handler failed', { tenantId, error })
  })
}
