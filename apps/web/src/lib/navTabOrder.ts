/**
 * Ordering for the primary nav tabs.
 *
 * `DEFAULT_NAV_TAB_ORDER` is the built-in order used when no custom order is set
 * (the workspace default and per-device override both start empty). It interleaves
 * the plugin tabs (Queue after Printers, Filament and Orders after Library) with the
 * core tabs. `orderNavTabs` applies a custom order to the currently-available tabs:
 * tabs named in the order come first in that order, then any remaining tabs fall back
 * to their default position, so the order survives plugins/tabs being added or removed.
 */

/** Built-in default order of primary content tabs (by route value). */
export const DEFAULT_NAV_TAB_ORDER: readonly string[] = [
  '/get-started',
  '/printers',
  '/queue',
  '/jobs',
  '/library',
  '/filament',
  '/calibration',
  '/orders',
  '/stats'
]

export function orderNavTabs<T extends { value: string }>(tabs: readonly T[], order: readonly string[]): T[] {
  const rank = (value: string): number => {
    const customIndex = order.indexOf(value)
    if (customIndex !== -1) return customIndex
    // Tabs not in the custom order sort after the customized ones, by their
    // built-in default position (unknown tabs go last).
    const defaultIndex = DEFAULT_NAV_TAB_ORDER.indexOf(value)
    return order.length + (defaultIndex === -1 ? DEFAULT_NAV_TAB_ORDER.length : defaultIndex)
  }
  return [...tabs].sort((left, right) => rank(left.value) - rank(right.value))
}
