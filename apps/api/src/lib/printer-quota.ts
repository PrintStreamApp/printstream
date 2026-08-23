/**
 * Printer quota hook. Core exposes a single optional registration point that a
 * deployment surface fills to cap printers and to report count changes for
 * usage metering. When nothing is registered, an unconfigured cloud, or a
 * licensed self-hosted install with no cap, printers are unlimited and count
 * changes are ignored, so core behaviour is unchanged.
 *
 * Two surfaces fill it, and they are mutually exclusive by build: the cloud
 * billing module (`private/cloud/index.ts`) caps a workspace by plan, and license
 * enforcement (`license-enforcement.ts`) caps a self-hosted install by the
 * allowance signed into its key.
 *
 * **The one invariant: `getLimit` and `countPrinters` must measure the same
 * population.** A limit covering the whole install checked against one
 * workspace's printers is lifted by making a second workspace; an account-wide
 * free allowance checked per workspace is lifted the same way. Both live
 * registrations learned this the hard way: the licence cap counts the whole
 * install, and the cloud's free allowance counts the whole ACCOUNT even though
 * its limit is expressed per workspace.
 *
 * That is why `countPrinters` is REQUIRED rather than defaulting to the
 * workspace's own printers: the default silently matched only one of the two
 * populations, so forgetting the override made a cap bypassable with no error
 * anywhere and nothing in the type to notice.
 */
import { conflict } from './http-error.js'

interface PrinterQuotaRegistration {
  /** Max printers allowed when adding to this workspace, or null for unlimited. */
  getLimit: (workspaceId: string) => Promise<number | null>
  /**
   * Count the printers `getLimit` is measured against. Required, and it must
   * span the same population as the limit: see the module header.
   */
  countPrinters: (workspaceId: string) => Promise<number>
  /** Message for a rejected add. Defaults to plan-upgrade wording. */
  describeLimit?: (limit: number) => string
  /**
   * Last chance to widen the limit before an add is refused, given the total
   * the add needs covered. Returns the limit now in force, or null if it could
   * not be raised.
   *
   * **This may spend the customer's money**, which is the point: on a metered
   * plan "add a printer" and "pay for a printer" are one action, so a surface
   * that bills per printer raises here instead of sending the operator to a
   * billing page and back. It runs only when the add would otherwise be
   * refused, so an add inside the existing allowance never touches it.
   *
   * Not implemented by the cloud, which meters AFTER the add
   * (`syncPrinterQuantity`) because its own database is the authority on the
   * count. A licensed install has no such authority, its allowance is signed
   * into a key by someone else, so it must raise first and add second.
   *
   * Throw `conflict(...)` to refuse with a specific reason (declined payment,
   * no subscription behind the key); return null to fall back to
   * `describeLimit`. A generic "upgrade your plan" message in front of a
   * declined card sends the operator to the wrong place entirely.
   */
  raiseLimit?: (needed: number) => Promise<number | null>
  /** Fired (best-effort) after a workspace's printer count changes, for usage metering. */
  onCountChanged?: (workspaceId: string) => void | Promise<void>
}

let registration: PrinterQuotaRegistration | null = null

export function registerPrinterQuota(next: PrinterQuotaRegistration): void {
  if (registration) {
    // Throws rather than warning: the two surfaces are build-exclusive, so a
    // collision is a wiring bug, not a runtime condition. Letting the second win
    // silently drops whichever cap registered first, on a misconfigured build
    // that is licence enforcement, i.e. the cap disappears exactly where it is
    // the only thing protecting a paid product.
    throw new Error('[printer-quota] a second quota registration was attempted, only one surface may cap printers')
  }
  registration = next
}

/** Test seam: drops the registration so each case starts from an unregistered gate. */
export function __resetPrinterQuotaForTests(): void {
  registration = null
}

/**
 * Throw a 409 when creating another printer would exceed the applicable limit.
 *
 * A surface that can buy its way past the limit gets one attempt at
 * `raiseLimit` first: see its doc for why that is worth billing inline.
 */
export async function assertPrinterQuotaOrThrow(workspaceId: string): Promise<void> {
  if (!registration) return
  const limit = await registration.getLimit(workspaceId)
  if (limit == null) return
  const count = await registration.countPrinters(workspaceId)
  if (count < limit) return

  // Asks for the count this add needs, not for "one more than the limit": the
  // two differ once an install is over its allowance (a key was downgraded, or a
  // raise failed halfway), and asking for the limit + 1 there would buy capacity
  // that still does not cover the fleet.
  const raised = await registration.raiseLimit?.(count + 1) ?? null
  if (raised != null && count < raised) return

  const effective = raised ?? limit
  const describe = registration.describeLimit
  throw conflict(describe ? describe(effective) : `Your plan is limited to ${effective} printer${effective === 1 ? '' : 's'}. Upgrade your plan to add more.`)
}

/** Notify the registered surface that a workspace's printer count changed (metering). Best-effort. */
export function notifyPrinterCountChanged(workspaceId: string): void {
  const handler = registration?.onCountChanged
  if (!handler) return
  void Promise.resolve(handler(workspaceId)).catch((error) => {
    console.warn('[printer-quota] onCountChanged handler failed', { workspaceId, error })
  })
}
