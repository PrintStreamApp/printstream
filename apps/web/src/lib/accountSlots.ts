import { webPluginRegistry } from '../plugin/registry'
import { buildWorkspacePath, isPlatformWorkspacePath, parseWorkspacePathname } from './workspaceRoute'

/**
 * Names of the Account plugin slots that also have their own top-level pages.
 *
 * Constants rather than string literals because three places have to agree on
 * each one — the plugin that fills it, the route that hosts it, and the nav tab
 * and Account link that point at that route. A typo in any of them fails
 * silently as an empty page.
 *
 * The slots are filled by private cloud plugins; in a public build they are
 * empty and the routes are not registered at all.
 */
export const ACCOUNT_MESSAGES_SLOT = 'account.support'

/**
 * The account page itself, on each host that renders one.
 *
 * Two hosts, because the account scope is rendered both inside a workspace and
 * at the platform (an operator has their own account, and reaches it without a
 * workspace selected).
 */
const WORKSPACE_ACCOUNT_PATH = '/account'
const PLATFORM_ACCOUNT_PATH = '/platform/account'

/** A page below the account page, relative to whichever host renders it. */
export const ACCOUNT_MESSAGES_SUBPATH = '/messages'

/**
 * An account page's path on the host the caller is currently on.
 *
 * Built from the CURRENT pathname rather than the active workspace: the panel
 * that links here also renders at the platform, and a link carrying a workspace
 * slug from elsewhere would navigate out of the page being viewed.
 *
 * The host matters because each prefixes the account scope differently, and a
 * sub-path built without the prefix matches NO route on the platform — where
 * the router's catch-all quietly sends the click to the home page instead of
 * erroring, so a dead link looks like a working one until someone follows it.
 * That is exactly how Account -> Messages went home from `/platform/account`.
 *
 * Counterpart: the account routes in `App.tsx`. A sub-path added here needs a
 * route registered on EVERY host that can produce it, or it becomes another
 * silent trip home.
 */
export function buildAccountPath(currentPathname: string, subPath = ''): string {
  const { workspaceSlug } = parseWorkspacePathname(currentPathname)
  if (workspaceSlug) return buildWorkspacePath(workspaceSlug, `${WORKSPACE_ACCOUNT_PATH}${subPath}`)
  if (isPlatformWorkspacePath(currentPathname)) return `${PLATFORM_ACCOUNT_PATH}${subPath}`
  return `${WORKSPACE_ACCOUNT_PATH}${subPath}`
}

/**
 * Whether any registered plugin fills this slot — i.e. whether the page behind
 * it has anything to show.
 *
 * The registry is populated at module load (built-in plugins register when the
 * app-shell chunk first evaluates), so this is settled before the first render
 * and gives the route, the nav tab, and the Account link one answer. Lives here
 * rather than beside the view because a file that exports both a component and
 * a helper breaks Fast Refresh.
 */
export function accountSlotHasContent(name: string): boolean {
  return webPluginRegistry.slots(name).length > 0
}
