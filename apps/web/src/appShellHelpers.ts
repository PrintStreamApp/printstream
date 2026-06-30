/**
 * App-shell helpers: pure route/path utilities, device-override localStorage keys,
 * and JSON parsers for nullable per-device setting overrides used by `App`.
 *
 * These are module-level, side-effect-free declarations factored out of `App.tsx`
 * to keep the component file focused on the shell component itself.
 */
import {
  appLandingPageSettingSchema,
  type AppLandingPageSetting,
  type AppThemeSetting
} from '@printstream/shared'

export const DEVICE_APP_THEME_OVERRIDE_KEY = 'printstream.general.appTheme.override'
export const DEVICE_LANDING_PAGE_OVERRIDE_KEY_PREFIX = 'printstream.general.landingPage.override'
export const DEVICE_NAV_TAB_ORDER_OVERRIDE_KEY_PREFIX = 'printstream.general.navTabOrder.override'
export const DEVICE_UNCONSTRAINED_WIDTH_OVERRIDE_KEY = 'bambu.general.unconstrainedWidth.override'

export function tenantScopedRoutePath(path: string): string {
  return path === '/' ? '/workspaces/:tenantSlug' : `/workspaces/:tenantSlug${path}`
}

export type CatchAllRouteDecision = 'wait' | 'defer-to-plugin-handling' | 'redirect-home'

/**
 * Decide what the router's catch-all (unmatched path) should do.
 *
 * Plugin routes (e.g. `/queue`) are only mounted once the plugin catalog resolves, which can't even start
 * until auth bootstrap finishes. On a hard refresh of a plugin route, that determination is still in flight
 * at first paint, so the route isn't in the tree yet and the path falls through to the catch-all. Redirecting
 * home then would bounce the user off the very page they refreshed. So:
 *  - a path that isn't a known plugin route is genuinely unknown -> `redirect-home`;
 *  - a known plugin route whose catalog is still resolving -> `wait` (render a loader; the real route mounts
 *    once the catalog lands);
 *  - a known plugin route once the catalog has resolved -> `defer-to-plugin-handling`: an enabled plugin's
 *    own route already matched (so the catch-all isn't reached), and a disabled one is redirected to plugin
 *    settings elsewhere, so the catch-all must not also send it home.
 */
export function catchAllRouteDecision(input: {
  isKnownPluginRoute: boolean
  pluginCatalogResolving: boolean
  hasPluginState: boolean
}): CatchAllRouteDecision {
  if (!input.isKnownPluginRoute) return 'redirect-home'
  if (input.pluginCatalogResolving) return 'wait'
  return input.hasPluginState ? 'defer-to-plugin-handling' : 'redirect-home'
}

export function parseNullableBoolean(raw: string): boolean | null {
  try {
    const parsed = JSON.parse(raw) as unknown
    return typeof parsed === 'boolean' || parsed === null ? parsed : null
  } catch {
    return null
  }
}

export function parseNullableAppThemeSetting(raw: string): AppThemeSetting | null {
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed === 'default' || parsed === 'aurora' || parsed === null ? parsed : null
  } catch {
    return null
  }
}

export function parseNullableAppLandingPageSetting(raw: string): AppLandingPageSetting | null {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed === null) {
      return null
    }

    const result = appLandingPageSettingSchema.safeParse(parsed)
    return result.success ? result.data : null
  } catch {
    return null
  }
}

/** Per-device nav-tab order override: an array of tab values, or null to follow the workspace default. */
export function parseNullableNavTabOrder(raw: string): string[] | null {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed === null) return null
    return Array.isArray(parsed) && parsed.every((value) => typeof value === 'string') ? parsed : null
  } catch {
    return null
  }
}
