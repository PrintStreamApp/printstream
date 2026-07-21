/**
 * App-shell helpers: pure route/path utilities, device-override localStorage keys,
 * and JSON parsers for nullable per-device setting overrides used by `App`.
 *
 * These are module-level, side-effect-free declarations factored out of `App.tsx`
 * to keep the component file focused on the shell component itself.
 */
import {
  appLandingPageSettingSchema,
  appThemeSettingSchema,
  type AppLandingPageSetting,
  type AppThemeSetting
} from '@printstream/shared'

export const DEVICE_APP_THEME_OVERRIDE_KEY = 'printstream.general.appTheme.override'
/**
 * Platform surfaces keep their own device override so a theme chosen inside
 * a tenant workspace never restyles the platform workspace (and vice versa).
 */
export const DEVICE_PLATFORM_APP_THEME_OVERRIDE_KEY = 'printstream.general.appTheme.override.platform'
/**
 * Cache of the last theme background the app painted ({ background, color }
 * JSON). The index.html pre-bundle script applies it before first paint so
 * the boot splash matches the theme that loads afterwards instead of
 * flashing a mismatched backdrop.
 */
export const BOOT_BACKGROUND_CACHE_KEY = 'printstream.appearance.bootBackground'
export const DEVICE_LANDING_PAGE_OVERRIDE_KEY_PREFIX = 'printstream.general.landingPage.override'
export const DEVICE_NAV_TAB_ORDER_OVERRIDE_KEY_PREFIX = 'printstream.general.navTabOrder.override'
export const DEVICE_UNCONSTRAINED_WIDTH_OVERRIDE_KEY = 'bambu.general.unconstrainedWidth.override'
/**
 * Per-device override for the workspace-wide "developer slicer settings"
 * default. Device-global (like the theme override), so the preference to see
 * BambuStudio's develop-tier options follows the browser across workspaces.
 */
export const DEVICE_SLICER_DEVELOPER_MODE_OVERRIDE_KEY = 'printstream.slicer.developerMode.override'
/**
 * Model studio viewport overrides. Tenant-scoped (like the nav-order and landing-page overrides,
 * and unlike the device-global theme/developer-mode ones): each workspace sets its own shared
 * default, so a device override that leaked across workspaces would silently shadow a default it
 * was never chosen against. The suffix is the workspace slug — see `lib/editorViewportSettings.ts`.
 */
export const DEVICE_EDITOR_SHOW_BED_MODEL_OVERRIDE_KEY_PREFIX = 'printstream.editor.bedModel3d.override'
export const DEVICE_EDITOR_SIDEBAR_SIDE_OVERRIDE_KEY_PREFIX = 'printstream.editor.sidebarSide.override'

export function tenantScopedRoutePath(path: string): string {
  return path === '/' ? '/workspaces/:tenantSlug' : `/workspaces/:tenantSlug${path}`
}

export type CatchAllRouteDecision = 'wait' | 'defer-to-plugin-handling' | 'redirect-home'

/**
 * Decide what the router's catch-all (unmatched path) should do.
 *
 * Plugin routes (e.g. `/orders`) are only mounted once the plugin catalog resolves, which can't even start
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

/**
 * Resolve which nav tab owns the current route: the tab whose value equals the
 * path or is an ancestor segment of it (longest match wins, so nested tab
 * values beat their parents). Views outside every tab's subtree (e.g.
 * `/suggestions` in a tenant workspace) resolve to null so no tab is
 * highlighted, rather than falling back to a default tab.
 */
export function resolveActiveNavTab(tabValues: ReadonlyArray<string>, appPathname: string): string | null {
  return tabValues
    .filter((value) => appPathname === value || appPathname.startsWith(`${value}/`))
    .sort((left, right) => right.length - left.length)[0] ?? null
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
    if (parsed === null) {
      return null
    }

    const result = appThemeSettingSchema.safeParse(parsed)
    return result.success ? result.data : null
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
