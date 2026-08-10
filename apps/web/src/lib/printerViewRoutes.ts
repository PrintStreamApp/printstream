/**
 * Addresses for saved printer views. Owns the `/printers/views/<view id>` path
 * shape and the rule for which view is active at a given address, so a view can
 * be bookmarked, shared, and chosen as the app's landing page.
 *
 * Contract (shared with the routes in `App.tsx` and `pages/PrintersView.tsx`,
 * which derives its active view from the URL instead of local state):
 *  - `/printers` means "this device's default view" — the per-device choice made
 *    via "Set as default" in the view settings dialog, falling back to the
 *    Overview. Deliberately not a redirect: the bare address stays meaningful as
 *    a bookmark that follows whatever the device's default is.
 *  - `/printers/views/<id>` pins one saved view by its server id (stable across
 *    renames, unlike the display name).
 *  - `/printers/views/overview` pins the built-in Overview, which has no server
 *    row. The segment cannot collide with a real view id (cuids).
 *
 * These paths are persisted — bookmarks, and the "Default page" landing setting
 * (workspace-shared and per-device tiers) store them verbatim — so treat the
 * shape as a wire format: existing addresses must keep resolving.
 */

/** Reserved `:viewId` segment addressing the built-in Overview. */
export const OVERVIEW_VIEW_ROUTE_ID = 'overview'

const PRINTER_VIEW_PATH_PREFIX = '/printers/views/'

/** App-relative address of a saved view (or the Overview via `OVERVIEW_VIEW_ROUTE_ID`). */
export function printerViewPath(viewId: string): string {
  return `${PRINTER_VIEW_PATH_PREFIX}${viewId}`
}

/** Whether an app-relative path (e.g. a stored landing-page value) addresses a printer view. */
export function isPrinterViewPath(path: string): boolean {
  return path.startsWith(PRINTER_VIEW_PATH_PREFIX)
}

/**
 * The view id a printers-page address resolves to (`null` = the Overview).
 *
 * A pinned address wins even before the views list loads — the page renders the
 * view as soon as it arrives. The bare address applies the device default only
 * once it is known to still exist, so a stale stored id degrades to the
 * Overview instead of an empty "view not found" state. A pinned id that turns
 * out not to exist is the caller's to redirect (the page replaces to bare
 * `/printers` once the list has loaded).
 */
export function resolveActivePrinterViewId(input: {
  /** The `:viewId` route param, absent on the bare `/printers` address. */
  routeViewId: string | undefined
  /** The device's stored default view id, if any. */
  storedDefaultViewId: string | null
  views: ReadonlyArray<{ id: string }>
}): string | null {
  if (input.routeViewId) {
    return input.routeViewId === OVERVIEW_VIEW_ROUTE_ID ? null : input.routeViewId
  }
  return input.storedDefaultViewId != null && input.views.some((view) => view.id === input.storedDefaultViewId)
    ? input.storedDefaultViewId
    : null
}
