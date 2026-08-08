/**
 * What tooltip a nav tab should carry, or '' for none.
 *
 * Its own module so it can be tested: a test that imported `AppShell` would
 * pull in Joy and `@mui/icons-material`, which the node runner cannot render.
 *
 * Counterpart: `AppShell`, whose mobile and desktop tab rows both call this so
 * a tab cannot behave one way on a phone and another on a desktop.
 */
import type { ShellTab } from './AppShell'

/**
 * Two cases that want opposite things.
 *
 * A tab with no visible text has the tooltip as the ONLY way to know what it
 * is, so the tooltip must name it, and adds the description after the name
 * when there is one. A tab whose label is already on screen must not repeat
 * that label — it either adds something (its description) or stays silent,
 * because a tooltip echoing the word under the pointer is noise that follows
 * the reader around the bar.
 *
 * Whether the label is visible is not a property of the tab: the same tab
 * shows its label on a wide desktop row and only its icon once
 * `useFittedNavDensity` has tightened that row, or on the mobile bar. So the
 * ROW tells us, via `labelHidden`; `iconOnly` is the case where the tab itself
 * has already decided.
 */
export function tabTooltip(
  tab: Pick<ShellTab, 'label' | 'ariaLabel' | 'description' | 'iconOnly'>,
  { labelHidden = false }: { labelHidden?: boolean } = {}
): string {
  if (!tab.iconOnly && !labelHidden) return tab.description ?? ''
  const name = tab.ariaLabel ?? tab.label
  return tab.description ? `${name}. ${tab.description}` : name
}
