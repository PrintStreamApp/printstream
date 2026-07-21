/**
 * Printer quota hook. Core exposes a single optional registration point that a
 * deployment surface fills to cap printers and to report count changes for
 * usage metering. When nothing is registered — an unconfigured cloud, or a
 * licensed self-hosted install with no cap — printers are unlimited and count
 * changes are ignored, so core behaviour is unchanged.
 *
 * Two surfaces fill it, and they are mutually exclusive by build: the cloud
 * billing module (`private/cloud/index.ts`) caps a tenant by plan, and license
 * enforcement (`license-enforcement.ts`) caps a self-hosted install by the
 * allowance signed into its key. Hence `countPrinters`: the cloud counts one
 * workspace's printers, while a license cap must count the whole install —
 * counting per workspace would let anyone lift it by making a second one.
 */
import { conflict } from './http-error.js'
import { prisma } from './prisma.js'

interface PrinterQuotaRegistration {
  /** Max printers allowed for a tenant, or null for unlimited. */
  getLimit?: (tenantId: string) => Promise<number | null>
  /**
   * Count the printers the limit applies to. Defaults to the tenant's own
   * printers; override to widen the scope (see the module header).
   */
  countPrinters?: (tenantId: string) => Promise<number>
  /** Message for a rejected add. Defaults to plan-upgrade wording. */
  describeLimit?: (limit: number) => string
  /** Fired (best-effort) after a tenant's printer count changes, for usage metering. */
  onCountChanged?: (tenantId: string) => void | Promise<void>
}

let registration: PrinterQuotaRegistration | null = null

export function registerPrinterQuota(next: PrinterQuotaRegistration): void {
  if (registration) {
    // Two surfaces claiming the quota means one silently wins and a cap goes
    // unenforced; they are supposed to be build-exclusive.
    console.warn('[printer-quota] a second quota registration replaced the first — only one surface may cap printers')
  }
  registration = next
}

/** Throw a 409 when creating another printer would exceed the applicable limit. */
export async function assertPrinterQuotaOrThrow(tenantId: string): Promise<void> {
  const limit = await registration?.getLimit?.(tenantId)
  if (limit == null) return
  const count = await (registration?.countPrinters?.(tenantId) ?? prisma.printer.count({ where: { tenantId } }))
  if (count >= limit) {
    const describe = registration?.describeLimit
    throw conflict(describe ? describe(limit) : `Your plan is limited to ${limit} printer${limit === 1 ? '' : 's'}. Upgrade your plan to add more.`)
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
